@echo off
setlocal
start "" /min powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "%~dp0scripts\launch-desktop.ps1"
exit /b
