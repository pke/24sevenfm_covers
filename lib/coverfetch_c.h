// coverfetch_c.h - plain C ABI wrapper around ssc::CoverMonitor.
//
// This is the easiest surface to bind from other languages / platforms:
//   * Android: call from JNI, or via a small JNI shim.
//   * iOS:     import into Swift/Objective-C through a bridging header.
//
// The callback fires on the library's background thread, so marshal back to
// your UI thread before touching UI.
#ifndef SSC_COVERFETCH_C_H
#define SSC_COVERFETCH_C_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ssc_monitor ssc_monitor;

// Invoked whenever the cover changes. `cover_url` is only valid for the
// duration of the call - copy it if you need to keep it. `user_data` is the
// pointer passed to ssc_monitor_create.
typedef void (*ssc_cover_changed_fn)(const char* cover_url, void* user_data);

// Creates a monitor. `cover_size` matches Config::coverSize (500 = big cover,
// 0 = original). Returns NULL on allocation failure.
ssc_monitor* ssc_monitor_create(ssc_cover_changed_fn callback,
                                void* user_data,
                                int cover_size);

// Starts / stops the background polling thread.
void ssc_monitor_start(ssc_monitor* monitor);
void ssc_monitor_stop(ssc_monitor* monitor);

// Stops (if needed) and frees the monitor.
void ssc_monitor_destroy(ssc_monitor* monitor);

#ifdef __cplusplus
} // extern "C"
#endif

#endif // SSC_COVERFETCH_C_H
