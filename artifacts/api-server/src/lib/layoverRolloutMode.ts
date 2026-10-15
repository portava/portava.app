/**
 * layoverRolloutMode — census-layover L242, spec §21: "Shadow mode in real
 * environments before high-confidence rollout."
 *
 * WHAT WAS TRUE BEFORE THIS FILE (census §59.4)
 * =============================================
 * One layover capability ran in shadow: the §5 lifecycle machine
 * (`layover_lifecycle_machine_enabled` OFF ⇒ the graph runs beside each write
 * and the overview, logs `layover_lifecycle_shadow` where it disagrees, and
 * publishes nothing; routes/airport.ts, the §5 LIFECYCLE block at its tail).
 * That is shadow mode for one capability, not a rollout MECHANISM: nothing else
 * could be run beside the live path, compared, and only then switched on.
 *
 * THE MECHANISM, MODELLED ON lib/discoveryEngineMode.ts (rulings D2=A, D3=B, D6)
 * ===========================================================================
 * One `feature_flags` row per capability. `enabled` is the master; `metadata.mode`
 * selects one of three states:
 *
 *   legacy  what every traveller gets today. The new code is not run.
 *   shadow  the new code runs BESIDE the live path; its answer is compared with
 *           the live one, the divergence is counted and logged, and NOTHING it
 *           produced is served. What the traveller receives is the legacy answer.
 *   on      the new code's answer is served.
 *
 * EVERY failure resolves to `legacy`: no client, no row, `enabled = false`, no
 * mode, an unrecognised mode, an unreadable row, a throw. Legacy is the current
 * production behaviour, so a failure here can only preserve what travellers
 * already get. The reason is kept beside the mode (`LayoverModeReason`), so
 * "it was legacy" and "the flag was unreadable" stay different facts.
 *
 * WHO — the optional tester cohort (lib/discoveryCohort.ts, ruling D6)
 * ====================================================================
 * A non-legacy mode applies only to the travellers its `metadata.cohort` names,
 * parsed and decided by `parseDiscoveryCohort` / `isInDiscoveryCohort`
 * themselves (not a copy):
 *
 *   { "mode": "shadow", "cohort": { "kind": "users", "userIds": ["…"] } }
 *   { "mode": "shadow", "cohort": { "kind": "percent", "percent": 5 } }
 *   { "mode": "on",     "cohort": { "kind": "all" } }
 *
 * The cohort fails closed the OTHER way from the mode: absent, malformed, an
 * unknown kind, or no user ⇒ NOBODY, so that user gets legacy. "Everyone" must
 * be TYPED (`kind: "all"`) — it is never what an omitted cohort means. The
 * percent bucket is the discovery bucket (same salt, `discovery-engine-mode/v1`):
 * a 5 % layover cohort is the same hashed 5 % of users as a 5 % discovery
 * cohort, and changing that salt reshuffles both. Recorded, not hidden.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * =============================
 * - No cache. `discoveryEngineMode` caches for 30 s because it sits above a
 *   cache fork on a hot path; a layover generation already reads several flags
 *   per request (`isFlagEnabled` caches nothing), and an uncached read means a
 *   flip back to legacy takes effect on the very next generation.
 * - No separate emergency stop. `enabled = false` IS the stop, and it fails
 *   towards legacy on any read error — the direction a stop must fail.
 * - THE FIVE LIVE FLAGS ARE UNTOUCHED (owner question OQ-7, default). The
 *   flags 0127 seeded TRUE run in production today with no shadow arm. Putting
 *   them through shadow or a cohort is a production change and the owner's
 *   decision; `LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW` names them so the registry
 *   below says so instead of being silent about them.
 */
import { getFlagRow } from "./featureFlags.js";
import { logger } from "./logger.js";
import {
  parseDiscoveryCohort, isInDiscoveryCohort, COHORT_NONE,
  type DiscoveryCohort, type CohortParseReason, type CohortDecision,
} from "./discoveryCohort.js";

/** census L78's objective ranking (services/airport/layoverObjective.ts). Seeded FALSE / legacy by 3784. */
export const LAYOVER_RANKING_MODE_FLAG = "layover_ranking_mode";

export const LAYOVER_ROLLOUT_MODES = ["legacy", "shadow", "on"] as const;
export type LayoverRolloutMode = (typeof LAYOVER_ROLLOUT_MODES)[number];

/**
 * Accepted `metadata.mode` spellings. A Map, not an object literal, for the
 * reason `discoveryEngineMode` gives: an object lookup answers `constructor`,
 * `toString` and `__proto__`, so a hand-typed `"mode": "constructor"` would
 * resolve to something truthy. A Map has no prototype chain.
 */
const MODE_SPELLINGS = new Map<string, LayoverRolloutMode>([
  ["legacy", "legacy"],
  ["shadow", "shadow"],
  ["on", "on"],
]);

/** `metadata.mode` → a mode, or null for anything unrecognised (the caller turns null into legacy). */
export function parseLayoverRolloutMode(raw: unknown): LayoverRolloutMode | null {
  if (typeof raw !== "string") return null;
  return MODE_SPELLINGS.get(raw) ?? null;
}

// ── the registry: which layover capabilities have a shadow arm ───────────────

/**
 * How a capability's shadow arm is switched.
 *   mode_row             this module's three-state row (legacy | shadow | on).
 *   boolean_off_shadows  one boolean flag: OFF runs the new code beside the live
 *                        path and logs, ON publishes it (the lifecycle machine).
 */
export type ShadowMechanism = "mode_row" | "boolean_off_shadows";

export interface ShadowArm {
  /** The feature_flags row that switches it. */
  flag: string;
  mechanism: ShadowMechanism;
  /** The structured log line its shadow arm writes where the two answers disagree. */
  shadowLog: string;
  /** The product file the shadow arm runs in, relative to artifacts/api-server/src. */
  file: string;
  /** census-layover rows it serves. */
  rows: readonly string[];
}

/**
 * Every layover capability that HAS a shadow arm. `src/test/layoverRollout.test.ts`
 * reads each `file` and requires its `shadowLog` and its `flag` to be there, so
 * an entry cannot outlive the code it describes.
 */
export const LAYOVER_SHADOW_ARMS = {
  ranking_objective: {
    flag: LAYOVER_RANKING_MODE_FLAG,
    mechanism: "mode_row",
    shadowLog: "layover_ranking_divergence",
    file: "services/airport/layoverRankingMode.ts",
    rows: ["L78", "L242"],
  },
  lifecycle_machine: {
    flag: "layover_lifecycle_machine_enabled",
    mechanism: "boolean_off_shadows",
    shadowLog: "layover_lifecycle_shadow",
    file: "routes/airport.ts",
    rows: ["L39", "L40", "L43"],
  },
} as const satisfies Record<string, ShadowArm>;

export type LayoverShadowCapability = keyof typeof LAYOVER_SHADOW_ARMS;

/** The capabilities this module resolves a three-state mode for. */
export type LayoverModeCapability = {
  [K in LayoverShadowCapability]: (typeof LAYOVER_SHADOW_ARMS)[K]["mechanism"] extends "mode_row" ? K : never;
}[LayoverShadowCapability];

/**
 * The five flags 0127 seeded TRUE (0127_layover_system.sql, "feature flags"):
 * live in production, with NO shadow arm. Owner question OQ-7 — should they go
 * through shadow or a tester cohort before further high-confidence rollouts? —
 * is OPEN, and its default is that they are untouched: no migration in this
 * change reads, re-seeds or wraps them.
 */
export const LAYOVER_LIVE_FLAGS_WITHOUT_SHADOW = [
  "airport_mode_enabled",
  "layover_safety_engine_enabled",
  "airport_pulse_enabled",
  "layover_plans_enabled",
  "layover_compass_enabled",
] as const;

// ── resolution ───────────────────────────────────────────────────────────────

/** Why the resolver returned what it did. A mode is never inferred from absence. */
export type LayoverModeReason =
  | "no_client"        // no service client to read with
  | "flag_absent"      // no row (or getFlagRow's fail-closed null on a read error)
  | "flag_disabled"    // row exists, enabled = false — the seed
  | "flag_unreadable"  // the resolver itself threw
  | "mode_missing"     // enabled, but metadata carries no mode
  | "mode_invalid"     // enabled, but metadata.mode is not legacy | shadow | on
  | "resolved";        // the configured mode was used as-is

export interface ResolvedLayoverMode {
  mode: LayoverRolloutMode;
  reason: LayoverModeReason;
  /** WHO a non-legacy mode applies to. Always `none` on legacy: legacy is what everyone already gets. */
  cohort: DiscoveryCohort;
  cohortReason: CohortParseReason;
}

const LEGACY = (reason: LayoverModeReason): ResolvedLayoverMode => ({
  mode: "legacy", reason, cohort: COHORT_NONE, cohortReason: "absent",
});

/**
 * Resolve a capability's rollout mode. NEVER THROWS; every unexpected state is
 * `legacy`. User-independent: decide the user with `layoverModeFor`.
 */
export async function resolveLayoverRolloutMode(sc: unknown, capability: LayoverModeCapability): Promise<ResolvedLayoverMode> {
  try {
    if (!sc) return LEGACY("no_client");
    // One capability today, so one literal read (check-flag-polarity resolves
    // the argument). A second mode_row capability adds its own case here.
    const row = capability === "ranking_objective" ? await getFlagRow(sc, LAYOVER_RANKING_MODE_FLAG) : null;
    // getFlagRow returns null on a read error AND on a missing row. Both mean
    // "no usable configuration" and both resolve to legacy.
    if (!row) return LEGACY("flag_absent");
    if (row.enabled !== true) return LEGACY("flag_disabled");
    const metadata = row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
    const raw = metadata?.mode;
    if (raw === undefined || raw === null) return LEGACY("mode_missing");
    const mode = parseLayoverRolloutMode(raw);
    if (mode === null) {
      logger.warn(
        { flag: LAYOVER_SHADOW_ARMS[capability].flag, mode: typeof raw === "string" ? raw.slice(0, 40) : typeof raw, modes: LAYOVER_ROLLOUT_MODES },
        "layoverRolloutMode: metadata.mode is not legacy | shadow | on — serving legacy",
      );
      return LEGACY("mode_invalid");
    }
    if (mode === "legacy") return LEGACY("resolved");
    const parsed = parseDiscoveryCohort(metadata?.cohort);
    if (parsed.reason !== "parsed") {
      logger.warn(
        { flag: LAYOVER_SHADOW_ARMS[capability].flag, mode, cohortReason: parsed.reason },
        "layoverRolloutMode: mode is non-legacy but metadata.cohort is unusable — the cohort is NOBODY, so every traveller gets legacy",
      );
    }
    return { mode, reason: "resolved", cohort: parsed.cohort, cohortReason: parsed.reason };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), capability }, "layoverRolloutMode: resolution threw — serving legacy");
    return LEGACY("flag_unreadable");
  }
}

export interface LayoverModeForUser {
  /** What THIS traveller's request runs: the resolved mode inside the cohort, legacy outside it. */
  mode: LayoverRolloutMode;
  resolved: ResolvedLayoverMode;
  /** Null on legacy: there is no cohort question to answer. */
  cohort: CohortDecision | null;
}

/** The mode for one traveller. Outside the cohort (or with no user id) the answer is legacy. */
export function layoverModeFor(resolved: ResolvedLayoverMode, userId: string | null | undefined): LayoverModeForUser {
  if (resolved.mode === "legacy") return { mode: "legacy", resolved, cohort: null };
  const decision = isInDiscoveryCohort(resolved.cohort, userId);
  return { mode: decision.included ? resolved.mode : "legacy", resolved, cohort: decision };
}
