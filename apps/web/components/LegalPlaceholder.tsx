import Link from "next/link";

/** Placeholder until the operator adds the legally required text (see DEPLOY-CLOUD.md checklist). */
export function LegalPlaceholder({ title }: { title: string }) {
  return (
    <div className="landing">
      <div className="landing-inner stack">
        <Link href="/">← Zurück</Link>
        <h1>{title}</h1>
        <div className="alert warn">
          Dieser Text fehlt noch. Vor dem Livegang muss der Betreiber hier den rechtlich nötigen Inhalt eintragen
          (apps/web/app/{title.toLowerCase().replace(/[^a-z]/g, "")}/page.tsx).
        </div>
      </div>
    </div>
  );
}
