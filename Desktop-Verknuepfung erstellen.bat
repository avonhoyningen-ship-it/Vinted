@echo off
rem Legt auf dem Desktop eine Verknuepfung "Alex Sales Kit" mit dem ASK-Icon an.
cd /d "%~dp0"
powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Alex Sales Kit.lnk'); $s.TargetPath = '%~dp0Dashboard starten.bat'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = '%~dp0ASK.ico'; $s.Description = 'Alex Sales Kit starten'; $s.Save()"
if errorlevel 1 (
  echo Verknuepfung konnte nicht erstellt werden.
) else (
  echo Fertig: Auf dem Desktop liegt jetzt "Alex Sales Kit" mit dem ASK-Icon.
)
echo.
pause
