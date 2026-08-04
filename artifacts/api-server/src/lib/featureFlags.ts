/**
 * Shared feature-flag helpers.
 *
 * Capability gates are fail-closed: every function returns false / null when
 * the DB is unavailable, so a partially configured rollout never exposes data.
 *
 * Memory note: column is `flag` (PK), not `key`.
 */

/**
 * Check whether a single feature flag is enabled.
 * Returns false on any error (fail-closed).
 */
export async function isFlagEnabled(sc: any, flag: string): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    if (error) return false;
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

/**
 * Fetch a single flag row including its metadata column.
 * Returns null on any error (fail-closed).
 */
export async function getFlagRow(
  sc: any,
  flag: string,
): Promise<{ enabled: boolean; metadata: Record<string, unknown> | null } | null> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled, metadata")
      .eq("flag", flag)
      .maybeSingle();
    if (error || !data) return null;
    return {
      enabled:  Boolean((data as any).enabled),
      metadata: (data as any).metadata ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The Live Places hierarchy is intentionally centralized. `external_places`
 * remains the independent gate for canonical place discovery; all experiential
 * surfaces also require the reversible `live_places_enabled` master switch.
 */
export const LIVE_PLACES_REQUIREMENTS: Record<string, readonly string[]> = {
  live_places_enabled: ["external_places_enabled"],
  place_days_enabled: ["external_places_enabled", "live_places_enabled"],
  shared_moments_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled"],
  shared_moments_compass_suggestions_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
  shared_moments_clustering_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
  place_recaps_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled"],
  moment_recaps_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
  live_places_world_feed_enabled: ["external_places_enabled", "live_places_enabled"],
  place_chat_enabled: ["external_places_enabled", "live_places_enabled"],
  shared_moments_chat_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
};

export function resolveFeatureFlags(rawFlags: Record<string, boolean>): Record<string, boolean> {
  const resolved = { ...rawFlags };
  for (const [flag, requirements] of Object.entries(LIVE_PLACES_REQUIREMENTS)) {
    if (flag in rawFlags) {
      resolved[flag] = rawFlags[flag] === true && requirements.every((parent) => rawFlags[parent] === true);
    }
  }
  return resolved;
}

export async function isLivePlacesCapabilityEnabled(sc: any, capability: keyof typeof LIVE_PLACES_REQUIREMENTS): Promise<boolean> {
  const requirements = LIVE_PLACES_REQUIREMENTS[capability];
  const flags = [capability, ...requirements];
  const values = await Promise.all(flags.map((flag) => isFlagEnabled(sc, flag)));
  return values.every(Boolean);
}
