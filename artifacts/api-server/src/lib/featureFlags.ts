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

/**
 * The stop's state could not be established.
 *
 * `isKillSwitchEngaged` is fail-closed on a DB error, and every caller was
 * written believing the whole check was. It was not: each guarded the read
 * behind a truthiness test on the service client, so an ABSENT client — the
 * shape a deployment takes when SUPABASE_SERVICE_ROLE_KEY is missing — skipped
 * the switch entirely and let the write through with a 2xx.
 *
 * Both operands of that `&&` are the same fact. This names it, so a door can
 * treat it as one:
 *
 *   const flagSc = getServiceClient();
 *   if (killSwitchStateUnknown(flagSc)) {
 *     sendError(res, 'degraded_unavailable', KILL_SWITCH_UNKNOWN_MESSAGE);
 *     return;
 *   }
 *   if (await isKillSwitchEngaged(flagSc!, 'disable_x')) { ... }
 *
 * `degraded_unavailable` and NOT `feature_disabled`: nobody engaged a stop. We
 * could not look, and telling a person their feature is switched off when it
 * may not be is a different false statement from the one we started with.
 *
 * `src/test/verifyFailOpenStopReads.test.ts` is the ratchet that keeps the old
 * shape from coming back.
 */
export function killSwitchStateUnknown(flagSc: unknown): boolean {
  return !flagSc;
}

/** What a person is told when the stop's state could not be established. */
export const KILL_SWITCH_UNKNOWN_MESSAGE =
  "We could not check whether this is available right now. Please try again shortly.";

// ── Rent-a-Buddy booking kill switches: WHICH one refused ─────────────────────
//
// Two flag names stop Rent-a-Buddy booking creation (FL-06: both are honoured).
// The five creation paths test them as `A || B` and answered one body for
// both, `{ error: "feature_disabled" }` — the SAME code the master flag
// `rent_buddy_enabled` answers with. The app could therefore not tell an
// operator's emergency stop from "the feature is not launched", nor say which
// of the two switches to turn off. Testing mode requires a refused gate to say
// exactly which gate refused and what unblocks it.
//
// This does NOT decide whether a booking is stopped: the call sites keep their
// own `if` unchanged, and only call this on the refusal path to NAME the
// switch in the body's `gate` field. It reads through `isKillSwitchEngaged`,
// so a switch whose state could not be read is named exactly as the gate
// treated it (fail-closed: engaged). If neither reads as engaged by the time
// this runs (a switch was released between the two reads), the pair's
// collective name is returned rather than a switch that is not on.
export const RAB_BOOKING_KILL_SWITCHES = ["disable_rent_buddy_booking", "disable_rab_bookings"] as const;

export async function engagedRabBookingKillSwitch(sc: any): Promise<string> {
  for (const flag of RAB_BOOKING_KILL_SWITCHES) {
    if (await isKillSwitchEngaged(sc, flag)) return flag;
  }
  return "rab_booking_kill_switch";
}

/**
 * Read a flag as one of THREE states: "on", "off" (row absent or false), or
 * "unknown" (the read failed or threw).
 *
 * For the flag whose ON means STRICTER — a control that adds a requirement, not
 * a feature that adds exposure — neither two-valued reader above is right.
 * `isFlagEnabled` answers false on an error, which switches the stricter path
 * off exactly when the database is unhealthy; `isKillSwitchEngaged` answers true,
 * which silently re-routes into the stricter path when the caller may have to
 * refuse instead. A caller that must REFUSE on an unreadable state needs to be
 * told the state was unreadable, so this says so.
 *
 * First caller: `routes/telegraphDiagnostics.ts` (census-telegraph T435, §45c
 * verifier finding 2) — with the durable-audit flag ON, an unreadable flag read
 * used to serve diagnostics with no durable audit row.
 */
export async function readFlagState(sc: any, flag: string): Promise<"on" | "off" | "unknown"> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", flag)
      .maybeSingle();
    if (error) return "unknown";
    return (data as any)?.enabled === true ? "on" : "off";
  } catch {
    return "unknown";
  }
}
