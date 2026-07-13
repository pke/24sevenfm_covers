// ui_element.cpp - the dockable Default-UI element. It's a thin host window: it
// hands its HWND to the shared CoverEngine and forwards the relevant window
// messages to it (paint / timers / the engine's app messages). All cover, preload,
// animation and rendering logic lives in the shared engine + Direct2D renderer -
// the exact same code the Winamp plugin runs.
//
// NOTE: the shared renderer/engine keep single-instance state, so only one cover
// panel is supported (adding a second would fight over the render target).
#include <helpers/foobar2000+atl.h>
#include <helpers/BumpableElem.h>
#include <libPPUI/win32_op.h>

#include "cover_engine.h"    // pulls d2d_renderer.h; defines SSC_WM_NEWCOVER/TICK
#include "cover_menu.h"      // shared right-click context menu (Poster / Options / Fullscreen)
#include "fullscreen.h"      // shared borderless-fullscreen toggle
#include "foobar_settings.h" // ssccfg::saveFromEngine + g_ssc_prefs_guid

namespace {

// Our element's GUID (unique to this component).
static const GUID guid_ssc_cover_elem =
    { 0x2f7a1c34, 0x9b6e, 0x4d21, { 0xa8, 0x3c, 0x11, 0x24, 0x7e, 0x5f, 0x90, 0xab } };

class ssc_cover_elem : public ui_element_instance, public CWindowImpl<ssc_cover_elem> {
public:
    DECLARE_WND_CLASS_EX(TEXT("{5B2E9D77-3A14-4C88-9F0A-7C1D2E3F4A5B}"), CS_VREDRAW | CS_HREDRAW | CS_DBLCLKS, (-1));

    void initialize_window(HWND parent) { WIN32_OP(Create(parent) != NULL); }

    BEGIN_MSG_MAP_EX(ssc_cover_elem)
        MSG_WM_CREATE(OnCreate)
        MSG_WM_DESTROY(OnDestroy)
        MSG_WM_ERASEBKGND(OnEraseBkgnd)
        MSG_WM_PAINT(OnPaint)
        MSG_WM_SIZE(OnSize)
        MSG_WM_TIMER(OnTimer)
        MSG_WM_CONTEXTMENU(OnContextMenu)
        MSG_WM_LBUTTONDBLCLK(OnLButtonDblClk)
        MSG_WM_KEYDOWN(OnKeyDown)
        MESSAGE_HANDLER(SSC_WM_NEWCOVER, OnNewCover)
    END_MSG_MAP()

    ssc_cover_elem(ui_element_config::ptr cfg, ui_element_instance_callback_ptr cb)
        : m_callback(cb), m_config(cfg) {}

    HWND get_wnd() { return *this; }
    void set_configuration(ui_element_config::ptr cfg) { m_config = cfg; }
    ui_element_config::ptr get_configuration() { return m_config; }

    static GUID g_get_guid() { return guid_ssc_cover_elem; }
    static GUID g_get_subclass() { return ui_element_subclass_playback_visualisation; }
    static void g_get_name(pfc::string_base& out) { out = "24seven.fm Covers"; }
    static ui_element_config::ptr g_get_default_configuration() {
        return ui_element_config::g_create_empty(g_get_guid());
    }
    static const char* g_get_description() {
        return "Cover art for the Streaming Soundtracks (24seven.fm) stream.";
    }

    void notify(const GUID& what, t_size, const void*, t_size) {
        if (what == ui_element_notify_colors_changed) Invalidate();
    }

private:
    int OnCreate(LPCREATESTRUCT) {
        CoverEngine::instance().setWindow(m_hWnd); // engine draws into us + owns its heartbeat
        return 0;
    }
    void OnDestroy() {
        // Only detach/free if the engine is actually drawing into THIS window. A
        // second cover element isn't really supported (single-instance renderer), but
        // if one stole the engine, destroying this one must not blank it - nor free
        // the render target it's still using.
        if (CoverEngine::instance().currentWindow() == m_hWnd) {
            CoverEngine::instance().setWindow(nullptr);
            // No element = nothing renders (the album-art provider uses the raw JPEG
            // bytes, not the render target), so free the GPU resources. The monitor
            // keeps running if a family stream is playing, to feed native album art.
            d2d::resetTarget(); // render target + cover bitmaps
            d2d::releaseBlur(); // poster-mode blur device
        }
        SetMsgHandled(FALSE); // let Bumpable/default cleanup run too
    }
    BOOL OnEraseBkgnd(CDCHandle) { return TRUE; } // D2D paints the whole client area
    void OnPaint(CDCHandle) {
        CPaintDC dc(*this); // validates the update region; D2D presents itself
        CoverEngine::instance().onPaint(m_hWnd);
    }
    void OnSize(UINT, CSize) { Invalidate(); }
    void OnTimer(UINT_PTR id) { CoverEngine::instance().onTimer(m_hWnd, id); } // engine heartbeat
    void OnContextMenu(HWND, CPoint pt) {
        // In layout-edit mode, defer to foobar's own element context menu.
        if (m_callback->is_edit_mode_enabled()) { SetMsgHandled(FALSE); return; }
        if (pt == CPoint(-1, -1)) { // keyboard-invoked (Menu key): use the client centre
            CRect rc; GetClientRect(&rc);
            pt = rc.CenterPoint(); ClientToScreen(&pt);
        }
        covermenu::Actions act;
        act.openOptions      = []     { ui_control::get()->show_preferences(g_ssc_prefs_guid); };
        act.persist          = []     { ssccfg::saveFromEngine(); };
        act.toggleFullscreen = [this] { toggleFullscreen(); };
        covermenu::showPopup(m_hWnd, pt, CoverEngine::instance(), act,
                             /*includeFullscreen*/ true, m_fs.active); // no station list
    }
    void OnLButtonDblClk(UINT, CPoint) { // double-click the cover -> fullscreen (as viewer/Winamp)
        if (!m_callback->is_edit_mode_enabled()) toggleFullscreen();
    }
    void OnKeyDown(TCHAR vk, UINT, UINT) {
        if (vk == VK_ESCAPE && m_fs.active) toggleFullscreen(); else SetMsgHandled(FALSE);
    }
    // Borderless fullscreen: the shared helper reparents this embedded element out to a
    // top-level popup and back. foobar owns the element's geometry inside its layout, so
    // we save our rect (in parent coords) going in and restore it coming out - foobar
    // re-lays-out on its own next pass, this just snaps us back in the meantime.
    void toggleFullscreen() {
        if (!m_fs.active) {
            GetWindowRect(&m_fsRect);
            if (HWND parent = GetParent()) ::MapWindowPoints(HWND_DESKTOP, parent, (LPPOINT)&m_fsRect, 2);
            m_fs.enter(m_hWnd);
        } else {
            m_fs.exit(m_hWnd);
            SetWindowPos(nullptr, m_fsRect.left, m_fsRect.top,
                         m_fsRect.Width(), m_fsRect.Height(), SWP_NOZORDER | SWP_NOACTIVATE);
        }
        Invalidate();
    }
    LRESULT OnNewCover(UINT, WPARAM, LPARAM, BOOL&) { CoverEngine::instance().onNewCover(m_hWnd); return 0; }

    ssc::Fullscreen m_fs;   // borderless-fullscreen state (shared helper)
    CRect           m_fsRect; // our pre-fullscreen rect (parent coords) to restore on exit
    ui_element_config::ptr m_config;
protected:
    const ui_element_instance_callback_ptr m_callback; // protected: ui_element_impl_withpopup needs it
};

// withpopup gives us the standalone-window popup command + menu entry for free.
class ssc_cover_elem_impl : public ui_element_impl_withpopup<ssc_cover_elem> {};
static service_factory_single_t<ssc_cover_elem_impl> g_ssc_cover_elem_factory;

} // namespace
