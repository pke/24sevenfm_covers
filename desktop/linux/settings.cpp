#include "viewer.h"
#include "motion.h"
#include "renderer_choice.h"
#include <QVBoxLayout>
#include <QGroupBox>
#include <QRadioButton>
#include <QButtonGroup>
#include <QCheckBox>
#include <QPushButton>
#include <QTabWidget>
#include <QLineEdit>
#include <QListWidget>
#include <QLabel>
#include <QPropertyAnimation>
#include <QCloseEvent>
#include <QKeyEvent>
#include <QStackedWidget>

namespace {
class SettingsDialog : public QDialog {
    bool exiting=false;
    bool reduced;
public:
    SettingsDialog(QWidget* parent,bool reduce):QDialog(parent),reduced(reduce) { setAttribute(Qt::WA_DeleteOnClose); }
    bool event(QEvent* event) override {
        // The viewer's Escape shortcut can remain eligible while this child
        // window is active. Reserve Escape so QDialog::keyPressEvent rejects
        // the settings dialog through its normal animated close path.
        if(event->type()==QEvent::ShortcutOverride && static_cast<QKeyEvent*>(event)->key()==Qt::Key_Escape) {
            event->accept();return true;
        }
        return QDialog::event(event);
    }
    void closeEvent(QCloseEvent* e) override {
        e->ignore();reject();
    }
    void reject() override {
        if(exiting)return;
        exiting=true;
        // QDialog::closeEvent calls the virtual reject(). Calling close() again
        // from reject() recursed into Qt's close guard and left the shell alive.
        if(reduced)QDialog::reject();
        else fadeContent(this,false,180,[this]{QDialog::reject();});
    }
};
}
void Viewer::showSettings() {
    if(dialog_){dialog_->show();dialog_->raise();dialog_->activateWindow();return;}
    auto* dialog=new SettingsDialog(this,reducedMotion());dialog_=dialog;dialog->setWindowTitle("24seven.fm — Settings");dialog->resize(560,630);
    auto* root=new QVBoxLayout(dialog); auto* tabs=new QTabWidget(dialog); root->addWidget(tabs);
    // QTabWidget normally hides the outgoing page immediately. Retain native
    // pixels above the new page until its exit fade has completed.
    auto previous=std::make_shared<int>(0);
    connect(tabs,&QTabWidget::currentChanged,dialog,[this,tabs,previous](int index){
        const int old=*previous;*previous=index;
        if(old==index || old<0 || old>=tabs->count() || reducedMotion())return;
        auto* stack=tabs->findChild<QStackedWidget*>();if(!stack)return;
        auto* retained=new QLabel(stack);retained->setPixmap(tabs->widget(old)->grab());
        retained->setGeometry(stack->contentsRect());retained->setAttribute(Qt::WA_TransparentForMouseEvents);
        retained->show();retained->raise();fadeContent(retained,false,180,[retained]{retained->deleteLater();});
    });
    auto page=[&](const QString& title){auto* widget=new QWidget;auto* box=new QVBoxLayout(widget);box->setAlignment(Qt::AlignTop);tabs->addTab(widget,title);return box;};
    auto change=[this](const QString& key,QVariant value){preferences.setValue(key,value);applyPreferences();};
    auto check=[&](QVBoxLayout* layout,QString label,QString key){
        auto* b=new QCheckBox(label);b->setObjectName(key);b->setChecked(preference(key.toUtf8().constData()).toBool());layout->addWidget(b);
        connect(b,&QCheckBox::toggled,this,[change,key](bool value){change(key,value);});return b;
    };
    auto choices=[&](QVBoxLayout* layout,QString title,QString key,QStringList labels){
        auto* box=new QGroupBox(title);auto* row=new QHBoxLayout(box);auto* group=new QButtonGroup(box);layout->addWidget(box);
        for(int i=0;i<labels.size();++i){auto* b=new QRadioButton(labels[i]);b->setObjectName(key+QString::number(i));group->addButton(b,i);row->addWidget(b);b->setChecked(preference(key.toUtf8().constData()).toInt()==i);}
        connect(group,&QButtonGroup::idClicked,this,[change,key](int value){change(key,value);});
    };
    // Native radio semantics, generous button-like hit targets; never a combo box.
    dialog->setStyleSheet("QRadioButton { padding: 10px; border: 1px solid palette(mid); border-radius: 6px; } QRadioButton:checked { background: palette(highlight); color: palette(highlighted-text); } QGroupBox { margin-top: 10px; padding-top: 16px; } ");
    auto* stations=page("Station");auto* group=new QButtonGroup(dialog);
    for(int i=0;i<ssc::kStationCount;++i){const auto& station=ssc::station(i);auto* button=new QRadioButton(QString::fromUtf8(station.displayName));
        button->setObjectName(QString("station%1").arg(i));button->setIcon(QIcon(QString(":/stations/%1.png").arg(station.id)));button->setIconSize({40,40});
        button->setToolTip(QString::fromUtf8(station.desc));button->setChecked(stationIndex()==i);group->addButton(button,i);stations->addWidget(button);}
    connect(group,&QButtonGroup::idClicked,this,[change](int i){change("station",ssc::station(i).id);});
    auto* display=page("Display");
    choices(display,"Layout","poster",{"Fill","Poster"});
    check(display,"Show countdown","countdown");choices(display,"Countdown size","countdownSize",{"Small","Medium","Large"});
    check(display,"Rolling digits","rolling");check(display,"Coming Next","next");
    check(display,"Keep window on top (where supported)","alwaysOnTop");
    check(display,"Reduce motion","reducedMotion");
    auto* fullscreen=new QPushButton("Toggle fullscreen · F11");display->addWidget(fullscreen);connect(fullscreen,&QPushButton::clicked,this,[this]{toggleFullscreen();});
    auto* art=page("Artwork");
    choices(art,"Transition","effect",{"Fade only","Crossfade","Flip X","Flip Y"});
    auto* backdrop=check(art,"SST backdrops","backdrops");
    check(art,"Hide cover over backdrops","hideCover");
    auto* logos=check(art,"SST title logos","logos");
    auto* ratings=check(art,"SST age ratings","ratings");
    check(art,"Germany (DE)","ratingDE");check(art,"United States (US)","ratingUS");
    auto updateEligibility=[this,backdrop,logos,ratings]{const bool sst=stationIndex()==0;backdrop->setEnabled(sst);logos->setEnabled(sst);ratings->setEnabled(sst);};
    updateEligibility();connect(group,&QButtonGroup::idClicked,dialog,[updateEligibility](int){updateEligibility();});
    auto* providers=page("Providers");providers->addWidget(new QLabel("Artwork lookup order (SST)"));
    auto* list=new QListWidget;list->setObjectName("providers");providers->addWidget(list);
    list->addItems(preference("providers").toString().split(','));list->setCurrentRow(0);
    auto* row=new QHBoxLayout;providers->addLayout(row);
    for(auto pair:{std::make_pair(QString("Move up"),-1),std::make_pair(QString("Move down"),1)}){
        auto* button=new QPushButton(pair.first);row->addWidget(button);connect(button,&QPushButton::clicked,dialog,[list,change,delta=pair.second]{
            int current=list->currentRow(),target=current+delta;if(current<0 || target<0 || target>=list->count())return;
            auto* item=list->takeItem(current);list->insertItem(target,item);list->setCurrentRow(target);QStringList order;
            for(int i=0;i<list->count();++i)order<<list->item(i)->text();
            change("providers",order.join(','));
        });
    }
    providers->addWidget(new QLabel("Personal fanart.tv key (optional)"));auto* key=new QLineEdit(preference("fanartKey").toString());key->setEchoMode(QLineEdit::Password);providers->addWidget(key);
    connect(key,&QLineEdit::editingFinished,dialog,[change,key]{change("fanartKey",key->text().trimmed());});
    auto* rendering=page("Renderer");
    auto* rendererGroup=new QButtonGroup(dialog);
    const QString selected=preference("renderer").toString();
    for(const auto& option:linuxui::renderers) {
        auto* button=new QRadioButton(QString::fromUtf8(option.label));
        button->setObjectName("renderer-"+QString::fromLatin1(option.id));
        button->setChecked(selected==QLatin1String(option.id));
        const bool available=QString::fromLatin1(option.id)=="raster" || QFileInfo(linuxui::rendererExecutable(option)).isExecutable();
        button->setEnabled(available);
        if(!available)button->setToolTip("This renderer is not included in the installed build.");
        rendererGroup->addButton(button);rendering->addWidget(button);
        connect(button,&QRadioButton::clicked,dialog,[this,id=QString::fromLatin1(option.id)]{
            preferences.setValue("renderer",id);preferences.sync();
        });
    }
    auto* explanation=new QLabel("Changes take effect after restarting the viewer. OpenGL accelerated drawing may change text and edge appearance. Exact-appearance modes retain raster drawing and use the GPU for composition.");
    explanation->setWordWrap(true);rendering->addWidget(explanation);
    auto* current=new QLabel("Active: "+linuxui::activeRenderer()+"\n"+stage->backendInfo.value("renderer").toString());
    current->setObjectName("activeRenderer");current->setWordWrap(true);rendering->addWidget(current);
    auto* fallback=new QLabel(QCoreApplication::instance()->property("rendererFallback").toString());
    fallback->setObjectName("rendererFallback");fallback->setWordWrap(true);rendering->addWidget(fallback);
    auto* restart=new QPushButton("Restart viewer");restart->setObjectName("restartRenderer");rendering->addWidget(restart);
    auto updateRestart=[this,restart]{restart->setEnabled(preference("renderer").toString()!=linuxui::activeRenderer());};
    updateRestart();connect(rendererGroup,&QButtonGroup::buttonClicked,dialog,[updateRestart](QAbstractButton*){updateRestart();});
    connect(restart,&QPushButton::clicked,this,[this]{restartRequested=true;close();});
    auto* close=new QPushButton("Close");root->addWidget(close);connect(close,&QPushButton::clicked,dialog,&QDialog::close);
    dialog->show();
    if(!reducedMotion())fadeContent(dialog,true,180);
}
