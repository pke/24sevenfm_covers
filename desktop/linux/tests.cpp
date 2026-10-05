#define DOCTEST_CONFIG_IMPLEMENT
#include "../../lib/tests/doctest.h"
#include "viewer.h"
#include "typography.h"
#include "renderer_choice.h"
#include "../../lib/image_probe.h"
#include <QApplication>
#include <QTemporaryDir>
#include <QBuffer>
#include <QTest>
#include <QRadioButton>
#include <QComboBox>
#include <QTabWidget>
#include <QCheckBox>
#include <QDir>
#include <QPainter>
#include <QPushButton>
#include <QElapsedTimer>
#include "../../shared/engine_settings.h"

namespace {
std::string encoded(QColor color,int width=96,int height=96) {
    QImage image(width,height,QImage::Format_ARGB32);image.fill(color);QByteArray bytes;QBuffer buffer(&bytes);
    buffer.open(QIODevice::WriteOnly);image.save(&buffer,"PNG");return bytes.toStdString();
}
ssc::PreparedPresentation fixture() {
    ssc::PreparedPresentation p;p.track.album="The Sound of Cinema";p.track.artist="A. Composer";
    p.track.track="Finale";p.track.asin="fixture";p.cover=encoded(QColor(45,120,165));return p;
}
void capture(Stage& stage,const QString& name) {
    const auto dir=qEnvironmentVariable("SSC_UI_CHECK_DIR");if(dir.isEmpty())return;
    QDir(dir).mkpath(".");CHECK(stage.snapshot().save(QDir(dir).filePath(name+".png")));
}
}
TEST_CASE("Linux decoder rejects bogus, oversized and truncated images before display") {
    const auto good=encoded(Qt::blue);CHECK(ssc::decodableImage(good,"fixture"));CHECK_FALSE(Stage::decode(good).isNull());
    CHECK_FALSE(ssc::decodableImage("\x89PNG\r\n\x1a\nthis is not an image","fixture"));
    CHECK_FALSE(ssc::decodableImage(good.substr(0,40),"fixture"));
    const auto oversized=encoded(Qt::red,4097,1);CHECK_FALSE(ssc::decodableImage(oversized,"fixture"));CHECK(Stage::decode(oversized).isNull());
    QImage logo(240,80,QImage::Format_RGBA8888); logo.fill(Qt::transparent);
    for(int y=10;y<70;++y)for(int x=20;x<220;++x) {
        if(x>=180 && (y<38 || y>=42))continue;
        logo.setPixelColor(x,y,Qt::white);
    }
    QByteArray png; QBuffer out(&png); out.open(QIODevice::WriteOnly); REQUIRE(logo.save(&out,"PNG"));
    const auto decodedLogo=Stage::decodeLogo(png.toStdString());
    CHECK(decodedLogo.size()==QSize(200,60)); // decorative tail is not cropped off
    CHECK(decodedLogo.text("ssc.logoAnchor").toFloat()==doctest::Approx(.4f));
}
TEST_CASE("Linux renderer consumes shared frame without advancing clocks during painting") {
    Stage stage;stage.resize(680,820);stage.show();stage.settings.poster=true;stage.settings.countdown=true;stage.settings.rolling=true;stage.settings.next=true;
    stage.controller.settingsChanged(stage.settings);stage.present(fixture(),0,false);stage.controller.remainingChanged(9);
    auto next=fixture();next.track.asin="next";next.track.album="Coming Next Album";stage.present(next,0,true);
    stage.sampleAt(0);stage.sampleAt(1000);stage.sampleAt(1400);
    const auto before=stage.controller.frame();const auto a=stage.snapshot(),b=stage.snapshot();
    CHECK(a==b);CHECK(stage.controller.frame().next.opacity==before.next.opacity);
    CHECK(stage.controller.frame().coverRect.width==before.coverRect.width);CHECK(before.nextWidth>100);CHECK(before.infoRect.height>0);
    CHECK(before.countdown.seconds==9);CHECK(before.next.opacity==1);capture(stage,"poster-next");
    stage.controller.remainingChanged(8);stage.sampleAt(1500);stage.sampleAt(1650);capture(stage,"rolling-digits");
    stage.settings.poster=false;stage.controller.settingsChanged(stage.settings);stage.sampleAt(2100);capture(stage,"fill-next");
    CHECK(stage.controller.frame().coverRect.width==680);
    stage.settings.reducedMotion=true;stage.settings.poster=true;stage.controller.settingsChanged(stage.settings);stage.sampleAt(2200);
    CHECK(stage.controller.frame().poster==1);CHECK_FALSE(stage.controller.frame().animating);
}
TEST_CASE("Linux late queue artwork measures final geometry independently of cover opacity") {
    Stage stage;stage.resize(680,820);stage.settings.next=true;stage.controller.settingsChanged(stage.settings);
    auto next=fixture();next.cover.clear();stage.present(next,0,true);stage.controller.remainingChanged(10);
    stage.sampleAt(0);stage.sampleAt(500);stage.sampleAt(800);const float textOnly=stage.controller.frame().nextWidth;
    next.cover=encoded(Qt::green);stage.present(next,0,true);
    for(int i=0;i<=40;++i)stage.sampleAt(810+i*16);
    const auto settled=stage.controller.frame();CHECK(settled.nextWidth>textOnly);CHECK(settled.nextCoverLayout==1);CHECK(settled.next.coverOpacity==1);
    stage.sampleAt(1800);CHECK(stage.controller.frame().nextWidth==settled.nextWidth);
}
TEST_CASE("Linux starts with Windows defaults and preserves explicit stored overrides") {
    QSettings store("dudesoft", "24sevenfm-covers"); // isolated by the test entry point
    for (bool saved : {false, true}) {
        store.clear();
        if (saved) {
            for (const char* key : {"poster", "countdown", "rolling", "next"}) store.setValue(key, true);
            store.setValue("countdownSize", 2);
        }
        store.sync();
        Viewer viewer(false);
        const ssccfg::EngineSettings reference;
        const auto& values = viewer.stage->settings;
        CHECK(values.poster == (saved ? true : reference.layout != 0));
        CHECK(values.countdown == (saved ? true : reference.showRemaining));
        CHECK(values.rolling == (saved ? true : reference.rollDigits));
        CHECK(values.next == (saved ? true : reference.comingNext));
        CHECK(values.countdownSize == (saved ? 2 : reference.remainingSize));
        viewer.showSettings();
        auto* dialog = viewer.findChild<QDialog*>(); REQUIRE(dialog);
        for (const char* key : {"countdown", "rolling", "next"}) {
            auto* checkbox = dialog->findChild<QCheckBox*>(key); REQUIRE(checkbox);
            CHECK(checkbox->isChecked() == saved);
            CHECK(viewer.preferences.contains(key) == saved);
        }
        const QString layout = saved ? "poster1" : "poster0";
        const QString size = saved ? "countdownSize2" : "countdownSize0";
        REQUIRE(dialog->findChild<QRadioButton*>(layout));
        REQUIRE(dialog->findChild<QRadioButton*>(size));
        CHECK(dialog->findChild<QRadioButton*>(layout)->isChecked());
        CHECK(dialog->findChild<QRadioButton*>(size)->isChecked());
    }
    store.clear(); store.sync();
}
TEST_CASE("Linux native settings use radios, preserve preferences and support window controls") {
    Viewer viewer(false);viewer.show();viewer.preferences.setValue("reducedMotion",true);viewer.applyPreferences();viewer.showSettings();
    auto* dialog=viewer.findChild<QDialog*>();REQUIRE(dialog);CHECK(dialog->findChildren<QComboBox*>().isEmpty());
    auto* death=dialog->findChild<QRadioButton*>("station3");REQUIRE(death);QTest::mouseClick(death,Qt::LeftButton);CHECK(viewer.stationIndex()==3);
    auto* tabs=dialog->findChild<QTabWidget*>();REQUIRE(tabs);tabs->setCurrentIndex(1);
    auto* fill=dialog->findChild<QRadioButton*>("poster0");REQUIRE(fill);QTest::mouseClick(fill,Qt::LeftButton);CHECK_FALSE(viewer.stage->settings.poster);
    auto* large=dialog->findChild<QRadioButton*>("countdownSize2");REQUIRE(large);QTest::mouseClick(large,Qt::LeftButton);CHECK(viewer.stage->settings.countdownSize==2);
    viewer.toggleFullscreen();CHECK(viewer.isFullScreen());viewer.toggleFullscreen();CHECK_FALSE(viewer.isFullScreen());
    auto dir=qEnvironmentVariable("SSC_UI_CHECK_DIR");if(!dir.isEmpty()){QDir(dir).mkpath(".");CHECK(dialog->grab().save(QDir(dir).filePath("settings.png")));}
    dialog->close();viewer.preferences.sync();QSettings reread("dudesoft","24sevenfm-covers");CHECK(reread.value("station").toString()=="death");
}
TEST_CASE("Linux TLS request honours cancellation before any connection") {
    std::atomic<bool> cancel{true};const auto r=ssc::httpRequest("example.invalid",443,"/","GET","","",3,&cancel);
    CHECK(r.status==0);CHECK(r.body.empty());CHECK(r.error=="cancelled");
}
TEST_CASE("Linux animated settings close destroys the complete native window") {
    QSettings store("dudesoft","24sevenfm-covers");store.clear();store.setValue("reducedMotion",false);store.sync();
    Viewer viewer(false);viewer.show();
    for(int route=0;route<3;++route) {
        INFO("close route ",route);
        viewer.showSettings();QPointer<QDialog> dialog=viewer.findChild<QDialog*>();REQUIRE(dialog);
        REQUIRE(QTest::qWaitForWindowExposed(dialog));
        // Close during entrance as well as after the entrance has completed.
        QTest::qWait(route==0?25:230);
        if(route==0) {
            auto buttons=dialog->findChildren<QPushButton*>();
            auto close=std::find_if(buttons.begin(),buttons.end(),[](QPushButton* b){return b->text()=="Close";});
            REQUIRE(close!=buttons.end());QTest::mouseClick(*close,Qt::LeftButton);
        } else if(route==1) {
            // Exercise Escape only after Wayland has activated the dialog.
            dialog->activateWindow();
            REQUIRE(QTest::qWaitFor([&]{return dialog && dialog->isActiveWindow();}));
            QTest::keyClick(dialog,Qt::Key_Escape);
        }
        else dialog->close();
        QElapsedTimer elapsed;elapsed.start();
        while(dialog && elapsed.elapsed()<1500) {
            QTest::qWait(20);QCoreApplication::sendPostedEvents(nullptr,QEvent::DeferredDelete);
        }
        CHECK(dialog.isNull());CHECK(viewer.findChildren<QDialog*>().isEmpty());
    }
    store.clear();store.sync();
}
TEST_CASE("Linux title logo uses shared visible bounds and replaces the text header") {
    QImage padded(1000,400,QImage::Format_ARGB32);padded.fill(Qt::transparent);
    {QPainter painter(&padded);painter.fillRect(QRect(300,150,400,100),Qt::yellow);}
    QByteArray bytes;QBuffer buffer(&bytes);buffer.open(QIODevice::WriteOnly);padded.save(&buffer,"PNG");
    REQUIRE(Stage::decodeLogo(bytes.toStdString()).size()==QSize(400,100));
    Stage first,second;
    auto prepare=[&](Stage& stage,const char* album) {
        stage.resize(680,820);stage.show();stage.settings.poster=true;stage.settings.countdown=true;
        stage.controller.settingsChanged(stage.settings);auto frame=fixture();frame.track.album=album;
        frame.logo=bytes.toStdString();stage.present(frame,0,false);stage.controller.remainingChanged(45);
        for(auto time:{0,1200,1600,2200,2800})stage.sampleAt(time);
    };
    prepare(first,"ALBUM AAAA");prepare(second,"ALBUM ZZZZ");
    CHECK(first.snapshot()==second.snapshot()); // invisible album text cannot affect native pixels or width
    const auto pixels=first.snapshot();QRect yellow;
    for(int y=0;y<pixels.height();++y)for(int x=0;x<pixels.width();++x) {
        const auto c=pixels.pixelColor(x,y);
        if(c.red()>240 && c.green()>240 && c.blue()<20)yellow=yellow.united(QRect(x,y,1,1));
    }
    const auto type=ssc::posterTypography(680,820);
    const auto size=ssc::titleLogoSize(400,100,680,820,type.title,1);
    const auto& frame=first.controller.frame();
    CHECK(yellow.width()==doctest::Approx(size.width).epsilon(.01));
    CHECK(yellow.height()==doctest::Approx(size.height).epsilon(.02));
    CHECK(yellow.center().y()==doctest::Approx(frame.infoRect.y).epsilon(.005));
    // Countdown uses the existing infobox background, not another painted capsule.
    const int countX=qRound(frame.countdownRect.x)+2,countY=qRound(frame.countdownRect.y)+2;
    CHECK(pixels.pixelColor(countX,countY)==pixels.pixelColor(countX-12,countY));
    capture(first,"shared-title-logo");
}
TEST_CASE("Linux typography preserves fractional shared sizes and Windows weight values") {
    const auto type=ssc::posterTypography(680,820);
    const auto title=linuxui::presentationFont(type.title,QFont::DemiBold);
    const auto artist=linuxui::presentationFont(type.artist,QFont::Normal);
    const auto track=linuxui::presentationFont(type.track,QFont::Medium);
    CHECK(int(title.weight())==600);CHECK(int(artist.weight())==400);CHECK(int(track.weight())==500);
    const auto dpi=QGuiApplication::primaryScreen()->logicalDotsPerInchY();
    CHECK(title.pointSizeF()*dpi/72.==doctest::Approx(type.title));
    CHECK(track.pointSizeF()*dpi/72.==doctest::Approx(type.track));
    QFile kernel("/proc/sys/kernel/osrelease");
    if(kernel.open(QIODevice::ReadOnly) && kernel.readAll().toLower().contains("microsoft")
        && QFile::exists("/mnt/c/Windows/Fonts/segoeui.ttf"))
        CHECK(title.family()=="Segoe UI");
}
TEST_CASE("Linux media adapter draws and retains backdrop logo and rating resources") {
    Stage stage;stage.resize(680,820);stage.show();stage.settings.poster=true;stage.settings.ratings=true;
    stage.controller.settingsChanged(stage.settings);auto frame=fixture();frame.backdrop=encoded(Qt::darkRed);
    frame.logo=encoded(Qt::yellow,180,40);ssc::PreparedRating rating;rating.country="DE";rating.bytes=encoded(Qt::green,48,48);frame.ratings.push_back(rating);
    stage.present(frame,0,false);stage.sampleAt(0);stage.sampleAt(1200);stage.sampleAt(1600);stage.sampleAt(2000);
    const auto& visual=stage.controller.frame();CHECK(visual.backdrop.size()==1);CHECK(visual.coverOpacity==0);
    CHECK(visual.logoOpacity==1);CHECK(visual.ratings.size()==1);CHECK(visual.ratingOpacity==1);capture(stage,"sst-assets");
    frame.backdrop.clear();frame.logo.clear();frame.ratings.clear();stage.present(frame,0,false);stage.sampleAt(2100);
    CHECK_FALSE(stage.controller.frame().backdrop.empty());CHECK_FALSE(stage.controller.frame().ratings.empty());
    stage.sampleAt(3300);CHECK(stage.controller.frame().backdrop.empty());CHECK(stage.controller.frame().ratings.empty());
}
int main(int argc,char** argv) {
    qputenv("SSC_TEST_MODE","1");QTemporaryDir settings; qputenv("XDG_CONFIG_HOME",settings.path().toUtf8());
    Q_INIT_RESOURCE(resources);QApplication app(argc,argv);doctest::Context context;context.applyCommandLine(argc,argv);return context.run();
}

TEST_CASE("Linux hidden feed countdown causes neither paint nor text measurement") {
    Stage stage;stage.resize(680,820);stage.show();stage.settings.countdown=false;stage.settings.rolling=true;
    stage.controller.settingsChanged(stage.settings);stage.present(fixture(),0,false);
    for(int t=0;t<=3000;t+=16)stage.sampleAt(t);
    QCoreApplication::processEvents();stage.resetStatistics();stage.profiling=true;
    for(int t=4000;t<9000;t+=16){
        stage.controller.remainingChanged(180-t/1000);stage.sampleAt(t);QCoreApplication::processEvents();
    }
    CHECK(stage.stats.animated==0);CHECK(stage.stats.measures==0);CHECK(stage.stats.paints==0);
}

TEST_CASE("Linux raster upload reference preserves native QWidget text pixels") {
    Stage stage;stage.resize(680,820);stage.show();
    REQUIRE(QTest::qWaitForWindowExposed(&stage));
    stage.settings.poster=true;stage.settings.countdown=true;stage.settings.rolling=true;
    stage.controller.settingsChanged(stage.settings);stage.present(fixture(),0,false);
    stage.controller.remainingChanged(9);
    for(int t=0;t<=3000;t+=16)stage.sampleAt(t);
    QCoreApplication::processEvents();
    const auto actual=stage.snapshot().convertToFormat(QImage::Format_RGBA8888);
    const auto reference=stage.rasterSnapshot().convertToFormat(QImage::Format_RGBA8888);
    REQUIRE_FALSE(actual.isNull());
    CHECK(actual==reference);
}

TEST_CASE("Linux raster backing store clears rounded fractional device edges") {
    Stage stage;stage.resize(805,491);
    const auto image=stage.rasterSnapshot().convertToFormat(QImage::Format_RGBA8888);
    REQUIRE_FALSE(image.isNull());
    bool opaqueBackground=true;
    const QColor background(16,18,24);
    for(int y=0;y<image.height();++y)
        opaqueBackground &= image.pixelColor(image.width()-1,y)==background;
    for(int x=0;x<image.width();++x)
        opaqueBackground &= image.pixelColor(x,image.height()-1)==background;
    CHECK(opaqueBackground);
}

TEST_CASE("Linux renderer selection persists without changing the running renderer") {
    QSettings store("dudesoft","24sevenfm-covers");store.clear();
    store.setValue("renderer","opengl-direct");store.setValue("reducedMotion",true);store.sync();
    Viewer viewer(false);viewer.show();viewer.showSettings();
    QPointer<QDialog> dialog=viewer.findChild<QDialog*>();REQUIRE(dialog);
    auto* direct=dialog->findChild<QRadioButton*>("renderer-opengl-direct");REQUIRE(direct);CHECK(direct->isChecked());
    auto* raster=dialog->findChild<QRadioButton*>("renderer-raster");REQUIRE(raster);
    auto* restart=dialog->findChild<QPushButton*>("restartRenderer");REQUIRE(restart);CHECK(restart->isEnabled());
    auto* tabs=dialog->findChild<QTabWidget*>();REQUIRE(tabs);tabs->setCurrentIndex(tabs->count()-1);
    QTest::mouseClick(raster,Qt::LeftButton);store.sync();
    CHECK(store.value("renderer").toString()=="raster");CHECK_FALSE(restart->isEnabled());
    if(direct->isEnabled()) {
        QTest::mouseClick(direct,Qt::LeftButton);store.sync();
        CHECK(store.value("renderer").toString()=="opengl-direct");CHECK(restart->isEnabled());
    }
    CHECK(linuxui::activeRenderer()=="raster");CHECK_FALSE(viewer.restartRequested);
    CHECK(linuxui::rendererChoice("../../untrusted")==nullptr);
    const auto captureDir=qEnvironmentVariable("SSC_UI_CHECK_DIR");
    if(!captureDir.isEmpty()){QDir(captureDir).mkpath(".");CHECK(dialog->grab().save(captureDir+"/renderer-settings.png"));}
    if(restart->isEnabled()) {
        QTest::mouseClick(restart,Qt::LeftButton);
        CHECK(viewer.restartRequested);CHECK_FALSE(viewer.isVisible());
    }
    if(dialog)dialog->close();store.clear();store.sync();
}
