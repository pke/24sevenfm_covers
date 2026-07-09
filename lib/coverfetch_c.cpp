#include "coverfetch_c.h"
#include "coverfetch.h"

struct ssc_monitor {
    ssc::CoverMonitor impl;
    ssc_monitor(ssc::CoverChangedCallback cb, ssc::Config cfg)
        : impl(std::move(cb), std::move(cfg)) {}
};

extern "C" {

ssc_monitor* ssc_monitor_create(ssc_cover_changed_fn callback,
                                void* user_data,
                                int cover_size) {
    if (!callback)
        return nullptr;

    ssc::Config cfg;
    cfg.coverSize = cover_size;

    auto cb = [callback, user_data](const std::string& url, const ssc::TrackInfo&) {
        callback(url.c_str(), user_data);
    };

    try {
        return new ssc_monitor(std::move(cb), std::move(cfg));
    } catch (...) {
        return nullptr;
    }
}

void ssc_monitor_start(ssc_monitor* monitor) {
    if (monitor) monitor->impl.start();
}

void ssc_monitor_stop(ssc_monitor* monitor) {
    if (monitor) monitor->impl.stop();
}

void ssc_monitor_destroy(ssc_monitor* monitor) {
    delete monitor; // destructor stops the thread
}

} // extern "C"
