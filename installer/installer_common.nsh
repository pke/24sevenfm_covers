; installer_common.nsh - shared NSIS skeleton for the 24seven.fm Covers installers.
;
; Each host wrapper (winamp_24sevenfm_covers.nsi / foobar_24sevenfm_covers.nsi) sets the
; host-specific !defines + two macros (DETECT, RUNNING_CHECK), then !includes this file.
; Everything identical between the installers lives here, so version-info keys, the MUI
; page flow and the uninstall-registry writes are edited in ONE place.
;
; Required from the wrapper (before the !include):
;   !define APPNAME    <shown name>                     !define OUTFILE   <..\www\downloads\...exe>
;   !define HOSTNAME   <e.g. Winamp / foobar2000>       !define ORIGFILE  <the setup exe filename>
;   !define HOSTEXE    <e.g. winamp.exe>                !define UNINSTKEY <Uninstall registry subkey>
;   !define SUBDIR     <e.g. Plugins / components>      !define FILEDESC  <version-info FileDescription>
;   !define DLL        <path to the built DLL>          !define DIRTEXT   <directory-page top text>
;   !define DLLNAME    <the DLL's filename>             !define REGVIEW64 <optional: uninstall uses 64-bit view>
;   !define DEFAULTDIR <fallback install dir>
;   !macro DETECT ...         sets $INSTDIR from the registry (leaves it empty if not found)
;   !macro RUNNING_CHECK ...  aborts if the host is running (or after a reminder)
; APPVER / APPVER4 are passed by build_artifacts.ps1 (/DAPPVER..); fallbacks below.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!ifndef APPVER
  !define APPVER "0.0.0"
!endif
!ifndef APPVER4
  !define APPVER4 "0.0.0.0"
!endif
!define COMPANY   "DudeSoft"
!define COPYRIGHT "Copyright (C) 2026 DudeSoft - https://dudesoft.app"

Name "${APPNAME}"
OutFile "${OUTFILE}"
RequestExecutionLevel highest   ; elevates if admin (Program Files), else runs as user (portable)
ShowInstDetails show

; Version info shown in the setup.exe's Properties > Details.
VIProductVersion "${APPVER4}"
VIFileVersion    "${APPVER4}"
VIAddVersionKey  "ProductName"      "${APPNAME}"
VIAddVersionKey  "ProductVersion"   "${APPVER}"
VIAddVersionKey  "FileVersion"      "${APPVER4}"
VIAddVersionKey  "FileDescription"  "${FILEDESC}"
VIAddVersionKey  "CompanyName"      "${COMPANY}"
VIAddVersionKey  "LegalCopyright"   "${COPYRIGHT}"
VIAddVersionKey  "Comments"         "Homepage: https://dudesoft.app"
VIAddVersionKey  "Web"              "https://dudesoft.app"
VIAddVersionKey  "OriginalFilename" "${ORIGFILE}"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "${DIRTEXT}"
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateDir
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; Detect the host folder from the registry (wrapper's DETECT), else fall back to default.
Function .onInit
  StrCpy $INSTDIR ""
  !insertmacro DETECT
  ${If} $INSTDIR == ""
  ${OrIfNot} ${FileExists} "$INSTDIR\${HOSTEXE}"
    StrCpy $INSTDIR "${DEFAULTDIR}"
  ${EndIf}
FunctionEnd

Function ValidateDir
  ${IfNot} ${FileExists} "$INSTDIR\${HOSTEXE}"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "${HOSTEXE} was not found in:$\n$INSTDIR$\n$\nThis does not look like a ${HOSTNAME} folder. Install here anyway?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  !insertmacro RUNNING_CHECK

  SetOutPath "$INSTDIR\${SUBDIR}"
  File "${DLL}"
  WriteUninstaller "$INSTDIR\${SUBDIR}\uninstall-24sevenfm_covers.exe"

  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayVersion"  "${APPVER}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\${HOSTEXE}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\${SUBDIR}\uninstall-24sevenfm_covers.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  !ifdef REGVIEW64
  SetRegView 64
  !endif
  ; The uninstaller lives in <host>\${SUBDIR}, so $INSTDIR is that folder here.
  Delete "$INSTDIR\${DLLNAME}"
  Delete "$INSTDIR\uninstall-24sevenfm_covers.exe"
  DeleteRegKey SHCTX "${UNINSTKEY}"
SectionEnd
