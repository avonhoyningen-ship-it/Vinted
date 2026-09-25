"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { AssistBanner } from "./AssistBanner";
import { Nav } from "./Nav";
import { SaleNotifier } from "./SaleNotifier";

/** Shows the login page when required, otherwise the dashboard shell. */
export function AuthGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [state, setState] = useState<"checking" | "in" | "out">("checking");

  useEffect(() => {
    let cancelled = false;
    setState("checking");
    api<{ authRequired: boolean; authenticated: boolean }>("/auth/me")
      .then((me) => !cancelled && setState(!me.authRequired || me.authenticated ? "in" : "out"))
      .catch(() => !cancelled && setState("in")); // API down: pages show their own error
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    if (state === "out" && path !== "/login") router.replace(`/login?next=${encodeURIComponent(path)}`);
    if (state === "in" && path === "/login") router.replace("/");
  }, [state, path, router]);

  if (path === "/login") return <>{children}</>;
  if (state !== "in") return null;
  return (
    <>
      <div className="shell">
        <Nav />
        <main className="main"><AssistBanner />{children}</main>
      </div>
      <SaleNotifier />
    </>
  );
}
