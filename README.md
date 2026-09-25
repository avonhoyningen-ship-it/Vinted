# Vinted Multi-Account Dashboard

Web-Dashboard zur Verwaltung mehrerer **eigener** Vinted-Accounts für Reselling: Accounts, KI-gestützte
Listing-Erstellung mit Warteschlange, dauerhaftes Artikel-Archiv mit Reupload, Automatisierungen,
Sale-Sound und Statistiken. Läuft komplett lokal bzw. auf einem eigenen Server.

- **Frontend:** Next.js 16 (React 19), Recharts, canvas-confetti – `apps/web`
- **Backend:** Node.js + Express, eigenständige REST-API (auch für eine spätere Mobile-App) – `apps/api`
- **Datenbank:** SQLite (in Node.js eingebaut, `node:sqlite` – nichts zu kompilieren), Fotos im Dateisystem – `data/`
- **Voraussetzung:** Node.js 22.13 oder neuer (empfohlen: aktuelle LTS)

## Schnellstart

```bash
npm install
npm run setup        # erstellt .env mit zufälligem ENCRYPTION_KEY
# optional: ANTHROPIC_API_KEY in .env eintragen (für KI-Inserate)
npm run dev          # API auf :4000, Dashboard auf http://localhost:3000
```

`npm run setup` erzeugt auch ein **Login-Passwort** und zeigt es an (änderbar in `.env` unter `DASHBOARD_PASSWORD`).

Produktion lokal: `npm run build && npm start`. Tests: `npm test`.

**Online von überall (iPhone, iPad, unterwegs):** siehe **[DEPLOY.md](DEPLOY.md)** – eigener Server mit
Docker, automatischem HTTPS (Caddy) und Passwort-Login.

Standardmäßig läuft das Dashboard im **Simulationsmodus** (`VINTED_MODE=mock`): Beliebiges Token ≥ 8 Zeichen
eingeben → der Account wird mit drei Beispiel-Listings „verbunden“. Auf der Account-Detailseite lassen sich
Verkäufe, Favoriten und Nachrichten simulieren, um Sale-Sound, Regeln und Statistiken zu testen.

## Module

| Route | Inhalt |
|---|---|
| `/` | Übersicht: Umsatz heute/Monat, aktive Listings, Warteschlange, letzte Aktivität |
| `/accounts` | Accounts verbinden (Länder-Domain + Session-Token), Status, Listings, Verkäufe, Nachrichten, Follower |
| `/listings` | Fotos hochladen (einzeln oder Batch), KI-Ausfüllen, Entwürfe, Warteschlange, aktive Listings, Textvorlagen |
| `/archive` | Alle je eingestellten Artikel, filterbar nach Account/Status/Kategorie/Marke; Bearbeiten, Fotos, Verlauf, Reupload |
| `/automations` | Regeln „Wenn [Ereignis] dann [Aktion] nach [Zeitspanne]“ + Aktionsprotokoll |
| `/stats` | Umsatz/Verkäufe pro Zeitraum und Account (gestapelte Balken), Ø Verkaufsdauer, Top-Marken/Kategorien |
| `/settings` | Sale-Sound (6 Presets, Lautstärke), Konfetti, Desktop-Benachrichtigung, Tageslimit, KI-Sprache |

## Architektur

```
apps/api/src
├── config/env.ts            alle Einstellungen aus .env (keine Secrets im Code)
├── db/                      SQL-Migrationen (portabel gehalten für späteren PostgreSQL-Umstieg)
├── lib/crypto.ts            AES-256-GCM für Session-Tokens
├── lib/rateLimiter.ts       Mindestabstand + Jitter pro Account
├── vinted/vintedClient.ts   zentrale Vinted-Schicht: Rate-Limit, Retry/Backoff bei 429
│   ├── mockAdapter.ts       Simulation (Entwicklung/Demo/Tests)
│   └── liveAdapter.ts       Vinted-Web-Endpunkte (siehe Einschränkungen)
├── modules/
│   ├── accounts/            CRUD + sync.ts (Profil, Listings, Verkäufe, Favoriten, Nachrichten)
│   ├── archive/             Artikel, Fotos, Listing-Verlauf, Suche, Reupload
│   ├── listings/            KI (ai.ts), Entwürfe, Warteschlange (queue.ts), Vorlagen
│   ├── automations/         Regel-Engine (engine.ts)
│   ├── stats/               Kennzahlen, Zeitreihen, Top-Listen
│   └── system/              Einstellungen, SSE-Eventstream, Fotos, Simulation
└── workers/scheduler.ts     Hintergrund-Loops: Polling, Veröffentlichung, Aktionen, Preissenkung
```

### Datenmodell (Kern)

- `accounts`: Domain, Benutzername, **verschlüsseltes** Session-Token (`v1:iv:tag:ciphertext`), Kennzahlen
- `items`: der Artikel im Archiv (Titel, Beschreibung, Kategorie, Marke, Größe, Zustand, Farbe, Material, Maße,
  Preis, Einkaufspreis, Notizen). Wird durch Synchronisierung **nie gelöscht**.
- `item_photos`: Fotos (Datei + SHA-256, Reihenfolge)
- `listings`: jedes Einstellen eines Artikels auf einem Account = eine Zeile (Snapshot von Titel/Text/Preis,
  Status aktiv/verkauft/entfernt, Favoriten, Aufrufe, Verkaufsdatum/-preis) → vollständiger Verlauf
- `listing_price_changes`, `sales`, `publish_queue`, `templates`
- `automation_rules`, `vinted_events` (dedupliziert), `scheduled_actions` (Plan + Protokoll)

Der Artikelstatus (Entwurf / in Warteschlange / aktiv / verkauft / archiviert / erneut gelistet) wird aus dem
Listing-Verlauf abgeleitet und kann daher nicht auseinanderlaufen.

### REST-API

Alle Endpunkte unter `/api`, JSON. Anmeldung per `POST /api/auth/login` (Session-Cookie) oder – für Skripte
und eine spätere Mobile-App – per `Authorization: Bearer <API_TOKEN>`.
Wichtigste Endpunkte: `GET/POST /accounts`, `POST /accounts/:id/sync`, `GET /archive`, `GET/PATCH /archive/:id`,
`POST /archive/:id/photos`, `POST /archive/:id/reupload`, `POST /listings/drafts`, `POST /listings/drafts/:id/ai`,
`GET/POST /listings/queue`, `GET/POST/PUT /automations/rules`, `GET /stats/overview|timeseries|top`,
`GET /events/stream` (Server-Sent Events für Live-Benachrichtigungen).

## Automatisierungen

| Ereignis | Aktion | Beispiel |
|---|---|---|
| Artikel wird favorisiert | Nachricht senden | „Danke fürs Merken, {nutzer}! Bei Fragen gerne melden 😊“ |
| Nachricht erhalten (Schlüsselwörter) | Nachricht senden | FAQ-Antwort auf „Maße“, „Versand“ … |
| Artikel verkauft | Nachricht senden | Danke für den Kauf |
| X Tage ohne Verkauf | Preis senken | −10 % nach 14 Tagen, alle 7 Tage wiederholen, Mindestpreis |

Platzhalter: `{artikelname}`, `{preis}`, `{neuer_preis}`, `{marke}`, `{groesse}`, `{nutzer}`, `{account}`.
Spam-Schutz: Häufigkeitslimit pro Nutzer und Regel, globales Tageslimit pro Account (Standard 40),
Globalschalter „Alle pausieren“. Beim **ersten** Sync eines Accounts werden alte Ereignisse nur gespeichert,
aber keine Aktionen ausgelöst.

## Rate-Limits & Nutzungsbedingungen

- Polling pro Account standardmäßig alle 10 Minuten (Minimum 5, `POLL_INTERVAL_MINUTES`)
- Mindestens 4 s + Jitter zwischen zwei Requests pro Account (`VINTED_MIN_REQUEST_GAP_MS`), Requests pro Account seriell
- Bei HTTP 429: Backoff (Retry-After bzw. 30 s/60 s), Veröffentlichungen werden verschoben statt wiederholt
- Warteschlange: maximal eine Veröffentlichung pro Account und Durchlauf, Standardabstand 30 Minuten

## Getroffene Annahmen & Entscheidungen

1. **Keine offizielle Vinted-API.** Vinted bietet keine öffentliche API für Privat-Accounts. Der Live-Adapter
   nutzt die Lese-Endpunkte der Vinted-Web-App (Profil, Kleiderschrank, Verkäufe, Benachrichtigungen, Posteingang).
   Diese sind undokumentiert und können sich jederzeit ändern. Alle Pfade stehen ausschließlich in `liveAdapter.ts`.
2. **Schreibende Aktionen im Live-Modus** (Einstellen, Nachrichten senden, Preis ändern) sind bewusst
   **nicht** gegen undokumentierte Endpunkte implementiert. Sie liefern eine klare Fehlermeldung. Alles ist
   vorbereitet: Wenn es einen offiziellen Weg gibt, wird nur `liveAdapter.ts` ergänzt. Bis dahin: Artikel im
   Dashboard vorbereiten, manuell auf Vinted einstellen und über „Manuell erfasst…“ im Archiv verknüpfen.
   Sync, Verkaufserkennung, Sale-Sound, Archiv und Statistik funktionieren dann trotzdem.
3. **Anmeldung per Session-Token** (Cookie `access_token_web`) statt Passwort. Es wird nie ein Passwort
   gespeichert; das Token wird mit AES-256-GCM verschlüsselt und im API-Output nur maskiert angezeigt.
4. **Foto-Metadaten:** Beim Hochladen werden EXIF-Daten (GPS-Standort, Kameradaten) aus Datenschutzgründen
   entfernt, Bilder werden gedreht und auf max. 2048 px verkleinert. Das passiert deterministisch und immer
   gleich. Es gibt **keine** Funktion, die Bilder oder Metadaten beim Reupload absichtlich verändert, um
   Erkennung durch Vinted zu umgehen (siehe unten).
5. **Reupload** verwendet die im Archiv gespeicherten Fotos und die *aktuellen* Archiv-Texte. Titel,
   Beschreibung, Preis usw. lassen sich vorher bearbeiten oder per KI neu erstellen lassen („Mit KI ausfüllen“).
   Ein Artikel kann pro Account nur einmal gleichzeitig aktiv sein.
6. **KI-Modell:** `claude-opus-5` (per `ANTHROPIC_MODEL` änderbar), strukturierte Ausgabe per Zod-Schema.
   Die KI ist angewiesen, Unsicheres nicht zu erfinden und Punkte zur manuellen Prüfung zu nennen.
7. **SQLite** statt PostgreSQL für einfachen lokalen Betrieb; die Migrationen sind Standard-SQL.
8. **Sounds** werden per Web Audio API synthetisiert (keine Audiodateien, keine Lizenzfragen). Browser
   spielen Sound erst nach einer ersten Interaktion mit der Seite.
9. Accounts mit Listings können nur **getrennt**, nicht gelöscht werden; eingestellte Artikel nur archiviert
   (kein Datenverlust).

## Bewusst nicht umgesetzt

- **Automatisches Verändern von Beschreibung und Bild-Metadaten beim Reupload**, damit ein Listing nicht als
  Duplikat erkannt wird. Das dient dazu, die Erkennung der Plattform zu umgehen, und wurde deshalb nicht gebaut.
  Texte lassen sich jederzeit manuell oder per KI überarbeiten.
- Funktionen zum Melden anderer Accounts.

## Mobile App (später)

Das Backend ist eine eigenständige REST-API ohne Abhängigkeit vom Next.js-Frontend. Eine React-Native- oder
Flutter-App kann dieselben Endpunkte nutzen (Auth über Login-Cookie oder `API_TOKEN`, Live-Events über
`/api/events/stream`). Bis dahin lässt sich das Dashboard auf iOS über „Zum Home-Bildschirm“ wie eine App nutzen.
