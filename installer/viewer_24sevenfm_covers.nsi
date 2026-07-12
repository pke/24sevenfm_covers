; 24seven.fm Covers - desktop viewer installer (standalone app).
; Installs the self-contained 24sevenfm_covers.exe to Program Files with a Start
; Menu shortcut + an uninstaller. Unlike the plugin installers there is no host to
; detect, so this does NOT use installer_common.nsh (which is host-plugin shaped).
;
; Build:  "C:\Program Files (x86)\NSIS\makensis.exe" viewer_24sevenfm_covers.nsi
; Output: www\downloads\viewer_24sevenfm_covers.exe
; APPVER / APPVER4 are passed by build_artifacts.ps1 (/DAPPVER..); fallbacks below.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef APPVER
  !define APPVER "0.0.0"
!endif
!ifndef APPVER4
  !define APPVER4 "0.0.0.0"
!endif
!define APPNAME   "24seven.fm Covers"
!define APPEXE    "24sevenfm_covers.exe"
!define WNDCLASS  "SST24CoverViewerWnd"   ; the viewer's window class (running check)
!define COMPANY   "DudeSoft"
!define COPYRIGHT "Copyright (C) 2026 DudeSoft - https://dudesoft.app"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\24sevenfm_covers_viewer"

Name "${APPNAME}"
OutFile "..\www\downloads\viewer_24sevenfm_covers.exe"
InstallDir "$PROGRAMFILES64\24seven.fm Covers"
InstallDirRegKey HKLM "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel admin
ShowInstDetails show

VIProductVersion "${APPVER4}"
VIFileVersion    "${APPVER4}"
VIAddVersionKey  "ProductName"      "${APPNAME}"
VIAddVersionKey  "ProductVersion"   "${APPVER}"
VIAddVersionKey  "FileVersion"      "${APPVER4}"
VIAddVersionKey  "FileDescription"  "24seven.fm Covers - desktop viewer installer"
VIAddVersionKey  "CompanyName"      "${COMPANY}"
VIAddVersionKey  "LegalCopyright"   "${COPYRIGHT}"
VIAddVersionKey  "Comments"         "Homepage: https://dudesoft.app"
VIAddVersionKey  "Web"              "https://dudesoft.app"
VIAddVersionKey  "OriginalFilename" "viewer_24sevenfm_covers.exe"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPEXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch 24seven.fm Covers"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  SetShellVarContext all   ; per-machine: Program Files, HKLM uninstall, all-users Start Menu
FunctionEnd
Function un.onInit
  SetShellVarContext all
FunctionEnd

; The viewer locks its own exe while running; it has a stable window class, so probe it.
!macro RUNNING_CHECK
  FindWindow $0 "${WNDCLASS}"
  ${If} $0 <> 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "24seven.fm Covers appears to be running. Please close it, then click OK." IDOK +2
    Abort
  ${EndIf}
!macroend

Section "Install"
  !insertmacro RUNNING_CHECK

  SetOutPath "$INSTDIR"
  File "..\desktop\build\Release\24sevenfm_covers.exe"
  WriteUninstaller "$INSTDIR\uninstall-24sevenfm_covers.exe"

  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${APPEXE}"

  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayVersion"  "${APPVER}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\${APPEXE}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall-24sevenfm_covers.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${APPEXE}"
  Delete "$INSTDIR\uninstall-24sevenfm_covers.exe"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  RMDir "$INSTDIR"
  DeleteRegKey SHCTX "${UNINSTKEY}"

  ; Remove this user's settings. The installed viewer stores its INI in per-user
  ; %APPDATA% (Program Files isn't writable), so switch to the current-user context
  ; for the lookup. Other users' copies, if any, are inherently out of reach of a
  ; per-machine uninstaller.
  SetShellVarContext current
  Delete "$APPDATA\24seven.fm Covers\24seven.fm-covers.ini"
  RMDir  "$APPDATA\24seven.fm Covers"
SectionEnd
