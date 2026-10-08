# Zugriff auf das Dashboard von anderen Geraeten (gleiches WLAN oder von unterwegs per Tailscale).
# Wird von "Zugriff von anderem Geraet.bat" gestartet.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
$restart = $false

Write-Host ""
Write-Host "=== Alex Sales Kit: Zugriff von anderem Laptop / Handy ===" -ForegroundColor Cyan
Write-Host ""

# 1) Passwort (ohne Passwort ist das Dashboard nur auf diesem PC erreichbar)
$lines = @()
if (Test-Path $envFile) { $lines = Get-Content $envFile -Encoding UTF8 }
$pwLine = $lines | Where-Object { $_ -match '^DASHBOARD_PASSWORD=' } | Select-Object -First 1
$pw = if ($pwLine) { $pwLine.Substring(19).Trim() } else { "" }
if (-not $pw) {
  Write-Host "Fuer den Zugriff von aussen braucht das Dashboard ein Passwort."
  do { $pw = Read-Host "Passwort waehlen (mind. 10 Zeichen)" } while ($pw.Length -lt 10)
  if ($pwLine) { $lines = $lines | ForEach-Object { if ($_ -match '^DASHBOARD_PASSWORD=') { "DASHBOARD_PASSWORD=$pw" } else { $_ } } }
  else { $lines += "DASHBOARD_PASSWORD=$pw" }
  [System.IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
  $restart = $true
  Write-Host "Passwort gespeichert." -ForegroundColor Green
} else {
  Write-Host "Dashboard-Passwort ist gesetzt (steht in .env unter DASHBOARD_PASSWORD)." -ForegroundColor Green
}

# 2) Windows-Firewall: Port 3000 nur fuer das Heimnetz (privat) und Tailscale (100.64.0.0/10) freigeben
$ruleName = "Alex Sales Kit Dashboard"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  Write-Host "Gebe Port 3000 in der Windows-Firewall frei (Windows fragt nach Administrator-Rechten) ..."
  $cmd = "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private -RemoteAddress LocalSubnet | Out-Null; " +
         "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any -RemoteAddress 100.64.0.0/10 | Out-Null"
  try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList "-NoProfile -Command $cmd"
    Write-Host "Firewall-Freigabe eingerichtet." -ForegroundColor Green
  } catch { Write-Host "Firewall-Freigabe abgebrochen - ohne sie kommen andere Geraete nicht durch." -ForegroundColor Yellow }
} else { Write-Host "Firewall-Freigabe ist schon eingerichtet." -ForegroundColor Green }

# 3) Tailscale (fuer den Zugriff von einem anderen Ort)
$ts = @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
Write-Host ""
if ($ts) {
  $tsIp = (& $ts ip -4 2>$null | Select-Object -First 1)
  if ($tsIp) {
    Write-Host "Von UNTERWEGS (Tailscale auf dem anderen Laptop installieren und mit demselben Konto anmelden):" -ForegroundColor Cyan
    Write-Host "    http://$($tsIp.Trim()):3000" -ForegroundColor White
  } else {
    Write-Host "Tailscale ist installiert, aber nicht angemeldet - bitte in Tailscale (Symbol unten rechts) einloggen und diese Datei nochmal starten." -ForegroundColor Yellow
  }
} else {
  Write-Host "Fuer den Zugriff von einem ANDEREN ORT: Tailscale installieren (kostenlos, privater verschluesselter Tunnel)." -ForegroundColor Yellow
  Write-Host "  1. Auf diesem PC UND dem anderen Laptop installieren: https://tailscale.com/download"
  Write-Host "  2. Auf beiden mit demselben Konto anmelden (z. B. Google)."
  Write-Host "  3. Diese Datei nochmal starten - dann steht hier die Adresse."
  if ((Read-Host "Download-Seite jetzt oeffnen? (j/n)") -match '^[jJyY]') { Start-Process "https://tailscale.com/download" }
}

# Adressen im gleichen WLAN
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|100\.)' } | Select-Object -ExpandProperty IPAddress
if ($ips) {
  Write-Host ""
  Write-Host "Im GLEICHEN WLAN:" -ForegroundColor Cyan
  $ips | ForEach-Object { Write-Host "    http://${_}:3000" -ForegroundColor White }
}

# 4) Autostart: Dashboard startet mit Windows (damit es von unterwegs immer erreichbar ist)
Write-Host ""
$startup = [Environment]::GetFolderPath("Startup")
$lnk = Join-Path $startup "Alex Sales Kit.lnk"
if (-not (Test-Path $lnk)) {
  if ((Read-Host "Dashboard automatisch beim Windows-Start starten? Empfohlen fuer den Zugriff von unterwegs (j/n)") -match '^[jJyY]') {
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = Join-Path $root "Dashboard starten.bat"
    $s.WorkingDirectory = $root
    $s.WindowStyle = 7
    $s.Save()
    Write-Host "Autostart eingerichtet." -ForegroundColor Green
  }
} else { Write-Host "Autostart ist eingerichtet." -ForegroundColor Green }

Write-Host ""
Write-Host "Wichtig: Dieser PC muss eingeschaltet sein (Energiesparmodus aus) und das Dashboard laufen." -ForegroundColor Yellow
Write-Host "Login auf dem anderen Geraet mit deinem Dashboard-Passwort."
if ($restart) { Write-Host "Das Passwort ist neu: Dashboard-Fenster schliessen und 'Dashboard starten.bat' neu starten." -ForegroundColor Yellow }
