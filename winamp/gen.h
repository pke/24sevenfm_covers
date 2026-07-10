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

// --- Preferences-tree integration (wa_ipc.h subset) -------------------------
// A plugin adds a page to Winamp's Preferences treeview by sending a persistent
// prefsDlgRec via WM_WA_IPC/IPC_ADD_PREFS_DLG, and removes it on unload with
// IPC_REMOVE_PREFS_DLG. The dialog is a WS_CHILD template Winamp hosts in the
// prefs content pane (no per-page OK - Winamp owns the Close button).
#define IPC_ADD_PREFS_DLG    332
#define IPC_REMOVE_PREFS_DLG 333

typedef struct _prefsDlgRec {
    HINSTANCE hInst;   // DLL instance holding the dialog resource
    int       dlgID;   // dialog resource id (WS_CHILD)
    void*     proc;    // dialog proc (DLGPROC)
    char*     name;    // label shown in the prefs tree
    INT_PTR   where;   // section: 0=General, 1=Plug-ins, 2=Skins
    INT_PTR   _id;     // filled in by Winamp
    struct _prefsDlgRec* next; // used internally by Winamp
} prefsDlgRec;

#endif // SSC_WINAMP_GEN_H
