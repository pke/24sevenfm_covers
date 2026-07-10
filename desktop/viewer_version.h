#ifndef VIEWER_VERSION_H
#define VIEWER_VERSION_H
/* Version of the DESKTOP VIEWER (24sevenfm_covers.exe) - independent of the Winamp and
   foobar2000 plugins. The five SSC_VER_ lines are rewritten by the git post-commit hook
   (.githooks/post-commit) when a Conventional Commit touches the viewer's own root sources
   OR the shared code (lib/, shared/); edit by hand only to pin. RC-safe: SSC_VER_STR is a
   pre-built literal. */
#define SSC_VER_MAJOR 1
#define SSC_VER_MINOR 1
#define SSC_VER_PATCH 0
#define SSC_VER_NUM   1, 1, 0, 0
#define SSC_VER_STR   "1.1.0"

#include "../shared/version.h" /* SSC_COMPANY / SSC_COPYRIGHT / SSC_WEB (shared) */
#endif /* VIEWER_VERSION_H */
