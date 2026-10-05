#include "viewer.h"
#include "motion.h"
#include "renderer_choice.h"
#include "../../lib/image_probe.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QPropertyAnimation>
#include <QProcess>
#include <QStatusBar>
#include <QJsonDocument>
#include <QSurfaceFormat>
#include <cstdio>

int smoke() {
    std::atomic<bool> cancelled{true};
    if(ssc::httpRequest("streamingsoundtracks.com",443,"/","GET","","",3,&cancelled).error!="cancelled")return 2;
    for(int station=0;station<ssc::kStationCount;++station){
        ssc::Config config;config.host=ssc::station(station).host;
        ssc::CoverMonitor monitor([](const std::string&,const ssc::TrackInfo&){},config);
        ssc::TrackInfo track;std::string error;
        if(!monitor.pollOnce(track,&error)){fprintf(stderr,"%s: %s\n",config.host.c_str(),error.c_str());return 3;}
        const auto bytes=ssc::MediaPreparation().cover(track.coverUrl,station,12);
        if(!track.coverUrl.empty() && (bytes.empty() || !ssc::decodableImage(bytes,track.coverUrl) || Stage::decode(bytes).isNull()))return 4;
        printf("HTTPS/feed/image %s: %s (%zu bytes)\n",config.host.c_str(),track.album.c_str(),bytes.size());
    }
    ssc::MediaRequest normalization;
    normalization.album="Loving Vincent, The";normalization.track="Cue &#039;A&#039;";
    normalization.artist="Caf&amp;eacute;";normalization.includeArt=false;normalization.includeRatings=false;
    const auto canonical=ssc::MediaResolver().resolve(normalization);
    if(!canonical.hasMetadata || canonical.album!="The Loving Vincent" || canonical.track!="Cue 'A'" || canonical.artist!="Caf&eacute;")return 6;
    puts("PASS: shared API HTML/article normalization");
    return 0;
}
int main(int argc,char** argv) {
    QSurfaceFormat format;format.setSwapInterval(1);QSurfaceFormat::setDefaultFormat(format);
    Q_INIT_RESOURCE(resources);
    QApplication app(argc,argv);app.setApplicationName("24sevenfm_covers");app.setOrganizationName("dudesoft");
    QCommandLineParser args;args.setApplicationDescription("24seven.fm Covers — Linux desktop viewer");args.addHelpOption();
    args.addOption({"smoke-test","Exercise live HTTPS, all five feeds and native image decoding, then exit."});
    args.addOption({"capture","Save a live window capture after 30 seconds and exit.","directory"});
    args.addOption({"renderer","Override the saved Linux renderer for this launch.","name"});
    QCommandLineOption worker("renderer-worker","Internal supervised GPU process.");
    worker.setFlags(QCommandLineOption::HiddenFromHelp);args.addOption(worker);
    args.addOption({"renderer-check","Open the selected renderer without network access, report its backend and exit."});
    args.process(app);
    if(args.isSet("smoke-test"))return smoke();
    QSettings preferences("dudesoft","24sevenfm-covers");
    QString requested=args.isSet("renderer")?args.value("renderer"):preferences.value("renderer","raster").toString();
    const auto* choice=linuxui::rendererChoice(requested);
    QString fallback;
#if SSC_RENDERER == 0
    if(args.isSet("renderer-worker"))return 2;
    if(requested!="raster") {
        if(!choice)fallback="Unknown renderer. Using QPainter / Raster.";
        else if(!QFileInfo(linuxui::rendererExecutable(*choice)).isExecutable())
            fallback="The selected renderer is not installed. Using QPainter / Raster.";
        else {
            auto childArgs=app.arguments().mid(1);childArgs<<"--renderer-worker";
            QProcess child;child.setProcessChannelMode(QProcess::ForwardedOutputChannel);
            QByteArray diagnostics;
            QObject::connect(&child,&QProcess::readyReadStandardError,[&]{
                const auto chunk=child.readAllStandardError();
                fwrite(chunk.constData(),1,size_t(chunk.size()),stderr);
                diagnostics=(diagnostics+chunk).right(4096);
            });
            child.start(linuxui::rendererExecutable(*choice),childArgs);
            if(child.waitForStarted()) {
                child.waitForFinished(-1);
                if(child.exitStatus()==QProcess::NormalExit && child.exitCode()==0)return 0;
            }
            fallback=diagnostics.contains("Software renderer rejected")
                ? "The selected renderer only offered software rendering. Using QPainter / Raster."
                : "The selected GPU renderer could not run. Using QPainter / Raster; choose another renderer in Settings.";
        }
        qWarning().noquote()<<fallback;
        requested="raster";
    }
#else
    const bool expected=choice &&
#if SSC_RENDERER == 1
        (requested=="opengl" || requested=="opengl-direct");
#else
        (requested=="rhi-opengl" || requested=="rhi-vulkan");
#endif
    if(!args.isSet("renderer-worker") || !expected)return 2;
    // A software fallback must be reported to the supervising raster entry
    // point instead of silently running a misleading GPU selection.
    qputenv("SSC_REQUIRE_HARDWARE","1");
    qputenv("SSC_GL_EXACT",requested=="opengl"?"1":"0");
    qputenv("SSC_RHI_BACKEND",requested=="rhi-vulkan"?"vulkan":"opengl");
#endif
    app.setProperty("activeRenderer",requested);
    app.setProperty("rendererFallback",fallback);
    Viewer viewer(!args.isSet("renderer-check"));viewer.show();
    if(!fallback.isEmpty())viewer.statusBar()->showMessage(fallback);
    if(!viewer.reducedMotion() && !args.isSet("renderer-check")) {
        viewer.fadeStage(true);
    }
#if SSC_RENDERER != 0
    QTimer::singleShot(10000,&viewer,[&]{
        if(viewer.stage->backendInfo.isEmpty()){qCritical("No GPU render context initialized");app.exit(78);}
    });
#endif
    if(args.isSet("renderer-check"))QTimer::singleShot(1500,&viewer,[&]{
        if(requested!="raster" && viewer.stage->backendInfo.isEmpty()){app.exit(78);return;}
        const QJsonObject result{{"active",requested},{"fallback",fallback},{"backend",viewer.stage->backendInfo},
            {"platform",QGuiApplication::platformName()},{"qt",qVersion()}};
        puts(QJsonDocument(result).toJson(QJsonDocument::Compact).constData());app.quit();
    });
    if(args.isSet("capture"))QTimer::singleShot(30000,&viewer,[&]{
        QDir dir(args.value("capture"));dir.mkpath(".");
        const bool ready=!viewer.stage->controller.frame().cover.empty();
        viewer.stage->snapshot().save(dir.filePath("live-poster.png"));
        printf("live capture: cover=%d title=%s platform=%s\n",ready,
            QString::fromStdWString(viewer.stage->controller.frame().title).toUtf8().constData(),qPrintable(QGuiApplication::platformName()));
        app.exit(ready?0:5);
    });
    const int result=app.exec();
    if(viewer.restartRequested) {
        preferences.sync();
        // Start through the raster entry point so the new choice is supervised.
        // Session overrides and the internal worker flag intentionally expire.
        if(!QProcess::startDetached(linuxui::rendererExecutable(linuxui::renderers.front()),{})) {
            qCritical("Could not restart viewer");return 1;
        }
    }
    return result;
}
