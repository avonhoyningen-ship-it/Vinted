import { Address, LegalPage } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata = { title: "Datenschutzerklärung – Alex Sales Kit" };

const PROVIDERS: [string, string, string][] = [
  ["Vercel Inc., San Francisco (USA)", "Hosting der Website und Web-App", "Seitenaufrufe, IP-Adresse, technische Protokolle"],
  ["Railway Corporation, San Francisco (USA)", "Betrieb der Server-Anwendung (API, Automatisierungen)", "alle Nutzungsdaten während der Verarbeitung, technische Protokolle"],
  ["Supabase Inc., Singapur/USA – Rechenzentrum Frankfurt am Main", "Datenbank und Foto-Speicher", "Konto-, Artikel-, Verkaufs- und Einstellungsdaten, Fotos"],
  ["Clerk Inc., San Francisco (USA)", "Registrierung, Anmeldung, Passwort-Zurücksetzen, Sitzungen", "E-Mail-Adresse, Passwort (nur als Hash bei Clerk), Anmeldezeitpunkte, IP-Adresse, Gerätedaten"],
  ["Stripe Payments Europe Ltd., Dublin (Irland)", "Abwicklung der Zahlungen und des Abos, Kundenportal, Rechnungen", "Name, E-Mail, Anschrift, Zahlungsdaten (bei Stripe), Zahlungs- und Abostatus"],
  ["PayPal (Europe) S.à r.l. et Cie, S.C.A., Luxemburg", "Zahlung per PayPal (nur wenn Sie PayPal wählen)", "Zahlungsdaten laut PayPal"],
  ["Anthropic PBC, San Francisco (USA)", "KI-Erstellung von Inseraten (Titel, Beschreibung, Fotos drehen/zuordnen)", "die dafür hochgeladenen Fotos, Maße und Hinweise"],
];

export default function Datenschutz() {
  return (
    <LegalPage title="Datenschutzerklärung">
      <h2>1. Verantwortlicher</h2>
      <Address />
      <p>E-Mail: {LEGAL.email}</p>

      <h2>2. Überblick</h2>
      <p>
        {LEGAL.product} ist ein Dashboard für Vinted-Verkäufer: Artikel und Fotos verwalten, Inserate mit KI erstellen, Preise lernen,
        mehrere eigene Vinted-Accounts im Blick behalten und Automatisierungen ausführen. Wir verarbeiten personenbezogene Daten nur, soweit
        das für diese Leistungen, die Abrechnung und den sicheren Betrieb nötig ist. Wir verwenden keine Werbe- oder Analyse-Tracker.
      </p>

      <h2>3. Welche Daten wir verarbeiten</h2>
      <ul>
        <li><strong>Konto:</strong> E-Mail-Adresse, Nutzer-ID, Anmeldezeitpunkte (Art. 6 Abs. 1 lit. b DSGVO – Vertrag).</li>
        <li><strong>Abo und Zahlung:</strong> Kunden- und Abo-Kennung bei Stripe, Abostatus, Laufzeitende, Zustimmung zu den AGB mit Zeitpunkt. Kartendaten und PayPal-Zugangsdaten erhalten wir nicht (Art. 6 Abs. 1 lit. b und c DSGVO – Vertrag, steuerliche Aufbewahrungspflichten).</li>
        <li><strong>Inhalte:</strong> Artikel, Fotos (beim Hochladen werden Standort- und Kamera-Metadaten entfernt), Texte, Preise, Regeln, Vorlagen und Einstellungen (Art. 6 Abs. 1 lit. b DSGVO).</li>
        <li><strong>Daten aus Ihren Vinted-Accounts:</strong> eigene Inserate, Verkäufe, Favoriten und Nachrichten einschließlich der Nutzernamen von Käuferinnen und Käufern, soweit Sie Ihre Accounts verbinden (Art. 6 Abs. 1 lit. b DSGVO; für die Daten Dritter Art. 6 Abs. 1 lit. f DSGVO – Ihr Interesse an der Verwaltung Ihrer Verkäufe).</li>
        <li><strong>Technische Daten:</strong> IP-Adresse, Zeitpunkt, aufgerufene Adresse und Fehlermeldungen in Server-Protokollen der Hosting-Anbieter, zur Sicherheit und Fehlersuche (Art. 6 Abs. 1 lit. f DSGVO). Protokolle werden von den Anbietern nach kurzer Zeit gelöscht.</li>
      </ul>

      <h2>4. PC-Helfer und Vinted-Anmeldung</h2>
      <p>
        Der optionale PC-Helfer läuft auf Ihrem eigenen Computer. Er liest die Vinted-Anmeldung aus dem von Ihnen genutzten Chrome-Profil und
        speichert sie verschlüsselt ausschließlich auf Ihrem Computer. Ihre Vinted-Anmeldedaten werden nicht an uns übertragen.
        Der Helfer ruft in unserem Auftrag Ihre Vinted-Daten ab (siehe Nr. 3) und überträgt die Ergebnisse an Ihr Konto.
      </p>

      <h2>5. Empfänger und Auftragsverarbeiter</h2>
      <p>Wir setzen folgende Dienstleister ein. Mit ihnen bestehen Verträge zur Auftragsverarbeitung (Art. 28 DSGVO) bzw. sie handeln bei der Zahlungsabwicklung teilweise als eigene Verantwortliche:</p>
      <div className="table-wrap">
        <table className="small">
          <thead><tr><th>Anbieter</th><th>Zweck</th><th>Daten</th></tr></thead>
          <tbody>{PROVIDERS.map(([a, b, c]) => <tr key={a}><td>{a}</td><td>{b}</td><td>{c}</td></tr>)}</tbody>
        </table>
      </div>
      <p>
        <strong>Übermittlung in Drittländer:</strong> Bei Anbietern mit Sitz in den USA erfolgt die Übermittlung auf Grundlage des
        EU-US Data Privacy Framework (Angemessenheitsbeschluss der EU-Kommission), soweit der Anbieter zertifiziert ist, und im Übrigen auf
        Grundlage der EU-Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO).
      </p>

      <h2>6. Cookies und lokale Speicherung</h2>
      <p>
        Wir verwenden nur technisch notwendige Cookies: Anmelde-Cookies von Clerk, damit Sie eingeloggt bleiben (§ 25 Abs. 2 Nr. 2 TDDDG).
        Im Browser werden außerdem Bedienungseinstellungen (z. B. Ton an/aus) lokal gespeichert. Es findet kein Tracking statt, daher ist
        kein Cookie-Banner erforderlich.
      </p>

      <h2>7. Speicherdauer</h2>
      <p>
        Ihre Daten speichern wir, solange Ihr Konto besteht. Nach Ablauf eines Abos bleiben die Daten erhalten, damit Sie sie bei einem neuen
        Abo weiter nutzen können – bis Sie Ihr Konto löschen. Beim Löschen des Kontos entfernen wir alle Inhalte, Fotos und Kontodaten sofort.
        Rechnungs- und Zahlungsbelege bewahrt Stripe für uns im Rahmen der gesetzlichen Fristen auf (bis zu 10 Jahre, § 147 AO, § 257 HGB).
      </p>

      <h2>8. Ihre Rechte</h2>
      <ul>
        <li>Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch (Art. 21 DSGVO).</li>
        <li>Selbst erledigen können Sie das unter <strong>„Abo“ → „Meine Daten“</strong>: alle Daten als Datei herunterladen oder das Konto mit allen Daten endgültig löschen.</li>
        <li>Beschwerde bei einer Datenschutz-Aufsichtsbehörde, insbesondere der für Ihren Wohnort oder unseren Sitz zuständigen (Art. 77 DSGVO).</li>
      </ul>
      <p>Für alle Anliegen genügt eine E-Mail an {LEGAL.email}.</p>

      <h2>9. Pflicht zur Bereitstellung</h2>
      <p>Ohne E-Mail-Adresse und Zahlungsdaten können wir kein Konto und kein Abo bereitstellen. Das Verbinden von Vinted-Accounts und die KI-Funktionen sind freiwillig.</p>

      <h2>10. Keine automatisierten Entscheidungen</h2>
      <p>Es findet keine automatisierte Entscheidungsfindung im Sinne von Art. 22 DSGVO statt. KI-Vorschläge (Texte, Preise) sind Vorschläge, die Sie prüfen und ändern können.</p>
    </LegalPage>
  );
}
