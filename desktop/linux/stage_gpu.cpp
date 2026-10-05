#include "stage.h"
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QFile>
#include <QJsonDocument>

#if SSC_RENDERER != 0
namespace {
bool software(const QByteArray& name) {
    const auto n=name.toLower();
    return n.contains("llvmpipe") || n.contains("softpipe") || n.contains("swrast")
        || n.contains("lavapipe") || n.contains("software") || n.contains("basic render");
}
void publish(QJsonObject& info) {
    qInfo().noquote()<<"RENDER_BACKEND"<<QJsonDocument(info).toJson(QJsonDocument::Compact);
    if(qEnvironmentVariableIsSet("SSC_REQUIRE_HARDWARE") && info.value("software").toBool())
        qFatal("Software renderer rejected by SSC_REQUIRE_HARDWARE");
}
}
#endif
#if SSC_RENDERER == 1
Stage::~Stage() = default;
void Stage::initializeGL() {
    const bool exactPainter=qEnvironmentVariableIntValue("SSC_GL_EXACT")!=0;
    auto* f=context()->functions();
    auto string=[&](GLenum key){return QByteArray(reinterpret_cast<const char*>(f->glGetString(key)));};
    const auto renderer=string(GL_RENDERER);
    backendInfo={{"api","OpenGL"},{"renderer",QString(renderer)},{"vendor",QString(string(GL_VENDOR))},
        {"version",QString(string(GL_VERSION))},{"software",software(renderer)},
        {"path",exactPainter?"QPainter raster + OpenGL texture composition":"QPainter on QOpenGLWidget"}};
    publish(backendInfo);
}
void Stage::paintGL() {
    QElapsedTimer elapsed;elapsed.start();
    const bool exactPainter=qEnvironmentVariableIntValue("SSC_GL_EXACT")!=0;
    {QPainter p(this);if(exactPainter)p.drawImage(QPointF(0,0),rasterSnapshot());else drawScene(p);}
    recordPaint(elapsed.nsecsElapsed());
}
#elif SSC_RENDERER == 2
Stage::~Stage() {
    if(activeRhi_)activeRhi_->finish();
    releaseResources();
}
void Stage::releaseResources() {
    pipeline_.reset();bindings_.reset();vertices_.reset();sampler_.reset();texture_.reset();activeRhi_=nullptr;
}
void Stage::initialize(QRhiCommandBuffer*) {
    // initialize is also called on resize and when moving between top-level windows.
    // Size changes do not change this widget's RGBA8/sample-count render pass.
    // Retain shaders and pipeline; only recreate the size-dependent texture.
    if(activeRhi_==rhi() && pipeline_) {
        const auto size=renderTarget()->pixelSize();
        if(texture_->pixelSize()!=size) {
            texture_->setPixelSize(size);
            if(!texture_->create() || !bindings_->create())qFatal("RHI resize failed");
        }
        return;
    }
    releaseResources(); activeRhi_=rhi();
    if(rhi()->backend()!=QRhi::Vulkan && rhi()->backend()!=QRhi::OpenGLES2)qFatal("Unexpected RHI backend");
    const auto driver=rhi()->driverInfo();
    const bool gl=rhi()->backend()==QRhi::OpenGLES2;
    const QJsonObject info={{"api",gl?"OpenGL":"Vulkan"},{"renderer",QString(driver.deviceName)},
        {"vendorId",int(driver.vendorId)},{"deviceId",int(driver.deviceId)},
        {"software",software(driver.deviceName)||driver.deviceType==QRhiDriverInfo::CpuDevice},
        {"path","QPainter raster + QRhi texture upload/composition"}};
    if(info!=backendInfo){backendInfo=info;publish(backendInfo);}
    const QSize size=renderTarget()->pixelSize();
    texture_.reset(rhi()->newTexture(QRhiTexture::RGBA8,size));
    sampler_.reset(rhi()->newSampler(QRhiSampler::Nearest,QRhiSampler::Nearest,QRhiSampler::None,
                                    QRhiSampler::ClampToEdge,QRhiSampler::ClampToEdge));
    vertices_.reset(rhi()->newBuffer(QRhiBuffer::Immutable,QRhiBuffer::VertexBuffer,16*sizeof(float)));
    if(!texture_->create()||!sampler_->create()||!vertices_->create())qFatal("RHI resource creation failed");
    bindings_.reset(rhi()->newShaderResourceBindings());
    bindings_->setBindings({QRhiShaderResourceBinding::sampledTexture(0,QRhiShaderResourceBinding::FragmentStage,texture_.get(),sampler_.get())});
    if(!bindings_->create())qFatal("RHI bindings failed");
    auto shader=[](const char* path){QFile f(path);if(!f.open(QIODevice::ReadOnly))qFatal("Missing RHI shader");return QShader::fromSerialized(f.readAll());};
    pipeline_.reset(rhi()->newGraphicsPipeline());
    pipeline_->setShaderStages({{QRhiShaderStage::Vertex,shader(":/shaders/stage.vert.qsb")},
                               {QRhiShaderStage::Fragment,shader(":/shaders/stage.frag.qsb")}});
    QRhiVertexInputLayout layout;
    layout.setBindings({{4*sizeof(float)}});
    layout.setAttributes({{0,0,QRhiVertexInputAttribute::Float2,0},{0,1,QRhiVertexInputAttribute::Float2,2*sizeof(float)}});
    pipeline_->setVertexInputLayout(layout);
    pipeline_->setTopology(QRhiGraphicsPipeline::TriangleStrip);
    pipeline_->setShaderResourceBindings(bindings_.get());
    pipeline_->setRenderPassDescriptor(renderTarget()->renderPassDescriptor());
    pipeline_->setSampleCount(renderTarget()->sampleCount());
    if(!pipeline_->create())qFatal("RHI pipeline failed");
}
void Stage::render(QRhiCommandBuffer* cb) {
    QElapsedTimer elapsed;elapsed.start();
    auto* updates=rhi()->nextResourceUpdateBatch();
    // UV origin is the top of the QImage. Vulkan's framebuffer Y is down.
    const float top=rhi()->isYUpInNDC()?1.f:-1.f;
    const float quad[]={-1,top,0,0, 1,top,1,0, -1,-top,0,1, 1,-top,1,1};
    updates->uploadStaticBuffer(vertices_.get(),quad);
    updates->uploadTexture(texture_.get(),rasterSnapshot());
    cb->beginPass(renderTarget(),Qt::black,{1,0},updates);
    cb->setGraphicsPipeline(pipeline_.get());
    const auto size=renderTarget()->pixelSize();
    cb->setViewport({0,0,float(size.width()),float(size.height())});
    cb->setShaderResources();
    const QRhiCommandBuffer::VertexInput binding(vertices_.get(),0);
    cb->setVertexInput(0,1,&binding);cb->draw(4);cb->endPass();
    recordPaint(elapsed.nsecsElapsed());
}
#endif
