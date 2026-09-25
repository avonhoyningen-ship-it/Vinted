import crypto from "node:crypto";
import sharp from "sharp";
import { photoStore } from "./store.js";

export interface StoredPhoto {
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
}

/**
 * Normalises an uploaded photo for privacy and consistent storage:
 * applies EXIF orientation, then drops all metadata (GPS position, camera
 * serial, timestamps). sharp strips metadata unless asked to keep it. The
 * result is deterministic: the same input always yields the same file.
 * Downscales to max 2048px.
 */
export async function storePhoto(input: Buffer): Promise<StoredPhoto> {
  const out = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const sha256 = crypto.createHash("sha256").update(out.data).digest("hex");
  const fileName = `${sha256}.jpg`;
  await photoStore().put(fileName, out.data, "image/jpeg");
  return { fileName, mimeType: "image/jpeg", width: out.info.width, height: out.info.height, sizeBytes: out.info.size, sha256 };
}

/** Rotates a stored photo (clockwise) and stores the result as a new file. */
export async function rotateStoredPhoto(fileName: string, degrees: 90 | 180 | 270): Promise<StoredPhoto> {
  const buf = await sharp(await readPhoto(fileName)).rotate(degrees).toBuffer();
  return storePhoto(buf);
}

/** Downloads a remote image (e.g. from an imported Vinted listing) and stores it. */
export async function storePhotoFromUrl(url: string): Promise<StoredPhoto> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Foto-Download fehlgeschlagen (HTTP ${res.status})`);
  return storePhoto(Buffer.from(await res.arrayBuffer()));
}

/** The stored JPEG (local file or Supabase Storage). */
export function readPhoto(fileName: string): Promise<Buffer> {
  return photoStore().get(fileName);
}

/** Path on this PC – only in local mode (posting assistant uploads files from disk). */
export function photoPath(fileName: string): string {
  const s = photoStore();
  if (!s.localPath) throw new Error("Fotos liegen in der Cloud – kein lokaler Dateipfad");
  return s.localPath(fileName);
}
