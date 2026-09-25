import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { env } from "../config/env.js";

export const PHOTO_DIR = path.join(env.storageDir, "photos");
if (env.storageDir !== ":memory:") fs.mkdirSync(PHOTO_DIR, { recursive: true });

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
  const target = path.join(PHOTO_DIR, fileName);
  if (!fs.existsSync(target)) fs.writeFileSync(target, out.data);
  return { fileName, mimeType: "image/jpeg", width: out.info.width, height: out.info.height, sizeBytes: out.info.size, sha256 };
}

/** Rotates a stored photo (clockwise) and stores the result as a new file. */
export async function rotateStoredPhoto(fileName: string, degrees: 90 | 180 | 270): Promise<StoredPhoto> {
  const buf = await sharp(photoPath(fileName)).rotate(degrees).toBuffer();
  return storePhoto(buf);
}

/** Downloads a remote image (e.g. from an imported Vinted listing) and stores it. */
export async function storePhotoFromUrl(url: string): Promise<StoredPhoto> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Foto-Download fehlgeschlagen (HTTP ${res.status})`);
  return storePhoto(Buffer.from(await res.arrayBuffer()));
}

export function photoPath(fileName: string) {
  const safe = path.basename(fileName);
  return path.join(PHOTO_DIR, safe);
}

export function readPhotoBase64(fileName: string) {
  return fs.readFileSync(photoPath(fileName)).toString("base64");
}
