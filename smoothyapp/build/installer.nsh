; SmoothyEdit NSIS Installer Script
; This script handles CEP plugin installation and clean uninstall

!include "MUI2.nsh"
!include "FileFunc.nsh"

; CEP Extensions folder path
!define CEP_FOLDER "$APPDATA\Adobe\CEP\extensions"
!define PLUGIN_NAME "com.smoothyedit.panel"

; Custom install page to show CEP installation info
!define MUI_FINISHPAGE_TEXT "SmoothyEdit has been installed successfully!$\r$\n$\r$\nThe Premiere Pro extension has been installed to:$\r$\n${CEP_FOLDER}\${PLUGIN_NAME}$\r$\n$\r$\nPlease restart Premiere Pro to use the plugin."

; Installation section - runs after main app is installed
!macro customInstall
  ; Create CEP extensions directory if it doesn't exist
  CreateDirectory "${CEP_FOLDER}"

  ; Remove old plugin if exists
  RMDir /r "${CEP_FOLDER}\${PLUGIN_NAME}"

  ; Copy CEP plugin from resources to Adobe CEP extensions folder
  SetOutPath "${CEP_FOLDER}\${PLUGIN_NAME}"
  CopyFiles /SILENT "$INSTDIR\resources\cep-plugin\*.*" "${CEP_FOLDER}\${PLUGIN_NAME}"

  ; Create .debug file to enable unsigned extensions (for development)
  FileOpen $0 "$APPDATA\Adobe\CEP\extensions\${PLUGIN_NAME}\.debug" w
  FileWrite $0 '<?xml version="1.0" encoding="UTF-8"?>$\r$\n'
  FileWrite $0 '<ExtensionList>$\r$\n'
  FileWrite $0 '  <Extension Id="${PLUGIN_NAME}">$\r$\n'
  FileWrite $0 '    <HostList>$\r$\n'
  FileWrite $0 '      <Host Name="PPRO" Port="8088"/>$\r$\n'
  FileWrite $0 '    </HostList>$\r$\n'
  FileWrite $0 '  </Extension>$\r$\n'
  FileWrite $0 '</ExtensionList>$\r$\n'
  FileClose $0

  ; Enable PlayerDebugMode in registry for unsigned extensions
  WriteRegStr HKCU "Software\Adobe\CSXS.11" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.10" "PlayerDebugMode" "1"
  WriteRegStr HKCU "Software\Adobe\CSXS.9" "PlayerDebugMode" "1"

  ; Write uninstaller info to registry for clean uninstall
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "DisplayName" "SmoothyEdit"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "UninstallString" "$INSTDIR\Uninstall SmoothyEdit.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "DisplayIcon" "$INSTDIR\SmoothyEdit.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "Publisher" "SmoothyEdit"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\SmoothyEdit" "DisplayVersion" "1.0.0"
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
