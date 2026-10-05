#include "viewer.h"
#include "../../shared/settings_schema.h"
#include "motion.h"
#include <QApplication>
#include <QShortcut>
#include <QCloseEvent>
#include <QProcess>
#include <QFile>
#include <QStatusBar>
#include <QPropertyAnimation>
#include <QLabel>

Viewer::Viewer(bool network) : preferences("dudesoft", "24sevenfm-covers"), network_(network) {
    stage = new Stage(this); setCentralWidget(stage); resize(680,820);
    setWindowIcon(QIcon(":/icon.ico")); setWindowTitle("24seven.fm Covers");
    if (!qEnvironmentVariableIsSet("SSC_TEST_MODE")) restoreGeometry(preferences.value("geometry").toByteArray());
    // GNOME exposes Reduce Motion as the inverse of enable-animations. Other
    // desktops can always use the explicit preference; no universal Wayland API.
    if (network_) {
        QProcess setting; setting.start("gsettings", {"get","org.gnome.desktop.interface","enable-animations"});
        if (setting.waitForFinished(1000)) systemReducedMotion_ = setting.exitCode()==0 && setting.readAllStandardOutput().trimmed()=="false";
    }
    stage->openSettings = [this] { showSettings(); };
    stage->toggleFullscreen = [this] { toggleFullscreen(); };
    auto shortcut=[this](QKeySequence key, std::function<void()> action) {
        auto* s=new QShortcut(key,this); connect(s,&QShortcut::activated,this,std::move(action));
    };
    shortcut(Qt::Key_F11,[this]{toggleFullscreen();});
    shortcut(Qt::Key_Escape,[this]{if(isFullScreen())showNormal();});
    shortcut(QKeySequence("Ctrl+,"),[this]{showSettings();});
    shortcut(QKeySequence("Ctrl+Q"),[this]{close();});
    shortcut(QKeySequence("Ctrl+R"),[this]{if(session_)session_->monitor->refresh();});
    viewportTimer_.setSingleShot(true); viewportTimer_.setInterval(200);
    connect(&viewportTimer_,&QTimer::timeout,this,[this]{
        if(session_) session_->pipeline->viewport(int(stage->width()*devicePixelRatioF()),int(stage->height()*devicePixelRatioF()));
    });
    applyPreferences();
    stage->controller.pointerChanged(true,false,true);
}
Viewer::~Viewer() {
    closing_=true; retireSession();
    for(auto& task:retiring_) task.get();
}
QVariant Viewer::preference(const char* storageKey) const {
    // Defaults come from the engine; reading a fallback never writes user settings.
    for (const auto& setting : ssccfg::settingsSchema(ssccfg::Profile::Linux)) {
        if (setting.storageKey != storageKey) continue;
        const QVariant fallback = setting.stringValue
            ? QVariant(QString::fromStdString(setting.defaultText)) : QVariant(setting.defaultInt);
        return preferences.value(QString::fromUtf8(storageKey), fallback);
    }
    return preferences.value(QString::fromUtf8(storageKey));
}
int Viewer::stationIndex() const { return ssc::validStationIndex(ssc::stationIndexForId(preference("station").toString().toUtf8().constData())); }
bool Viewer::reducedMotion() const { return systemReducedMotion_ || preference("reducedMotion").toBool(); }
ssc::MediaRequest Viewer::mediaOptions() const {
    ssc::MediaPreferences m; m.station=stationIndex();
    m.backdrops=preference("backdrops").toBool(); m.logos=preference("logos").toBool();
    m.ratings=preference("ratings").toBool();
    m.providers=preference("providers").toString().toStdString();
    m.fanartKey=preference("fanartKey").toString().toStdString();
    m.ratingCountries=preference("ratingDE").toBool()?"DE":"";
    if(preference("ratingUS").toBool()) m.ratingCountries+=m.ratingCountries.empty()?"US":",US";
    return ssc::mediaOptions(m,int(stage->width()*devicePixelRatioF()),int(stage->height()*devicePixelRatioF()));
}
void Viewer::applyPreferences() {
    auto& s=stage->settings;
    s.poster=preference("poster").toBool(); s.countdown=preference("countdown").toBool();
    s.rolling=preference("rolling").toBool(); s.next=preference("next").toBool();
    s.ratings=preference("ratings").toBool(); s.hideCover=preference("hideCover").toBool();
    s.countdownSize=qBound(0,preference("countdownSize").toInt(),2);
    s.countdownSizing=ssc::CountdownSizing::ViewportRelative;
    s.effect=qBound(0,preference("effect").toInt(),3); s.reducedMotion=reducedMotion();
    stage->refresh();
    const bool onTop=preference("alwaysOnTop").toBool();
    if(bool(windowFlags()&Qt::WindowStaysOnTopHint)!=onTop) {
        const bool visible=isVisible(), full=isFullScreen(); setWindowFlag(Qt::WindowStaysOnTopHint,onTop);
        if(visible) { if(full)showFullScreen();else show(); }
    }
    preferences.sync();
    QFile::setPermissions(preferences.fileName(),QFile::ReadOwner|QFile::WriteOwner);
    if(network_) {
        if(!session_ || session_->station!=stationIndex()) startStation();
        else session_->pipeline->options(mediaOptions());
    }
}
void Viewer::retireSession() {
    auto old=std::move(session_); if(!old)return;
    old->pipeline->cancel();
    retiring_.push_back(std::async(std::launch::async,[old]{old->monitor->stop();old->pipeline->stop();}));
    retiring_.erase(std::remove_if(retiring_.begin(),retiring_.end(),[](std::future<void>& f){
        if(f.wait_for(std::chrono::seconds(0))!=std::future_status::ready)return false;
        f.get();return true;
    }),retiring_.end());
}
void Viewer::startStation() {
    retireSession(); auto state=std::make_shared<Session>(); session_=state; state->station=stationIndex();
    std::weak_ptr<Session> weak=state;
    stage->controller.comingNext.setQueue("",L"",L""); stage->controller.remainingChanged(-1);
    setWindowTitle(QString::fromUtf8(ssc::station(state->station).displayName)+" — 24seven.fm Covers");
    state->pipeline.reset(new ssc::PresentationPipeline(
        [station=state->station](const ssc::TrackInfo& t,const ssc::MediaRequest& r,const std::atomic<bool>* cancel){
            return std::make_shared<const ssc::PreparedPresentation>(ssc::preparePresentation(t,r,station,cancel));
        },[station=state->station](const std::atomic<bool>* cancel){return ssc::stationQueue(station,cancel);},
        [this,weak](ssc::PresentationPipeline::Frame frame,bool queued,bool,unsigned long long generation){
            QMetaObject::invokeMethod(this,[this,weak,frame,queued,generation]{
                auto state=weak.lock();
                if(closing_ || !state || session_!=state || state->pipeline->generation()!=generation)return;
                stage->present(*frame,state->station,queued);
            },Qt::QueuedConnection);
        }));
    ssc::Config config; config.host=ssc::station(state->station).host; config.errorRetrySeconds=8; config.cycleErrorRetryAfterCap=true;
    state->monitor.reset(new ssc::CoverMonitor([this,weak](const std::string&,const ssc::TrackInfo& track){
        QMetaObject::invokeMethod(this,[this,weak,track]{
            auto state=weak.lock(); if(closing_ || !state || session_!=state)return;
            state->identity=ssc::trackIdentity(track,state->station);
            stage->controller.trackChanged(state->identity);
            stage->controller.remainingChanged(track.remainingSeconds);
            state->pipeline->current(track,ssc::requestForTrack(track,mediaOptions()));
        },Qt::QueuedConnection);
    },config));
    state->monitor->setTickCallback([this,weak](const ssc::TrackInfo& track){
        QMetaObject::invokeMethod(this,[this,weak,track]{
            auto state=weak.lock(); if(closing_ || !state || session_!=state || state->identity!=ssc::trackIdentity(track,state->station))return;
            stage->controller.remainingChanged(track.remainingSeconds);
        },Qt::QueuedConnection);
    });
    state->monitor->setErrorCallback([this,weak](const std::string& error){
        qWarning("Feed: %s",error.c_str());
        QMetaObject::invokeMethod(this,[this,weak]{
            auto state=weak.lock(); if(closing_ || !state || session_!=state)return;
            setWindowTitle(QString::fromUtf8(ssc::station(state->station).displayName)+" — reconnecting…");
        },Qt::QueuedConnection);
    });
    state->monitor->start();
}
void Viewer::toggleFullscreen() { if(isFullScreen())showNormal();else showFullScreen(); }
void Viewer::resizeEvent(QResizeEvent* e) { QMainWindow::resizeEvent(e); viewportTimer_.start(); }
void Viewer::closeEvent(QCloseEvent* e) {
    if(closing_) { e->accept();return; }
    if(!isFullScreen())preferences.setValue("geometry",saveGeometry());
    closing_=true; retireSession();
    if(dialog_)dialog_->close();
    if(reducedMotion()){e->accept();return;}
    e->ignore(); fadeStage(false,[this]{close();});
}
void Viewer::fadeStage(bool entering, std::function<void()> finished) {
    // Fade an ordinary overlay: graphics effects on QOpenGLWidget/QRhiWidget
    // cannot reliably capture their separately composed GPU surface.
    auto* shade=new QLabel(this);shade->setGeometry(stage->geometry());
    shade->setStyleSheet("background: rgb(16,18,24)");
    shade->setAttribute(Qt::WA_TransparentForMouseEvents);shade->show();shade->raise();
    fadeContent(shade,!entering,180,[shade,finished]{shade->deleteLater();if(finished)finished();});
}
