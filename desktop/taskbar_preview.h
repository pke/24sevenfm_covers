// Keep the viewer's single taskbar button, but preview the window actually being
// rendered. The shell composites the fullscreen surface itself; no readback,
// second renderer or repaint of the covered host window is needed.
#ifndef DV_TASKBAR_PREVIEW_H
#define DV_TASKBAR_PREVIEW_H

#include <windows.h>
#include <commctrl.h>
#include <shobjidl.h>

namespace dv {

class TaskbarPreview {
public:
    using Factory = HRESULT (*)(ITaskbarList3**);
    explicit TaskbarPreview(Factory factory = nullptr) : factory_(factory) {}
    ~TaskbarPreview() { detach(); }
    TaskbarPreview(const TaskbarPreview&) = delete;
    TaskbarPreview& operator=(const TaskbarPreview&) = delete;

    void attach(HWND host);
    void detach();
    void setFullscreen(HWND window);
    bool onMessage(UINT message);
    static UINT buttonCreatedMessage();

private:
    void registerSource();
    void releaseTaskbar();
    static LRESULT CALLBACK sourceProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);
    HWND host_ = nullptr, source_ = nullptr, registered_ = nullptr;
    ITaskbarList3* taskbar_ = nullptr;
    Factory factory_ = nullptr;
    bool ready_ = false;
};

} // namespace dv
#endif
