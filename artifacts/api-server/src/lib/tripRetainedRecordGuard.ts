/**
 * ONE guard for every member-level write under /trips/:tripId — verifier R3 on
 * 1867c97df, census-trips §85.2.
 *
 * The owner's ruling on appeal restoration (2026-10-04): "if a trip has ended,
 * restore access to its retained record only." 3974 stamps such a membership
 * `trip_members.permissions.access = 'retained_record_only'`. Wave 4 refused it
 * on the plan, proposal and /commands doors; the verifier then wrote a note, a
 * document, a checklist, a reminder and a saved place as that member, each 201,
 * because those doors check membership only. Gating door by door is how one is
 * always missed, so this runs BEFORE every trip router (mounted on the first
 * router routes/index.ts registers, routes/trips.ts) and refuses every write
 * method under /trips/:tripId for such a member with 403
 * `trip_record_read_only` — never worded as a restriction.
 *
 * NOT refused (deliberately): reads (GET/HEAD/OPTIONS) and the POSTs that only
 * compute (simulate, previews, checks, refresh); safety (rescue, regroup,
 * meeting-checkpoint arrival and close, stopping a live share, ghost mode on);
 * acts that only reduce what the member holds (leaving the trip, revoking an
 * anchor share they made); invite answers and join requests (not a member's
 * write); and /commands, which applies the same rule per command type with its
 * own safety list (server/trips/commandRoute.ts).
 *
 * WHO. The bearer token is resolved through the account gate
 * (optionalUserFromToken — never a hand-rolled `auth.getUser`, which
 * handRolledAuthAccountState.test.ts forbids). A request this guard cannot
 * attribute (no token, a token the auth service rejects, an Auth transport
 * failure) passes through untouched: the handler's own requireUser answers it.
 * A banned or suspended account, or an unreadable account state, is the gate's
 * own 403 / 503, handed to the global error handler exactly as requireUser's
 * is. The guard only ever REFUSES, so it cannot widen anything.
 *
 * FAIL CLOSED. The membership row that says "retained record only" could not
 * be read → 503, retryable, nothing written. A trip write must not proceed on an
 * access level nobody read.
 */
import type { NextFunction, Request, Response } from "express";

import { getServiceClient } from "./supabase.js"; import { optionalUserFromToken, isAccountGateRefusal } from "./accountStateGate.js";
import { sendError } from "./http.js";
import { RETAINED_RECORD_ONLY_MESSAGE } from "./tripTrustGate.js";

const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TRIP_PATH = /^\/trips\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i;

/** The rest of the path after /trips/:tripId, matched exactly. */
const EXEMPT: ReadonlyArray<{ methods?: ReadonlySet<string>; path: RegExp }> = [
  { path: /^\/commands$/ }, // per-command rule in commandRoute.ts
  // safety
  { path: /^\/rescue$/ }, { path: /^\/regroup$/ },
  { path: /^\/meeting-checkpoints\/[^/]+\/(arrival|close)$/ },
  { path: /^\/crew\/live-share\/stop$/ }, { path: /^\/crew\/ghost-mode\/enable$/ },
  // compute-only POSTs (they write nothing)
  { path: /^\/location-check$/ }, { path: /^\/replay\/verify$/ }, { path: /^\/daily-brief\/refresh$/ },
  { path: /^\/simulate$/ }, { path: /^\/proposals\/preview$/ }, { path: /^\/neighborhood-match$/ }, { path: /^\/budget\/sandbox$/ },
  // not a member's write
  { path: /^\/accept-invite$/ }, { path: /^\/decline-invite$/ }, { path: /^\/join-request$/ },
  // reducing what the member holds
  { methods: new Set(["DELETE"]), path: /^\/anchors\/[^/]+\/shares\/[^/]+$/ },
];

function exempt(method: string, rest: string, userId: string): boolean {
  if (method === "DELETE" && rest === `/members/${userId}`) return true; // leaving the trip
  return EXEMPT.some((e) => (!e.methods || e.methods.has(method)) && e.path.test(rest));
}

export type RetainedAccess = "retained_record_only" | "other" | "unread";

/** Pure: the access a trip_members row grants, as this guard reads it. */
export function retainedAccessOf(row: { permissions?: unknown } | null): RetainedAccess {
  const p = row?.permissions;
  if (p && typeof p === "object" && (p as Record<string, unknown>).access === "retained_record_only") return "retained_record_only";
  return "other";
}

export function tripRetainedRecordWriteGuard() {
  return async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!WRITE_METHODS.has(req.method)) return next();
      const m = TRIP_PATH.exec(req.path);
      if (!m) return next();
      const tripId = m[1]!;
      const rest = m[2] ?? "";
      const auth = req.headers.authorization;
      const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token) return next();
      const sc = getServiceClient();
      if (!sc) return next();
      const userId = (await optionalUserFromToken(sc, token, { log: (req as { log?: unknown }).log, authThrowIsAnonymous: true }))?.id ?? null;
      if (!userId) return next();
      if (exempt(req.method, rest, userId)) return next();
      const { data: row, error } = await sc.from("trip_members").select("permissions").eq("trip_id", tripId).eq("user_id", userId).maybeSingle();
      if (error) {
        sendError(res, "degraded_unavailable", "We could not check your access to this trip right now, so nothing was changed. Please try again shortly.");
        return;
      }
      if (retainedAccessOf(row as { permissions?: unknown } | null) === "retained_record_only") {
        res.status(403).json({ error: "trip_record_read_only", message: RETAINED_RECORD_ONLY_MESSAGE });
        return;
      }
      return next();
    } catch (e) {
      // The account gate's own refusal (a ban or suspension → 403, an unreadable
      // account state → 503) reaches the global error handler, as requireUser's does.
      if (isAccountGateRefusal(e)) return next(e);
      // Anything else: this guard could not decide, so nothing is written — try again.
      sendError(res, "degraded_unavailable", "We could not check your access to this trip right now, so nothing was changed. Please try again shortly.");
    }
  };
}
