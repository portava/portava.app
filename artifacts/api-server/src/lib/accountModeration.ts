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
 * Open Telegraph streams are closed (terminateUserConnections, fanned out to
 * other instances); the notification stream re-checks the row itself
 * (watchAccountRestriction).
 */
import { terminateUserConnections } from "./telegraphEvents.js";
import { MODERATION_RESTRICTION_STATES, type ModerationRestrictionState } from "./accountStateGate.js";

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
  const expiresAt = input.kind === "banned" ? null : input.expiresAt;
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

  const duration = sessionLockDuration(expiresAt, now);
  if (duration === null) return { ok: true, sessionLock: "not_needed" };
  const lock = await setSessionLock(sc, input.userId, duration);
  if (!lock.ok) return { ok: true, sessionLock: "failed", sessionLockError: lock.error };
  return { ok: true, sessionLock: "locked" };
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
