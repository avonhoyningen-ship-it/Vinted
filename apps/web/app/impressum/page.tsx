import { Address, LegalPage } from "@/components/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata = { title: "Impressum – Alex Sales Kit" };

export default function Impressum() {
  return (
    <LegalPage title="Impressum">
      <h2>Angaben gemäß § 5 DDG</h2>
      <Address />
      <h2>Kontakt</h2>
      <p>
        E-Mail: {LEGAL.email}
        {LEGAL.phone && <><br />Telefon: {LEGAL.phone}</>}
      </p>
      {LEGAL.register && (<><h2>Registereintrag</h2><p>{LEGAL.register}</p></>)}
      <h2>Umsatzsteuer</h2>
      <p>
        {LEGAL.vatId
          ? <>Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: {LEGAL.vatId}</>
          : <>Kleinunternehmer im Sinne von § 19 UStG – es wird keine Umsatzsteuer ausgewiesen.</>}
      </p>
      <h2>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV</h2>
      <p>{LEGAL.representative ?? LEGAL.name}, Anschrift wie oben.</p>
      <h2>Verbraucherstreitbeilegung</h2>
      <p>Wir sind nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
      <h2>Hinweis zu Vinted</h2>
      <p>{LEGAL.product} ist ein unabhängiges Werkzeug für Verkäufer und steht in keiner Verbindung zu Vinted UAB. „Vinted“ ist eine Marke ihres Inhabers.</p>
    </LegalPage>
  );
}
