import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { keywords, roundPrice, similarity } from "../src/modules/pricing/engine.js";

const app = createApp();

async function draft(title: string, extra: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/archive").send({ title, ...extra });
  expect(res.status).toBe(201);
  return res.body.id as number;
}
const item = async (id: number) => (await request(app).get(`/api/archive/${id}`)).body.item;

describe("price learning", () => {
  it("helpers: keywords, similarity, rounding", () => {
    expect([...keywords("Hysteric Glamour Girl Print T-Shirt Y2K Vintage")]).toEqual(["hysteric", "glamour", "girl", "print"]);
    const a = { title: "Carhartt Detroit Jacket braun", brand: "Carhartt", category: "Herren > Jacken", size: "L", condition: "good" };
    const b = { title: "Carhartt Detroit Jacket schwarz", brand: "Carhartt", category: "Herren > Jacken", size: "M", condition: "good" };
    const c = { title: "Zara Bluse", brand: "Zara", category: "Damen > Blusen", size: "S", condition: "good" };
    expect(similarity(a, b)).toBeGreaterThan(similarity(a, c));
    expect(roundPrice(3549)).toBe(3500);
    expect(roundPrice(740)).toBe(750);
  });

  it("learns from bulk prices and suggests them for similar items; ✓ accepts", async () => {
    const shirts = [
      await draft("Hysteric Glamour Girl Print Tee", { brand: "Hysteric Glamour", category: "Herren > T-Shirts" }),
      await draft("Hysteric Glamour Skull Tee", { brand: "Hysteric Glamour", category: "Herren > T-Shirts" }),
    ];
    const bulk = await request(app).post("/api/pricing/bulk").send({ itemIds: shirts, priceCents: 4500 });
    expect(bulk.status).toBe(200);
    expect((await item(shirts[0]!))).toMatchObject({ price_cents: 4500, price_confirmed: 1 });

    const next = await draft("Hysteric Glamour Band Tee", { brand: "Hysteric Glamour", category: "Herren > T-Shirts" });
    const fresh = await item(next);
    expect(fresh.price_suggested_cents).toBe(4500);
    expect(fresh.price_suggestion_reason).toMatch(/Wie 2 ähnliche Artikel/);
    expect(fresh.price_cents).toBeNull();

    const acc = await request(app).post("/api/pricing/accept").send({ itemIds: [next] });
    expect(acc.body.accepted).toBe(1);
    expect(await item(next)).toMatchObject({ price_cents: 4500, price_confirmed: 1 });
    const examples = (await request(app).get("/api/pricing/examples")).body;
    expect(examples.filter((e: { brand: string }) => e.brand === "Hysteric Glamour")).toHaveLength(3);
  });

  it("rules win over learned prices and are applied to open suggestions", async () => {
    const id = await draft("Hysteric Glamour Hoodie", { brand: "Hysteric Glamour", category: "Herren > Pullover" });
    const rule = await request(app).post("/api/pricing/rules").send({ brand: "Hysteric Glamour", keyword: "hoodie", price_cents: 8000 });
    expect(rule.status).toBe(201);
    const it1 = await item(id);
    expect(it1.price_suggested_cents).toBe(8000);
    expect(it1.price_suggestion_reason).toMatch(/Deine Regel: Marke „Hysteric Glamour“ \+ Stichwort „hoodie“/);
    expect((await request(app).post("/api/pricing/rules").send({ price_cents: 1000 })).status).toBe(400);
  });

  it("a manual price edit is learned too", async () => {
    const id = await draft("Stüssy Fleece Jacket", { brand: "Stüssy" });
    await request(app).patch(`/api/archive/${id}`).send({ price_cents: 6000 });
    expect(await item(id)).toMatchObject({ price_cents: 6000, price_confirmed: 1 });
    const other = await draft("Stüssy Fleece Jacket grün", { brand: "Stüssy" });
    expect((await item(other)).price_suggested_cents).toBe(6000);
  });
});
