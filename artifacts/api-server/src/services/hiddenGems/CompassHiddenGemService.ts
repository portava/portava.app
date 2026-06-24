/**
 * CompassHiddenGemService
 *
 * Dedicated enforcement wrapper for Hidden Gems in Compass/LLM context.
 *
 * Responsibilities:
 * - Feature-flag gate: hidden_gems_compass_enabled must be true
 * - Strict inclusion: only sensitivity_level = 'public' gems
 * - Strict verification: only community/guide/gps_verified/admin
 * - LLM safety: no coordinates, no protected/sensitive content
 * - Structured prompt fragment: formatted text + typed gem objects
 *
 * Call getCompassGemContext() instead of querying hidden_gems directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface CompassGemEntry {
  name: string;
  category: string;
  city: string;
  neighborhood: string | null;
  verificationLevel: string;
  priceRange: string | null;
  vibeTags: string[];
}

export interface CompassGemContext {
  enabled: boolean;
  gems: CompassGemEntry[];
  promptFragment: string;
}

const COMPASS_SAFE_VERIFICATION_LEVELS = ["community", "guide", "gps_verified", "admin"] as const;

/**
 * Build a gem context object safe to inject into Compass prompts.
 * Returns `{ enabled: false, gems: [], promptFragment: "" }` when flag is off.
 */
export async function getCompassGemContext(
  db: SupabaseClient,
  city: string | null | undefined,
): Promise<CompassGemContext> {
  const empty: CompassGemContext = { enabled: false, gems: [], promptFragment: "" };
  if (!city) return empty;

  try {
    const { data: flag } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("key", "hidden_gems_compass_enabled")
      .maybeSingle();

    if (!(flag as any)?.enabled) return empty;

    const { data: rows } = await db
      .from("hidden_gems")
      .select("name, category, city, neighborhood, verification_level, price_range, vibe_tags")
      .eq("status", "active")
      .eq("sensitivity_level", "public")          // STRICT: public only — never leak sensitive gems
      .ilike("city", city)
      .in("verification_level", COMPASS_SAFE_VERIFICATION_LEVELS)
      .limit(5);

    const gems: CompassGemEntry[] = (rows ?? []).map((g: any) => ({
      name:              g.name,
      category:          g.category,
      city:              g.city,
      neighborhood:      g.neighborhood ?? null,
      verificationLevel: g.verification_level,
      priceRange:        g.price_range ?? null,
      vibeTags:          g.vibe_tags ?? [],
    }));

    if (gems.length === 0) return { enabled: true, gems: [], promptFragment: "" };

    // Format a structured prompt fragment — no coordinates, no private details
    const lines = gems.map((g) => {
      const tags = g.vibeTags.length > 0 ? ` [${g.vibeTags.slice(0, 3).join(", ")}]` : "";
      const price = g.priceRange ? ` (${g.priceRange})` : "";
      const area = g.neighborhood ? ` — ${g.neighborhood}` : "";
      return `• ${g.name} (${g.category}${price})${area}${tags} — ${g.verificationLevel} verified`;
    });

    const promptFragment = [
      `Hidden gems in ${city} known to locals:`,
      ...lines,
    ].join("\n");

    return { enabled: true, gems, promptFragment };
  } catch {
    return empty;
  }
}

/**
 * Returns true if a gem is LLM-safe (may be included in prompts).
 * Protected, reveal_after_save, and reveal_after_acceptance gems must never
 * appear in LLM output — their exact location is private.
 */
export function isGemLlmSafe(sensitivityLevel: string): boolean {
  return sensitivityLevel === "public" || sensitivityLevel === "approximate";
}
