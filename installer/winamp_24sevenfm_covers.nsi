; 24seven.fm Covers - Winamp plugin installer (NSIS, modern UI)
; Installs gen_24sevenfm_covers.dll into <Winamp>\Plugins.
; Auto-detects a normal Winamp install from the registry; for portable installs the
; user browses to the folder, and Setup validates that winamp.exe is there.
;
; Build:  "C:\Program Files (x86)\NSIS\makensis.exe" winamp_24sevenfm_covers.nsi
; Output: dist\winamp_24sevenfm_covers.exe   (a ~100 KB installer)

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APPNAME "24seven.fm Covers Winamp plugin"
; Version is passed in by build_artifacts.ps1 (/DAPPVER=.. /DAPPVER4=..), which reads
; it from the single source shared\version.h. Fallbacks below for a direct compile.
!ifndef APPVER
  !define APPVER "0.0.0"
!endif
!ifndef APPVER4
  !define APPVER4 "0.0.0.0"
!endif
!define COMPANY   "DudeSoft"
!define COPYRIGHT "Copyright (C) 2026 DudeSoft - https://dudesoft.app"
!define DLL     "..\winamp\build\Release\gen_24sevenfm_covers.dll"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\winamp_24sevenfm_covers"

Name "${APPNAME}"
OutFile "..\dist\winamp_24sevenfm_covers.exe"
RequestExecutionLevel highest   ; elevates if admin (Program Files), else runs as user (portable)
ShowInstDetails show

; Version info shown in the setup.exe's Properties > Details.
VIProductVersion "${APPVER4}"
VIFileVersion    "${APPVER4}"
VIAddVersionKey  "ProductName"      "${APPNAME}"
VIAddVersionKey  "ProductVersion"   "${APPVER}"
VIAddVersionKey  "FileVersion"      "${APPVER4}"
VIAddVersionKey  "FileDescription"  "24seven.fm Covers - Winamp plugin installer"
VIAddVersionKey  "CompanyName"      "${COMPANY}"
VIAddVersionKey  "LegalCopyright"   "${COPYRIGHT}"
VIAddVersionKey  "Comments"         "Homepage: https://dudesoft.app"
VIAddVersionKey  "Web"              "https://dudesoft.app"
VIAddVersionKey  "OriginalFilename" "winamp_24sevenfm_covers.exe"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "Select your Winamp folder (the one that contains winamp.exe). For a portable Winamp, browse to its folder. The plugin is installed into the Plugins subfolder."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateWinampDir
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; --- Detect the Winamp folder from the registry (empty for portable installs) ---
Function .onInit
  StrCpy $INSTDIR ""
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Winamp" "UninstallString"
  ${If} $0 != ""
    ; Strip surrounding quotes, then take the directory.
    StrCpy $1 $0 1
    ${If} $1 == '"'
      StrCpy $0 $0 "" 1
      StrCpy $0 $0 -1
    ${EndIf}
    ${GetParent} "$0" $INSTDIR
  ${EndIf}
  ${If} $INSTDIR == ""
  ${OrIfNot} ${FileExists} "$INSTDIR\winamp.exe"
    StrCpy $INSTDIR "$PROGRAMFILES32\Winamp"
  ${EndIf}
FunctionEnd

Function ValidateWinampDir
  ${IfNot} ${FileExists} "$INSTDIR\winamp.exe"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "winamp.exe was not found in:$\n$INSTDIR$\n$\nThis does not look like a Winamp folder. Install here anyway?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  ; Winamp locks the plugin DLL while running; ask the user to close it first.
  FindWindow $0 "Winamp v1.x"
  ${If} $0 <> 0
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Winamp appears to be running. Please close it (right-click the tray icon > Exit), then click OK." IDOK +2
    Abort
  ${EndIf}

  SetOutPath "$INSTDIR\Plugins"
  File "${DLL}"
  WriteUninstaller "$INSTDIR\Plugins\uninstall-24sevenfm_covers.exe"

  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayVersion"  "${APPVER}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\winamp.exe"
  WriteRegStr   SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\Plugins\uninstall-24sevenfm_covers.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; The uninstaller lives in <Winamp>\Plugins, so $INSTDIR is that folder here.
  Delete "$INSTDIR\gen_24sevenfm_covers.dll"
  Delete "$INSTDIR\uninstall-24sevenfm_covers.exe"
  DeleteRegKey SHCTX "${UNINSTKEY}"
SectionEnd
