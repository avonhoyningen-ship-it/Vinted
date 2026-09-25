import sharp from "sharp";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";

// Fake model: photos are coloured; a colour change = new article. Reads the colour
// from each image's first pixel, so the grouping logic is tested end-to-end.
const colourOf = async (b64: string) => {
  const { data } = await sharp(Buffer.from(b64, "base64")).raw().toBuffer({ resolveWithObject: true });
  return Math.round(data[0]! / 40);
};
const parse = vi.fn(async (req: { messages: { content: { type: string; source?: { data: string } }[] }[] }) => {
  const imgs = req.messages[0]!.content.filter((c) => c.type === "image");
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
    expect(parse).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("needs at least two photos", async () => {
    const res = await request(app).post("/api/listings/group-photos").attach("photos", await photo(1), "a.jpg");
    expect(res.status).toBe(400);
  });
});
