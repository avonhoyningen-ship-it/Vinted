import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { currentUserId } from "../db/index.js";

/**
 * Where photo files live. Locally: a folder on this PC. In the cloud: a
 * private Supabase Storage bucket with one folder per user – the folder is
 * always the signed-in user's, so nobody can reach someone else's photos.
 */
export interface PhotoStore {
  kind: "local" | "supabase";
  put(fileName: string, data: Buffer, contentType: string): Promise<void>;
  get(fileName: string): Promise<Buffer>;
  /** Local path (only the local store has one). */
  localPath?(fileName: string): string;
  /** Short-lived URL the browser can load directly (only Supabase). */
  signedUrl?(fileName: string, expiresInSeconds: number): Promise<string>;
  /** Deletes all photos of the current user (account deletion, only Supabase). Returns the number removed. */
  deleteAll?(): Promise<number>;
}

export const safeName = (fileName: string) => {
  const base = path.basename(fileName);
  if (!/^[A-Za-z0-9._-]+$/.test(base)) throw new Error("Ungültiger Dateiname");
  return base;
};

export function localStore(dir: string): PhotoStore {
  if (dir !== ":memory:") fs.mkdirSync(dir, { recursive: true });
  const p = (f: string) => path.join(dir, safeName(f));
  return {
    kind: "local",
    async put(f, data) {
      if (!fs.existsSync(p(f))) fs.writeFileSync(p(f), data);
    },
    async get(f) {
      return fs.promises.readFile(p(f));
    },
    localPath: p,
  };
}

export function supabaseStore(opts: { url: string; serviceKey: string; bucket: string; fetch?: typeof fetch }): PhotoStore {
  const f = opts.fetch ?? fetch;
  const auth = { authorization: `Bearer ${opts.serviceKey}`, apikey: opts.serviceKey };
  const objectPath = (name: string) => `${encodeURIComponent(currentUserId())}/${safeName(name)}`;
  let bucketReady: Promise<void> | null = null;
  // Private bucket, created on first use.
  const ensureBucket = () => (bucketReady ??= (async () => {
    const r = await f(`${opts.url}/storage/v1/bucket`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: opts.bucket, name: opts.bucket, public: false }),
    });
    if (!r.ok && r.status !== 409 && !/already exists/i.test(await r.text())) throw new Error(`Supabase-Bucket: HTTP ${r.status}`);
  })().catch((e) => { bucketReady = null; throw e; }));

  return {
    kind: "supabase",
    async put(name, data, contentType) {
      await ensureBucket();
      const r = await f(`${opts.url}/storage/v1/object/${opts.bucket}/${objectPath(name)}`, {
        method: "POST", headers: { ...auth, "content-type": contentType, "x-upsert": "true" }, body: new Uint8Array(data),
      });
      if (!r.ok) throw new Error(`Foto-Upload zu Supabase fehlgeschlagen (HTTP ${r.status})`);
    },
    async get(name) {
      const r = await f(`${opts.url}/storage/v1/object/authenticated/${opts.bucket}/${objectPath(name)}`, { headers: auth });
      if (!r.ok) throw new Error(`Foto nicht gefunden (HTTP ${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    },
    async deleteAll() {
      const prefix = encodeURIComponent(currentUserId());
      let removed = 0;
      for (;;) {
        const list = await f(`${opts.url}/storage/v1/object/list/${opts.bucket}`, {
          method: "POST", headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ prefix: `${prefix}/`, limit: 1000, offset: 0 }),
        });
        if (!list.ok) throw new Error(`Fotos auflisten fehlgeschlagen (HTTP ${list.status})`);
        const names = ((await list.json()) as { name: string }[]).map((o) => `${prefix}/${o.name}`);
        if (!names.length) return removed;
        const del = await f(`${opts.url}/storage/v1/object/${opts.bucket}`, {
          method: "DELETE", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ prefixes: names }),
        });
        if (!del.ok) throw new Error(`Fotos löschen fehlgeschlagen (HTTP ${del.status})`);
        removed += names.length;
      }
    },
    async signedUrl(name, expiresIn) {
      const r = await f(`${opts.url}/storage/v1/object/sign/${opts.bucket}/${objectPath(name)}`, {
        method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ expiresIn }),
      });
      if (!r.ok) throw new Error(`Foto nicht gefunden (HTTP ${r.status})`);
      const { signedURL } = (await r.json()) as { signedURL: string };
      return `${opts.url}/storage/v1${signedURL}`;
    },
  };
}

let store: PhotoStore =
  env.appMode === "cloud" && env.supabaseUrl && env.supabaseServiceKey
    ? supabaseStore({ url: env.supabaseUrl, serviceKey: env.supabaseServiceKey, bucket: env.supabaseBucket })
    : localStore(path.join(env.storageDir, "photos"));

export const photoStore = () => store;
/** Tests swap the store. */
export function setPhotoStore(s: PhotoStore) {
  store = s;
}
