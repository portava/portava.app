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
import { createConfiguredImageVariants } from "../../lib/media/imageVariants/bridge.js";
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
