# Alex Sales Kit als SaaS (Cloud-Version)

Diese Anleitung bringt das Dashboard als öffentliche Web-App mit Nutzerkonten und Monats-Abo online.
Die **lokale Version bleibt unverändert** nutzbar (`Dashboard starten.bat`). Beide laufen aus demselben Code, der Schalter ist `APP_MODE=cloud`.

## 1. Aufbau

```
Browser ──► Vercel (Next.js-Web-App, Landingpage, Clerk-Login, /abo)
              │  /api/* wird an Railway weitergeleitet (gleiche Domain → Cookies, Fotos, Live-Meldungen)
              ▼
            Railway (API + Automatisierungen, läuft dauerhaft)
              ├── Supabase Postgres  – alle Daten, jede Zeile mit user_id, Row Level Security
              ├── Supabase Storage   – Fotos, privater Bucket, ein Ordner pro Nutzer
              ├── Clerk              – Registrierung, Login, Passwort-Reset, Sitzungen
              ├── Stripe             – Abo (Karte + PayPal), Kundenportal, Webhooks
              └── PC-Helfer ◄──────── läuft beim Kunden, holt Aufträge ab (nur ausgehende Verbindung)
                                       spricht von dort mit Vinted und füllt das Formular im Vinted-Chrome aus
```

**Warum ein PC-Helfer?** Vinted blockt Anfragen aus Rechenzentren (Railway) nach wenigen Aufrufen mit einer Bot-Prüfung, und ein Server kommt nicht an das Chrome der Kunden heran. Der Helfer macht alles, was Vinted betrifft, vom PC des Kunden aus. Die Vinted-Anmeldung liest er aus dem Vinted-Chrome und speichert sie **nur auf dem PC** (verschlüsselt in `%USERPROFILE%\.ask-helper`), nie in der Cloud.

| Funktion | läuft in der Cloud | braucht den PC-Helfer |
|---|---|---|
| Registrierung, Login, Abo | ✓ | |
| Fotos hochladen, KI-Inserate, Entwürfe, Preise lernen, Archiv, Statistik | ✓ | |
| Accounts abgleichen, Verkaufs-/Favoriten-/Nachrichten-Meldungen | | ✓ |
| Automatisierungen (Nachrichten senden, Preis senken) | Planung | Ausführung ✓ |
| Einstell-Assistent (Formular im Vinted-Chrome ausfüllen) | | ✓ |

## 2. Analyse: was lokal war (und wie es jetzt gelöst ist)

| Stelle | lokal | Cloud |
|---|---|---|
| Datenbank | SQLite-Datei `data/vinted.db`, 14 Tabellen ohne `user_id` | Supabase Postgres, jede Tabelle mit `user_id` (automatisch gesetzt) und RLS (`apps/api/src/db/pgSchema.ts`, `supabase/schema.sql`) |
| Datenbankzugriff | 162 synchrone SQLite-Abfragen | asynchrone Schnittstelle für beide Datenbanken (`apps/api/src/db/index.ts`), jede Anfrage läuft im Kontext ihres Nutzers |
| Fotos | Ordner `data/uploads/photos` | Supabase Storage, `<user_id>/<datei>.jpg`, Anzeige über kurzlebige signierte Links |
| Zugang | ein `DASHBOARD_PASSWORD` für alle | Clerk-Konten; ohne aktives Abo antwortet die API mit 402 |
| Einstellungen (KI-Prompt, Marken-/Paketregeln …) | eine Tabelle für alle | pro Nutzer (`settings` mit `(user_id, key)`) |
| Hintergrundjobs | alle Accounts | pro zahlendem Nutzer nacheinander, jeweils in dessen Datenbank-Kontext |
| Live-Meldungen (Verkauf, Assistent) | an alle offenen Fenster | nur an die Fenster des jeweiligen Nutzers |
| Vinted-Zugriff, Einstell-Assistent | direkt vom PC | über den PC-Helfer des Kunden |
| KI | ein Anthropic-Schlüssel | weiterhin einer (deiner) – die KI-Kosten aller Kunden zahlst du, im Abo-Preis einplanen |

## 3. Einrichtung Schritt für Schritt

Plane etwa 1–2 Stunden ein. Zuerst alles im **Testmodus** (Stripe `sk_test_…`, Clerk Development), erst am Ende live schalten.

### A. Supabase (Datenbank + Fotos)
1. Auf [supabase.com](https://supabase.com) ein Projekt anlegen, Region **Frankfurt (eu-central-1)**. Das Datenbank-Passwort notieren.
2. **Project Settings → Database → Connection string → „Session pooler“** kopieren → `DATABASE_URL` (Passwort einsetzen).
3. **Project Settings → Database → SSL Configuration → Download certificate** → Inhalt der Datei → `DATABASE_CA_CERT`.
4. **Project Settings → API**: „Project URL“ → `SUPABASE_URL`, „service_role“-Key → `SUPABASE_SERVICE_ROLE_KEY` (geheim, nur auf Railway eintragen).
5. Das Schema legt die API beim ersten Start selbst an. Alternativ `supabase/schema.sql` im SQL-Editor ausführen.

### B. Clerk (Konten)
1. Auf [clerk.com](https://clerk.com) eine Application anlegen, Anmeldung mit **E-Mail + Passwort** (Passwort-Reset ist automatisch dabei), optional Google.
2. **Configure → API keys**: „Publishable key“ → `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (Vercel), „Secret key“ → `CLERK_SECRET_KEY` (Vercel **und** Railway).
3. Für den Livebetrieb: in Clerk eine **Production instance** anlegen, deine Domain eintragen und die DNS-Einträge setzen, die Clerk anzeigt. Danach die `pk_live_…`/`sk_live_…`-Schlüssel verwenden.

### C. Railway (API)
1. Auf [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → dieses Repository. Railway nutzt automatisch `railway.json` → `Dockerfile.railway`.
2. **Variables** eintragen (Erklärung in `.env.example`):
   `APP_MODE=cloud`, `APP_URL`, `TRUST_PROXY=true`, `ENCRYPTION_KEY` (z. B. mit `openssl rand -base64 32`), `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`.
   Für die Stripe-Werte zuerst Schritt D ausführen.
3. **Settings → Networking → Generate Domain** (oder eigene Domain `api.deine-domain.de`). Diese Adresse ist die „API-Adresse“.
4. Optional für E-Mails (Kündigungsbestätigung): `RESEND_API_KEY`, `MAIL_FROM`, `OPERATOR_EMAIL` ([resend.com](https://resend.com), Domain dort verifizieren).
5. Mehrere Instanzen sind möglich (Railway → Settings → Replicas): Live-Meldungen und PC-Helfer-Aufträge laufen über Postgres LISTEN/NOTIFY, die Hintergrundjobs laufen per Sperre nur auf einer Instanz. Dafür den **Session pooler** von Supabase verwenden (nicht den Transaction pooler auf Port 6543).
6. Test: `https://<api-adresse>/api/health` zeigt `{"ok":true}`.

### D. Stripe (Abo, Karte + PayPal)
1. Konto auf [stripe.com](https://stripe.com) anlegen, oben rechts **Testmodus** an.
2. **Einstellungen → Zahlungsmethoden → PayPal aktivieren** (für Abos in der EU verfügbar; sonst lehnt der Checkout PayPal ab. Zur Not `STRIPE_PAYMENT_METHODS=card` setzen).
3. Produkt, Monatspreis, Webhook und Kundenportal anlegen – mit einem Befehl:
   ```bash
   STRIPE_SECRET_KEY=sk_test_… npm run stripe:setup -w apps/api -- --api https://<api-adresse> --app https://<app-adresse> --amount 9.99
   ```
   Der Befehl gibt `STRIPE_PRICE_ID` und `STRIPE_WEBHOOK_SECRET` aus → in Railway eintragen. Der Preis (9,99 €) ist ein Platzhalter. Einen anderen Betrag später mit `--amount` erneut anlegen und die neue `STRIPE_PRICE_ID` eintragen.
   Webhook-Ereignisse: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`.

### E. Vercel (Web-App)
1. Auf [vercel.com](https://vercel.com): **Add New → Project** → dieses Repository, **Root Directory: `apps/web`**, Framework Next.js.
2. **Environment Variables**: `NEXT_PUBLIC_APP_MODE=cloud`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up`, `API_INTERNAL_URL=https://<api-adresse>`, `NEXT_PUBLIC_DIRECT_API_URL=https://<api-adresse>`, `NEXT_PUBLIC_PRICE_LABEL=9,99 € / Monat`,
   deine Betreiberangaben `NEXT_PUBLIC_LEGAL_NAME`, `…_STREET`, `…_CITY`, `…_EMAIL` (optional `…_PHONE`, `…_VAT_ID`, `…_REPRESENTATIVE`, `…_REGISTER`) und nach Schritt H `NEXT_PUBLIC_HELPER_DOWNLOAD_URL`.
   `API_INTERNAL_URL` und alle `NEXT_PUBLIC_…`-Werte werden beim Build eingebaut. Nach einer Änderung neu deployen.
3. Deploy. Die Landingpage erscheint unter der Vercel-Adresse.

### F. Domain verbinden
- Web-App: in Vercel **Settings → Domains** z. B. `app.deine-domain.de` (oder die Hauptdomain) hinzufügen und den angezeigten DNS-Eintrag bei deinem Domain-Anbieter setzen.
- API: in Railway `api.deine-domain.de` hinzufügen, CNAME wie angezeigt setzen.
- Danach `APP_URL` (Railway) und `API_INTERNAL_URL`/`NEXT_PUBLIC_DIRECT_API_URL` (Vercel) auf die neuen Adressen umstellen, `stripe:setup` mit der neuen API-Adresse erneut ausführen (neuer Webhook) und in Clerk die Domain eintragen.

### G. Deine bisherigen Daten übernehmen (optional)
1. In der Cloud-Version registrieren. Deine Clerk-Nutzer-ID findest du in Clerk unter **Users** (`user_…`).
2. Auf deinem PC im Ordner `Vinted` in `.env` `DATABASE_URL`, `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` ergänzen, dann:
   ```bash
   npm run migrate:cloud -w apps/api -- --user user_…
   ```
   Artikel, Fotos, Listings, Verkäufe, Regeln, Vorlagen, Preise und Einstellungen werden übertragen. Vinted-Logins werden absichtlich **nicht** übertragen: die Accounts danach im Dashboard mit dem PC-Helfer verbinden.

### H. PC-Helfer für Kunden (Download ohne Node.js)
1. Einmal das Download-Paket bauen und hochladen (auf deinem PC im Ordner `Vinted`, `SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` in `.env`):
   ```bash
   npm run helper:package -- --api https://<api-adresse> --upload
   ```
   Das erzeugt `dist/ask-helper-windows.zip` (≈ 37 MB: Node.js für Windows, der Helfer, Chrome-Startdatei, Anleitung, die API-Adresse ist schon eingetragen) und gibt den Link für `NEXT_PUBLIC_HELPER_DOWNLOAD_URL` aus. Nach Updates des Helfers erneut ausführen.
2. Kunde: Dashboard → **Accounts → PC-Helfer herunterladen**, ZIP entpacken, **„Chrome fuer Vinted starten.bat“** öffnen und bei Vinted einloggen, **„PC-Helfer starten.cmd“** doppelklicken, Schlüssel eingeben (**Neuen Schlüssel erzeugen**).
3. Im Dashboard auf der Account-Karte **„Mit PC-Helfer verbinden“** klicken.
4. **Mehrere Vinted-Accounts:** Im Account-Formular pro weiterem Account einen eigenen **Chrome-Port** eintragen (9223, 9224 …). Auf der Account-Karte gibt es dann „Chrome für diesen Account“ – eine Startdatei für ein eigenes Chrome-Profil. So bleiben alle Accounts gleichzeitig eingeloggt.

## 4. Checkliste: was du selbst erledigen musst

- [ ] Konten anlegen: Supabase, Clerk, Stripe, Railway, Vercel (alle haben kostenlose Einstiegsstufen)
- [ ] Supabase-Projekt in Frankfurt, `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` notieren
- [ ] Clerk-App anlegen, Schlüssel notieren
- [ ] Railway-Projekt aus dem Repository, alle Variablen eintragen, Domain erzeugen
- [ ] Stripe: PayPal aktivieren, `npm run stripe:setup …` ausführen, `STRIPE_PRICE_ID` + `STRIPE_WEBHOOK_SECRET` in Railway eintragen
- [ ] Vercel-Projekt mit Root Directory `apps/web`, Variablen eintragen, deployen
- [ ] Den ganzen Ablauf im Testmodus durchklicken (Abschnitt 5)
- [ ] **Betreiberangaben** in Vercel eintragen (`NEXT_PUBLIC_LEGAL_*`) – bis dahin zeigen Impressum, Datenschutz, AGB und Widerruf einen roten Hinweis.
- [ ] **Rechtstexte prüfen lassen:** Impressum, Datenschutzerklärung, AGB, Widerrufsbelehrung und „Verträge hier kündigen“ sind fertig eingebaut (`apps/web/app/…`), aber von mir geschrieben, nicht von einer Anwältin oder einem Anwalt. Vor dem Start von einer Fachperson oder einem Rechtstext-Dienst (z. B. IT-Recht Kanzlei, Händlerbund, eRecht24) prüfen lassen. Wer die AGB ändert, erhöht `LEGAL.version` in `apps/web/lib/legal.ts` (wird mit jeder Zustimmung gespeichert).
- [ ] E-Mail-Versand einrichten (Resend), damit Kündigungen per E-Mail bestätigt werden (§ 312k BGB verlangt eine Bestätigung in Textform).
- [ ] PC-Helfer-Paket bauen und hochladen (Abschnitt H). Tipp: Mit einem Code-Signing-Zertifikat signiert, zeigt Windows beim ersten Start keine SmartScreen-Warnung.
- [ ] Auftragsverarbeitungsverträge (AVV/DPA) mit den Anbietern abschließen (meist im jeweiligen Dashboard)
- [ ] Preis festlegen: Produkt in Stripe (Live) mit echtem Betrag anlegen, `NEXT_PUBLIC_PRICE_LABEL` anpassen
- [ ] **Stripe live schalten**: Konto verifizieren, `stripe:setup` mit `sk_live_…` erneut ausführen, Live-Schlüssel/Preis/Webhook-Secret in Railway eintragen
- [ ] Clerk Production instance + Domain, Live-Schlüssel in Vercel/Railway
- [ ] Domain verbinden (Abschnitt F)
- [ ] Bedenken: Ein kostenpflichtiges Tool, das Vinted-Konten automatisiert, verstößt sehr wahrscheinlich gegen Vinteds Nutzungsbedingungen. Kunden riskieren Kontosperren. Kläre das vor dem Start und weise Kunden darauf hin.

## 5. Test: einmal alles durchklicken (Testmodus)

1. **Registrierung:** Landingpage öffnen → „Jetzt registrieren“ → mit E-Mail registrieren → du landest auf **/abo** („Kein Abo“). Andere Menüpunkte sind gesperrt, `/dashboard` leitet auf `/abo` um.
2. **Abo abschließen:** Die beiden Häkchen (AGB/Datenschutz, sofortiger Leistungsbeginn) setzen – vorher ist der Knopf gesperrt – → „Abo abschließen“ → Stripe-Checkout (Karte und PayPal werden angeboten).
   - Testkarte `4242 4242 4242 4242`, beliebiges künftiges Ablaufdatum, beliebige Prüfnummer, beliebige PLZ.
   - PayPal im Testmodus: PayPal wählen → auf der Stripe-Testseite „Authorize“.
   Zurück auf `/abo?status=success`, Status **Aktiv** (nach 1–2 Sekunden, ggf. „Aktualisieren“).
3. **Zugriff aufs Dashboard:** Menü ist frei, Übersicht lädt. Einen Artikel mit Fotos anlegen – Fotos erscheinen, ZIP-Download funktioniert.
4. **PC-Helfer:** Accounts → Schlüssel erzeugen → „PC-Helfer starten.bat“ → Status „verbunden“. Account anlegen → „Mit PC-Helfer verbinden“ (vorher im Vinted-Chrome einloggen).
5. **Zweiter Nutzer:** in einem privaten Fenster ein zweites Konto registrieren → sieht keine Artikel, Fotos oder Accounts des ersten.
6. **Kündigung:** `/abo` → „Abo verwalten / kündigen“ → im Kundenportal kündigen. Standard: Zugang bis zum Ende des bezahlten Zeitraums („Zugang bis …“).
   Um die Sperre sofort zu testen: im Stripe-Dashboard (Testmodus) → Kunden → Abo → **Abo sofort kündigen**.
7. **Zugriff gesperrt:** Seite neu laden → Status „Gekündigt / abgelaufen“, alle Menüpunkte außer „Abo“ gesperrt, die API antwortet mit 402. Der PC-Helfer meldet „Kein aktives Abo“. Die Daten bleiben erhalten; ein neues Abo schaltet alles wieder frei.
8. **Kündigungsbutton:** ohne Anmeldung `/kuendigen` öffnen → „Verträge hier kündigen“ → Name + E-Mail → „Jetzt kündigen“. Bestätigung mit Eingangszeit erscheint, E-Mail kommt an (mit Resend), in Stripe steht das Abo auf „kündigt zum Periodenende“.
9. **Meine Daten:** `/abo` → „Alle Daten herunterladen“ (ZIP mit JSON und Fotos). Mit einem Testkonto „Konto endgültig löschen“ → Abo sofort beendet, Daten, Fotos und Clerk-Login weg.
10. **Zahlung fehlgeschlagen** (optional): im Stripe-Dashboard eine Rechnung mit Testkarte `4000 0000 0000 0341` scheitern lassen → Status „Zahlung offen“, Zugang bleibt, bis Stripe das Abo beendet.

Automatische Tests (ohne echte Konten, mit nachgebautem Stripe/Clerk/Vinted und echtem Postgres in PGlite):
```bash
npm test                       # alles mit der lokalen SQLite-Datenbank
npm run test:postgres -w apps/api   # dieselben Tests gegen Postgres (PGlite im Speicher) mit Row Level Security
TEST_PG_URL=postgres://user:pass@host/db npm run test:pgserver -w apps/api   # gegen einen echten Postgres-Server
```
`test/cloud.test.ts` spielt Schritte 1–9 automatisch durch, `test/helper.test.ts` den PC-Helfer, `test/tenancy.test.ts` die Trennung der Nutzer, `test/cluster.test.ts` zwei API-Instanzen.

## 6. Grenzen

- **Vinted-Nutzungsbedingungen:** Ein kostenpflichtiges Tool, das Vinted-Konten automatisiert, verstößt sehr wahrscheinlich dagegen. Die AGB schließen deine Haftung für Sperren durch Vinted ein Stück weit aus, das Risiko für dich und deine Kunden bleibt aber.
- **Rechtstexte** sind ein sorgfältiger Entwurf, keine Rechtsberatung – vor dem Start prüfen lassen (Checkliste).
- **KI-Kosten** laufen über deinen Anthropic-Schlüssel; plane sie im Abo-Preis ein.
- **Kündigung per E-Mail-Bestätigung** braucht Resend (oder einen anderen Versand); ohne wird die Kündigung trotzdem gespeichert und in Stripe ausgeführt, aber nicht per E-Mail bestätigt.
- **PC-Helfer** gibt es als Windows-Paket; für macOS müsste ein eigenes Paket gebaut werden (der Helfer selbst läuft dort mit `npm run helper -w apps/api`).
