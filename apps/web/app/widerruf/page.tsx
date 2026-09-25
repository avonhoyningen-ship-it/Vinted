import { Address, LegalPage } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata = { title: "Widerrufsbelehrung – Alex Sales Kit" };

/** Statutory model (Anlage 1 und 2 zu Art. 246a EGBGB) for a service contract. */
export default function Widerruf() {
  return (
    <LegalPage title="Widerrufsbelehrung">
      <p>Verbraucherinnen und Verbraucher haben ein vierzehntägiges Widerrufsrecht.</p>
      <h2>Widerrufsrecht</h2>
      <p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>
      <p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses.</p>
      <p>Um Ihr Widerrufsrecht auszuüben, müssen Sie uns</p>
      <Address />
      <p>
        E-Mail: {LEGAL.email}{LEGAL.phone && <>, Telefon: {LEGAL.phone}</>}<br />
        mittels einer eindeutigen Erklärung (z. B. eine E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren.
        Sie können dafür das unten stehende Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.
      </p>
      <p>Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.</p>
      <h2>Folgen des Widerrufs</h2>
      <p>
        Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, einschließlich der Lieferkosten
        (mit Ausnahme der zusätzlichen Kosten, die sich daraus ergeben, dass Sie eine andere Art der Lieferung als die von uns angebotene,
        günstigste Standardlieferung gewählt haben), unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die
        Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel,
        das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart;
        in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.
      </p>
      <p>
        Haben Sie verlangt, dass die Dienstleistungen während der Widerrufsfrist beginnen sollen, so haben Sie uns einen angemessenen Betrag
        zu zahlen, der dem Anteil der bis zu dem Zeitpunkt, zu dem Sie uns von der Ausübung des Widerrufsrechts hinsichtlich dieses Vertrags
        unterrichten, bereits erbrachten Dienstleistungen im Vergleich zum Gesamtumfang der im Vertrag vorgesehenen Dienstleistungen entspricht.
      </p>
      <h2>Muster-Widerrufsformular</h2>
      <p className="small muted">(Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses Formular aus und senden Sie es zurück.)</p>
      <div className="card">
        <p>An {LEGAL.name}, {LEGAL.street}, {LEGAL.city}, E-Mail: {LEGAL.email}:</p>
        <p>
          Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über die Erbringung der folgenden Dienstleistung (*):
          Abonnement „{LEGAL.product}“
        </p>
        <p>Bestellt am (*): ______________</p>
        <p>Name des/der Verbraucher(s): ______________</p>
        <p>Anschrift des/der Verbraucher(s): ______________</p>
        <p>Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier): ______________</p>
        <p>Datum: ______________</p>
        <p className="small muted">(*) Unzutreffendes streichen.</p>
      </div>
    </LegalPage>
  );
}
