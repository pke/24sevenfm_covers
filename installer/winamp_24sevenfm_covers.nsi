; 24seven.fm Covers - Winamp plugin installer (host wrapper).
; Sets the Winamp-specific values + the two divergent macros, then includes the shared
; skeleton (installer_common.nsh). Installs gen_24sevenfm_covers.dll into <Winamp>\Plugins;
; auto-detects a normal install from the registry, browse+validate for portable.
;
; Build:  "C:\Program Files (x86)\NSIS\makensis.exe" winamp_24sevenfm_covers.nsi
; Output: www\downloads\winamp_24sevenfm_covers.exe

!define APPNAME    "24seven.fm Covers Winamp plugin"
!define HOSTNAME   "Winamp"
!define HOSTEXE    "winamp.exe"
!define SUBDIR     "Plugins"
!define DLL        "..\winamp\build\Release\gen_24sevenfm_covers.dll"
!define DLLNAME    "gen_24sevenfm_covers.dll"
!define DEFAULTDIR "$PROGRAMFILES32\Winamp"
!define OUTFILE    "..\www\downloads\winamp_24sevenfm_covers.exe"
!define ORIGFILE   "winamp_24sevenfm_covers.exe"
!define UNINSTKEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\winamp_24sevenfm_covers"
!define FILEDESC   "24seven.fm Covers - Winamp plugin installer"
!define DIRTEXT    "Select your Winamp folder (the one that contains winamp.exe). For a portable Winamp, browse to its folder. The plugin is installed into the Plugins subfolder."

; Winamp registers a normal uninstall entry; take its parent dir (empty for portable).
!macro DETECT
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Winamp" "UninstallString"
  ${If} $0 != ""
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $0 $0 "" 1
      StrCpy $0 $0 -1
    ${EndIf}
    ${GetParent} "$0" $INSTDIR
  ${EndIf}
!macroend

; Winamp locks the plugin DLL while running; it has a stable window class, so probe it.
!macro RUNNING_CHECK
  FindWindow $0 "Winamp v1.x"
  ${If} $0 <> 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Winamp appears to be running. Please close it (right-click the tray icon > Exit), then click OK." IDOK +2
    Abort
  ${EndIf}
!macroend

!include "installer_common.nsh"
