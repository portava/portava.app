/**
 * memoryReadPolicy — §23's `canReadMemory(userId, memoryId, surface)`, in ONE place.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §23 "Authorization and RLS" — `canReadMemory(userId, memoryId, surface)`.
 *       §10 canonical storage and public projections are separate.
 *       §16 "Compass ... may not bypass privacy/visibility policy."
 *
 * CENSUS: H205 was moved to BUILT-AND-CORRECT by section B with a CEILING stated
 *         in its own row: "the helper is module-private, and two other surfaces
 *         re-derive the rule instead of calling it ... One verdict now serves one
 *         route file, not the repository."
 *
 *         This module removes the FIRST half of that ceiling and no more. The
 *         function is no longer module-private, and §16's Compass accessors call
 *         THIS function instead of becoming a fourth copy of the ladder.
 *         `routes/contentStamps.ts` and `routes/wellKnownShare.ts` still
 *         re-derive it in their own words; that half of the ceiling is unchanged
 *         and section C of the census says so rather than letting this header
 *         imply otherwise.
 *
 * NOTHING IN THE LADDER BELOW WAS CHANGED BY THE MOVE. The body is what
 * `routes/memories.ts` carried, comment for comment, including every note
 * recording the audit that produced it (MEM·M1; the trip_crew role/status
 * repair; the four fail-closed gate reads that bind `.error`). Only two things
 * are added:
 *
 *   1. A fifth surface, `"compass"`, described at its own entry below.
 *   2. `canCompassReadMemory`, which is `canReadMemory(..., "compass")` AND the
 *      bidirectional block check in ONE call, so a Compass tool cannot read a
 *      Memory and forget the blocks. "Remember to call both" is precisely the
 *      shape of defect the comments in this file keep recording.
 *
 * `routes/memories.ts` imports every symbol here and re-derives none of them.
 */
import { logger } from "../../lib/logger.js";

// ── Visibility helpers ─────────────────────────────────────────────────────────

export const VISIBILITY_VALUES = ["public", "friends_only", "trip_crew", "circle_only", "only_me", "custom"] as const;
export type MemoryVisibility = (typeof VISIBILITY_VALUES)[number];

/**
 * The surface a read is being served on. Spec v1 §23 names the policy function
 * `canReadMemory(userId, memoryId, surface)` — the surface is part of the
 * signature because one verdict must not serve every surface.
 *
 *   "single"      GET /memories/:id — a direct, addressed read. The full
 *                 audience ladder applies: an allow-listed viewer of a `custom`
 *                 Memory, a mutual follower of a `friends_only` one and a crew
 *                 member of a `trip_crew` one may all read it here.
 *   "profile"     GET /users/:userId/memories — same ladder; the viewer asked
 *                 for one named owner.
 *   "trip"        GET /trips/:tripId/memory — same ladder, scoped to a trip.
 *   "public_feed" GET /memories — the discovery surface, and the reason this
 *                 parameter exists. It is a PUBLIC surface: nothing but
 *                 `visibility = 'public'` is admissible on it, no matter what
 *                 relationship the viewer has to the owner. A `custom` Memory
 *                 whose allow-list happens to contain the viewer must not
 *                 appear in a global feed — being permitted to see something
 *                 when you ask for it is not the same as having it pushed at
 *                 you among strangers' content. §10 states the general form:
 *                 canonical storage and public projections are separate, and
 *                 the public surface gets the narrower rule.
 *   "compass"     The §16 Compass accessors (`compass/MemoryCompassTools.ts`).
 *                 It is an ADDRESSED read — the user asked their own assistant
 *                 about their own history — so it runs the same ladder as
 *                 "single" and deliberately not the feed rule: a Memory shared
 *                 with this viewer is a Memory this viewer may be told about.
 *                 It is a DISTINCT surface anyway, for two reasons that are
 *                 about the future rather than about today's branch structure.
 *                 (a) An LLM turn is the one caller that will paraphrase what
 *                 it is given, so if the audience ladder ever needs to narrow
 *                 for a generative consumer, §23 says the narrowing belongs to a
 *                 surface and this is the surface it belongs to. (b) The
 *                 `denyUnreadable` log line carries the surface, so a gate read
 *                 that fails during a Compass turn is distinguishable in the
 *                 logs from one that fails on GET /memories/:id.
 *                 Compass callers should use `canCompassReadMemory`, which also
 *                 applies the block check.
 */
export type MemoryReadSurface = "single" | "profile" | "trip" | "public_feed" | "compass";

/**
 * Spec v1 §23 `canReadMemory(userId, memoryId, surface)`.
 *
 * Determines whether `viewerId` can read a memory row given raw DB data, ON THE
 * NAMED SURFACE. Always returns true for the owner.
 */
export async function canReadMemory(
  sc: any,
  memory: any,
  viewerId: string | null,
  surface: MemoryReadSurface,
): Promise<boolean> {
  if (viewerId === memory.owner_id) return true;
  if (memory.state !== "published") return false;

  const vis: MemoryVisibility = memory.visibility ?? "only_me";

  if (vis === "only_me") return false;

  // The public surface admits exactly one visibility class, before any
  // relationship is consulted. Everything below this line is the addressed-read
  // ladder and must not run for the feed.
  if (surface === "public_feed") {
    if (vis !== "public") return false;
    const hiddenOnFeed: string[] = memory.hidden_user_ids ?? [];
    return !(viewerId != null && hiddenOnFeed.includes(viewerId));
  }

  if (!viewerId) return vis === "public";

  // A hidden viewer is denied for EVERY visibility mode. The hide list used to be
  // consulted only in the 'custom' branch, so a user the owner hid could still
  // read the memory when it was public / friends_only / trip_crew / circle_only
  // (audit MEM·M1). Owner already returned true above, so this never self-hides.
  const hidden: string[] = memory.hidden_user_ids ?? [];
  if (hidden.includes(viewerId)) return false;

  if (vis === "public") return true;

  if (vis === "custom") {
    const allowed: string[] = memory.allowed_user_ids ?? [];
    if (allowed.includes(viewerId)) return true;
    return false;
  }

  // EVERY GATE READ BELOW BINDS AND INSPECTS `.error`.
  //
  // supabase-js RESOLVES on a database error, so the old `Boolean(data)` /
  // `if (!data) return false` forms turned an unreadable follow graph, crew or
  // circle into a confident "not permitted". The DENIAL is right — withholding
  // is the safe answer — but it was indistinguishable from a real one at every
  // level: no different value, no log, nothing an operator could see. These are
  // the four entries routes/memories.ts carries on the unchecked-reads ledger.
  //
  // The verdict is deliberately unchanged (still `false`), because this helper
  // is called per-row across the discovery feed and the profile listing, where
  // a per-row "undecidable" has no honest rendering. What changes is that the
  // failure is now VISIBLE.
  const denyUnreadable = (table: string, err: unknown): false => {
    logger.error(
      { err, table, memoryId: memory?.id, viewerId, visibility: vis, surface },
      "memories: visibility gate read failed — withholding the memory (indistinguishable from a real deny in the response)",
    );
    return false;
  };

  if (vis === "friends_only") {
    const { data, error } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", memory.owner_id)
      .eq("following_id", viewerId)
      .maybeSingle();
    if (error) return denyUnreadable("user_follows", error);
    if (!data) return false;
    const { data: back, error: backErr } = await sc
      .from("user_follows")
      .select("following_id")
      .eq("follower_id", viewerId)
      .eq("following_id", memory.owner_id)
      .maybeSingle();
    if (backErr) return denyUnreadable("user_follows", backErr);
    return Boolean(back);
  }

  if (vis === "trip_crew") {
    if (!memory.trip_id) return false;
    // THE OLD PREDICATE WAS `trip_members WHERE trip_id = … AND user_id = viewer`
    // AND NOTHING ELSE — no role filter, no status filter, and no check on the
    // MEMORY OWNER at all. Any row admitted: role='invited' (never accepted the
    // invitation), status='removed' (thrown off the trip), any role whatsoever.
    // requireTripMember (lib/http.ts, the definition of record) accepts
    //     role IN (owner, co_host, member, viewer)
    //     AND (status IS NULL OR status = 'accepted')
    // and falls back to trips.owner_id when no row exists. Migration 2530
    // repaired the identical shape in the RLS policy behind highlights;
    // routes/highlights.ts and routes/stories.ts carry the app-side rule. This
    // is the third copy, and it was the loosest of the three.
    const crew = await acceptedCrewOfTrip(sc, memory.trip_id);
    if (!crew.ok) return denyUnreadable("trip_members", crew.error);
    return crew.ids.has(viewerId) && crew.ids.has(memory.owner_id as string);
  }

  if (vis === "circle_only") {
    const { data, error } = await sc
      .from("circle_memberships")
      .select("other_id")
      .eq("user_id", memory.owner_id)
      .eq("other_id", viewerId)
      .maybeSingle();
    if (error) return denyUnreadable("circle_memberships", error);
    return Boolean(data);
  }

  return false;
}

/* ============================================================================
 * Trip crew — requireTripMember's rule, the third app-side copy.
 *
 * See the note in canReadMemory's trip_crew branch. The rule is duplicated
 * rather than imported because that is already this repo's shape for it
 * (lib/circleAccessGuard.ts, lib/mediaEligibility.ts, routes/geofence.ts,
 * routes/highlights.ts, routes/stories.ts); one home for all of them is worth
 * doing and is not this change.
 *
 * FAIL CLOSED: both reads check `.error` and the caller withholds.
 * ============================================================================ */
const ACCEPTED_TRIP_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

function isAcceptedMembershipRow(r: { role?: string | null; status?: string | null }): boolean {
  if (!r.role || !ACCEPTED_TRIP_ROLES.has(r.role)) return false;
  return r.status == null || r.status === "accepted";
}

/**
 * The accepted crew of `tripId` — accepted trip_members rows, plus the
 * trips.owner_id fallback when the owner holds no row (the row wins when one
 * exists, so an owner whose own row says status='removed' is NOT crew).
 */
export async function acceptedCrewOfTrip(
  sc: any,
  tripId: string,
): Promise<{ ok: true; ids: Set<string> } | { ok: false; error: unknown }> {
  const [rows, trip] = await Promise.all([
    sc.from("trip_members").select("user_id, role, status").eq("trip_id", tripId),
    sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle(),
  ]);
  if (rows.error) return { ok: false, error: rows.error };
  if (trip.error) return { ok: false, error: trip.error };
  const ids = new Set<string>();
  const rowUsers = new Set<string>();
  for (const r of (rows.data ?? []) as any[]) {
    rowUsers.add(r.user_id as string);
    if (isAcceptedMembershipRow(r)) ids.add(r.user_id as string);
  }
  const ownerId = (trip.data as any)?.owner_id as string | null | undefined;
  if (ownerId && !rowUsers.has(ownerId)) ids.add(ownerId);
  return { ok: true, ids };
}

/** Check blocks in both directions. Returns true if blocked. */
export async function isBlocked(sc: any, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const [r1, r2] = await Promise.all([
    sc.from("blocks").select("blocked_id").eq("blocker_id", a).eq("blocked_id", b).maybeSingle(),
    sc.from("blocks").select("blocker_id").eq("blocker_id", b).eq("blocked_id", a).maybeSingle(),
  ]);
  // Fail CLOSED: if either block lookup errors we cannot prove the two users are
  // unblocked, so treat them as blocked. supabase-js resolves (does not throw)
  // on a DB error, so an unchecked error here would silently read as "not
  // blocked" and leak the owner's memory content to a blocked viewer.
  if (r1.error || r2.error) return true;
  return Boolean(r1.data) || Boolean(r2.data);
}

/**
 * §16's read gate: the §23 ladder on the `"compass"` surface AND the block check,
 * as one call that cannot be half-performed.
 *
 * WHY THIS IS NOT JUST `canReadMemory(..., "compass")`. `routes/memories.ts`
 * calls `isBlocked` separately at four of its six read sites, and the fifth and
 * sixth use a set-shaped variant. That is fine in a route file where the two
 * calls sit three lines apart and a reviewer sees both. It is not fine for a
 * tool surface where eight accessors each have their own read path: eight
 * chances to write one of the two calls and not the other, and the failure is
 * silent — a blocked viewer being told, in prose, what the person who blocked
 * them did last summer.
 *
 * FAIL CLOSED IN BOTH LIMBS. `isBlocked` returns `true` when the blocks table
 * cannot be read, and this returns `false` (withhold) on that reading.
 */
export async function canCompassReadMemory(
  sc: any,
  memory: any,
  viewerId: string,
): Promise<boolean> {
  const ownerId = memory?.owner_id as string | null | undefined;
  if (typeof ownerId === "string" && ownerId !== viewerId) {
    if (await isBlocked(sc, viewerId, ownerId)) return false;
  }
  return canReadMemory(sc, memory, viewerId, "compass");
}

/* ============================================================================
 * §23 `canPublishMemory(userId, memoryId, audience)`
 *
 * CENSUS H207 was NOT-BUILT with the evidence "Publishing is a `visibility`
 * write with no audience predicate". This is the predicate, and it is derived
 * from `canReadMemory` above rather than invented beside it.
 *
 * THE ONE QUESTION IT ASKS: can this audience be DELIVERED?
 * ---------------------------------------------------------
 * Three (visibility, row) combinations make `canReadMemory` return false for
 * EVERY viewer who is not the owner — not "usually", not "until somebody joins
 * something", but by the structure of the ladder itself:
 *
 *   trip_crew with no trip_id            `if (!memory.trip_id) return false;`
 *   trip_crew whose OWNER is not crew    the branch requires
 *                                        `crew.ids.has(memory.owner_id)`
 *   custom with an empty allow-list      the branch is `allowed.includes(viewer)`
 *                                        over an empty array
 *
 * A user who picks one of those is told their Memory is shared with their crew,
 * or with a chosen few, and it is shared with nobody. That is not a privacy
 * failure — it fails safe — it is an HONESTY failure, and it is silent: nothing
 * in the product ever tells them. §10's separation of canonical storage from
 * published audience is what makes it a policy question rather than a UI one.
 *
 * `only_me` is NOT refused: it means nobody, on purpose. `friends_only` and
 * `circle_only` are NOT refused when the graph is empty, because that is a
 * state which changes without a write — a follower can arrive tomorrow and the
 * Memory becomes visible with no further action. The three above cannot: the
 * ROW itself is what makes them undeliverable.
 *
 * A test asserts exactly that correspondence — for every refused combination it
 * runs `canReadMemory` over a set of candidate viewers on every surface and
 * requires all of them to deny — so this list cannot drift into an arbitrary
 * set of opinions about audiences.
 *
 * THE SIGNATURE. §23 writes `canPublishMemory(userId, memoryId, audience)`.
 * This takes the ROW rather than the id, because both call sites already hold
 * it (POST has not written the row yet and so has no id at all) and re-fetching
 * to match a signature would be a round trip bought with nothing. `memoryId` is
 * carried on the decision for the log line.
 * ============================================================================ */

export type PublishRefusalReason =
  | "not_owner"
  | "unknown_audience"
  | "trip_crew_without_trip"
  | "trip_crew_owner_not_crew"
  | "trip_crew_unreadable"
  | "custom_without_allow_list";

export const PUBLISH_REFUSAL_MESSAGE: Readonly<Record<PublishRefusalReason, string>> = Object.freeze({
  not_owner: "Only the owner of a Memory may choose its audience.",
  unknown_audience: "That is not an audience this app can publish to.",
  trip_crew_without_trip: "This Memory is not attached to a trip, so there is no crew to share it with. Attach it to a trip, or choose another audience.",
  trip_crew_owner_not_crew: "You are not an accepted member of that trip, so nobody on it would be able to see this Memory.",
  trip_crew_unreadable: "The trip's membership could not be checked just now, so this audience cannot be confirmed. Try again in a moment.",
  custom_without_allow_list: "A custom audience with nobody on the list shares this Memory with no one. Add at least one person, or choose another audience.",
});

/** The row shape `canPublishMemory` needs. Both call sites already hold it. */
export interface PublishCandidate {
  id?: string | null;
  owner_id: string;
  trip_id?: string | null;
  allowed_user_ids?: string[] | null;
}

export type PublishDecision =
  | { ok: true; audience: MemoryVisibility }
  | { ok: false; audience: string | null; reason: PublishRefusalReason; message: string };

export async function canPublishMemory(
  sc: any,
  actorUserId: string,
  memory: PublishCandidate,
  audience: string | null | undefined,
): Promise<PublishDecision> {
  const refuse = (reason: PublishRefusalReason): PublishDecision => {
    logger.info(
      { memoryId: memory.id ?? null, actorUserId, audience: audience ?? null, reason },
      "memories: publish refused — the chosen audience cannot be delivered",
    );
    return { ok: false, audience: audience ?? null, reason, message: PUBLISH_REFUSAL_MESSAGE[reason] };
  };

  if (memory.owner_id !== actorUserId) return refuse("not_owner");
  if (typeof audience !== "string" || !(VISIBILITY_VALUES as readonly string[]).includes(audience)) {
    return refuse("unknown_audience");
  }
  const vis = audience as MemoryVisibility;

  if (vis === "custom") {
    const allowed = memory.allowed_user_ids ?? [];
    if (allowed.length === 0) return refuse("custom_without_allow_list");
  }

  if (vis === "trip_crew") {
    if (!memory.trip_id) return refuse("trip_crew_without_trip");
    const crew = await acceptedCrewOfTrip(sc, memory.trip_id);
    // FAIL CLOSED, and distinguishably. An unreadable trip_members is not
    // "you are not on the trip"; the two get different reasons because one is
    // the user's situation and the other is ours.
    if (!crew.ok) return refuse("trip_crew_unreadable");
    if (!crew.ids.has(memory.owner_id)) return refuse("trip_crew_owner_not_crew");
  }

  return { ok: true, audience: vis };
}
