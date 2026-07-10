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

#endif // SSC_OPTIONS_IDS_H
