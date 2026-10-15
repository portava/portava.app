/**
 * Layover crew location grant — census-layover L166 ("Precise crew sharing:
 * separate explicit control, off by default") and L203 ("Crew membership/
 * location rows require membership and explicit permission"). B58 lane LAY-C1.
 *
 *   POST   /api/airport/sessions/:id/crew/location-grant   allow this crew to see my precise location
 *   DELETE /api/airport/sessions/:id/crew/location-grant   stop (every crew, every unrevoked grant)
 *
 * Both answer with the WHOLE crew payload (`crewPayload`, the same one GET /crew
 * serves), so the screen shows `yourShare` as a fresh read would, never an echo
 * of the row just written.
 *
 * A SEPARATE ROUTER, like `routes/layoverConstraints.ts`, because
 * `routes/airport.ts` is line-anchored by census citations: two handlers there
 * would move every one below them. Ported by content from open PR #569's two
 * handlers (lead ruling LR-B58-1), with these differences, each fail-closed:
 *   - behind `layover_crew_location_sharing_enabled` (seeded FALSE by 3787):
 *     OFF, no grant can be created (404 feature_disabled). Stopping is never
 *     gated — a revocation can only reduce what is shared;
 *   - the grant must come from the session the traveller is in the crew WITH;
 *   - refused while the traveller's sharing is paused/off or the trip is in
 *     ghost mode, or those settings cannot be read;
 *   - refused while airport re-entry cannot be verified (2992's checkpoints
 *     unreadable or not stored): re-entry ends a share, and a share whose end
 *     cannot be observed is not started;
 *   - a double tap is one grant; at most MAX_GRANTS_PER_MEMBER rows per member
 *     per crew.
 *
 * NOTHING HERE WRITES A `layover_events` ROW (#569's reason, kept): a
 * `crew_location_granted` event would re-record who shared their location, and
 * when, in a table keyed on the session and NOT cascaded by the crew — moving the
 * same personal fact somewhere it outlives the grant.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  getSession,
  LAYOVER_LIVE_SESSION_STATUSES,
  type LayoverSession,
} from "../services/airport/LayoverSessionService.js";
import { resolveSessionAirport } from "../services/airport/LayoverSnapshot.js";
import { evaluateSharingGate } from "../services/airport/LayoverPrivacyGuard.js";
import { activeCrewForUser, crewMembers } from "../services/layover/LayoverCrewStore.js";
import { readTravellerCheckpoints } from "../services/layover/LayoverCheckpointStore.js";
import {
  boundedGrantWindow,
  grantCrewLocation,
  revokeCrewLocation,
} from "../services/layover/LayoverCrewLocationGrantStore.js";
import { certifyCrewMemberRecord, crewPayload, crewViewerLandside } from "./airport.js";

const router = Router();

/**
 * When the traveller wants the share to end. OPTIONAL, and omitting it does
 * not mean "forever": it means the derived ceiling, `min(crew.expires_at, my
 * certified hard return)`. There is no way to ask for longer (OQ-2).
 */
export const crewLocationGrantSchema = z.object({ expiresAt: z.string().datetime().optional() }).strict();

/** Signed in, Layover on, the session exists and is the caller's — or the reply already sent. */
async function ownedSession(req: any, res: any): Promise<{ sc: any; userId: string; session: LayoverSession } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (!(await isFlagEnabled(sc, "airport_mode_enabled"))) { sendError(res, "feature_disabled"); return null; }
  const read = await getSession(sc, req.params.id, auth.user.id);
  if (!read.ok) { sendError(res, "degraded_unavailable", "Your layover could not be loaded. Please try again."); return null; }
  if (!read.session) { sendError(res, "not_found", "Session not found"); return null; }
  return { sc, userId: auth.user.id, session: read.session };
}

/** Re-read, re-certify, publish — GET /crew's own payload. */
async function respondWithCrew(
  res: any,
  sc: any,
  userId: string,
  session: LayoverSession,
  nowMs: number,
  savedNote: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const mine = await activeCrewForUser(sc, userId, new Date(nowMs).toISOString());
  if (!mine.ok) { sendError(res, "degraded_unavailable", `${savedNote} Your crew could not be loaded just now. Please refresh.`); return; }
  if (!mine.value) { res.json({ ok: true, inCrew: false, ...extra }); return; }
  const members = await crewMembers(sc, mine.value.crew.id);
  if (!members.ok) { sendError(res, "degraded_unavailable", `${savedNote} Your crew could not be loaded just now. Please refresh.`); return; }
  const payload = await crewPayload(sc, userId, mine.value.crew, members.value, nowMs, await crewViewerLandside(sc, userId, session, nowMs));
  if (!payload.ok) { sendError(res, "degraded_unavailable", `${savedNote} Your crew could not be certified just now. Please refresh.`); return; }
  res.json({ ok: true, inCrew: true, ...payload.body, ...extra });
}

router.post("/airport/sessions/:id/crew/location-grant", asyncHandler(async (req, res) => {
  const ctx = await ownedSession(req, res);
  if (!ctx) return;
  const { sc, userId, session } = ctx;

  // L166 "off by default", at the server: OFF (the seed) or absent, no grant.
  if (!(await isFlagEnabled(sc, "layover_crew_location_sharing_enabled"))) {
    sendError(res, "feature_disabled", "Sharing your location with a crew is not available.");
    return;
  }

  const parsed = crewLocationGrantSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid location share");
    return;
  }
  if (!(LAYOVER_LIVE_SESSION_STATUSES as readonly string[]).includes(session.status)) {
    sendError(res, "invalid_payload", "This layover has ended, so your location cannot be shared for it.");
    return;
  }

  const nowMs = Date.now();
  const mine = await activeCrewForUser(sc, userId, new Date(nowMs).toISOString());
  if (!mine.ok) { sendError(res, "degraded_unavailable", "Your crew could not be loaded, so nothing was shared. Please try again."); return; }
  if (!mine.value) { sendError(res, "not_found", "You are not in a crew."); return; }
  const { crew, membership } = mine.value;
  // L203: from the layover they are IN this crew with, and no other.
  if (membership.sessionId !== session.id) {
    sendError(res, "conflict", "You are in this crew from a different layover. Share from that one.");
    return;
  }

  // The traveller's own sharing switches: paused, off, or the trip's ghost mode.
  const gate = await evaluateSharingGate(sc, { userId, tripId: session.tripId });
  if (gate.degraded) { sendError(res, "degraded_unavailable", "Your sharing settings could not be checked, so nothing was shared. Please try again."); return; }
  if (!gate.allowed) { sendError(res, "sharing_disabled", "Your location sharing is paused or off, so nothing was shared."); return; }

  // Airport re-entry ends a crew share (§14.1). A share whose end cannot be
  // observed is not started: 2992's checkpoints must be stored and readable.
  const checkpoints = await readTravellerCheckpoints(sc, session.id, nowMs);
  if (!checkpoints.ok) {
    if (checkpoints.reason === "read_failed") {
      sendError(res, "degraded_unavailable", "We could not check your airport check-ins, so nothing was shared. Please try again.");
    } else {
      sendError(res, "conflict", "Sharing your location needs airport re-entry tracking, which is not available yet. Nothing was shared.", { reason: "reentry_unverifiable" });
    }
    return;
  }

  const airport = await resolveSessionAirport(sc, session);
  if (!airport.ok) { sendError(res, "degraded_unavailable", "Your airport's timings could not be loaded, so nothing was shared. Please try again."); return; }
  // THE CREW FEATURE'S ONE CERTIFICATION WRAPPER, reused, so this bound and the
  // crew's own deadline come from the same derivation.
  const record = certifyCrewMemberRecord(airport.airport, session, nowMs);

  const window = boundedGrantWindow({
    nowMs,
    requestedExpiresAtMs: parsed.data.expiresAt ? Date.parse(parsed.data.expiresAt) : null,
    crewExpiresAtIso: crew.expiresAt,
    granterHardReturnMs: record.deadline.hardReturnTime.getTime(),
  });
  if (!window.ok) {
    sendError(res, "conflict", "There is no time left on this crew or this layover to share your location for.");
    return;
  }

  const granted = await grantCrewLocation(sc, {
    crewId: crew.id,
    grantedByUserId: userId,
    sessionId: session.id,
    grantedAtMs: window.grantedAtMs,
    expiresAtMs: window.expiresAtMs,
  });
  if (!granted.ok) {
    if (granted.reason === "not_a_member") { sendError(res, "not_found", "You are not in that crew."); return; }
    if (granted.reason === "session_not_in_crew") { sendError(res, "conflict", "You are in this crew from a different layover. Share from that one."); return; }
    if (granted.reason === "too_many_grants") { sendError(res, "rate_limited", "You have started and stopped sharing with this crew too many times."); return; }
    if (granted.reason === "read_failed") { sendError(res, "degraded_unavailable", "Your crew could not be read, so nothing was shared. Please try again."); return; }
    sendError(res, "degraded_unavailable", "Your location share could not be saved. Nothing was shared.");
    return;
  }

  await respondWithCrew(res, sc, userId, session, nowMs, "Your share was saved.", { alreadyGranted: granted.value.alreadyGranted });
}));

router.delete("/airport/sessions/:id/crew/location-grant", asyncHandler(async (req, res) => {
  const ctx = await ownedSession(req, res);
  if (!ctx) return;
  const { sc, userId, session } = ctx;

  // NOT behind the sharing flag: stopping can only reduce what is shared, and a
  // grant made while the flag was on must be revocable after it is turned off.
  const nowMs = Date.now();
  const revoked = await revokeCrewLocation(sc, { userId }, new Date(nowMs).toISOString());
  if (!revoked.ok) {
    // A revocation that did not write has NOT happened.
    sendError(res, "degraded_unavailable", "Your location share could not be stopped. It may still be on. Please try again.");
    return;
  }
  await respondWithCrew(res, sc, userId, session, nowMs, "Sharing was stopped.", { revoked: revoked.value.revoked });
}));

export default router;
