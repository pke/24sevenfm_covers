// gen.h - minimal Winamp general-purpose plugin SDK definition.
#ifndef SSC_WINAMP_GEN_H
#define SSC_WINAMP_GEN_H

#include <windows.h>

typedef struct {
    int version;            // GPPHDR_VER
    char* description;      // name shown in Winamp's plugin list
    int  (*init)();         // called on Winamp's UI thread; return 0 on success
    void (*config)();
    void (*quit)();
    HWND hwndParent;        // Winamp main window (filled by Winamp)
    HINSTANCE hDllInstance; // this DLL's instance (filled by Winamp)
} winampGeneralPurposePlugin;

#define GPPHDR_VER 0x10

#endif // SSC_WINAMP_GEN_H
