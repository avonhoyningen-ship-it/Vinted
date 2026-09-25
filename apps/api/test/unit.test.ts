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
    expect(reducedPrice(2500, 10, null)).toBe(2250);
    expect(reducedPrice(1999, 15, null)).toBe(1690);
    expect(reducedPrice(1000, 50, 800)).toBe(800);
    expect(reducedPrice(150, 50, null)).toBe(100);
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
  it("reads measurements", () => {
    expect(parseMeasurements("Breite 43 Länge 65")).toEqual({ width: 43, length: 65 });
    expect(parseMeasurements("Laenge 70 Breite 55")).toEqual({ width: 55, length: 70 });
    expect(parseMeasurements("Sakura T-Shirt Gr. M 43x65")).toEqual({ width: 43, length: 65 });
    expect(parseMeasurements("L68 B52")).toEqual({ width: 52, length: 68 });
    expect(parseMeasurements(null)).toEqual({ width: null, length: null });
  });
});
