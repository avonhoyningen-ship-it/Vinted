"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";

function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", json: { password } });
      const next = params.get("next");
      // Full navigation so every page starts with the fresh session cookie.
      window.location.href = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card stack login-card" onSubmit={submit}>
      <h1 className="row" style={{ fontSize: 18 }}><img src="/icon.svg" alt="" width={28} height={28} style={{ borderRadius: 7 }} /> Alex Sales Kit</h1>
      <label className="field">Passwort
        <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="alert bad">{error}</div>}
      <button className="btn primary" disabled={!password || busy} style={{ justifyContent: "center" }}>{busy ? "Anmelden…" : "Anmelden"}</button>
    </form>
  );
}

export default function LoginPage() {
  return <div className="login-wrap"><Suspense><LoginForm /></Suspense></div>;
}
