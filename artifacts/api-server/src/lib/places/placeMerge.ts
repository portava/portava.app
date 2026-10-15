/**
 * placeMerge — the admin MERGE and UNMERGE of canonical places
 * (`POST /api/admin/places/:id/merge|unmerge`, routes/placesCanonical.ts).
 *
 * THE INVARIANT: no merge or unmerge this API applies to `places` is left
 * without a row in `place_merge_log` that records it, and no failure is ever
 * answered as success. It rests on one fact, checked by grep: this file is the
 * ONLY writer of `places.merged_into_place_id`, and every write here LOGS
 * BEFORE IT MOVES. A write made outside this API (an operator's SQL) is outside
 * the invariant.
 *
 * WHAT MAIN DID (3c214ca80, measured by src/test/placesMergeLog.test.ts):
 * the handlers wrote the place first and then `await`ed the log insert without
 * reading its result. A log write that failed answered 200 and left the place
 * merged (or unmerged) with no record. Unmerge did not read the log at all, so
 * a merge nobody recorded was reversed as if it had been. A failed place read
 * was answered 404 "Place not found"; a failed reference count was logged as
 * `ref_count: 0`; an already-merged place was silently re-pointed; a place
 * other places were merged into could itself be merged away (a two-hop chain
 * the canonical read follows only one hop of); and a place changed by a
 * concurrent request was overwritten.
 *
 * WHY THIS ORDER AND NOT A TRANSACTION. The safest shape is one SQL function
 * that locks the rows and writes the change and its log row in one
 * transaction — the shape 3812's `place_split` (PR #744) takes. That needs a
 * migration, and the routes are LIVE: `external_places_enabled` is TRUE in
 * production (the 2026-09-22 snapshot), so moving them onto an unapplied
 * function would break the admin merge until the owner applies it. With what
 * main has — PostgREST, no transaction across two statements — the order is:
 *
 *   1. read the place(s) and check every precondition, every read checked;
 *   2. WRITE THE LOG ROW, with an id generated here so it can be withdrawn
 *      without trusting a RETURNING body; if this fails, nothing has changed;
 *   3. move the place with a compare-and-set: the UPDATE matches only the
 *      state step 1 read, so a concurrent change makes it match nothing;
 *   4. if the move did not happen, WITHDRAW the log row (it records a change
 *      that did not occur). It is withdrawn in exactly two cases:
 *        (a) the UPDATE ran and matched no row — this request changed nothing;
 *        (b) the UPDATE errored, the place is re-read in exactly its starting
 *            state, AND this request's row is still the NEWEST place_merge_log
 *            row for the place. The second half is what makes (b) sound:
 *            because every writer logs before it moves, a request that
 *            reversed this one's committed-but-unacknowledged change (verifier
 *            scenarios X1/X2) left a newer row first. Without it, a starting-
 *            state re-read would withdraw the row of a change that DID happen.
 *      An outcome that cannot be established — a failed re-read, a place
 *      re-read in neither state, or a newer row for the place — KEEPS the row
 *      and answers `*_outcome_unknown`, naming it. The same newest-row test
 *      gates the opposite case: a place re-read in its TARGET state is this
 *      request's success only while its row is the newest; otherwise another
 *      request may have made the change, and the outcome is unknown.
 *
 * So no interleaving of this API's own requests leaves an applied change
 * without its row. WHAT REMAINS (a transaction with row locks would close it):
 *   - a crash, or a failed withdrawal, between steps 2 and 4 leaves a row for a
 *     change that did not happen (the answer names it, the operator log carries
 *     it at error level). Such a row, if it is the place's newest, makes a
 *     later unmerge refuse (409) until an operator removes it;
 *   - two requests making the SAME change in one window: the one whose UPDATE
 *     failed without committing can, if its row is the newer, answer 200 for a
 *     change the other made; the log holds two rows for one change;
 *   - the merge target and the place's merged-in places are checked in step 1
 *     and not locked: a target merged away, or a place merged into this one,
 *     by a concurrent request between steps 1 and 3 yields a two-hop chain,
 *     and A→B racing B→A yields a cycle. Without a race, both shapes are
 *     refused (`Target is itself merged`, `place_is_survivor`).
 *
 * UNMERGE READS THE LOG. Only a merge the log records AS THE PLACE'S CURRENT
 * STATE is reversed: the NEWEST place_merge_log row for this place must be a
 * 'merge' naming its current survivor. No row, or a newest row that is not a
 * merge (an 'unmerge' — the merge being reversed was never recorded after it —
 * or any other action) → 409 `merge_not_logged`; a newest merge into another
 * place → 409 `merge_log_disagrees`. A 'split' row (3812, PR #744) has the NEW
 * place as its affected_place_id, so it is never the newest row of a place
 * being unmerged unless that place was created by the split and never merged.
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

/** The newest place_merge_log row for a place, any action. `null` data with no error = the place has no row. */
async function newestLogRow(sc: any, placeId: string): Promise<{ data: { id: string; action: string; survivor_place_id: string } | null; error: unknown }> {
  const { data, error } = await sc.from("place_merge_log")
    .select("id, action, survivor_place_id")
    .eq("affected_place_id", placeId)
    .order("created_at", { ascending: false }).limit(1);
  if (error) return { data: null, error };
  return { data: ((data as Array<{ id: string; action: string; survivor_place_id: string }> | null) ?? [])[0] ?? null, error: null };
}

/**
 * The instant a timestamptz string names, in MICROSECONDS. PostgREST answers
 * `2026-10-14T12:00:00.123456+00:00`; this file writes `…:00.123Z`. Comparing
 * strings would call those two spellings of one instant different.
 */
export function instantMicros(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s.trim());
  if (!m) return null;
  let zone = m[4] ?? "Z";
  if (zone !== "Z") zone = zone.length === 3 ? `${zone}:00` : zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const secondsMs = Date.parse(`${m[1]}T${m[2]}${zone}`);
  if (!Number.isFinite(secondsMs)) return null;
  return secondsMs * 1000 + Number((m[3] ?? "").padEnd(6, "0").slice(0, 6));
}

/**
 * The `updated_at` a move writes: now, but always STRICTLY later than the stamp
 * the move compares against. No trigger maintains `places.updated_at`; the two
 * moves in this file are its only writers in the API (by grep), and each
 * compare-and-sets on the exact stamp it read. So along every chain of moves
 * the stamp strictly increases — even two moves in one millisecond, or on API
 * instances whose clocks disagree — and a stale compare-and-set armed on an
 * earlier, identical state (an ABA) can never match again.
 */
export function nextStamp(prev: string | null): string {
  const p = instantMicros(prev);
  const floorMs = p === null ? 0 : Math.floor(p / 1000) + 1;
  return new Date(Math.max(Date.now(), floorMs)).toISOString();
}

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
 * response may be what was lost), so the place is re-read, and then the log:
 *   - UNTOUCHED: the starting state WITH the exact stamp step 1 read, and this
 *     request's row is still the newest → not applied: withdraw;
 *   - OURS: the target state WITH the stamp this request wrote, and this
 *     request's row is still the newest → applied: keep and succeed;
 *   - anything else → keep the row and say the outcome is unknown.
 * The stamps are what make the two states mean something. Every move here sets
 * `updated_at` strictly later than the stamp it compared against (nextStamp),
 * so a place cannot come back to a stamp it has left: a place re-read at
 * step 1's stamp has not moved since, and one at our stamp was moved by us
 * (or by a request that read the same stamp in the same millisecond and made
 * the same change). The newest-row test is kept as a second, independent
 * check: the place is read BEFORE the log, so any move visible in the re-read
 * had its row written before it (every writer logs first).
 */
async function settleAfterWriteError(
  sc: any, logId: string, verb: Verb, placeId: string, before: string | null, after: string | null,
  stamp0: string | null, ourStamp: string, log: OpLog | undefined, writeErr: unknown,
): Promise<PlaceMergeOutcome> {
  let why = "the place could not be re-read";
  const { data, error } = await sc.from("places").select("id, merged_into_place_id, updated_at").eq("id", placeId).maybeSingle();
  if (!error && data) {
    const now = (data as any).merged_into_place_id ?? null;
    const at = instantMicros((data as any).updated_at);
    const untouched = now === before && at !== null && at === instantMicros(stamp0);
    const ours = now === after && at !== null && at === instantMicros(ourStamp);
    why = "the place is neither untouched since it was read nor in the state this request wrote";
    if (untouched || ours) {
      const newest = await newestLogRow(sc, placeId);
      why = newest.error ? "place_merge_log could not be read"
        : !newest.data ? "place_merge_log holds no row for the place"
        : "place_merge_log holds a newer row for the place";
      if (!newest.error && newest.data?.id === logId) {
        if (untouched) {
          return withdraw(sc, logId, verb, placeId, log, refuse("db_error", `The ${verb} was not applied: the place could not be updated. Nothing was changed.`, `${verb}_write_failed`));
        }
        return { ok: true, logId };
      }
    }
  } else if (!error) {
    why = "the place no longer exists";
  }
  log?.error(
    { err: writeErr, rereadErr: error ?? null, placeMergeLogId: logId, placeId, verb, why },
    `place ${verb}: the place write failed and its outcome could not be established (${why}); place_merge_log row ${logId} is KEPT`,
  );
  return refuse(
    "db_error",
    `The ${verb} may or may not have been applied: the place write failed and its outcome could not be established (${why}). Its place_merge_log row ${logId} was kept.`,
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
    sc.from("places").select("id, merged_into_place_id, updated_at").eq("id", placeId).maybeSingle(),
    sc.from("places").select("id, merged_into_place_id").eq("id", intoId).maybeSingle(),
  ]);
  if (loserRead.error || survivorRead.error) {
    return refuse("degraded_unavailable", "The places could not be read, so nothing was merged.", "place_read_failed");
  }
  const loser = loserRead.data as { merged_into_place_id: string | null; updated_at?: string | null } | null;
  const survivor = survivorRead.data as { merged_into_place_id: string | null } | null;
  if (!loser || !survivor) return refuse("not_found", "Place not found");
  if (survivor.merged_into_place_id) return refuse("invalid_payload", "Target is itself merged; merge into the survivor");
  // Main re-pointed an already-merged place, losing the survivor it had; the
  // log could then not say which merge an unmerge reverses.
  if (loser.merged_into_place_id) return refuse("conflict", "Place is already merged; unmerge it first", "already_merged");
  // A place other places are merged into is not merged away: C→A then A→B is a
  // two-hop chain the canonical read follows one hop of. landmarkDedupSweep can
  // produce exactly that in one --apply run (a survivor later chosen as a loser).
  const { count: mergedIn, error: mergedInErr } = await sc.from("places")
    .select("id", { count: "exact", head: true }).eq("merged_into_place_id", placeId);
  if (mergedInErr || typeof mergedIn !== "number") {
    return refuse("degraded_unavailable", "The places merged into this place could not be read, so nothing was merged.", "place_read_failed");
  }
  if (mergedIn > 0) {
    return refuse("conflict", "Other places are merged into this place; unmerge them, or merge them into the new survivor, first", "place_is_survivor");
  }

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

  // Step 3: move the place only from the state step 1 read — not merged, AND
  // the exact stamp read, so a stale compare-and-set (ABA) matches nothing.
  const stamp0 = loser.updated_at ?? null;
  const ourStamp = nextStamp(stamp0);
  const mergeMove = sc.from("places")
    .update({ merged_into_place_id: intoId, status: "duplicate", updated_at: ourStamp })
    .eq("id", placeId).is("merged_into_place_id", null);
  const { data: moved, error: moveErr } = await (stamp0 === null ? mergeMove.is("updated_at", null) : mergeMove.eq("updated_at", stamp0))
    .select("id");
  if (moveErr) return settleAfterWriteError(sc, logId, "merge", placeId, null, intoId, stamp0, ourStamp, log, moveErr);
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
    .select("id, merged_into_place_id, updated_at").eq("id", placeId).maybeSingle();
  if (placeErr) return refuse("degraded_unavailable", "The place could not be read, so nothing was unmerged.", "place_read_failed");
  if (!place) return refuse("not_found", "Place not found");
  const survivorId: string | null = (place as any).merged_into_place_id ?? null;
  if (!survivorId) return refuse("invalid_payload", "Place is not merged");

  // Only a merge the log records as the place's CURRENT state is reversed: the
  // newest row for this place must be a 'merge' naming its survivor.
  const newest = await newestLogRow(sc, placeId);
  if (newest.error) {
    return refuse("degraded_unavailable", "place_merge_log could not be read, so nothing was unmerged.", "merge_log_unreadable");
  }
  if (!newest.data || newest.data.action !== "merge") {
    return refuse("conflict", "place_merge_log does not record this merge (its latest entry for this place is not a merge), so it is not reversed here. Nothing was changed.", "merge_not_logged");
  }
  if (newest.data.survivor_place_id !== survivorId) {
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

  // Step 3: only from the survivor AND the exact stamp step 1 read.
  const stamp0: string | null = (place as any).updated_at ?? null;
  const ourStamp = nextStamp(stamp0);
  const unmergeMove = sc.from("places")
    .update({ merged_into_place_id: null, status: "active", updated_at: ourStamp })
    .eq("id", placeId).eq("merged_into_place_id", survivorId);
  const { data: moved, error: moveErr } = await (stamp0 === null ? unmergeMove.is("updated_at", null) : unmergeMove.eq("updated_at", stamp0))
    .select("id");
  if (moveErr) return settleAfterWriteError(sc, logId, "unmerge", placeId, survivorId, null, stamp0, ourStamp, log, moveErr);
  if (affectedRows(moved) !== 1) {
    return withdraw(sc, logId, "unmerge", placeId, log, refuse("conflict", "The place changed while it was being unmerged; nothing was unmerged.", "place_changed"));
  }
  return { ok: true, logId };
}
