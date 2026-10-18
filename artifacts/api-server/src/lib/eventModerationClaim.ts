/**
 * eventModerationClaim — apply an admin's event moderation action (PATCH
 * /admin/events/:eventId/moderate, routes/admin.ts) the way a legacy report is
 * moved (lib/legacyReportClose.ts): CLAIM, then AUDIT, then UNDO the claim when
 * the audit cannot be written.
 *
 * ── WHAT WAS WRONG (census-trust, wave 5, the remaining seven) ─────────────
 * The route wrote event_activity_log first, then patched the event with an
 * UNGUARDED update whose row count nobody read, then inserted the
 * `event_<action>` moderation_actions row FAIL-OPEN: an insert that failed was
 * a log warning and the answer was `200 { ok: true }`. So an event could be
 * hidden, cancelled or removed with no row in the global moderation audit
 * trail, and the admin was told it had worked. And:
 *   - an action that lost a race (another admin restored the event between
 *     the read and the write) silently overwrote it;
 *   - an update that matched no row (the event deleted mid-request) was a 200;
 *   - an update that FAILED left an activity-log row for an action that never
 *     happened.
 *
 * ── THE ORDER ───────────────────────────────────────────────────────────────
 * Every one of these actions is a plain column patch on `events` — state,
 * visibility, featured — with no trigger on the table (no migration creates
 * one), so each is reversible by writing back the values read. So:
 *   1. CLAIM: the patch, guarded on every column it writes still holding the
 *      value this request READ, `.select("id")`. Zero rows is a CONFLICT and
 *      nothing has been written. warn_host writes no column: nothing to claim.
 *   2. AUDIT: the event_activity_log row (the host-visible activity feed),
 *      then the `event_<action>` moderation_actions row (the global trail).
 *      Both are required: neither fails open any more.
 *   3. UNDO, only when an audit row could not be written: the event goes back
 *      to the values read, guarded on the values this request wrote AND its own
 *      updated_at stamp (so a later decision by someone else is never undone);
 *      and when it was the moderation_actions row that failed, the activity row
 *      this request wrote is removed, by its id, so the event's history does not
 *      record an action that was rolled back. A step of the undo that fails is
 *      NAMED in the outcome — "fix by hand" — never reported as restored.
 *
 * NEVER REJECTS: a thrown read or write is an outcome, like a returned error.
 */

/** The columns the moderate route may patch, and so the ones its claim is guarded on. */
export const EVENT_MODERATION_COLUMNS = ["state", "visibility", "featured"] as const;
type ModeratedColumn = (typeof EVENT_MODERATION_COLUMNS)[number];

export interface ModeratedEventRow {
  id: string;
  state?: unknown;
  visibility?: unknown;
  featured?: unknown;
}

export interface EventModerationOptions {
  /** The columns the action writes (a subset of EVENT_MODERATION_COLUMNS); empty for warn_host. */
  changes: Partial<Record<ModeratedColumn, unknown>>;
  /** updated_at for the claim, and the undo's guard. One per request. */
  now: string;
  /** The event_activity_log action word (`admin_<action>`), for the messages. */
  activityAction: string;
  /**
   * Writes the event_activity_log row and answers its id (`.insert({...}).select("id")`). The caller writes
   * both audit rows itself, with literal bodies, so the schema scans read their columns where they are sent.
   */
  writeActivity: () => PromiseLike<{ data?: unknown; error?: unknown } | null | undefined>;
  /** Writes the `event_<action>` moderation_actions row. */
  writeAudit: () => PromiseLike<{ error?: unknown } | null | undefined>;
}

export type EventModerationOutcome =
  | { outcome: "applied"; activityId: string | null }
  /** The claim moved no row: the event changed (or was deleted) since it was read. Nothing was written. */
  | { outcome: "conflict"; message: string }
  /**
   * `nothing_written` — the claim failed, or (warn_host) the first audit row failed: nothing changed.
   * `unknown` — the claim threw or answered no rows to count: whether the event changed is not known.
   * `restored` — an audit row failed, and everything this request wrote was undone.
   * `unrestored` — an audit row failed AND part of the undo failed: the message names what remains.
   */
  | { outcome: "failed"; state: "nothing_written" | "unknown" | "restored" | "unrestored"; message: string };

function messageOf(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown } | null;
  return String(e?.message ?? e?.code ?? err ?? "unknown error");
}

/** `.eq(col, v)`, or `.is(col, null)` for a null — PostgREST's `eq.null` compares to the TEXT 'null'. */
function guard(q: any, col: string, v: unknown): any {
  return v === null || v === undefined ? q.is(col, null) : q.eq(col, v);
}

export async function applyEventModeration(sc: any, req: any, ev: ModeratedEventRow, opts: EventModerationOptions): Promise<EventModerationOutcome> {
  const cols = (Object.keys(opts.changes) as ModeratedColumn[]).filter((c) => (EVENT_MODERATION_COLUMNS as readonly string[]).includes(c));
  // What the undo writes back, copied BEFORE anything is written (the caller's row object may alias a store).
  const prior: Record<string, unknown> = {};
  for (const c of cols) prior[c] = ev[c] ?? null;

  // 1. Claim.
  if (cols.length > 0) {
    let claimed: unknown;
    try {
      let q = sc.from("events").update({ ...opts.changes, updated_at: opts.now }).eq("id", ev.id);
      for (const c of cols) q = guard(q, c, prior[c]);
      const res = await q.select("id");
      if (res?.error) {
        return { outcome: "failed", state: "nothing_written", message: `The event could not be updated: ${messageOf(res.error)}. Nothing was changed or recorded.` };
      }
      claimed = res?.data;
    } catch (err) {
      return { outcome: "failed", state: "unknown", message: `The event update did not answer (${messageOf(err)}); whether it changed is unknown. Re-read the event before retrying.` };
    }
    if (!Array.isArray(claimed)) {
      return { outcome: "failed", state: "unknown", message: "The event update answered no rows to count; whether it changed is unknown. Re-read the event before retrying." };
    }
    if (claimed.length === 0) {
      return { outcome: "conflict", message: "The event changed while this request ran (someone else moderated or edited it, or it was deleted). Nothing was changed or recorded." };
    }
  }

  // 3. Undo (declared here, used by step 2): the event back to `prior`, then this request's activity row away.
  const undo = async (why: string, activityId: string | null | undefined): Promise<EventModerationOutcome> => {
    const left: string[] = [];
    if (cols.length > 0) {
      let restored = false;
      let undoError = "no row matched";
      try {
        let q = sc.from("events").update({ ...prior, updated_at: opts.now }).eq("id", ev.id).eq("updated_at", opts.now);
        for (const c of cols) q = guard(q, c, opts.changes[c]);
        const r = await q.select("id");
        if (r?.error) undoError = messageOf(r.error);
        restored = !r?.error && Array.isArray(r?.data) && r.data.length === 1;
      } catch (err) {
        undoError = messageOf(err);
      }
      if (!restored) left.push(`the event still reads ${cols.map((c) => `${c} = ${JSON.stringify(opts.changes[c])}`).join(", ")} (restore failed: ${undoError})`);
    }
    if (activityId !== undefined) {
      let removed = false;
      let delError = "no row matched";
      if (activityId !== null) {
        try {
          const r = await sc.from("event_activity_log").delete().eq("id", activityId).select("id");
          if (r?.error) delError = messageOf(r.error);
          removed = !r?.error && Array.isArray(r?.data) && r.data.length === 1;
        } catch (err) {
          delError = messageOf(err);
        }
      } else {
        delError = "the insert answered no id";
      }
      if (!removed) left.push(`its activity-log row ${activityId ?? ""}`.trimEnd() + ` records '${opts.activityAction}', which did not stand (removal failed: ${delError})`);
    }
    if (left.length === 0) {
      const undid = cols.length > 0 || activityId !== undefined;
      return { outcome: "failed", state: undid ? "restored" : "nothing_written", message: `${why}, so ${cols.length > 0 ? "the event was restored to what it held when read" : "nothing was applied"}. Nothing was recorded.` };
    }
    req?.log?.error?.({ eventId: ev.id, why, left }, "event moderation: audit write failed AND the undo did not complete");
    return { outcome: "failed", state: "unrestored", message: `${why}, and the undo did not complete: ${left.join("; ")}. Fix by hand.` };
  };

  // 2. Audit: the host-visible activity row, then the global moderation_actions row.
  let activityId: string | null = null;
  try {
    const r = await opts.writeActivity();
    if (r?.error) return await undo(`The event's activity log could not be written (${messageOf(r.error)})`, undefined);
    activityId = Array.isArray(r?.data) && r.data[0]?.id ? String(r.data[0].id) : null;
  } catch (err) {
    return await undo(`The event's activity log could not be written (${messageOf(err)})`, undefined);
  }
  try {
    const r = await opts.writeAudit();
    if (r?.error) return await undo(`The moderation audit row could not be written (${messageOf(r.error)})`, activityId);
  } catch (err) {
    return await undo(`The moderation audit row could not be written (${messageOf(err)})`, activityId);
  }
  return { outcome: "applied", activityId };
}
