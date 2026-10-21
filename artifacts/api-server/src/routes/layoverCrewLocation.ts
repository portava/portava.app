/**
 * §14 L4 "temporary location — explicit, scoped, auto-expiring" for a layover
 * crew (census-layover L132, L158, L166, L203, L124, L277).
 *
 *   GET    /api/airport/sessions/:id/crew/location
 *            the viewer's own share, the precise-sharing control, and the live
 *            shares of crewmates they may see (with a proximity bucket when
 *            both share a point)
 *   POST   /api/airport/sessions/:id/crew/location
 *            share where you are with your crew: { label, precision?, purpose?,
 *            expiresAt, lat?, lng? } — Telegraph's scoped share
 *   DELETE /api/airport/sessions/:id/crew/location
 *            stop sharing. NEVER gated by a flag: a switch must not be able to
 *            strand a share its owner wants ended (Locate My Friends' rule)
 *   PUT    /api/airport/sessions/:id/crew/location/precise-control
 *            { enabled } — the SEPARATE control exact sharing needs (L166).
 *            Turning it off ends an exact share at once.
 *
 * A SEPARATE ROUTER, like `routes/layoverSimulate.ts`, for the reason that file
 * gives: `routes/airport.ts` is line-anchored by census citations.
 *
 * ── WHO SEES WHAT (L203) ─────────────────────────────────────────────────────
 * Nothing here is read by a client directly: 3996's tables are service-role
 * only. A crewmate's share reaches a viewer only through
 * `projectCrewLocations` — this crew's share, from a LIVE member, live by every
 * §14.1 terminator (crew end, re-entry, boarding, session end, leaving), not
 * blocked either way, from a sharer whose sharing preferences still publish
 * them — and an unreadable input withholds rather than clears. The viewer must
 * themselves be a live member of the crew (`activeCrewForUser`).
 *
 * ── FLAGS ───────────────────────────────────────────────────────────────────
 * `airport_mode_enabled` (the layover surface) and `layover_crew_location_enabled`
 * (3996, seeded FALSE). With the second OFF, GET answers `available: false`
 * and the writes answer `feature_disabled`; DELETE still runs.
 */
import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { readBlockExclusions } from "../lib/exclusionSet.js";
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { loadProtectedZones } from "../lib/locateFriendsSession.js";
import {
  LAYOVER_LIVE_SESSION_STATUSES,
  emitLayoverEvent,
  getSession,
  type LayoverSession,
} from "../services/airport/LayoverSessionService.js";
import { publishableUserIds } from "../services/airport/LayoverPrivacyGuard.js";
import { activeCrewForUser, crewMembers, type CrewRow } from "../services/layover/LayoverCrewStore.js";
import { landsideSuppressionFor } from "../services/layover/LayoverCheckpointStore.js";
import {
  CREW_SHARE_MAX_MINUTES,
  crewLocationViewOf,
  crewShareSignalsFor,
  planCrewLocationShare,
  projectCrewLocations,
  type CrewGrantRow,
  type CrewLocationView,
} from "../services/layover/LayoverCrewLocation.js";
import {
  deleteCrewGrants,
  deleteOwnGrants,
  readCrewGrants,
  readPreciseControl,
  readSharerSessions,
  upsertCrewGrant,
  writePreciseControl,
} from "../services/layover/LayoverCrewLocationStore.js";

const router = Router();

const UNREADABLE = "Your crew's locations could not be loaded. Please try again.";

/** The control's body: one boolean, and nothing else. */
export const preciseControlSchema = z.object({ enabled: z.boolean() }).strict();

type Gate = { sc: SupabaseClient; userId: string; session: LayoverSession };

/** Auth, the layover surface, and the caller's OWN session. Null after replying. */
async function ownedSession(req: any, res: any, opts: { surfaceGated: boolean }): Promise<Gate | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient() as SupabaseClient | null;
  if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (opts.surfaceGated && !(await isFlagEnabled(sc, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return null; }
  const read = await getSession(sc, req.params.id, auth.user.id);
  if (!read.ok) { sendError(res, "degraded_unavailable", "Your layover could not be loaded. Please try again."); return null; }
  if (!read.session) { sendError(res, "not_found", "Session not found"); return null; }
  return { sc, userId: auth.user.id, session: read.session };
}

function sessionLive(session: LayoverSession): boolean {
  return (LAYOVER_LIVE_SESSION_STATUSES as readonly string[]).includes(session.status as string);
}

/** The latest a NEW share by this viewer could run to: the ceiling, the crew's end, their boarding. */
function shareEndsBy(session: LayoverSession, crew: CrewRow, nowMs: number): string {
  const bounds = [nowMs + CREW_SHARE_MAX_MINUTES * 60_000, Date.parse(crew.expiresAt), Date.parse(session.boardingTime ?? session.departureTime)]
    .filter((n) => Number.isFinite(n));
  return new Date(Math.min(...bounds)).toISOString();
}

/** A re-entry the sharer reported, as an instant; `nowMs` when it could not be checked (fail closed). */
async function reentryAtMs(sc: SupabaseClient, sessionId: string, nowMs: number): Promise<number | null> {
  const s = await landsideSuppressionFor(sc, sessionId, nowMs);
  if (s.state === "suppressed") {
    const at = Date.parse(s.reportedAt);
    return Number.isFinite(at) ? at : nowMs;
  }
  return s.state === "unknown" ? nowMs : null;
}

type ViewBody = {
  crewId: string;
  maxShareMinutes: number;
  shareEndsBy: string;
  preciseControl: { enabled: boolean } | null;
  mine: CrewLocationView | null;
  crewmates: Array<CrewLocationView & { handle: string | null; name: string | null }>;
  crewmatesWithheld: string | null;
};

/**
 * Everything one crew member may see of the crew's shares, and the purge of
 * what has ended. `ok: false` only for the reads without which there is no
 * honest answer at all (members, shares, the sharers' sessions).
 */
async function crewLocationBody(sc: SupabaseClient, viewerId: string, session: LayoverSession, crew: CrewRow, nowMs: number): Promise<{ ok: true; body: ViewBody } | { ok: false }> {
  const members = await crewMembers(sc, crew.id);
  if (!members.ok) return { ok: false };
  const grants = await readCrewGrants(sc, crew.id);
  if (!grants.ok) return { ok: false };
  const sessions = await readSharerSessions(sc, grants.value.map((g) => g.sessionId));
  if (!sessions.ok) return { ok: false };

  const liveMemberIds = new Set(members.value.map((m) => m.userId));
  const reentry = new Map<string, number | null>();
  for (const g of grants.value) {
    if (liveMemberIds.has(g.userId)) reentry.set(g.userId, await reentryAtMs(sc, g.sessionId, nowMs));
  }
  const others = grants.value.map((g) => g.userId).filter((id) => id !== viewerId);
  const blocks = await readBlockExclusions(sc, viewerId, { among: others });
  const publish = await publishableUserIds(sc, others);

  const projected = projectCrewLocations({
    viewerId,
    crewId: crew.id,
    grants: grants.value,
    liveMemberIds,
    blocked: blocks.ok ? blocks.ids : null,
    publishable: publish.kind === "read" ? new Set(publish.value.allowed) : null,
    signalsFor: (g: CrewGrantRow) => crewShareSignalsFor({
      grant: g,
      crew: { status: crew.status, expiresAt: crew.expiresAt },
      sharerSession: sessions.value.get(g.sessionId) ?? null,
      membershipLive: liveMemberIds.has(g.userId),
      reentryAtMs: reentry.get(g.userId) ?? null,
      nowMs,
    }),
    nowMs,
  });

  // Appendix C.8: a share past its scope is not kept. A failed purge is logged
  // by the store; the row is already invisible to every read.
  if (projected.ended.length > 0) await deleteCrewGrants(sc, crew.id, projected.ended.map((g) => g.userId));

  let crewmatesWithheld: string | null = projected.crewmatesWithheld;
  let crewmates: ViewBody["crewmates"] = [];
  if (projected.crewmates.length > 0) {
    const ids = projected.crewmates.map((c) => c.userId);
    const { data: profiles, error } = await sc.from("profiles").select("id, handle, name").in("id", ids);
    if (error) {
      crewmatesWithheld = "profiles_unreadable";
    } else {
      const names = await nameVisibilitySet(sc, ids);
      const byId = new Map(((profiles ?? []) as Array<{ id: string; handle: string | null; name: string | null }>).map((p) => [p.id, p]));
      crewmates = projected.crewmates.map((c) => ({
        ...c,
        handle: byId.get(c.userId)?.handle ?? null,
        name: names.has(c.userId) ? (byId.get(c.userId)?.name ?? null) : null,
      }));
    }
  }

  const control = await readPreciseControl(sc, crew.id, viewerId);
  return {
    ok: true,
    body: {
      crewId: crew.id,
      maxShareMinutes: CREW_SHARE_MAX_MINUTES,
      shareEndsBy: shareEndsBy(session, crew, nowMs),
      preciseControl: control.ok ? { enabled: control.value } : null,
      mine: projected.mine,
      crewmates,
      crewmatesWithheld,
    },
  };
}

router.get("/airport/sessions/:id/crew/location", asyncHandler(async (req, res) => {
  const gate = await ownedSession(req, res, { surfaceGated: true });
  if (!gate) return;
  const { sc, userId, session } = gate;
  if (!(await isFlagEnabled(sc, "layover_crew_location_enabled"))) { res.json({ ok: true, available: false }); return; }

  const nowMs = Date.now();
  const crew = await activeCrewForUser(sc, userId, new Date(nowMs).toISOString());
  if (!crew.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
  if (!crew.value) { res.json({ ok: true, available: true, inCrew: false, maxShareMinutes: CREW_SHARE_MAX_MINUTES }); return; }

  const view = await crewLocationBody(sc, userId, session, crew.value.crew, nowMs);
  if (!view.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
  res.json({ ok: true, available: true, inCrew: true, ...view.body });
}));

router.post("/airport/sessions/:id/crew/location", asyncHandler(async (req, res) => {
  const gate = await ownedSession(req, res, { surfaceGated: true });
  if (!gate) return;
  const { sc, userId, session } = gate;
  if (!(await isFlagEnabled(sc, "layover_crew_location_enabled"))) { sendError(res, "feature_disabled", "Crew location sharing is not switched on."); return; }
  if (!sessionLive(session)) {
    sendError(res, "conflict", "This layover has ended, so there is nothing to share.", { reason: "layover_ended" }); return;
  }

  const nowMs = Date.now();
  const crew = await activeCrewForUser(sc, userId, new Date(nowMs).toISOString());
  if (!crew.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
  if (!crew.value) { sendError(res, "conflict", "You are not in a crew, so there is nobody to share with.", { reason: "not_in_crew" }); return; }
  if (crew.value.membership.sessionId !== session.id) {
    sendError(res, "conflict", "You joined this crew from another layover. Share from that one.", { reason: "crew_joined_from_another_layover" }); return;
  }

  // A sharer who paused sharing (or switched location off) is not published
  // by any read, so a share they make now would be one nobody may see.
  const self = await publishableUserIds(sc, [userId]);
  if (self.kind === "degraded") { sendError(res, "degraded_unavailable", "Your sharing settings could not be checked. Please try again."); return; }
  if (!self.value.allowed.includes(userId)) {
    sendError(res, "conflict", "Your location sharing is paused in Settings, so nothing can be shared.", { reason: "sharing_paused" }); return;
  }

  const control = await readPreciseControl(sc, crew.value.crew.id, userId);
  if (!control.ok) { sendError(res, "degraded_unavailable", "Your sharing settings could not be checked. Please try again."); return; }

  const plan = planCrewLocationShare(req.body, {
    nowMs,
    crewExpiresAt: crew.value.crew.expiresAt,
    sharerBoardingAt: session.boardingTime,
    sharerDepartureAt: session.departureTime,
    preciseControlEnabled: control.value,
    zones: await loadProtectedZones(sc),
  });
  if (!plan.ok) {
    sendError(res, plan.status === 400 ? "invalid_payload" : "conflict", plan.message, { exposeDetail: true, reason: plan.reason });
    return;
  }

  const written = await upsertCrewGrant(sc, { crewId: crew.value.crew.id, userId, sessionId: session.id }, plan.grant);
  if (!written.ok) { sendError(res, "degraded_unavailable", "Your location was not shared. Please try again."); return; }

  // Precision and times only. A label or a coordinate in the audit log would
  // be a second, longer-lived copy of the thing this share is scoped to end.
  await emitLayoverEvent(sc, session.id, userId, "crew_location_shared", {
    crewId: crew.value.crew.id,
    precision: written.value.precision,
    endsAt: written.value.expiresAt,
  });
  res.json({ ok: true, mine: crewLocationViewOf(written.value), endsBecause: plan.endsBecause, downgraded: plan.downgraded });
}));

router.delete("/airport/sessions/:id/crew/location", asyncHandler(async (req, res) => {
  // No flag gate on purpose — see the header.
  const gate = await ownedSession(req, res, { surfaceGated: false });
  if (!gate) return;
  const { sc, userId, session } = gate;
  const stopped = await deleteOwnGrants(sc, userId, session.id);
  if (!stopped.ok) { sendError(res, "degraded_unavailable", "Your location could not be un-shared. Please try again."); return; }
  if (stopped.value > 0) await emitLayoverEvent(sc, session.id, userId, "crew_location_stopped", { count: stopped.value });
  res.json({ ok: true, stopped: stopped.value });
}));

router.put("/airport/sessions/:id/crew/location/precise-control", asyncHandler(async (req, res) => {
  const gate = await ownedSession(req, res, { surfaceGated: true });
  if (!gate) return;
  const { sc, userId } = gate;
  if (!(await isFlagEnabled(sc, "layover_crew_location_enabled"))) { sendError(res, "feature_disabled", "Crew location sharing is not switched on."); return; }
  const parsed = preciseControlSchema.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", "enabled (boolean) is required, and nothing else", { exposeDetail: true }); return; }

  const nowMs = Date.now();
  const crew = await activeCrewForUser(sc, userId, new Date(nowMs).toISOString());
  if (!crew.ok) { sendError(res, "degraded_unavailable", UNREADABLE); return; }
  if (!crew.value) { sendError(res, "conflict", "You are not in a crew.", { reason: "not_in_crew" }); return; }

  const written = await writePreciseControl(sc, crew.value.crew.id, userId, parsed.data.enabled, new Date(nowMs).toISOString());
  if (!written.ok) { sendError(res, "degraded_unavailable", "Your setting was not saved. Please try again."); return; }
  if (!parsed.data.enabled) {
    // Off means off now: an exact share does not run out its clock after the
    // traveller withdrew the permission it was made under. (3996's trigger does
    // the same at the database; this does not rely on it.)
    const ended = await deleteCrewGrants(sc, crew.value.crew.id, [userId], { precision: "exact" });
    if (!ended.ok) { sendError(res, "degraded_unavailable", "Exact sharing is off, but your exact share could not be ended. Please stop sharing."); return; }
  }
  res.json({ ok: true, preciseControl: { enabled: written.value } });
}));

export default router;
