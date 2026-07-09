#ifndef SSC_VERSION_H
#define SSC_VERSION_H
/* Single source of truth for the plugin version + copyright, shared by the Winamp
   plugin (VERSIONINFO + About), the foobar2000 component (DECLARE_COMPONENT_VERSION),
   and the NSIS installer (via build_artifacts.ps1).

   The version is bumped AUTOMATICALLY by the git post-commit hook
   (.githooks/post-commit) from Conventional Commits:
     fix:  -> patch      feat: -> minor      feat! / BREAKING CHANGE -> major
   The hook rewrites the five SSC_VER_* lines below together; only set them by hand
   if you must pin a version. RC-safe: SSC_VER_STR is a pre-built literal (the resource
   compiler does not concatenate adjacent string literals). */
#define SSC_VER_MAJOR 1
#define SSC_VER_MINOR 0
#define SSC_VER_PATCH 0
#define SSC_VER_NUM   1, 0, 0, 0
#define SSC_VER_STR   "1.0.0"

#define SSC_COMPANY   "DudeSoft"
#define SSC_COPYRIGHT "Copyright (C) 2026 DudeSoft"
#endif /* SSC_VERSION_H */
