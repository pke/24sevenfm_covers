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
#include "preferences_click_map.h"

// External linkage (declared in foobar_settings.h) so the UI element's context menu
// can open Preferences straight to this page via ui_control::show_preferences().
extern const GUID g_ssc_prefs_guid =
    { 0x6d2a41e7, 0x3c9b, 0x4a5f, { 0x9e, 0x21, 0x7b, 0x44, 0x0c, 0x8e, 0x13, 0xd2 } };

namespace {

class CSscPrefs : public CDialogImpl<CSscPrefs>, public preferences_page_instance {
public:
    CSscPrefs(preferences_page_callback::ptr callback)
        : m_callback(callback), m_clicks([this](int id) {
            optpanel::onCommand(*this, id);
            optpanel::updateEnabled(*this);
            onChanged();
        }) {}

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
        CHAIN_MSG_MAP_MEMBER(m_clicks) // all checkboxes + radio groups
        COMMAND_HANDLER_EX(IDC_OPT_FANART_KEY, EN_CHANGE, OnTextChange)
        NOTIFY_HANDLER_EX(IDC_OPT_PROVIDERS, LVN_ITEMCHANGED, OnProviderChanged)
    END_MSG_MAP()

private:
    BOOL OnInitDialog(CWindow, LPARAM) {
        m_dark.AddDialogWithControls(*this);
        optpanel::init(*this, CoverEngine::instance().settings);
        return FALSE;
    }
    void OnHScroll(UINT, UINT, CScrollBar) { optpanel::onHScroll(*this); onChanged(); }
    void OnTextChange(UINT, int, CWindow) { onChanged(); }
    LRESULT OnProviderChanged(LPNMHDR header) {
        if (optpanel::onNotify(*this, header)) onChanged();
        return 0;
    }

    bool hasChanged() {
        CoverEngine::Settings d; optpanel::read(*this, d);
        const CoverEngine::Settings& s = CoverEngine::instance().settings;
        return d.showRemaining != s.showRemaining || d.remainingSize != s.remainingSize ||
               d.rollDigits != s.rollDigits || d.transition != s.transition ||
               d.fadeMs != s.fadeMs || d.layout != s.layout ||
               d.backdrops != s.backdrops || d.ratings != s.ratings ||
               d.hideCoverWithBackdrop != s.hideCoverWithBackdrop ||
               d.ratingDE != s.ratingDE || d.ratingUS != s.ratingUS ||
               d.mediaProviders != s.mediaProviders ||
               d.fanartClientKey != s.fanartClientKey ||
               d.fanartClientKeyVerifiedAt != s.fanartClientKeyVerifiedAt;
    }
    void onChanged() { m_callback->on_state_changed(); }

    const preferences_page_callback::ptr m_callback;
    SscPreferencesClickMap m_clicks;
    fb2k::CDarkModeHooks m_dark;
};

class preferences_page_ssc : public preferences_page_impl<CSscPrefs> {
public:
    const char* get_name() { return "24seven.fm Covers"; }
    GUID get_guid() { return g_ssc_prefs_guid; }
    GUID get_parent_guid() { return preferences_page::guid_display; }
};

static preferences_page_factory_t<preferences_page_ssc> g_preferences_page_ssc_factory;

} // namespace
