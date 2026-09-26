/**
 * sensingErasureRecompute — the EFFECT of an erasure on derived state
 * (census-sensing S112, §26; owner: "verify that revocation actually produces
 * the required effect; a read-only reach calculation alone is not completion").
 *
 * ── WHAT HAPPENS, IN ORDER ───────────────────────────────────────────────────
 * `erase_intel_for_actor` has already deleted the account's observations.
 * Every snapshot the pre-erase reach found resting on them (3311's
 * `input_observation_ids`, exact; or every snapshot of every subject the
 * account observed, when provenance was unrecorded) is now handled:
 *
 *   1. RECOMPUTE. For each affected (subject, zone), the live-eligible claims
 *      are re-assembled by `assembleClaimInput` — which reads the observations
 *      that STILL EXIST — and re-projected by `projectAndStore`, which writes a
 *      new version row and upserts the current row with a provenance that no
 *      longer names the erased ids. The cohort may pass the gate with fewer
 *      people, be suppressed, or be withheld (`cohortSupportsValue` false when
 *      the departed actor was the only one asserting the served value).
 *   2. VERIFY, then RETRACT. The affected rows are re-read. Any that STILL
 *      names an erased observation — the flag was off, the claim is no longer
 *      live-eligible, the projection was withheld, the write failed — is
 *      retracted in place: `privacy_eligible = false`, `expires_at = now`,
 *      provenance emptied, and a retraction version row appended with
 *      `privacy_reason = 'input_erased'` so the record says why. The read
 *      path filters on `privacy_eligible = true` AND `expires_at > now`, so a
 *      retracted row stops serving at once.
 *
 * Fail-closed at every read: an unreadable claim set or an unreadable
 * post-recompute state retracts rather than trusts. A retraction that fails
 * to write is counted and reported so the deletion step warns.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * It does not touch the ANONYMOUS store (2315/3110): that store keeps no
 * per-row provenance by design (§20), and its revocation is
 * `revoke_sensing_contributions` under the device's own epoch secret. It does
 * not recompute memory: nothing persists `claim_refs` (sensingRevocationReach
 * header). It never reads or writes an actor id.
 */
import { randomUUID } from "node:crypto";
import { logger as rootLogger } from "../../lib/logger.js";
import { assembleClaimInput, type ClaimRow } from "../../lib/intelProjectionAggregator.js";
import { projectAndStore, PROJECTION_ALGORITHM_VERSION } from "../../lib/intelProjection.js";
import { LIVE_ELIGIBLE_CLAIM_STATUSES } from "../../lib/intelContracts.js";

const logger = rootLogger.child({ service: "sensingErasureRecompute" });

export interface AffectedSnapshot {
  id: string;
  subjectId: string;
  /** '' for a zone-less snapshot, as the unique index keys it. */
  zoneId: string;
  claimType: string;
}

export interface RecomputeDeps {
  assemble: typeof assembleClaimInput;
  project: typeof projectAndStore;
}

export const DEFAULT_RECOMPUTE_DEPS: RecomputeDeps = Object.freeze({
  assemble: assembleClaimInput,
  project: projectAndStore,
});

export interface RecomputeOutcome {
  /** Distinct (subject, zone) groups recomputed. */
  groups: number;
  /** What projectAndStore reported across the groups. */
  written: number;
  suppressed: number;
  skipped: number;
  /** Groups whose claim read failed; their snapshots fall through to retraction. */
  claimsUnreadable: number;
  /** Affected rows that still named an erased observation after the recompute, and were retracted. */
  retracted: number;
  /** Retractions whose write failed — the step warns on any. */
  retractionFailures: number;
  /** True when the post-recompute state could not be read and EVERY affected row was retracted (fail-closed). */
  verifiedBlind: boolean;
}

const IN_CHUNK = 200;
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function recomputeSnapshotsAfterErasure(
  sc: any,
  affected: readonly AffectedSnapshot[],
  erasedObservationIds: readonly string[],
  now: Date,
  deps: RecomputeDeps = DEFAULT_RECOMPUTE_DEPS,
): Promise<RecomputeOutcome> {
  const outcome: RecomputeOutcome = {
    groups: 0, written: 0, suppressed: 0, skipped: 0, claimsUnreadable: 0,
    retracted: 0, retractionFailures: 0, verifiedBlind: false,
  };
  if (affected.length === 0) return outcome;
  const erased = new Set(erasedObservationIds.map((id) => String(id).toLowerCase()));

  // 1. RECOMPUTE, one (subject, zone) at a time.
  const groups = new Map<string, { subjectId: string; zoneId: string }>();
  for (const a of affected) groups.set(`${a.subjectId}\u0000${a.zoneId}`, { subjectId: a.subjectId, zoneId: a.zoneId });
  outcome.groups = groups.size;
  for (const g of groups.values()) {
    const { data, error } = await sc
      .from("intel_claims")
      .select("id, subject_id, zone_id, claim_type, value, status, observed_at, updated_at, version")
      .eq("subject_id", g.subjectId)
      .in("status", LIVE_ELIGIBLE_CLAIM_STATUSES as unknown as string[]);
    if (error) {
      outcome.claimsUnreadable += 1;
      logger.warn({ err: error, subject: g.subjectId, zone: g.zoneId }, "erasure recompute: claim read failed; affected snapshots will be retracted");
      continue;
    }
    const claims = (((data as ClaimRow[]) ?? [])).filter((c) => (c.zone_id ?? "") === g.zoneId);
    if (claims.length === 0) continue; // nothing live-eligible: retraction below handles the rows
    try {
      const inputs = await Promise.all(claims.map((c) => deps.assemble(sc, c, now)));
      const t = await deps.project(sc, g.subjectId, inputs, { zoneId: g.zoneId || null, now });
      outcome.written += t.written; outcome.suppressed += t.suppressed; outcome.skipped += t.skipped;
    } catch (err) {
      outcome.skipped += claims.length;
      logger.warn({ err, subject: g.subjectId, zone: g.zoneId }, "erasure recompute: projection threw; affected snapshots will be retracted");
    }
  }

  // 2. VERIFY. Which affected rows still rest on erased evidence?
  const ids = [...new Set(affected.map((a) => a.id))];
  const stillResting: AffectedSnapshot[] = [];
  let blind = false;
  const byId = new Map(affected.map((a) => [a.id, a] as const));
  for (const part of chunk(ids, IN_CHUNK)) {
    const { data, error } = await sc
      .from("intel_state_snapshots")
      .select("id, subject_id, zone_id, claim_type, value, confidence, confidence_band, source_count, distinct_actors, observed_at, input_observation_ids")
      .in("id", part);
    if (error) {
      blind = true;
      logger.warn({ err: error }, "erasure recompute: post-recompute state unreadable; retracting every affected row (fail-closed)");
      break;
    }
    for (const row of (data as any[]) ?? []) {
      const idsOnRow: unknown[] = Array.isArray(row?.input_observation_ids) ? row.input_observation_ids : [];
      const rests = idsOnRow.some((x) => erased.has(String(x).toLowerCase()));
      if (rests) stillResting.push({ ...(byId.get(row.id) ?? { id: row.id, subjectId: row.subject_id, zoneId: row.zone_id ?? "", claimType: row.claim_type }), ...({ _row: row } as object) } as AffectedSnapshot);
    }
  }
  outcome.verifiedBlind = blind;
  const toRetract = blind ? affected : stillResting;

  // 3. RETRACT what still rests on the erased evidence.
  const nowIso = now.toISOString();
  for (const a of toRetract) {
    const row = (a as AffectedSnapshot & { _row?: any })._row ?? null;
    const { error: updErr } = await sc
      .from("intel_state_snapshots")
      .update({ privacy_eligible: false, expires_at: nowIso, input_observation_ids: [] })
      .eq("id", a.id);
    if (updErr) {
      outcome.retractionFailures += 1;
      logger.warn({ err: updErr, snapshot: a.id }, "erasure recompute: retraction update failed");
      continue;
    }
    outcome.retracted += 1;
    // The record: a retraction version, so the history says the state was
    // withdrawn because its input was erased — never silently overwritten.
    const { error: verErr } = await sc.from("intel_state_snapshot_versions").insert({
      id: randomUUID(),
      subject_id: a.subjectId,
      zone_id: a.zoneId,
      claim_type: a.claimType,
      value: row?.value ?? {},
      confidence: row?.confidence ?? null,
      confidence_band: row?.confidence_band ?? null,
      source_count: row?.source_count ?? 0,
      distinct_actors: row?.distinct_actors ?? null,
      privacy_eligible: false,
      privacy_reason: "input_erased",
      observed_at: row?.observed_at ?? nowIso,
      expires_at: nowIso,
      confidence_components: {},
      algorithm_version: PROJECTION_ALGORITHM_VERSION,
      input_claim_versions: [],
      input_observation_ids: [],
      conflict_state: null,
      generated_at: nowIso,
    });
    if (verErr) {
      // The current row IS retracted; only the history entry is missing. Count
      // it so the step warns, but do not un-retract.
      outcome.retractionFailures += 1;
      logger.warn({ err: verErr, snapshot: a.id }, "erasure recompute: retraction version append failed (row is retracted)");
    }
  }

  logger.info({ ...outcome, affected: affected.length, erasedObservations: erased.size }, "erasure recompute: done");
  return outcome;
}
