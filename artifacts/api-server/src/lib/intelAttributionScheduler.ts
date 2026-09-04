/**
 * Intelligence Gathering — ATTRIBUTION job (unit I4a, spec §14 Table 22 / §21).
 *
 * The driver that turns outcome EVENTS into attribution ROWS:
 *
 *   1. read outcome events from the canonical spine (verb ∈ arrival / completion /
 *      rejection whose payload.intel is the shared I4a/I4b envelope);
 *   2. anti-join against intel_attributions so each outcome is attributed at
 *      most once per algorithm version (the 2277 unique index is the real
 *      guarantee — 23505 ⇒ replay);
 *   3. resolve the served claim and its INPUT observations — the observations
 *      sharing the claim's (subject, zone, claim_type) natural key (the same key
 *      the projection aggregates on and the RewardOracle joins on), admissible
 *      by moderation, and observed inside the claim family's hard-expiry window
 *      ending at served_at;
 *   4. derive Table-22 weights (lib/intelAttribution — pure), normalized so
 *      Σ ≤ 1.0 per outcome, with the counterfactual answer discounting to the
 *      pre-committed band, and write the rows;
 *   5. when the outcome CONTRADICTS the served state, the rows carry
 *      contradiction = true and a structured log line names the claim for the
 *      correction path. Claims are never mutated here.
 *
 * Gated on `intel_outcome_attribution_enabled`, fail-closed, self-rescheduling —
 * the house scheduler shape (intelRewardScheduler). Off ⇒ an inert no-op that
 * reads and writes nothing. Runs after the reward pass's inputs exist.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { CLAIM_TYPES, isPilotClaimable } from "./intelContracts.js";
import {
  OUTCOME_VERBS, ATTRIBUTION_TOUCHES, TRAVELER_MODES, isIntelOutcomePayload,
  type AttributionTouch, type TravelerMode,
} from "./intelOutcomes.js";
import { deriveAttributions, ATTRIBUTION_ALGORITHM_VERSION, type AttributionRow, type Contribution } from "./intelAttribution.js";
import { buildScopeKey, scopeFor } from "./intelScopedTrust.js";

export const ATTRIBUTION_FLAG = "intel_outcome_attribution_enabled";
// After promotion (2m) + projection (3m) + reward (6m): outcomes reference
// snapshots those passes produce, and the reward oracle reads what this writes.
const STARTUP_DELAY_MS = 8 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

const MAX_EVENTS = 2000;
const MAX_OBS = 20000;
const IN_CHUNK = 300;
/** Fallback input window when a claim type has no registered hard expiry. */
const DEFAULT_HARD_EXPIRY_SECONDS = 2 * 60 * 60;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface AttributionPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  /** Outcome events seen with a valid envelope. */
  events: number;
  /** Events attributed THIS pass (rows newly written). */
  attributed: number;
  rows: number;
  /** Events already attributed (anti-join or 23505). */
  replayed: number;
  /** Events with no contributing observation behind the served claim. */
  unattributable: number;
  contradictions: number;
  /** Rows the scoped-trust step applied this pass (see intelScopedTrustApply). */
  trustApplied: number;
}

const EMPTY: AttributionPassResult = {
  skipped: true, reason: null, events: 0, attributed: 0, rows: 0, replayed: 0, unattributable: 0, contradictions: 0, trustApplied: 0,
};

const TOUCH_SET = new Set<string>(ATTRIBUTION_TOUCHES);
const MODE_SET = new Set<string>(TRAVELER_MODES);

const natKey = (subjectId: string, zoneId: string | null | undefined, claimType: string): string =>
  `${subjectId}|${zoneId ?? ""}|${claimType}`;

function hardExpirySecondsFor(claimType: string): number {
  return CLAIM_TYPES.find((c) => c.claimType === claimType)?.hardExpirySeconds ?? DEFAULT_HARD_EXPIRY_SECONDS;
}

/** Fetch rows for an `in(column, ids)` filter in bounded chunks. */
async function fetchIn<T>(
  db: any, table: string, columns: string, column: string, ids: string[],
  refine?: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const slice = ids.slice(i, i + IN_CHUNK);
    let q = db.from(table).select(columns).in(column, slice);
    if (refine) q = refine(q);
    const { data, error } = await q;
    if (error) throw error;
    if (data) out.push(...(data as T[]));
  }
  return out;
}

interface EventRow { id: string; actor_id: string | null; occurred_at: string; confidence: number | null; payload: any }
interface ClaimRow { id: string; subject_id: string; zone_id: string | null; claim_type: string }
interface ObsRow { id: string; actor_id: string; subject_id: string; zone_id: string | null; claim_type: string; observed_at: string; moderation_state: string }
interface PlaceRow { id: string; city: string | null; country_code: string | null; latitude: number | null; longitude: number | null }

/**
 * Optional post-write hook — the scoped-trust applier (slice 3) registers here
 * so the attribution pass stays testable on its own. Returns rows applied.
 */
export type TrustApplier = (db: any, rows: readonly AttributionRow[], now: Date) => Promise<number>;
let _trustApplier: TrustApplier | null = null;
export function setTrustApplier(fn: TrustApplier | null): void { _trustApplier = fn; }

export async function runIntelAttributionPass(opts: { client?: any; now?: Date } = {}): Promise<AttributionPassResult> {
  // Explicit null ⇒ "no client"; undefined ⇒ the service client (house pattern).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...EMPTY, reason: "no_client" };
  if (!(await isFlagEnabled(db, ATTRIBUTION_FLAG))) return { ...EMPTY, reason: "disabled" };

  const now = opts.now ?? new Date();

  try {
    // 1. Outcome events with the shared envelope.
    const { data: evData, error: evErr } = await db
      .from("canonical_events")
      .select("id, actor_id, occurred_at, confidence, payload")
      .in("verb", OUTCOME_VERBS as unknown as string[])
      .order("occurred_at", { ascending: false })
      .limit(MAX_EVENTS);
    if (evErr) { logger.warn({ err: evErr }, "attribution pass: outcome-event read failed"); return { ...EMPTY, reason: "error" }; }
    const outcomes = ((evData ?? []) as EventRow[]).filter((e) => e.id && isIntelOutcomePayload(e.payload?.intel));
    const tally = { events: outcomes.length, attributed: 0, rows: 0, replayed: 0, unattributable: 0, contradictions: 0, trustApplied: 0 };
    if (outcomes.length === 0) return { skipped: false, reason: null, ...tally };

    // 2. Anti-join on already-attributed events (this algorithm version).
    const already = new Set<string>();
    const prior = await fetchIn<{ outcome_event_id: string }>(
      db, "intel_attributions", "outcome_event_id", "outcome_event_id", outcomes.map((e) => e.id),
      (q) => q.eq("algorithm_version", ATTRIBUTION_ALGORITHM_VERSION),
    );
    for (const p of prior) already.add(p.outcome_event_id);
    const pending = outcomes.filter((e) => !already.has(e.id));
    tally.replayed += outcomes.length - pending.length;
    if (pending.length === 0) return { skipped: false, reason: null, ...tally };

    // 3. Served claims, their input observations, and the subjects' places.
    const claimIds = [...new Set(pending.map((e) => e.payload.intel.claim_id as string))];
    const claims = new Map<string, ClaimRow>();
    for (const c of await fetchIn<ClaimRow>(db, "intel_claims", "id, subject_id, zone_id, claim_type", "id", claimIds)) claims.set(c.id, c);
    const subjectIds = [...new Set([...claims.values()].map((c) => c.subject_id))];
    const observations = subjectIds.length === 0 ? [] : await fetchIn<ObsRow>(
      db, "intel_observations",
      "id, actor_id, subject_id, zone_id, claim_type, observed_at, moderation_state",
      "subject_id", subjectIds, (q) => q.limit(MAX_OBS),
    );
    const obsByKey = new Map<string, ObsRow[]>();
    for (const o of observations) {
      if (!o.id || !o.actor_id || !isPilotClaimable(o.moderation_state)) continue;
      const k = natKey(o.subject_id, o.zone_id, o.claim_type);
      const arr = obsByKey.get(k) ?? [];
      arr.push(o); obsByKey.set(k, arr);
    }
    const places = new Map<string, PlaceRow>();
    for (const p of subjectIds.length === 0 ? [] : await fetchIn<PlaceRow>(db, "places", "id, city, country_code, latitude, longitude", "id", subjectIds)) places.set(p.id, p);

    // 4. Derive + write, one outcome at a time (a per-event error never aborts the pass).
    const written: AttributionRow[] = [];
    for (const e of pending) {
      const intel = e.payload.intel;
      const claim = claims.get(intel.claim_id);
      if (!claim) { tally.unattributable++; continue; }

      const servedMs = Date.parse(intel.served_at);
      const windowStart = servedMs - hardExpirySecondsFor(claim.claim_type) * 1000;
      const contributions: Contribution[] = (obsByKey.get(natKey(claim.subject_id, claim.zone_id, claim.claim_type)) ?? [])
        .filter((o) => {
          const t = Date.parse(o.observed_at);
          return Number.isFinite(t) && t <= servedMs && t >= windowStart;
        })
        .map((o) => ({ observationId: o.id, actorId: o.actor_id }));
      if (contributions.length === 0) { tally.unattributable++; continue; }

      const touch: AttributionTouch = TOUCH_SET.has(e.payload.touch) ? e.payload.touch : "impression"; // unknown touch ⇒ weight 0 (fail-closed)
      const travelerMode: TravelerMode | null = MODE_SET.has(e.payload.traveler_mode) ? e.payload.traveler_mode : null;
      const scope = scopeFor({ place: places.get(claim.subject_id) ?? null, claimType: claim.claim_type, servedAt: intel.served_at, travelerMode });
      const rows = deriveAttributions({
        outcomeEventId: e.id,
        outcome: intel,
        touch,
        counterfactualSameChoice: e.payload.counterfactual_same_choice === true,
        servedConfidence: e.confidence,
        contributions,
        scopeKey: buildScopeKey(scope),
        computedAt: now,
      });

      const { error: insErr } = await db.from("intel_attributions").insert(rows);
      if (insErr) {
        if (insErr.code === "23505") { tally.replayed++; continue; }
        logger.warn({ err: insErr, outcome_event_id: e.id }, "attribution pass: insert rejected (continuing)");
        continue;
      }
      tally.attributed++;
      tally.rows += rows.length;
      written.push(...rows);

      if (rows[0]?.contradiction) {
        tally.contradictions++;
        // The correction-path signal (§14 / Table 29 intel.claim.corrected consumer):
        // structured, no identities, names the claim so a reviewer can act.
        logger.info({
          event: "intel.attribution.contradiction",
          outcome_event_id: e.id,
          claim_id: claim.id,
          subject_id: claim.subject_id,
          zone_id: claim.zone_id,
          claim_type: claim.claim_type,
          outcome: intel.outcome,
          expected_accuracy: rows[0].expected_accuracy,
          contributors: rows.length,
          scope_key: rows[0].scope_key,
        }, "intel attribution: outcome contradicts the served state — recorded for the correction path");
      }
    }

    // 5. Scoped trust (registered by intelScopedTrustApply; absent ⇒ nothing applied).
    if (_trustApplier && written.length > 0) {
      try {
        tally.trustApplied = await _trustApplier(db, written, now);
      } catch (err) {
        logger.warn({ err }, "attribution pass: scoped-trust application threw (rows are written; trust replays next pass)");
      }
    }

    if (tally.attributed > 0 || tally.contradictions > 0) logger.info(tally, "attribution pass complete");
    return { skipped: false, reason: null, ...tally };
  } catch (err) {
    logger.warn({ err }, "attribution pass threw");
    return { ...EMPTY, reason: "error" };
  }
}

export function startIntelAttributionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: ATTRIBUTION_FLAG },
    "IntelAttributionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelAttributionPass()
      .catch((err) => logger.warn({ err }, "attribution pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelAttributionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
