#include "stage.h"
#include "typography.h"
#include "../../shared/image_limits.h"
#include "../../shared/image_alpha_bounds.h"
#include "../../lib/image_probe.h"
#include <QPainter>
#include <QPainterPath>
#include <QImageReader>
#include <QBuffer>
#include <QMouseEvent>
#include <QFontDatabase>
#include <QCryptographicHash>

namespace {
class RasterSurface final : public QWidget {
public:
    explicit RasterSurface(std::function<void(QPainter&)> draw) : draw_(std::move(draw)) {
        setAttribute(Qt::WA_OpaquePaintEvent);
    }
protected:
    void paintEvent(QPaintEvent*) override { QPainter painter(this); draw_(painter); }
private:
    std::function<void(QPainter&)> draw_;
};
QString text(const std::wstring& value) { return QString::fromStdWString(value); }
std::wstring wide(const std::string& value) { return QString::fromStdString(value).toStdWString(); }
QRectF rect(ssc::PresentationRect r) { return {r.x, r.y, r.width, r.height}; }
QFont nativeFont(float size, QFont::Weight weight = QFont::Normal) {
    return linuxui::presentationFont(size,weight);
}
void fitImage(QPainter& p, const QImage& image, QRectF target, bool fill) {
    if (image.isNull() || target.isEmpty()) return;
    const auto size = QSizeF(image.size()).scaled(target.size(), fill ? Qt::KeepAspectRatioByExpanding : Qt::KeepAspectRatio);
    p.drawImage(QRectF(target.center() - QPointF(size.width()/2, size.height()/2), size), image);
}
void line(QPainter& p, QString value, QRectF r, float size, QFont::Weight weight = QFont::Normal, bool center = true) {
    p.setFont(nativeFont(size, weight));
    p.drawText(r, (center ? Qt::AlignHCenter : Qt::AlignLeft) | Qt::AlignVCenter,
        QFontMetricsF(p.font()).elidedText(value, Qt::ElideRight, r.width()));
}
float posterLineHeight(const QString& value, float width, float size, QFont::Weight weight) {
    if(value.isEmpty())return 0;
    const QFontMetricsF metrics(nativeFont(size,weight));
    return qMin(metrics.height()*3,metrics.boundingRect(QRectF(0,0,width,10000),Qt::TextWordWrap,value).height());
}
std::string png(const QImage& image) {
    QByteArray bytes; QBuffer buffer(&bytes); buffer.open(QIODevice::WriteOnly); image.save(&buffer, "PNG");
    return {bytes.constData(), size_t(bytes.size())};
}
}
Stage::Stage(QWidget* parent) : StageWidget(parent), controller([this] { return now_; }) {
    setMinimumSize(280, 280); setMouseTracking(true); setAttribute(Qt::WA_OpaquePaintEvent);
    clock_.start(); paintClock_.start(); timer_.setInterval(16);
#if SSC_RENDERER == 2
    const auto requested=qEnvironmentVariable("SSC_RHI_BACKEND","vulkan");
    if(requested!="vulkan" && requested!="opengl") qFatal("SSC_RHI_BACKEND must be vulkan or opengl");
    setApi(requested=="opengl"?Api::OpenGL:Api::Vulkan);
    connect(this,&QRhiWidget::renderFailed,this,[]{qFatal("RHI rendering failed; no silent fallback");});
#endif
    connect(&timer_, &QTimer::timeout, this, [this] { sampleAt(clock_.elapsed()); });
    if (!qEnvironmentVariableIsSet("SSC_TEST_MODE")) timer_.start();
}
QImage Stage::decode(const std::string& bytes) {
    if (bytes.empty() || bytes.size() > 16u*1024u*1024u) return {};
    QByteArray data = QByteArray::fromRawData(bytes.data(), int(bytes.size()));
    QBuffer buffer(&data); buffer.open(QIODevice::ReadOnly);
    QImageReader reader(&buffer); const auto size = reader.size();
    if (!size.isValid() || !ssc::coverDimsOk(size.width(), size.height())) return {};
    return reader.read();
}
QImage Stage::decodeLogo(const std::string& bytes) {
    auto decoded=decode(bytes);if(decoded.isNull())return {};
    if(qMax(decoded.width(),decoded.height())>int(ssc::kLogoScanMaximum))
        decoded=decoded.scaled(ssc::kLogoScanMaximum,ssc::kLogoScanMaximum,Qt::KeepAspectRatio,Qt::SmoothTransformation);
    decoded=decoded.convertToFormat(QImage::Format_RGBA8888_Premultiplied);
    const auto bounds=ssc::visibleAlphaBounds(decoded.constBits(),decoded.width(),decoded.height(),decoded.bytesPerLine());
    if(bounds.right<=bounds.left || bounds.bottom<=bounds.top)return {};
    auto cropped=decoded.copy(bounds.left,bounds.top,bounds.right-bounds.left,bounds.bottom-bounds.top);
    cropped.setText("ssc.logoAnchor",QString::number(ssc::titleLogoHorizontalAnchor(
        decoded.constBits(),decoded.width(),decoded.height(),decoded.bytesPerLine(),bounds),'g',9));
    return cropped;
}
const QImage& Stage::image(const std::string& bytes, bool blur, bool logo) {
    const QByteArray key = QCryptographicHash::hash(QByteArray::fromRawData(bytes.data(), int(bytes.size())), QCryptographicHash::Sha256) + (blur ? "blur" : logo ? "logo" : "image");
    if (auto* cached = images_.object(key)) return *cached;
    auto decoded = logo?decodeLogo(bytes):decode(bytes);
    if (blur && !decoded.isNull()) {
        // Low-pass filtering is native resource preparation, independent of frame geometry.
        decoded = decoded.scaled(24, 24, Qt::IgnoreAspectRatio, Qt::SmoothTransformation)
            .scaled(512, 512, Qt::IgnoreAspectRatio, Qt::SmoothTransformation);
    }
    const int cost = qMax(1, int(decoded.sizeInBytes()/1024));
    auto* value = new QImage(std::move(decoded)); images_.insert(key, value, cost); return *value;
}
ssc::TitleLogoSize Stage::logoSize() {
    const auto& pixels=image(controller.frame().logo,false,true);
    const auto type=ssc::posterTypography(width(),height());
    return ssc::titleLogoSize(pixels.width(),pixels.height(),width(),height(),type.title,1);
}
void Stage::present(const ssc::PreparedPresentation& frame, int station, bool queued) {
    dirty_ = true;
    const auto metadata = ssc::presentationText(frame.track, frame.media, station);
    if (queued) {
        const auto id = ssc::queuedTrackIdentity(frame.track);
        controller.comingNext.setQueue(id, wide(metadata.album), wide(metadata.artist));
        controller.comingNext.resolve(id, wide(metadata.album), wide(metadata.artist), metadata.authoritative);
        controller.comingNext.setCover(id, frame.cover);
        return;
    }
    const auto token = controller.trackChanged(ssc::trackIdentity(frame.track, station));
    controller.resolverCompleted(token, wide(metadata.album), wide(metadata.artist), wide(metadata.album), wide(metadata.track), metadata.authoritative);
    auto ref = [](const std::string& bytes) -> ssc::ImageReference {
        return bytes.empty() ? nullptr : std::make_shared<const std::string>(bytes);
    };
    controller.assetReady(token, ref(frame.cover)); controller.assetReady(token, ref(frame.backdrop), true);
    controller.backdropChanged(!frame.backdrop.empty());
    controller.setLogo(image(frame.logo,false,true).isNull()?std::string():frame.logo, wide(metadata.album));
    // Compose native rating pixels, then let the shared controller retain/fade them.
    QImage strip(320, 64, QImage::Format_ARGB32_Premultiplied); strip.fill(Qt::transparent);
    QPainter p(&strip); int x = 0;
    for (const auto& rating : frame.ratings) {
        auto badge = decode(rating.bytes);
        if (badge.isNull()) {
            badge=QImage(72,56,QImage::Format_ARGB32_Premultiplied);badge.fill(QColor(30,33,40));
            QPainter fallback(&badge);fallback.setPen(Qt::white);
            line(fallback,QString::fromStdString(rating.country+" "+rating.certification.rating),badge.rect(),13,QFont::DemiBold);
        }
        auto size = badge.size().scaled(72, 56, Qt::KeepAspectRatio);
        p.drawImage(QRect(x, 4, size.width(), size.height()), badge); x += size.width() + 8;
    }
    p.end(); controller.setRatingContent(x ? ref(png(strip.copy(0, 0, qMin(x,320),64))) : nullptr);
}
void Stage::refresh() { dirty_=true; controller.settingsChanged(settings); sampleAt(clock_.elapsed()); }
void Stage::measure() {
    if(profiling)++stats.measures;
    const auto& f = controller.frame(); const auto t = ssc::posterTypography(width(), height());
    float w = 0;
    const std::pair<QString,float> rows[] = {{text(f.title),t.title},{text(f.artist),t.artist},{text(f.track),t.track}};
    for (const auto& row : rows) {
        if (row.first.isEmpty()) continue;
        const auto weight=row.second==t.title?QFont::DemiBold:row.second==t.track?QFont::Medium:QFont::Normal;
        QFontMetricsF metric(nativeFont(row.second,weight));
        const float rowWidth=metric.boundingRect(QRectF(0,0,width()*.86f-2*t.padX,10000),Qt::TextWordWrap,row.first).width();
        w = qMax(w,rowWidth*(row.second==t.title?1-f.logoLayout:1));
    }
    const auto logo=logoSize();
    w=qMax(w,f.countdown.fontSize*4.5f*f.countdown.opacity);
    const float targetWidth=ssc::posterInfoWidth(width(),w,t.padX,1,logo.width*f.logoLayout);
    const float textWidth=qMax(1.f,targetWidth-2*t.padX);
    const float albumHeight=posterLineHeight(text(f.title),textWidth,t.title,QFont::DemiBold);
    const float artistHeight=posterLineHeight(text(f.artist),textWidth,t.artist,QFont::Normal);
    const float trackHeight=posterLineHeight(text(f.track),textWidth,t.track,QFont::Medium);
    const float h=2*t.padY+albumHeight+(logo.rowHeight-albumHeight)*f.logoLayout
        +artistHeight+trackHeight+(artistHeight>0?t.lineGap:0)+(trackHeight>0?t.title*.12f:0);
    controller.measured(ssc::VisualChannel::InfoWidth,targetWidth);
    controller.measured(ssc::VisualChannel::InfoHeight, h);
    const auto n = ssc::nextTypography(width());
    // Always untrimmed final text metrics. Never feed cover opacity into layout.
    const auto album = QFontMetricsF(nativeFont(n.album, QFont::DemiBold)), artist = QFontMetricsF(nativeFont(n.artist));
    const float natural = qMax(QFontMetricsF(nativeFont(n.label,QFont::Bold)).horizontalAdvance("COMING NEXT"),
        qMax(album.horizontalAdvance(text(f.next.album)), artist.horizontalAdvance(text(f.next.artist))));
    controller.measuredNext(natural, std::ceil(QFontMetricsF(nativeFont(n.label,QFont::Bold)).height())+std::ceil(album.height())+std::ceil(artist.height())+5.6f);
}
void Stage::sampleAt(ssc::PresentationTime time) {
    if(profiling)++stats.ticks;
    const bool wasAnimating=controller.frame().animating;
    const int seconds=controller.frame().countdown.seconds;
    const float controls=controller.frame().controlsOpacity;
    now_ = time; controller.viewportChanged(width(), height(), 1, layoutDirection()==Qt::RightToLeft);
    const auto& frame=controller.advance();
    if(profiling && frame.animating)++stats.animated;
    // Native font layout and logo resource lookup are unnecessary while the
    // retained frame is idle. Keep advancing time for countdown/hover events.
    if(dirty_ || wasAnimating || frame.animating || lastSize_!=size())measure();
    if(dirty_ || wasAnimating || frame.animating || (frame.countdown.opacity>0 && seconds!=frame.countdown.seconds)
        || controls!=frame.controlsOpacity || lastSize_!=size())update();
    dirty_=false;lastSize_=size();
}
QImage Stage::snapshot() {
#if SSC_RENDERER == 1 || SSC_RENDERER == 2
    return grabFramebuffer();
#else
    return grab().toImage();
#endif
}
QImage Stage::rasterSnapshot() {
    // A QWidget painter resolves native text properties differently from an
    // image/pixmap painter on some platforms (notably WSLg). Retain the same
    // paint device semantics as the baseline, without a second layout engine.
    if(!rasterSurface_)rasterSurface_=std::make_unique<RasterSurface>([this](QPainter& p){drawScene(p);});
    rasterSurface_->setScreen(screen());
    rasterSurface_->setFont(font());
    rasterSurface_->setLayoutDirection(layoutDirection());
    rasterSurface_->resize(size());
    return rasterSurface_->grab().toImage().convertToFormat(QImage::Format_RGBA8888_Premultiplied);
}
void Stage::resetStatistics() { stats={}; lastPaintNs_=0; }
void Stage::recordPaint(qint64 elapsed) {
    if(!profiling)return;
    ++stats.paints;stats.renderMs.push_back(elapsed/1e6);
    const auto now=paintClock_.nsecsElapsed();
    if(lastPaintNs_)stats.intervalMs.push_back((now-lastPaintNs_)/1e6);
    lastPaintNs_=now;
}
#if SSC_RENDERER == 0
Stage::~Stage() = default;
void Stage::paintEvent(QPaintEvent*) {
    QElapsedTimer elapsed; elapsed.start();
    {QPainter p(this);drawScene(p);}
    recordPaint(elapsed.nsecsElapsed());
}
#endif
void Stage::drawScene(QPainter& p) {
    const auto& f = controller.frame();
    // An odd logical size at fractional DPR can end halfway through a device
    // pixel. Clear the entire backing-store edge before antialiasing content;
    // WA_OpaquePaintEvent otherwise leaves that pixel partially uninitialized.
    // Qt's widget/device clip keeps the expanded fill inside the paint target.
    p.setRenderHint(QPainter::Antialiasing,false);
    p.fillRect(rect().adjusted(0,0,1,1), QColor(16,18,24));
    p.setRenderHints(QPainter::Antialiasing | QPainter::SmoothPixmapTransform | QPainter::TextAntialiasing);
    auto layers = [&](const std::vector<ssc::ImageLayer>& list, QRectF target, float opacity, bool fill, bool blur=false, float radius=0) {
        for (const auto& layer : list) {
            if (!layer.image || layer.opacity*opacity <= 0) continue;
            p.save(); p.setOpacity(layer.opacity*opacity);
            p.translate(target.center()); p.scale(layer.scaleX,layer.scaleY); p.translate(-target.center());
            QPainterPath clip; clip.addRoundedRect(target, radius, radius); p.setClipPath(clip,Qt::IntersectClip);
            fitImage(p,image(*layer.image,blur),target,fill); p.restore();
        }
    };
    layers(f.blurredCover,rect(),f.poster,true,true);
    layers(f.backdrop,rect(),1,true);
    layers(f.cover,::rect(f.coverRect),f.coverOpacity,true,false,f.coverRect.width*f.radius/1000.f*f.poster);
    if (f.poster > 0) {
        p.save(); p.setOpacity(f.poster*f.infoOpacity); auto box = ::rect(f.infoRect);
        p.setPen(Qt::NoPen); p.setBrush(QColor(5,8,12,205)); p.drawRoundedRect(box,14,14); p.setPen(Qt::white);
        const auto t=ssc::posterTypography(width(),height());const auto logo=logoSize();
        const float logoAlpha=f.logoAlbum==f.album?f.logoOpacity:0;
        const float textWidth=qMax(1.f,float(box.width())-2*t.padX);
        const float titleHeight=posterLineHeight(text(f.title),textWidth,t.title,QFont::DemiBold);
        const float titleRow=titleHeight+(logo.rowHeight-titleHeight)*f.logoLayout;
        float y=box.y()+t.padY;
        const auto drawRow=[&](const QString& value,float size,float h,QFont::Weight weight,float alpha){
            p.save();const QRectF area(box.x()+t.padX,y,box.width()-2*t.padX,h);
            p.setOpacity(f.poster*f.infoOpacity*alpha);
            p.setClipRect(area,Qt::IntersectClip);p.setFont(nativeFont(size,weight));
            p.drawText(area,Qt::AlignHCenter|Qt::AlignTop|Qt::TextWordWrap,value);p.restore();
        };
        drawRow(text(f.title),t.title,titleRow,QFont::DemiBold,1-logoAlpha);y+=titleRow;
        if(!f.artist.empty()) {
            y+=t.lineGap;const float h=posterLineHeight(text(f.artist),textWidth,t.artist,QFont::Normal);
            drawRow(text(f.artist),t.artist,h,QFont::Normal,.8f);y+=h;
        }
        if(!f.track.empty()) {
            y+=t.title*.12f;const float h=posterLineHeight(text(f.track),textWidth,t.track,QFont::Medium);
            drawRow(text(f.track),t.track,h,QFont::Medium,1);
        }
        p.restore();
        if (logoAlpha>0) {
            const auto& logoImage=image(f.logo,false,true);
            const auto r=ssc::titleLogoRect(box.center().x(),box.y(),logo,logoImage.text("ssc.logoAnchor").toFloat());
            p.save();p.setOpacity(f.poster*f.infoOpacity*logoAlpha);
            fitImage(p,image(f.logo,false,true),{r.left,r.top,r.right-r.left,r.bottom-r.top},false);p.restore();
        }
    }
    if (f.countdown.opacity > 0) {
        p.save(); p.setOpacity(f.countdown.opacity); p.setPen(Qt::white);
        const auto r=::rect(f.countdownRect);p.setClipRect(r);
        const auto digits=nativeFont(f.countdown.fontSize,QFont::Medium);p.setFont(digits);
        const QFontMetricsF metrics(digits);
        const qreal cw=metrics.horizontalAdvance("0000000000")/10.;
        const qreal colonWidth=metrics.horizontalAdvance("0:0")-2*cw;
        qreal total=0;for(const auto& column:f.countdown.columns)total+=column.colon?colonWidth:cw;
        qreal x=r.center().x()-total/2;
        for (const auto& column : f.countdown.columns) {
            const qreal cellWidth=column.colon?colonWidth:cw;
            for (const auto& d : column.layers) {
                p.setOpacity(f.countdown.opacity*d.opacity);
                p.drawText(QRectF(x,r.y()+d.offset*r.height(),cellWidth,r.height()),Qt::AlignCenter,QString(QChar(d.digit)));
            }
            x+=cellWidth;
        }
        p.restore();
    }
    if (f.next.opacity > 0) {
        p.save(); p.setOpacity(f.next.opacity); auto box=::rect(f.nextRect); const auto n=ssc::nextTypography(width());
        p.setPen(Qt::NoPen); p.setBrush(QColor(5,8,12,225)); p.drawRoundedRect(box,10,10);
        const qreal column=(n.cover+n.gap)*f.nextCoverLayout;
        if (f.next.cover) {
            p.setOpacity(f.next.opacity*f.next.coverOpacity);
            fitImage(p,image(*f.next.cover),{box.x()+n.padX,box.center().y()-n.cover*f.nextCoverLayout/2,n.cover*f.nextCoverLayout,n.cover*f.nextCoverLayout},true);
        }
        p.setOpacity(f.next.opacity); p.setPen(Qt::white); float y=box.y()+n.padY;
        for (const auto& row : std::vector<std::pair<QString,float>>{{"COMING NEXT",n.label},{text(f.next.album),n.album},{text(f.next.artist),n.artist}}) {
            const auto weight=row.second==n.label?QFont::Bold:row.second==n.album?QFont::DemiBold:QFont::Normal;
            const float h=std::ceil(QFontMetricsF(nativeFont(row.second,weight)).height());
            line(p,row.first,{box.x()+n.padX+column,y,box.width()-n.padX*2-column,h},row.second,weight,false); y+=h+(row.second==n.label?3:1.3f);
        }
        p.restore();
    }
    layers(f.ratings,{double(width()-190),double(height()-78),176,64},f.ratingOpacity,false);
    p.save(); p.setOpacity(f.controlsOpacity); p.setPen(Qt::white); p.setBrush(QColor(15,18,24,220));
    p.drawRoundedRect(QRectF(16,height()-50,106,34),8,8); line(p,"Settings",{16.,double(height()-50),106,34},14,QFont::DemiBold); p.restore();
}
void Stage::mouseMoveEvent(QMouseEvent*) { controller.pointerChanged(true,window()->isFullScreen(),true); }
void Stage::leaveEvent(QEvent*) { controller.pointerChanged(false,window()->isFullScreen(),false); }
void Stage::mousePressEvent(QMouseEvent* e) {
    controller.pointerChanged(true,window()->isFullScreen(),true);
    if (e->button()==Qt::RightButton || QRect(16,height()-50,106,34).contains(e->position().toPoint())) if(openSettings) openSettings();
}
void Stage::mouseDoubleClickEvent(QMouseEvent* e) { if(e->button()==Qt::LeftButton && toggleFullscreen) toggleFullscreen(); }
