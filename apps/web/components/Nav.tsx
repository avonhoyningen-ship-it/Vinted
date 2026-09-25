"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton } from "@clerk/nextjs";
import { api } from "@/lib/api";
import { CLOUD } from "@/lib/mode";
import { useApi } from "@/lib/useApi";

const LINKS = [
  { href: "/dashboard", label: "Übersicht", icon: "◧" },
  { href: "/accounts", label: "Accounts", icon: "👤" },
  { href: "/listings", label: "Listings", icon: "📤" },
  { href: "/archive", label: "Archiv", icon: "🗄" },
  { href: "/automations", label: "Automatisierungen", icon: "⚡" },
  { href: "/stats", label: "Statistik", icon: "📈" },
  { href: "/settings", label: "Einstellungen", icon: "⚙" },
  ...(CLOUD ? [{ href: "/abo", label: "Abo", icon: "💳" }] : []),
];

/** `locked`: cloud user without subscription – only "Abo" is usable. */
export function Nav({ locked = false }: { locked?: boolean }) {
  const path = usePathname();
  const { data: info } = useApi<{ aiEnabled: boolean }>("/info");
  const { data: me } = useApi<{ authRequired: boolean }>(CLOUD ? null : "/auth/me");
  const logout = () => api("/auth/logout", { method: "POST" }).then(() => { window.location.href = "/login"; });
  return (
    <nav className="sidebar">
      <div className="brand"><img src="/icon.svg" alt="" width={24} height={24} style={{ borderRadius: 6 }} /> Alex Sales Kit</div>
      {LINKS.map((l) => {
        const active = path.startsWith(l.href);
        if (locked && l.href !== "/abo") return <span key={l.href} className="nav-link disabled"><span aria-hidden>{l.icon}</span> {l.label}</span>;
        return (
          <Link key={l.href} href={l.href} className={`nav-link ${active ? "active" : ""}`}>
            <span aria-hidden>{l.icon}</span> {l.label}
          </Link>
        );
      })}
      <div className="sidebar-foot">
        {info ? (
          <>
            <span>KI: {info.aiEnabled ? "aktiv" : "kein API-Key"}</span>
          </>
        ) : (
          <span>API nicht erreichbar</span>
        )}
        {CLOUD && <div style={{ marginTop: 6 }}><UserButton /></div>}
        {CLOUD && (
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <Link href="/impressum">Impressum</Link><Link href="/datenschutz">Datenschutz</Link><Link href="/agb">AGB</Link><Link href="/kuendigen">Kündigen</Link>
          </div>
        )}
        {me?.authRequired && <button className="btn small" style={{ marginTop: 6 }} onClick={logout}>Abmelden</button>}
      </div>
    </nav>
  );
}
