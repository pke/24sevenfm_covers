// preferences.cpp - the foobar2000 preferences page (Preferences > Display >
// 24seven.fm Covers). A thin host: it wraps the SHARED options page (IDD_OPTIONS_PAGE +
// shared/options_panel.cpp - the exact dialog + control logic the Winamp options tab
// uses) in foobar's preferences framework, persisting via cfg_var and applying live.
// Dark mode is handled for us by fb2k::CDarkModeHooks.
#include <helpers/foobar2000+atl.h>
#include <helpers/atl-misc.h>
#include <helpers/DarkMode.h>

#include "options_panel.h" // shared page IDs + control logic
#include "cover_engine.h"
#include "foobar_settings.h"

namespace {

class CSscPrefs : public CDialogImpl<CSscPrefs>, public preferences_page_instance {
public:
    CSscPrefs(preferences_page_callback::ptr callback) : m_callback(callback) {}

    enum { IDD = IDD_OPTIONS_PAGE }; // the shared dialog resource

    t_uint32 get_state() {
        t_uint32 state = preferences_state::resettable | preferences_state::dark_mode_supported;
        if (hasChanged()) state |= preferences_state::changed;
        return state;
    }
    void apply() {
        optpanel::read(*this, CoverEngine::instance().settings);
        ssccfg::saveFromEngine();          // persist
        CoverEngine::instance().repaint(); // reflect on the panel immediately
        onChanged();
    }
    void reset() {
        optpanel::setValues(*this, CoverEngine::Settings{}); // struct defaults
        onChanged();
    }

    BEGIN_MSG_MAP_EX(CSscPrefs)
        MSG_WM_INITDIALOG(OnInitDialog)
        MSG_WM_HSCROLL(OnHScroll)
        COMMAND_HANDLER_EX(IDC_OPT_OVERLAY, BN_CLICKED, OnEnableChange)
        COMMAND_HANDLER_EX(IDC_OPT_ROLL, BN_CLICKED, OnAnyChange)
        COMMAND_HANDLER_EX(IDC_OPT_SIZE, CBN_SELCHANGE, OnAnyChange)
        COMMAND_HANDLER_EX(IDC_OPT_TRANS, CBN_SELCHANGE, OnEnableChange)
    END_MSG_MAP()

private:
    BOOL OnInitDialog(CWindow, LPARAM) {
        m_dark.AddDialogWithControls(*this);
        optpanel::init(*this, CoverEngine::instance().settings);
        return FALSE;
    }
    void OnHScroll(UINT, UINT, CScrollBar) { optpanel::onHScroll(*this); onChanged(); }
    void OnEnableChange(UINT, int, CWindow) { optpanel::updateEnabled(*this); onChanged(); }
    void OnAnyChange(UINT, int, CWindow) { onChanged(); }

    bool hasChanged() {
        CoverEngine::Settings d; optpanel::read(*this, d);
        const CoverEngine::Settings& s = CoverEngine::instance().settings;
        return d.showOverlay != s.showOverlay || d.overlaySize != s.overlaySize ||
               d.rollDigits != s.rollDigits || d.transition != s.transition || d.fadeMs != s.fadeMs;
    }
    void onChanged() { m_callback->on_state_changed(); }

    const preferences_page_callback::ptr m_callback;
    fb2k::CDarkModeHooks m_dark;
};

class preferences_page_ssc : public preferences_page_impl<CSscPrefs> {
public:
    const char* get_name() { return "24seven.fm Covers"; }
    GUID get_guid() {
        return GUID { 0x6d2a41e7, 0x3c9b, 0x4a5f, { 0x9e, 0x21, 0x7b, 0x44, 0x0c, 0x8e, 0x13, 0xd2 } };
    }
    GUID get_parent_guid() { return preferences_page::guid_display; }
};

static preferences_page_factory_t<preferences_page_ssc> g_preferences_page_ssc_factory;

} // namespace
