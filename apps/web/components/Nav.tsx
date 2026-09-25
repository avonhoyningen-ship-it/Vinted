"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";

const LINKS = [
  { href: "/", label: "Übersicht", icon: "◧" },
  { href: "/accounts", label: "Accounts", icon: "👤" },
  { href: "/listings", label: "Listings", icon: "📤" },
  { href: "/archive", label: "Archiv", icon: "🗄" },
  { href: "/automations", label: "Automatisierungen", icon: "⚡" },
  { href: "/stats", label: "Statistik", icon: "📈" },
  { href: "/settings", label: "Einstellungen", icon: "⚙" },
];

export function Nav() {
  const path = usePathname();
  const { data: info } = useApi<{ aiEnabled: boolean }>("/info");
  const { data: me } = useApi<{ authRequired: boolean }>("/auth/me");
  const logout = () => api("/auth/logout", { method: "POST" }).then(() => { window.location.href = "/login"; });
  return (
    <nav className="sidebar">
      <div className="brand"><span className="brand-dot" /> Vinted Dashboard</div>
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
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
        {me?.authRequired && <button className="btn small" style={{ marginTop: 6 }} onClick={logout}>Abmelden</button>}
      </div>
    </nav>
  );
}
