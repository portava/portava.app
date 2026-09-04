/**
 * Intel projection scheduler (IG-04) — the missing DRIVER that runs the claim →
 * live-state projection automatically.
 *
 * The projection (lib/intelProjection.projectAndStore) and its input assembly
 * (lib/intelProjectionAggregator) were both built, but nothing invoked them in
 * production: projectAndStore had callers only in tests. Without this, a real
 * observation → claim never became a snapshot, so liveClaims could never expose
 * live intelligence on its own. This closes that gap the same way
 * intelRetentionScheduler closed the "documented expiry nothing enforced" gap —
 * a flag-gated, self-rescheduling loop that never overlaps its own runs.
 *
 * WHAT IT DOES EACH PASS. Reads every active/conflicting claim, groups by
 * (subject, zone), assembles a ProjectionInput per claim from its real evidence,
 * and upserts snapshots. The privacy gate (inside projectClaim) still decides
 * privacy_eligible, and liveClaimRead still applies its own gates on the way out
 * — this driver never widens what may be shown, it only makes the write happen.
 *
 * Flag-gated (intel_claim_projection_crowd) and fail-closed; safe to start in
 * index.ts before the flag is on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { projectAndStore } from "./intelProjection.js";
import { assembleClaimInput, type ClaimRow } from "./intelProjectionAggregator.js";
import { LIVE_ELIGIBLE_CLAIM_STATUSES } from "./intelContracts.js";
import { captureSnapshotStates, emitStateChangedEvents, type SnapshotRow } from "./intelDomainEvents.js";

const STARTUP_DELAY_MS = 3 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000; // spec §24: aggregate live state every five minutes
const MAX_CLAIMS_PER_PASS = 5000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface ProjectionPassResult {
  subjects: number;
  written: number;
  suppressed: number;
  skipped: number;
  skippedRun: boolean;
  reason: "disabled" | "no_client" | "error" | null;
}

/**
 * Run one projection pass. Fail-closed: no client, flag off, or an error each
 * produce a distinct `reason` so a persistently failing driver is never mistaken
 * for one nobody switched on. Idempotent — snapshots upsert on
 * (subject_id, zone_id, claim_type), so re-running only refreshes.
 */
export async function runIntelProjectionPass(opts: { client?: SupabaseClient | null; now?: Date } = {}): Promise<ProjectionPassResult> {
  const base: ProjectionPassResult = { subjects: 0, written: 0, suppressed: 0, skipped: 0, skippedRun: true, reason: null };
  // Explicit null => "no client"; undefined => use the service client (house pattern).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...base, reason: "no_client" };
  if (!(await isFlagEnabled(db, "intel_claim_projection_crowd"))) return { ...base, reason: "disabled" };

  const now = opts.now ?? new Date();
  try {
    const { data, error } = await db
      .from("intel_claims")
      // updated_at + version (2274) are what Table 17's input_claim_versions cites.
      .select("id, subject_id, zone_id, claim_type, value, status, observed_at, updated_at, version")
      .in("status", LIVE_ELIGIBLE_CLAIM_STATUSES as unknown as string[])
      .limit(MAX_CLAIMS_PER_PASS);
    if (error) {
      logger.warn({ err: error }, "intelProjection pass: claim read failed");
      return { ...base, reason: "error" };
    }

    // Group by (subject_id, zone_id): projectAndStore applies one zone per call,
    // and the snapshot key is (subject_id, zone_id, claim_type).
    const groups = new Map<string, { subjectId: string; zoneId: string | null; claims: ClaimRow[] }>();
    for (const c of ((data as ClaimRow[]) ?? [])) {
      if (!c.subject_id || !c.claim_type) continue;
      const key = JSON.stringify([c.subject_id, c.zone_id ?? ""]);
      let g = groups.get(key);
      if (!g) { g = { subjectId: c.subject_id, zoneId: c.zone_id ?? null, claims: [] }; groups.set(key, g); }
      g.claims.push(c);
    }

    // §21 intel.state.changed: capture the prior semantic state of every
    // projected subject's snapshots BEFORE the pass writes, so a real diff
    // (value/band/eligibility) can be detected after. Bounded to the group
    // subjects — the set the projection can move. Orphan snapshots of subjects
    // that left live-eligibility entirely are handled as "went dark" below.
    const groupSubjectIds = [...new Set([...groups.values()].map((g) => g.subjectId))];
    const priorStates = await captureSnapshotStates(db, groupSubjectIds);
    const groupSubjectSet = new Set(groupSubjectIds);
    const wentDarkRows: Pick<SnapshotRow, "id" | "subject_id" | "zone_id" | "claim_type">[] = [];

    const tally = { written: 0, suppressed: 0, skipped: 0 };
    for (const g of groups.values()) {
      try {
        const inputs = await Promise.all(g.claims.map((c) => assembleClaimInput(db, c, now)));
        const t = await projectAndStore(db, g.subjectId, inputs, { zoneId: g.zoneId, now });
        tally.written += t.written; tally.suppressed += t.suppressed; tally.skipped += t.skipped;
      } catch (err) {
        tally.skipped += g.claims.length;
        logger.warn({ err, subject: g.subjectId }, "intelProjection pass: subject projection threw");
      }
    }

    // Reconcile stale snapshots. The loop above only (re)writes snapshots for
    // LIVE_ELIGIBLE claims, so a claim that LEFT that set (retracted, rejected,
    // superseded, expired) is never touched and its snapshot would keep serving
    // as LIVE until its TTL. Expire any servable snapshot with no live-eligible
    // claim behind it. BOTH the live-key set and the servable set are read with
    // FULL pagination: a range-less PostgREST read silently caps at 1000 rows with
    // no error, so past 1000 live claims an unpaginated read would miss real live
    // keys and force-expire the servable snapshots those keys back — a silent
    // deletion of live intelligence. Every page is accumulated until a short page
    // ends it, and if ANY page errors the whole reconciliation aborts WITHOUT
    // expiring anything (fail-closed: never expire on a partial/errored read).
    try {
      const PAGE = 1000;

      // Full live-key set, paginated. A short (or empty) page ends the loop.
      const liveKeys = new Set<string>();
      let liveKeysComplete = true;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await db
          .from("intel_claims")
          .select("subject_id, zone_id, claim_type")
          .in("status", LIVE_ELIGIBLE_CLAIM_STATUSES as unknown as string[])
          .range(offset, offset + PAGE - 1);
        if (error) {
          liveKeysComplete = false;
          logger.warn({ err: error }, "intelProjection pass: live-key page read failed; skipping expiry (fail-closed)");
          break;
        }
        const rows = (data as any[]) ?? [];
        for (const c of rows) liveKeys.add(JSON.stringify([c.subject_id, c.zone_id ?? "", c.claim_type]));
        if (rows.length < PAGE) break;
      }

      // Full servable-snapshot set, paginated (the same silent cap applies).
      const servable: any[] = [];
      let servableComplete = true;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await db
          .from("intel_state_snapshots")
          .select("id, subject_id, zone_id, claim_type")
          .eq("privacy_eligible", true)
          .gt("expires_at", now.toISOString())
          .range(offset, offset + PAGE - 1);
        if (error) {
          servableComplete = false;
          logger.warn({ err: error }, "intelProjection pass: servable page read failed; skipping expiry (fail-closed)");
          break;
        }
        const rows = (data as any[]) ?? [];
        servable.push(...rows);
        if (rows.length < PAGE) break;
      }

      // Expire only when BOTH sets were read IN FULL. A partial live-key read
      // cannot tell a real orphan from a key it simply did not read, so a
      // partial/errored read must never delete a servable row — leave snapshots
      // alone (the TTL still bounds staleness).
      if (liveKeysComplete && servableComplete) {
        const orphans = servable
          .filter((s) => !liveKeys.has(JSON.stringify([s.subject_id, s.zone_id ?? "", s.claim_type])));
        const orphanIds = orphans.map((s) => s.id);
        if (orphanIds.length > 0) {
          await db.from("intel_state_snapshots")
            .update({ privacy_eligible: false, expires_at: now.toISOString() })
            .in("id", orphanIds);
          // §24 completion status: these are the invalidation targets a correction
          // (IntelCaptureService.correctClaim → `intel.correction.invalidation`)
          // or a retraction/expiry named; this pass has now expired them. Snapshot
          // ids and keys only — never an actor.
          logger.info(
            {
              event: "intel.correction.invalidation.completed",
              expired: orphanIds.length,
              snapshot_ids: orphanIds,
              keys: servable
                .filter((s) => orphanIds.includes(s.id))
                .map((s) => ({ subject_id: s.subject_id, zone_id: s.zone_id ?? "", claim_type: s.claim_type })),
            },
            "intelProjection pass: expired snapshots whose claim is no longer live-eligible",
          );
          // An orphan of a subject we did NOT project this pass went dark and
          // its subject is not in priorStates/post: emit its state.changed here
          // (subjects we DID project have their eligibility flip caught by the
          // prior/post diff, and the emitter dedups by snapshot id).
          for (const o of orphans) {
            if (!groupSubjectSet.has(o.subject_id)) {
              wentDarkRows.push({ id: o.id, subject_id: o.subject_id, zone_id: o.zone_id ?? null, claim_type: o.claim_type });
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, "intelProjection pass: snapshot reconciliation failed (non-fatal)");
    }

    // §21 intel.state.changed — emitted only on a real diff (spec §11). Fully
    // fail-closed: never throws into the pass, so a spine hiccup cannot corrupt
    // the projection result the caller relies on.
    const postStates = await captureSnapshotStates(db, groupSubjectIds);
    await emitStateChangedEvents(db, priorStates, postStates, wentDarkRows, { now });

    if (tally.written > 0 || tally.suppressed > 0) {
      logger.info({ subjects: groups.size, ...tally }, "intelProjection pass complete");
    }
    return { subjects: groups.size, ...tally, skippedRun: false, reason: null };
  } catch (err) {
    logger.warn({ err }, "intelProjection pass threw");
    return { ...base, reason: "error" };
  }
}

export function startIntelProjectionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: "intel_claim_projection_crowd" },
    "IntelProjectionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runIntelProjectionPass()
      .catch((err) => logger.warn({ err }, "intelProjection pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopIntelProjectionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
