@echo off
rem Dashboard von einem anderen Laptop/Handy aus erreichbar machen (WLAN oder unterwegs per Tailscale).
title Zugriff von anderem Geraet
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\remote-access.ps1"
echo.
pause
