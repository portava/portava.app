/**
 * Intelligence Gathering — reward PRODUCER scheduler (rewards internal, IG-10/§23).
 *
 * The missing driver that makes intel_reward_ledger stop being dead code.
 * services/intel/RewardService.recordEarnedReward had exactly one writer and no
 * caller but tests; the pure eligibility gate only ever saw caller-supplied
 * booleans. This scheduler is the autonomous earning loop:
 *
 *   1. read the SERVED state (intel_state_snapshots, privacy_eligible & unexpired)
 *      — a contributor's evidence that reached the live state, having passed the
 *      downstream privacy gate;
 *   2. find the admissible, consented OBSERVATIONS behind those served subjects
 *      (join by the same (subject, zone, claim_type) natural key the projection
 *      keys on) that have NOT already been rewarded;
 *   3. assemble eligibility from REAL state via the oracle (services/intel/
 *      RewardOracle) — NOT from caller input;
 *   4. book each qualifying contribution once via recordEarnedReward, keyed on
 *      the observation id so an at-least-once run can never double-credit.
 *
 * EARNING EVENT = "a contributor's observation reached the served live state."
 * Chosen because it is the strongest "finalized, policy-eligible outcome" (§4)
 * signal the data model actually carries: a privacy-eligible snapshot has already
 * cleared moderation, consent, freshness, the confidence bands AND the k-anonymity
 * privacy gate. The observation id is the natural unique key — one earning per
 * contribution, forever, on an append-only ledger.
 *
 * THE HONEST ORACLE (unit I4a). With intel_outcome_attribution_enabled ON, "served"
 * is no longer enough: the candidate must ALSO carry a finalized, non-contradicting,
 * graded attribution row (intel_attributions, 2277) — a traveler went, reported an
 * outcome, and it did not contradict the served state. The producer reads those
 * rows and classifies them (services/intel/RewardOracle.classifyAttribution); a
 * contradiction or the absence of any outcome leaves the contribution unrewarded
 * and reconsidered next pass. With the flag OFF the candidate is marked
 * `not_required` and the pre-I4a behaviour is byte-for-byte unchanged.
 *
 * Gated on `intel_rewards`, fail-closed, self-rescheduling — the house scheduler
 * shape (see intelPromotionScheduler / intelCoverageScheduler). Off ⇒ an inert
 * no-op that reads and writes nothing. NON-CASH only: cash_amount is 0, enforced
 * by the table CHECK. It edits no projection/serve/capture code — it hooks purely
 * via the existing intel_* table outputs.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { recordEarnedReward } from "../services/intel/RewardService.js";
import {
  buildRewardEligibilityContext,
  candidateQiu,
  classifyAttribution,
  CURRENT_REWARD_LEDGER_VERSION,
  type EarningCandidate,
  type OutcomeAttribution,
} from "../services/intel/RewardOracle.js";
import { evaluateRewardEligibility } from "./rewardEligibility.js";
import { ATTRIBUTION_FLAG } from "./intelAttributionScheduler.js";

const REWARDS_FLAG = "intel_rewards";
// After promotion (2m) + projection (3m) so served snapshots for freshly promoted
// claims exist before the first reward pass runs.
const STARTUP_DELAY_MS = 6 * 60 * 1000;
const INTERVAL_MS = 15 * 60 * 1000;

const MAX_SNAPSHOTS = 5000;
const MAX_OBS = 20000;
const IN_CHUNK = 300;

// The natural, per-contribution idempotency key. `observation:<id>` books each
// observation at most once (the ledger's partial unique index on
// (actor_id, idempotency_key) enforces it; recordEarnedReward turns the 23505 into
// a replay). Mirrored into the anti-join below so an already-rewarded contribution
// is not even reconsidered.
const KEY_PREFIX = "observation:";
const rewardKeyFor = (observationId: string): string => `${KEY_PREFIX}${observationId}`;

const REWARD_SOURCE = "served";

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface RewardPassResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  candidates: number;
  booked: number;   // ledger rows newly written this pass
  replayed: number; // already-rewarded contributions re-seen (no new row)
  ineligible: number;
}

const EMPTY: RewardPassResult = {
  skipped: true, reason: null, candidates: 0, booked: 0, replayed: 0, ineligible: 0,
};

const snapKey = (subjectId: string, zoneId: string | null | undefined, claimType: string): string =>
  `${subjectId}|${zoneId ?? ""}|${claimType}`;

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

interface SnapshotRow { subject_id: string; zone_id: string | null; claim_type: string; confidence: number | null }
interface ObsRow {
  id: string; actor_id: string; subject_id: string; zone_id: string | null;
  claim_type: string; moderation_state: string;
}
interface ConsentRow { user_id: string; enabled: boolean; withdrawn_at: string | null }
interface LedgerRow { actor_id: string; idempotency_key: string | null }
interface AttributionRow { observation_id: string; contradiction: boolean; outcome_score: number | string | null }

export async function runIntelRewardPass(opts: { client?: any; now?: Date } = {}): Promise<RewardPassResult> {
  // Explicit null ⇒ "no client"; undefined ⇒ use the service client (house pattern —
  // see intelPromotionScheduler / intelCoverageScheduler; `??` would be wrong).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...EMPTY, reason: "no_client" };
  // Gate the whole pass: off ⇒ no scan, no writes. recordEarnedReward re-checks the
  // same flag per call, so this is defence in depth, not the only guard.
  if (!(await isFlagEnabled(db, REWARDS_FLAG))) return { ...EMPTY, reason: "disabled" };

  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();

  try {
    // 1. SERVED state: privacy-eligible, un-expired snapshots. Map every served
    //    (subject, zone, claim_type) key → its realized confidence (the QIU proxy).
    const { data: snapData, error: snapErr } = await db
      .from("intel_state_snapshots")
      .select("subject_id, zone_id, claim_type, confidence")
      .eq("privacy_eligible", true)
      .gt("expires_at", nowIso)
      .limit(MAX_SNAPSHOTS);
    if (snapErr) { logger.warn({ err: snapErr }, "reward pass: served-snapshot read failed"); return { ...EMPTY, reason: "error" }; }
    const snapshots = (snapData ?? []) as SnapshotRow[];
    if (snapshots.length === 0) return { skipped: false, reason: null, candidates: 0, booked: 0, replayed: 0, ineligible: 0 };

    const servedConfidence = new Map<string, number | null>();
    const servedSubjects = new Set<string>();
    for (const s of snapshots) {
      if (!s.subject_id || !s.claim_type) continue;
      servedConfidence.set(snapKey(s.subject_id, s.zone_id, s.claim_type), s.confidence);
      servedSubjects.add(s.subject_id);
    }
    if (servedSubjects.size === 0) return { skipped: false, reason: null, candidates: 0, booked: 0, replayed: 0, ineligible: 0 };

    // 2. Observations behind those served subjects — narrowed to the served subject
    //    set so we never scan the whole corpus. Filtered in TS to the exact served
    //    key (subject|zone|type), matching the snapshot's unique key.
    const observations = await fetchIn<ObsRow>(
      db, "intel_observations",
      "id, actor_id, subject_id, zone_id, claim_type, moderation_state",
      "subject_id", [...servedSubjects],
      (q) => q.limit(MAX_OBS),
    );
    const behindServed = observations.filter(
      (o) => o.id && o.actor_id && servedConfidence.has(snapKey(o.subject_id, o.zone_id, o.claim_type)),
    );
    if (behindServed.length === 0) return { skipped: false, reason: null, candidates: 0, booked: 0, replayed: 0, ineligible: 0 };

    const actorIds = [...new Set(behindServed.map((o) => o.actor_id))];

    // 3. Consent + prior-ledger reads for exactly those actors.
    const consentRows = await fetchIn<ConsentRow>(
      db, "intel_contribution_consent", "user_id, enabled, withdrawn_at", "user_id", actorIds,
    );
    const consentByActor = new Map<string, { enabled: boolean; withdrawn: boolean }>();
    for (const c of consentRows) {
      consentByActor.set(c.user_id, { enabled: c.enabled === true, withdrawn: c.withdrawn_at != null });
    }

    // Anti-join: skip contributions already booked. recordEarnedReward is the real
    // at-most-once guarantee (23505 → replay), so this is an efficiency + accuracy
    // filter, not the safety net — a stale read here can only cost a replay, never a
    // double credit.
    const ledgerRows = await fetchIn<LedgerRow>(
      db, "intel_reward_ledger", "actor_id, idempotency_key", "actor_id", actorIds,
    );
    const alreadyRewarded = new Set<string>();
    for (const l of ledgerRows) {
      if (l.idempotency_key) alreadyRewarded.add(`${l.actor_id}|${l.idempotency_key}`);
    }

    // 3b. The honest oracle input: with the closed loop ON, read this pass's
    //     candidates' attribution rows and classify each observation; OFF ⇒ every
    //     candidate is `not_required` and nothing here is read.
    const honest = await isFlagEnabled(db, ATTRIBUTION_FLAG);
    const attributionByObs = new Map<string, AttributionRow[]>();
    if (honest) {
      const rows = await fetchIn<AttributionRow>(
        db, "intel_attributions", "observation_id, contradiction, outcome_score", "observation_id",
        behindServed.map((o) => o.id),
      );
      for (const r of rows) {
        const arr = attributionByObs.get(r.observation_id) ?? [];
        arr.push(r); attributionByObs.set(r.observation_id, arr);
      }
    }
    const attributionFor = (observationId: string): OutcomeAttribution =>
      honest ? classifyAttribution(attributionByObs.get(observationId) ?? []) : "not_required";

    // 4. Grade + book. A per-candidate error never aborts the pass.
    const tally = { candidates: 0, booked: 0, replayed: 0, ineligible: 0 };
    for (const o of behindServed) {
      const key = rewardKeyFor(o.id);
      if (alreadyRewarded.has(`${o.actor_id}|${key}`)) continue;
      tally.candidates++;

      const consent = consentByActor.get(o.actor_id) ?? { enabled: false, withdrawn: false };
      const candidate: EarningCandidate = {
        actorId: o.actor_id,
        observationId: o.id,
        served: true, // it is in the served-key map by construction
        servedConfidence: servedConfidence.get(snapKey(o.subject_id, o.zone_id, o.claim_type)) ?? null,
        outcomeAttribution: attributionFor(o.id),
        moderationState: o.moderation_state,
        consentEnabled: consent.enabled,
        consentWithdrawn: consent.withdrawn,
      };

      const ctx = buildRewardEligibilityContext(candidate);
      if (!evaluateRewardEligibility(ctx).eligible) { tally.ineligible++; continue; }

      const qiu = candidateQiu(candidate);
      // No realized impact yet ⇒ book nothing (fail-closed). The contribution stays
      // unrewarded and is reconsidered next pass, so it earns once its served
      // snapshot first carries a positive confidence.
      if (qiu <= 0) continue;

      try {
        const res = await recordEarnedReward(db, o.actor_id, {
          qiu,
          eligibility: ctx,
          source: REWARD_SOURCE,
          ledgerVersion: CURRENT_REWARD_LEDGER_VERSION,
          idempotencyKey: key,
        });
        if (res.ok) {
          if ((res as any).replayed) tally.replayed++;
          else tally.booked++;
        } else if (res.reason === "ineligible") {
          tally.ineligible++;
        } else {
          // disabled (flag flipped mid-pass) or db_error — log, keep going.
          logger.warn({ actor: o.actor_id, observation: o.id, reason: res.reason }, "reward pass: booking refused");
        }
      } catch (err) {
        logger.warn({ err, actor: o.actor_id, observation: o.id }, "reward pass: booking threw (continuing)");
      }
    }

    if (tally.booked > 0 || tally.replayed > 0) {
      logger.info(tally, "reward pass complete");
    }
    return { skipped: false, reason: null, ...tally };
  } catch (err) {
    logger.warn({ err }, "reward pass threw");
    return { ...EMPTY, reason: "error" };
  }
}

export function startIntelRewardScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: REWARDS_FLAG },
    "IntelRewardScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelRewardPass()
      .catch((err) => logger.warn({ err }, "reward pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelRewardScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
