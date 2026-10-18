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
import { decideEventTransition, eventTransitionRefusalMessage, decideEventModerationReversal, EVENT_MODERATION_REVERSIBLE_STATES, EVENT_MODERATION_STATE_ACTIVITY, type EventState, type RecordedEventModeration } from "./eventLifecycle.js"; import { readEveryRow } from "./moderationCounts.js"; import { sendPushWithRetry } from "./pushWithRetry.js"; // the transition authority (wave 5, honesty 3)
/** The columns the moderate route may patch, and so the ones its claim is guarded on. */
export const EVENT_MODERATION_COLUMNS = ["state", "visibility", "featured"] as const;
type ModeratedColumn = (typeof EVENT_MODERATION_COLUMNS)[number];

export interface ModeratedEventRow {
  id: string;
  state?: unknown;
  visibility?: unknown;
  featured?: unknown; title?: unknown; // title: a moderator's cancel pushes "<title> has been cancelled" to the attendees, as the host's does
}

export interface EventModerationOptions {
  /** The columns the action writes (visibility / featured); empty for warn_host. NEVER `state`: that is `stateDecision`, and a raw one is refused. */
  changes: Partial<Record<Exclude<ModeratedColumn, "state">, unknown>>;
  /** updated_at for the claim, and the undo's guard. One per request. */
  now: string; /** events.state, ONLY as the transition authority decided it (decideEventTransition, or decideEventModerationReversal for a restore); absent or null = state untouched. */ stateDecision?: EventStateDecided | null;
  /** The event_activity_log action word (`admin_<action>`), for the messages. */
  activityAction: string;
  /**
   * Writes the event_activity_log row and answers its id (`.insert({...}).select("id")`). The caller writes
   * both audit rows itself, with literal bodies, so the schema scans read their columns where they are sent.
   */
  writeActivity: (stateChange: EventModerationStateChange) => PromiseLike<{ data?: unknown; error?: unknown } | null | undefined>;
  /** Writes the `event_<action>` moderation_actions row. */
  writeAudit: () => PromiseLike<{ error?: unknown } | null | undefined>;
}

export type EventModerationOutcome =
  | { outcome: "applied"; activityId: string | null }
  /** The claim moved no row: the event changed (or was deleted) since it was read. Nothing was written. */
  | { outcome: "conflict"; message: string } | { outcome: "refused"; message: string } /* refused: a state change the transition authority did not decide — nothing written */
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
  const decided = decidedChanges(opts, ev); if ("refused" in decided) return decided.refused; const changes = decided.changes; const cols = (Object.keys(changes) as ModeratedColumn[]).filter((c) => (EVENT_MODERATION_COLUMNS as readonly string[]).includes(c));
  // What the undo writes back, copied BEFORE anything is written (the caller's row object may alias a store).
  const prior: Record<string, unknown> = {};
  for (const c of cols) prior[c] = ev[c] ?? null;

  // 1. Claim.
  if (cols.length > 0) {
    let claimed: unknown;
    try {
      let q = sc.from("events").update({ ...changes, updated_at: opts.now }).eq("id", ev.id);
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
        for (const c of cols) q = guard(q, c, changes[c]);
        const r = await q.select("id");
        if (r?.error) undoError = messageOf(r.error);
        restored = !r?.error && Array.isArray(r?.data) && r.data.length === 1;
      } catch (err) {
        undoError = messageOf(err);
      }
      if (!restored) left.push(`the event still reads ${cols.map((c) => `${c} = ${JSON.stringify(changes[c])}`).join(", ")} (restore failed: ${undoError})`);
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
    const r = await opts.writeActivity(stateChangeOf(changes, prior));
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
  if (changes.state === "cancelled") notifyAttendeesOfModeratedCancel(sc, req, ev); return { outcome: "applied", activityId }; // the transition's side effect, only once the change and both audit rows stand
}

// ═══════════════════════════════════════════════════════════════════════════
// events.state THROUGH THE TRANSITION AUTHORITY (wave 5, honesty 3)
// ═══════════════════════════════════════════════════════════════════════════
//
// The claim above wrote whatever `changes.state` the caller put in it: the
// moderate route's `cancel` wrote `cancelled` over a completed or archived
// event, and its `restore` wrote `open` over every cancelled or archived event,
// the host's own cancellations included. Now:
//   * `changes` may not carry `state` at all — refused, nothing written;
//   * the state is `stateDecision`, an ALLOWED decision of lib/eventLifecycle.ts
//     (decideEventTransition for cancel / remove, decideEventModerationReversal
//     for restore), and it must have been decided FROM the state this request
//     read — the claim is then conditional on that state, as writeEventState's
//     UPDATE is;
//   * the activity row records the change (`from_state` / `to_state`), which is
//     what a later restore reverses and nothing else;
//   * a change to `cancelled` tells the attendees, as the host's cancel does —
//     after the change and both audit rows stand, never before (the undo can
//     only ever reverse a change nobody has been told about).
// The host-cancel trust charge is NOT emitted: a moderator's cancel is not the
// host's act (routes/events.ts emitHostCancelledTrustEvent says the same).

/** An allowed decision of the transition authority. */
export type EventStateDecided = { readonly allowed: true; readonly from: string; readonly to: string };

/** What the activity row records: the state change (or nothing), and the visibility an action that writes it found and wrote — what a restore reverses (wave 5). */
export type EventModerationStateChange = { from_state?: string; to_state?: string } & Partial<EventVisibilityRecord>;

function decidedChanges(
  opts: EventModerationOptions,
  ev: ModeratedEventRow,
): { changes: Record<string, unknown> } | { refused: EventModerationOutcome } {
  if (Object.prototype.hasOwnProperty.call(opts.changes, "state")) {
    return { refused: { outcome: "refused", message: "events.state is written only as the transition authority decides it (a stateDecision); a raw state patch was refused. Nothing was changed or recorded." } };
  }
  const d = opts.stateDecision;
  if (d === undefined || d === null) return { changes: { ...opts.changes } };
  if (d.allowed !== true || d.from !== String(ev.state ?? "") || typeof d.to !== "string" || d.to === d.from) {
    return { refused: { outcome: "refused", message: `The state change ${String(d.from)} -> ${String(d.to)} was not decided from the state this request read ('${String(ev.state ?? "")}'). Nothing was changed or recorded.` } };
  }
  return { changes: { ...opts.changes, state: d.to } };
}

function stateChangeOf(changes: Record<string, unknown>, prior: Record<string, unknown>): EventModerationStateChange {
  return { ...(typeof changes.state === "string" ? { from_state: String(prior.state), to_state: changes.state } : {}), ...visibilityRecordOf(changes, prior) }; // + visibility (wave 5): restore wrote "public" over a friends-only event, because nothing said what the hide found
}

/** What a moderation action asks of events.state; the authority answers. */
export type EventModerationStateIntent = { to: "cancelled" | "archived" } | { reverse: true };

export type EventModerationStateAnswer =
  | { ok: true; decision: EventStateDecided | null }
  | { ok: false; code: "invalid_state_transition" | "db_error"; message: string };

/**
 * Put a moderation action's state intent to the transition authority.
 * `cancel` / `remove`: decideEventTransition, unchanged — an event already in
 * the target state is NO state change (the action still applies its other
 * columns and is audited); any other refusal is refused here, nothing written.
 * `restore`: the newest recorded moderation is read and put to
 * decideEventModerationReversal; anything but an allowed reversal is refused.
 */
export async function decideModeratedEventState(sc: any, ev: ModeratedEventRow, intent: EventModerationStateIntent | null): Promise<EventModerationStateAnswer> {
  if (intent === null) return { ok: true, decision: null };
  if ("to" in intent) {
    const d = decideEventTransition(ev.state, intent.to);
    if (d.allowed) return { ok: true, decision: d };
    if (d.reason === "same_state") return { ok: true, decision: null };
    return { ok: false, code: "invalid_state_transition", message: `${eventTransitionRefusalMessage(d)}: a moderator's action goes through the same transition authority as the host's. Nothing was changed or recorded.` };
  }
  if (!(EVENT_MODERATION_REVERSIBLE_STATES as readonly string[]).includes(String(ev.state ?? ""))) return { ok: true, decision: null };
  const rec = await readRecordedEventModeration(sc, ev.id);
  if (!rec.ok) return { ok: false, code: "db_error", message: `${rec.message}. Nothing was changed or recorded.` };
  const d = decideEventModerationReversal(ev.state, rec.recorded);
  if (d.allowed) return { ok: true, decision: d };
  return { ok: false, code: "invalid_state_transition", message: `${d.message}. Nothing was changed or recorded.` };
}

/**
 * The newest moderation STATE CHANGE recorded on an event: its
 * event_activity_log rows for admin_cancel / admin_remove / admin_restore,
 * newest first, every row read (paged past the row cap), and the first whose
 * metadata records a change (`from_state` != `to_state`). A row that changed no
 * state (a cancel of an already-cancelled event) is not a change and is passed
 * over. A read that fails, or answers no list, is not "no record".
 */
export async function readRecordedEventModeration(sc: any, eventId: string): Promise<{ ok: true; recorded: RecordedEventModeration | null } | { ok: false; message: string }> {
  const rows = await readEveryRow((from, to, count) => sc
    .from("event_activity_log")
    .select("id, action, metadata, created_at", { count })
    .eq("event_id", eventId)
    .in("action", EVENT_MODERATION_STATE_ACTIVITY as string[])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to));
  if (rows.error || !rows.data) return { ok: false, message: `The event's moderation record could not be read (event_activity_log): ${rows.error?.message ?? "no rows answered"}` };
  for (const r of rows.data) {
    const m = r?.metadata;
    if (m && typeof m === "object" && typeof m.from_state === "string" && typeof m.to_state === "string" && m.from_state !== m.to_state) {
      return { ok: true, recorded: { action: String(r.action), from_state: m.from_state, to_state: m.to_state } };
    }
  }
  return { ok: true, recorded: null };
}

const RECIPIENT_CHUNK = 100;

/**
 * The host's cancel pushes "Event cancelled" to the going / maybe attendees
 * (routes/events.ts POST /events/:id/cancel and DELETE /events/:id); a
 * moderator's cancel told nobody. Fire-and-forget, as the host's is: the change
 * is already durable and audited. Every read is checked and paged past the row
 * cap; one that fails tells nobody and is LOGGED (an outage is not "nobody was
 * going").
 */
function notifyAttendeesOfModeratedCancel(sc: any, req: any, ev: ModeratedEventRow): void {
  void (async () => {
    try {
      const rsvps = await readEveryRow((from, to, count) => sc
        .from("event_rsvps")
        .select("user_id", { count })
        .eq("event_id", ev.id)
        .in("status", ["going", "maybe"])
        .order("user_id", { ascending: true })
        .range(from, to));
      if (rsvps.error || !rsvps.data) {
        req?.log?.warn?.({ eventId: ev.id, err: rsvps.error }, "moderator cancel: attendee read failed — nobody was told");
        return;
      }
      const ids = [...new Set(rsvps.data.map((r: any) => String(r.user_id)))];
      const recipients: Array<{ userId: string; tokens: string[] }> = [];
      for (let i = 0; i < ids.length; i += RECIPIENT_CHUNK) {
        const chunk = ids.slice(i, i + RECIPIENT_CHUNK);
        const got = await readEveryRow((from, to, count) => sc
          .from("profiles")
          .select("id, expo_push_token", { count })
          .in("id", chunk)
          .not("expo_push_token", "is", null)
          .order("id", { ascending: true })
          .range(from, to));
        if (got.error || !got.data) {
          req?.log?.warn?.({ eventId: ev.id, err: got.error }, "moderator cancel: attendee push tokens unreadable — nobody was told");
          return;
        }
        for (const p of got.data) if (p?.expo_push_token) recipients.push({ userId: String(p.id), tokens: [String(p.expo_push_token)] });
      }
      if (recipients.length === 0) return;
      await sendPushWithRetry(sc, recipients, {
        title: "Event cancelled",
        body: `"${String(ev.title ?? "An event")}" has been cancelled.`,
        data: { eventId: ev.id, type: "event_cancelled" },
      });
    } catch (err) {
      // resolves-not-throws-ok: fire-and-forget push, as the host's cancel — best-effort, logged.
      req?.log?.warn?.({ err, eventId: ev.id }, "moderator cancel: attendee push failed");
    }
  })();
}

export type AppealEventReversal =
  /** What the reversal put back: the state, the visibility, or both (each null when that column was not moderated). */
  | { outcome: "restored"; state: { from: string; to: string } | null; visibility: { from: string; to: string } | null }
  /** The event is not the appellant's, or does not exist. */
  | { outcome: "not_found" }
  /** Nothing recorded that this appeal can reverse, or a hide whose prior visibility was never recorded. A person must look. */
  | { outcome: "refused"; message: string }
  /** A read or write failed, or the event changed mid-request: nothing (or nothing lasting) was written; retry. */
  | { outcome: "failed"; message: string };

/**
 * An approved appeal of a moderated event (services/appeals/resolveAppeal.ts)
 * wrote `state: "open"` over every state — publishing a draft, reopening a
 * completed event, un-cancelling a host's own cancellation — and never put a
 * hidden event's visibility back at all. It now reverses exactly what the
 * moderate route's `restore` reverses, through the same deciders: the newest
 * recorded moderation STATE change (decideModeratedEventState), and the newest
 * recorded hide or remove's VISIBILITY (decideRestoredEventVisibility, below).
 * Nothing recorded to reverse, or a hide that never recorded what it found, is
 * refused — deferred to a person — with nothing written. Claimed, recorded (an
 * `admin_restore` activity row, `via: "appeal"`, carrying both records), and
 * undone if that record cannot be written: an unrecorded reversal would leave
 * the next restore deciding on a stale record.
 */
export async function reverseModeratedEventOnAppeal(
  sc: any,
  a: { eventId: string; hostId: string; actorId: string | null; appealId: string; note: string | null },
): Promise<AppealEventReversal> {
  let ev: ModeratedEventRow | null;
  try {
    const { data, error } = await sc.from("events").select("id, host_id, title, state, visibility, featured").eq("id", a.eventId).eq("host_id", a.hostId).maybeSingle();
    if (error) return { outcome: "failed", message: `the event could not be read: ${messageOf(error)}` };
    ev = (data as ModeratedEventRow | null) ?? null;
  } catch (err) {
    return { outcome: "failed", message: `the event could not be read: ${messageOf(err)}` };
  }
  if (!ev) return { outcome: "not_found" };
  let stateDecision: EventStateDecided | null = null;
  if ((EVENT_MODERATION_REVERSIBLE_STATES as readonly string[]).includes(String(ev.state ?? ""))) {
    const answer = await decideModeratedEventState(sc, ev, { reverse: true });
    if (!answer.ok) return answer.code === "db_error" ? { outcome: "failed", message: answer.message } : { outcome: "refused", message: answer.message };
    stateDecision = answer.decision;
  }
  const vis = await decideRestoredEventVisibility(sc, ev);
  if (!vis.ok) return vis.code === "db_error" ? { outcome: "failed", message: vis.message } : { outcome: "refused", message: vis.message };
  if (!stateDecision && !vis.decision) {
    return { outcome: "refused", message: `the event is '${String(ev.state)}': there is no moderation state change to reverse, and its visibility ('${String(ev.visibility)}') holds no recorded hide to reverse (an appeal reverses a moderator's cancel, remove or hide)` };
  }
  const out = await applyEventModeration(sc, null, ev, {
    changes: vis.decision ? { visibility: vis.decision.to } : {}, stateDecision, now: new Date().toISOString(), activityAction: "admin_restore",
    writeActivity: (st) => sc.from("event_activity_log").insert({ event_id: a.eventId, actor_id: a.actorId, action: "admin_restore", metadata: { via: "appeal", appeal_id: a.appealId, reason: a.note, ...st } }).select("id"),
    writeAudit: () => Promise.resolve({ error: null }), // the appeal row is this reversal's audit record (routes/appeals.ts commits it after this answers)
  });
  if (out.outcome === "applied") return { outcome: "restored", state: stateDecision ? { from: stateDecision.from, to: stateDecision.to } : null, visibility: vis.decision };
  return { outcome: "failed", message: out.message };
}

// ═══════════════════════════════════════════════════════════════════════════
// VISIBILITY: a restore puts back ONLY what a recorded hide found (wave 5)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE PRIVACY DEFECT (census-trust, wave 5). `hide` writes visibility
// `invite_only`; `remove` writes `invite_only` and archives. `restore` wrote
// `public` over EVERY event, whatever it had held before the hide: a
// friends-only or circle event came back PUBLIC — to every feed, search and
// the public-read policy. And an approved appeal never put visibility back at
// all, so a hidden event stayed hidden.
//
// THE RECORD. Every action that writes visibility (hide, remove, a restore
// that puts it back, the appeal's restore) records on its own
// event_activity_log row the value it FOUND and the value it WROTE:
// metadata.from_visibility / to_visibility — equal when it changed nothing —
// beside the state record, in the same claim -> audit -> undo order
// (stateChangeOf above). No schema change: metadata is jsonb.
//
// THE REVERSAL (route and appeal alike). The newest visibility moderation
// (admin_hide / admin_remove / admin_restore; paged, newest first; a record
// that changed nothing is passed over) decides:
//   * a RECORDED hide or remove whose value the event still holds -> back to
//     exactly the value it found;
//   * nothing to reverse — no moderation ever changed the visibility, or the
//     newest one is a restore — so the visibility is the host's own -> left as
//     it is;
//   * a hide or remove that did NOT record what it found (it predates the
//     record) and whose `invite_only` the event still holds -> REFUSED,
//     nothing written. The prior value is unknowable and any guess can only
//     widen, so the event keeps `invite_only`: of event_visibility's labels
//     (baseline: public | friends_only | invite_only; the API's `circle` /
//     `trip` are not stored, census-discovery §64.10) it is the most
//     restrictive — no feed or search reads it (they read public and
//     friends_only) and the public-read policy admits `public` only.
// A restore never writes a visibility that no record holds; it never writes
// `public` from nothing.
//
// Only an event that reads `invite_only` — the one value hide and remove
// write — can hold a hide to reverse; any other value is the host's own and is
// left as it is, without a read.
//
// STATED LIMIT. A host may change visibility (PATCH /events/:id) and that
// writes no record. A host who moved a hidden event away from `invite_only`
// and back again is not seen: its restore puts back the host's own value from
// before the hide.

/** The visibility `hide` and `remove` write (routes/admin.ts). */
export const EVENT_HIDDEN_VISIBILITY = "invite_only";

/** event_activity_log actions that write events.visibility, and so record it. */
export const EVENT_MODERATION_VISIBILITY_ACTIVITY: readonly string[] = Object.freeze(["admin_hide", "admin_remove", "admin_restore"]);

/** The visibility record on a moderation's activity row: what it found, what it wrote. */
export interface EventVisibilityRecord { from_visibility: string; to_visibility: string }

/** The record, when the action writes visibility and the value it found was read; otherwise nothing (and a later restore treats the row as unrecorded). */
function visibilityRecordOf(changes: Record<string, unknown>, prior: Record<string, unknown>): Partial<EventVisibilityRecord> {
  return typeof changes.visibility === "string" && typeof prior.visibility === "string" ? { from_visibility: prior.visibility, to_visibility: changes.visibility } : {};
}

/** The newest visibility moderation on an event, as its activity rows hold it. */
export type RecordedEventVisibility =
  | { kind: "none" }
  | { kind: "recorded"; action: string; from: string; to: string }
  | { kind: "unrecorded"; action: string };

/**
 * The newest moderation that wrote the event's visibility: its
 * event_activity_log rows for admin_hide / admin_remove / admin_restore,
 * newest first, every row read (paged past the row cap). A row recording no
 * change (found == wrote) is passed over; the first other row decides — a
 * recorded change, or a row that records nothing (`unrecorded`). A read that
 * fails, or answers no list, is not "no record".
 */
export async function readRecordedEventVisibility(sc: any, eventId: string): Promise<{ ok: true; recorded: RecordedEventVisibility } | { ok: false; message: string }> {
  const rows = await readEveryRow((from, to, count) => sc
    .from("event_activity_log")
    .select("id, action, metadata, created_at", { count })
    .eq("event_id", eventId)
    .in("action", EVENT_MODERATION_VISIBILITY_ACTIVITY as string[])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to));
  if (rows.error || !rows.data) return { ok: false, message: `The event's visibility record could not be read (event_activity_log): ${rows.error?.message ?? "no rows answered"}` };
  for (const r of rows.data) {
    const m = r?.metadata;
    const held = m && typeof m === "object" && typeof m.from_visibility === "string" && m.from_visibility !== "" && typeof m.to_visibility === "string" && m.to_visibility !== "";
    if (!held) return { ok: true, recorded: { kind: "unrecorded", action: String(r?.action) } };
    if (m.from_visibility !== m.to_visibility) return { ok: true, recorded: { kind: "recorded", action: String(r.action), from: m.from_visibility, to: m.to_visibility } };
  }
  return { ok: true, recorded: { kind: "none" } };
}

export type EventVisibilityReversal =
  | { kind: "reverse"; from: string; to: string }
  /** Nothing a moderation left to reverse: the value is the host's own. */
  | { kind: "keep"; why: string }
  /** A hide or remove that never recorded what it found still holds: refuse, never guess. */
  | { kind: "unknown"; why: string };

/** May a restore move this event's visibility from `current` back to what its newest visibility moderation found? Pure. */
export function decideEventVisibilityReversal(current: unknown, recorded: RecordedEventVisibility | null | undefined): EventVisibilityReversal {
  const cur = typeof current === "string" ? current : String(current ?? "");
  if (!recorded || recorded.kind === "none") return { kind: "keep", why: `no moderation changed this event's visibility ('${cur}' is its host's)` };
  if (recorded.action === "admin_restore") return { kind: "keep", why: `the newest moderation of this event's visibility is a restore ('${cur}' is its host's since)` };
  if (recorded.kind === "recorded") {
    if (recorded.to === cur) return { kind: "reverse", from: cur, to: recorded.from };
    return { kind: "keep", why: `this event's visibility changed since the ${recorded.action} (it wrote '${recorded.to}'; it reads '${cur}'), so the later value stands` };
  }
  if (cur === EVENT_HIDDEN_VISIBILITY) {
    return { kind: "unknown", why: `Event is hidden ('${cur}') by an ${recorded.action} that did not record the visibility it found (it predates the record), so a restore cannot know it and will not widen it: the event keeps '${cur}', the most restrictive visibility` };
  }
  return { kind: "keep", why: `this event's visibility changed since the ${recorded.action} ('${cur}' is not what it wrote), so the later value stands` };
}

export type EventVisibilityAnswer =
  | { ok: true; decision: { from: string; to: string } | null }
  | { ok: false; code: "invalid_state_transition" | "db_error"; message: string };

/**
 * What a restore does to visibility: back to the value the newest recorded
 * hide / remove found (`decision`), or nothing (`null`); a hide that never
 * recorded what it found is REFUSED, nothing written (see above).
 */
export async function decideRestoredEventVisibility(sc: any, ev: ModeratedEventRow): Promise<EventVisibilityAnswer> {
  if (ev.visibility !== EVENT_HIDDEN_VISIBILITY) return { ok: true, decision: null }; // not a value a hide writes: the host's own, left as it is
  const rec = await readRecordedEventVisibility(sc, ev.id);
  if (!rec.ok) return { ok: false, code: "db_error", message: `${rec.message}. Nothing was changed or recorded.` };
  const d = decideEventVisibilityReversal(ev.visibility, rec.recorded);
  if (d.kind === "reverse") return { ok: true, decision: { from: d.from, to: d.to } };
  if (d.kind === "unknown") return { ok: false, code: "invalid_state_transition", message: `${d.why}. Nothing was changed or recorded.` };
  return { ok: true, decision: null };
}
