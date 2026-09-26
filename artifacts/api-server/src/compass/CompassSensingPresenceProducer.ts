/**
 * CompassSensingPresenceProducer — decision #9's producer, and the CONSENT
 * SCOPE it runs into.
 *
 * ── WHAT THIS CLOSES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 * `compass/CompassSensingPresence` is the formatter S39 needed and it names the
 * three things decision #9 takes: a migration seeding the flag (shipped,
 * 3004_sensing_presence_context_flag.sql), the owner flipping it, and A LANE
 * WIRING A PRODUCER TO THE FORMATTER. This file is that producer, and it is
 * wired into `routes/compass.ts` beside the live-claim block.
 *
 * It does NOT close S39, and the reason is not timidity — it is a scope the
 * contributions were never collected under. See the next section.
 *
 * ── THE READ-ONLY SHAPE, WHICH IS THE CONSERVATIVE ARM ───────────────────────
 * This producer serves ONLY aggregates that were ALREADY published, through
 * `lib/sensingDifferencingGate.publishThroughDifferencingGate`, into the
 * durable store 3110 creates — and only while they are unexpired.
 *
 * It cannot cause a publication. That is the whole design, and it is worth
 * saying why rather than leaving it to be inferred: if rendering context ran
 * the anti-differencing gate, then ASKING COMPASS A QUESTION WOULD BE A WAY TO
 * DRIVE PUBLICATIONS. An attacker who can pick when a cohort is published can
 * pick the moments to compare, which is the differencing attack the gate exists
 * to stop, re-opened one layer up through a conversational surface. So the
 * publish decision stays with whatever publisher the owner eventually builds,
 * and a conversation is a pure reader of what that publisher already decided.
 *
 * ── THE GATE THAT ACTUALLY REFUSES TODAY: `surface` IS NOT GRANTED ───────────
 * `lib/sensingContributionPolicy.SENSING_ANON_GRANTED_SCOPES` is exactly
 * `["collect", "retain", "aggregate"]`. Its own comment is explicit that
 * *"infer / personalize / surface / share are owner decisions and read as NOT
 * granted"*.
 *
 * Rendering a cohort aggregate into a conversation IS the `surface` scope. So
 * every row in 3110 was contributed under a policy that permits aggregating it
 * and does not permit showing it. Flipping
 * `sensing_presence_context_enabled` does not change that, and MUST NOT be able
 * to: a capability flag is an operational switch, not a consent grant.
 *
 * Hence the order of the two gates below. The SCOPE is checked first, before
 * the flag and before any database read, so that the flag cannot surface
 * anything the policy does not permit — not even transiently, not even for an
 * operator who flips it by mistake. Granting the scope is a one-line change to
 * `SENSING_ANON_GRANTED_SCOPES` and it is a DIFFERENT owner act from #9's flag;
 * this module does not make it and must not.
 *
 * WHAT THAT MEANS FOR THE OUTPUT TODAY, SAID PLAINLY: this producer returns no
 * lines, on every call, because `surface` is ungranted. That is not a stub and
 * not dead code — it is a consent check that currently refuses, wired at the
 * one place a sensing aggregate could reach a user. Nothing else in the tree
 * enforces the `surface` scope at a render point.
 */
import {
  SENSING_ANON_POLICY_V1,
  type ContributionPurposeScope,
  type IntelligenceContributionPolicy,
} from "../lib/sensingContributionPolicy.js";
import {
  aggregateFromPublicationRow,
  readLastPublishedAggregate,
  type PublicationStore,
} from "../lib/sensingDifferencingGate.js";
import { buildSensingPresenceState } from "../lib/sensingPresenceState.js";
import {
  buildSensingPresenceLines,
  readSensingPresenceGate,
  SENSING_PRESENCE_ZONE_CAP,
  type ConsumablePresenceState,
} from "./CompassSensingPresence.js";

/** The purpose scope rendering an aggregate into a conversation requires. */
export const SENSING_SURFACE_SCOPE: ContributionPurposeScope = "surface";

/**
 * Why nothing was rendered. OPERATOR DIAGNOSTICS ONLY — never returned to a
 * caller that puts them in a prompt, for the same reason the formatter refuses
 * to render `withheld`: which gate refused a zone is itself a fact about that
 * zone's cohort.
 */
export type SensingPresenceRefusal =
  | "surface_scope_not_granted"
  | "capability_off"
  | "no_cohorts"
  | "publication_unreadable"
  | "no_live_publication";

/** One cohort a caller wants presence for. Coarse zone label; never a coordinate. */
export interface SensingPresenceCohortRef {
  zoneId: string;
  /** ISO start of the privacy time bucket, already floored by whoever published it. */
  timeBucket: string;
  /**
   * The publication identity, exactly as the publisher recorded it on the row.
   * This module does NOT derive it: deriving a cohort key here would mean
   * naming the contribution store, and the whole point of reading only the
   * publication store is that this file never touches the other one.
   */
  cohortKey: string;
  reductionVersion?: number;
}

export interface SensingPresenceContext {
  /** Prompt lines, already formatted and gated. Empty whenever anything refused. */
  lines: string[];
  states: ConsumablePresenceState[];
  refusals: Array<{ zoneId: string; reason: SensingPresenceRefusal }>;
}

export const EMPTY_SENSING_PRESENCE_CONTEXT: SensingPresenceContext = Object.freeze({
  lines: Object.freeze([]) as unknown as string[],
  states: Object.freeze([]) as unknown as ConsumablePresenceState[],
  refusals: Object.freeze([]) as unknown as Array<{ zoneId: string; reason: SensingPresenceRefusal }>,
});

/**
 * Whether the contribution policy permits showing an aggregate at all.
 *
 * Reads the POLICY, not a flag, because this is a CONSENT question and not an
 * operational one: a database cannot answer it and an operator must not be able
 * to. The policy is a parameter defaulting to the frozen one for the same
 * reason `lib/sensingContributionPolicy.sensingAdmission` takes it that way —
 * the admission rules are a pure function OF a policy, so they can be proved
 * against one without the production constant having to change. Every
 * production caller takes the default; the test below pins that the default
 * refuses.
 */
export function sensingSurfaceScopeGranted(
  policy: IntelligenceContributionPolicy = SENSING_ANON_POLICY_V1,
): boolean {
  return (policy?.purposeScopes ?? []).includes(SENSING_SURFACE_SCOPE);
}

export interface SensingPresenceContextOptions {
  nowMs?: number;
  /** Defaults to the one policy in force. See `sensingSurfaceScopeGranted`. */
  policy?: IntelligenceContributionPolicy;
}

/**
 * Build the presence context block for a turn. Never throws; every failure is a
 * refusal with no lines.
 */
export async function buildSensingPresenceContext(
  db: PublicationStore | null | undefined,
  cohorts: readonly SensingPresenceCohortRef[] | null | undefined,
  options: SensingPresenceContextOptions = {},
): Promise<SensingPresenceContext> {
  const requested = (cohorts ?? []).filter(
    (c) => c && typeof c.zoneId === "string" && c.zoneId !== "" && typeof c.cohortKey === "string" && c.cohortKey !== "",
  );

  // GATE 1 — CONSENT, before the flag and before any read. An ungranted scope
  // refuses whatever the flag says and whatever the store holds.
  if (!sensingSurfaceScopeGranted(options.policy ?? SENSING_ANON_POLICY_V1)) {
    return {
      lines: [],
      states: [],
      refusals: requested.map((c) => ({ zoneId: c.zoneId, reason: "surface_scope_not_granted" as const })),
    };
  }

  if (requested.length === 0) return { lines: [], states: [], refusals: [] };

  // GATE 2 — the capability. Fail-closed on an absent row, a false row, an
  // unreadable flag and a missing client alike.
  const permission = await readSensingPresenceGate(db);
  if (permission.enabled !== true) {
    return {
      lines: [],
      states: [],
      refusals: requested.map((c) => ({ zoneId: c.zoneId, reason: "capability_off" as const })),
    };
  }

  // The cap is applied BEFORE the reads, not after: it bounds the work a single
  // turn can ask of the publication store, not merely what is rendered.
  const considered = requested.slice(0, SENSING_PRESENCE_ZONE_CAP);
  const nowMs = Number.isFinite(options.nowMs as number) ? (options.nowMs as number) : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const states: ConsumablePresenceState[] = [];
  const refusals: Array<{ zoneId: string; reason: SensingPresenceRefusal }> = [];

  for (const cohort of considered) {
    const read = await readLastPublishedAggregate(db as PublicationStore, cohort.cohortKey, nowIso);

    // A FAILED READ IS NOT AN EMPTY ONE. Both render "not known" — the surface
    // must never learn which — but the operator diagnostic keeps them apart.
    if (!read.ok) {
      refusals.push({ zoneId: cohort.zoneId, reason: "publication_unreadable" });
      states.push(
        buildSensingPresenceState({
          zoneId: cohort.zoneId,
          timeBucket: cohort.timeBucket,
          aggregate: { publishable: false, reason: "read_failed", distinctActors: 0, distinctGroups: 0, maxGroupShare: 0, contributions: 0, observedAt: null, medianSignalBucket: null },
          nowMs,
          reductionVersion: cohort.reductionVersion,
        }),
      );
      continue;
    }

    if (!read.row) {
      refusals.push({ zoneId: cohort.zoneId, reason: "no_live_publication" });
      states.push(
        buildSensingPresenceState({
          zoneId: cohort.zoneId,
          timeBucket: cohort.timeBucket,
          aggregate: { publishable: false, reason: "no_live_publication", distinctActors: 0, distinctGroups: 0, maxGroupShare: 0, contributions: 0, observedAt: null, medianSignalBucket: null },
          nowMs,
          reductionVersion: cohort.reductionVersion,
        }),
      );
      continue;
    }

    // A stored row exists only because a PUBLISHABLE aggregate was served
    // through the differencing gate, so the k-floor and the anti-differencing
    // rule were both satisfied at publication time and are not re-litigated
    // here. What this path still owns is the TIME: the row's own bucket and its
    // freshness, which `buildSensingPresenceState` derives.
    states.push(
      buildSensingPresenceState({
        zoneId: cohort.zoneId,
        timeBucket: cohort.timeBucket,
        aggregate: aggregateFromPublicationRow(read.row),
        nowMs,
        reductionVersion: read.row.reduction_version,
      }),
    );
  }

  return { lines: buildSensingPresenceLines(states, permission), states, refusals };
}
