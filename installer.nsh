!macro customInstall
  ; Add "Open with Diamond Media Player" to the context menu with icon
  WriteRegStr HKCR "*\shell\DiamondMediaPlayer" "" "Open with Diamond Media Player"
  WriteRegStr HKCR "*\shell\DiamondMediaPlayer" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCR "*\shell\DiamondMediaPlayer\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUninstall
  ; Clean up the registry keys on uninstall
  DeleteRegKey HKCR "*\shell\DiamondMediaPlayer"
!macroend
