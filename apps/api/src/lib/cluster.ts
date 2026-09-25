import crypto from "node:crypto";
import { getDriver } from "../db/index.js";

/**
 * Messages between several running API instances via Postgres LISTEN/NOTIFY
 * (live events, helper job wake-ups). With SQLite (one process) nothing is sent.
 */
const INSTANCE = crypto.randomUUID();
const MAX_PAYLOAD = 7900; // Postgres NOTIFY limit is 8000 bytes

type Handler = (data: unknown) => void;
const handlers = new Map<string, Handler[]>();
const subscribed = new Set<string>();

export async function broadcast(channel: string, data: unknown) {
  const pubsub = getDriver().pubsub;
  if (!pubsub) return;
  const payload = JSON.stringify({ from: INSTANCE, data });
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
    console.warn(`[cluster] Nachricht auf ${channel} zu groß (${Buffer.byteLength(payload)} B) – nur lokal`);
    return;
  }
  await pubsub.publish(channel, payload).catch((e) => console.warn(`[cluster] ${channel}:`, (e as Error).message));
}

/** Handles messages from other instances (own messages are ignored – they were handled locally). */
export function onBroadcast(channel: string, handler: Handler) {
  handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
}

/** Starts listening (call after the database driver is set). */
export async function startCluster() {
  const pubsub = getDriver().pubsub;
  if (!pubsub) return;
  for (const channel of handlers.keys()) {
    if (subscribed.has(channel)) continue;
    subscribed.add(channel);
    await pubsub.subscribe(channel, (payload) => {
      try {
        const msg = JSON.parse(payload) as { from: string; data: unknown };
        if (msg.from === INSTANCE) return;
        for (const h of handlers.get(channel) ?? []) h(msg.data);
      } catch {
        /* ignore malformed */
      }
    });
  }
}

/** Tests: forget subscriptions (new driver). */
export function resetCluster() {
  subscribed.clear();
}
