#ifndef SSC_VERSION_H
#define SSC_VERSION_H
/* Shared IDENTITY (company / copyright / homepage) - the same for all three binaries.
   It intentionally does NOT define a version: each binary versions INDEPENDENTLY in its
   own header, bumped separately by the git post-commit hook (.githooks/post-commit):
     winamp/gen_version.h                          -> gen_24sevenfm_covers.dll
     foobar2000/foo_24sevenfm_covers/foo_version.h -> foo_24sevenfm_covers.dll
     viewer_version.h                              -> 24sevenfm_covers.exe
   A commit bumps a binary iff it touches that module's code OR the shared code
   (lib/, shared/). Each of those headers includes THIS file for the strings below. */
#define SSC_COMPANY   "DudeSoft"
#define SSC_COPYRIGHT "Copyright (C) 2026 DudeSoft - https://dudesoft.app"
#define SSC_WEB       "https://dudesoft.app"
#endif /* SSC_VERSION_H */
