@echo off
rem PC-Helfer fuer die Cloud-Version von Alex Sales Kit.
rem Verbindet dein Vinted-Chrome und deine Vinted-Accounts mit dem Online-Dashboard.
rem Deine Vinted-Anmeldung bleibt auf diesem PC (verschluesselt in %USERPROFILE%\.ask-helper).
title PC-Helfer - Alex Sales Kit
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules (echo Pruefe Pakete ...) else (echo Erster Start: Pakete werden installiert, das dauert ein paar Minuten ...)
call npm.cmd install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto failed

rem Vinted-Chrome starten, falls es noch nicht laeuft (Port 9222).
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 call "Chrome fuer Vinted starten.bat"

echo.
echo Der PC-Helfer startet. Beim ersten Start fragt er nach der Dashboard-Adresse
echo und dem Helfer-Schluessel (Dashboard - Accounts - PC-Helfer).
echo Dieses Fenster OFFEN LASSEN, solange das Dashboard mit Vinted arbeiten soll.
echo.
call npm.cmd run helper -w apps/api -- %*
goto end

:nonode
echo Node.js ist nicht installiert. Bitte die LTS-Version von https://nodejs.org installieren und erneut starten.
goto end

:failed
echo Die Installation ist fehlgeschlagen. Bitte die Meldungen oben pruefen.

:end
pause
