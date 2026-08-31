/**
 * Locate My Friends — the §12 API.
 *
 *   POST   /api/locate-friends/sessions                  start or opt in
 *   POST   /api/locate-friends/sessions/:id/position     publish your position
 *   GET    /api/locate-friends/sessions/:id              read the group
 *   DELETE /api/locate-friends/sessions/:id/membership   leave, immediately
 *
 *   flag: locate_friends_enabled (OFF by default; fail-soft)
 *
 * The flag name is written as a STRING LITERAL at each call site rather than
 * through lib/locateFriendsSession.ts's `LOCATE_FRIENDS_FLAG` constant, because
 * scripts/check-flag-polarity.mjs resolves the argument statically: a constant
 * makes the flag unclassifiable, and an unclassifiable flag is one the check
 * cannot prove is being read through the right reader for its polarity. The
 * constant remains exported for documentation and for the migration to match.
 *
 * THE FOUR ENDPOINTS ARE THE WHOLE SURFACE, AND THAT IS DELIBERATE.
 * There is no "list my sessions", no "sessions near me", no unauthenticated
 * route and nothing that takes a viewport. §37's "do not build a public
 * real-time people tracker" is not enforced by a guard on those endpoints —
 * they do not exist, which is the only version of that rule that cannot be
 * weakened by a later change to a filter.
 *
 * WHY THERE IS NO "ADD MEMBERS" PARAMETER
 * =======================================
 * §12 says opt-in only, so a creator cannot enroll anyone. POST /sessions is
 * therefore idempotent PER GROUP SCOPE: the first caller creates the session
 * and becomes its only member; every later caller from the SAME group scope
 * joins the same session by making the same call themselves. Each membership is
 * consequently an act by the person it exposes, which is what opt-in has to
 * mean. Consent is stamped on the row (`consent_source`) rather than assumed.
 *
 * That makes the group-scope check load-bearing rather than cosmetic: it is the
 * only thing standing between "join the session you belong to" and "join any
 * session whose id you can guess". See `verifyScopeMembership` — an unverifiable
 * scope kind is REFUSED, not waved through.
 *
 * THE LEAVE PATH IS NOT FLAG-GATED
 * ================================
 * Every other handler answers an explicitly-disabled envelope when
 * `locate_friends_enabled` is off. DELETE .../membership does not consult the
 * flag at all. A capability switch that can strand an opted-in member inside a
 * session they cannot leave is worse than the feature being on, and revocation
 * is exactly the operation that must keep working when everything else is being
 * switched off.
 *
 * ALL POLICY LIVES IN lib/locateFriendsSession.ts. This file authenticates,
 * validates shape, rate-limits, and calls it. In particular it never touches a
 * coordinate: `positionRowFor` decides what is stored and `projectMember`
 * decides what is served, so there is no second place a raw lat/lng could leak
 * from.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import {
  GROUP_SCOPE_KINDS,
  LOCATE_SIGNAL_RUNGS,
  MAX_SESSION_MINUTES,
  MIN_SESSION_MINUTES,
  POSITION_TTL_MS,
  isLocationPrecision,
  isMembershipLive,
  isSessionActive,
  leaveSession,
  loadMembership,
  loadSession,
  positionRowFor,
  readSessionForViewer,
  storedPrecisionFor,
  validateSessionRequest,
  writeAudit,
  type GroupScopeKind,
  type SessionRow,
} from "../lib/locateFriendsSession.js";
import type { LocationPrecision } from "../presence/domain/types.js";

const router = Router();

// ── Request shapes ────────────────────────────────────────────────────────────

/**
 * `ttlMinutes` is REQUIRED here and has no default anywhere below it. A schema
 * default would be the single edit that turns "temporary and auto-expiring"
 * into "whatever we happened to pick", so the omission is the enforcement:
 * `validateSessionRequest` receives `undefined` and rejects.
 */
export const startSessionSchema = z.object({
  groupScopeKind: z.enum(GROUP_SCOPE_KINDS),
  groupScopeId: z.string().uuid(),
  ttlMinutes: z.number().int().min(MIN_SESSION_MINUTES).max(MAX_SESSION_MINUTES),
  ceiling: z.enum(["presence_only", "venue", "zone", "approximate", "nearby", "precise"]).optional(),
  label: z.string().max(80).optional(),
});

export const positionSchema = z.object({
  rung: z.enum(LOCATE_SIGNAL_RUNGS),
  /** What the DEVICE is willing to expose. Only ever narrowed from here. */
  precision: z.enum(["presence_only", "venue", "zone", "approximate", "nearby", "precise"]),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  proximityBucket: z.enum(["very_close", "nearby", "within_area", "weak"]).nullable().optional(),
  checkpointLabel: z.string().max(60).nullable().optional(),
  /** Epoch ms. Clamped below — a device clock never decides its own freshness. */
  observedAt: z.number().int().nonnegative(),
});

// ── Group scope ───────────────────────────────────────────────────────────────

type ScopeVerifier = (sc: any, scopeId: string, userId: string) => Promise<boolean>;

/**
 * "Is this caller actually in that group?", per scope kind.
 *
 * A kind with NO verifier here cannot be used — `verifyScopeMembership` returns
 * false rather than defaulting to permissive. The vocabulary in the schema is
 * wider than this table on purpose: adding a scope kind to the database is a
 * migration, and making it USABLE is an entry here plus whatever query proves
 * membership. Those are two separate decisions and only the second one can leak.
 *
 * Every verifier fails closed on a read error. `circle` and `plan` are absent
 * because neither has a membership table this module could prove against today;
 * they are refused rather than approximated.
 */
export const SCOPE_MEMBERSHIP_VERIFIERS: Partial<Record<GroupScopeKind, ScopeVerifier>> = {
  /** Accepted trip crew: the owner, or a trip_members row with an accepted role. */
  trip: async (sc, tripId, userId) => {
    const { data: trip, error: tripError } = await sc
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if (tripError) return false;
    if ((trip as any)?.owner_id === userId) return true;
    const { data, error } = await sc
      .from("trip_members")
      .select("role")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .in("role", ["owner", "co_host", "member"])
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  },
  /**
   * Event: RSVP'd going. Matches the rule lib/circleAccessGuard.ts already
   * applies for event presence — an "interested" RSVP is not attendance.
   */
  event: async (sc, eventId, userId) => {
    const { data, error } = await sc
      .from("event_rsvps")
      .select("status")
      .eq("event_id", eventId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    return (data as any).status === "going";
  },
};

export async function verifyScopeMembership(
  sc: any,
  kind: GroupScopeKind,
  scopeId: string,
  userId: string,
): Promise<boolean> {
  const verifier = SCOPE_MEMBERSHIP_VERIFIERS[kind];
  if (!verifier) return false;
  try {
    return await verifier(sc, scopeId, userId);
  } catch {
    return false;
  }
}

// ── Start or join ─────────────────────────────────────────────────────────────

export type StartOutcome =
  | { ok: true; session: SessionRow; joined: boolean; auditWritten: boolean }
  | { ok: false; code: "invalid_payload" | "forbidden" | "db_error"; detail: string };

/**
 * Create the group's session, or opt into the one it already has.
 *
 * Order matters and every step fails closed:
 *   1. the request must carry a group scope AND a usable TTL (no defaults),
 *   2. the caller must be provably in that group scope,
 *   3. an ACTIVE session for the scope is joined; expiry is evaluated here at
 *      `nowMs`, so an expired-but-unswept session is never joined — a fresh one
 *      is created instead,
 *   4. the membership row carries the consent stamp; there is no path that
 *      writes one without it.
 */
export async function startOrJoinSession(
  sc: any,
  userId: string,
  body: unknown,
  nowMs: number,
): Promise<StartOutcome> {
  const parsed = startSessionSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_payload",
      detail: parsed.error.issues[0]?.message ?? "Invalid payload",
    };
  }

  const validated = validateSessionRequest(parsed.data, nowMs);
  if (!validated.ok) {
    return { ok: false, code: "invalid_payload", detail: validated.reason };
  }
  const v = validated.value;

  if (!(await verifyScopeMembership(sc, v.groupScopeKind, v.groupScopeId, userId))) {
    return {
      ok: false,
      code: "forbidden",
      detail: "You are not a member of that group, or that group kind cannot be verified.",
    };
  }

  // (3) An existing session for this scope, if it is STILL ACTIVE at nowMs.
  const { data: existingRows, error: existingError } = await sc
    .from("locate_friends_sessions")
    .select("id, group_scope_kind, group_scope_id, created_by, started_at, expires_at, ended_at, ceiling, label")
    .eq("group_scope_kind", v.groupScopeKind)
    .eq("group_scope_id", v.groupScopeId)
    .is("ended_at", null);
  if (existingError) return { ok: false, code: "db_error", detail: "Could not read sessions." };

  const active = ((existingRows as SessionRow[]) ?? []).find((r) => isSessionActive(r, nowMs)) ?? null;

  if (active) {
    const { row: existingMembership, unreadable } = await loadMembership(sc, active.id, userId);
    if (unreadable) return { ok: false, code: "db_error", detail: "Could not read membership." };

    if (isMembershipLive(existingMembership, nowMs)) {
      return { ok: true, session: active, joined: false, auditWritten: true };
    }

    // Either a first join, or a re-join after leaving. Both are a fresh opt-in,
    // so both re-stamp the consent moment and clear left_at.
    const { error: joinError } = await sc.from("locate_friends_members").upsert(
      {
        session_id: active.id,
        user_id: userId,
        opted_in_at: new Date(nowMs).toISOString(),
        consent_source: "group_join",
        left_at: null,
      },
      { onConflict: "session_id,user_id" },
    );
    if (joinError) return { ok: false, code: "db_error", detail: "Could not join session." };

    // Attribution is the point of the audit row, but refusing a join whose
    // consent has already been recorded on the membership row would strand a
    // member who did opt in. So the failure is REPORTED to the caller (which
    // logs it), never swallowed and never fatal.
    const audit = await writeAudit(sc, {
      event: "member_joined",
      sessionId: active.id,
      actorId: userId,
      nowMs,
    });
    return { ok: true, session: active, joined: true, auditWritten: audit.ok };
  }

  const { data: created, error: createError } = await sc
    .from("locate_friends_sessions")
    .insert({
      group_scope_kind: v.groupScopeKind,
      group_scope_id: v.groupScopeId,
      created_by: userId,
      started_at: new Date(v.startedAtMs).toISOString(),
      // The expiry is written here, from a validated TTL. There is no branch in
      // which this insert happens without it.
      expires_at: new Date(v.expiresAtMs).toISOString(),
      ceiling: v.ceiling,
      label: v.label,
    })
    .select("id, group_scope_kind, group_scope_id, created_by, started_at, expires_at, ended_at, ceiling, label")
    .single();
  if (createError || !created) {
    return { ok: false, code: "db_error", detail: "Could not create session." };
  }

  const session = created as SessionRow;

  const { error: memberError } = await sc.from("locate_friends_members").insert({
    session_id: session.id,
    user_id: userId,
    opted_in_at: new Date(nowMs).toISOString(),
    consent_source: "creator",
    left_at: null,
  });
  if (memberError) {
    return { ok: false, code: "db_error", detail: "Could not record your opt-in." };
  }

  const audit = await writeAudit(sc, {
    event: "session_started",
    sessionId: session.id,
    actorId: userId,
    nowMs,
  });

  return { ok: true, session, joined: false, auditWritten: audit.ok };
}

// ── Publish a position ────────────────────────────────────────────────────────

export type PositionOutcome =
  | { ok: true; storedPrecision: LocationPrecision; rung: string; auditWritten: boolean }
  | { ok: false; code: "invalid_payload" | "forbidden" | "gone" | "db_error"; detail: string };

/**
 * How far ahead of the server a device clock may be before its timestamp is
 * distrusted. A future observation would otherwise buy an artificially long
 * decay window — the one direction clock skew can be exploited.
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

export async function publishPosition(
  sc: any,
  userId: string,
  sessionId: string,
  body: unknown,
  nowMs: number,
): Promise<PositionOutcome> {
  const parsed = positionSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_payload",
      detail: parsed.error.issues[0]?.message ?? "Invalid payload",
    };
  }

  const { row: session, unreadable } = await loadSession(sc, sessionId);
  if (unreadable) return { ok: false, code: "db_error", detail: "Could not read session." };
  // An expired session accepts nothing. Evaluated here, not by a sweep.
  if (!session || !isSessionActive(session, nowMs)) {
    return { ok: false, code: "gone", detail: "That session is not active." };
  }

  const { row: membership, unreadable: mUnreadable } = await loadMembership(sc, sessionId, userId);
  if (mUnreadable) return { ok: false, code: "db_error", detail: "Could not read membership." };
  if (!isMembershipLive(membership, nowMs)) {
    return { ok: false, code: "forbidden", detail: "You are not a member of that session." };
  }

  // The device's own clock never decides its freshness. A timestamp far ahead
  // of the server is REFUSED — the future is the one direction skew can be
  // exploited in, since it buys an artificially long decay window. A slightly
  // fast clock is pulled back to now. A timestamp older than the decay horizon
  // is refused rather than stored as something that could never be served.
  const claimed = parsed.data.observedAt;
  if (claimed - nowMs > MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: "invalid_payload", detail: "Observation timestamp is in the future." };
  }
  const observedAtMs = Math.min(claimed, nowMs);
  if (nowMs - observedAtMs >= POSITION_TTL_MS) {
    return { ok: false, code: "invalid_payload", detail: "Observation is older than the decay horizon." };
  }

  const sessionCeiling: LocationPrecision = isLocationPrecision(session.ceiling)
    ? session.ceiling
    : "none";

  const row = positionRowFor(
    sessionId,
    userId,
    {
      rung: parsed.data.rung,
      requestedPrecision: parsed.data.precision,
      lat: parsed.data.lat ?? null,
      lng: parsed.data.lng ?? null,
      proximityBucket: parsed.data.proximityBucket ?? null,
      checkpointLabel: parsed.data.checkpointLabel ?? null,
      observedAtMs,
    },
    sessionCeiling,
    new Date(session.expires_at).getTime(),
  );

  const storedPrecision = storedPrecisionFor(
    { rung: parsed.data.rung, requestedPrecision: parsed.data.precision },
    sessionCeiling,
  );

  const { error: writeError } = await sc
    .from("locate_friends_positions")
    .upsert({ ...row, written_at: new Date(nowMs).toISOString() }, { onConflict: "session_id,user_id" });
  if (writeError) return { ok: false, code: "db_error", detail: "Could not store position." };

  const audit = await writeAudit(sc, {
    event: "position_written",
    sessionId,
    actorId: userId,
    rung: parsed.data.rung,
    precision: storedPrecision,
    nowMs,
  });

  return { ok: true, storedPrecision, rung: parsed.data.rung, auditWritten: audit.ok };
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post(
  "/locate-friends/sessions",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }

    const nowMs = Date.now();

    if (!(await isFlagEnabled(sc, "locate_friends_enabled"))) {
      res.json({ enabled: false, session: null, joined: false });
      return;
    }

    const rl = checkRateLimit("locate_friends_session", user.id, 10, 60 * 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many session requests. Please wait.");
      return;
    }

    const outcome = await startOrJoinSession(sc, user.id, req.body, nowMs);
    if (!outcome.ok) {
      sendError(res, outcome.code, outcome.detail);
      return;
    }
    if (!outcome.auditWritten) {
      req.log?.warn({ sessionId: outcome.session.id }, "locate-friends: membership audit write failed");
    }

    res.json({
      enabled: true,
      joined: outcome.joined,
      session: {
        id: outcome.session.id,
        groupScopeKind: outcome.session.group_scope_kind,
        groupScopeId: outcome.session.group_scope_id,
        expiresAt: outcome.session.expires_at,
        secondsRemaining: Math.max(
          0,
          Math.floor((new Date(outcome.session.expires_at).getTime() - nowMs) / 1000),
        ),
        ceiling: outcome.session.ceiling,
        label: outcome.session.label ?? null,
      },
    });
  }),
);

router.post(
  "/locate-friends/sessions/:id/position",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }

    const nowMs = Date.now();

    if (!(await isFlagEnabled(sc, "locate_friends_enabled"))) {
      res.json({ enabled: false, stored: false });
      return;
    }

    // A live session polls this. Bounded well above a sane cadence (one write
    // every ~10s) and far below anything that could be used to build a track.
    const rl = checkRateLimit("locate_friends_position", user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many position updates. Please wait.");
      return;
    }

    const outcome = await publishPosition(sc, user.id, String(req.params.id), req.body, nowMs);
    if (!outcome.ok) {
      sendError(res, outcome.code, outcome.detail);
      return;
    }
    if (!outcome.auditWritten) {
      req.log?.warn({ sessionId: req.params.id }, "locate-friends: position audit write failed");
    }

    res.json({
      enabled: true,
      stored: true,
      storedPrecision: outcome.storedPrecision,
      rung: outcome.rung,
    });
  }),
);

router.get(
  "/locate-friends/sessions/:id",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }

    const nowMs = Date.now();

    if (!(await isFlagEnabled(sc, "locate_friends_enabled"))) {
      res.json({ enabled: false, status: "unavailable", session: null, members: [] });
      return;
    }

    const rl = checkRateLimit("locate_friends_read", user.id, 120, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const result = await readSessionForViewer(sc, String(req.params.id), user.id, nowMs);

    // ONE opaque answer for not-found, not-a-member, expired and unreadable.
    // Distinguishing them would turn this endpoint into an existence oracle: a
    // stranger could enumerate ids and learn which groups are out right now,
    // which is the §37 tracker rebuilt out of status codes.
    if (result.status !== "ok") {
      res.json({ enabled: true, status: "unavailable", session: null, members: [] });
      return;
    }

    res.json({
      enabled: true,
      status: "ok",
      session: result.session,
      members: result.members,
      generatedAt: new Date(nowMs).toISOString(),
    });
  }),
);

router.delete(
  "/locate-friends/sessions/:id/membership",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured");
      return;
    }

    const nowMs = Date.now();

    // NOT flag-gated. See the file header: revocation must not depend on a
    // capability switch.
    const sessionId = String(req.params.id);
    const result = await leaveSession(sc, sessionId, user.id, nowMs);

    if (result.positionDeleteError) {
      req.log?.warn(
        { err: result.positionDeleteError, sessionId },
        "locate-friends: position delete failed on leave; membership still closed",
      );
    }

    if (result.outcome === "error") {
      sendError(res, "db_error", "Could not leave the session.");
      return;
    }

    if (result.outcome === "left") {
      const audit = await writeAudit(sc, {
        event: "member_left",
        sessionId,
        actorId: user.id,
        nowMs,
      });
      if (!audit.ok) {
        req.log?.warn({ err: audit.error, sessionId }, "locate-friends: leave audit write failed");
      }
    }

    // `left: true` for a member who was never in the session too — the caller is
    // not exposed either way, and saying "you were not a member" would confirm
    // the session exists.
    res.json({ ok: true, left: true });
  }),
);

export default router;
