#include "stage.h"
#include <QApplication>
#include <QBuffer>
#include <QCommandLineParser>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QSurfaceFormat>
#include <sys/resource.h>
#include <numeric>
#include <cmath>

namespace {
double cpuMs() {rusage u{};getrusage(RUSAGE_SELF,&u);return (u.ru_utime.tv_sec+u.ru_stime.tv_sec)*1000.+(u.ru_utime.tv_usec+u.ru_stime.tv_usec)/1000.;}
QJsonObject distribution(std::vector<double> v) {
    if(v.empty())return {{"n",0},{"avg",QJsonValue()},{"p95",QJsonValue()}};
    const double avg=std::accumulate(v.begin(),v.end(),0.)/v.size();std::sort(v.begin(),v.end());
    return {{"n",int(v.size())},{"avg",avg},{"p95",v[size_t(std::ceil(v.size()*.95))-1]}};
}
std::string encode(const QImage& img) {QByteArray b;QBuffer buffer(&b);buffer.open(QIODevice::WriteOnly);img.save(&buffer,"PNG");return b.toStdString();}
ssc::PreparedPresentation fixture(int index) {
    ssc::PreparedPresentation p;
    p.track.album=index%2?"Across the Ocean":"The Sound of Cinema";
    p.track.artist="A. Composer";p.track.track=index%2?"A New Beginning":"Finale";p.track.asin="fixture-"+std::to_string(index);
    QImage art(1024,1024,QImage::Format_RGB32);
    for(int y=0;y<art.height();++y)for(int x=0;x<art.width();++x)
        art.setPixel(x,y,qRgb((x/4+index*61)%256,(y/4+index*37)%256,((x+y)/8+index*19)%256));
    QPainter painter(&art);painter.setPen(Qt::white);painter.setFont(QFont("sans-serif",64));painter.drawText(art.rect(),Qt::AlignCenter,"24seven.fm\nCINEMA");painter.end();
    p.cover=encode(art);return p;
}
void settle(Stage& s) {for(int t=0;t<=3000;t+=16)s.sampleAt(t);}
}
int main(int argc,char** argv) {
    qputenv("SSC_TEST_MODE","1");
    QSurfaceFormat format;format.setSwapInterval(1);QSurfaceFormat::setDefaultFormat(format);
    Q_INIT_RESOURCE(resources);
    QApplication app(argc,argv);
    QCommandLineParser args;args.addHelpOption();
    args.addOptions({{"scenario","idle, countdown, changes or resize","name","idle"},
                     {"warmup","Warmup seconds","seconds","3"},
                     {"seconds","Measured seconds","seconds","8"},
                     {"output","Output JSON","file"},{"visual","Deterministic screenshot directory","directory"}});
    args.process(app);
    const auto scenario=args.value("scenario");
    if(!QStringList{"idle","countdown","changes","resize"}.contains(scenario))return 2;
    const int warmup=args.value("warmup").toInt()*1000,duration=args.value("seconds").toInt()*1000;
    if(warmup<0||duration<1000)return 2;
    Stage s;s.resize(680,820);s.setWindowTitle("24seven renderer benchmark");s.setMouseTracking(false);
    s.settings.poster=true;s.settings.countdown=scenario=="countdown";s.settings.rolling=true;s.settings.next=true;
    s.controller.settingsChanged(s.settings);
    const auto a=fixture(0),b=fixture(1);s.present(a,0,false);s.present(b,0,true);s.controller.remainingChanged(scenario=="countdown"?12:-1);
    settle(s);s.show();
    if(args.isSet("visual")) {
        QDir out(args.value("visual"));out.mkpath(".");
        QTimer::singleShot(500,&s,[&]{
            int step=0;
            const auto capture=[&](const QString& name){
                s.repaint();QApplication::processEvents();
                const auto actual=s.snapshot().convertToFormat(QImage::Format_RGBA8888);
                const auto reference=s.rasterSnapshot().convertToFormat(QImage::Format_RGBA8888);
                actual.save(out.filePath(name+".png"));reference.save(out.filePath(name+"-reference.png"));
                if(actual.isNull()||actual.size()!=reference.size())qFatal("Invalid framebuffer capture");
                double error=0;quint64 changed=0;
                for(int y=0;y<actual.height();++y)for(int x=0;x<actual.width();++x){
                    bool different=false;for(int c=0;c<3;++c){const int d=std::abs(int(actual.constScanLine(y)[x*4+c])-int(reference.constScanLine(y)[x*4+c]));error+=d;different|=d!=0;}changed+=different;
                }
                qInfo().noquote()<<"VISUAL"<<name<<"MAE"<<error/(actual.width()*actual.height()*3)<<"differentPixels"<<changed;
                ++step;
            };
            s.controller.pointerChanged(false,false,false);s.sampleAt(5000);s.sampleAt(5500);capture("poster");
            s.settings.countdown=true;s.controller.settingsChanged(s.settings);s.controller.remainingChanged(9);s.sampleAt(5600);s.sampleAt(6500);capture("countdown-next");
            s.controller.remainingChanged(8);s.sampleAt(6600);s.sampleAt(6750);capture("rolling");
            s.present(b,0,false);s.sampleAt(6800);s.sampleAt(7000);capture("transition");
            s.settings.poster=false;s.controller.settingsChanged(s.settings);s.sampleAt(7200);s.sampleAt(8500);capture("fill");
            s.resize(900,650);s.sampleAt(8600);s.sampleAt(9800);capture("resize");
            app.exit(step==6?0:3);
        });return app.exec();
    }
    QElapsedTimer wall;wall.start();QTimer tick;tick.setTimerType(Qt::PreciseTimer);tick.setInterval(16);
    bool measuring=false;double startCpu=0;int lastChange=-1,lastSecond=-1; qint64 startWall=0;
    QObject::connect(&tick,&QTimer::timeout,&s,[&]{
        const auto elapsed=wall.elapsed();
        if(!measuring && elapsed>=warmup){s.resetStatistics();s.profiling=true;startCpu=cpuMs();startWall=elapsed;measuring=true;}
        if(measuring && elapsed-startWall>=duration) {
            s.profiling=false;
            auto backend=s.backendInfo;
#if SSC_RENDERER == 0
            backend={{"api","Raster"},{"path","QWidget/QPainter raster backing store"}};
#endif
            QJsonObject result{{"qt",qVersion()},{"platform",QGuiApplication::platformName()},{"backend",backend},
                {"scenario",scenario},{"warmupMs",warmup},{"elapsedMs",elapsed-startWall},
                {"cpuPercentOneCore",(cpuMs()-startCpu)/(elapsed-startWall)*100.},
                {"paintCount",qint64(s.stats.paints)},{"tickCount",qint64(s.stats.ticks)},
                {"measureCount",qint64(s.stats.measures)},{"animatedTicks",qint64(s.stats.animated)},
                {"renderCpuMs",distribution(s.stats.renderMs)},{"paintIntervalMs",distribution(s.stats.intervalMs)},
                {"dpr",s.devicePixelRatioF()},{"gpuTimeMs",QJsonValue()},{"gpuUtilization",QJsonValue()},
                {"gpuMetricNote","Unavailable: no validated per-process hardware counter; renderCpuMs is callback elapsed wall time including waits, not thread CPU, GPU or presentation latency"}};
            if(args.isSet("output")){QFile file(args.value("output"));if(!file.open(QIODevice::WriteOnly))qFatal("Cannot write results");file.write(QJsonDocument(result).toJson());}
            puts(QJsonDocument(result).toJson(QJsonDocument::Compact).constData());
            // Keep the native surface alive until Stage releases its resources
            // during normal QApplication shutdown.
            tick.stop();app.quit();return;
        }
        if((scenario=="countdown" || scenario=="idle") && elapsed/1000!=lastSecond){lastSecond=elapsed/1000;s.controller.remainingChanged(scenario=="idle"?180-lastSecond:12-lastSecond%10);}
        if(scenario=="changes" && elapsed/1500!=lastChange){lastChange=elapsed/1500;s.present(lastChange%2?b:a,0,false);}
        if(scenario=="resize"){const double phase=elapsed/700.;s.resize(680+int(160*std::sin(phase)),700+int(110*std::cos(phase)));}
        s.sampleAt(4000+elapsed);
    });tick.start();return app.exec();
}
