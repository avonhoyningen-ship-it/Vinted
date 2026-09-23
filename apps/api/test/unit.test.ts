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
