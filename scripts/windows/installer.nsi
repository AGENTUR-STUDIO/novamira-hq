; SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
; SPDX-License-Identifier: AGPL-3.0-or-later
;
; Per-user installer: a stable path keeps AI client configurations valid
; across updates, which replace the files in place.

Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!ifndef VERSION
  !error "Pass /DVERSION=<version>"
!endif
!ifndef STAGE
  !error "Pass /DSTAGE=<staging directory>"
!endif
!ifndef OUTFILE
  !error "Pass /DOUTFILE=<installer path>"
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!define APP "Novamira HQ"
!define EXE "novamira-hq-desktop.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\NovamiraHQ"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"

; With /DUNINSTALLER=<path> this script builds a program that only writes the
; uninstaller there. The release signs that uninstaller, and the installer
; then ships it as a file instead of writing an unsigned one.

!define MUI_ICON "${STAGE}\novamira-hq.ico"
!ifdef UNINSTALLER
  !define MUI_UNICON "${STAGE}\novamira-hq.ico"
!endif
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Run ${APP}"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchHQ
!insertmacro MUI_PAGE_LICENSE "${STAGE}\LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!ifdef UNINSTALLER
  !insertmacro MUI_UNPAGE_CONFIRM
  !insertmacro MUI_UNPAGE_INSTFILES
!endif
!insertmacro MUI_LANGUAGE "English"

; HQ windows, servers, MCP processes and the command launcher lock their
; executables. Only those two exact files are matched, passed through the
; environment so no path is ever quoted inside the PowerShell command. A
; 32-bit installer must start 64-bit PowerShell to read 64-bit process paths.
!macro StopRunning
  System::Call 'Kernel32::SetEnvironmentVariable(t "HQ_STOP_APP", t "$INSTDIR\${EXE}")'
  System::Call 'Kernel32::SetEnvironmentVariable(t "HQ_STOP_LAUNCHER", t "$LOCALAPPDATA\Novamira HQ\State\command\novamira-hq.exe")'
  ${If} ${RunningX64}
    StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy $1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::Exec `"$1" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -in @($$env:HQ_STOP_APP, $$env:HQ_STOP_LAUNCHER) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $$_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }"`
  Pop $0
!macroend

Function LaunchHQ
  ${If} ${RunningX64}
    Exec '"$WINDIR\Sysnative\conhost.exe" --headless "$INSTDIR\${EXE}"'
  ${Else}
    Exec '"$SYSDIR\conhost.exe" --headless "$INSTDIR\${EXE}"'
  ${EndIf}
FunctionEnd

!ifdef UNINSTALLER
Function .onInit
  WriteUninstaller "${UNINSTALLER}"
  ; Quitting from .onInit otherwise reports a cancelled install.
  SetErrorLevel 0
  Quit
FunctionEnd

Section "Install"
SectionEnd
!else
Section "Install"
  !insertmacro StopRunning
  SetOutPath "$INSTDIR"
  File "${STAGE}\novamira-hq-desktop.exe"
  File "${STAGE}\LICENSE"
  File "${STAGE}\SOURCE-OFFER.txt"
  File "${STAGE}\LGPL-2.1.txt"
  File "${STAGE}\THIRD-PARTY-NOTICES.txt"
  File "${STAGE}\Uninstall.exe"
  ; A headless console: with Windows Terminal as the default terminal, HQ's
  ; own console would otherwise stay open as an empty terminal window.
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$WINDIR\System32\conhost.exe" '--headless "$INSTDIR\${EXE}"' "$INSTDIR\${EXE}" 0
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Ovation S.r.l."
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd
!endif

!ifdef UNINSTALLER
; Settings, state and credentials stay, as the Settings uninstall help says.
Section "Uninstall"
  !insertmacro StopRunning
  Delete "$INSTDIR\novamira-hq-desktop.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\SOURCE-OFFER.txt"
  Delete "$INSTDIR\LGPL-2.1.txt"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APP}.lnk"
  RMDir /r "$LOCALAPPDATA\Novamira HQ\State\command"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
!endif
