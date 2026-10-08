import { HttpError } from "../../lib/http.js";
import { chromeUrlFor, getAccount } from "../accounts/repo.js";
import { endListing, getListing } from "../archive/repo.js";
import { startAssist } from "../assist/assistant.js";
import { deleteInChrome, type DeleteJob, type DeleteResult } from "./chromeDelete.js";

/**
 * Re-upload of an online listing: delete it on Vinted (in the Vinted-Chrome),
 * then the posting assistant prepares it again – the AI writes title and
 * description fresh, the seller clicks "Hochladen" as always.
 */
type Deleter = (job: DeleteJob) => Promise<DeleteResult>;
type Launcher = (itemIds: number[], accountId: number) => Promise<unknown>;
let deleter: Deleter = deleteInChrome;
let launcher: Launcher = startAssist;

/** Cloud: delete and assistant run on the PC helper (set at startup). Tests: fakes. */
export function setReuploadDeps(deps: { deleter?: Deleter; launcher?: Launcher }) {
  if (deps.deleter) deleter = deps.deleter;
  if (deps.launcher) launcher = deps.launcher;
}

export async function reuploadListing(listingId: number) {
  const listing = await getListing(listingId);
  if (listing.status !== "active") throw new HttpError(400, "Der Artikel ist nicht mehr online");
  if (!listing.vinted_item_id) throw new HttpError(400, "Keine Vinted-Artikelnummer – Re-Upload nicht möglich");
  const account = await getAccount(listing.account_id);
  const r = await deleter({ vintedItemId: listing.vinted_item_id, domain: account.domain, chromeUrl: chromeUrlFor(account) });
  if (!r.ok) throw new HttpError(502, `Löschen auf Vinted hat nicht geklappt: ${r.message}`);
  await endListing(listing.id, "removed");
  const assist = await launcher([listing.item_id], listing.account_id);
  return { deleted: r.message, itemId: listing.item_id, assist };
}
