/**
 * mediaVisualFreshness — Media v2 Phase 10 (§19) coverage-gap awareness.
 *
 * "Last visual update 28m ago — show what's happening?" and the staleness a
 * Request-a-View targets. The FRESHNESS DECISION reuses the existing gated
 * freshness policy (lib/freshnessPolicy) — this module NEVER fabricates a live
 * label: when there is no recent visual observation, or no freshness policy for
 * the claim family, it reports "stale / unknown" and no live label.
 *
 * The pure formatter (formatAgo / buildVisualCoverage) is unit-testable; the one
 * IO function (readVisualCoverage) reads the freshest visual observation for a
 * place and runs it through freshnessPolicy.isStale.
 */
import { getPolicy } from "./freshnessPolicy.js";

/** Capture surfaces that carry a VISUAL perspective (a photo/video moment). */
export const VISUAL_CAPTURE_SURFACES = ["moment", "highlight", "postcard"] as const;

/**
 * Human "Nm ago" / "Nh ago" / "Nd ago" label for an age in ms. Null age (no
 * observation) ⇒ null (the caller renders "no recent visual update", never a
 * fabricated time).
 */
export function formatAgo(ageMs: number | null): string | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export interface VisualCoverage {
  /** ISO time of the freshest visual observation, or null when none. */
  lastObservedAt: string | null;
  /** Whole minutes since the freshest visual observation, or null when none. */
  ageMinutes: number | null;
  /** "28m ago", or null when there is no recent visual update. */
  lastUpdateLabel: string | null;
  /**
   * True when the freshest visual observation has aged past its claim-family TTL,
   * OR there is no observation, OR no freshness policy (fail-closed). A stale/
   * thin place is exactly what Request-a-View targets.
   */
  stale: boolean;
  /** True when the place has NO visual observation at all (a coverage void). */
  noCoverage: boolean;
}

/**
 * PURE: turn a freshest-observation timestamp + a staleness verdict into the
 * coverage view object. `stale` and `now`/`observedAt` are supplied by the
 * caller (which got `stale` from the gated freshnessPolicy).
 */
export function buildVisualCoverage(args: {
  lastObservedAt: string | null;
  stale: boolean;
  nowMs: number;
}): VisualCoverage {
  const { lastObservedAt } = args;
  if (!lastObservedAt) {
    return {
      lastObservedAt: null,
      ageMinutes: null,
      lastUpdateLabel: null,
      stale: true,         // no observation ⇒ treated as stale (a gap to fill)
      noCoverage: true,
    };
  }
  const obsMs = Date.parse(lastObservedAt);
  if (!Number.isFinite(obsMs)) {
    // Unparseable timestamp: fail-closed to a coverage void.
    return { lastObservedAt: null, ageMinutes: null, lastUpdateLabel: null, stale: true, noCoverage: true };
  }
  const ageMs = Math.max(0, args.nowMs - obsMs);
  return {
    lastObservedAt,
    ageMinutes: Math.floor(ageMs / 60000),
    lastUpdateLabel: formatAgo(ageMs),
    stale: args.stale,
    noCoverage: false,
  };
}

/**
 * Read the freshest VISUAL observation for a place + claim family and decide
 * staleness through the gated freshness policy. Fail-closed on every branch: a
 * read error, no observation, or no policy ⇒ stale / no live label.
 *
 * @param sc  service-role Supabase client (loose-typed at the boundary, per the
 *            freshnessPolicy / featureFlags convention).
 */
export async function readVisualCoverage(
  sc: any,
  args: { subjectId: string; claimFamily: string; nowMs?: number },
): Promise<VisualCoverage> {
  const nowMs = args.nowMs ?? Date.now();
  let lastObservedAt: string | null = null;
  try {
    const { data, error } = await sc
      .from("intel_observations")
      .select("observed_at")
      .eq("subject_id", args.subjectId)
      .eq("claim_type", args.claimFamily)
      .in("capture_surface", VISUAL_CAPTURE_SURFACES as unknown as string[])
      .order("observed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data && typeof (data as any).observed_at === "string") {
      lastObservedAt = (data as any).observed_at;
    }
  } catch {
    lastObservedAt = null; // fail-closed
  }

  if (!lastObservedAt) {
    return buildVisualCoverage({ lastObservedAt: null, stale: true, nowMs });
  }

  // Staleness comes from the GATED freshness policy — never fabricated here.
  // An unknown claim family / unreadable policy ⇒ getPolicy returns null ⇒ we
  // treat the observation as stale (no live label).
  let stale = true;
  try {
    const policy = await getPolicy(sc, args.claimFamily);
    if (policy) {
      const ageSeconds = (nowMs - Date.parse(lastObservedAt)) / 1000;
      stale = ageSeconds >= policy.ttlSeconds;
    }
  } catch {
    stale = true; // fail-closed
  }

  return buildVisualCoverage({ lastObservedAt, stale, nowMs });
}
