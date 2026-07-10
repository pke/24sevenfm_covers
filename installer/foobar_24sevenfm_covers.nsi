; 24seven.fm Covers - foobar2000 component installer (NSIS, modern UI)
; Installs foo_24sevenfm_covers.dll into <foobar2000>\components.
; Auto-detects a normal foobar2000 install from the registry; for portable installs the
; user browses to the folder, and Setup validates that foobar2000.exe is there.
;
; Build:  "C:\Program Files (x86)\NSIS\makensis.exe" foobar_24sevenfm_covers.nsi
; Output: dist\foobar_24sevenfm_covers.exe   (a ~100 KB installer)

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APPNAME "24seven.fm Covers foobar2000 component"
; Version is passed in by build_artifacts.ps1 (/DAPPVER=.. /DAPPVER4=..), which reads it
; from this module's foobar2000\foo_24sevenfm_covers\foo_version.h. Fallbacks for a direct compile.
!ifndef APPVER
  !define APPVER "0.0.0"
!endif
!ifndef APPVER4
  !define APPVER4 "0.0.0.0"
!endif
!define COMPANY   "DudeSoft"
!define COPYRIGHT "Copyright (C) 2026 DudeSoft - https://dudesoft.app"
!define DLL     "..\foobar2000\foo_24sevenfm_covers\build\Release\foo_24sevenfm_covers.dll"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\foobar_24sevenfm_covers"

Name "${APPNAME}"
OutFile "..\dist\foobar_24sevenfm_covers.exe"
RequestExecutionLevel highest   ; elevates if admin (Program Files), else runs as user (portable)
ShowInstDetails show

; Version info shown in the setup.exe's Properties > Details.
VIProductVersion "${APPVER4}"
VIFileVersion    "${APPVER4}"
VIAddVersionKey  "ProductName"      "${APPNAME}"
VIAddVersionKey  "ProductVersion"   "${APPVER}"
VIAddVersionKey  "FileVersion"      "${APPVER4}"
VIAddVersionKey  "FileDescription"  "24seven.fm Covers - foobar2000 component installer"
VIAddVersionKey  "CompanyName"      "${COMPANY}"
VIAddVersionKey  "LegalCopyright"   "${COPYRIGHT}"
VIAddVersionKey  "Comments"         "Homepage: https://dudesoft.app"
VIAddVersionKey  "Web"              "https://dudesoft.app"
VIAddVersionKey  "OriginalFilename" "foobar_24sevenfm_covers.exe"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "Select your foobar2000 folder (the one that contains foobar2000.exe). For a portable foobar2000, browse to its folder. The component is installed into the components subfolder. Requires foobar2000 v2 (64-bit)."
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateFoobarDir
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; --- Detect the foobar2000 folder from the registry (empty for portable installs) ---
Function .onInit
  SetRegView 64            ; foobar2000 v2 is a 64-bit app; its uninstall entry is in the 64-bit view
  StrCpy $INSTDIR ""
  ; Preferred: InstallLocation (the install dir directly).
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\foobar2000" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${Else}
    ; Fallback: parse the UninstallString (".../uninstall.exe") and take its directory.
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
  ${If} $INSTDIR == ""
  ${OrIfNot} ${FileExists} "$INSTDIR\foobar2000.exe"
    StrCpy $INSTDIR "$PROGRAMFILES64\foobar2000"
  ${EndIf}
FunctionEnd

Function ValidateFoobarDir
  ${IfNot} ${FileExists} "$INSTDIR\foobar2000.exe"
    MessageBox MB_YESNO|MB_ICONEXCLAMATION "foobar2000.exe was not found in:$\n$INSTDIR$\n$\nThis does not look like a foobar2000 folder. Install here anyway?" IDYES +2
    Abort
  ${EndIf}
FunctionEnd

Section "Install"
  ; foobar2000 locks the component DLL while running; ask the user to close it first.
  ; (foobar2000 has no stable window class to probe, so this is an unconditional reminder.)
  MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "If foobar2000 is running, please close it now (File > Exit) - it locks the component DLL while open.$\n$\nClick OK to continue, or Cancel to abort." IDOK +2
  Abort

  SetOutPath "$INSTDIR\components"
  File "${DLL}"
  WriteUninstaller "$INSTDIR\components\uninstall-24sevenfm_covers.exe"

  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayVersion"  "${APPVER}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "Publisher"       "${COMPANY}"
  WriteRegStr   SHCTX "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\foobar2000.exe"
  WriteRegStr   SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\components\uninstall-24sevenfm_covers.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetRegView 64
  ; The uninstaller lives in <foobar2000>\components, so $INSTDIR is that folder here.
  Delete "$INSTDIR\foo_24sevenfm_covers.dll"
  Delete "$INSTDIR\uninstall-24sevenfm_covers.exe"
  DeleteRegKey SHCTX "${UNINSTKEY}"
SectionEnd
