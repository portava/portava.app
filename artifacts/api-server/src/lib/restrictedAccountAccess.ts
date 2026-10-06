/**
 * restrictedAccountAccess (census-trust TV-4b) — what a banned or suspended
 * account may still do, and what it is told.
 *
 * ── THE OWNER'S RULINGS (2026-10-04) ─────────────────────────────────────────
 *   OD-TRUST-4: "Show the user what is restricted, the reason at an appropriate
 *     level of detail, duration or review timing, and a clear appeal path. Keep
 *     reports and reporter details private."
 *   OD-TRUST-5: "… Limit each restriction to the actions and duration needed,
 *     and preserve access to appeals and permitted data exports."
 *
 * ── WHAT #580 LEFT ───────────────────────────────────────────────────────────
 * lib/http.ts `requireUser` refused a restricted account on EVERY route, the
 * appeal routes and the data export included, and its 403 said what kind of
 * restriction and until when, but not how to appeal.
 *
 * ── THE ALLOW-LIST (explicit; everything else stays refused) ─────────────────
 * A restricted account is admitted to exactly these, matched on method + the
 * full path (no prefixes, no patterns): its appeal, the state of its appeals,
 * its data export, its own deletion request, and a safety report. Each entry
 * says why. Anything not listed — including every route added later — is
 * refused, so the list fails closed by construction.
 *
 * ── WHAT IT CANNOT DO TODAY (stated, not hidden) ─────────────────────────────
 * lib/accountModeration.ts also sets the auth user's GoTrue `banned_until` on
 * every restriction, and GoTrue then rejects the still-valid access token: the
 * request never reaches the moderation-row check this list sits in (it is
 * refused at `auth.getUser`, lib/accountStateGate.ts sendTokenRefusal). So
 * once the session lock has applied, a restricted person reaches NONE of these
 * routes. The list governs only a token GoTrue still accepts (before the lock
 * lands, or where it failed — `sessionLock: "failed"`). Making the routes
 * reachable after the lock is an owner/design decision recorded in the lane-B
 * wave-2 report (TV-4b).
 *
 * ── NO APPEAL TARGET NAMES A RESTRICTION YET ─────────────────────────────────
 * POST /api/appeals accepts post, memory, highlight, account_warning, … — not
 * a ban or a suspension (routes/appeals.ts CreateAppealSchema, enum
 * `appeal_target_type`). The guidance says so (`restrictionIsAppealableTarget:
 * false`); adding the target is a migration plus a resolveAppeal case.
 *
 * ── THE REASON IS NOT SENT ───────────────────────────────────────────────────
 * The moderation row's `reason` is free text an admin writes and may name a
 * reporter (OD-TRUST-4: "Keep reports and reporter details private"). There is
 * no reviewed, user-facing reason field, so the response states the KIND, the
 * end and the scope, and says the reason is shared through the appeal, not
 * here. It never invents one.
 */
import type { Request } from "express";

export interface RestrictedAccountRoute {
  readonly method: "GET" | "POST" | "DELETE";
  /** The full path as mounted (`/api/...`), matched exactly. */
  readonly path: string;
  readonly why: string;
}

export const RESTRICTED_ACCOUNT_ROUTES: readonly RestrictedAccountRoute[] = Object.freeze([
  Object.freeze({ method: "POST", path: "/api/appeals", why: "OD-TRUST-5: preserve access to appeals" }),
  Object.freeze({ method: "GET", path: "/api/appeals/me", why: "OD-TRUST-4: the person can see where their appeal stands" }),
  Object.freeze({ method: "GET", path: "/api/compass/me/memory/export", why: "OD-TRUST-5: preserve access to permitted data exports" }),
  Object.freeze({ method: "POST", path: "/api/me/delete-request", why: "erasure is the person's own right; a restriction does not take it away" }),
  Object.freeze({ method: "DELETE", path: "/api/me/delete-request", why: "withdrawing one's own deletion request" }),
  Object.freeze({ method: "POST", path: "/api/reports", why: "a safety door: reporting abuse must stay open (OD-TRUST-9)" }),
] as const);

/** The request's path without query string or trailing slash. */
function pathOf(req: Pick<Request, "originalUrl" | "url">): string {
  const raw = String(req.originalUrl ?? req.url ?? "").split("?")[0] ?? "";
  return raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
}

/** Is this request one a restricted account may make? Exact method + path only. */
export function restrictedAccountMayUse(req: Pick<Request, "method" | "originalUrl" | "url">): boolean {
  const method = String(req.method ?? "").toUpperCase();
  const path = pathOf(req);
  return RESTRICTED_ACCOUNT_ROUTES.some((r) => r.method === method && r.path === path);
}

/**
 * The structured part of a restricted account's 403 (OD-TRUST-4): what is
 * restricted, why (as far as may be said), until when (`restriction.until`,
 * beside this), and how to appeal.
 */
export function restrictionGuidance(kind: "banned" | "suspended"): Record<string, unknown> {
  return {
    restricted: {
      scope: "account",
      summary:
        kind === "banned"
          ? "Your account is banned: you can't use Portava's features."
          : "Your account is suspended: you can't use Portava's features until the suspension ends.",
      stillAvailable: RESTRICTED_ACCOUNT_ROUTES.map((r) => ({ method: r.method, path: r.path })),
    },
    why: {
      shared: false,
      detail: "The moderation decision is explained through the appeal; reports and who made them stay private.",
    },
    appeal: {
      method: "POST",
      path: "/api/appeals",
      statusPath: "/api/appeals/me",
      // The appeal routes are open to this account, but no appeal TARGET names a
      // ban or suspension yet (routes/appeals.ts CreateAppealSchema; the
      // `appeal_target_type` enum). Said here rather than implied.
      restrictionIsAppealableTarget: false,
    },
  };
}
