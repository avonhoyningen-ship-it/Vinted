import { EventEmitter } from "node:events";
import { currentUserId } from "../db/index.js";
import { broadcast, onBroadcast } from "./cluster.js";

export type DashboardEvent =
  | { type: "sale"; accountId: number; accountName: string; itemId: number | null; title: string; priceCents: number; currency: string; soldAt: string }
  | { type: "favourite"; accountId: number; title: string; user: string }
  | { type: "message"; accountId: number; user: string; preview: string }
  | { type: "published"; accountId: number; itemId: number; title: string }
  | { type: "queue_failed"; accountId: number; itemId: number; error: string }
  | { type: "account_status"; accountId: number; status: string; error?: string | null }
  | { type: "assist"; status: AssistStatus };

export interface AssistStatus {
  state: "idle" | "preparing" | "waiting" | "error";
  itemId: number | null;
  title: string | null;
  position: number;
  total: number;
  filled: string[];
  missing: string[];
  message: string | null;
  done: { itemId: number; title: string; url: string }[];
  /** Form fields seen on the page when something could not be filled (for troubleshooting). */
  fields: string[];
  /** One entry per selected item – each gets its own tab in the Vinted-Chrome. */
  tabs: AssistTab[];
}

export interface AssistTab {
  itemId: number;
  title: string;
  state: "queued" | "preparing" | "ready" | "done" | "skipped" | "error";
  filled: string[];
  missing: string[];
  message: string | null;
  url: string | null;
  fields: string[];
}

class Bus extends EventEmitter {
  /** Latest posting-assistant status per user (cloud: reported by the PC helper). */
  readonly lastAssist = new Map<string, AssistStatus>();

  /** Events belong to the user whose request/job raised them; the SSE stream only forwards the viewer's own. */
  publish(e: DashboardEvent) {
    const userId = currentUserId();
    this.emitLocal(e, userId);
    // Other API instances forward it to their open streams (assistant details stay local if too big).
    const slim = e.type === "assist" ? { ...e, status: { ...e.status, fields: [], tabs: e.status.tabs.map((t) => ({ ...t, fields: [] })) } } : e;
    void broadcast("ask_events", { e: slim, userId });
  }

  emitLocal(e: DashboardEvent, userId: string) {
    if (e.type === "assist") this.lastAssist.set(userId, e.status);
    this.emit("event", e, userId);
  }
}

/** Bus that feeds the SSE stream (/api/events/stream), shared across API instances. */
export const eventBus = new Bus();
eventBus.setMaxListeners(1000);
onBroadcast("ask_events", (d) => {
  const { e, userId } = d as { e: DashboardEvent; userId: string };
  eventBus.emitLocal(e, userId);
});
