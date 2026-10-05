#pragma once
#include <QCoreApplication>
#include <QFileInfo>
#include <QString>
#include <QVariant>
#include <array>

namespace linuxui {
struct RendererChoice { const char* id; const char* label; const char* executable; };
inline constexpr std::array<RendererChoice,5> renderers{{
    {"raster","QPainter / Raster (default)","24sevenfm_covers"},
    {"opengl-direct","OpenGL — accelerated drawing","24sevenfm_covers_opengl"},
    {"opengl","OpenGL — exact appearance","24sevenfm_covers_opengl"},
    {"rhi-opengl","RHI / OpenGL — exact appearance","24sevenfm_covers_rhi"},
    {"rhi-vulkan","RHI / Vulkan — exact appearance","24sevenfm_covers_rhi"}
}};
inline const RendererChoice* rendererChoice(const QString& id) {
    for(const auto& choice:renderers)if(id==QLatin1String(choice.id))return &choice;
    return nullptr;
}
inline QString rendererExecutable(const RendererChoice& choice) {
    return QCoreApplication::applicationDirPath()+"/"+choice.executable;
}
inline QString activeRenderer() {
    const auto value=QCoreApplication::instance()->property("activeRenderer").toString();
    return value.isEmpty()?QStringLiteral("raster"):value;
}
}
