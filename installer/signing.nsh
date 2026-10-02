; Sign and verify the uninstaller before NSIS embeds it into the installer.
; The outer installer is signed as part of the final batch in build_artifacts.ps1.
!ifdef SIGN_THUMBPRINT
  !uninstfinalize '"${SIGN_POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "${__FILEDIR__}\sign_file.ps1" -Path "%1" -Thumbprint "${SIGN_THUMBPRINT}" -TimestampUrl "${SIGN_TIMESTAMP}" -SignToolPath "${SIGNTOOL}"' = 0
!endif
