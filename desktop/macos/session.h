#pragma once
struct Session {
    std::atomic<bool> cancelled{false};
    std::atomic<unsigned long long> revision{0};
    int station = 0;
    bool backdrops = false, logos = false;
    bool ratings = false, comingNext = false;
    std::string providers, fanartKey, ratingCountries;
    int width = 0, height = 0;
    ssc::platform::Mutex mediaMutex;
    ssc::MediaRequest mediaOptions;
    std::unique_ptr<ssc::CoverMonitor> monitor;
    std::unique_ptr<ssc::PresentationPipeline> pipeline;
};
