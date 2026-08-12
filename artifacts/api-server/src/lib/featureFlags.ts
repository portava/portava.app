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
 * Read an EMERGENCY STOP flag. Returns true when the stop is ENGAGED.
 *
 * WHY THIS EXISTS SEPARATELY FROM isFlagEnabled
 * =============================================
 *
 * isFlagEnabled returns false on any error, and for an ordinary capability flag
 * that is the safe default: an unreadable flag means the feature stays off.
 *
 * A kill switch inverts the meaning of every value. `disable_tagging = true`
 * means STOP, so false-on-error means "do not stop" — the switch disengages
 * precisely when the database is unhealthy, which is the moment you are most
 * likely to be reaching for it. Reading a stop through isFlagEnabled is not a
 * safe default wearing the wrong name; it is the unsafe default.
 *
 * So the polarity of the FAILURE is inverted here, not the polarity of the
 * flag: a DB error means the stop engages. The flag row keeps its name, its
 * value and its meaning, so nothing about existing rows or the admin UI
 * changes — which is why this was chosen over renaming the flag to
 * `tagging_enabled`. Inverting the flag itself would make an ABSENT row (every
 * flag nobody has created, including all of them on a freshly restored CI
 * project) read as "disabled", turning a missing row into an outage.
 *
 * A missing row is therefore NOT engaged: maybeSingle() returns data=null with
 * error=null, which means "no such stop has been configured". Only a genuine
 * error — the state could not be established — engages it.
 */
export async function isKillSwitchEngaged(sc: any, flag: string): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    if (error) return true; // state unknown → treat as stopped
    return Boolean((data as any)?.enabled);
  } catch {
    return true; // state unknown → treat as stopped
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
