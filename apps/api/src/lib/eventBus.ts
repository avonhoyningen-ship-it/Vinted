import { EventEmitter } from "node:events";

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
  publish(e: DashboardEvent) {
    this.emit("event", e);
  }
}

/** In-process bus that feeds the SSE stream (/api/events/stream). */
export const eventBus = new Bus();
eventBus.setMaxListeners(100);
