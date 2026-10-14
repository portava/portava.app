/**
 * memoryMediaRenditions — §20's four renditions of a Memory item's photo or video.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Spec v1 §20
 *       (:561) "Original, viewer, card, and tiny renditions should be distinct
 *       signed derivatives." §21 "Delete media asset — Remove asset and
 *       derivatives". CENSUS: H182 (census-highlights-memories.md:550). B58
 *       cluster MEM-RENDITIONS, migration 3808 (`media_asset_renditions`).
 *
 * ── WHAT EXISTED, AND WHAT THIS ADDS ────────────────────────────────────────
 * `POST /media/upload` (routes/posts.ts storeVerifiedMediaUpload) already stores
 * three objects for an image: the processed original (EXIF/GPS stripped, capped
 * at 4096 px) at `<stem>.<ext>`, a 400 px `<stem>.thumb.jpg` and a 1500 px
 * `<stem>.feed.jpg`. Nothing recorded the two variants for a Memory, nothing made
 * a tiny one, and a Memory item kept ONE url — the original — for every viewer
 * and every surface. This module:
 *   1. REGISTERS the ladder for an item after its ADD_MEDIA: original, viewer
 *      (the upload's feed variant), card (the upload's thumbnail), and a tiny it
 *      generates from the STORED original (lib/mediaProcessing makeTinyVariant:
 *      64 px, low quality, no metadata). A rung the upload did not leave is
 *      generated from the stored original under a name only this module writes
 *      (`.viewer.jpg` / `.card.jpg` / `.tiny.jpg`), so the purge below can tell
 *      its own objects from the upload's.
 *   2. SERVES them: `readRenditionsForItems` + `renditionRefsFor` give a Memory
 *      read `renditions: {viewer, card, tiny, original?}` as bare `<bucket>/<path>`
 *      refs the client signs through /api/media/sign.
 *   3. PURGES them: `purgeRenditionsForMemory` (§21 DERIVATIVES_PURGED) and
 *      `purgeRenditionsForMediaUrls` (REMOVE_MEDIA), and lists them for account
 *      deletion (`collectAccountRenditionPaths`).
 *
 * ── THE RULES, EACH WITH ITS REASON ─────────────────────────────────────────
 * FAIL-SOFT ON WRITE. A rendition that cannot be made never fails the Memory
 * write (§19 H177: a failed media step does not invalidate saved facts), and is
 * simply not registered. NEVER A BROKEN PATH: a row is written only for an
 * object this call has just uploaded, or has downloaded AND decoded AND found
 * inside its rung's size bound — never for a name that "should" exist.
 *
 * NOTHING NEW BEFORE 3808. The first query is the renditions table; where it is
 * absent (42P01 / PGRST205) registration stops before any media_assets read,
 * download, encode or upload, and every read serves today's single URL. So no
 * object is generated and no response changes on a database without 3808 — the
 * reason this ships with no flag.
 *
 * A CANONICAL ASSET IS REQUIRED. 3808 keys a rendition by `media_assets.id`. An
 * item whose object has no `media_assets` row (the canonical layer did not record
 * it — lib/mediaAssets.ts `media_canonical_enabled`) is reported
 * `no_canonical_asset` and keeps its single URL. This module never WRITES
 * media_assets: that writer is the Media lane's, gated, and lit read paths hang
 * off it (lib/mediaAssets.ts header).
 *
 * ONLY THE OWNER'S OWN SERVER-WRITTEN OBJECTS. The object's path must name the
 * Memory's owner (memoryMediaOrigin.ownerSegmentOf) and must not sit under a
 * client-writable prefix (memories/, stories/ — never EXIF-stripped by the
 * server). 3808's path CHECK refuses the same prefixes.
 *
 * NON-OWNERS (Q-H182-1, fail-closed default). A non-owner is never given the
 * `original` ref when a distinct viewer exists, and their `mediaUrl` becomes the
 * viewer. This is a DISCLOSURE default on the refs this API serves; it is NOT a
 * byte-level rule — lib/mediaAccess decides each signature per object, and this
 * module changes nothing there (a rendition grants no read its original does not).
 * VIDEO: no transcoder exists in this tier (census-media MD277), so a video's
 * viewer IS its original and is reported `viewerDistinct: false`; its card and
 * tiny are cut from the device-extracted poster when one exists.
 */
import sharp from "sharp";
import {
  makeFeedVariant,
  makeThumbnail,
  makeTinyVariant,
  FEED_DIM,
  THUMBNAIL_DIM,
  TINY_DIM,
  type ProcessedImage,
} from "../../lib/mediaProcessing.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { isAlreadyExists } from "../../lib/mediaVideoPoster.js";
import { POSTER_SUFFIX } from "../../lib/mediaPosterPath.js";
import { publicUrlFor } from "../../lib/mediaAccess.js";
import { ownerSegmentOf, storageRefOf } from "./memoryMediaOrigin.js";

// ── Vocabulary (mirrors 3808) ────────────────────────────────────────────────

/** 3808's `media_asset_renditions_rendition_check`, in ladder order. */
export const RENDITION_NAMES = ["original", "viewer", "card", "tiny"] as const;
export type RenditionName = (typeof RENDITION_NAMES)[number];

/**
 * 3808's `media_asset_renditions_ladder_check`: the longest edge each rung may
 * have. Pinned equal to lib/mediaProcessing's FEED_DIM / THUMBNAIL_DIM /
 * TINY_DIM and to the SQL by src/test/memoryMediaRenditions.test.ts.
 */
export const LADDER_MAX_EDGE = { viewer: FEED_DIM, card: THUMBNAIL_DIM, tiny: TINY_DIM } as const;

/** 3808's `media_asset_renditions_mime_check`. */
export const RENDITION_MIMES = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm"] as const;

/** Prefixes an authenticated client can write to directly (lib/mediaPosterPath). */
const CLIENT_WRITABLE_PREFIXES = ["memories/", "stories/"] as const;

export interface RenditionRow {
  asset_id: string;
  rendition: RenditionName;
  storage_path: string;
  width: number | null;
  height: number | null;
  mime: string;
}

/** Same-file constant so check:write-path-columns can read the select list. */
const RENDITION_COLUMNS = "asset_id, rendition, storage_path, width, height, mime";
const ASSET_COLUMNS = "id, owner_user_id, storage_bucket, storage_path, media_type, mime_type, width, height, deleted_at";

interface Log {
  error?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  info?: (obj: unknown, msg?: string) => void;
}

// ── Layout: where each rung of one original lives ────────────────────────────

export interface RenditionLayout {
  bucket: string;
  original: string;
  /** Folder the original sits in ("" at the bucket root). */
  folder: string;
  /** The original's file name without its extension — the storage `list` search. */
  fileStem: string;
  /** The /media/upload siblings (routes/posts.ts): NOT this module's objects. */
  uploadViewer: string;
  uploadCard: string;
  /** Names only this module writes, so a purge can never take the upload's objects. */
  ownedViewer: string;
  ownedCard: string;
  tiny: string;
  /** A video's device-extracted poster (lib/mediaPosterPath). */
  poster: string;
}

/**
 * The ladder's paths for one original, or null when the path is not one this
 * module may build on: absolute, a traversal, a client-writable prefix, or a
 * file without an extension (no stem to hang siblings on).
 */
export function renditionLayoutFor(bucket: string, originalPath: string): RenditionLayout | null {
  const p = String(originalPath ?? "");
  if (!p || p.startsWith("/") || p.includes("..") || p.length > 1000) return null;
  if (CLIENT_WRITABLE_PREFIXES.some((pre) => p.startsWith(pre))) return null;
  const slash = p.lastIndexOf("/");
  const folder = slash >= 0 ? p.slice(0, slash) : "";
  const file = p.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  if (dot <= 0 || dot === file.length - 1) return null;
  const fileStem = file.slice(0, dot);
  const stem = folder ? `${folder}/${fileStem}` : fileStem;
  return {
    bucket,
    original: p,
    folder,
    fileStem,
    uploadViewer: `${stem}.feed.jpg`,
    uploadCard: `${stem}.thumb.jpg`,
    ownedViewer: `${stem}.viewer.jpg`,
    ownedCard: `${stem}.card.jpg`,
    tiny: `${stem}.tiny.jpg`,
    poster: `${p}${POSTER_SUFFIX}`,
  };
}

/** The objects of `layout` this module wrote (and therefore may remove). */
export function ownedRenditionPaths(layout: RenditionLayout): string[] {
  return [layout.ownedViewer, layout.ownedCard, layout.tiny];
}

/** Does this (rung, size, mime) satisfy 3808's ladder CHECK? Mirrors the SQL. */
export function withinLadder(rendition: RenditionName, mime: string, width: number | null, height: number | null): boolean {
  if (!(RENDITION_MIMES as readonly string[]).includes(mime)) return false;
  if ((width === null) !== (height === null)) return false;
  if (width !== null && height !== null && (width <= 0 || height <= 0)) return false;
  const edge = width !== null && height !== null ? Math.max(width, height) : null;
  const isVideo = mime.startsWith("video/");
  switch (rendition) {
    case "tiny": return mime === "image/jpeg" && edge !== null && edge <= LADDER_MAX_EDGE.tiny;
    case "card": return mime === "image/jpeg" && edge !== null && edge <= LADDER_MAX_EDGE.card;
    case "viewer": return isVideo || (mime === "image/jpeg" && edge !== null && edge <= LADDER_MAX_EDGE.viewer);
    case "original": return isVideo || edge !== null;
    default: return false;
  }
}

function mimeOfFormat(format: string | undefined): string | null {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return null;
}

// ── Storage seam (the subset of supabase-js storage this module uses) ─────────

interface BucketLike {
  list(folder: string, opts?: { limit?: number; search?: string }): Promise<{ data: Array<{ name: string }> | null; error: unknown }>;
  download(path: string): Promise<{ data: unknown; error: unknown }>;
  upload(path: string, body: Buffer, opts: { contentType: string; upsert: boolean }): Promise<{ error: unknown }>;
  remove(paths: string[]): Promise<{ data?: unknown; error: unknown }>;
}

function bucketOf(sc: any, bucket: string): BucketLike {
  return sc.storage.from(bucket) as BucketLike;
}

async function toBuffer(data: unknown): Promise<Buffer | null> {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  const blobLike = data as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blobLike.arrayBuffer === "function") return Buffer.from(await blobLike.arrayBuffer());
  return null;
}

type Fetched =
  | { ok: true; buffer: Buffer; width: number; height: number; mime: string }
  /** The store did not answer (or answered with an error): nothing is known about the bytes. */
  | { ok: false; why: "unreadable" }
  /** The bytes came back and are not an image this ladder can use. */
  | { ok: false; why: "undecodable" };

/** Download and DECODE one object. Never throws. */
async function fetchImage(bucket: BucketLike, path: string): Promise<Fetched> {
  let buffer: Buffer | null;
  try {
    const { data, error } = await bucket.download(path);
    if (error) return { ok: false, why: "unreadable" };
    buffer = await toBuffer(data);
  } catch {
    return { ok: false, why: "unreadable" };
  }
  if (!buffer || buffer.length === 0) return { ok: false, why: "undecodable" };
  try {
    const meta = await sharp(buffer, { failOn: "error" }).metadata();
    const mime = mimeOfFormat(meta.format);
    if (!mime || !meta.width || !meta.height) return { ok: false, why: "undecodable" };
    return { ok: true, buffer, width: meta.width, height: meta.height, mime };
  } catch {
    return { ok: false, why: "undecodable" };
  }
}

// ── 1. Registration ──────────────────────────────────────────────────────────

export type RegistrationSkip =
  | "external"              // not one of our storage objects
  | "not_owner_storage"     // the path does not name the Memory's owner
  | "unrecognised_path"     // client-writable prefix, traversal, or no extension
  | "not_deployed"          // 3808 is not applied: nothing generated, nothing read
  | "no_canonical_asset"    // media_assets holds no row for the object
  | "not_owner_asset"       // the asset row belongs to someone else
  | "asset_deleted"         // the asset was deleted (2952)
  | "unsupported_media";    // neither an image nor a video this ladder knows

export type RegistrationResult =
  | {
      state: "registered";
      assetId: string;
      bucket: string;
      kind: "image" | "video";
      /** Every row now registered for the asset (read back, not assumed). */
      rows: RenditionRow[];
      /** Objects this call wrote to storage. */
      generated: string[];
      /** Rungs still unregistered, each with why. */
      missing: Array<{ rendition: RenditionName; why: string }>;
    }
  | { state: "skipped"; reason: RegistrationSkip }
  | { state: "failed"; reason: string };

export interface RegistrationInput {
  ownerId: string;
  /** The item's media_url as written (any of memoryMediaOrigin's three spellings). */
  mediaUrl: string;
  log?: Log | undefined;
}

/**
 * Register §20's ladder for one Memory item's object. Idempotent: rows already
 * registered are kept as they are (ON CONFLICT DO NOTHING) and only missing rungs
 * are made. NEVER THROWS and never fails the caller's write.
 */
export async function registerMemoryItemRenditions(sc: any, input: RegistrationInput): Promise<RegistrationResult> {
  let result: RegistrationResult;
  try {
    result = await register(sc, input);
  } catch (err) {
    result = { state: "failed", reason: `threw: ${String((err as any)?.message ?? err)}` };
  }
  if (result.state === "failed") {
    input.log?.warn?.({ reason: result.reason }, "memories: §20 renditions not registered — the item keeps its single URL");
  } else if (result.state === "registered" && result.missing.length > 0) {
    input.log?.warn?.({ assetId: result.assetId, missing: result.missing }, "memories: §20 renditions registered in part");
  }
  return result;
}

/** How long the ADD_MEDIA route waits before answering without the ladder. */
export const RENDITION_REGISTRATION_BUDGET_MS = 4000;

/**
 * The route's form: wait up to `budgetMs`, then answer `pending` and let the
 * registration finish on its own (it never rejects). The write's response is
 * never held hostage by object storage.
 */
export async function registerWithinBudget(
  sc: any,
  input: RegistrationInput,
  budgetMs: number = RENDITION_REGISTRATION_BUDGET_MS,
): Promise<RegistrationResult | { state: "pending" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ state: "pending" }>((resolve) => {
    timer = setTimeout(() => resolve({ state: "pending" }), Math.max(0, budgetMs));
  });
  try {
    return await Promise.race([registerMemoryItemRenditions(sc, input), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Candidate { rendition: RenditionName; path: string; width: number | null; height: number | null; mime: string }

async function register(sc: any, input: RegistrationInput): Promise<RegistrationResult> {
  const ref = storageRefOf(input.mediaUrl);
  if (!ref) return { state: "skipped", reason: "external" };
  const pathOwner = ownerSegmentOf(ref.path);
  if (!pathOwner || pathOwner.toLowerCase() !== String(input.ownerId ?? "").toLowerCase()) {
    return { state: "skipped", reason: "not_owner_storage" };
  }
  const layout = renditionLayoutFor(ref.bucket, ref.path);
  if (!layout) return { state: "skipped", reason: "unrecognised_path" };

  // FIRST the renditions table: absent ⇒ stop before touching anything else.
  const probe = await sc
    .from("media_asset_renditions")
    .select(RENDITION_COLUMNS)
    .eq("rendition", "original")
    .eq("storage_path", ref.path);
  if (probe.error) {
    if (isTableAbsentError(probe.error)) return { state: "skipped", reason: "not_deployed" };
    return { state: "failed", reason: `media_asset_renditions unreadable: ${String(probe.error.message ?? "")}` };
  }

  const assetRead = await sc
    .from("media_assets")
    .select(ASSET_COLUMNS)
    .eq("storage_bucket", ref.bucket)
    .eq("storage_path", ref.path)
    .maybeSingle();
  if (assetRead.error) return { state: "failed", reason: `media_assets unreadable: ${String(assetRead.error.message ?? "")}` };
  const asset = assetRead.data as {
    id: string; owner_user_id: string; storage_bucket: string; storage_path: string;
    media_type: string; mime_type: string; width: number | null; height: number | null; deleted_at: string | null;
  } | null;
  if (!asset) return { state: "skipped", reason: "no_canonical_asset" };
  if (String(asset.owner_user_id ?? "").toLowerCase() !== String(input.ownerId).toLowerCase()) {
    return { state: "skipped", reason: "not_owner_asset" };
  }
  if (asset.deleted_at) return { state: "skipped", reason: "asset_deleted" };
  const kind = asset.media_type === "image" ? "image" : asset.media_type === "video" ? "video" : null;
  if (!kind) return { state: "skipped", reason: "unsupported_media" };

  const existingRead = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).eq("asset_id", asset.id);
  if (existingRead.error) return { state: "failed", reason: `media_asset_renditions unreadable: ${String(existingRead.error.message ?? "")}` };
  const have = new Map<RenditionName, RenditionRow>();
  for (const r of ((existingRead.data ?? []) as RenditionRow[])) have.set(r.rendition, r);
  if (RENDITION_NAMES.every((n) => have.has(n))) {
    return { state: "registered", assetId: asset.id, bucket: ref.bucket, kind, rows: RENDITION_NAMES.map((n) => have.get(n)!), generated: [], missing: [] };
  }

  const bucket = bucketOf(sc, ref.bucket);
  const listed = await bucket.list(layout.folder, { limit: 100, search: layout.fileStem });
  if (listed.error) return { state: "failed", reason: `storage list failed: ${String((listed.error as any)?.message ?? listed.error)}` };
  const names = new Set(((listed.data ?? []) as Array<{ name: string }>).map((o) => String(o?.name ?? "")));
  const present = (path: string) => names.has(path.slice(path.lastIndexOf("/") + 1));

  const candidates: Candidate[] = [];
  const generated: string[] = [];
  const missing: Array<{ rendition: RenditionName; why: string }> = [];

  /** Upload a generated rung under its owned name; an object already there (an
   *  earlier partial run, a concurrent one) is downloaded and measured instead. */
  const store = async (rendition: RenditionName, path: string, made: ProcessedImage): Promise<void> => {
    const up = await bucket.upload(path, made.buffer, { contentType: made.mime, upsert: false });
    if (!up.error) {
      generated.push(path);
      candidates.push({ rendition, path, width: made.width, height: made.height, mime: made.mime });
      return;
    }
    if (isAlreadyExists(up.error)) {
      const there = await fetchImage(bucket, path);
      if (there.ok && withinLadder(rendition, there.mime, there.width, there.height)) {
        candidates.push({ rendition, path, width: there.width, height: there.height, mime: there.mime });
        return;
      }
      missing.push({ rendition, why: `an object already at the owned path is ${there.ok ? "outside its rung" : there.why}` });
      return;
    }
    missing.push({ rendition, why: `upload failed: ${String((up.error as any)?.message ?? up.error)}` });
  };

  /** Use the upload's sibling when it is there and sound; otherwise make the rung. */
  const siblingOrMake = async (
    rendition: "viewer" | "card",
    siblingPath: string,
    ownedPath: string,
    source: Buffer | null,
    make: (b: Buffer) => Promise<ProcessedImage>,
  ): Promise<void> => {
    if (have.has(rendition)) return;
    if (present(siblingPath)) {
      const sib = await fetchImage(bucket, siblingPath);
      if (sib.ok && withinLadder(rendition, sib.mime, sib.width, sib.height)) {
        candidates.push({ rendition, path: siblingPath, width: sib.width, height: sib.height, mime: sib.mime });
        return;
      }
      // Unreadable is not "broken": the store may answer next time, so nothing is
      // generated beside an object that may be fine. A sibling that came back and
      // does not decode (or is outside its rung) is replaced by a generated rung.
      if (!sib.ok && sib.why === "unreadable") { missing.push({ rendition, why: "the upload's variant could not be read" }); return; }
    }
    if (!source) { missing.push({ rendition, why: "no source to generate from" }); return; }
    try {
      await store(rendition, ownedPath, await make(source));
    } catch (err) {
      missing.push({ rendition, why: `generation failed: ${String((err as any)?.message ?? err)}` });
    }
  };

  const makeTiny = async (source: Buffer | null): Promise<void> => {
    if (have.has("tiny")) return;
    if (present(layout.tiny)) {
      const t = await fetchImage(bucket, layout.tiny);
      if (!t.ok && t.why === "unreadable") { missing.push({ rendition: "tiny", why: "an existing tiny could not be read" }); return; }
      if (t.ok && withinLadder("tiny", t.mime, t.width, t.height)) {
        candidates.push({ rendition: "tiny", path: layout.tiny, width: t.width, height: t.height, mime: t.mime });
        return;
      }
    }
    if (!source) { missing.push({ rendition: "tiny", why: "no source to generate from" }); return; }
    try {
      await store("tiny", layout.tiny, await makeTinyVariant(source));
    } catch (err) {
      missing.push({ rendition: "tiny", why: `generation failed: ${String((err as any)?.message ?? err)}` });
    }
  };

  if (kind === "image") {
    // The STORED original is the one source: it is what /media/upload kept after
    // the EXIF/GPS strip, and its variants were cut from these same bytes.
    if (!present(layout.original)) return { state: "failed", reason: "the original object is not in storage" };
    const original = await fetchImage(bucket, layout.original);
    if (!original.ok) return { state: "failed", reason: `the original object is ${original.why}` };
    // The bytes decide the mime (sniffed by decode), not the asset row's claim.
    if (!have.has("original")) candidates.push({ rendition: "original", path: layout.original, width: original.width, height: original.height, mime: original.mime });
    await siblingOrMake("viewer", layout.uploadViewer, layout.ownedViewer, original.buffer, makeFeedVariant);
    await siblingOrMake("card", layout.uploadCard, layout.ownedCard, original.buffer, makeThumbnail);
    await makeTiny(original.buffer);
  } else {
    // VIDEO. No transcoder (census-media MD277): the viewer IS the original, and
    // the row says so by naming the same path. Card and tiny come from the poster.
    if (!present(layout.original)) return { state: "failed", reason: "the original object is not in storage" };
    const mime = String(asset.mime_type ?? "");
    if (!mime.startsWith("video/") || !(RENDITION_MIMES as readonly string[]).includes(mime)) {
      return { state: "skipped", reason: "unsupported_media" };
    }
    const w = Number.isInteger(asset.width) && (asset.width as number) > 0 ? asset.width : null;
    const h = Number.isInteger(asset.height) && (asset.height as number) > 0 ? asset.height : null;
    const dims = w !== null && h !== null ? { width: w, height: h } : { width: null, height: null };
    if (!have.has("original")) candidates.push({ rendition: "original", path: layout.original, ...dims, mime });
    if (!have.has("viewer")) candidates.push({ rendition: "viewer", path: layout.original, ...dims, mime });
    const fetchedPoster = present(layout.poster) ? await fetchImage(bucket, layout.poster) : null;
    const poster = fetchedPoster && fetchedPoster.ok ? fetchedPoster : null;
    if (!poster && (!have.has("card") || !have.has("tiny"))) {
      const why = fetchedPoster === null ? "the video has no poster yet" : `the video's poster is ${(fetchedPoster as { why: string }).why}`;
      if (!have.has("card")) missing.push({ rendition: "card", why });
      if (!have.has("tiny")) missing.push({ rendition: "tiny", why });
    } else if (poster) {
      if (!have.has("card")) {
        try { await store("card", layout.ownedCard, await makeThumbnail(poster.buffer)); }
        catch (err) { missing.push({ rendition: "card", why: `generation failed: ${String((err as any)?.message ?? err)}` }); }
      }
      await makeTiny(poster.buffer);
    }
  }

  // The ladder bound, again, on what is about to be written: a rung outside its
  // bound is not registered (3808 would refuse the whole insert for it).
  const rows = candidates
    .filter((c) => {
      if (withinLadder(c.rendition, c.mime, c.width, c.height)) return true;
      missing.push({ rendition: c.rendition, why: "outside its rung's size bound" });
      return false;
    })
    .map((c): RenditionRow => ({ asset_id: asset.id, rendition: c.rendition, storage_path: c.path, width: c.width, height: c.height, mime: c.mime }));

  if (rows.length > 0) {
    const ins = await sc
      .from("media_asset_renditions")
      .upsert(rows, { onConflict: "asset_id,rendition", ignoreDuplicates: true });
    if (ins.error) {
      // Nothing records the objects this call wrote, so they go too (best effort):
      // an unregistered generated object is an orphan no deletion path can find.
      if (generated.length > 0) {
        const rm = await bucket.remove(generated);
        if (rm.error) input.log?.error?.({ paths: generated, err: rm.error }, "memories: §20 rendition registration failed AND its generated objects could not be removed — orphaned");
      }
      return { state: "failed", reason: `media_asset_renditions write failed: ${String(ins.error.message ?? "")}` };
    }
  }

  // Confirm by a read: the response reports what IS registered, not what was sent.
  const after = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).eq("asset_id", asset.id);
  if (after.error) return { state: "failed", reason: `media_asset_renditions unreadable after write: ${String(after.error.message ?? "")}` };
  const registered = ((after.data ?? []) as RenditionRow[]).slice().sort((a, b) => RENDITION_NAMES.indexOf(a.rendition) - RENDITION_NAMES.indexOf(b.rendition));
  const got = new Set(registered.map((r) => r.rendition));
  const stillMissing = RENDITION_NAMES.filter((n) => !got.has(n)).map((n) => missing.find((m) => m.rendition === n) ?? { rendition: n, why: "not registered" });
  return { state: "registered", assetId: asset.id, bucket: ref.bucket, kind, rows: registered, generated, missing: stillMissing };
}

// ── 2. Reads ─────────────────────────────────────────────────────────────────

/** What a Memory read serves for one item. Bare `<bucket>/<path>` refs. */
export interface RenditionRefs {
  viewer: string | null;
  card: string | null;
  tiny: string | null;
  /** Present ONLY for the Memory's owner (Q-H182-1). */
  original?: string;
  /** False for a video (no transcoder): its viewer is its original. */
  viewerDistinct: boolean;
}

export interface RegisteredLadder { bucket: string; rows: Map<RenditionName, RenditionRow> }

export type RenditionLookup =
  | { state: "not_deployed" }
  | { state: "ok"; byObject: Map<string, RegisteredLadder> }
  | { state: "unreadable"; detail: string };

const READ_CHUNK = 100;
function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** `<bucket>/<path>` — the key a lookup and a decorate agree on. */
export function objectKeyOf(mediaUrl: string): string | null {
  const ref = storageRefOf(mediaUrl);
  return ref ? `${ref.bucket}/${ref.path}` : null;
}

/**
 * The registered ladders for a set of items, keyed by `<bucket>/<path>` of the
 * item's object. An item whose object does not name its Memory's owner, or sits
 * under a client-writable prefix, is never looked up. No item to look up ⇒ no
 * query at all. 3808 absent ⇒ `not_deployed` (callers serve today's shape).
 */
export async function readRenditionsForItems(
  sc: any,
  items: ReadonlyArray<{ mediaUrl: string; ownerId: string }>,
): Promise<RenditionLookup> {
  const wanted = new Map<string, { bucket: string; path: string }>();
  for (const it of items) {
    const ref = storageRefOf(String(it.mediaUrl ?? ""));
    if (!ref) continue;
    const owner = ownerSegmentOf(ref.path);
    if (!owner || owner.toLowerCase() !== String(it.ownerId ?? "").toLowerCase()) continue;
    if (!renditionLayoutFor(ref.bucket, ref.path)) continue;
    wanted.set(`${ref.bucket}/${ref.path}`, ref);
  }
  const byObject = new Map<string, RegisteredLadder>();
  if (wanted.size === 0) return { state: "ok", byObject };
  try {
    const paths = [...new Set([...wanted.values()].map((r) => r.path))];
    const originals: RenditionRow[] = [];
    for (const batch of chunks(paths, READ_CHUNK)) {
      const q = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).eq("rendition", "original").in("storage_path", batch);
      if (q.error) {
        if (isTableAbsentError(q.error)) return { state: "not_deployed" };
        return { state: "unreadable", detail: `media_asset_renditions: ${String(q.error.message ?? "")}` };
      }
      originals.push(...((q.data ?? []) as RenditionRow[]));
    }
    if (originals.length === 0) return { state: "ok", byObject };

    const assetIds = [...new Set(originals.map((o) => o.asset_id))];
    const assets = new Map<string, { storage_bucket: string; storage_path: string; owner_user_id: string; deleted_at: string | null }>();
    for (const batch of chunks(assetIds, READ_CHUNK)) {
      const a = await sc.from("media_assets").select(ASSET_COLUMNS).in("id", batch);
      if (a.error) return { state: "unreadable", detail: `media_assets: ${String(a.error.message ?? "")}` };
      for (const r of ((a.data ?? []) as any[])) assets.set(String(r.id), r);
    }
    // An original row counts only when its asset IS this object, is owned by the
    // path's owner, and is not deleted — never a path match alone.
    const confirmed = new Map<string, string>(); // asset_id -> object key
    for (const o of originals) {
      const a = assets.get(o.asset_id);
      if (!a || a.deleted_at) continue;
      const key = `${a.storage_bucket}/${a.storage_path}`;
      const ref = wanted.get(key);
      if (!ref || a.storage_path !== o.storage_path) continue;
      if (String(a.owner_user_id ?? "").toLowerCase() !== String(ownerSegmentOf(ref.path) ?? "").toLowerCase()) continue;
      confirmed.set(o.asset_id, key);
    }
    if (confirmed.size === 0) return { state: "ok", byObject };
    for (const batch of chunks([...confirmed.keys()], READ_CHUNK)) {
      const r = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).in("asset_id", batch);
      if (r.error) return { state: "unreadable", detail: `media_asset_renditions: ${String(r.error.message ?? "")}` };
      for (const row of ((r.data ?? []) as RenditionRow[])) {
        const key = confirmed.get(row.asset_id);
        if (!key) continue;
        const ladder = byObject.get(key) ?? { bucket: wanted.get(key)!.bucket, rows: new Map<RenditionName, RenditionRow>() };
        ladder.rows.set(row.rendition, row);
        byObject.set(key, ladder);
      }
    }
    return { state: "ok", byObject };
  } catch (err) {
    return { state: "unreadable", detail: `threw: ${String((err as any)?.message ?? err)}` };
  }
}

/** One item's refs for one viewer, or null when nothing is registered. */
export function renditionRefsFor(ladder: RegisteredLadder | undefined, viewerIsOwner: boolean): RenditionRefs | null {
  if (!ladder || ladder.rows.size === 0) return null;
  const ref = (r: RenditionRow | undefined) => (r ? `${ladder.bucket}/${r.storage_path}` : null);
  const original = ladder.rows.get("original");
  const viewer = ladder.rows.get("viewer");
  const out: RenditionRefs = {
    viewer: ref(viewer),
    card: ref(ladder.rows.get("card")),
    tiny: ref(ladder.rows.get("tiny")),
    viewerDistinct: Boolean(viewer && original && viewer.storage_path !== original.storage_path),
  };
  if (viewerIsOwner && original) out.original = ref(original)!;
  return out;
}

/**
 * Decorate one served media object (`{ mediaUrl, ... }`) for one viewer. A
 * NON-OWNER whose item has a distinct viewer gets the viewer as `mediaUrl` and no
 * `original` anywhere (Q-H182-1); everyone else keeps `mediaUrl` exactly as today.
 * No ladder ⇒ the object is returned UNCHANGED (no `renditions` key at all).
 */
export function withRenditions<T extends { mediaUrl: string }>(
  served: T,
  lookup: RenditionLookup,
  viewerIsOwner: boolean,
): T & { renditions?: RenditionRefs } {
  if (lookup.state !== "ok") return served;
  const key = objectKeyOf(served.mediaUrl);
  const refs = renditionRefsFor(key ? lookup.byObject.get(key) : undefined, viewerIsOwner);
  if (!refs) return served;
  const mediaUrl = !viewerIsOwner && refs.viewerDistinct && refs.viewer ? refs.viewer : served.mediaUrl;
  return { ...served, mediaUrl, renditions: refs };
}

/**
 * A Memory read's single question to this module. `ok: false` ONLY when a
 * non-owner would be served and the ladder could not be read: with the ladder
 * unknown, whether an original may be withheld cannot be decided, so the read
 * refuses (the §28.11 posture of memoryItemVisibility.hiddenItemKeys). The owner
 * is served today's shape instead — their original is theirs.
 */
export async function renditionsForRead(
  sc: any,
  items: ReadonlyArray<{ mediaUrl: string; ownerId: string }>,
  viewerId: string,
  log?: Log,
): Promise<{ ok: true; lookup: RenditionLookup } | { ok: false; detail: string }> {
  const lookup = await readRenditionsForItems(sc, items);
  if (lookup.state !== "unreadable") return { ok: true, lookup };
  log?.error?.({ detail: lookup.detail }, "memories: §20 renditions unreadable");
  const anyNonOwner = items.some((it) => String(it.ownerId) !== String(viewerId));
  if (anyNonOwner) return { ok: false, detail: lookup.detail };
  return { ok: true, lookup: { state: "not_deployed" } };
}

/** The ADD_MEDIA response's refs (the owner's view) from a registration. */
export function refsFromRegistration(result: RegistrationResult | { state: "pending" }): RenditionRefs | null {
  if (result.state !== "registered" || result.rows.length === 0) return null;
  return renditionRefsFor({ bucket: result.bucket, rows: new Map(result.rows.map((r) => [r.rendition, r])) }, true);
}

// ── 3. Purge (§21) ───────────────────────────────────────────────────────────

export type PurgeResult =
  | { state: "not_deployed" }
  /** Nothing registered for these objects. */
  | { state: "none" }
  | { state: "done"; purgedAssets: number; rowsDeleted: number; objectsRemoved: number; keptInUse: number }
  | { state: "failed"; detail: string };

function urlFormsOf(bucket: string, path: string): string[] {
  const bare = `${bucket}/${path}`;
  const abs = publicUrlFor(bucket, path);
  return abs ? [abs, bare] : [bare];
}

/**
 * Purge the ladder of every object in `mediaUrls` that NO LIVE MEMORY ITEM still
 * shows: the objects this module wrote (tiny, a generated viewer/card) are
 * removed from storage FIRST, then the rows. Objects the upload wrote (the
 * original, `.feed.jpg`, `.thumb.jpg`) are never removed here — their lifecycle
 * is the asset's (account deletion, the asset purge). A storage failure leaves
 * the rows in place, so a retry finds the same paths; a row delete is confirmed
 * by a read. Never throws.
 */
export async function purgeRenditionsForMediaUrls(
  sc: any,
  input: { ownerId: string; mediaUrls: readonly string[] },
): Promise<PurgeResult> {
  try {
    const objects = new Map<string, { bucket: string; path: string }>();
    for (const u of input.mediaUrls) {
      const ref = storageRefOf(String(u ?? ""));
      if (!ref) continue;
      const owner = ownerSegmentOf(ref.path);
      if (!owner || owner.toLowerCase() !== String(input.ownerId).toLowerCase()) continue;
      if (!renditionLayoutFor(ref.bucket, ref.path)) continue;
      objects.set(`${ref.bucket}/${ref.path}`, ref);
    }
    if (objects.size === 0) return { state: "none" };

    let purgedAssets = 0, rowsDeleted = 0, objectsRemoved = 0, keptInUse = 0, sawAny = false;
    for (const obj of objects.values()) {
      const orig = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).eq("rendition", "original").eq("storage_path", obj.path);
      if (orig.error) {
        if (isTableAbsentError(orig.error)) return { state: "not_deployed" };
        return { state: "failed", detail: `media_asset_renditions unreadable: ${String(orig.error.message ?? "")}` };
      }
      for (const o of ((orig.data ?? []) as RenditionRow[])) {
        const asset = await sc.from("media_assets").select(ASSET_COLUMNS).eq("id", o.asset_id).maybeSingle();
        if (asset.error) return { state: "failed", detail: `media_assets unreadable: ${String(asset.error.message ?? "")}` };
        const a = asset.data as { storage_bucket: string; storage_path: string; owner_user_id: string } | null;
        // A row for some other bucket's object of the same path is not this object's.
        if (a && (a.storage_bucket !== obj.bucket || a.storage_path !== obj.path)) continue;
        sawAny = true;

        // Still shown by a live Memory item? Then the ladder stays.
        const refs = await sc.from("memory_items").select("memory_id, media_url").in("media_url", urlFormsOf(obj.bucket, obj.path));
        if (refs.error) return { state: "failed", detail: `memory_items unreadable: ${String(refs.error.message ?? "")}` };
        const memIds = [...new Set(((refs.data ?? []) as Array<{ memory_id: string }>).map((r) => String(r.memory_id)))];
        if (memIds.length > 0) {
          const live = await sc.from("memories").select("id, state").in("id", memIds).neq("state", "deleted");
          if (live.error) return { state: "failed", detail: `memories unreadable: ${String(live.error.message ?? "")}` };
          if (((live.data ?? []) as unknown[]).length > 0) { keptInUse += 1; continue; }
        }

        const rowsRead = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).eq("asset_id", o.asset_id);
        if (rowsRead.error) return { state: "failed", detail: `media_asset_renditions unreadable: ${String(rowsRead.error.message ?? "")}` };
        const layout = renditionLayoutFor(obj.bucket, obj.path)!;
        const mine = new Set(ownedRenditionPaths(layout));
        const toRemove = [...new Set(((rowsRead.data ?? []) as RenditionRow[])
          .filter((r) => r.rendition !== "original" && mine.has(r.storage_path))
          .map((r) => r.storage_path))];
        if (toRemove.length > 0) {
          const rm = await bucketOf(sc, obj.bucket).remove(toRemove);
          if (rm.error) return { state: "failed", detail: `storage remove failed: ${String((rm.error as any)?.message ?? rm.error)}` };
          objectsRemoved += toRemove.length;
        }
        const del = await sc.from("media_asset_renditions").delete().eq("asset_id", o.asset_id).select("rendition");
        if (del.error) return { state: "failed", detail: `media_asset_renditions delete failed: ${String(del.error.message ?? "")}` };
        const left = await sc.from("media_asset_renditions").select(RENDITION_COLUMNS).eq("asset_id", o.asset_id);
        if (left.error) return { state: "failed", detail: `media_asset_renditions unreadable after delete: ${String(left.error.message ?? "")}` };
        if (((left.data ?? []) as unknown[]).length > 0) return { state: "failed", detail: `media_asset_renditions: ${(left.data as unknown[]).length} row(s) remain after the delete` };
        rowsDeleted += ((del.data ?? []) as unknown[]).length;
        purgedAssets += 1;
      }
    }
    if (!sawAny) return { state: "none" };
    return { state: "done", purgedAssets, rowsDeleted, objectsRemoved, keptInUse };
  } catch (err) {
    return { state: "failed", detail: `threw: ${String((err as any)?.message ?? err)}` };
  }
}

/** §21 DERIVATIVES_PURGED for one deleted Memory: its items' ladders. */
export async function purgeRenditionsForMemory(
  sc: any,
  input: { memoryId: string; ownerId: string },
): Promise<PurgeResult> {
  try {
    const items = await sc.from("memory_items").select("media_url").eq("memory_id", input.memoryId);
    if (items.error) return { state: "failed", detail: `memory_items unreadable: ${String(items.error.message ?? "")}` };
    const urls = ((items.data ?? []) as Array<{ media_url: string }>).map((r) => String(r.media_url ?? ""));
    return await purgeRenditionsForMediaUrls(sc, { ownerId: input.ownerId, mediaUrls: urls });
  } catch (err) {
    return { state: "failed", detail: `threw: ${String((err as any)?.message ?? err)}` };
  }
}

// ── 4. Account deletion ──────────────────────────────────────────────────────

type PagedRead = (build: () => any, consume: (rows: any[]) => number) => Promise<number>;

/**
 * AccountDeletionService's `collect_media_rendition_paths`: every registered
 * NON-original rung of every asset the account owns or uploaded, added to the
 * removal set BEFORE `delete_media_assets` takes the rows (by cascade). The
 * original is collected by `collect_media_asset_paths`. Each path must name the
 * departing user (lib/mediaAccess ownerFromPath's rule) and sit outside the
 * client-writable prefixes — a DELETE path never trusts a stored string. 3808
 * absent ⇒ 0: nothing was ever registered. Throws on any other read failure, so
 * the step reports it and the outcome warns that objects may remain.
 */
export async function collectAccountRenditionPaths(
  sc: any,
  userId: string,
  readAll: PagedRead,
  targets: Array<{ bucket: string; path: string }>,
): Promise<number> {
  const probe = await sc.from("media_asset_renditions").select("asset_id").limit(1);
  if (probe.error) {
    if (isTableAbsentError(probe.error)) return 0;
    throw new Error(`media_asset_renditions: ${String(probe.error.message ?? probe.error)}`);
  }
  const bucketOfAsset = new Map<string, string>();
  await readAll(
    () => sc.from("media_assets").select("id, storage_bucket").or(`owner_user_id.eq.${userId},uploader_user_id.eq.${userId}`).order("id", { ascending: true }),
    (rows) => { for (const r of rows) if (r?.id) bucketOfAsset.set(String(r.id), String(r.storage_bucket || "post-media")); return 0; },
  );
  if (bucketOfAsset.size === 0) return 0;
  let found = 0;
  for (const batch of chunks([...bucketOfAsset.keys()], READ_CHUNK)) {
    found += await readAll(
      () => sc.from("media_asset_renditions").select(RENDITION_COLUMNS).in("asset_id", batch).order("asset_id", { ascending: true }).order("rendition", { ascending: true }),
      (rows) => {
        let n = 0;
        for (const r of rows as RenditionRow[]) {
          if (r.rendition === "original") continue;
          const path = String(r.storage_path ?? "");
          if (!path || path.includes("..") || CLIENT_WRITABLE_PREFIXES.some((p) => path.startsWith(p))) continue;
          if (String(ownerSegmentOf(path) ?? "").toLowerCase() !== String(userId).toLowerCase()) continue;
          targets.push({ bucket: bucketOfAsset.get(String(r.asset_id)) ?? "post-media", path });
          n += 1;
        }
        return n;
      },
    );
  }
  return found;
}
