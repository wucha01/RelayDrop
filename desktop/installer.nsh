!macro customInstall
  ; Current-user installer: stable executable for SendTo and optional startup.
  Push $0
  FileOpen $0 "$INSTDIR\.relaydrop-installed" w
  FileWrite $0 "${PRODUCT_NAME} per-user installation"
  FileClose $0
  Pop $0
  CreateShortCut "$SENDTO\${PRODUCT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--send" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  Delete "$SENDTO\${PRODUCT_NAME}.lnk"
  Delete "$INSTDIR\.relaydrop-installed"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
