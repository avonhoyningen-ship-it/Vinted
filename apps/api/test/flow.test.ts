import sharp from "sharp";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db } from "../src/db/index.js";
import { runDueActions } from "../src/modules/automations/engine.js";
import { processDueQueue } from "../src/modules/listings/queue.js";
import { mockInject, mockSentMessages } from "./support/mockAdapter.js";

const app = createApp();

/** Injects a fake Vinted event and syncs the account (like the poller would). */
async function simulate(accountId: number, type: "sale" | "favourite" | "message", text?: string) {
  const acc = db.prepare("SELECT vinted_user_id FROM accounts WHERE id = ?").get(accountId) as { vinted_user_id: string };
  mockInject(acc.vinted_user_id, type, { text });
  return request(app).post(`/api/accounts/${accountId}/sync`);
}
let accountA: number;
let accountB: number;
let userA: string;

async function jpegWithExif() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 50, b: 50 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam", Model: "SecretModel", Copyright: "private" } })
    .toBuffer();
}

describe("end-to-end (mock mode)", () => {
  beforeAll(async () => {
    const a = await request(app).post("/api/accounts").send({ name: "Shop DE", domain: "vinted.de", sessionToken: "token-account-a" });
    expect(a.status).toBe(201);
    expect(a.body.error).toBeNull();
    accountA = a.body.account.id;
    userA = a.body.account.vinted_user_id;
    const b = await request(app).post("/api/accounts").send({ name: "Shop AT", domain: "vinted.at", sessionToken: "token-account-b" });
    accountB = b.body.account.id;
  });

  it("never exposes the session token and stores it encrypted", async () => {
    const res = await request(app).get("/api/accounts");
    expect(JSON.stringify(res.body)).not.toContain("token-account-a");
    expect(res.body[0].has_session).toBe(true);
    const row = db.prepare("SELECT session_encrypted FROM accounts WHERE id = ?").get(accountA) as { session_encrypted: string };
    expect(row.session_encrypted.startsWith("v1:")).toBe(true);
  });

  it("imports existing Vinted listings into the archive on first sync", async () => {
    const res = await request(app).get("/api/archive").query({ accountId: accountA });
    expect(res.body.total).toBe(3);
    expect(res.body.items.every((i: { status: string }) => i.status === "active")).toBe(true);
  });

  it("rejects an invalid session", async () => {
    const res = await request(app).post("/api/accounts").send({ name: "Bad", domain: "vinted.de", sessionToken: "invalid-token" });
    expect(res.body.account.status).toBe("error");
    expect(res.body.error).toMatch(/ungültig/);
  });

  it("runs a favourite → message rule with placeholders and per-user limit", async () => {
    const rule = await request(app).post("/api/automations/rules").send({
      name: "Danke fürs Merken", triggerType: "item_favourited", actionType: "send_message",
      actionConfig: { message: "Danke fürs Merken, {nutzer}! {artikelname} kostet {preis} 😊" }, delayMinutes: 0, perUserLimit: 1,
    });
    expect(rule.status).toBe(201);

    const sim = await simulate(accountA, "favourite");
    expect(sim.status).toBe(200);
    expect(sim.body.result.newFavourites).toBe(1);
    await runDueActions();
    const sent = mockSentMessages(userA);
    expect(sent.length).toBe(1);
    expect(sent[0]!.text).toMatch(/^Danke fürs Merken, .+! .+ kostet \d+,\d\d\s€/);

    // Same user favouriting again → skipped by the frequency limit.
    const fav = db.prepare("SELECT vinted_user_id FROM vinted_events WHERE type = 'favourite' LIMIT 1").get() as { vinted_user_id: string };
    const { ingestEvent } = await import("../src/modules/automations/engine.js");
    ingestEvent({ accountId: accountA, type: "favourite", externalId: "dup-1", listingId: null, userId: fav.vinted_user_id, username: "x", payload: {}, occurredAt: new Date().toISOString() });
    const skipped = db.prepare("SELECT COUNT(*) c FROM scheduled_actions WHERE status = 'skipped'").get() as { c: number };
    expect(skipped.c).toBe(1);
  });

  it("answers FAQ messages only when keywords match", async () => {
    await request(app).post("/api/automations/rules").send({
      name: "Maße", triggerType: "message_received", triggerConfig: { keywords: ["maße"] }, actionType: "send_message",
      actionConfig: { message: "Die Maße stehen in der Beschreibung von {artikelname}." },
    });
    await simulate(accountA, "message", "Ist das noch da?");
    await simulate(accountA, "message", "Wie sind die Maße?");
    const actions = db.prepare("SELECT COUNT(*) c FROM scheduled_actions s JOIN automation_rules r ON r.id = s.rule_id WHERE r.name = 'Maße'").get() as { c: number };
    expect(actions.c).toBe(1);
  });

  it("detects sales, archives them and feeds stats", async () => {
    const sim = await simulate(accountA, "sale");
    expect(sim.body.result.newSales).toBe(1);
    const stats = await request(app).get("/api/stats/overview").query({ accountId: accountA });
    expect(stats.body.salesCount).toBe(1);
    expect(stats.body.revenueCents).toBeGreaterThan(0);
    expect(stats.body.activeListings).toBe(2);
    const sold = await request(app).get("/api/archive").query({ status: "sold" });
    expect(sold.body.total).toBe(1);
    const top = await request(app).get("/api/stats/top").query({ by: "brand" });
    expect(top.body[0].count).toBe(1);
  });

  it("re-uploads a sold item to another account with its photos and history", async () => {
    const sold = (await request(app).get("/api/archive").query({ status: "sold" })).body.items[0];
    const photo = await request(app).post(`/api/archive/${sold.id}/photos`).attach("photos", await jpegWithExif(), "p.jpg");
    expect(photo.status).toBe(201);
    await request(app).patch(`/api/archive/${sold.id}`).send({ description: "Neu formuliert vor Reupload", price_cents: 3000 });

    const q = await request(app).post(`/api/archive/${sold.id}/reupload`).send({ accountId: accountB });
    expect(q.status).toBe(201);
    const dup = await request(app).post(`/api/archive/${sold.id}/reupload`).send({ accountId: accountB });
    expect(dup.status).toBe(409);

    expect(await processDueQueue()).toBe(1);
    const detail = await request(app).get(`/api/archive/${sold.id}`);
    expect(detail.body.item.status).toBe("relisted");
    expect(detail.body.summary.timesListed).toBe(2);
    expect(detail.body.summary.timesSold).toBe(1);
    expect(detail.body.listings[0].description).toBe("Neu formuliert vor Reupload");
    expect(detail.body.listings[0].price_cents).toBe(3000);
  });

  it("downloads all photos of an item as a valid ZIP", async () => {
    const d = (await request(app).post("/api/listings/drafts").attach("photos", await jpegWithExif(), "z.jpg")).body.item;
    const res = await request(app).get(`/api/archive/${d.id}/photos.zip`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const zip = res.body as Buffer;
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/vinted-test.zip", zip);
    const { execSync } = await import("node:child_process");
    expect(execSync("unzip -t /tmp/vinted-test.zip").toString()).toMatch(/No errors detected/);
  });

  it("strips photo metadata (EXIF) on upload", async () => {
    const res = await request(app).post("/api/listings/drafts").attach("photos", await jpegWithExif(), "x.jpg");
    expect(res.status).toBe(201);
    const file = res.body.photos[0].file_name;
    const img = await request(app).get(`/api/photos/${file}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const meta = await sharp(img.body as Buffer).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("queues drafts spaced by the interval", async () => {
    const d1 = (await request(app).post("/api/listings/drafts").attach("photos", await jpegWithExif(), "a.jpg").field("data", JSON.stringify({ title: "A", price_cents: 1000 }))).body.item;
    const other = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#00f" } }).jpeg().toBuffer();
    const d2 = (await request(app).post("/api/listings/drafts").attach("photos", other, "b.jpg").field("data", JSON.stringify({ title: "B", price_cents: 1200 }))).body.item;
    const res = await request(app).post("/api/listings/queue").send({ itemIds: [d1.id, d2.id], accountId: accountA, intervalMinutes: 30 });
    expect(res.status).toBe(201);
    const gap = Date.parse(res.body[1].scheduled_at) - Date.parse(res.body[0].scheduled_at);
    expect(gap).toBe(30 * 60_000);
  });

  it("links a listing that was posted manually on Vinted", async () => {
    const d = (await request(app).post("/api/listings/drafts").attach("photos", await sharp({ create: { width: 30, height: 30, channels: 3, background: "#0f0" } }).jpeg().toBuffer(), "m.jpg")
      .field("data", JSON.stringify({ title: "Manuell", price_cents: 1500 }))).body.item;
    const res = await request(app).post(`/api/archive/${d.id}/listings`).send({ accountId: accountB, url: "https://www.vinted.at/items/987654-manuell" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ vinted_item_id: "987654", price_cents: 1500, status: "active" });
    expect((await request(app).get(`/api/archive/${d.id}`)).body.item.status).toBe("active");
  });

  it("protects listed items and accounts from deletion", async () => {
    const item = (await request(app).get("/api/archive").query({ accountId: accountA })).body.items[0];
    expect((await request(app).delete(`/api/archive/${item.id}`)).status).toBe(409);
    expect((await request(app).delete(`/api/accounts/${accountA}`)).status).toBe(409);
  });

  it("drops stale listing prices via rule", async () => {
    db.prepare("UPDATE listings SET listed_at = '2020-01-01T00:00:00.000Z' WHERE account_id = ? AND status = 'active'").run(accountA);
    const rule = await request(app).post("/api/automations/rules").send({
      name: "Preis -10%", triggerType: "listing_stale", triggerConfig: { days: 14 }, actionType: "reduce_price",
      actionConfig: { percent: 10, minPriceCents: 500 },
    });
    expect(rule.status).toBe(201);
    const { scheduleStaleListingActions } = await import("../src/modules/automations/engine.js");
    expect(scheduleStaleListingActions()).toBe(2);
    expect(scheduleStaleListingActions()).toBe(0);
    await runDueActions();
    const changes = db.prepare("SELECT COUNT(*) c FROM listing_price_changes").get() as { c: number };
    expect(changes.c).toBeGreaterThanOrEqual(2);
  });

  it("parks drafts under 'Später', adds photos and marks them uploaded by hand", async () => {
    const jpg = (c: string) => sharp({ create: { width: 30, height: 30, channels: 3, background: c } }).jpeg().toBuffer();
    const d = (await request(app).post("/api/listings/drafts").attach("photos", await jpg("#f0f"), "a.jpg")
      .field("data", JSON.stringify({ title: "Später-Shirt", price_cents: 1800 }))).body.item;
    const ids = async (path: string) => (await request(app).get(path)).body.map((x: { id?: number; item_id?: number }) => x.item_id ?? x.id);

    expect((await request(app).post("/api/listings/later").send({ itemIds: [d.id], later: true })).status).toBe(200);
    expect(await ids("/api/listings/drafts")).not.toContain(d.id);
    expect(await ids("/api/listings/later")).toContain(d.id);

    const add = await request(app).post(`/api/archive/${d.id}/photos`).attach("photos", await jpg("#0ff"), "b.jpg").attach("photos", await jpg("#ff0"), "c.jpg");
    expect(add.status).toBe(201);
    expect((await request(app).get(`/api/archive/${d.id}`)).body.photos).toHaveLength(3);

    expect((await request(app).post(`/api/archive/${d.id}/listings`).send({ accountId: accountA })).status).toBe(201);
    expect(await ids("/api/listings/later")).not.toContain(d.id);
    expect(await ids("/api/listings/drafts")).not.toContain(d.id);
    expect(await ids("/api/listings/uploaded")).toContain(d.id);
  });
});
