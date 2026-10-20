import { loadConfig } from "./client.js";
import { listOnEbay } from "./service.js";

/** After an article went online on Vinted: put it on eBay too, in the background (errors become live events). */
export async function autoListOnEbay(itemId: number) {
  try {
    const cfg = await loadConfig();
    if (!cfg?.refreshToken || cfg.autoList === false) return;
    await listOnEbay(itemId);
  } catch (e) {
    console.warn(`[ebay] Artikel ${itemId}:`, (e as Error).message);
  }
}
