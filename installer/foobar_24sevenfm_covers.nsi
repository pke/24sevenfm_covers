; 24seven.fm Covers - foobar2000 component installer (host wrapper).
; Sets the foobar-specific values + the two divergent macros, then includes the shared
; skeleton (installer_common.nsh). Installs foo_24sevenfm_covers.dll into <foobar2000>\components;
; auto-detects a normal install from the registry, browse+validate for portable.
;
; Build:  "C:\Program Files (x86)\NSIS\makensis.exe" foobar_24sevenfm_covers.nsi
; Output: www\downloads\foobar_24sevenfm_covers.exe

!define APPNAME    "24seven.fm Covers foobar2000 component"
!define HOSTNAME   "foobar2000"
!define HOSTEXE    "foobar2000.exe"
!define SUBDIR     "components"
!define DLL        "..\foobar2000\foo_24sevenfm_covers\build\Release\foo_24sevenfm_covers.dll"
!define DLLNAME    "foo_24sevenfm_covers.dll"
!define DEFAULTDIR "$PROGRAMFILES64\foobar2000"
!define OUTFILE    "..\www\downloads\foobar_24sevenfm_covers.exe"
!define ORIGFILE   "foobar_24sevenfm_covers.exe"
!define UNINSTKEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\foobar_24sevenfm_covers"
!define FILEDESC   "24seven.fm Covers - foobar2000 component installer"
!define DIRTEXT    "Select your foobar2000 folder (the one that contains foobar2000.exe). For a portable foobar2000, browse to its folder. The component is installed into the components subfolder. Requires foobar2000 v2 (64-bit)."
; foobar2000 v2 is 64-bit; the uninstaller should use the 64-bit registry view.
!define REGVIEW64

; foobar2000 v2 is 64-bit: read its uninstall entry from the 64-bit view. Prefer
; InstallLocation; fall back to the UninstallString's parent (empty for portable).
!macro DETECT
  SetRegView 64
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${Else}
    ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000" "UninstallString"
    ${If} $0 != ""
      StrCpy $1 $0 1
      ${If} $1 == '"'
        StrCpy $0 $0 "" 1
        StrCpy $0 $0 -1
      ${EndIf}
      ${GetParent} "$0" $INSTDIR
    ${EndIf}
  ${EndIf}
!macroend

; foobar2000 has no stable window class to probe, so remind unconditionally.
!macro RUNNING_CHECK
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "If foobar2000 is running, please close it now (File > Exit) - it locks the component DLL while open.$\n$\nClick OK to continue, or Cancel to abort." IDOK +2
  Abort
!macroend

!include "installer_common.nsh"
