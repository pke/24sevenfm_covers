#include "taskbar_preview.h"
#include <string>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "uuid.lib")
#pragma comment(lib, "comctl32.lib")

namespace dv {

UINT TaskbarPreview::buttonCreatedMessage() {
    static const UINT message = RegisterWindowMessageW(L"TaskbarButtonCreated");
    return message;
}

void TaskbarPreview::attach(HWND host) {
    detach();
    host_ = host;
    buttonCreatedMessage();
}

void TaskbarPreview::releaseTaskbar() {
    if (taskbar_) { taskbar_->Release(); taskbar_ = nullptr; }
}

void TaskbarPreview::detach() {
    setFullscreen(nullptr);
    releaseTaskbar();
    host_ = nullptr;
    ready_ = false;
}

bool TaskbarPreview::onMessage(UINT message) {
    if (!message || message != buttonCreatedMessage()) return false;
    // Also delivered when Explorer recreates the taskbar. Its old registration
    // and COM object cannot be assumed to survive that restart.
    registered_ = nullptr;
    releaseTaskbar();
    ready_ = true;
    registerSource();
    return true;
}

void TaskbarPreview::setFullscreen(HWND window) {
    if (window == source_) return;
    if (registered_ && taskbar_) taskbar_->UnregisterTab(registered_);
    registered_ = nullptr;
    if (source_) RemoveWindowSubclass(source_, sourceProc, reinterpret_cast<UINT_PTR>(this));
    source_ = nullptr;
    if (!window || !host_ || !IsWindow(window)) return;

    if (!SetWindowSubclass(window, sourceProc, reinterpret_cast<UINT_PTR>(this),
            reinterpret_cast<DWORD_PTR>(this))) return;
    source_ = window;
    // The shared fullscreen popup has no caption/icon of its own. Borrow the
    // viewer's identity; WM_SETICON does not transfer icon ownership.
    std::wstring title(static_cast<size_t>(GetWindowTextLengthW(host_)) + 1, L'\0');
    GetWindowTextW(host_, &title[0], static_cast<int>(title.size()));
    SetWindowTextW(window, title.c_str());
    for (WPARAM kind : { WPARAM(ICON_SMALL), WPARAM(ICON_BIG) }) {
        HICON icon = reinterpret_cast<HICON>(SendMessageW(host_, WM_GETICON, kind, 0));
        if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(host_,
            kind == ICON_SMALL ? GCLP_HICONSM : GCLP_HICON));
        SendMessageW(window, WM_SETICON, kind, reinterpret_cast<LPARAM>(icon));
    }
    registerSource();
}

void TaskbarPreview::registerSource() {
    if (!ready_ || !host_ || !source_ || registered_ == source_) return;
    if (!taskbar_) {
        const HRESULT created = factory_ ? factory_(&taskbar_)
            : CoCreateInstance(CLSID_TaskbarList, nullptr, CLSCTX_INPROC_SERVER,
                IID_PPV_ARGS(&taskbar_));
        if (FAILED(created) || !taskbar_ || FAILED(taskbar_->HrInit())) {
            releaseTaskbar();
            return; // retain the normal host preview if the shell is unavailable
        }
    }
    if (FAILED(taskbar_->RegisterTab(source_, host_))) return;
    if (FAILED(taskbar_->SetTabOrder(source_, nullptr))) {
        taskbar_->UnregisterTab(source_); // incomplete registration must not hide the host
        return;
    }
    registered_ = source_;
    taskbar_->SetTabActive(source_, host_, 0);
}

LRESULT CALLBACK TaskbarPreview::sourceProc(HWND window, UINT message, WPARAM wp,
        LPARAM lp, UINT_PTR, DWORD_PTR data) {
    auto* self = reinterpret_cast<TaskbarPreview*>(data);
    if (message == WM_DESTROY) {
        // Esc, double-click, menu and WM_CLOSE all destroy this popup. Unregister
        // while its HWND is still valid, before the shared onExit callback runs.
        self->setFullscreen(nullptr);
    } else if (message == WM_ACTIVATE && LOWORD(wp) != WA_INACTIVE) {
        self->registerSource(); // retry a transient shell failure on activation
        if (self->registered_ && self->taskbar_)
            self->taskbar_->SetTabActive(window, self->host_, 0);
    }
    return DefSubclassProc(window, message, wp, lp);
}

} // namespace dv
