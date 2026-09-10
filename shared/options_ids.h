// options_ids.h - resource IDs for the shared options page (IDD_OPTIONS_PAGE),
// used by both the Winamp options tab and the foobar2000 preferences page. Pure
// preprocessor so it's safe to #include from the .rc as well as C++.
#ifndef SSC_OPTIONS_IDS_H
#define SSC_OPTIONS_IDS_H

#define IDD_OPTIONS_PAGE 2000
#define IDC_OPT_OVERLAY  2001
#define IDC_OPT_ROLL     2002
#define IDC_OPT_FADE     2003
#define IDC_OPT_FADEVAL  2004
// Radio-button groups: the base id is the first radio, +i for the rest.
#define IDC_OPT_LAYOUT   2010 // 2 radios: Fill screen, Poster
#define IDC_OPT_SIZE     2020 // 3 radios: Small, Medium, Large
#define IDC_OPT_TRANS    2030 // 4 radios: None, Crossfade, Flip-H, Flip-V
#define IDC_OPT_BACKDROPS 2040
#define IDC_OPT_RATINGS   2041
#define IDC_OPT_HIDECOVER 2042
#define IDC_OPT_RATING_DE 2043
#define IDC_OPT_RATING_US 2044
#define IDC_OPT_PROVIDERS 2045
#define IDC_OPT_PROVIDER_UP 2046
#define IDC_OPT_PROVIDER_DOWN 2047
#define IDC_OPT_TITLELOGOS 2048
#define IDD_OPT_PROVIDER_DETAILS 2050
#define IDC_OPT_PROVIDER_DETAILS 2051
#define IDC_OPT_PROVIDER_LINK 2052
#define IDC_OPT_PROVIDER_ATTRIBUTION 2053
#define IDC_OPT_FANART_KEY_LABEL 2054
#define IDC_OPT_FANART_KEY 2055
#define IDC_OPT_FANART_KEY_CHECK 2056
#define IDC_OPT_FANART_KEY_STATUS 2057
#define IDC_OPT_FANART_KEY_WHY 2058
#define IDC_OPT_FANART_KEY_GET 2059
// Synthetic notification sent after an asynchronous key check has changed the
// verification timestamp. It has no corresponding HWND/control in the resource.
#define IDC_OPT_FANART_KEY_VERIFIED 2060

#endif // SSC_OPTIONS_IDS_H
