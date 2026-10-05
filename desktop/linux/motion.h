#pragma once
#include <QWidget>
#include <QGraphicsOpacityEffect>
#include <QPropertyAnimation>
#include <functional>

// Content opacity works on Wayland too; QWidget::windowOpacity is X11-only.
inline void fadeContent(QWidget* widget, bool entering, int duration, std::function<void()> finished = {}) {
    const auto* previous=qobject_cast<QGraphicsOpacityEffect*>(widget->graphicsEffect());
    const qreal start=previous?previous->opacity():(entering?0.:1.);
    // An interrupted entrance must not later clear the exit effect and prevent
    // its completion callback (the callback is what actually dismisses a dialog).
    for(auto* running:widget->findChildren<QPropertyAnimation*>("ssc-content-fade",Qt::FindDirectChildrenOnly)) {
        running->stop();running->deleteLater();
    }
    auto* effect=new QGraphicsOpacityEffect(widget);
    effect->setOpacity(start);widget->setGraphicsEffect(effect);
    auto* animation=new QPropertyAnimation(effect,"opacity",widget);
    animation->setObjectName("ssc-content-fade");
    animation->setDuration(duration);animation->setEndValue(entering?1.:0.);
    QObject::connect(animation,&QPropertyAnimation::finished,widget,[widget,effect,entering,finished]{
        if(widget->graphicsEffect()!=effect)return;
        if(entering)widget->setGraphicsEffect(nullptr);
        if(finished)finished();
    });
    animation->start(QAbstractAnimation::DeleteWhenStopped);
}
