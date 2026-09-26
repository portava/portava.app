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
 * `revoke_sensing_contributions` under the device's own epoch secret. It never
 * reads or writes an actor id.
 *
 * ── THE MEMORY STAGE (3314), AFTER THE SNAPSHOTS ─────────────────────────────
 * `pruneMemoryLineageAfterErasure` runs once the snapshots have been
 * recomputed or retracted. A memory written from a closed session carries
 * `claim_refs` — the snapshots its world opportunity rested on. What the
 * erasure does to it, and why:
 *
 *   RETAINED.  The memory is ANOTHER person's record of their own evening,
 *              admitted by the section-6 gate from THEIR reported outcome. The
 *              world evidence supported the recommendation, not the fact that
 *              they went; deleting their memory because a third party erased
 *              a contribution would destroy someone else's data — 2130:449-452's
 *              reasoning, one stage further on. Content and confidence are not
 *              touched, because no input to them changed.
 *   PRUNED.    Every reference to a snapshot the erasure WITHDREW is removed:
 *              retracted (privacy_eligible false or expired), gone, or — if a
 *              retraction failed to land — still naming an erased observation.
 *              A reference to a snapshot that was REWRITTEN from the evidence
 *              that remains is kept: that snapshot still stands, and no longer
 *              rests on the erased evidence.
 *   RECORDED.  `provenance.lineage` gains one entry — event `input_erased`,
 *              when, and how many references were removed — naming no snapshot
 *              and no person, so the record says the memory's lineage changed
 *              without saying whose erasure changed it.
 *   VERIFIED.  The memories are re-read; any that still names a withdrawn
 *              snapshot is counted and the deletion step warns.
 *
 * Fail-closed: if the snapshots' post-erasure state cannot be read, EVERY
 * affected reference is treated as withdrawn — removing a reference is the
 * privacy-safe direction; keeping one to evidence that may be gone is not.
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

// ═════════════════════════════════════════════════════════════════════════════
// The memory stage (3314): prune references to withdrawn snapshots
// ═════════════════════════════════════════════════════════════════════════════

export interface AffectedMemory {
  /** memory_projections.id — another account's memory; its owner is never carried. */
  id: string;
  claimRefs: string[];
}

export interface MemoryLineageOutcome {
  /** Memories examined. */
  memories: number;
  /** Memories whose claim_refs lost at least one withdrawn reference. */
  pruned: number;
  /** References removed across all memories. */
  refsRemoved: number;
  /** Memories whose references all still stand (every snapshot was rewritten, not withdrawn). */
  unchanged: number;
  /** Updates that failed, plus memories still naming a withdrawn snapshot after the pass. */
  failures: number;
  /** True when the snapshot state could not be read and every affected reference was treated as withdrawn. */
  verifiedBlind: boolean;
}

/**
 * After the erasure and the snapshot recompute: remove, from every affected
 * memory, each reference to a snapshot that no longer stands. See the header.
 */
export async function pruneMemoryLineageAfterErasure(
  sc: any,
  memories: readonly AffectedMemory[],
  erasedObservationIds: readonly string[],
  now: Date,
): Promise<MemoryLineageOutcome> {
  const outcome: MemoryLineageOutcome = { memories: 0, pruned: 0, refsRemoved: 0, unchanged: 0, failures: 0, verifiedBlind: false };
  if (memories.length === 0) return outcome;
  outcome.memories = memories.length;
  const erased = new Set(erasedObservationIds.map((id) => String(id).toLowerCase()));
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  // 1. Which referenced snapshots still STAND? Read, never assumed from the
  //    recompute's own counts: a rewrite and a retraction both leave a row.
  const referenced = [...new Set(memories.flatMap((m) => m.claimRefs.map((r) => r.toLowerCase())))].sort();
  const standing = new Set<string>();
  let blind = false;
  for (const part of chunk(referenced, IN_CHUNK)) {
    const { data, error } = await sc
      .from("intel_state_snapshots")
      .select("id, privacy_eligible, expires_at, input_observation_ids")
      .in("id", part);
    if (error) {
      blind = true;
      logger.warn({ err: error }, "erasure memory lineage: snapshot state unreadable; treating every affected reference as withdrawn (fail-closed)");
      break;
    }
    for (const row of (data as any[]) ?? []) {
      const expires = Date.parse(String(row?.expires_at ?? ""));
      const eligible = row?.privacy_eligible === true && Number.isFinite(expires) && expires > nowMs;
      const idsOnRow: unknown[] = Array.isArray(row?.input_observation_ids) ? row.input_observation_ids : [];
      const restsOnErased = idsOnRow.some((x) => erased.has(String(x).toLowerCase()));
      if (eligible && !restsOnErased) standing.add(String(row.id).toLowerCase());
    }
  }
  if (blind) standing.clear();
  outcome.verifiedBlind = blind;
  const withdrawn = (ref: string) => !standing.has(ref.toLowerCase());

  // 2. Prune. The current provenance is re-read so the lineage entry is
  //    appended to what is there now, not to what the reach saw.
  const byId = new Map(memories.map((m) => [m.id, m] as const));
  const current = new Map<string, { claim_refs: string[]; provenance: Record<string, unknown> }>();
  for (const part of chunk([...byId.keys()], IN_CHUNK)) {
    const { data, error } = await sc.from("memory_projections").select("id, claim_refs, provenance").in("id", part);
    if (error) {
      outcome.failures += part.length;
      logger.warn({ err: error }, "erasure memory lineage: memory rows unreadable; their references were not pruned");
      continue;
    }
    for (const row of (data as any[]) ?? []) {
      current.set(String(row.id), {
        claim_refs: Array.isArray(row?.claim_refs) ? row.claim_refs.map(String) : [],
        provenance: row?.provenance && typeof row.provenance === "object" ? row.provenance : {},
      });
    }
  }

  const touched: string[] = [];
  for (const [id, row] of current) {
    const removed = row.claim_refs.filter(withdrawn);
    if (removed.length === 0) {
      outcome.unchanged += 1;
      continue;
    }
    const kept = row.claim_refs.filter((r) => !withdrawn(r));
    const priorLineage = Array.isArray((row.provenance as any).lineage) ? ((row.provenance as any).lineage as unknown[]) : [];
    const { error: updErr } = await sc
      .from("memory_projections")
      .update({
        claim_refs: kept,
        provenance: {
          ...row.provenance,
          lineage: [...priorLineage, { event: "input_erased", at: nowIso, refs_removed: removed.length }],
        },
        updated_at: nowIso,
      })
      .eq("id", id);
    if (updErr) {
      outcome.failures += 1;
      logger.warn({ err: updErr, memory: id }, "erasure memory lineage: prune update failed");
      continue;
    }
    outcome.pruned += 1;
    outcome.refsRemoved += removed.length;
    touched.push(id);
  }

  // 3. VERIFY: nothing examined may still name a withdrawn snapshot.
  for (const part of chunk([...current.keys()], IN_CHUNK)) {
    const { data, error } = await sc.from("memory_projections").select("id, claim_refs").in("id", part);
    if (error) {
      outcome.failures += part.length;
      logger.warn({ err: error }, "erasure memory lineage: post-prune state unreadable");
      continue;
    }
    for (const row of (data as any[]) ?? []) {
      const refs: string[] = Array.isArray(row?.claim_refs) ? row.claim_refs.map(String) : [];
      if (refs.some(withdrawn)) outcome.failures += 1;
    }
  }

  logger.info({ ...outcome, touched: touched.length }, "erasure memory lineage: done");
  return outcome;
}
