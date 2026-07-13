#ifndef GEN_VERSION_H
#define GEN_VERSION_H
/* Version of the WINAMP plugin (gen_24sevenfm_covers.dll) - independent of the foobar
   component and the desktop viewer. The five SSC_VER_ lines are rewritten by the git
   post-commit hook (.githooks/post-commit) when a Conventional Commit touches this
   module (winamp/) OR the shared code (lib/, shared/); edit by hand only to pin.
   RC-safe: SSC_VER_STR is a pre-built literal (rc.exe does not concat adjacent literals). */
#define SSC_VER_MAJOR 1
#define SSC_VER_MINOR 10
#define SSC_VER_PATCH 0
#define SSC_VER_NUM   1, 10, 0, 0
#define SSC_VER_STR   "1.10.0"

#include "../shared/version.h" /* SSC_COMPANY / SSC_COPYRIGHT / SSC_WEB (shared) */
#endif /* GEN_VERSION_H */
