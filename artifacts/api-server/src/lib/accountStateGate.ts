/**
 * accountStateGate — the ONE account-state gate for every bearer token, not
 * only the ones that reach `requireUser`.
 *
 * ── THE AUTHORITATIVE MODERATION STATE ──────────────────────────────────────
 * Bans and suspensions live in `user_account_states` (migration 0063 :155,
 * +0130 updated_at), and NOWHERE ELSE. `profiles.account_status` cannot hold
 * them: profiles_account_status_check permits exactly active | deactivated |
 * pending_deletion | deleted (baseline, and verified read-only on the hosted
 * testing database 2026-10-03), so every gate that compared it to 'banned' /
 * 'suspended' compared against a value no row can carry, and every admin write
 * of those values was rejected 23514. The owner's decision (2026-10-03):
 * `user_account_states` is canonical. The contract, as confirmed:
 *
 *   one row per (user_id, state)   UNIQUE (user_id, state) — upserts key on it
 *   state 'banned' | 'suspended'   the two moderation restrictions this gate reads
 *   expires_at NULL                in force until revoked (a permanent ban)
 *   expires_at > now               in force until then (a temporary suspension)
 *   expires_at <= now              NOT in force: expired, or REVOKED — an unban
 *                                  sets expires_at to the revocation instant and
 *                                  keeps the row (reason, set_by, created_at), so
 *                                  history survives and every expiry-aware reader
 *                                  (circleAccessGuard, CompassNotificationEngine)
 *                                  honours the unban with no change of its own
 *   an unparseable expires_at      IN FORCE: a garbage end date never lifts a ban
 *   RLS                            authenticated reads its OWN rows only; no client
 *                                  write policy, so a banned user cannot lift it
 *
 * `profiles.account_status` keeps its own, unchanged meanings: deleted,
 * pending_deletion and deactivated. One read path (`resolveAccountRestriction`)
 * combines the two, and every gate below answers from it.
 *
 * ── WHERE IT RUNS ───────────────────────────────────────────────────────────
 * requireUser (lib/http.ts, via enforceAccountState), optionalUser (lib/http.ts,
 * via optionalUserFromToken), every route that extracts its own bearer token
 * (passport, profileTabs, follows, og, stamps, passportStamps, hiddenGems —
 * optional, optionalUserFromToken; discovery's three viewer lookups — optional,
 * getGatedUser; the Telegraph SSE stream — required, requireUserFromToken), and
 * the long-lived notification stream's periodic re-check
 * (watchAccountRestriction). NO route verifies a bearer token any other way:
 * handRolledAuthAccountState.test.ts scans src/ for `.auth.getUser(` outside
 * this file and lib/http.ts, with no exemption, and for any `try` whose `catch`
 * would swallow the refusal these helpers throw. It lives beside lib/http.ts
 * rather than in it because the census documents cite lib/http.ts by line.
 *
 * ── WHAT EACH ANSWER IS ─────────────────────────────────────────────────────
 *   banned / suspended (in force) → 403 `forbidden`, reason `account_banned` /
 *     `account_suspended`, plus `restriction: { kind, until }` (the end as an
 *     ISO instant, or null) so a client need not parse the message to tell a
 *     restricted account from a connection fault or to show when a suspension
 *     ends — on REQUIRED and OPTIONAL auth alike. An optional-auth
 *     route does NOT downgrade a restricted caller to an anonymous visitor: the
 *     caller identified themselves, the account is restricted, and serving them
 *     the anonymous view would be the restriction silently not applying (the
 *     owner's ruling, 2026-10-03, reversing PR #580's anonymous mapping).
 *   the auth service refuses the token as banned (GoTrue `user_banned`, the
 *     session lock lib/accountModeration.ts sets beside the row) → the same 403,
 *     reason `account_restricted`, never 401 (which would read as "signed out")
 *     and never anonymous.
 *   unreadable (either read) → 503 `degraded_unavailable`, retryable. A DATABASE
 *     FAILURE IS NOT A RESTRICTION: it is never answered 403 (that would assert
 *     a ban that is not in evidence) and never served (that would treat an
 *     unread ban as no ban).
 *   deleted → required: served (unchanged); optional: anonymous (unchanged, PR
 *     #580 — a tombstoned account has no standing to an owner view).
 *   active / deactivated / pending_deletion / no profile row → served.
 *
 * A token issued BEFORE the ban is refused the same way: nothing here trusts the
 * token beyond its identity, and the state is read on every request.
 */
import type { Request, Response } from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { sendError, type ApiErrorCode } from "./http.js";
import { isPostgrestBackedClient } from "./supabase.js";

// ---------------------------------------------------------------------------
// The one read path
// ---------------------------------------------------------------------------

/** The two `user_account_states.state` values that restrict access. */
export const MODERATION_RESTRICTION_STATES = ["banned", "suspended"] as const;
export type ModerationRestrictionState = (typeof MODERATION_RESTRICTION_STATES)[number];

/** A user's effective moderation restriction. `until` is null for an open-ended one. */
export type AccountRestriction =
  | { kind: "none" }
  | { kind: "banned"; until: string | null }
  | { kind: "suspended"; until: string | null };

/**
 * `ok` — both reads succeeded: `accountStatus` is `profiles.account_status`
 * ("active" when the profile row or column is absent: a brand-new account's
 * auth user exists before its profile row does), `restriction` the in-force
 * moderation row. `unavailable` — either read failed; nothing is known.
 */
export type AccountRestrictionRead =
  | { state: "ok"; accountStatus: string; restriction: AccountRestriction }
  | { state: "unavailable"; reason: string };

/**
 * Whether a `user_account_states` row is in force at `nowMs`: no end (NULL), or
 * an end still in the future. An end that does not parse is IN FORCE — a
 * malformed date must never be the thing that lifts a ban.
 */
export function isRestrictionRowInForce(expiresAt: unknown, nowMs: number): boolean {
  if (expiresAt == null) return true;
  const end = Date.parse(String(expiresAt));
  if (Number.isNaN(end)) return true;
  return end > nowMs;
}

/**
 * The in-force moderation restriction among `rows` (any order, any states):
 * banned outranks suspended. UNIQUE (user_id, state) admits one row per kind,
 * so there is never a choice between two ends of the same kind.
 */
export function pickRestriction(
  rows: ReadonlyArray<{ state?: unknown; expires_at?: unknown }>,
  nowMs: number,
): AccountRestriction {
  let banned: { until: string | null } | null = null;
  let suspended: { until: string | null } | null = null;
  for (const r of rows) {
    if (!isRestrictionRowInForce(r.expires_at, nowMs)) continue;
    const until = r.expires_at == null ? null : String(r.expires_at);
    if (r.state === "banned") banned = { until };
    else if (r.state === "suspended") suspended = { until };
  }
  if (banned) return { kind: "banned", until: banned.until };
  if (suspended) return { kind: "suspended", until: suspended.until };
  return { kind: "none" };
}

/**
 * The select behind the gate: `profiles.account_status` and, EMBEDDED through
 * the user_id foreign key, the user's `user_account_states` rows. One request,
 * one snapshot: the moderation rows cannot be read at a different moment from
 * the status beside them, and a gate on every authenticated request costs one
 * round trip rather than two. The FK is named rather than inferred because the
 * table has TWO foreign keys to profiles (user_id, set_by);
 * `user_account_states_user_id_fkey` is the name on the baseline, on the
 * testing database and on portava-ci (verified read-only 2026-10-03). Every
 * state is embedded (the UNIQUE (user_id, state) key bounds it to one row per
 * kind) and the restriction is picked in pickRestriction.
 */
export const ACCOUNT_STATE_GATE_SELECT =
  "account_status, user_account_states!user_account_states_user_id_fkey(state, expires_at)";

/**
 * The gate's one read. supabase-js RESOLVES `{ data: null, error }` on a failed
 * query, so `error` is the failure path, and PostgREST fails the WHOLE request
 * when an embed cannot be resolved — a moderation table it cannot see is an
 * error here, never an empty list.
 *
 *   no profile row      → status "active", no rows. Not a guess: user_id is a
 *                         foreign key to profiles, so a user with no profile
 *                         row has no moderation row either (a brand-new
 *                         account's auth user exists before its profile does).
 *   embed is an array   → the rows.
 *   embed present but NOT an array (null, an object) → unavailable: not a shape
 *                         a to-many embed can take, so nothing is known.
 *   embed key ABSENT    → UNAVAILABLE on a PostgREST-backed client (every client
 *                         getServiceClient builds — lib/supabase.ts records
 *                         them). PostgREST always returns the key of an embed a
 *                         select names, `[]` when there are no rows, so a row
 *                         without it is not this select's answer: the moderation
 *                         rows were not read, and "not read" is never "no ban".
 *                         (This used to be `rows: []` for every client — a
 *                         select that lost its embed, or anything between the
 *                         API and PostgREST that dropped the key, would have
 *                         lifted every ban in silence.) Only an injected test
 *                         double that models the status column alone, which
 *                         lib/supabase.ts never records, still reads as no rows.
 *                         An answer that is not a row object at all (an array,
 *                         a scalar) carries no such key either, and is
 *                         unavailable by the same rule.
 */
async function readGateInputs(
  client: SupabaseClient,
  userId: string,
): Promise<
  | { ok: true; accountStatus: string; rows: ReadonlyArray<{ state?: unknown; expires_at?: unknown }> }
  | { ok: false; reason: string }
> {
  try {
    const result: any = await client
      .from("profiles")
      .select(ACCOUNT_STATE_GATE_SELECT)
      .eq("id", userId)
      .maybeSingle();
    if (!result || typeof result !== "object") return { ok: false, reason: "profiles read returned no result" };
    if (result.error) {
      return { ok: false, reason: String(result.error.message ?? result.error.code ?? "db_error") };
    }
    const row = result.data as any;
    if (row == null) return { ok: true, accountStatus: "active", rows: [] };
    const status = row.account_status == null ? "active" : String(row.account_status);
    const embedded = row.user_account_states;
    if (embedded === undefined) {
      if (isPostgrestBackedClient(client)) return { ok: false, reason: "user_account_states embed missing from the profiles row" };
      return { ok: true, accountStatus: status, rows: [] };
    }
    if (!Array.isArray(embedded)) return { ok: false, reason: "user_account_states embed is not a row list" };
    return { ok: true, accountStatus: status, rows: embedded };
  } catch (err) {
    // Transport-level rejection only (socket, DNS).
    return { ok: false, reason: String((err as any)?.message ?? err) };
  }
}

/**
 * THE read path: `profiles.account_status` plus the in-force
 * `user_account_states` banned / suspended row, read together. There is no
 * table-absence exemption: the table is canonical schema (0063), and a gate
 * that cannot see it has had ban enforcement switched off — that is reported
 * as `unavailable`, never as "no restriction".
 */
export async function resolveAccountRestriction(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date(),
): Promise<AccountRestrictionRead> {
  const read = await readGateInputs(client, userId);
  if (!read.ok) return { state: "unavailable", reason: read.reason };
  return { state: "ok", accountStatus: read.accountStatus, restriction: pickRestriction(read.rows, now.getTime()) };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Machine-readable reason on a 403 for a restricted account. */
export type AccountRestrictionReason = "account_banned" | "account_suspended" | "account_restricted";

export function restrictionRefusal(r: AccountRestriction): { reason: AccountRestrictionReason; message: string } | null {
  // A ban's wording does not name an end: the writer never gives a ban one, and
  // requireUser's census-cited refusal line says exactly this.
  if (r.kind === "banned") return { reason: "account_banned", message: "Your account has been banned" };
  if (r.kind === "suspended") {
    return { reason: "account_suspended", message: r.until ? `Your account is suspended until ${r.until}` : "Your account is temporarily suspended" };
  }
  return null;
}

/**
 * What a 403 for a restricted account says about the restriction, beside the
 * human `message` and the machine `reason`: which kind, and when it ends (ISO
 * 8601, or null for one with no end). This is the SERVER CONTRACT a client
 * needs to tell a restricted account from a connection fault and to show the
 * end of a suspension without parsing prose (census-trust TV-4b). It decides
 * nothing about what the client then offers — that is D-SUSPENSION-UX.
 */
export interface RestrictionDetail { kind: ModerationRestrictionState; until: string | null }

export function restrictionDetail(r: AccountRestriction): RestrictionDetail | null {
  return r.kind === "none" ? null : { kind: r.kind, until: r.until };
}

/**
 * `res` for one refusal: the body sendError writes through it also carries the
 * restriction's machine `reason` and its `restriction` detail. requireUser
 * installs it right before its refusal lines, which stay as the census cites
 * them (lib/http.ts is cited by line AND by anchor text); sendError calls only
 * `status().json()`.
 */
export function withRefusalReason(res: Response, r: AccountRestriction): Response {
  const refusal = restrictionRefusal(r);
  if (!refusal) return res;
  const wrapper = {
    status(code: number) { res.status(code); return wrapper; },
    json(body: Record<string, unknown>) { return res.json({ ...body, reason: refusal.reason, restriction: restrictionDetail(r) }); },
  };
  return wrapper as unknown as Response;
}

/**
 * Whether a supabase-js Auth error is the auth service refusing a BANNED user's
 * token (GoTrue answers 403 `user_banned` for a user whose `banned_until` is in
 * the future — the session lock lib/accountModeration.ts sets beside the row).
 */
export function isAuthUserBannedError(error: any): boolean {
  if (!error) return false;
  if (error.code === "user_banned") return true;
  return /user is banned/i.test(String(error.message ?? ""));
}

const AUTH_BANNED_REFUSAL = { reason: "account_restricted" as const, message: "Your account is restricted" };

/**
 * A restricted account's request on an OPTIONAL-auth route. Read by the global
 * error handler (lib/errorEnvelope.ts) as 403 `forbidden` with `reason`. An
 * exception for the reason AccountStatusUnavailableError is one: optionalUser
 * returns `{ client, user } | null`, and null already means "anonymous" —
 * which is exactly the answer a restricted caller must NOT get.
 */
export class AccountRestrictedError extends Error {
  readonly status: number = 403;
  readonly code: ApiErrorCode = "forbidden";
  readonly reason: AccountRestrictionReason;
  /** Kind and end of the restriction (lib/errorEnvelope.ts writes it); absent for the auth service's own refusal, which names neither. */
  readonly restriction?: RestrictionDetail;
  constructor(reason: AccountRestrictionReason, message: string, restriction?: RestrictionDetail | null) {
    super(message);
    this.name = "AccountRestrictedError";
    this.reason = reason;
    if (restriction) this.restriction = restriction;
  }
}

/**
 * requireUser's answer to a failed `auth.getUser`: 403 for the auth service's
 * banned refusal, 401 otherwise. Kept here so requireUser's call site stays one
 * line (lib/http.ts is cited by line).
 */
export function sendTokenRefusal(res: Response, error: any): void {
  if (isAuthUserBannedError(error)) {
    sendError(res, "forbidden", AUTH_BANNED_REFUSAL.message, { reason: AUTH_BANNED_REFUSAL.reason });
    return;
  }
  sendError(res, "unauthenticated", error?.message ?? "Invalid or expired token");
}

/**
 * The account-state read behind an optional-auth request could not be made.
 * Read by the global error handler (`lib/errorEnvelope.ts`) as 503
 * `degraded_unavailable`, retryable — the response requireUser writes by hand
 * for the same failure. An exception rather than a wider return type for the
 * reason `TripAccessUnavailableError` (lib/http.ts) gives: `optionalUser`
 * returns `{ client, user } | null`, null already means "anonymous", and there
 * is no third slot for "unknown". Every caller is an async Express 5 handler,
 * which forwards the rejection with no route change.
 */
export class AccountStatusUnavailableError extends Error {
  /** Read by the global error handler. */
  readonly status: number = 503;
  /** Read by the global error handler. */
  readonly code: ApiErrorCode = "degraded_unavailable";
  constructor(detail: string) {
    super(`Could not verify account status. Please try again. (${detail})`);
    this.name = "AccountStatusUnavailableError";
  }
}

/**
 * `profiles.account_status` values that are ANONYMOUS on an optional-auth
 * route: `deleted` only, unchanged from PR #580. A tombstoned account whose auth
 * user outlived the erasure (AccountDeletionService's `auth.admin.deleteUser`
 * step is retryable, so the window is real) has no standing to an owner bypass,
 * and nothing about it is a moderation restriction to refuse. `deactivated` and
 * `pending_deletion` stay signed in, as requireUser keeps them, because both
 * are reversible by the account itself. Banned and suspended are NOT here: they
 * are refused (AccountRestrictedError), not anonymised.
 */
const OPTIONAL_AUTH_ANONYMOUS_STATUSES: ReadonlySet<string> = new Set(["deleted"]);

/**
 * optionalUser's gate, also for a route that extracts its own bearer token and
 * so cannot call optionalUser: `null` for no user / a deleted account, the user
 * otherwise; THROWS AccountRestrictedError (403) for a banned or suspended
 * account and AccountStatusUnavailableError (503) when the state cannot be read.
 *
 * `handRolledAuthAccountState.test.ts` pins that no file outside lib/http.ts
 * and this one calls `.auth.getUser(` again.
 *
 * `authThrowIsAnonymous` preserves what the hand-rolled sites that wrapped
 * `getUser` in a try/catch did when the Auth CALL ITSELF threw (network, DNS):
 * treat the caller as anonymous. It never covers the account-state read, nor
 * the auth service's own banned refusal — both are answered whatever the
 * option says.
 */
export async function optionalUserFromToken(
  client: SupabaseClient,
  token: string,
  opts: { log?: any; authThrowIsAnonymous?: boolean } = {},
): Promise<User | null> {
  let data: any;
  let error: any;
  try {
    ({ data, error } = await client.auth.getUser(token));
  } catch (err) {
    if (opts.authThrowIsAnonymous) return null;
    throw err;
  }
  // The auth service refusing the token AS BANNED is a confirmed restriction,
  // not an invalid token: anonymous would be the restriction not applying.
  if (isAuthUserBannedError(error)) throw new AccountRestrictedError(AUTH_BANNED_REFUSAL.reason, AUTH_BANNED_REFUSAL.message);
  if (error || !data?.user) return null;
  return admitVerifiedOptionalUser(client, data.user as User, opts.log);
}

/**
 * The optional-auth decision for a token the auth service has ALREADY verified:
 * the user, `null` for a deleted account, or a THROW — AccountRestrictedError
 * (403) for an in-force ban or suspension, AccountStatusUnavailableError (503)
 * when the state cannot be read. One body, so optionalUserFromToken and
 * getGatedUser cannot drift apart.
 */
async function admitVerifiedOptionalUser(client: SupabaseClient, user: User, log?: any): Promise<User | null> {
  const read = await resolveAccountRestriction(client, user.id);
  if (read.state === "unavailable") {
    log?.error?.(
      { userId: user.id, reason: read.reason },
      "account state unreadable on an optional-auth route — refusing rather than guessing",
    );
    throw new AccountStatusUnavailableError(read.reason);
  }
  const refusal = restrictionRefusal(read.restriction);
  if (refusal) throw new AccountRestrictedError(refusal.reason, refusal.message, restrictionDetail(read.restriction));
  if (OPTIONAL_AUTH_ANONYMOUS_STATUSES.has(read.accountStatus)) return null;
  return user;
}

/**
 * A DROP-IN for `client.auth.getUser(token)` at a route that resolves its own
 * optional viewer and reads more of the answer than the user (routes/discovery.ts
 * reads `error` to tell a rejected token from an unreachable auth service). It
 * answers `{ data: { user }, error }` exactly as `auth.getUser` does, with these
 * differences, all of them the gate:
 *
 *   an in-force ban or suspension   THROWS AccountRestrictedError (403)
 *   the auth service's banned refusal (GoTrue `user_banned`)   THROWS the same
 *   an unreadable account state     THROWS AccountStatusUnavailableError (503)
 *   a deleted account               `{ data: { user: null }, error: null }` —
 *                                   anonymous, as optionalUserFromToken answers
 *
 * An Auth call that itself throws (network, DNS) still throws what it threw, so
 * a site that treated that as "viewer unresolved" keeps doing so. The two gate
 * errors must NOT be swallowed by such a site's catch: pass every caught error
 * through `rethrowAccountGateRefusal` first.
 */
export async function getGatedUser(
  client: SupabaseClient,
  token: string,
  opts: { log?: any } = {},
): Promise<{ data: { user: User | null }; error: any }> {
  const { data, error } = await client.auth.getUser(token);
  if (isAuthUserBannedError(error)) throw new AccountRestrictedError(AUTH_BANNED_REFUSAL.reason, AUTH_BANNED_REFUSAL.message);
  if (error || !data?.user) return { data: { user: null }, error: error ?? null };
  const user = await admitVerifiedOptionalUser(client, data.user as User, opts.log);
  return { data: { user }, error: null };
}

/** Whether `err` is one of the gate's two refusals (403 restricted, 503 state unreadable). */
export function isAccountGateRefusal(err: unknown): err is AccountRestrictedError | AccountStatusUnavailableError {
  return err instanceof AccountRestrictedError || err instanceof AccountStatusUnavailableError;
}

/**
 * For the `catch` of a site that degrades a failed viewer lookup to "anonymous":
 * rethrow the gate's refusals so they reach the global error handler (403 / 503)
 * instead of being read as "no viewer" — which would serve a banned caller the
 * anonymous view, the exact bypass the gate exists to close. Anything else
 * returns, and the site's own degradation proceeds.
 */
export function rethrowAccountGateRefusal(err: unknown): void {
  if (isAccountGateRefusal(err)) throw err;
}

/**
 * requireUser for a REQUIRED-auth route that extracts its own token (the
 * Telegraph SSE stream's `?token=`): verify it, then apply requireUser's gate.
 * Returns the user, or null after writing 401 / 403 / 503.
 */
export async function requireUserFromToken(
  req: Request,
  res: Response,
  client: SupabaseClient,
  token: string,
): Promise<User | null> {
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    if (isAuthUserBannedError(error)) sendTokenRefusal(res, error);
    else sendError(res, "unauthenticated", "Invalid token");
    return null;
  }
  if (!(await enforceAccountState(req, res, client, data.user.id))) return null;
  return data.user as User;
}

/**
 * requireUser's account-state gate for requireUserFromToken and any hand-rolled
 * REQUIRED-auth site. requireUser (lib/http.ts) keeps the same steps inline —
 * its lines are cited by the census — over the same read and the same refusal
 * wording; handRolledAuthAccountState.test.ts holds the two identical. Returns true
 * when the request may be served; otherwise it has already written 503
 * `degraded_unavailable` (state unreadable) or 403 `forbidden` with reason
 * `account_banned` / `account_suspended`, and the caller must return.
 */
export async function enforceAccountState(
  req: Request,
  res: Response,
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const read = await resolveAccountRestriction(client, userId);
  if (read.state === "unavailable") {
    (req as any).log?.error?.(
      { userId, reason: read.reason },
      "account state unreadable — refusing to serve an unchecked request",
    );
    sendError(
      res,
      "degraded_unavailable",
      "Could not verify account status. Please try again.",
    );
    return false;
  }
  const refusal = restrictionRefusal(read.restriction);
  if (refusal) {
    sendError(withRefusalReason(res, read.restriction), "forbidden", refusal.message);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Long-lived connections
// ---------------------------------------------------------------------------

/** How often a long-lived stream re-reads its account's state. */
export const ACCOUNT_STATE_RECHECK_MS = 60_000;
let recheckMs = ACCOUNT_STATE_RECHECK_MS;
/** Test seam: the default re-check interval (null restores 60s). */
export function _setAccountStateRecheckMsForTest(ms: number | null): void {
  recheckMs = ms ?? ACCOUNT_STATE_RECHECK_MS;
}

/**
 * Re-check a long-lived connection's account (an SSE stream admitted once by
 * requireUser at connect time) every `intervalMs`, and call `onEnd` ONCE with
 * the 403-shaped refusal when the account becomes restricted, or the
 * 503-shaped one when the state can no longer be read (the client's reconnect
 * then meets the gate, which answers 503 retryable or serves it). Returns a stop
 * function; the timer is unref'd and stops itself after `onEnd`.
 */
export function watchAccountRestriction(
  client: SupabaseClient,
  userId: string,
  onEnd: (end: { status: 403 | 503; code: ApiErrorCode; reason?: AccountRestrictionReason; restriction?: RestrictionDetail | null; message: string }) => void,
  opts: { intervalMs?: number; log?: any } = {},
): () => void {
  let stopped = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    resolveAccountRestriction(client, userId)
      .then((read) => {
        if (stopped) return;
        if (read.state === "unavailable") {
          opts.log?.error?.({ userId, reason: read.reason }, "stream account-state re-check unreadable — closing the stream");
          stop();
          onEnd({ status: 503, code: "degraded_unavailable", message: "Could not verify account status. Please reconnect." });
          return;
        }
        const refusal = restrictionRefusal(read.restriction);
        if (refusal) {
          stop();
          onEnd({ status: 403, code: "forbidden", reason: refusal.reason, restriction: restrictionDetail(read.restriction), message: refusal.message });
        }
      })
      .finally(() => { inFlight = false; });
  }, opts.intervalMs ?? recheckMs);
  (timer as any).unref?.();
  function stop() {
    stopped = true;
    clearInterval(timer);
  }
  return stop;
}
