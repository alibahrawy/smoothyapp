; SmoothyEdit NSIS Installer Script
; This script handles CEP plugin installation and clean uninstall

!include "MUI2.nsh"
!include "FileFunc.nsh"

; CEP Extensions folder path
!define CEP_FOLDER "$APPDATA\Adobe\CEP\extensions"
!define PLUGIN_NAME "com.smoothyedit.panel"
!define EXTENSION_ID "com.smoothyedit.autocut.panel"

; Custom install page to show CEP installation info
!define MUI_FINISHPAGE_TEXT "SmoothyEdit has been installed successfully!$\r$\n$\r$\nThe Premiere Pro extension has been installed to:$\r$\n${CEP_FOLDER}\${PLUGIN_NAME}$\r$\n$\r$\nPlease restart Premiere Pro to use the plugin."

; Installation section - runs after main app is installed
!macro customInstall
  ; Create CEP extensions directory if it doesn't exist
  CreateDirectory "${CEP_FOLDER}"

  ; Remove old plugin if exists
  RMDir /r "${CEP_FOLDER}\${PLUGIN_NAME}"
  CreateDirectory "${CEP_FOLDER}\${PLUGIN_NAME}"

  ; Copy the CEP plugin recursively. CopyFiles is NOT recursive, which used to
  ; leave the CSXS/, jsx/ and js/ folders behind. xcopy /E copies subdirectories
  ; (including empty ones) and /I treats the destination as a directory.
  nsExec::ExecToLog 'xcopy /E /I /Y "$INSTDIR\resources\cep-plugin" "${CEP_FOLDER}\${PLUGIN_NAME}"'
  Pop $0

  ; Create .debug file to enable the unsigned extension
  FileOpen $0 "${CEP_FOLDER}\${PLUGIN_NAME}\.debug" w
  FileWrite $0 '<?xml version="1.0" encoding="UTF-8"?>$\r$\n'
  FileWrite $0 '<ExtensionList>$\r$\n'
  FileWrite $0 '  <Extension Id="${EXTENSION_ID}">$\r$\n'
  FileWrite $0 '    <HostList>$\r$\n'
  FileWrite $0 '      <Host Name="PPRO" Port="8088"/>$\r$\n'
  FileWrite $0 '    </HostList>$\r$\n'
  FileWrite $0 '  </Extension>$\r$\n'
  FileWrite $0 '</ExtensionList>$\r$\n'
  FileClose $0

  ; Enable PlayerDebugMode for unsigned extensions. CSXS 12 and 13 are what
  ; current Premiere Pro builds read; 9-11 are kept for older releases.
  WriteRegStr HKCU "Software\Adobe\CSXS.13" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.12" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.11" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.10" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.9" "PlayerDebugMode" "1"

  ; Write uninstaller info to registry for clean uninstall
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "DisplayName" "SmoothyEdit"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "UninstallString" "$INSTDIR\Uninstall SmoothyEdit.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "DisplayIcon" "$INSTDIR\SmoothyEdit.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "Publisher" "SmoothyEdit"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "DisplayVersion" "${VERSION}"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "NoRepair" 1

  ; Get install size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "EstimatedSize" "$0"
!macroend

; Uninstall section - clean removal
!macro customUnInstall
  ; Remove CEP plugin
  RMDir /r "${CEP_FOLDER}\${PLUGIN_NAME}"

  ; Remove registry entries
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit"

  ; Don't remove PlayerDebugMode as other extensions might need it
!macroend
