import Link from "next/link";
import { LegalLinks } from "@/components/LegalPage";
import { PRICE_LABEL } from "@/lib/mode";

const FEATURES = [
  { icon: "📁", title: "Ordner rein, Inserate raus", text: "Ganzen Foto-Ordner hochladen – die KI ordnet die Fotos den Artikeln zu, dreht sie richtig herum und schreibt Titel, Beschreibung und Hashtags in deinem Stil." },
  { icon: "💶", title: "Preise, die mitlernen", text: "Aus deinen Preisen und Verkäufen lernt das Tool, was ähnliche Teile bei dir kosten – mit Regeln wie „Graphic Tee = 24 €“." },
  { icon: "🧾", title: "Einstell-Assistent", text: "Füllt das Vinted-Formular in deinem eigenen Chrome aus: Fotos, Kategorie, Marke, Größe, Zustand, Maße, Paketgröße. Den Klick auf „Hochladen“ machst du." },
  { icon: "👥", title: "Mehrere Accounts", text: "Alle deine Vinted-Accounts in einem Dashboard – Archiv, Wiedereinstellen und Statistik über alle Accounts." },
  { icon: "🔔", title: "Verkaufs-Sound", text: "Verkauf, Favorit oder Nachricht? Du bekommst es sofort mit – mit Sound und Konfetti." },
  { icon: "📈", title: "Statistik", text: "Umsatz, Gewinn, Tage bis zum Verkauf und deine Top-Marken auf einen Blick." },
];

/** Public start page of the cloud version. */
export function Landing() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="brand"><img src="/icon.svg" alt="" width={28} height={28} style={{ borderRadius: 7 }} /> Alex Sales Kit</div>
        <div className="spacer" />
        <Link className="btn ghost" href="/sign-in">Anmelden</Link>
        <Link className="btn primary" href="/sign-up">Jetzt registrieren</Link>
      </header>

      <section className="landing-hero">
        <h1>Dein Verkaufs-Cockpit für Vinted</h1>
        <p className="muted">
          Fotos hochladen, Inserate von der KI schreiben lassen, Preise lernen lassen und alle Accounts im Blick behalten –
          damit du mehr Zeit fürs Einkaufen hast.
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <Link className="btn primary big" href="/sign-up">Jetzt registrieren</Link>
          <a className="btn big" href="#preis">Preis ansehen</a>
        </div>
      </section>

      <section className="landing-features">
        {FEATURES.map((f) => (
          <div key={f.title} className="card stack" style={{ gap: 6 }}>
            <div style={{ fontSize: 26 }} aria-hidden>{f.icon}</div>
            <h3 style={{ margin: 0 }}>{f.title}</h3>
            <p className="muted" style={{ margin: 0 }}>{f.text}</p>
          </div>
        ))}
      </section>

      <section className="landing-steps">
        <h2>So funktioniert’s</h2>
        <ol>
          <li><strong>Registrieren</strong> und das Abo abschließen – mit Karte oder PayPal, monatlich kündbar.</li>
          <li><strong>PC-Helfer installieren:</strong> Er verbindet deinen Chrome und deine Vinted-Accounts mit dem Dashboard. Deine Vinted-Anmeldung bleibt auf deinem PC.</li>
          <li><strong>Loslegen:</strong> Fotos hochladen, Entwürfe prüfen, im Chrome hochladen – den Rest erledigt das Dashboard.</li>
        </ol>
      </section>

      <section className="landing-price" id="preis">
        <div className="card stack price-card">
          <h2 style={{ margin: 0 }}>Alex Sales Kit</h2>
          <div className="price">{PRICE_LABEL}</div>
          <ul>
            <li>Alle Funktionen, beliebig viele eigene Vinted-Accounts</li>
            <li>KI-Inserate aus deinen Fotos</li>
            <li>Bezahlen mit Karte oder PayPal</li>
            <li>Monatlich kündbar – im Kundenportal mit einem Klick</li>
          </ul>
          <Link className="btn primary big" href="/sign-up" style={{ justifyContent: "center" }}>Jetzt registrieren</Link>
        </div>
      </section>

      <footer className="landing-foot">
        <LegalLinks />
        <p className="small muted">Alex Sales Kit ist ein unabhängiges Werkzeug und steht in keiner Verbindung zu Vinted.</p>
      </footer>
    </div>
  );
}
