/**
 * Rendition selection for a Memory's photos — census-highlights-memories H182
 * ("Distinct original / viewer / card / tiny signed renditions").
 *
 * WHAT EXISTS, AND WHAT THIS ADDS
 * ===============================
 * The Media lane's image ladder (`lib/media/imageVariants/*`) publishes, per
 * canonical `post-media` image, eight files — `thumb.jpg`, `feed.jpg`,
 * `image-{320,800,1600}.{webp,avif}` — and serves them through an authenticated
 * relay (`routes/mediaImageVariants.ts`). Memory photos are uploaded through
 * the same `POST /api/media/upload`, so a Memory item's `media_url` IS a
 * canonical `post-media` reference. Until this file no Memory read asked for
 * the ladder: every surface got the one original URL.
 *
 * This SELECTS. For each image item the viewer is already being shown, it asks
 * the ladder's own descriptor (`ImageVariantsService.descriptor`, by the item's
 * `media_url`) and, when the generation is published, names one file per tier:
 *
 *   tiny   → image-320.webp, else thumb.jpg     (list rows, avatars of a Memory)
 *   card   → image-800.webp, else feed.jpg      (cards, grids)
 *   viewer → image-1600.webp, else feed.jpg     (the full-screen viewer)
 *   original → the item's `media_url`, unchanged
 *
 * WebP before AVIF and JPEG because every client this app ships decodes WebP;
 * the AVIF files stay available through the descriptor for a client that asks.
 *
 * IT CANNOT WIDEN ANYTHING
 * ========================
 *  - It runs only over items the route already decided to show (the Memory's
 *    own read policy, the hidden-photo filter), so it never adds an item.
 *  - The descriptor re-authorizes the viewer against the CANONICAL asset — its
 *    own visibility, the owner's account state, `authorizeMediaAccess` — so a
 *    rendition is offered only where the original's own rules admit the viewer.
 *    The two gates intersect.
 *  - The URLs are the relay's relative, authenticated paths. No signed URL, no
 *    storage path, no token is minted here.
 *
 * IT CANNOT BREAK A READ
 * ======================
 * A rendition is an optimisation of a photo the person may already see, so
 * every failure is "no renditions" and the original stays: the environment
 * switch off (`MEDIA_IMAGE_VARIANTS_ENABLED`), either database flag off
 * (`media_canonical_enabled`, `media_derivative_jobs_enabled` — 3980, seeded
 * FALSE, applied nowhere), an unpublished generation, a refusal, a timeout
 * (`SELECTION_BUDGET_MS` for the whole Memory), a throw. No flag is added here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createConfiguredImageVariants, enqueueConfiguredImageVariants, type ImageVariantsIngestSubject } from "../../lib/media/imageVariants/bridge.js"; import { imageVariantsConfigFromEnv } from "../../lib/media/imageVariants/runtime.js"; import { createImageVariantsAccess } from "../../lib/media/imageVariants/canonical.js"; import { imageOriginalPath } from "../media/ImageVariantsService.js";
import type { ImageVariantDescriptor } from "../../lib/media/imageVariants/descriptor.js";

export const MEMORY_RENDITION_TIERS = Object.freeze({
  tiny: ["image-320.webp", "thumb.jpg"],
  card: ["image-800.webp", "feed.jpg"],
  viewer: ["image-1600.webp", "feed.jpg"],
} as const);

export type MemoryRenditionTier = keyof typeof MEMORY_RENDITION_TIERS;

export interface MemoryRendition {
  url: string;
  mime: string;
  width: number;
  height: number;
}

export interface MemoryItemRenditions {
  assetId: string;
  sourceVersion: number;
  tiny: MemoryRendition | null;
  card: MemoryRendition | null;
  viewer: MemoryRendition | null;
  original: string;
}

/** The whole selection for one Memory read gets this long, then the originals stand alone. */
export const SELECTION_BUDGET_MS = 2_500;
/** At most this many photos of one Memory are looked up. */
export const MAX_ITEMS_LOOKED_UP = 24;

export type RenditionDescriptorReader = (viewerId: string, reference: string, signal: AbortSignal) => Promise<ImageVariantDescriptor>;

let testReader: ((sc: SupabaseClient) => RenditionDescriptorReader | null) | undefined;
/** Tests only: replace the configured ladder. `undefined` restores it. */
export function _setMemoryRenditionReaderForTest(f: ((sc: SupabaseClient) => RenditionDescriptorReader | null) | undefined): void {
  testReader = f;
}

/** The configured ladder's descriptor, or null while the environment switch is off or the configuration is invalid. */
function configuredReader(sc: SupabaseClient): RenditionDescriptorReader | null {
  if (testReader !== undefined) return testReader(sc);
  try {
    const service = createConfiguredImageVariants(sc)?.service;
    return service ? (viewerId, reference, signal) => service.descriptor(viewerId, { reference }, signal) : null;
  } catch {
    return null;
  }
}

/** The tiers a published descriptor offers, or null when it is not ready. Pure. */
export function selectRenditionTiers(descriptor: ImageVariantDescriptor, original: string): MemoryItemRenditions | null {
  if (!descriptor || descriptor.state !== "ready" || !Array.isArray(descriptor.variants)) return null;
  const byName = new Map(descriptor.variants.map((v) => [v.filename, v]));
  const pick = (tier: MemoryRenditionTier): MemoryRendition | null => {
    for (const name of MEMORY_RENDITION_TIERS[tier]) {
      const v = byName.get(name);
      if (v && typeof v.url === "string" && v.url.startsWith("/api/media/image-variants/")) {
        return { url: v.url, mime: v.mime, width: v.width, height: v.height };
      }
    }
    return null;
  };
  const tiers = { tiny: pick("tiny"), card: pick("card"), viewer: pick("viewer") };
  if (!tiers.tiny && !tiers.card && !tiers.viewer) return null;
  return { assetId: descriptor.assetId, sourceVersion: descriptor.sourceVersion, ...tiers, original };
}

type ItemLike = { mediaUrl?: unknown; mediaType?: unknown };

/** `memory_items.media_type` is a MIME type ("image/jpeg", the column default); "image" is accepted too. */
export function isImageItem(mediaType: unknown): boolean {
  return typeof mediaType === "string" && (mediaType === "image" || mediaType.startsWith("image/"));
}

/**
 * The same items, each image item carrying `renditions` when its generation is
 * published and the viewer may read it. Never throws; never removes an item.
 */
export async function withMemoryItemRenditions<T extends ItemLike>(
  sc: SupabaseClient,
  viewerId: string,
  items: T[],
  log?: { warn?: (o: object, m: string) => void },
  budgetMs: number = SELECTION_BUDGET_MS,
): Promise<Array<T & { renditions?: MemoryItemRenditions }>> {
  const reader = configuredReader(sc);
  if (!reader || items.length === 0) return items;
  const signal = AbortSignal.timeout(budgetMs);
  let looked = 0;
  const settled = await Promise.all(items.map(async (item) => {
    const url = typeof item.mediaUrl === "string" ? item.mediaUrl : "";
    if (!isImageItem(item.mediaType) || !url || looked >= MAX_ITEMS_LOOKED_UP || signal.aborted) return item;
    looked++;
    try {
      const descriptor = await Promise.race([
        reader(viewerId, url, signal),
        new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("rendition budget spent")), { once: true })),
      ]);
      const renditions = selectRenditionTiers(descriptor, url);
      return renditions ? { ...item, renditions } : item;
    } catch (err) {
      log?.warn?.({ err: String((err as Error)?.message ?? err) }, "memories: rendition lookup failed — serving the original");
      return item;
    }
  }));
  return settled;
}

// ── H182, wave 5 lane 5: list covers, and the ladder enqueued where a Memory photo is stored ──

/**
 * The same selection for a LIST's covers (`enrichMemories`: GET /memories,
 * GET /users/:id/memories, GET /me/saved-memories), keyed by Memory id. Each
 * cover keeps its original `mediaUrl`; a cover whose ladder is published for
 * this viewer gains `renditions`. Same gates, same budget, same cap
 * (MAX_ITEMS_LOOKED_UP covers per page), same "any failure is the original".
 * With the environment switch off it reads nothing.
 */
export async function withMemoryCoverRenditions<C extends { mediaUrl: string; mediaType: string }>(
  sc: SupabaseClient,
  viewerId: string,
  covers: Record<string, C>,
  log?: { warn?: (o: object, m: string) => void },
): Promise<Record<string, C & { renditions?: MemoryItemRenditions }>> {
  const ids = Object.keys(covers);
  if (ids.length === 0) return covers;
  const selected = await withMemoryItemRenditions(sc, viewerId, ids.map((id) => covers[id]), log);
  const out: Record<string, C & { renditions?: MemoryItemRenditions }> = {};
  ids.forEach((id, i) => { out[id] = selected[i] ?? covers[id]; });
  return out;
}

export type MemoryRenditionEnqueueOutcome =
  /** Not an image item: the ladder is image-only. */
  | "not_image"
  /** MEDIA_IMAGE_VARIANTS_ENABLED is not "1", or a 3980 flag is off. Nothing was read past the flags. */
  | "off"
  /** Not one of our canonical `post-media` objects, or not the Memory owner's own upload. */
  | "not_canonical"
  /** No (single) canonical media_assets row for the object (uploaded before canonical recording). */
  | "not_found"
  /** The ladder's own bridge refused (a hold, a stale generation, a mismatched row). */
  | "refused"
  /** Already enqueued for this asset generation by this process. No second call. */
  | "already_enqueued"
  | "enqueued"
  /** A read or the queue failed. Logged; the item stands, the original is served. */
  | "failed";

const ENQUEUED_MAX = 500;
const enqueuedThisProcess = new Map<string, string>();
/** Tests only. */
export function _resetMemoryRenditionEnqueueMemo(): void { enqueuedThisProcess.clear(); }

let testEnqueue: ((sc: unknown, subject: ImageVariantsIngestSubject, env: NodeJS.ProcessEnv) => Promise<string | null>) | undefined;
/** Tests only: replace the bridge's enqueue. `undefined` restores it. */
export function _setMemoryRenditionEnqueueForTest(f: typeof testEnqueue): void { testEnqueue = f; }

/**
 * Enqueue the image ladder for a photo just stored as a Memory item — the one
 * place a Memory image is stored: `POST /memories/:id/items` and
 * `POST /memories/:id/items/from-post` (routes/memories.ts, memory_items'
 * declared writer).
 *
 * WHY HERE AS WELL AS AT UPLOAD. `POST /api/media/upload` already reaches the
 * ladder: `runMediaVendorIngest` (lib/media/vendors/mediaVendorStages.ts) calls
 * `enqueueConfiguredImageVariants` for an image once its source generation is
 * approved. That is fire-and-forget and runs only for an upload made while
 * the switch and flags were on. A photo attached to a Memory later — an older
 * upload, a post's photo copied in by MD385, an upload whose enqueue failed —
 * would never get renditions. The attach is where the Memory first needs them.
 *
 * GATES, in order, each before any further read:
 *   1. an image item;
 *   2. MEDIA_IMAGE_VARIANTS_ENABLED === "1" (no read at all otherwise);
 *   3. the reference is one of our canonical `post-media` objects
 *      (`imageOriginalPath`, the reader's own parser) and the Memory owner's
 *      own (its owner path segment);
 *   4. `media_canonical_enabled` and `media_derivative_jobs_enabled` (3980),
 *      read through the ladder's own `access.enabled` — the reader's gate;
 *   5. exactly one canonical `media_assets` row for the object;
 *   6. `enqueueConfiguredImageVariants`, which re-checks the switch, the flags
 *      and that the row is current, and enqueues through 3980's
 *      `media_derivative_enqueue`.
 *
 * IDEMPOTENT PER ASSET. 3980's `media_derivative_enqueue` returns the existing
 * job for the same (asset, source version, kind, model) rather than inserting a
 * second; this process also remembers what it enqueued and does not call
 * again. Never throws: the item is already stored, and a rendition is an
 * optimisation of a photo the person can already see.
 */
export async function enqueueMemoryItemRenditions(
  sc: SupabaseClient,
  item: { mediaUrl: unknown; mediaType: unknown; ownerId: string },
  opts: { env?: NodeJS.ProcessEnv; log?: { warn?: (o: object, m: string) => void } } = {},
): Promise<{ outcome: MemoryRenditionEnqueueOutcome; jobId?: string }> {
  const env = opts.env ?? process.env;
  if (!isImageItem(item.mediaType)) return { outcome: "not_image" };
  if (env.MEDIA_IMAGE_VARIANTS_ENABLED !== "1") return { outcome: "off" };
  try {
    const config = imageVariantsConfigFromEnv(env);
    const url = typeof item.mediaUrl === "string" ? item.mediaUrl : "";
    const path = imageOriginalPath(url, config.storageOrigin);
    if (!path || path.split("/")[0] !== item.ownerId) return { outcome: "not_canonical" };
    const signal = AbortSignal.timeout(10_000);
    if (!(await createImageVariantsAccess(sc, config).enabled(signal))) return { outcome: "off" };
    const reply = await sc.from("media_assets").select("id, version, media_type")
      .eq("storage_bucket", "post-media").eq("storage_path", path).limit(2);
    if (reply.error) throw new Error(`media_assets: ${reply.error.message}`);
    const rows = (reply.data ?? []) as Array<{ id: unknown; version: unknown; media_type: unknown }>;
    if (rows.length !== 1) return { outcome: "not_found" };
    const row = rows[0];
    if (row.media_type !== "image") return { outcome: "not_image" };
    const key = `${String(row.id)}:${String(row.version)}`;
    const known = enqueuedThisProcess.get(key);
    if (known) return { outcome: "already_enqueued", jobId: known };
    const subject: ImageVariantsIngestSubject = {
      assetId: typeof row.id === "string" ? row.id : null,
      sourceVersion: typeof row.version === "number" ? row.version : null,
      bucket: "post-media", path, mediaType: "image",
    };
    const jobId = await (testEnqueue ?? enqueueConfiguredImageVariants)(sc, subject, env);
    if (!jobId) return { outcome: "refused" };
    if (enqueuedThisProcess.size >= ENQUEUED_MAX) {
      const oldest = enqueuedThisProcess.keys().next();
      if (!oldest.done) enqueuedThisProcess.delete(oldest.value);
    }
    enqueuedThisProcess.set(key, jobId);
    return { outcome: "enqueued", jobId };
  } catch (err) {
    opts.log?.warn?.({ err: String((err as Error)?.message ?? err) }, "memories: rendition enqueue failed — the item stands and its original is served");
    return { outcome: "failed" };
  }
}
