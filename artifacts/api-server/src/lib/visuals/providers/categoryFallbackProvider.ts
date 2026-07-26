/**
 * Category fallback provider.
 *
 * Never calls a paid API. Resolves a static, branded category image so every card
 * has an intentional header during loading, provider outage, disabled state,
 * moderation block, missing credentials, or usage-limit exhaustion.
 *
 * The actual asset URLs live in a config map the app can point at bundled assets or
 * a public storage path. Kept here so the fallback is a real, resolvable image and
 * not a broken placeholder.
 */
import type {
  ImageGenerationInput,
  ImageGenerationProvider,
  ImageGenerationResult,
  ProviderHealth,
} from "../types.js";

/**
 * Base URL prefix for category fallback images.
 *
 * In development the API server serves them at /fallbacks/<slug>.webp via
 * express.static (see app.ts).  In production, point this at a CDN base URL
 * (e.g. "https://cdn.example.com/fallbacks") by setting AI_VISUAL_FALLBACK_BASE.
 *
 * The default "/fallbacks" works with the built-in express.static middleware
 * and lets the mobile client convert to an absolute URL using its API base.
 */
const FALLBACK_BASE =
  process.env.AI_VISUAL_FALLBACK_BASE?.trim() ||
  "/fallbacks";

/** Canonical category → fallback slug. Unknown categories map to a generic tile. */
const CATEGORY_MAP: Record<string, string> = {
  restaurant: "restaurant",
  cafe: "cafe",
  "café": "cafe",
  nightclub: "nightclub",
  bar: "cocktail-bar",
  "cocktail bar": "cocktail-bar",
  hotel: "hotel",
  beach: "beach",
  landmark: "landmark",
  attraction: "attraction",
  "tourist attraction": "attraction",
  shopping: "shopping",
  wellness: "wellness",
  outdoor: "outdoor-adventure",
  "outdoor adventure": "outdoor-adventure",
  festival: "festival",
  meetup: "meetup",
  concert: "concert",
  "food event": "food-event",
  "sports event": "sports-event",
};

export function fallbackSlug(category: string | null | undefined, entityType: string): string {
  const key = (category ?? "").trim().toLowerCase();
  if (key && CATEGORY_MAP[key]) return CATEGORY_MAP[key];
  return entityType === "event" ? "generic-event" : "generic-place";
}

export function fallbackUrl(category: string | null | undefined, entityType: string): string {
  return `${FALLBACK_BASE}/${fallbackSlug(category, entityType)}.webp`;
}

export class CategoryFallbackProvider implements ImageGenerationProvider {
  readonly name = "category_fallback";

  async generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult> {
    const url = fallbackUrl(input.snapshot.category, input.snapshot.entityType);
    return {
      ok: true,
      provider: this.name,
      model: "static",
      imageDataUrl: url,
      costEstimate: 0,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { status: "present" };
  }
}
