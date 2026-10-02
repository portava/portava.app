/**
 * Telegraph §13.2 — the mechanism that makes `availability.expired` and
 * `location.expired` HAPPEN.
 *
 * Spec:
 *   §4.3   "Availability expires automatically and revokes across Telegraph,
 *          Discovery and Compass."
 *   §12    `location_shares` — "Purpose/audience/precision/EXPIRY scoped
 *          location capability."
 *   §13.2  `availability.expired` · `location.expired`
 *   §13.3  "…consume asynchronously and idempotently."
 *
 * ── WHY THIS FILE EXISTS, AND WHAT IT IS NOT ────────────────────────────────
 * census-telegraph T188, verbatim: "Not in the union; expiry is evaluated
 * LAZILY ON READ (`2260:38-42`) and emits nothing."
 *
 * Lazy-on-read is a correct DISPLAY rule and is kept — every reader in this
 * tree already refuses to render a row past its `expires_at`, and none of that
 * changes here. What lazy-on-read cannot do is EXPIRE anything. A person who
 * closes the app at 21:00 with FREE NOW showing, and opens it at 23:00, is
 * shown the truth; a person who leaves the app open is shown FREE NOW until
 * they pull to refresh, and a second device is shown it forever. §4.3 asks for
 * a revocation, and a revocation nobody performs is a timestamp.
 *
 * So this is a SWEEP: a thing that runs, reads the expiry columns, ends what
 * has ended, and emits. It is deliberately not a trigger and not a queue.
 *
 * ── EXACTLY-ONCE, WHERE IT IS ACHIEVABLE, AND HONESTY WHERE IT IS NOT ───────
 * AVAILABILITY is exactly-once by CONDITIONAL WRITE. The sweep DELETEs the
 * expired rows and emits one event per row the delete returned. Of two
 * instances sweeping the same row exactly one delete matches it, so the event
 * is emitted once; and because the row is gone, a restart cannot replay it.
 * The delete is safe precisely because every reader already treats these rows
 * as absent past `expires_at` — `routes/availability.ts:151`, `:86`, `:618`,
 * `services/passport/PassportProjectionService.ts#loadQuickStatus`,
 * `services/passport/SharedContextService.ts#loadActiveQuickStatus` — so it
 * removes data nothing was allowed to show. Deleting dead presence rows is a
 * privacy improvement, not a data loss.
 *
 * THE DELETE IS QUALIFIED, AND THAT IS NOT STYLE. This database runs supautils'
 * safeupdate guard, which REJECTS an unqualified DELETE in a PostgREST-role
 * session. `.lte("expires_at", now)` is the qualification and it is also the
 * whole semantics: a sweep that could ever be unqualified is a sweep that could
 * ever delete everybody's availability.
 *
 * LOCATION is at-least-once, bounded by ONE INTERVAL, and says so. A scoped
 * share is a `messages` row; `messages` has no mutable per-share state this
 * lane owns and no index on an envelope field, so there is nothing to flip. The
 * sweep therefore emits for shares whose `expiresAt` falls in the half-open
 * window `(since, now]`, where `since` is the previous tick. Two instances
 * sweeping the same tick emit twice; a restart replays at most the last
 * interval, never the whole history, because a cold start sets `since` to
 * `now - interval` rather than to the epoch. Every payload carries a stable
 * `eventKey`, which is what §13.3's "idempotently" needs a consumer to have.
 * Claiming exactly-once over a bus whose own header says publish failures are
 * "logged and swallowed" would be a claim about a transport that cannot make
 * it.
 *
 * ── A FAILED SWEEP MUST NOT LOOK LIKE AN IDLE ONE ───────────────────────────
 * The trip crew live-share scheduler records this defect at length and it is
 * the same one here: a `.error` that is checked and turned into `return 0`
 * reports "nothing to expire" for a broken database. Every read below checks
 * `error` explicitly — a PostgREST rejection RESOLVES, so an unchecked call
 * yields `{data: null}` and sails into `?? []` — and a failure is returned as a
 * FAILURE, never as zero.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  emitAvailabilityExpired,
  emitLocationExpired,
} from "../../lib/telegraphEvents.js";
import { LOCATION_PRECISIONS, parseKindEnvelope } from "./messageKinds.js";

/** How far back the location sweep will look for shares at all. */
export const LOCATION_SWEEP_HORIZON_HOURS = 8;
/** How many `messages` rows one location sweep reads. */
export const LOCATION_SWEEP_SCAN_LIMIT = 500;
/** How many availability rows one sweep will end in a single pass. */
export const AVAILABILITY_SWEEP_LIMIT = 500;

export interface SweepResult {
  expired: number;
  /** Non-empty means the pass did NOT do its job. Never folded into `expired`. */
  failures: string[];
}

/**
 * §4.3 — end every quick-availability signal whose window has closed, and tell
 * its owner.
 *
 * Returns the number of signals ENDED, which is not the number examined: a row
 * another instance ended first is not counted here, and that is the point of
 * counting the delete's own return rather than a prior select.
 */
export async function sweepExpiredAvailability(
  sc: SupabaseClient,
  now: Date,
): Promise<SweepResult> {
  const nowIso = now.toISOString();

  // TWO STATEMENTS, AND THE SECOND IS STILL THE CONDITIONAL WRITE.
  //
  // The obvious single `DELETE ... WHERE expires_at <= now LIMIT n` is not
  // available: PostgREST refuses a limited DELETE that carries no `order`, so a
  // one-statement version either drops the bound or fails every tick. A bound
  // matters on the first tick after a long outage, when the backlog is whatever
  // accumulated while nothing was sweeping.
  //
  // So: a bounded SELECT names the candidates, and the DELETE names BOTH the
  // ids and the expiry predicate. Keeping `lte("expires_at", ...)` on the
  // delete is what preserves exactly-once — a row another instance re-armed
  // between the two statements no longer matches, and of two instances deleting
  // the same row exactly one gets it back from `.select()`. Dropping that
  // predicate would turn this into "delete the rows I saw a moment ago", which
  // is a different and wrong statement.
  const { data: candidates, error: readErr } = await sc
    .from("quick_availability_status")
    .select("user_id")
    .lte("expires_at", nowIso)
    .limit(AVAILABILITY_SWEEP_LIMIT);
  if (readErr) {
    return { expired: 0, failures: [`quick_availability_status: ${readErr.message ?? "read failed"}`] };
  }
  const ids = ((candidates as Array<{ user_id?: string }> | null) ?? [])
    .map((r) => r.user_id)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  if (ids.length === 0) return { expired: 0, failures: [] };

  const { data, error } = await sc
    .from("quick_availability_status")
    // Qualified twice. See the header: an unqualified DELETE is refused by this
    // database's safeupdate guard, and would be wrong even where it is allowed.
    .delete()
    .in("user_id", ids)
    .lte("expires_at", nowIso)
    .select("user_id, status, expires_at");

  if (error) {
    // NOT `expired: 0`. An unreadable table and an empty one are different
    // facts and only one of them means the revocation is working.
    return { expired: 0, failures: [`quick_availability_status: ${error.message ?? "delete failed"}`] };
  }

  const rows = (data as Array<{ user_id?: string; status?: string; expires_at?: string }> | null) ?? [];
  for (const r of rows) {
    const owner = typeof r.user_id === "string" ? r.user_id : "";
    if (!owner) continue;
    emitAvailabilityExpired(owner, {
      status: typeof r.status === "string" ? r.status : null,
      // The signal's OWN expiry, not the sweep's clock — see the emitter.
      expiredAt: typeof r.expires_at === "string" ? r.expires_at : nowIso,
      sweptAt: nowIso,
    });
  }
  return { expired: rows.length, failures: [] };
}

/** One scoped share the sweep found, before any event is emitted. */
export interface ExpiringShare {
  shareId: string;
  threadId: string;
  ownerUserId: string;
  expiresAt: string;
}

/**
 * Which shares a tick must emit for — a PURE function, so the window rule is
 * testable without a database and without a clock.
 *
 * HALF-OPEN, `(since, now]`, and both ends matter. Inclusive at `since` would
 * re-emit the share that sat exactly on the previous boundary on every tick
 * forever; exclusive at `now` would drop a share that expires exactly on this
 * one, and the next tick's `since` would then be past it.
 */
export function sharesExpiringIn(
  shares: ExpiringShare[],
  sinceMs: number,
  nowMs: number,
): ExpiringShare[] {
  return shares.filter((s) => {
    const t = Date.parse(s.expiresAt);
    return Number.isFinite(t) && t > sinceMs && t <= nowMs;
  });
}

/**
 * §13.2 `location.expired` — end the scoped in-thread shares whose window
 * closed since the previous tick.
 *
 * Reads a bounded slice of `messages`: LOCATION rows only, inside the horizon,
 * newest first. It parses the envelope to reach `expiresAt` and NOTHING ELSE
 * leaves this function — no coordinate is logged, counted or published. The
 * event carries the share's id, its owner and its expiry, which is what a
 * client needs to stop rendering a live chip.
 */
export async function sweepExpiredLocationShares(
  sc: SupabaseClient,
  opts: { now: Date; since: Date },
): Promise<SweepResult> {
  const nowMs = opts.now.getTime();
  const sinceMs = opts.since.getTime();
  const horizonIso = new Date(nowMs - LOCATION_SWEEP_HORIZON_HOURS * 3600_000).toISOString();

  // THE SUBTYPE FILTER IS THE INDEX, AND THE msg_type IS THE CORRECTNESS.
  //
  // `messages` has no index on `msg_type` and none on `created_at` alone, so
  // the obvious query is a sequential scan of the hottest table in the product
  // every five minutes. It DOES have `idx_messages_subtype` — partial, on
  // `subtype` where not null — and a LOCATION message's subtype is its
  // precision. Narrowing on the precision ladder first turns the scan into a
  // bitmap index scan (measured on `portava-ci`: Bitmap Index Scan on
  // idx_messages_subtype, cost 4.45).
  //
  // The `msg_type` equality stays, and it is not redundant: it is what stops a
  // future kind that happens to use one of those subtype words from being swept
  // as a location share. The filter is derived from `LOCATION_PRECISIONS`
  // rather than written out, because a second copy would drift and the drift
  // would be silent — a new precision would produce shares this sweep never
  // looked at.
  const { data, error } = await sc
    .from("messages")
    .select("id, thread_id, sender_id, created_at, msg_type, body, deleted_at")
    .in("subtype", [...LOCATION_PRECISIONS])
    .eq("msg_type", "location")
    .is("deleted_at", null)
    .gte("created_at", horizonIso)
    .order("created_at", { ascending: false })
    .limit(LOCATION_SWEEP_SCAN_LIMIT);

  if (error) {
    return { expired: 0, failures: [`messages(location): ${error.message ?? "read failed"}`] };
  }

  const candidates: ExpiringShare[] = [];
  for (const row of ((data as any[]) ?? [])) {
    const env = parseKindEnvelope(row.msg_type, row.body);
    if (!env || env.kind !== "LOCATION") continue;
    const expiresAt = (env.payload as { expiresAt?: unknown }).expiresAt;
    // A pin with no expiry has no lifecycle and emits nothing. See
    // `LocationPayload`.
    if (typeof expiresAt !== "string" || expiresAt.length === 0) continue;
    candidates.push({
      shareId: String(row.id),
      threadId: String(row.thread_id),
      ownerUserId: String(row.sender_id),
      expiresAt,
    });
  }

  const due = sharesExpiringIn(candidates, sinceMs, nowMs);
  const failures: string[] = [];
  for (const s of due) {
    try {
      await emitLocationExpired(sc, s.threadId, {
        shareId: s.shareId,
        ownerUserId: s.ownerUserId,
        expiredAt: s.expiresAt,
        sweptAt: opts.now.toISOString(),
      });
    } catch (err) {
      failures.push(`location.expired ${s.shareId}: ${(err as Error)?.message ?? "publish threw"}`);
    }
  }
  return { expired: due.length, failures };
}
