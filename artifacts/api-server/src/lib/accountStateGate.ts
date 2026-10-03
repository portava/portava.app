/**
 * accountStateGate — the account-state (ban) gate for every bearer token, not
 * only the ones that reach `requireUser`.
 *
 * `requireUser` (lib/http.ts) reads `profiles.account_status` after verifying
 * the token and refuses banned / suspended accounts. Nothing in this system
 * revokes sessions, so that read is the ONLY place a ban is enforced — and
 * three kinds of path skipped it:
 *
 *   1. `optionalUser` (lib/http.ts), behind seven optional-auth routes, which
 *      returned the token's user without reading the account state at all.
 *   2. Route sites that verified the token with a bare `sc.auth.getUser(token)`
 *      because they extract the token themselves (a case-insensitive scheme, a
 *      raw header): passport, profileTabs, follows, og, stamps, passportStamps.
 *   3. The Telegraph SSE stream, REQUIRED auth but hand-rolled because an
 *      EventSource can only send `?token=`.
 *
 * This module is their gate. It lives beside lib/http.ts rather than in it
 * because the census documents cite lib/http.ts by line, and those citations
 * must keep pointing at the code they name.
 *
 * ── WHAT EACH ACCOUNT STATE ANSWERS ─────────────────────────────────────────
 * OPTIONAL auth (optionalUser, optionalUserFromToken):
 *   banned / suspended / deleted → null: ANONYMOUS. Every optional route
 *     already serves an anonymous caller, so this is always a truthful answer;
 *     the account gets exactly what dropping its token would get it.
 *   unavailable → THROWS AccountStatusUnavailableError (503, retryable). Never
 *     signed in — that is an unread ban treated as "not banned". And NOT
 *     anonymous either: an ordinary user whose state merely could not be read
 *     would silently lose their block filter (rent-a-buddy list, trip detail,
 *     place reviews) and be told they have no vote — a failed read presented
 *     as an answer. A request with NO token never reaches this read, so
 *     anonymous traffic keeps serving through a profiles outage.
 *   active / deactivated / pending_deletion / no row → signed in, as requireUser.
 * REQUIRED auth (requireUserFromToken, enforceAccountState): exactly
 *   requireUser's answers — 403 banned / suspended, 503 unreadable, served
 *   otherwise. `handRolledAuthAccountState.test.ts` pins the parity state by state.
 */
import type { Request, Response } from "express";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { readAccountStatus, sendError, type ApiErrorCode } from "./http.js";

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
 * Account states that are NOT signed in on an optional-auth route. `banned` and
 * `suspended` are the two requireUser refuses with 403. `deleted` is added here
 * only: a tombstoned account whose auth user outlived the erasure (the
 * `auth.admin.deleteUser` step in AccountDeletionService is retryable, so the
 * window is real) has no standing to an owner bypass, and on an optional route
 * anonymous is always a legal answer. `deactivated` and `pending_deletion` stay
 * signed in, as requireUser keeps them, because both are reversible by the
 * account itself.
 */
const OPTIONAL_AUTH_ANONYMOUS_STATUSES: ReadonlySet<string> = new Set(["banned", "suspended", "deleted"]);

/**
 * optionalUser's gate, also for a route that extracts its own bearer token and
 * so cannot call optionalUser: `null` for no user / banned / suspended /
 * deleted, the user otherwise, and a THROWN AccountStatusUnavailableError when
 * the state cannot be read.
 *
 * `handRolledAuthAccountState.test.ts` pins that no file outside lib/http.ts
 * and this one calls `.auth.getUser(` again.
 *
 * `authThrowIsAnonymous` preserves what the hand-rolled sites that wrapped
 * `getUser` in a try/catch did when the Auth CALL ITSELF threw (network, DNS):
 * treat the caller as anonymous. It never covers the account-state read — an
 * unreadable ban is thrown whatever the option says.
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
  if (error || !data?.user) return null;

  const statusRead = await readAccountStatus(client, data.user.id);
  if (statusRead.state === "unavailable") {
    opts.log?.error?.(
      { userId: data.user.id, reason: statusRead.reason },
      "account_status unreadable on an optional-auth route — refusing rather than guessing",
    );
    throw new AccountStatusUnavailableError(statusRead.reason);
  }
  if (statusRead.state === "ok" && OPTIONAL_AUTH_ANONYMOUS_STATUSES.has(statusRead.status)) return null;
  return data.user as User;
}

/**
 * requireUser for a REQUIRED-auth route that extracts its own token (the
 * Telegraph SSE stream's `?token=`): verify it, then apply requireUser's ban
 * gate. Returns the user, or null after writing 401 / 403 / 503.
 */
export async function requireUserFromToken(
  req: Request,
  res: Response,
  client: SupabaseClient,
  token: string,
): Promise<User | null> {
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    sendError(res, "unauthenticated", "Invalid token");
    return null;
  }
  if (!(await enforceAccountState(req, res, client, data.user.id))) return null;
  return data.user as User;
}

/**
 * requireUser's ban gate (see its block comment in lib/http.ts), with
 * requireUser's exact answers. Returns true when the request may be served;
 * otherwise it has already written 503 degraded_unavailable (state unreadable)
 * or 403 forbidden (banned / suspended) and the caller must return.
 *
 * requireUser keeps its own inline copy, unedited, because lib/http.ts is
 * cited by line; a parity test holds the two to the same answer
 * for every state (`handRolledAuthAccountState.test.ts`), so they cannot drift apart unnoticed.
 */
export async function enforceAccountState(
  req: Request,
  res: Response,
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const statusRead = await readAccountStatus(client, userId);
  if (statusRead.state === "unavailable") {
    (req as any).log?.error?.(
      { userId, reason: statusRead.reason },
      "account_status unreadable — refusing to serve an unchecked request",
    );
    sendError(
      res,
      "degraded_unavailable",
      "Could not verify account status. Please try again.",
    );
    return false;
  }

  // `absent` is a successful read that found no ban state, so the account is
  // active — folding it into the refusal would lock out every brand-new
  // account, whose auth user exists before its profile row does.
  const accountStatus: string = statusRead.state === "ok" ? statusRead.status : "active";
  if (accountStatus === "banned") {
    sendError(res, "forbidden", "Your account has been banned");
    return false;
  }
  if (accountStatus === "suspended") {
    sendError(res, "forbidden", "Your account is temporarily suspended");
    return false;
  }
  return true;
}
