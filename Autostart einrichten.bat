@echo off
rem Startet das Dashboard automatisch bei jeder Windows-Anmeldung (minimiert).
rem Nochmal ausfuehren mit dem Wort "aus" dahinter entfernt den Autostart wieder.
cd /d "%~dp0"
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Alex Sales Kit.lnk
if /i "%~1"=="aus" (
  del "%LNK%" 2>nul
  echo Autostart entfernt.
  goto end
)
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = '%~dp0Dashboard starten.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0ASK.ico'; $s.WindowStyle = 7; $s.Description = 'Alex Sales Kit automatisch starten'; $s.Save()"
if errorlevel 1 (
  echo Autostart konnte nicht eingerichtet werden.
) else (
  echo Fertig: Das Dashboard startet jetzt bei jeder Anmeldung automatisch.
  echo Tipp: In den Windows-Energieoptionen "Energiesparmodus: Nie" einstellen, damit es durchlaeuft.
)
:end
echo.
if /i not "%~2"=="still" pause
