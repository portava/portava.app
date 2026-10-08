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
  | { readonly ok: true; readonly people: ReachablePersonProjection[]; readonly served: { readonly recorded: number; readonly fresh: number; readonly withdrawn: number; readonly withheld?: number } }
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
  unpublished?: ReadonlyMap<string, UnpublishedReason>, // T26 (§62): why each candidate's proximity is not published (file foot)
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
  let withheld = 0;
  for (const p of people) {
    if (!p.privacy.proximityPublished) {
      // T26 (§62): WHY it is unpublished decides what happens to the pair's record (file foot).
      const kept = unpublishedPerson(p, unpublished?.get(p.personId), byId.get(p.personId), nowMs);
      served.push(kept.serve);
      if (kept.serve !== p) recorded += 1;
      if (kept.marker) record.push({ viewer_id: viewerId, subject_id: p.personId, ...MARKER, observed_at: nowIso });
      if (kept.withdraw && byId.has(p.personId)) withdraw.push(p.personId);
      continue;
    }
    const fresh: ServedProximity = { bucket: p.proximity.bucket, travel: p.proximity.travel, freshness: p.proximity.freshness };
    const earlier = servedFrom(byId.get(p.personId), nowMs);
    if (earlier) {
      recorded += 1;
      if (earlier.bucket === "unknown" && !p.privacy.availabilityPublished) { withheld += 1; continue; } // T26 (§62): withheld by a live marker, and nothing else to show
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
  // A person no longer listed: their record goes ONLY when they withdrew it themselves; a person-side change
  // that is not consent keeps (or renews as a marker) the record; anything the loader did not explain —
  // including every viewer-side reason — keeps it untouched (verification F3: the viewer cannot reset it).
  for (const subject of byId.keys()) {
    if (listed.has(subject)) continue;
    const fate = unlistedFate(unpublished?.get(subject), byId.get(subject), nowMs);
    if (fate === "withdraw") withdraw.push(subject);
    else if (fate === "marker") record.push({ viewer_id: viewerId, subject_id: subject, ...MARKER, observed_at: nowIso });
  }

  if (record.length > 0) {
    const { error } = await db.from("nearby_proximity_observations").upsert(record, { onConflict: "viewer_id,subject_id" });
    if (error) return { ok: false, stage: "observation_budget_write", message: String(error.message ?? "write refused") };
  }
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
    served: { recorded, fresh: record.length, withdrawn: withdraw.length, withheld },
  };
}

// ── T26 (census-telegraph §62): WHY a proximity is unpublished decides the record's fate ──
//
// §53 deleted a pair's record whenever the fresh projection published no proximity for the person or the
// person left the list — and the VIEWER controls both (verification F3 on 3e2b9c1afd): pausing their own
// sharing made every bucket unknown, the next poll deleted every record, and resuming observed everyone
// afresh, so one PATCH per minute bought ~720 observations of a crew-mate a day instead of 96. And a
// person-side change that is not consent — entering a protected zone (home, lodging), going stale — reached
// a polling viewer at poll resolution. The loader now says why (services/telegraph/reachablePeopleQuery.ts
// `unpublished`):
//   person_withdrew  the PERSON's own consent (sharing paused or off, discovery off, invisible): withdrawn at
//                    once and the record DELETED — the record never outlives the consent it was observed under;
//   protected_zone,  person-side, not consent: budgeted like any other change of proximity — inside the
//   stale            interval the viewer keeps being served what was last observed (computed before the change,
//                    so nothing inside a zone is published), and an observed withdrawal is recorded as a MARKER
//                    (bucket/travel unknown, freshness stale) so the REAPPEARANCE is held to the interval too;
//   viewer_side,     the viewer measures from nowhere (their own sharing, position, zone or invisibility), a
//   unknown, absent  block, an unreadable relationship, or no reason given: nothing is served for this person
//                    now and the record is KEPT untouched — fail closed toward the budget, so neither side can
//                    reset it by toggling.
// Stated gap: a person whose ONLY published field was proximity and who is refused outright when they enter a
// zone or go stale leaves the list at poll resolution (showing them would need a projection the loader refuses
// to build); their reappearance is still held by the marker.

export type UnpublishedReason = "person_withdrew" | "viewer_side" | "protected_zone" | "stale" | "unknown";

const BUDGETED_REASONS: ReadonlySet<string> = new Set(["protected_zone", "stale"]);
const MARKER = { bucket: "unknown", travel: "unknown", freshness: "stale" } as const;

/** A LISTED person whose proximity is now unpublished: what to serve, whether to mark, whether to withdraw. */
export function unpublishedPerson(
  p: ReachablePersonProjection,
  why: UnpublishedReason | undefined,
  row: ObservationRow | undefined,
  nowMs: number,
): { serve: ReachablePersonProjection; marker: boolean; withdraw: boolean } {
  if (why === "person_withdrew") return { serve: p, marker: false, withdraw: true };
  if (!why || !BUDGETED_REASONS.has(why)) return { serve: p, marker: false, withdraw: false };
  const earlier = servedFrom(row, nowMs);
  if (earlier && earlier.bucket !== "unknown") {
    const fresh: ServedProximity = { bucket: p.proximity.bucket, travel: p.proximity.travel, freshness: p.proximity.freshness };
    return {
      serve: {
        ...p,
        proximity: { ...p.proximity, bucket: earlier.bucket, travel: earlier.travel, freshness: earlier.freshness },
        privacy: { ...p.privacy, proximityPublished: true },
        rank: rerankForServedProximity(p.rank, fresh, earlier),
      },
      marker: false,
      withdraw: false,
    };
  }
  return { serve: p, marker: !earlier, withdraw: false };
}

/** A person NO LONGER LISTED: delete only on their own withdrawal; mark a budgeted one whose record expired; else keep. */
export function unlistedFate(why: UnpublishedReason | undefined, row: ObservationRow | undefined, nowMs: number): "withdraw" | "marker" | "keep" {
  if (why === "person_withdrew") return "withdraw";
  if (why && BUDGETED_REASONS.has(why) && !servedFrom(row, nowMs)) return "marker";
  return "keep";
}
