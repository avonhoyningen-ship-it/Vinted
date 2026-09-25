import Link from "next/link";
import { LegalPage } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata = { title: "AGB – Alex Sales Kit" };

export default function Agb() {
  return (
    <LegalPage title="Allgemeine Geschäftsbedingungen">
      <h2>§ 1 Geltungsbereich</h2>
      <p>
        Diese AGB gelten für alle Verträge über die Nutzung von „{LEGAL.product}“ (nachfolgend „Dienst“) zwischen {LEGAL.name} (nachfolgend
        „Anbieter“) und den Nutzerinnen und Nutzern (nachfolgend „Kunde“). Abweichende Bedingungen des Kunden gelten nicht.
        Verbraucher ist jede natürliche Person, die den Vertrag zu Zwecken abschließt, die überwiegend weder ihrer gewerblichen noch ihrer
        selbständigen beruflichen Tätigkeit zugerechnet werden können (§ 13 BGB); Unternehmer ist, wer in Ausübung einer solchen Tätigkeit handelt (§ 14 BGB).
      </p>

      <h2>§ 2 Leistungen</h2>
      <p>
        Der Dienst ist eine Web-Anwendung für Verkäufer auf Vinted. Sie umfasst insbesondere: Verwaltung von Artikeln und Fotos,
        KI-gestützte Vorschläge für Inseratstexte, Kategorien und Preise, Preis-Lernen, Archiv und Statistik sowie – über das Programm
        „PC-Helfer“ auf dem Computer des Kunden – den Abgleich eigener Vinted-Accounts, Automatisierungen und das Vorausfüllen des
        Vinted-Verkaufsformulars. Das Hochladen auf Vinted löst der Kunde selbst aus.
      </p>
      <p>
        KI-Vorschläge können fehlerhaft sein. Der Kunde prüft Texte, Kategorien, Marken, Größen und Preise vor der Veröffentlichung selbst
        und ist für seine Inserate verantwortlich.
      </p>
      <p>
        Der Anbieter stellt den Dienst mit angemessener Sorgfalt bereit, schuldet aber keine ununterbrochene Verfügbarkeit. Wartungen,
        Störungen bei Dienstleistern sowie Änderungen oder Sperren durch Vinted können einzelne Funktionen vorübergehend oder dauerhaft
        beeinträchtigen. Der Anbieter darf den Dienst weiterentwickeln, sofern der Kern der vereinbarten Leistung erhalten bleibt.
      </p>

      <h2>§ 3 Verhältnis zu Vinted, Pflichten des Kunden</h2>
      <p>
        Der Dienst ist ein unabhängiges Produkt und steht in keiner Verbindung zu Vinted. Der Kunde nutzt ihn ausschließlich für eigene
        Vinted-Accounts und ist selbst dafür verantwortlich, die Nutzungsbedingungen von Vinted einzuhalten. Vinted kann die Nutzung
        von Hilfsprogrammen einschränken und Accounts sperren. Der Anbieter übernimmt keine Gewähr dafür, dass Vinted die Nutzung des
        Dienstes erlaubt, und haftet nicht für Maßnahmen von Vinted gegen Accounts des Kunden, soweit diese nicht auf einer
        Pflichtverletzung des Anbieters beruhen.
      </p>
      <p>
        Der Kunde hält seine Zugangsdaten geheim, lädt nur Inhalte hoch, an denen er die nötigen Rechte hat, und nutzt Automatisierungen
        (z. B. Nachrichten an Interessenten) nicht für Belästigung oder Spam.
      </p>

      <h2>§ 4 Vertragsschluss, Konto</h2>
      <p>
        Der Vertrag über das Abo kommt zustande, wenn der Kunde nach der Registrierung im Bereich „Abo“ den Bestellvorgang bei unserem
        Zahlungsdienstleister Stripe mit der Schaltfläche „Abonnieren“ abschließt. Vorher kann der Kunde seine Eingaben jederzeit
        prüfen und korrigieren oder den Vorgang abbrechen. Vertragssprache ist Deutsch.
      </p>

      <h2>§ 5 Preise und Zahlung</h2>
      <p>
        Es gilt der bei der Bestellung angezeigte Monatspreis. Der Preis ist monatlich im Voraus fällig und wird über Stripe per Karte oder
        PayPal eingezogen. {LEGAL.vatId ? "Die Preise enthalten die gesetzliche Umsatzsteuer." : "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."}
        Schlägt eine Zahlung fehl, versucht Stripe den Einzug erneut; bleibt die Zahlung aus, endet der Zugang zu den Funktionen.
      </p>
      <p>
        Preisänderungen für laufende Abos teilt der Anbieter mindestens sechs Wochen vorher in Textform mit. Der Kunde kann bis zum
        Wirksamwerden kündigen; darauf wird in der Mitteilung hingewiesen.
      </p>

      <h2>§ 6 Laufzeit und Kündigung</h2>
      <p>
        Das Abo läuft jeweils einen Monat und verlängert sich automatisch um einen weiteren Monat, wenn es nicht gekündigt wird. Der Kunde
        kann jederzeit zum Ende des laufenden Monats kündigen – im Bereich „Abo“ über das Kundenportal, über die Schaltfläche
        <Link href="/kuendigen"> „Verträge hier kündigen“</Link> oder per E-Mail an {LEGAL.email}. Das Recht zur außerordentlichen Kündigung
        aus wichtigem Grund bleibt unberührt. Nach Vertragsende bleiben die Daten gespeichert, bis der Kunde sein Konto löscht
        (siehe Datenschutzerklärung).
      </p>

      <h2>§ 7 Widerrufsrecht</h2>
      <p>Verbrauchern steht ein Widerrufsrecht zu. Die Einzelheiten stehen in der <Link href="/widerruf">Widerrufsbelehrung</Link>.</p>

      <h2>§ 8 Haftung</h2>
      <p>
        Der Anbieter haftet unbeschränkt bei Vorsatz und grober Fahrlässigkeit, bei Verletzung von Leben, Körper oder Gesundheit sowie nach
        dem Produkthaftungsgesetz. Bei leichter Fahrlässigkeit haftet der Anbieter nur bei Verletzung einer wesentlichen Vertragspflicht
        (einer Pflicht, deren Erfüllung die ordnungsgemäße Durchführung des Vertrags erst ermöglicht und auf deren Einhaltung der Kunde
        regelmäßig vertrauen darf), begrenzt auf den vertragstypischen, vorhersehbaren Schaden. Im Übrigen ist die Haftung ausgeschlossen.
        Der Kunde sichert wichtige Daten (z. B. Fotos) auch selbst; der Dienst bietet dazu einen Export.
      </p>

      <h2>§ 9 Datenschutz</h2>
      <p>
        Es gilt die <Link href="/datenschutz">Datenschutzerklärung</Link>. Soweit der Kunde als Unternehmer personenbezogene Daten Dritter
        (z. B. Käufernamen, Nachrichten) mit dem Dienst verarbeitet, verarbeitet der Anbieter diese in seinem Auftrag; ein Vertrag zur
        Auftragsverarbeitung nach Art. 28 DSGVO wird auf Anfrage abgeschlossen.
      </p>

      <h2>§ 10 Änderungen dieser AGB</h2>
      <p>
        Änderungen, die den Kern der Leistungen oder den Preis nicht betreffen, teilt der Anbieter mindestens sechs Wochen vor Wirksamwerden
        in Textform mit. Widerspricht der Kunde nicht bis zum Wirksamwerden, gelten sie als angenommen; darauf wird in der Mitteilung
        hingewiesen. Bei Widerspruch kann jede Seite zum Wirksamwerden kündigen.
      </p>

      <h2>§ 11 Schlussbestimmungen</h2>
      <p>
        Es gilt deutsches Recht unter Ausschluss des UN-Kaufrechts. Bei Verbrauchern gilt diese Rechtswahl nur, soweit dadurch nicht
        zwingende Schutzvorschriften des Staates ihres gewöhnlichen Aufenthalts entzogen werden. Ist der Kunde Kaufmann, ist Gerichtsstand
        der Sitz des Anbieters. Sollten einzelne Bestimmungen unwirksam sein, bleibt der Vertrag im Übrigen wirksam.
      </p>
    </LegalPage>
  );
}
