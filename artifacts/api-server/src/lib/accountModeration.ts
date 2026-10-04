/**
 * accountModeration — the ONE writer for account bans and suspensions.
 *
 * `user_account_states` is the authoritative moderation state (owner decision
 * 2026-10-03; the contract is written out at the head of lib/accountStateGate.ts,
 * which holds the one READ path). Every admin path that bans, suspends or lifts
 * a sanction — POST /admin/users/:id/ban, /suspend, /restore and PATCH
 * /admin/users/:id/moderation-action — writes through here, so there is one
 * shape of row and one revocation rule.
 *
 * WHAT USED TO HAPPEN. /ban and /suspend wrote `profiles.account_status =
 * 'banned' | 'suspended'` FIRST and returned db_error when it failed — and it
 * always failed, because profiles_account_status_check admits only active |
 * deactivated | pending_deletion | deleted. The user_account_states upsert after
 * it was never reached, and its own error was swallowed (`.then(undefined,
 * () => {})`) on the occasions it was. The moderation-action PATCH wrote the
 * row and then the same impossible profiles value. /restore DELETED the
 * banned/suspended rows (history gone) and set account_status 'active' — which
 * would also have silently reactivated a deactivated or pending-deletion
 * account. None of this writes `profiles.account_status` any more: that column
 * keeps deletion and deactivation, which are not moderation.
 *
 * THE ROW. One per (user_id, state) — the table's UNIQUE key, so a ban upserts.
 *   ban       state 'banned',    expires_at NULL (permanent)
 *   suspend   state 'suspended', expires_at = the end (NULL = until lifted)
 *   lift      every IN-FORCE banned/suspended row gets expires_at := now. The
 *             row stays — reason, set_by, created_at — so the sanction's history
 *             survives the unban; moderation_actions (written by the route,
 *             audit-first) records who lifted it and why. Expiry-aware readers
 *             (circleAccessGuard, CompassNotificationEngine, the gate) honour a
 *             lift with no change of their own, and no column is needed that a
 *             hosted database might not have yet.
 *
 * THE SESSION LOCK. The row is what every API request is refused on. A
 * client also holds a refresh token and talks to PostgREST, Realtime and
 * Storage directly with its access token, under RLS that knows nothing of bans
 * (227 tables carry a client write policy, measured on the testing database
 * 2026-10-03). So a restriction also sets the auth user's GoTrue `banned_until`
 * (`ban_duration`): refresh and sign-in are refused, and GoTrue rejects the
 * still-valid access token too, so the direct paths close within one access
 * token lifetime. It is a CONSEQUENCE of the row, never consulted to decide
 * access — the gate reads only the row — and a lift clears it. A lock that
 * fails is reported (`sessionLock: "failed"`), never hidden: for a ban the API
 * refusal already holds; for a lift the caller must answer an error, because
 * the account would otherwise stay locked out of sign-in after its unban.
 *
 * THE LOCK FOLLOWS EVERY ROW IN FORCE, NOT THE ROW JUST WRITTEN. One user can
 * hold a `banned` row and a `suspended` row at once (the key is (user_id,
 * state)). Suspending an already-banned user used to set `ban_duration` to the
 * suspension's length: GoTrue's lock then lapsed with the suspension while the
 * ban row was still in force, and the banned account could refresh its session
 * and reach PostgREST, Realtime and Storage directly again. The lock is now
 * computed from ALL the user's in-force rows after the write (`lockForRowsInForce`):
 * permanent if any has no end, otherwise the LATEST end. If those rows cannot
 * be read back, the lock is left as it is and reported `failed` — never
 * shortened on a guess.
 *
 * Open Telegraph streams are closed (terminateUserConnections, fanned out to
 * other instances); the notification stream re-checks the row itself
 * (watchAccountRestriction).
 *
 * AN END IS A REAL TIMESTAMP OR IT IS REFUSED (`parseRestrictionEnd`).
 * `Date.parse("2099")` is a valid future instant to JavaScript and not a
 * timestamp to PostgreSQL, so POST /admin/users/:id/suspend accepted it,
 * wrote its audit row, and then failed the write. The end is now checked for
 * shape before anything is written and stored as the normalised ISO instant.
 *
 * A RESTRICTION THAT DID NOT LAND IS SAID SO IN THE AUDIT TRAIL
 * (`recordModerationNotApplied`). The routes audit FIRST (fail-closed: no
 * sanction without a record), so a failed write used to leave a
 * `permanent_ban` row behind that read exactly like a ban that landed. The
 * trail is append-only, so the correction is a second row —
 * `<action>_not_applied`, naming the first — not an edit of the first.
 */
import { terminateUserConnections } from "./telegraphEvents.js";
import { MODERATION_RESTRICTION_STATES, isRestrictionRowInForce, type ModerationRestrictionState } from "./accountStateGate.js";

/** GoTrue `ban_duration` for an open-ended restriction (100 years). */
export const PERMANENT_SESSION_LOCK = "876000h";

/**
 * The GoTrue `ban_duration` that ends with the restriction: permanent for an
 * open-ended one, whole seconds (rounded UP, so the lock never lifts before the
 * row does) for a timed one, and null when the end is already past.
 */
export function sessionLockDuration(expiresAt: string | null, now: Date): string | null {
  if (expiresAt == null) return PERMANENT_SESSION_LOCK;
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return PERMANENT_SESSION_LOCK;
  const ms = end - now.getTime();
  if (ms <= 0) return null;
  return `${Math.ceil(ms / 1000)}s`;
}

/**
 * The GoTrue `ban_duration` that covers EVERY restriction row in force at `now`:
 * permanent when any in-force row has no end (or an end that does not parse —
 * a malformed date never shortens a lock), otherwise the latest end, and null
 * when nothing is in force. Rows of any state may be passed; only banned and
 * suspended ones count.
 */
export function lockForRowsInForce(
  rows: ReadonlyArray<{ state?: unknown; expires_at?: unknown }>,
  now: Date,
): string | null {
  const nowMs = now.getTime();
  let latest: number | null = null;
  for (const r of rows) {
    if (!(MODERATION_RESTRICTION_STATES as readonly unknown[]).includes(r.state)) continue;
    if (!isRestrictionRowInForce(r.expires_at, nowMs)) continue;
    if (r.expires_at == null) return PERMANENT_SESSION_LOCK;
    const end = Date.parse(String(r.expires_at));
    if (Number.isNaN(end)) return PERMANENT_SESSION_LOCK;
    if (latest === null || end > latest) latest = end;
  }
  if (latest === null) return null;
  return `${Math.ceil((latest - nowMs) / 1000)}s`;
}

/** The message POST /admin/users/:id/suspend answers 400 with for an end that is not a real future instant. */
export const RESTRICTION_END_MESSAGE =
  "expires_at must be a future ISO-8601 timestamp with a time and an offset (e.g. 2026-12-31T00:00:00Z), or omitted (until lifted)";

const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A suspension's end as an admin supplied it → the value to store.
 *   omitted / null  → `{ ok: true, expiresAt: null }` (until lifted)
 *   a full ISO-8601 date-time WITH an offset (`Z` or `±hh:mm`), in the future
 *                   → `{ ok: true, expiresAt: <normalised ISO instant> }`
 *   anything else   → `{ ok: false }` with the message to answer 400 with
 *
 * "Anything else" includes what `Date.parse` alone would have let through and
 * PostgreSQL then refused or misread: a bare year (`"2099"`), a date with no
 * time, a local time with no offset (whose meaning depends on the server's
 * zone), a number, an instant that is not in the future (a suspension that is
 * never in force) — and a calendar date that does not exist. JavaScript rolls
 * `2027-02-30` forward to March 2 and `24:00` into the next day; PostgreSQL
 * refuses the first, and neither is the instant the admin typed.
 */
export function parseRestrictionEnd(
  raw: unknown,
  now: Date,
): { ok: true; expiresAt: string | null } | { ok: false; message: string } {
  if (raw === null || raw === undefined) return { ok: true, expiresAt: null };
  const refused = { ok: false as const, message: RESTRICTION_END_MESSAGE };
  if (typeof raw !== "string") return refused;
  const m = ISO_INSTANT.exec(raw.trim());
  if (!m) return refused;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]), hour = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23) return refused;
  const end = Date.parse(raw.trim());
  if (Number.isNaN(end) || end <= now.getTime()) return refused;
  return { ok: true, expiresAt: new Date(end).toISOString() };
}

export type SessionLockOutcome = "locked" | "unlocked" | "not_needed" | "failed";

async function setSessionLock(
  sc: any,
  userId: string,
  banDuration: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const admin = sc?.auth?.admin;
    if (!admin || typeof admin.updateUserById !== "function") {
      return { ok: false, error: "auth admin API unavailable" };
    }
    const { error } = await admin.updateUserById(userId, { ban_duration: banDuration });
    if (error) return { ok: false, error: String(error.message ?? error.code ?? error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as any)?.message ?? err) };
  }
}

export type ApplyRestrictionResult =
  | { ok: true; sessionLock: Exclude<SessionLockOutcome, "unlocked">; sessionLockError?: string }
  | { ok: false; error: string };

/**
 * Ban or suspend: write the authoritative row, then lock the auth session and
 * close open Telegraph streams. `ok: false` means the ROW was not written and
 * nothing is in force; the caller refuses.
 */
export async function applyAccountRestriction(
  sc: any,
  input: {
    userId: string;
    kind: ModerationRestrictionState;
    reason: string | null;
    /** NULL = until lifted. A ban is always NULL. */
    expiresAt: string | null;
    actorId: string;
    now?: Date;
  },
): Promise<ApplyRestrictionResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  // A ban has no end. A suspension's end is checked HERE as well as at the route:
  // this is the only writer, and a value PostgreSQL would refuse (or read in the
  // server's zone) must be refused before the row is attempted, whoever calls.
  const end = input.kind === "banned" ? { ok: true as const, expiresAt: null } : parseRestrictionEnd(input.expiresAt, now);
  if (!end.ok) return { ok: false, error: end.message };
  const expiresAt = end.expiresAt;
  const { error } = await sc.from("user_account_states").upsert(
    {
      user_id: input.userId,
      state: input.kind,
      reason: input.reason ?? null,
      expires_at: expiresAt,
      set_by: input.actorId,
      created_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "user_id,state" },
  );
  if (error) return { ok: false, error: String(error.message ?? error.code ?? "user_account_states write failed") };

  try { terminateUserConnections(input.userId); } catch { /* best effort: the stream's own gate re-runs on reconnect */ }

  // The lock covers EVERY row in force, not only the one just written: read them
  // back. A read that fails leaves the lock untouched and says so — setting it
  // from this row alone is what let a suspension shorten a ban's lock.
  let inForce: Array<{ state?: unknown; expires_at?: unknown }>;
  try {
    const read = await sc
      .from("user_account_states")
      .select("state, expires_at")
      .eq("user_id", input.userId)
      .in("state", [...MODERATION_RESTRICTION_STATES]);
    if (read?.error) {
      return { ok: true, sessionLock: "failed", sessionLockError: `could not read the restrictions in force (${String(read.error.message ?? read.error.code ?? "db_error")}); the auth session lock was left unchanged` };
    }
    if (!Array.isArray(read?.data)) {
      return { ok: true, sessionLock: "failed", sessionLockError: "could not read the restrictions in force (no row list); the auth session lock was left unchanged" };
    }
    inForce = read.data;
  } catch (err) {
    return { ok: true, sessionLock: "failed", sessionLockError: `could not read the restrictions in force (${String((err as any)?.message ?? err)}); the auth session lock was left unchanged` };
  }
  // The row just written is in force whatever the read-back shows (a replica a
  // moment behind must not make the lock shorter than the restriction).
  const duration = lockForRowsInForce([...inForce, { state: input.kind, expires_at: expiresAt }], now);
  if (duration === null) return { ok: true, sessionLock: "not_needed" };
  const lock = await setSessionLock(sc, input.userId, duration);
  if (!lock.ok) return { ok: true, sessionLock: "failed", sessionLockError: lock.error };
  return { ok: true, sessionLock: "locked" };
}

/**
 * Say in the audit trail that a moderation action did NOT take effect.
 *
 * The admin routes write their `moderation_actions` row FIRST (fail-closed: no
 * sanction without a record) and the state change second. When the second write
 * fails, the first row is still there, and it reads exactly like an action that
 * landed — to GET /admin/users/:id/summary, and to anyone auditing the trail
 * later. The trail is append-only, so the correction is another row:
 * `<actionType>_not_applied`, whose `metadata.voids_action_id` names the row it
 * corrects and whose reason carries the write's error.
 *
 * `ok: false` means even that could not be written; the caller must say so in
 * its answer, because the trail then really does hold a row that looks landed.
 */
export async function recordModerationNotApplied(
  sc: any,
  input: { userId: string; actorId: string; actionType: string; auditId?: string | null; error: string; now?: Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await sc.from("moderation_actions").insert({
      target_user_id: input.userId,
      action_type: `${input.actionType}_not_applied`,
      reason: `The ${input.actionType} recorded just before this did NOT take effect: ${input.error}`,
      performed_by: input.actorId,
      created_at: (input.now ?? new Date()).toISOString(),
      metadata: { voids_action_id: input.auditId ?? null, voided_action_type: input.actionType, write_error: input.error },
    });
    if (error) return { ok: false, error: String(error.message ?? error.code ?? "moderation_actions write failed") };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as any)?.message ?? err) };
  }
}

/** The sentence a route appends to its refusal after `recordModerationNotApplied`. */
export function notAppliedAuditNote(voided: { ok: true } | { ok: false; error: string }): string {
  return voided.ok
    ? " The audit trail records that this attempt did not take effect."
    : ` WARNING: the audit row for this attempt could NOT be marked as not applied (${voided.error}); it reads as if it landed.`;
}

export type RevokeRestrictionResult =
  | { ok: true; revoked: number; sessionLock: "unlocked" | "failed"; sessionLockError?: string }
  | { ok: false; error: string };

/**
 * Lift every in-force ban and suspension: expires_at := now on each, rows kept.
 * Then clear the auth session lock. `ok: false` means the rows could not be
 * updated and the restriction still stands.
 */
export async function revokeAccountRestrictions(
  sc: any,
  input: { userId: string; now?: Date },
): Promise<RevokeRestrictionResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const { data, error } = await sc
    .from("user_account_states")
    .update({ expires_at: nowIso, updated_at: nowIso })
    .eq("user_id", input.userId)
    .in("state", [...MODERATION_RESTRICTION_STATES])
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .select("id");
  if (error) return { ok: false, error: String(error.message ?? error.code ?? "user_account_states update failed") };
  const revoked = Array.isArray(data) ? data.length : 0;

  const unlock = await setSessionLock(sc, input.userId, "none");
  if (!unlock.ok) return { ok: true, revoked, sessionLock: "failed", sessionLockError: unlock.error };
  return { ok: true, revoked, sessionLock: "unlocked" };
}
