/**
 * /api/map/journey/* — Map spec §36 Phase 6, the two surfaces that are not a
 * gateway parameter.
 *
 *   flag: map_journey_intelligence_enabled (OFF by default; migration 2296)
 *
 * The third Phase-6 capability, Along My Way, is NOT here: it is a `corridor=`
 * parameter on GET /api/map/projection, because it is a filter over objects
 * that route already decided the viewer may see. These two are different in
 * kind — one is a trip-scoped write, the other reasons over the trip's own
 * plan — so they are their own endpoints rather than a viewport query.
 *
 *   GET  /api/map/journey/shortlist?tripId=…            the group decision
 *   POST /api/map/journey/shortlist/:planItemId/vote     accept / decline
 *   GET  /api/map/journey/recovery?tripId=…              Plan B for a stop
 *
 * WHAT THIS FILE IS AUTHORITATIVE FOR, AND WHAT IT MUST NOT RE-DECIDE
 * ==================================================================
 * It owns exactly one decision: IS THE CALLER AN ACCEPTED MEMBER OF THIS TRIP
 * (`isAcceptedTripMember`, the same helper routes/trips.ts and routes/plan.ts
 * use). Everything else is delegated:
 *
 *   the shortlist projection   lib/journeyGroupDecision (pure)
 *   the crew's coarse areas    services/tripCrew getCrewMap — which already
 *                              applies ghost mode, per-member visibility, the
 *                              bidirectional block filter and the fail-closed
 *                              "no blocks read ⇒ no members" rule
 *   the recovery reasoning     lib/journeyRecovery → compass/CompassLiveConstraints
 *   the live claims            lib/liveClaimRead's gated envelope seam
 *   PROMOTING A CANDIDATE      PATCH /api/trips/:tripId/plan/items/:itemId
 *                              — NOT this file. See below.
 *
 * THE CONFIRM IS THE EXISTING PLAN WRITE PATH
 * ===========================================
 * A shortlist candidate is a `trip_plan_items` row at status 'tentative'.
 * Turning it into 'confirmed' is a plan edit, and the plan already has a write
 * path with a permission model (`canEditPlan` + `canEditPlanItem`) that
 * distinguishes owners, co-hosts and members. This route records VOTES and
 * reports when the crew has agreed (`tally.readyToConfirm`); the client then
 * makes the existing PATCH. A status write here would be a second, divergent
 * answer to "who may change this trip's plan", which is exactly the class of
 * defect the gateway-bypass guard exists to prevent one layer over.
 *
 * THE ELECTORATE AND `canEditPlan` ARE DIFFERENT SETS, AND THAT IS THE RULE
 * ========================================================================
 * Any accepted member — role 'viewer' included — may cast a decline, on a trip
 * whose `plan_edit_permission` may well be 'owner_only'. That asymmetry is
 * deliberate, not an oversight, because the two sets answer different
 * questions:
 *
 *   WHO IS AFFECTED BY THE DECISION  → the trip's members. Somebody who is
 *     going to be standing in that queue may say so, whatever their editing
 *     rights. An electorate narrowed to `canEditPlan` would poll only the
 *     people who were already going to decide, which is not a group decision.
 *   WHO MAY CHANGE THE PLAN          → `canEditPlan` + `canEditPlanItem`,
 *     unchanged by Phase 6.
 *
 * So a decline is ADVISORY, and its entire effect is on the TALLY: it clears
 * `readyToConfirm` and sets `blockedBy: 'declined'`. It cannot stop an editor
 * from confirming (the PATCH never consults the tally) and a ready tally cannot
 * let a non-editor confirm. src/test/mapJourney.test.ts pins both halves,
 * including that the only row this route ever writes is a vote.
 *
 * §23 — NO CREW COORDINATE CAN REACH THIS RESPONSE
 * ================================================
 * `getCrewMap` returns `CrewMemberCard`s that MAY carry `exactCoords` when a
 * member has granted the viewer a live share. That grant is for the crew map.
 * Every card here goes through `toCrewAreas`, whose output type has no
 * coordinate field at all, so the decision sheet is coarse area labels or
 * nothing. src/test/mapJourney.test.ts feeds a card WITH exactCoords through
 * this projection and asserts the serialized response contains no coordinate.
 *
 * FAIL-SOFT ON THE FLAG, FAIL-CLOSED ON MEMBERSHIP. A disabled flag answers
 * `enabled:false` with empty content (the client shows nothing); a caller who
 * is not an accepted member gets an error, never an empty success.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  ACCEPTED_TRIP_MEMBER_ROLES,
  isAcceptedTripMember,
  isAcceptedTripMemberRow,
  requireTripMember,
  requireUser,
  sendError,
} from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { getCrewMap } from "../services/tripCrew/TripCrewLocationService.js";
import { readLiveClaimEnvelopes, type LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import {
  SHORTLIST_STATUS,
  buildShortlist,
  isVote,
  tallyItem,
  type ShortlistItemRow,
  type VoteRow,
} from "../lib/journeyGroupDecision.js";
import {
  computeRecovery,
  type PlannedStop,
  type RecoveryCandidate,
} from "../lib/journeyRecovery.js";
import { JOURNEY_INTELLIGENCE_FLAG } from "../lib/mapCorridor.js";
import { deriveViewerLiveTolerances, resolveLiveSubjects } from "../compass/CompassLiveConstraints.js";
import type { CompassItem, CompassProfile } from "../compass/types.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * The Phase-6 flag, read once per request. Fail-closed via isFlagEnabled.
 *
 * PINNED against lib/mapCorridor's JOURNEY_INTELLIGENCE_FLAG, which
 * routes/mapProjection.ts pins its own corridor literal against too. One
 * constant, two annotated spellings: renaming the flag is a type error in both
 * files rather than a silent divergence in one of them.
 */
const JOURNEY_FLAG: typeof JOURNEY_INTELLIGENCE_FLAG = "map_journey_intelligence_enabled";

/** Bounded reads: a trip's plan and its votes are small, and must stay small. */
const MAX_PLAN_ROWS = 200;
const MAX_MEMBER_ROWS = 500;
const MAX_VOTE_ROWS = 2_000;
const MAX_CANDIDATE_ROWS = 100;
/** Stops we will read live claims for. Mirrors the Compass live-stage cap. */
const MAX_RECOVERY_SUBJECTS = 20;

const PLAN_COLUMNS =
  "id, trip_id, title, category, status, starts_at, ends_at, location_name, sort_order, created_at, source_type, source_id";

/**
 * The trip's accepted members — the eligible voters.
 *
 * THE ELECTORATE IS EXACTLY WHO THE VOTE GATE LETS IN. Both this list and the
 * gate above (`isAcceptedTripMember` → `requireTripMember`) are decided by the
 * SHARED `isAcceptedTripMemberRow` predicate over the same role set, so the two
 * cannot drift. When they did drift, both directions were wrong:
 *
 *   - a role the gate accepts but the list omits (a 'viewer') could cast a vote
 *     that was written to the table and then dropped by `tallyItem` as
 *     ineligible — the member is told nothing, and their own vote reads back as
 *     `myVote: null`;
 *   - a row with an accepted role but a non-'accepted' status ('invited',
 *     'declined', 'removed', 'left') would swell the electorate with somebody
 *     who cannot pass the gate to vote, so `pending` never reaches zero and
 *     `readyToConfirm` stays false forever.
 *
 * 'invited' is EXCLUDED by that predicate. A pending invitee may look at the
 * crew (the documented exception on GET /trips/:tripId/crew/map, so they can
 * decide whether to accept) but they are not on the trip yet and their vote
 * must not decide it. Null on a read failure, never [] — an empty electorate
 * would make every candidate trivially "ready to confirm".
 *
 * THE OWNER IS ADMITTED BY `requireTripMember`, NOT BY `trips.owner_id`, and
 * that distinction is the whole reason the call is here rather than an
 * `ids.add(ownerId)`. `requireTripMember` gives the owner the benefit of a
 * MISSING trip_members row (trip creation writes none) but NOT of a present
 * one: an owner row at status 'left' or 'removed', or at a role outside
 * ACCEPTED_TRIP_MEMBER_ROLES, fails `isAcceptedTripMemberRow` and the gate
 * turns them away. Adding the owner unconditionally made this list a SECOND
 * rule — the exact drift the paragraphs above say cannot happen — and it drifted
 * in the quorum-breaking direction: an owner the gate rejects can never vote,
 * so `pending` never reaches zero and `readyToConfirm` is false forever. One
 * extra tiny read is the price of there being one rule.
 */
async function loadEligibleVoters(sc: any, tripId: string): Promise<string[] | null> {
  const [ownerRes, memberRes] = await Promise.all([
    sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
    sc
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", tripId)
      .in("role", ACCEPTED_TRIP_MEMBER_ROLES)
      .limit(MAX_MEMBER_ROWS),
  ]);
  if (ownerRes.error || memberRes.error) return null;
  const ids = new Set<string>();
  const ownerId = (ownerRes.data as any)?.owner_id;
  if (typeof ownerId === "string" && (await requireTripMember(sc, tripId, ownerId))) {
    ids.add(ownerId);
  }
  for (const row of ((memberRes.data as any[]) ?? [])) {
    if (typeof row?.user_id !== "string") continue;
    if (!isAcceptedTripMemberRow(row)) continue;
    ids.add(row.user_id);
  }
  return [...ids];
}

/** Non-removed plan rows for a trip, bounded. Null on a read failure. */
async function loadPlanRows(sc: any, tripId: string): Promise<any[] | null> {
  const { data, error } = await sc
    .from("trip_plan_items")
    .select(PLAN_COLUMNS)
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .order("starts_at", { ascending: true, nullsFirst: false })
    .order("sort_order", { ascending: true })
    .limit(MAX_PLAN_ROWS);
  if (error || !Array.isArray(data)) return null;
  return data as any[];
}

// ── GET /map/journey/shortlist ────────────────────────────────────────────────

router.get(
  "/map/journey/shortlist",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured"); return; }

    const tripId = typeof req.query.tripId === "string" ? req.query.tripId : "";
    if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "tripId must be a valid UUID"); return; }

    // Membership BEFORE the flag: a non-member must not be able to learn
    // whether Phase 6 is on for someone else's trip.
    if (!(await isAcceptedTripMember(client, tripId, user.id))) {
      sendError(res, "not_member", "You must be an accepted trip member to see the shortlist");
      return;
    }

    if (!(await isFlagEnabled(sc, JOURNEY_FLAG))) {
      res.json({ enabled: false, items: [], crew: [], eligibleVoters: 0, truncated: 0 });
      return;
    }

    const rl = checkRateLimit("map_journey_shortlist", user.id, 60, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const [rows, voters] = await Promise.all([
      loadPlanRows(sc, tripId),
      loadEligibleVoters(sc, tripId),
    ]);
    if (rows === null || voters === null) { sendError(res, "db_error", "Could not read the trip plan"); return; }

    const candidateIds = rows.filter((r) => r.status === SHORTLIST_STATUS).map((r) => String(r.id));
    let votes: VoteRow[] = [];
    if (candidateIds.length > 0) {
      const { data, error } = await sc
        .from("trip_plan_item_votes")
        .select("plan_item_id, user_id, vote")
        .eq("trip_id", tripId)
        .in("plan_item_id", candidateIds)
        .limit(MAX_VOTE_ROWS);
      // A failed vote read is NOT "no votes": an empty tally would show a
      // declined candidate as merely undecided. Refuse instead.
      if (error || !Array.isArray(data)) { sendError(res, "db_error", "Could not read the votes"); return; }
      votes = data as VoteRow[];
    }

    // Coarse crew areas. A crew-map failure costs the sheet its area labels and
    // nothing else — the decision itself does not depend on where anyone is.
    const crew = await getCrewMap(sc, tripId, user.id).catch(() => null);

    const projection = buildShortlist({
      rows: rows as ShortlistItemRow[],
      votes,
      eligibleMemberIds: voters,
      viewerId: user.id,
      crew: crew?.members,
    });

    res.json({
      enabled: true,
      ...projection,
      // The confirm is the EXISTING plan write path; this names it rather than
      // implementing a second one. See the file header.
      confirmPath: "PATCH /api/trips/:tripId/plan/items/:itemId { status: 'confirmed' }",
      crewReadFailed: crew === null,
    });
  }),
);

// ── POST /map/journey/shortlist/:planItemId/vote ──────────────────────────────

const VoteSchema = z.object({
  tripId: z.string().regex(UUID, "tripId must be a valid UUID"),
  vote: z.enum(["accept", "decline"]),
});

router.post(
  "/map/journey/shortlist/:planItemId/vote",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured"); return; }

    const { planItemId } = req.params;
    if (!UUID.test(planItemId)) { sendError(res, "invalid_payload", "Invalid planItemId"); return; }

    const parsed = VoteSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const { tripId, vote } = parsed.data;
    if (!isVote(vote)) { sendError(res, "invalid_payload", "vote must be accept or decline"); return; }

    if (!(await isAcceptedTripMember(client, tripId, user.id))) {
      sendError(res, "not_member", "You must be an accepted trip member to vote");
      return;
    }

    if (!(await isFlagEnabled(sc, JOURNEY_FLAG))) {
      // Fail-soft AND write-free: nothing is recorded while the capability is
      // off, so pressing the flag later cannot surface votes nobody knew about.
      res.json({ enabled: false, recorded: false });
      return;
    }

    const rl = checkRateLimit("map_journey_vote", user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    // The item must be THIS trip's, still live, and still a candidate. The
    // migration's trigger enforces the trip match at the storage layer too;
    // this check is what turns that into a clean 404 instead of a 500.
    const { data: item, error: itemErr } = await sc
      .from("trip_plan_items")
      .select("id, trip_id, status, removed_at")
      .eq("id", planItemId)
      .maybeSingle();
    if (itemErr) { sendError(res, "db_error", "Could not read the plan item"); return; }
    if (!item || (item as any).trip_id !== tripId || (item as any).removed_at !== null) {
      sendError(res, "not_found", "Plan item not found on this trip");
      return;
    }
    if ((item as any).status !== SHORTLIST_STATUS) {
      // A confirmed / done / cancelled item is a decision the plan already
      // made. Voting on it would let this sheet re-open it behind the plan's
      // own permission model.
      sendError(res, "forbidden", "This item is no longer on the shortlist");
      return;
    }

    const { error } = await sc
      .from("trip_plan_item_votes")
      .upsert(
        {
          trip_id: tripId,
          plan_item_id: planItemId,
          user_id: user.id,
          vote,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "plan_item_id,user_id" },
      );
    if (error) { req.log.error({ err: error }, "journey vote upsert"); sendError(res, "db_error", error.message); return; }

    // Answer with the item's fresh tally so the caller never has to guess what
    // its own vote did.
    const [{ data: votes, error: votesErr }, voters] = await Promise.all([
      sc.from("trip_plan_item_votes").select("plan_item_id, user_id, vote").eq("plan_item_id", planItemId).limit(MAX_VOTE_ROWS),
      loadEligibleVoters(sc, tripId),
    ]);
    if (votesErr || !Array.isArray(votes) || voters === null) {
      // The vote IS recorded; only the echo failed. Say exactly that.
      res.json({ enabled: true, recorded: true, tally: null });
      return;
    }

    // `tallyItem` directly, not a synthetic one-row shortlist: the tally is the
    // only thing being echoed, and inventing a plan-item row to carry it would
    // put a placeholder title one refactor away from the wire.
    res.json({
      enabled: true,
      recorded: true,
      tally: tallyItem(votes as VoteRow[], new Set(voters), user.id),
    });
  }),
);

// ── GET /map/journey/recovery ─────────────────────────────────────────────────

router.get(
  "/map/journey/recovery",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured"); return; }

    const tripId = typeof req.query.tripId === "string" ? req.query.tripId : "";
    if (!UUID.test(tripId)) { sendError(res, "invalid_payload", "tripId must be a valid UUID"); return; }

    if (!(await isAcceptedTripMember(client, tripId, user.id))) {
      sendError(res, "not_member", "You must be an accepted trip member to see recovery options");
      return;
    }

    const nowMs = Date.now();
    const generatedAt = new Date(nowMs).toISOString();

    if (!(await isFlagEnabled(sc, JOURNEY_FLAG))) {
      res.json({ enabled: false, entries: [], considered: 0, weakEvidenceStops: 0, generatedAt });
      return;
    }

    const rl = checkRateLimit("map_journey_recovery", user.id, 30, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const rows = await loadPlanRows(sc, tripId);
    if (rows === null) { sendError(res, "db_error", "Could not read the trip plan"); return; }

    // The stops recovery reasons about: CONFIRMED plan items. A 'tentative'
    // candidate is still being decided (that is the shortlist's job) and a
    // done/cancelled one is history — neither is a stop the traveller is on
    // their way to, and offering an alternative to one would be noise.
    const planned = rows
      .filter((r) => r.status === "confirmed")
      .filter((r) => typeof r.title === "string" && r.title.trim() !== "");

    // Resolve each stop to the canonical subject the live seam is keyed on,
    // through the SAME discovery_places → canonical_location_id bridge Compass
    // uses (the "demand id-space trap"). An unresolved stop simply gets no
    // live claim — never a wrong subject.
    const items: CompassItem[] = planned
      .filter((r) => r.source_type === "place" && typeof r.source_id === "string")
      .slice(0, MAX_RECOVERY_SUBJECTS)
      .map((r) => ({ id: String(r.id), type: "place", placeId: String(r.source_id) }) as CompassItem);
    const subjectByItem = await resolveLiveSubjects(sc, items).catch(() => new Map<string, string>());

    // One read per DISTINCT subject, through the gated envelope seam. That seam
    // is fail-closed end to end (flag chain, kill switch, promotion, freshness,
    // privacy, truth boundary); this route never touches a snapshot row.
    const subjects = [...new Set(subjectByItem.values())];
    const envelopesBySubject = new Map<string, LiveClaimEnvelope[]>();
    await Promise.all(
      subjects.map(async (subjectId) => {
        const envs = await readLiveClaimEnvelopes(sc, subjectId, { now: new Date(nowMs) }).catch(() => []);
        envelopesBySubject.set(subjectId, envs);
      }),
    );

    const stops: PlannedStop[] = planned.map((r) => ({
      id: String(r.id),
      title: String(r.title).trim(),
      category: r.category ?? null,
      subjectId: subjectByItem.get(String(r.id)) ?? null,
      endsAt: r.ends_at ?? null,
    }));

    // The alternative pool is the TRIP'S OWN saved places plus its other
    // candidates. Deliberately not a fresh discovery search: those are places
    // this crew already chose, the read is trip-scoped and already authorized,
    // and no new privacy surface is opened to answer "where else could we go".
    const { data: savedRows } = await sc
      .from("trip_saved_places")
      .select("id, place_name, place_type, saved_at")
      .eq("trip_id", tripId)
      .order("saved_at", { ascending: false })
      .limit(MAX_CANDIDATE_ROWS);

    const plannedIds = new Set(planned.map((r) => String(r.id)));
    const candidates: RecoveryCandidate[] = [
      ...(((savedRows as any[]) ?? []).map((s, i) => ({
        id: String(s.id),
        title: String(s.place_name ?? "Saved place"),
        category: s.place_type ?? null,
        // Recency order, expressed as a descending score. This is a ranking of
        // the crew's own saved list; it is NOT a confidence, is never stored,
        // and never re-enters any model.
        score: 1_000 - i,
      })) as RecoveryCandidate[]),
      ...rows
        .filter((r) => r.status === SHORTLIST_STATUS && !plannedIds.has(String(r.id)))
        .filter((r) => typeof r.title === "string" && r.title.trim() !== "")
        .map((r, i) => ({
          id: String(r.id),
          title: String(r.title).trim(),
          category: r.category ?? null,
          score: 500 - i,
        })),
    ];

    // The viewer's own tolerances (queue patience, a 'quiet' intent), derived
    // by the Compass helper from their travel styles. Unreadable ⇒ defaults.
    const { data: profile } = await sc
      .from("profiles")
      .select("travel_styles")
      .eq("id", user.id)
      .maybeSingle();
    const tolerances = deriveViewerLiveTolerances({
      travelStyles: ((profile as any)?.travel_styles ?? []) as string[],
    } as Pick<CompassProfile, "travelStyles">);

    const result = computeRecovery({
      stops,
      envelopesBySubject,
      candidates,
      tolerances,
      nowMs,
    });

    res.json({ enabled: true, ...result, generatedAt });
  }),
);

export default router;
