#pragma once
#include <QFont>
#include <QFontDatabase>
#include <QGuiApplication>
#include <QScreen>
#include <QFile>

namespace linuxui {
inline QString presentationFontFamily() {
    static const QString family=[] {
        // WSL can use the user's existing Windows installation. Do not copy or
        // redistribute Windows fonts with the Linux package.
        if(!QFontDatabase::families().contains("Segoe UI")) {
            QFile kernel("/proc/sys/kernel/osrelease");
            if(kernel.open(QIODevice::ReadOnly) && kernel.readAll().toLower().contains("microsoft")) {
                for(const char* file:{"segoeui.ttf","seguisb.ttf","segoeuib.ttf"})
                    QFontDatabase::addApplicationFont(QString("/mnt/c/Windows/Fonts/")+file);
            }
        }
        for(const QString& name:{QString("Segoe UI"),QString("Noto Sans"),QString("DejaVu Sans")})
            if(QFontDatabase::families().contains(name))return name;
        return QFontDatabase::systemFont(QFontDatabase::GeneralFont).family();
    }();
    return family;
}
inline QFont presentationFont(float pixels,QFont::Weight weight=QFont::Normal) {
    QFont font(presentationFontFamily());font.setWeight(weight);
    // setPixelSize(int) rounded away the common controller's fractional sizes.
    const qreal dpi=QGuiApplication::primaryScreen()->logicalDotsPerInchY();
    font.setPointSizeF(qMax(.1f,pixels)*72./dpi);
    return font;
}
}
