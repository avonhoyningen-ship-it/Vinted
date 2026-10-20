import { db } from "../../db/index.js";
import { eventBus } from "../../lib/eventBus.js";
import { getItem } from "../archive/repo.js";

/**
 * One article, several platforms: as soon as it is sold on one of them it is taken
 * off all the others, so it can never be sold twice.
 */
export async function soldElsewhere(itemId: number, soldOn: "vinted" | "ebay") {
  const title = (await getItem(itemId).catch(() => null))?.title ?? "Artikel";
  if (soldOn !== "ebay") {
    const onEbay = await db.get("SELECT id FROM marketplace_listings WHERE item_id = ? AND platform = 'ebay' AND status = 'active'", [itemId]);
    if (onEbay) {
      const { endOnEbay } = await import("./ebay/service.js");
      try {
        await endOnEbay(itemId, "sold_elsewhere");
      } catch (e) {
        eventBus.publish({ type: "marketplace", platform: "eBay", itemId, title, state: "failed", url: null,
          message: `Auf Vinted verkauft, aber auf eBay nicht beendet: ${(e as Error).message} – bitte auf eBay selbst beenden!` });
      }
    }
  }
  if (soldOn !== "vinted") {
    const onVinted = await db.all<{ id: number }>("SELECT id FROM listings WHERE item_id = ? AND status = 'active' AND vinted_item_id IS NOT NULL", [itemId]);
    if (onVinted.length) {
      const { deleteOnVinted } = await import("../reupload/service.js");
      for (const l of onVinted) {
        const r = await deleteOnVinted(l.id).catch((e) => ({ ok: false, message: (e as Error).message }));
        eventBus.publish({ type: "marketplace", platform: "Vinted", itemId, title, state: r.ok ? "ended" : "failed", url: null,
          message: r.ok ? "Auf eBay verkauft – auf Vinted gelöscht" : `Auf eBay verkauft, aber auf Vinted nicht gelöscht: ${r.message} – bitte auf Vinted selbst löschen!` });
      }
    }
  }
}
