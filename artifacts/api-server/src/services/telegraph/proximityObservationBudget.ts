/**
 * Telegraph §4.3 — "Do not allow repeated refreshes to become a movement-tracking
 * side channel." The per-RELATIONSHIP observation budget (census-telegraph T26).
 *
 * ── WHAT WAS THERE, AND WHY IT WAS NOT ENOUGH ────────────────────────────────
 * GET /nearby/reachable floors its clock to a 60 s quantum (two polls inside one
 * are byte-identical) and rate-limits each viewer. Both bound a REQUEST. Neither
 * bounds how often one viewer learns where one PERSON is: a viewer polling once a
 * minute all day saw every bucket edge that person crossed, timed to the minute —
 * 1,440 observations a day of one relationship, which is a movement trace with a
 * coarse spatial grain and a fine temporal one. The census's words: "the guard is
 * per-request quantisation, not the per-relationship budget §4.5 describes, and
 * nothing bounds observations across a long session."
 *
 * ── THE BUDGET ───────────────────────────────────────────────────────────────
 * For each (viewer, person) pair the PROXIMITY a viewer is shown — bucket, travel
 * band, freshness, and the rank they feed — is observed at most once per
 * OBSERVATION_INTERVAL_MS. Inside the interval the viewer is served the proximity
 * recorded at the start of it, whatever the person has done since, so a change
 * reaches the viewer only at an interval boundary the viewer cannot choose. That
 * caps a relationship at 96 observations a day however fast anyone polls, from
 * however many instances: the record is a ROW (migration 3651,
 * `nearby_proximity_observations`), not process memory.
 *
 * Withdrawal is never delayed. When the fresh projection publishes no proximity —
 * the person went invisible, entered a protected zone, withdrew consent, a block —
 * or the person is no longer on the list at all, the viewer is served that at
 * once and the pair's record is DELETED, so nothing recorded can outlive the
 * consent it was observed under.
 *
 * ── WHAT THIS DOES NOT BOUND, STATED ─────────────────────────────────────────
 * The TRANSITIONS into and out of publication. Withdrawal is immediate by design
 * (consent), and a person who publishes again is observed afresh, so the moment
 * someone enters or leaves a protected zone, pauses sharing or goes stale reaches
 * a polling viewer at poll resolution. Budgeting those without delaying a consent
 * withdrawal needs the loader to say WHY a person's proximity is unpublished, and
 * whether the viewer had a position at all; it does not (census-telegraph T26).
 *
 * ── DATA MINIMISATION ────────────────────────────────────────────────────────
 * One row per pair, the latest observation only (no history), holding buckets and
 * nothing finer. After a viewer's read every row of theirs that remains is one
 * observation of a person still listed and still publishing (anything else is
 * withdrawn). A viewer who stops polling leaves rows behind, so ANY viewer's read
 * also deletes every row, of anyone, older than OBSERVATION_RETENTION_MS; both
 * user columns cascade on account deletion.
 *
 * ── FAIL DIRECTION ───────────────────────────────────────────────────────────
 * An unreadable record, or a write that does not land, refuses the whole answer
 * (the route's retryable 503): serving fresh proximity without recording it is
 * exactly the unbounded observation this exists to stop. On a database without
 * 3651 the table is absent, so Nearby — dark behind `nearby_reachable_enabled` —
 * cannot serve proximity until 3651 is applied.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { PROXIMITY_BUCKETS, TRAVEL_BANDS } from "../../lib/proximityBuckets.js";
import {
  FRESHNESS_STATES,
  orderReachablePeople,
  rerankForServedProximity,
  type ReachablePersonProjection,
  type ServedProximity,
} from "./reachablePeople.js";

/** One observation of a relationship's proximity per this many ms. */
export const OBSERVATION_INTERVAL_MS = 15 * 60_000;
/** A record older than this is deleted on the next read by ANY viewer. */
export const OBSERVATION_RETENTION_MS = 24 * 60 * 60_000;

const BUCKETS = new Set<string>(PROXIMITY_BUCKETS);
const TRAVEL = new Set<string>(TRAVEL_BANDS);
const FRESHNESS = new Set<string>(FRESHNESS_STATES);

interface ObservationRow {
  subject_id?: unknown;
  bucket?: unknown;
  travel?: unknown;
  freshness?: unknown;
  observed_at?: unknown;
}

export type BudgetOutcome =
  | { readonly ok: true; readonly people: ReachablePersonProjection[]; readonly served: { readonly recorded: number; readonly fresh: number; readonly withdrawn: number } }
  | { readonly ok: false; readonly stage: string; readonly message: string };

function servedFrom(row: ObservationRow | undefined, nowMs: number): ServedProximity | null {
  if (!row) return null;
  const at = Date.parse(String(row.observed_at ?? ""));
  if (!Number.isFinite(at) || nowMs - at >= OBSERVATION_INTERVAL_MS || at > nowMs) return null;
  const bucket = String(row.bucket ?? "");
  const travel = String(row.travel ?? "");
  const freshness = String(row.freshness ?? "");
  if (!BUCKETS.has(bucket) || !TRAVEL.has(travel) || !FRESHNESS.has(freshness)) return null;
  return { bucket, travel, freshness } as ServedProximity;
}

/**
 * Apply the budget to one viewer's projected list, record what was observed, and
 * return the list as SERVED (re-ranked and re-ordered on the served proximity).
 */
export async function applyObservationBudget(
  db: SupabaseClient,
  viewerId: string,
  people: readonly ReachablePersonProjection[],
  nowMs: number,
): Promise<BudgetOutcome> {
  const nowIso = new Date(nowMs).toISOString();
  // EVERY record of this viewer, not only the listed people's: a person who has
  // left the list (blocked, invisible, consent withdrawn, no longer a candidate)
  // must lose their record too, or it outlives the consent it was observed under.
  // Bounded by the people this viewer was shown in the retention window.
  const { data, error } = await db
    .from("nearby_proximity_observations")
    .select("subject_id, bucket, travel, freshness, observed_at")
    .eq("viewer_id", viewerId);
  if (error) return { ok: false, stage: "observation_budget_read", message: String(error.message ?? "unreadable") };
  const rows = (data ?? []) as ObservationRow[];
  const byId = new Map<string, ObservationRow>();
  for (const r of rows) if (typeof r.subject_id === "string") byId.set(r.subject_id, r);
  const listed = new Set(people.map((p) => p.personId));

  const served: ReachablePersonProjection[] = [];
  const record: Array<Record<string, string>> = [];
  const withdraw: string[] = [];
  let recorded = 0;
  for (const p of people) {
    if (!p.privacy.proximityPublished) {
      served.push(p);
      if (byId.has(p.personId)) withdraw.push(p.personId);
      continue;
    }
    const fresh: ServedProximity = { bucket: p.proximity.bucket, travel: p.proximity.travel, freshness: p.proximity.freshness };
    const earlier = servedFrom(byId.get(p.personId), nowMs);
    if (earlier) {
      recorded += 1;
      served.push({
        ...p,
        proximity: { ...p.proximity, bucket: earlier.bucket, travel: earlier.travel, freshness: earlier.freshness },
        privacy: { ...p.privacy, proximityPublished: earlier.bucket !== "unknown" },
        rank: rerankForServedProximity(p.rank, fresh, earlier),
      });
      continue;
    }
    served.push(p);
    record.push({ viewer_id: viewerId, subject_id: p.personId, bucket: fresh.bucket, travel: fresh.travel, freshness: fresh.freshness, observed_at: nowIso });
  }

  if (record.length > 0) {
    const { error } = await db.from("nearby_proximity_observations").upsert(record, { onConflict: "viewer_id,subject_id" });
    if (error) return { ok: false, stage: "observation_budget_write", message: String(error.message ?? "write refused") };
  }
  for (const subject of byId.keys()) if (!listed.has(subject)) withdraw.push(subject);
  if (withdraw.length > 0) {
    const { error } = await db.from("nearby_proximity_observations").delete().eq("viewer_id", viewerId).in("subject_id", withdraw);
    if (error) return { ok: false, stage: "observation_budget_withdraw", message: String(error.message ?? "delete refused") };
  }
  // Not scoped to this viewer: this viewer's own rows are all fresh by now, and
  // the rows left by a viewer who stopped polling have no other reader to purge them.
  const { error: purgeErr } = await db
    .from("nearby_proximity_observations")
    .delete()
    .lt("observed_at", new Date(nowMs - OBSERVATION_RETENTION_MS).toISOString());
  if (purgeErr) return { ok: false, stage: "observation_budget_purge", message: String(purgeErr.message ?? "purge refused") };

  return {
    ok: true,
    people: orderReachablePeople(viewerId, served),
    served: { recorded, fresh: record.length, withdrawn: withdraw.length },
  };
}
