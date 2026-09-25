import sharp from "sharp";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Fake model: photos are coloured; a colour change = new article. Reads the colour
// from each image's first pixel, so the grouping logic is tested end-to-end.
const colourOf = async (b64: string) => {
  const { data } = await sharp(Buffer.from(b64, "base64")).raw().toBuffer({ resolveWithObject: true });
  return Math.round(data[0]! / 40);
};
// Orientation requests: pick the variant whose top edge is darkest (test images are dark on top when upright).
const topBrightness = async (b64: string) => {
  const { data, info } = await sharp(Buffer.from(b64, "base64")).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let x = 0; x < info.width; x++) sum += data[x]!;
  return sum / info.width;
};
const parse = vi.fn(async (req: { system: string; messages: { content: { type: string; source?: { data: string } }[] }[] }) => {
  const imgs = req.messages[0]!.content.filter((c) => c.type === "image");
  if (req.system.includes("Ausrichtung")) {
    const photos = [];
    for (let k = 0; k < imgs.length / 4; k++) {
      const b = await Promise.all(imgs.slice(k * 4, k * 4 + 4).map((c) => topBrightness(c.source!.data)));
      photos.push({ photo: k + 1, upright: "ABCD"[b.indexOf(Math.min(...b))] });
    }
    return { stop_reason: "end_turn", parsed_output: { photos } };
  }
  const colours = await Promise.all(imgs.map((c) => colourOf(c.source!.data)));
  return {
    stop_reason: "end_turn",
    parsed_output: { decisions: colours.slice(1).map((c, i) => ({ photo: i + 2, new_item: c !== colours[i] })) },
  };
});
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { parse }; } }));

let app: import("express").Express;
beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  vi.resetModules();
  app = (await import("../src/app.js")).createApp();
});

// 23 articles × 3 photos = 69 photos → needs 3 overlapping windows of 30.
const pattern = Array.from({ length: 69 }, (_, i) => Math.floor(i / 3));
const photo = (article: number) =>
  sharp({ create: { width: 60, height: 80, channels: 3, background: { r: (article % 6) * 40, g: 120, b: 60 } } }).jpeg({ quality: 95 }).toBuffer();

describe("grouping a flat folder into articles", () => {
  it("splits ordered photos into consecutive groups across windows", async () => {
    let req = request(app).post("/api/listings/group-photos");
    for (const [i, a] of pattern.entries()) req = req.attach("photos", await photo(a), `IMG_${String(i).padStart(3, "0")}.jpg`);
    const res = await req;
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(23);
    expect(res.body.groups[0]).toEqual([0, 1, 2]);
    expect(res.body.groups[22]).toEqual([66, 67, 68]);
    expect(res.body.groups.flat()).toEqual(pattern.map((_, i) => i));
    expect(res.body.rotations).toHaveLength(69);
    const groupingCalls = parse.mock.calls.filter(([r]) => !(r as { system: string }).system.includes("Ausrichtung"));
    expect(groupingCalls).toHaveLength(3);
  }, 60_000);

  it("needs at least two photos", async () => {
    const res = await request(app).post("/api/listings/group-photos").attach("photos", await photo(1), "a.jpg");
    expect(res.status).toBe(400);
  });
});

describe("orientation", () => {
  // Upright test image: dark top half, white bottom half.
  const upright = () => sharp({ create: { width: 60, height: 80, channels: 3, background: "#fff" } })
    .composite([{ input: { create: { width: 60, height: 40, channels: 3, background: "#111" } }, top: 0, left: 0 }]).jpeg().toBuffer();

  it("finds the rotation that makes each photo upright", async () => {
    const { detectOrientations } = await import("../src/modules/listings/ai.js");
    const base = await upright();
    const upsideDown = await sharp(base).rotate(180).toBuffer();
    const sideways = await sharp(base).rotate(90).toBuffer(); // needs 270 to be upright again
    expect(await detectOrientations([base, upsideDown, sideways])).toEqual([0, 180, 270]);
  });
});
