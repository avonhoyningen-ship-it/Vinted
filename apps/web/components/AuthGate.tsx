"use client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { CLOUD } from "@/lib/mode";
import { AssistBanner } from "./AssistBanner";
import { Nav } from "./Nav";
import { SaleNotifier } from "./SaleNotifier";

/** Pages without the dashboard shell (cloud: public pages, Clerk; local: password login). */
const BARE = CLOUD ? [/^\/$/, /^\/sign-(in|up)/, /^\/(impressum|datenschutz|agb)$/] : [/^\/login$/];

/**
 * Local: shows the password login when required. Cloud: Clerk (proxy.ts) already
 * requires a login; here we send users without an active subscription to /abo.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const bare = BARE.some((r) => r.test(path));
  const [state, setState] = useState<"checking" | "in" | "out" | "unpaid">("checking");

  useEffect(() => {
    if (bare) return;
    let cancelled = false;
    setState("checking");
    type S = "in" | "out" | "unpaid";
    const check: Promise<S> = CLOUD
      ? api<{ active: boolean }>("/me").then((me): S => (me.active ? "in" : "unpaid"))
      : api<{ authRequired: boolean; authenticated: boolean }>("/auth/me").then((me): S => (!me.authRequired || me.authenticated ? "in" : "out"));
    check
      .then((s) => !cancelled && setState(s))
      .catch(() => !cancelled && setState("in")); // API down: pages show their own error
    return () => { cancelled = true; };
  }, [path, bare]);

  useEffect(() => {
    if (state === "out") router.replace(`/login?next=${encodeURIComponent(path)}`);
    if (state === "unpaid" && path !== "/abo") router.replace("/abo");
  }, [state, path, router]);

  if (bare) return <>{children}</>;
  if (state === "checking" || state === "out" || (state === "unpaid" && path !== "/abo")) return null;
  return (
    <>
      <div className="shell">
        <Nav locked={state === "unpaid"} />
        <main className="main">{state === "in" && <AssistBanner />}{children}</main>
      </div>
      {state === "in" && <SaleNotifier />}
    </>
  );
}
