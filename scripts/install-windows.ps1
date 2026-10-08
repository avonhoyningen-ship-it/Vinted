# Alex Sales Kit auf einem weiteren Windows-PC/Laptop installieren.
# Start in PowerShell:
#   irm https://raw.githubusercontent.com/avonhoyningen-ship-it/vinted/claude/new-session-v9ap3b/scripts/install-windows.ps1 | iex
$ErrorActionPreference = "Stop"
$repo = "https://github.com/avonhoyningen-ship-it/vinted.git"
$branch = "claude/new-session-v9ap3b"
$dir = Join-Path $HOME "Vinted"

function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
function Need($cmd, $id, $name) {
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "$name ist installiert." -ForegroundColor Green; return }
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "$name fehlt und winget ist nicht verfuegbar. Bitte $name von Hand installieren und dieses Skript nochmal starten." }
  Write-Host "Installiere $name ..." -ForegroundColor Cyan
  # Only the winget source: the Microsoft Store source often fails (certificate errors) and makes the ID ambiguous.
  winget install --id $id -e --source winget --silent --accept-package-agreements --accept-source-agreements | Out-Host
  $code = $LASTEXITCODE
  Refresh-Path
  if (Get-Command $cmd -ErrorAction SilentlyContinue) { Write-Host "$name ist jetzt installiert." -ForegroundColor Green; return }
  if ($code -ne 0) { throw "$name konnte nicht installiert werden (winget-Fehler $code). Bitte $name von Hand installieren und die Zeile nochmal einfuegen." }
  throw "$name wurde installiert, ist aber in diesem Fenster noch nicht verfuegbar. Bitte das Fenster schliessen, ein neues oeffnen und die Zeile nochmal einfuegen."
}

Write-Host ""
Write-Host "=== Alex Sales Kit: Installation ===" -ForegroundColor Cyan
Need "git" "Git.Git" "Git"
Need "node" "OpenJS.NodeJS.LTS" "Node.js"

if (Test-Path (Join-Path $dir ".git")) {
  Write-Host "Ordner $dir gibt es schon - hole die neueste Version ..." -ForegroundColor Cyan
  git -C $dir pull
} else {
  Write-Host "Lade das Programm nach $dir ..." -ForegroundColor Cyan
  git clone --branch $branch $repo $dir
}
Set-Location $dir

Write-Host "Installiere Pakete (ein paar Minuten) ..." -ForegroundColor Cyan
npm.cmd install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm install ist fehlgeschlagen." }

$envFile = Join-Path $dir ".env"
if (-not (Test-Path $envFile)) {
  npm.cmd run setup | Out-Null
  $lines = Get-Content $envFile -Encoding UTF8
  # Nur auf diesem Laptop nutzen: kein Login noetig, startet schneller.
  $lines = $lines | ForEach-Object { if ($_ -match '^DASHBOARD_PASSWORD=') { "DASHBOARD_PASSWORD=" } else { $_ } }
  Write-Host ""
  Write-Host "Fuer die KI-Funktionen (Beschreibungen, Analyse) brauchst du deinen Anthropic-API-Key." -ForegroundColor Yellow
  Write-Host "Er steht auf dem Haupt-PC in der Datei .env (ANTHROPIC_API_KEY=...) oder du erstellst einen neuen: https://console.anthropic.com/settings/keys"
  $key = Read-Host "API-Key einfuegen (leer lassen = spaeter)"
  if ($key) { $lines = $lines | ForEach-Object { if ($_ -match '^ANTHROPIC_API_KEY=') { "ANTHROPIC_API_KEY=$($key.Trim())" } else { $_ } } }
  [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
}

# Verknuepfung auf dem Desktop
$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath("Desktop") + "\Alex Sales Kit.lnk")
$s.TargetPath = Join-Path $dir "Dashboard starten.bat"; $s.WorkingDirectory = $dir; $s.IconLocation = Join-Path $dir "ASK.ico"; $s.Save()

Write-Host ""
Write-Host "Fertig! Auf dem Desktop liegt jetzt 'Alex Sales Kit'." -ForegroundColor Green
Write-Host "Das Dashboard startet jetzt. Danach:" -ForegroundColor Green
Write-Host "  1. Im Vinted-Chrome (oeffnet sich automatisch) bei Vinted einloggen."
Write-Host "  2. Im Dashboard: Accounts -> '+ Account verbinden' -> Namen eingeben -> 'Login aus Vinted-Chrome uebernehmen'."
Write-Host "     Deine Artikel, Verkaeufe und Statistiken werden dann von Vinted geladen."
Start-Process (Join-Path $dir "Dashboard starten.bat") -WorkingDirectory $dir
