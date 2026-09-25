@echo off
rem Startet Chrome mit eigenem Profil (Standard C:\vinted-chrome) und Remote-Debugging (Standard Port 9222)
rem und oeffnet vinted.de. Das Standardprofil laesst Chrome fuer Remote-Debugging nicht zu.
title Chrome fuer Vinted (%~1)
setlocal

rem Mehrere Vinted-Accounts: pro Account ein eigenes Profil und ein eigener Port, z. B.
rem   "Chrome fuer Vinted starten.bat" Shop2 9223 vinted.de
rem Ohne Angaben: Profil C:\vinted-chrome, Port 9222, vinted.de (wie bisher).
set "PROFILE=C:\vinted-chrome"
set "PORT=9222"
set "DOMAIN=vinted.de"
if not "%~1"=="" set "PROFILE=C:\vinted-chrome-%~1"
if not "%~2"=="" set "PORT=%~2"
if not "%~3"=="" set "DOMAIN=%~3"
set "URL=https://www.%DOMAIN%/"

rem Chrome suchen (Standard-Installationsorte)
set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined CHROME goto nochrome

rem Eigenes Profil anlegen (beim ersten Start leer - einmal bei Vinted einloggen)
if not exist "%PROFILE%" mkdir "%PROFILE%"

rem Laeuft schon ein Chrome mit Debug-Port? Dann nur vinted.de darin oeffnen.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/json/version -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo Chrome laeuft bereits mit Remote-Debugging auf Port %PORT% - oeffne vinted.de darin.
  start "" "%CHROME%" --user-data-dir="%PROFILE%" "%URL%"
  goto end
)

echo Starte Chrome mit Profil %PROFILE% und Remote-Debugging auf Port %PORT% ...
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%URL%"
echo.
echo Fertig. Debug-Schnittstelle: http://127.0.0.1:%PORT%/json/version
echo Hinweis: Nur auf diesem Rechner erreichbar. Solange dieses Chrome laeuft, kann jedes
echo Programm auf deinem PC es fernsteuern - nur fuer Vinted nutzen und danach schliessen.
goto end

:nochrome
echo Google Chrome wurde nicht gefunden. Bitte Chrome installieren: https://www.google.com/chrome/

:end
echo.
pause
