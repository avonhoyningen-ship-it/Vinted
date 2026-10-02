import sharp from "sharp";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// Fake model answer: photo 1 lies on its side, photo 2 is upright.
vi.mock("../src/modules/listings/ai.js", async (orig) => {
  const real = await orig<typeof import("../src/modules/listings/ai.js")>();
  return {
    ...real,
    aiEnabled: () => true,
    // IMG_2 lies on its side, IMG_10 is upright.
    detectOrientations: vi.fn(async (imgs: Buffer[]) => imgs.map((_, i) => (i === 0 ? 90 : 0))),
    generateListing: vi.fn(async (_photos: unknown, opts: { measurements?: string | null; hints?: string }) => ({
      title: "Carhartt Detroit Jacket Y2K Vintage Archive Workwear Gr. L",
      bullets: ["- 🧥 Carhartt Detroit Jacket", `📏 Maße: ${opts.measurements}`, "- 📦 Ich versende fix – stell gerne Fragen", "- ⚖️ Privatverkauf – keine Garantie, Gewährleistung oder Rücknahme"],
      hashtags: ["#japanstyle", "Y2K", "#vintage", "#y2k", "#older brother core"],
      category: "Herren > Jacken", brand: "Carhartt", size: "L", condition: "very_good", color: "Braun", material: "Canvas",
      suggested_price_eur: 39, price_reasoning: "gefragt", confidence_notes: "",
      photo_order: [2, 1],
    })),
  };
});

const { createApp } = await import("../src/app.js");
const { generateListing } = await import("../src/modules/listings/ai.js");
const { measurementsFromFolder } = await import("../src/modules/listings/routes.js");
const app = createApp();

const landscapeWithGps = () => sharp({ create: { width: 80, height: 40, channels: 3, background: "#835" } })
  .jpeg().withExif({ IFD0: { Make: "Apple", Model: "iPhone 15" }, IFD3: { GPSLatitudeRef: "N" } }).toBuffer();
const portrait = () => sharp({ create: { width: 40, height: 80, channels: 3, background: "#358" } }).jpeg().toBuffer();

describe("folder upload with AI sales kit", () => {
  it("normalises the photo order from the model", async () => {
    const { normalizeOrder } = await import("../src/modules/listings/ai.js");
    expect(normalizeOrder([3, 1, 2], 3)).toEqual([2, 0, 1]);
    expect(normalizeOrder([2, 2, 9], 3)).toEqual([1, 0, 2]); // duplicates/unknown ignored, missing appended
  });

  it("reads measurements from folder names", () => {
    expect(measurementsFromFolder("Jacken/Laenge_70_Breite-55")).toBe("Laenge 70 Breite 55");
    expect(measurementsFromFolder("L 70cm x B 55cm")).toBe("L 70cm x B 55cm");
    expect(measurementsFromFolder("")).toBeNull();
  });

  it("creates a draft: measurements from folder, photos rotated upright, description + hashtags, no metadata", async () => {
    const res = await request(app).post("/api/listings/drafts")
      .attach("photos", await landscapeWithGps(), "IMG_2.jpg")
      .attach("photos", await portrait(), "IMG_10.jpg")
      .field("folder", "Laenge_70_Breite_55")
      .field("hints", "Zustand sehr gut, fällt größer aus")
      .field("ai", "true");
    expect(res.status).toBe(201);
    expect(res.body.aiError).toBeNull();

    const call = vi.mocked(generateListing).mock.calls[0]![1];
    expect(call).toMatchObject({ measurements: "Laenge 70 Breite 55", hints: "Zustand sehr gut, fällt größer aus" });
    expect(call.stylePrompt).toMatch(/Vinted-Reselling/);

    const item = res.body.item;
    expect(item).toMatchObject({ measurements: "Laenge 70 Breite 55", brand: "Carhartt", status: "draft", price_cents: null, price_confirmed: 0 });
    // No learned prices yet → the AI estimate becomes the suggestion (to be confirmed with ✓).
    expect(item.price_suggested_cents).toBe(3900);
    expect(item.price_suggestion_reason).toMatch(/KI-Schätzung/);
    expect(item.description).toContain("- 📏 Maße: Laenge 70 Breite 55");
    expect(item.description.split("\n").filter((l: string) => l.startsWith("- "))).toHaveLength(4);
    expect(item.description).toMatch(/#japanstyle #y2k #vintage #olderbrothercore$/);

    // Uploaded sorted by file name (IMG_2, IMG_10); the model put IMG_10 (outfit shot) first.
    const detail = await request(app).get(`/api/archive/${item.id}`);
    expect(detail.body.photos.map((p: { original_name: string }) => p.original_name)).toEqual(["IMG_10.jpg", "IMG_2.jpg"]);
    // IMG_2 was lying on its side: rotated from 80x40 to 40x80.
    const first = detail.body.photos[1];
    expect([first.width, first.height]).toEqual([40, 80]);
    const img = await request(app).get(`/api/photos/${first.file_name}`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const meta = await sharp(img.body as Buffer).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("imports without texts and writes them fresh at every upload – price and photos stay", async () => {
    vi.mocked(generateListing).mockClear();
    const res = await request(app).post("/api/listings/drafts")
      .attach("photos", await landscapeWithGps(), "A_1.jpg")
      .attach("photos", await portrait(), "A_2.jpg")
      .field("folder", "50 breit 67 lang")
      .field("hints", "Größe: M. Kleiner Fleck am Ärmel")
      .field("orient", "true");
    expect(res.status).toBe(201);
    const id = res.body.item.id;
    expect(generateListing).not.toHaveBeenCalled(); // no texts at import
    expect(res.body.item).toMatchObject({ title: "50 breit 67 lang", description: "", notes: "Größe: M. Kleiner Fleck am Ärmel" });
    const before = (await request(app).get(`/api/archive/${id}`)).body.photos;
    expect([before[0].width, before[0].height]).toEqual([40, 80]); // photos were turned upright at import

    // Seller types a price in the list.
    expect((await request(app).post("/api/pricing/set").send({ itemId: id, priceCents: 2200 })).body).toMatchObject({ price_cents: 2200, price_confirmed: 1 });

    // Upload: the assistant asks for the item → AI writes everything fresh.
    const { localAssistSource } = await import("../src/modules/assist/localSource.js");
    const { db } = await import("../src/db/index.js");
    const accountId = await db.insert("INSERT INTO accounts (name, domain) VALUES ('Upload-Shop', 'vinted.de')");
    const data = await localAssistSource.load({ itemId: id, accountId });
    expect(vi.mocked(generateListing).mock.calls.at(-1)![1]).toMatchObject({ hints: "Größe: M. Kleiner Fleck am Ärmel", measurements: "50 breit 67 lang" });
    expect(data).toMatchObject({ title: expect.stringMatching(/^Carhartt/), price: "22", aiError: null, condition: "Sehr gut" });
    expect(data.description).toContain("Carhartt Detroit Jacket");
    const after = (await request(app).get(`/api/archive/${id}`)).body;
    expect(after.item).toMatchObject({ price_cents: 2200, price_confirmed: 1, category: "Herren > Jacken", measurements: "50 breit 67 lang" });
    expect(after.photos.map((p: { id: number }) => p.id)).toEqual(before.map((p: { id: number }) => p.id)); // order untouched

    // Next upload (e.g. reupload): written fresh again.
    await localAssistSource.load({ itemId: id, accountId });
    expect(vi.mocked(generateListing).mock.calls.length).toBe(2);
  });
});
