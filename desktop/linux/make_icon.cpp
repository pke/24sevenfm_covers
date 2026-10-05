#include <QCoreApplication>
#include <QImageReader>
int main(int argc,char** argv) {
    QCoreApplication app(argc,argv);if(argc!=3)return 1;
    QImageReader reader(QString::fromLocal8Bit(argv[1]));QImage best;
    do {auto image=reader.read();if(image.width()>best.width())best=image;} while(reader.jumpToNextImage());
    return !best.isNull() && best.scaled(64,64,Qt::KeepAspectRatio,Qt::SmoothTransformation).save(QString::fromLocal8Bit(argv[2]),"PNG")?0:2;
}
