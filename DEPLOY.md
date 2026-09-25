# Dashboard online stellen (von überall erreichbar)

Das Dashboard läuft auf einem kleinen eigenen Server und ist dann unter deiner Adresse
(z. B. `https://dashboard.meine-domain.de`) von iPhone, iPad und jedem Computer erreichbar – mit
Passwort-Login und verschlüsselter HTTPS-Verbindung.

**Kosten:** Server ca. 4–5 €/Monat + Domain ca. 1–15 €/Jahr. **Zeit:** ca. 30 Minuten.

## Was du brauchst

1. **Einen Server (VPS)** mit Ubuntu 24.04, mindestens 2 GB RAM.
   Empfehlung: [Hetzner Cloud](https://www.hetzner.com/cloud) → Typ **CX22** (oder CAX11), Standort Deutschland, Image **Ubuntu 24.04**.
   Nach dem Erstellen bekommst du eine **IP-Adresse** (z. B. `49.12.34.56`) und das root-Passwort per E-Mail.
2. **Eine Domain** (z. B. bei Hetzner, IONOS, Strato, GoDaddy). Eine vorhandene Domain geht auch –
   dann nutzt du eine Subdomain wie `dashboard.meine-domain.de`.

## Schritt 1: Domain auf den Server zeigen lassen

Im DNS-Bereich deines Domain-Anbieters einen Eintrag anlegen:

| Typ | Name | Wert |
|---|---|---|
| A | `dashboard` (oder `@` für die Hauptdomain) | IP-Adresse deines Servers |

Es kann 5–60 Minuten dauern, bis der Eintrag aktiv ist.

## Schritt 2: Mit dem Server verbinden

- **Mac:** Programm „Terminal“ öffnen
- **Windows:** „PowerShell“ öffnen
- **iPad/iPhone:** App „Termius“ (kostenlos)

```bash
ssh root@49.12.34.56        # deine Server-IP
```

## Schritt 3: Docker installieren

```bash
curl -fsSL https://get.docker.com | sh
```

## Schritt 4: Dashboard herunterladen und einrichten

```bash
git clone -b claude/new-session-v9ap3b https://github.com/avonhoyningen-ship-it/Vinted.git
cd Vinted
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim node scripts/setup.mjs
```

Der letzte Befehl erstellt die Datei `.env` und **zeigt dein Login-Passwort an – notieren!**

Dann die Einstellungen anpassen:

```bash
nano .env
```

Folgende Zeilen setzen (mit den Pfeiltasten navigieren, speichern mit `Strg+O`, `Enter`, beenden mit `Strg+X`):

```
DOMAIN=dashboard.meine-domain.de
ANTHROPIC_API_KEY=sk-ant-...          (optional, für KI-Inserate)
DASHBOARD_PASSWORD=...                (optional: eigenes Passwort, mind. 10 Zeichen)
```

> Das Repository ist privat? Dann bei `git clone` mit deinem GitHub-Benutzernamen und einem
> [Personal Access Token](https://github.com/settings/tokens) als Passwort anmelden.

## Schritt 5: Starten

```bash
docker compose up -d --build
```

Der erste Start dauert einige Minuten. Danach **https://dashboard.meine-domain.de** öffnen und mit
deinem Passwort anmelden. Das HTTPS-Zertifikat wird automatisch besorgt und erneuert.

**Auf iPhone/iPad:** Seite in Safari öffnen → Teilen → **„Zum Home-Bildschirm“**. Das Dashboard
startet dann wie eine App im Vollbild.

## Firewall (empfohlen)

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

## Alltag

| Aufgabe | Befehl (im Ordner `Vinted`) |
|---|---|
| Status ansehen | `docker compose ps` |
| Logs ansehen | `docker compose logs -f api` |
| Neu starten | `docker compose restart` |
| Update einspielen | `git pull && docker compose up -d --build` |
| Passwort ändern | `.env` bearbeiten, dann `docker compose up -d` |
| Stoppen | `docker compose down` |

## Backup

Alle Daten (Datenbank, Fotos) liegen im Ordner `data/`. Sicherung:

```bash
tar czf backup-$(date +%F).tar.gz data .env
```

Die Datei `.env` enthält den Schlüssel, mit dem die Vinted-Sessions verschlüsselt sind – ohne sie
sind gesicherte Sessions nicht mehr lesbar. Backup an einem sicheren Ort aufbewahren.

## Sicherheit

- Zugang nur mit Passwort; nach 10 Fehlversuchen wird die IP 15 Minuten gesperrt.
- Session-Cookies sind `HttpOnly`, `Secure` und signiert; Passwortänderung meldet alle Geräte ab.
- Vinted-Tokens sind in der Datenbank mit AES-256-GCM verschlüsselt.
- Ohne `DASHBOARD_PASSWORD` startet der Server im Docker-Betrieb absichtlich nicht.
