"use client";
import confetti from "canvas-confetti";
import { useEffect, useRef } from "react";
import { api, eventStreamUrl, euro } from "@/lib/api";
import { playSound, type SoundPreset } from "@/lib/sounds";
import { useToast } from "./Toasts";

interface Settings {
  "sound.preset": SoundPreset;
  "sound.volume": number;
  "sound.enabled": boolean;
  "notifications.desktop": boolean;
  "notifications.confetti": boolean;
}

/** Subscribes to the API event stream; celebrates sales with sound, notification and confetti. */
export function SaleNotifier() {
  const toast = useToast();
  const settings = useRef<Settings | null>(null);

  useEffect(() => {
    const load = () => api<Settings>("/settings").then((s) => (settings.current = s)).catch(() => {});
    void load();
    window.addEventListener("settings-changed", load);

    const es = new EventSource(eventStreamUrl(), { withCredentials: true });
    es.addEventListener("sale", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      const s = settings.current;
      const text = `${e.title} – ${euro(e.priceCents, e.currency)}`;
      toast({ kind: "sale", text: <><strong>💰 Verkauft auf {e.accountName}!</strong><br />{text}</> });
      if (!s || s["sound.enabled"]) playSound(s?.["sound.preset"] ?? "cha-ching", s?.["sound.volume"] ?? 0.7);
      if (!s || s["notifications.confetti"]) {
        void confetti({ particleCount: 140, spread: 80, origin: { y: 0.7 }, disableForReducedMotion: true });
      }
      if ((!s || s["notifications.desktop"]) && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Verkauft auf ${e.accountName}!`, { body: text, tag: `sale-${e.soldAt}` });
      }
      window.dispatchEvent(new CustomEvent("dashboard-refresh"));
    });
    es.addEventListener("favourite", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      toast({ kind: "info", text: <>❤️ <strong>{e.user}</strong> hat „{e.title}“ favorisiert</> });
    });
    es.addEventListener("message", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      toast({ kind: "info", text: <>💬 <strong>{e.user}</strong>: {e.preview}</> });
    });
    es.addEventListener("published", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      toast({ kind: "info", text: <>📤 Veröffentlicht: {e.title}</> });
      window.dispatchEvent(new CustomEvent("dashboard-refresh"));
    });
    es.addEventListener("queue_failed", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      toast({ kind: "error", text: <>Veröffentlichung fehlgeschlagen: {e.error}</> });
    });
    es.addEventListener("account_status", (ev) => {
      const e = JSON.parse((ev as MessageEvent).data);
      if (e.status === "error") toast({ kind: "error", text: <>Account-Fehler: {e.error}</> });
    });
    return () => {
      es.close();
      window.removeEventListener("settings-changed", load);
    };
  }, [toast]);

  return null;
}
