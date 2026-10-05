import { describe, expect, it } from "vitest";
import { decrypt, encrypt, maskSecret } from "../src/lib/crypto.js";
import { renderTemplate } from "../src/lib/placeholders.js";
import { RateLimiter } from "../src/lib/rateLimiter.js";
import { matchesKeywords, reducedPrice } from "../src/modules/automations/engine.js";
import { normalizeCondition } from "../src/modules/accounts/sync.js";

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("secret-token-123");
    const b = encrypt("secret-token-123");
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret");
    expect(decrypt(a)).toBe("secret-token-123");
  });
  it("rejects tampered ciphertext", () => {
    const parts = encrypt("hello").split(":");
    parts[3] = Buffer.from("jello").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
  it("masks secrets", () => {
    expect(maskSecret("abcdefgh")).toBe("••••efgh");
  });
});

describe("templates", () => {
  it("replaces known placeholders case-insensitively and keeps unknown ones", () => {
    expect(renderTemplate("Danke {nutzer}! {ARTIKELNAME} für {preis} {foo}", { nutzer: "lena", artikelname: "Jeans", preis: "12,00 €" }))
      .toBe("Danke lena! Jeans für 12,00 € {foo}");
  });
});

describe("automation helpers", () => {
  it("reduces price, rounds down to 10 cents and respects the floor", () => {
    // Even whole euros, always below the old price.
    expect(reducedPrice(2400, 10, null)).toBe(2200);
    expect(reducedPrice(3500, 10, null)).toBe(3200);
    expect(reducedPrice(1900, 10, null)).toBe(1800);
    expect(reducedPrice(2500, 10, null)).toBe(2200);
    expect(reducedPrice(1000, 10, null)).toBe(800); // 9 € would round up to 10 €
    expect(reducedPrice(1999, 15, null)).toBe(1600);
    expect(reducedPrice(1000, 50, 800)).toBe(800);
    expect(reducedPrice(150, 50, null)).toBe(200); // not below 2 € (the caller skips it: not cheaper)
  });
  it("matches keywords", () => {
    expect(matchesKeywords("Wie sind die MAßE?", ["maße", "länge"])).toBe(true);
    expect(matchesKeywords("Hallo", ["maße"])).toBe(false);
    expect(matchesKeywords("egal", [])).toBe(true);
  });
  it("normalises condition labels", () => {
    expect(normalizeCondition("Sehr gut")).toBe("very_good");
    expect(normalizeCondition("good")).toBe("good");
    expect(normalizeCondition("???")).toBeNull();
  });
});

describe("rate limiter", () => {
  it("enforces a minimum gap per key", async () => {
    const waits: number[] = [];
    const rl = new RateLimiter(1000, 0, async (ms) => { waits.push(ms); });
    await Promise.all([rl.schedule("a", async () => 1), rl.schedule("a", async () => 2), rl.schedule("b", async () => 3)]);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(900);
  });
});

describe("brand rules and measurements", async () => {
  const { parseBrandRules, ruleBrand, parseMeasurements } = await import("../src/modules/listings/brandRules.js");
  it("applies 'T-Shirt=Graphic Tee' to T-shirts only", () => {
    const rules = parseBrandRules("T-Shirt=Graphic Tee\n# Kommentar\nHoodie = Vintage Hoodie");
    expect(ruleBrand({ title: "Sakura Cherry Blossom T-Shirt weiß", category: null }, rules)).toBe("Graphic Tee");
    expect(ruleBrand({ title: "Print Tee", category: "Herren > Kleidung > T-Shirts > Bedruckte T-Shirts" }, rules)).toBe("Graphic Tee");
    expect(ruleBrand({ title: "Nike Hoodie", category: null }, rules)).toBe("Vintage Hoodie");
    expect(ruleBrand({ title: "Levi's Jeans", category: "Hosen" }, rules)).toBeNull();
  });
  it("matches alternatives, plurals and hashtags as whole words", () => {
    const rules = parseBrandRules("T-Shirt, Tee, Shirt=Graphic Tee");
    expect(ruleBrand({ title: "Sakura Anime Tee weiß M", category: null }, rules)).toBe("Graphic Tee");
    expect(ruleBrand({ title: "Japan Print Oberteil", category: null, description: "Schön\n#tshirt #japancore" }, rules)).toBe("Graphic Tee");
    expect(ruleBrand({ title: "Oversized Shirt", category: null }, rules)).toBe("Graphic Tee");
    expect(ruleBrand({ title: "Nike Sweatshirt grau", category: "Pullover" }, rules)).toBeNull();
    expect(ruleBrand({ title: "Teddy Jacke", category: null }, rules)).toBeNull();
  });
  it("picks the parcel size: pullovers medium, T-shirts small", async () => {
    const { parseRules, ruleParcel } = await import("../src/modules/listings/brandRules.js");
    const { DEFAULT_SETTINGS } = await import("../src/lib/settings.js");
    const rules = parseRules(DEFAULT_SETTINGS["parcel.rules"]);
    expect(ruleParcel({ title: "Sakura Tee weiß", category: "Herren > Kleidung > T-Shirts > Bedruckte T-Shirts" }, rules)).toBe("Klein");
    expect(ruleParcel({ title: "Vintage Hoodie", category: null }, rules)).toBe("Mittel");
    expect(ruleParcel({ title: "Nike Sweatshirt grau", category: null }, rules)).toBe("Mittel");
    expect(ruleParcel({ title: "Levi's Jeans", category: "Hosen" }, rules)).toBeNull();
  });
  it("reads measurements", () => {
    expect(parseMeasurements("Breite 43 Länge 65")).toEqual({ width: 43, length: 65 });
    expect(parseMeasurements("Laenge 70 Breite 55")).toEqual({ width: 55, length: 70 });
    expect(parseMeasurements("Sakura T-Shirt Gr. M 43x65")).toEqual({ width: 43, length: 65 });
    expect(parseMeasurements("L68 B52")).toEqual({ width: 52, length: 68 });
    expect(parseMeasurements(null)).toEqual({ width: null, length: null });
  });
});

describe("sales analysis", async () => {
  const { diagnose, insights } = await import("../src/modules/analysis/diagnose.js");
  const { parsePrice } = await import("../src/modules/reprice/chromePrice.js");
  const now = Date.parse("2026-10-01T12:00:00Z");
  const base = {
    title: "Graphic Tee Anime weiß M", description: "- 🌸 Print vorne\n- 📏 Breite 52 cm, Länge 70 cm\n- Zustand sehr gut, keine Flecken, nur zweimal getragen\n- Versand am nächsten Werktag #tee",
    priceCents: 2400, views: 300, favourites: 20, listedAt: "2026-09-20T12:00:00Z", lastPriceDropAt: null, photoCount: 6,
    brand: "Graphic Tee", size: "M", category: "Herren > T-Shirts", condition: "very_good", measurements: "Breite 52 Länge 70", marketCents: 2400,
  };
  const codes = (f: Partial<typeof base>) => diagnose({ ...base, ...f }, now).issues.map((i) => i.code);

  it("finds nothing wrong with a healthy listing", () => {
    const d = diagnose({ ...base, views: 60, favourites: 2 }, now);
    expect(d.issues).toEqual([]);
    expect(d.score).toBe(100);
    expect(d.viewsPerDay).toBeCloseTo(60 / 11, 1);
  });
  it("names the typical reasons", () => {
    expect(codes({ views: 10 })).toContain("low_views");
    expect(codes({ views: 400, favourites: 2 })).toContain("low_interest");
    expect(codes({ favourites: 5 })).toContain("no_conversion");
    expect(codes({ priceCents: 3500 })).toContain("overpriced");
    expect(codes({ photoCount: 2 })).toContain("few_photos");
    expect(codes({ description: "kurz #tee #anime" })).toContain("short_description");
    expect(codes({ brand: null, size: null })).toContain("missing_info");
    expect(codes({ listedAt: "2026-08-01T00:00:00Z" })).toContain("stale");
    expect(codes({ title: "Weißes Shirt" })).toContain("brand_not_in_title");
    expect(codes({ listedAt: "2026-10-01T00:00:00Z", views: 0 })).toEqual(["new"]);
  });
  it("ranks the worst first and lowers the score", () => {
    const d = diagnose({ ...base, views: 10, photoCount: 2, priceCents: 4000 }, now);
    expect(d.issues[0]!.severity).toBe("high");
    expect(d.score).toBeLessThanOrEqual(25);
  });
  it("derives insights from the history", () => {
    const row = (category: string, status: string, priceCents = 2000) => ({ status, listedAt: "2026-09-01T00:00:00Z", soldAt: status === "sold" ? "2026-09-08T00:00:00Z" : null, priceCents, category, brand: null });
    const rows = [
      ...["sold", "sold", "sold", "active"].map((s) => row("Herren > T-Shirts", s, 1500)),
      ...["active", "active", "active", "sold"].map((s) => row("Herren > Hosen", s, 4000)),
    ];
    const texts = insights(rows).map((i) => i.text).join("\n");
    expect(texts).toMatch(/Beste Kategorie: T-Shirts – 75 %/);
    expect(texts).toMatch(/Schwächste Kategorie: Hosen – 25 %/);
    expect(texts).toMatch(/im Mittel 7 Tage online/);
  });
  it("reads prices from Vinted pages", () => {
    expect(parsePrice("24,50 €")).toBe(2450);
    expect(parsePrice("1.200,00 €")).toBe(120000);
    expect(parsePrice("€24.50")).toBe(2450);
    expect(parsePrice("19 €")).toBe(1900);
    expect(parsePrice("kein Preis")).toBeNull();
  });
});

describe("Vinted-Chrome autostart", () => {
  it("plans one Chrome per debug port with the account's profile and domain", async () => {
    const { chromeTargets } = await import("../src/modules/accounts/chromeLaunch.js");
    expect(chromeTargets([
      { name: "Haupt", domain: "vinted.de", chrome_port: null },
      { name: "Shop 2!", domain: "vinted.at", chrome_port: 9223 },
      { name: "Shop 3", domain: "vinted.fr", chrome_port: 9223 },
    ], "http://127.0.0.1:9222")).toEqual([
      { port: 9222, profile: "C:\\vinted-chrome", url: "https://www.vinted.de/", label: "Standard" },
      { port: 9223, profile: "C:\\vinted-chrome-Shop2", url: "https://www.vinted.at/", label: "Shop 2!" },
    ]);
    // Only own-port accounts: no default Chrome needed. No accounts yet: the default one (to log in).
    expect(chromeTargets([{ name: "A", domain: "vinted.de", chrome_port: 9300 }], "http://127.0.0.1:9222").map((t) => t.port)).toEqual([9300]);
    expect(chromeTargets([], "http://127.0.0.1:9222").map((t) => t.port)).toEqual([9222]);
  });
});

describe("AI sales kit parsing", () => {
  it("maps condition and parcel size leniently instead of failing the item", async () => {
    const { parseSuggestion } = await import("../src/modules/listings/ai.js");
    const base = {
      title: "T", bullets: [], hashtags: [], category: "Herren", brand: null, size: null, color: null, material: null,
      suggested_price_eur: 20, price_reasoning: "", rotations: [], photo_order: [1], confidence_notes: "",
    };
    expect(parseSuggestion({ ...base, condition: "Sehr gut", parcel_size: "klein (Umschlag)" })).toMatchObject({ condition: "very_good", parcel_size: "Klein" });
    expect(parseSuggestion({ ...base, condition: "new_with_tags", parcel_size: "Groß" })).toMatchObject({ condition: "new_with_tags", parcel_size: "Groß" });
    expect(parseSuggestion({ ...base, condition: null, parcel_size: null })).toMatchObject({ condition: "very_good", parcel_size: "Mittel" });
  });
});
