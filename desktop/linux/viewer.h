#pragma once
#include "stage.h"
#include <QMainWindow>
#include <QSettings>
#include <QPointer>
#include <QDialog>
#include <future>

class Viewer : public QMainWindow {
public:
    explicit Viewer(bool network = true);
    ~Viewer();
    Stage* stage;
    QSettings preferences;
    QVariant preference(const char* storageKey) const;
    void applyPreferences();
    void showSettings();
    void toggleFullscreen();
    ssc::MediaRequest mediaOptions() const;
    int stationIndex() const;
    bool reducedMotion() const;
    void fadeStage(bool entering, std::function<void()> finished = {});
    bool restartRequested = false;
protected:
    void resizeEvent(QResizeEvent*) override;
    void closeEvent(QCloseEvent*) override;
private:
    struct Session {
        int station = 0;
        std::unique_ptr<ssc::CoverMonitor> monitor;
        std::unique_ptr<ssc::PresentationPipeline> pipeline;
        std::string identity;
    };
    bool network_, closing_ = false, systemReducedMotion_ = false;
    std::shared_ptr<Session> session_;
    std::vector<std::future<void>> retiring_;
    QPointer<QDialog> dialog_;
    QTimer viewportTimer_;
    void startStation();
    void retireSession();
};
