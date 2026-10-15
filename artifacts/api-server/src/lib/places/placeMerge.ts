/**
 * placeMerge — the admin MERGE and UNMERGE of canonical places
 * (`POST /api/admin/places/:id/merge|unmerge`, routes/placesCanonical.ts).
 *
 * THE INVARIANT: no merge or unmerge is ever applied to `places` without a row
 * in `place_merge_log` that records it, and no failure is ever answered as
 * success.
 *
 * WHAT MAIN DID (3c214ca80, measured by src/test/placesMergeLog.test.ts):
 * the handlers wrote the place first and then `await`ed the log insert without
 * reading its result. A log write that failed answered 200 and left the place
 * merged (or unmerged) with no record. Unmerge did not read the log at all, so
 * a merge nobody recorded was reversed as if it had been. A failed place read
 * was answered 404 "Place not found"; a failed reference count was logged as
 * `ref_count: 0`; an already-merged place was silently re-pointed; and a place
 * changed by a concurrent request was overwritten.
 *
 * WHY THIS ORDER AND NOT A TRANSACTION. The safest shape is one SQL function
 * that locks both rows and writes the change and its log row in one
 * transaction — the shape 3812's `place_split` (PR #744) takes. That needs a
 * migration, and the routes are LIVE: `external_places_enabled` is TRUE in
 * production (the 2026-09-22 snapshot), so moving them onto an unapplied
 * function would break the admin merge until the owner applies it. With what
 * main has — PostgREST, no transaction across two statements — the order that
 * cannot leave an UNLOGGED change is:
 *
 *   1. read the place(s) and check every precondition, every read checked;
 *   2. WRITE THE LOG ROW, with an id generated here so it can be withdrawn
 *      without trusting a RETURNING body; if this fails, nothing has changed;
 *   3. move the place with a compare-and-set: the UPDATE matches only the
 *      state step 1 read, so a concurrent change makes it match nothing;
 *   4. if the move did not happen, WITHDRAW the log row (it records a change
 *      that did not occur). The row is withdrawn only when the move PROVABLY
 *      did not happen: the UPDATE matched no row, or, after an UPDATE error,
 *      the place is re-read in exactly the state step 1 read. An error whose
 *      outcome cannot be established (a lost response, a failed re-read) KEEPS
 *      the row and says so — a log row for a change that may not have happened
 *      is the lesser fault; an applied change with no log row is the one this
 *      file exists to prevent.
 *
 * WHAT THIS DOES NOT CLOSE (a transaction would), named rather than implied:
 *   - a crash or a failed withdrawal between steps 2 and 4 leaves a log row for
 *     a change that did not happen (the answer names its id and the operator
 *     log carries it at error level);
 *   - the merge target is checked in step 1 and not locked: a target merged
 *     away by a concurrent request between steps 1 and 3 yields a two-hop
 *     chain, exactly as on main;
 *   - after an UPDATE error, a place re-read in its starting state is taken as
 *     unchanged; a concurrent request that applied and then reversed the same
 *     change inside that window would be withdrawn with it.
 *
 * UNMERGE READS THE LOG. Only a merge the log records is reversed: the NEWEST
 * row with action 'merge' for this place must name its current survivor. No
 * such row → 409 `merge_not_logged`; a newer merge into another place → 409
 * `merge_log_disagrees`. Rows with any other action — 'unmerge', and 'split'
 * once 3812 (PR #744) is applied — are not merge records and are ignored.
 *
 * Unmerge still sets `status = 'active'`, as main did. The status a place had
 * before it was merged is not recorded anywhere (place_merge_log has no column
 * for it), so a closed place merged and unmerged comes back active. Fixing that
 * needs a column, so a migration; it is reported, not done here.
 */
import { randomUUID } from "node:crypto";
import { sendError, type ApiErrorCode } from "../http.js";
import { affectedRows } from "../affectedRows.js";

/** A refusal: the HTTP answer the route sends. `reason` is absent on main's own refusals, so their bodies are unchanged. */
export interface PlaceMergeRefusal {
  ok: false;
  code: ApiErrorCode;
  message: string;
  reason?: string;
}

export type PlaceMergeOutcome = { ok: true; logId: string } | PlaceMergeRefusal;

interface OpLog { error(obj: unknown, msg?: string): void }

const refuse = (code: ApiErrorCode, message: string, reason?: string): PlaceMergeRefusal =>
  reason ? { ok: false, code, message, reason } : { ok: false, code, message };

/** Send a refusal. Details are exposed: both routes are admin-only, and an orphaned log id is the operator's to act on. */
export function sendPlaceMergeRefusal(res: any, out: PlaceMergeRefusal): void {
  sendError(res, out.code, out.message, { exposeDetail: true, ...(out.reason ? { reason: out.reason } : {}) });
}

type Verb = "merge" | "unmerge";

/**
 * Step 4. Withdraw the log row of a change that did not happen. A withdrawal
 * that fails leaves a row claiming a change that never occurred: that is said
 * in the answer, with the row's id, and logged at error level.
 */
async function withdraw(sc: any, logId: string, verb: Verb, placeId: string, log: OpLog | undefined, then: PlaceMergeRefusal): Promise<PlaceMergeRefusal> {
  const { data, error } = await sc.from("place_merge_log").delete().eq("id", logId).select("id");
  if (!error && affectedRows(data) === 1) return then;
  log?.error(
    { err: error ?? null, placeMergeLogId: logId, placeId, verb },
    `place_merge_log row ${logId} records a ${verb} that was NOT applied and could not be withdrawn`,
  );
  return refuse(
    "db_error",
    `The ${verb} was not applied, but its place_merge_log row ${logId} could not be withdrawn: that row records a ${verb} that did not happen.`,
    `${verb}_log_orphaned`,
  );
}

/**
 * Step 3 failed with an ERROR. Whether the UPDATE committed is unknown (the
 * response may be what was lost), so the place is re-read: back in `before` →
 * not applied, withdraw; in `after` → applied, keep and succeed; anything else,
 * or an unreadable place → keep the row and say the outcome is unknown.
 */
async function settleAfterWriteError(
  sc: any, logId: string, verb: Verb, placeId: string, before: string | null, after: string | null, log: OpLog | undefined, writeErr: unknown,
): Promise<PlaceMergeOutcome> {
  const { data, error } = await sc.from("places").select("id, merged_into_place_id").eq("id", placeId).maybeSingle();
  if (!error && data) {
    const now = (data as any).merged_into_place_id ?? null;
    if (now === before) {
      return withdraw(sc, logId, verb, placeId, log, refuse("db_error", `The ${verb} was not applied: the place could not be updated. Nothing was changed.`, `${verb}_write_failed`));
    }
    if (now === after) return { ok: true, logId };
  }
  log?.error(
    { err: writeErr, rereadErr: error ?? null, placeMergeLogId: logId, placeId, verb },
    `place ${verb}: the place write failed and its outcome could not be established; place_merge_log row ${logId} is KEPT`,
  );
  return refuse(
    "db_error",
    `The ${verb} may or may not have been applied: the place write failed and the place could not be re-read in a known state. Its place_merge_log row ${logId} was kept.`,
    `${verb}_outcome_unknown`,
  );
}

/** Merge `placeId` into `intoId`. Every precondition read is checked; the log row is written before the place moves. */
export async function mergePlace(
  sc: any,
  args: { placeId: string; intoId: string; adminId: string },
  log?: OpLog,
): Promise<PlaceMergeOutcome> {
  const { placeId, intoId, adminId } = args;
  const [loserRead, survivorRead] = await Promise.all([
    sc.from("places").select("id, merged_into_place_id").eq("id", placeId).maybeSingle(),
    sc.from("places").select("id, merged_into_place_id").eq("id", intoId).maybeSingle(),
  ]);
  if (loserRead.error || survivorRead.error) {
    return refuse("degraded_unavailable", "The places could not be read, so nothing was merged.", "place_read_failed");
  }
  const loser = loserRead.data as { merged_into_place_id: string | null } | null;
  const survivor = survivorRead.data as { merged_into_place_id: string | null } | null;
  if (!loser || !survivor) return refuse("not_found", "Place not found");
  if (survivor.merged_into_place_id) return refuse("invalid_payload", "Target is itself merged; merge into the survivor");
  // Main re-pointed an already-merged place, losing the survivor it had; the
  // log could then not say which merge an unmerge reverses.
  if (loser.merged_into_place_id) return refuse("conflict", "Place is already merged; unmerge it first", "already_merged");

  // ref_count is part of the record. Main logged 0 when this read failed.
  const { count, error: countErr } = await sc.from("external_place_references")
    .select("id", { count: "exact", head: true }).eq("place_id", placeId);
  if (countErr || typeof count !== "number") {
    return refuse("degraded_unavailable", "The place's provider references could not be counted, so nothing was merged.", "reference_count_failed");
  }

  // Step 2: the record first.
  const logId = randomUUID();
  const { error: logErr } = await sc.from("place_merge_log").insert({
    id: logId, action: "merge", survivor_place_id: intoId, affected_place_id: placeId, admin_id: adminId, ref_count: count,
  });
  if (logErr) {
    return refuse("db_error", "The merge was not applied: it could not be recorded in place_merge_log. Nothing was changed.", "merge_log_write_failed");
  }

  // Step 3: move the place only from the state step 1 read (not merged).
  const { data: moved, error: moveErr } = await sc.from("places")
    .update({ merged_into_place_id: intoId, status: "duplicate", updated_at: new Date().toISOString() })
    .eq("id", placeId).is("merged_into_place_id", null)
    .select("id");
  if (moveErr) return settleAfterWriteError(sc, logId, "merge", placeId, null, intoId, log, moveErr);
  if (affectedRows(moved) !== 1) {
    return withdraw(sc, logId, "merge", placeId, log, refuse("conflict", "The place changed while it was being merged; nothing was merged.", "place_changed"));
  }
  return { ok: true, logId };
}

/** Reverse the merge the log records for `placeId`. The unmerge is logged before it is applied. */
export async function unmergePlace(
  sc: any,
  args: { placeId: string; adminId: string },
  log?: OpLog,
): Promise<PlaceMergeOutcome> {
  const { placeId, adminId } = args;
  const { data: place, error: placeErr } = await sc.from("places")
    .select("id, merged_into_place_id").eq("id", placeId).maybeSingle();
  if (placeErr) return refuse("degraded_unavailable", "The place could not be read, so nothing was unmerged.", "place_read_failed");
  if (!place) return refuse("not_found", "Place not found");
  const survivorId: string | null = (place as any).merged_into_place_id ?? null;
  if (!survivorId) return refuse("invalid_payload", "Place is not merged");

  // Only a RECORDED merge is reversed: the newest 'merge' row for this place.
  const { data: newest, error: readErr } = await sc.from("place_merge_log")
    .select("id, survivor_place_id")
    .eq("affected_place_id", placeId).eq("action", "merge")
    .order("created_at", { ascending: false }).limit(1);
  if (readErr) {
    return refuse("degraded_unavailable", "place_merge_log could not be read, so nothing was unmerged.", "merge_log_unreadable");
  }
  const last = ((newest as Array<{ survivor_place_id: string }> | null) ?? [])[0];
  if (!last) {
    return refuse("conflict", "place_merge_log has no record of this merge, so it is not reversed here. Nothing was changed.", "merge_not_logged");
  }
  if (last.survivor_place_id !== survivorId) {
    return refuse("conflict", "The newest merge place_merge_log records for this place names a different survivor. Nothing was changed.", "merge_log_disagrees");
  }

  // Step 2: the record first.
  const logId = randomUUID();
  const { error: logErr } = await sc.from("place_merge_log").insert({
    id: logId, action: "unmerge", survivor_place_id: survivorId, affected_place_id: placeId, admin_id: adminId, ref_count: 0,
  });
  if (logErr) {
    return refuse("db_error", "The unmerge was not applied: it could not be recorded in place_merge_log. Nothing was changed.", "unmerge_log_write_failed");
  }

  // Step 3: only from the survivor step 1 read.
  const { data: moved, error: moveErr } = await sc.from("places")
    .update({ merged_into_place_id: null, status: "active", updated_at: new Date().toISOString() })
    .eq("id", placeId).eq("merged_into_place_id", survivorId)
    .select("id");
  if (moveErr) return settleAfterWriteError(sc, logId, "unmerge", placeId, survivorId, null, log, moveErr);
  if (affectedRows(moved) !== 1) {
    return withdraw(sc, logId, "unmerge", placeId, log, refuse("conflict", "The place changed while it was being unmerged; nothing was unmerged.", "place_changed"));
  }
  return { ok: true, logId };
}
