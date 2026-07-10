// viewer_resource.h - resource IDs for the 24seven.fm Covers desktop viewer.
// The options controls themselves are the SHARED options page (shared/options_ids.h,
// shared/options_page.rc) - the exact page the Winamp/foobar plugins use.
#ifndef SSC_VIEWER_RESOURCE_H
#define SSC_VIEWER_RESOURCE_H

#define IDI_APPICON     107  // app icon (24sevenfm_covers.ico)
#define IDD_TAB_ABOUT   103  // the "About" property-sheet page
#define IDC_ABOUT_VER   1011 // version line on the About page
#define IDC_ABOUT_LINK  1012 // clickable 24seven.fm link

#define IDD_TAB_STATION       105  // the "Station" property-sheet page (viewer only)
#define IDC_VIEW_STATION_DESC  1022 // one-line genre blurb for the selected station
#define IDC_VIEW_STATION_FIRST 1030 // first station radio button; station i uses FIRST+i

// The options page (IDD_OPTIONS_PAGE) and its control IDs come from the shared
// shared/options_ids.h + shared/options_page.rc; the viewer's own version is in
// viewer_version.h (company/copyright/web shared via shared/version.h).
#include "viewer_version.h"

#endif // SSC_VIEWER_RESOURCE_H
