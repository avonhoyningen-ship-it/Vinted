/**
 * Start file for the Chrome profile of one Vinted account (own profile + own
 * remote-debugging port), so several accounts can stay logged in side by side.
 * Same logic as "Chrome fuer Vinted starten.bat", with the values filled in.
 */
export function chromeBat(profile: string, port: number, domain: string): string {
  const safe = profile.replace(/[^A-Za-z0-9_-]+/g, "") || `Account${port}`;
  return [
    "@echo off",
    `rem Chrome fuer den Vinted-Account "${safe}" (Profil C:\\vinted-chrome-${safe}, Port ${port})`,
    `title Chrome fuer Vinted - ${safe}`,
    "setlocal",
    `set "PROFILE=C:\\vinted-chrome-${safe}"`,
    `set "PORT=${port}"`,
    `set "URL=https://www.${domain}/"`,
    'set "CHROME="',
    'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined CHROME if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if not defined CHROME if exist "%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    "if not defined CHROME (",
    "  echo Google Chrome wurde nicht gefunden. Bitte installieren: https://www.google.com/chrome/",
    "  pause",
    "  goto :eof",
    ")",
    'if not exist "%PROFILE%" mkdir "%PROFILE%"',
    'start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check "%URL%"',
    "",
  ].join("\r\n");
}

export function downloadChromeBat(name: string, port: number, domain: string) {
  const blob = new Blob([chromeBat(name, port, domain)], { type: "application/x-bat" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `Chrome fuer Vinted - ${name.replace(/[^A-Za-z0-9 _-]+/g, "") || port}.bat` });
  a.click();
  URL.revokeObjectURL(url);
}
