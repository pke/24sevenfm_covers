#pragma once
#include "../../shared/presentation_controller.h"
#include "../../shared/presentation_pipeline.h"
#include <QWidget>
#include <QJsonObject>
#include <QPainter>
#if SSC_RENDERER == 1
#include <QOpenGLWidget>
using StageWidget = QOpenGLWidget;
#elif SSC_RENDERER == 2
#include <QRhiWidget>
#include <rhi/qrhi.h>
using StageWidget = QRhiWidget;
#else
using StageWidget = QWidget;
#endif
#include <QCache>
#include <QImage>
#include <QElapsedTimer>
#include <QTimer>
#include <memory>

// No acquisition or animation policy here: native metrics/resources and drawing.
class Stage : public StageWidget {
public:
    explicit Stage(QWidget* parent = nullptr);
    ~Stage() override;
    struct Statistics {
        quint64 ticks=0, measures=0, paints=0, animated=0;
        std::vector<double> renderMs, intervalMs;
    } stats;
    bool profiling=false;
    QJsonObject backendInfo;
    void resetStatistics();
    QImage rasterSnapshot();
    ssc::PresentationController controller;
    ssc::PresentationSettings settings;
    std::function<void()> openSettings, toggleFullscreen;
    void present(const ssc::PreparedPresentation& frame, int station, bool queued);
    void refresh();
    void sampleAt(ssc::PresentationTime time); // same production measurement/draw path for deterministic QA
    QImage snapshot();
    static QImage decode(const std::string& bytes);
    static QImage decodeLogo(const std::string& bytes);
protected:
    #if SSC_RENDERER == 1
    void initializeGL() override;
    void paintGL() override;
#elif SSC_RENDERER == 2
    void initialize(QRhiCommandBuffer*) override;
    void render(QRhiCommandBuffer*) override;
    void releaseResources() override;
#else
    void paintEvent(QPaintEvent*) override;
#endif
    void mouseMoveEvent(QMouseEvent*) override;
    void leaveEvent(QEvent*) override;
    void mousePressEvent(QMouseEvent*) override;
    void mouseDoubleClickEvent(QMouseEvent*) override;
private:
    void drawScene(QPainter&);
    void recordPaint(qint64 elapsed);
    QElapsedTimer paintClock_;
    qint64 lastPaintNs_=0;
    std::unique_ptr<QWidget> rasterSurface_;
#if SSC_RENDERER == 2
    QRhi* activeRhi_=nullptr;
    std::unique_ptr<QRhiTexture> texture_;
    std::unique_ptr<QRhiSampler> sampler_;
    std::unique_ptr<QRhiShaderResourceBindings> bindings_;
    std::unique_ptr<QRhiGraphicsPipeline> pipeline_;
    std::unique_ptr<QRhiBuffer> vertices_;
#endif
    ssc::PresentationTime now_ = 0;
    QElapsedTimer clock_;
    QTimer timer_;
    bool dirty_ = true;
    QSize lastSize_;
    QCache<QByteArray, QImage> images_{128 * 1024}; // KiB, includes outgoing resources
    const QImage& image(const std::string& bytes, bool blur = false, bool logo = false);
    ssc::TitleLogoSize logoSize();
    void measure();
};
