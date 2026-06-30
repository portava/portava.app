/**
 * Shared feature-flag helpers.
 *
 * FAIL-OPEN contract: every function returns false / null when the DB is
 * unavailable so a DB outage never silently blocks users.
 *
 * Memory note: column is `flag` (PK), not `key`.
 */

/**
 * Check whether a single feature flag is enabled.
 * Returns false on any error (fail-open).
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
 * Returns null on any error (fail-open).
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
