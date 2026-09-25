@echo off
rem Startet Alex Sales Kit (Vinted Dashboard) per Doppelklick (Windows).
title Alex Sales Kit
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto installed
echo Erster Start: Pakete werden installiert, das dauert ein paar Minuten ...
call npm.cmd install
if errorlevel 1 goto failed
:installed

if exist .env goto configured
call npm.cmd run setup
echo Bitte das Passwort oben notieren. Weiter mit einer beliebigen Taste ...
pause >nul
:configured

echo.
echo Das Dashboard startet. Der Browser oeffnet sich gleich von selbst.
echo Dieses Fenster OFFEN LASSEN, solange du das Dashboard nutzt.
echo Zum Beenden einfach dieses Fenster schliessen.
echo.

rem Oeffnet den Browser, sobald das Dashboard erreichbar ist.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 120;$i++){try{Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/login -TimeoutSec 10 | Out-Null; Start-Process 'http://localhost:3000'; break}catch{Start-Sleep 2}}"

call npm.cmd run dev
goto end

:nonode
echo Node.js ist nicht installiert. Bitte von https://nodejs.org die LTS-Version installieren.
goto end

:failed
echo Die Installation ist fehlgeschlagen. Bitte einen Screenshot dieses Fensters schicken.

:end
echo.
pause
