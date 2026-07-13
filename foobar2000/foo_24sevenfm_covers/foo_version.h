#ifndef FOO_VERSION_H
#define FOO_VERSION_H
/* Version of the FOOBAR2000 component (foo_24sevenfm_covers.dll) - independent of the
   Winamp plugin and the desktop viewer. The five SSC_VER_ lines are rewritten by the git
   post-commit hook (.githooks/post-commit) when a Conventional Commit touches this module
   (foobar2000/foo_24sevenfm_covers/) OR the shared code (lib/, shared/); edit by hand only
   to pin. RC-safe: SSC_VER_STR is a pre-built literal. */
#define SSC_VER_MAJOR 1
#define SSC_VER_MINOR 5
#define SSC_VER_PATCH 12
#define SSC_VER_NUM   1, 5, 12, 0
#define SSC_VER_STR   "1.5.12"

#include "../../shared/version.h" /* SSC_COMPANY / SSC_COPYRIGHT / SSC_WEB (shared) */
#endif /* FOO_VERSION_H */
