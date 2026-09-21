/**
 * Plan helper routes — add place or meetup to a trip plan.
 *
 *   POST /api/meetups/:meetupId/add-to-trip-plan  { tripId }
 *   POST /api/places/:placeId/add-to-trip-plan    { tripId, dayDate?, startsAt? }
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireUser, isAcceptedTripMember, canEditPlan, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { isMissingColumnError } from "../lib/capability/schemaCapability.js";
import {
  tripKernelClient,
  readCommandEnvelope,
  executeTripCommand,
  sendKernelRejection,
  setTripVersionHeader,
} from "../domain/trips/commands/tripKernel.js";

const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

// ── POST /meetups/:meetupId/add-to-trip-plan ─────────────────────────────────

const AddMeetupSchema = z.object({
  tripId: z.string().regex(UUID, "tripId must be a valid UUID"),
  lockType: z.enum(["fixed", "flexible", "optional"]).default("flexible"),
});

router.post("/meetups/:meetupId/add-to-trip-plan", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { meetupId } = req.params;
  if (!UUID.test(meetupId)) { sendError(res, "invalid_payload", "Invalid meetupId"); return; }

  const parsed = AddMeetupSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { tripId, lockType } = parsed.data;

  // Caller must be an accepted trip member with plan edit permission
  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to add items"); return; }
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to add items to this plan"); return; }

  // Fetch meetup row — we use a meetups table stub (title, starts_at, location_name)
  const { data: meetup } = await client
    .from("meetups")
    .select("id, title, starts_at, location_name, trip_id")
    .eq("id", meetupId)
    .maybeSingle();
  if (!meetup) { sendError(res, "not_found", "Meetup not found"); return; }

  // Enforce meetup-trip identity: a trip-scoped meetup may only be added to its own trip
  // (guard ported from the now-removed duplicate handler in meetups.ts).
  if ((meetup as any).trip_id && (meetup as any).trip_id !== tripId) {
    sendError(res, "forbidden", "This meetup is scoped to a different trip");
    return;
  }

  // Duplicate guard: same meetup already added to this trip (non-removed).
  // supabase-js RESOLVES on a DB error, so an unbound `error` read an
  // unreadable trip_plan_items as "not added yet" and went on to ADD_PLAN —
  // putting the same meetup into the trip timeline twice for every member,
  // which no one can tell apart from a real second entry.
  const { data: existing, error: existingErr } = await client
    .from("trip_plan_items")
    .select("id")
    .eq("trip_id", tripId)
    .eq("source_type", "meetup")
    .eq("source_id", meetupId)
    .is("removed_at", null)
    .maybeSingle();
  if (existingErr) {
    req.log.error({ err: existingErr, tripId, meetupId }, "meetup plan duplicate check failed — refusing to add");
    sendError(res, "db_error", existingErr.message);
    return;
  }
  if (existing) { res.status(409).json({ error: "duplicate", message: "This meetup is already in your trip plan" }); return; }

  // Trip Kernel path (§4.1 ADD_PLAN, capability crew). The membership and
  // plan-edit checks above are the authorization; the kernel re-checks crew.
  // The payload names every column the direct insert names, plus
  // location_is_private = true — the column the insert leaves at its table
  // default — so the kernel row is the legacy row. Off => the insert below.
  const kernel = await tripKernelClient();
  if (kernel) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernel, {
      commandId: randomUUID(),
      tripId,
      actorUserId: user.id,   // always from token
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "ADD_PLAN",
      payload: {
        title: (meetup as any).title,
        category: "meeting_point",
        status: "tentative",
        source_type: "meetup",
        source_id: meetupId,
        starts_at: (meetup as any).starts_at ?? null,
        location_name: (meetup as any).location_name ?? null,
        location_is_private: true,
        sort_order: 0,
        visibility: "members",
        lock_type: lockType,
      },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    res.status(201).json(toCamel(r.result));
    return;
  }

  // trip-kernel:legacy-path — flag-off twin of ADD_PLAN above.
  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id: tripId,
      creator_id: user.id,
      title: (meetup as any).title,
      category: "meeting_point",
      status: "tentative",
      source_type: "meetup",
      source_id: meetupId,
      starts_at: (meetup as any).starts_at ?? null,
      location_name: (meetup as any).location_name ?? null,
      sort_order: 0,
      visibility: "members",
      lock_type: lockType,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add meetup to plan"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toCamel(item));
}));

// ── POST /places/:placeId/add-to-trip-plan ───────────────────────────────────

const AddPlaceSchema = z.object({
  tripId:   z.string().regex(UUID, "tripId must be a valid UUID"),
  dayDate:  z.string().optional(),
  startsAt: z.string().optional(),
  lockType: z.enum(["fixed", "flexible", "optional"]).default("flexible"),
});

router.post("/places/:placeId/add-to-trip-plan", asyncHandler(async (req, res) => {
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { client, user } = ctx;

  const { placeId } = req.params;

  const parsed = AddPlaceSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body"); return; }
  const { tripId, dayDate, startsAt, lockType } = parsed.data;

  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to add items"); return; }
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to add items to this plan"); return; }

  // Fetch place row — public-safe columns only (name, category, city)
  // NOTE: exact coordinates are intentionally NOT fetched.
  // Repointed from non-existent "places" to the live "discovery_places" table.
  const { data: place } = await client
    .from("discovery_places")
    .select("id, name, category, city")
    .eq("id", placeId)
    .maybeSingle();
  if (!place) { sendError(res, "not_found", "Place not found"); return; }

  // Duplicate guard — see the meetup route above for why `error` must be bound:
  // an unreadable trip_plan_items otherwise reads as "not added yet" and the
  // ADD_PLAN below puts the same place into the trip timeline a second time.
  const { data: existing, error: existingErr } = await client
    .from("trip_plan_items")
    .select("id")
    .eq("trip_id", tripId)
    .eq("source_type", "place")
    .eq("source_id", placeId)
    .is("removed_at", null)
    .maybeSingle();
  if (existingErr) {
    req.log.error({ err: existingErr, tripId, placeId }, "place plan duplicate check failed — refusing to add");
    sendError(res, "db_error", existingErr.message);
    return;
  }
  if (existing) { res.status(409).json({ error: "duplicate", message: "This place is already in your trip plan" }); return; }

  // Trip Kernel path (§4.1 ADD_PLAN, capability crew) — see the meetup route.
  const kernel = await tripKernelClient();
  if (kernel) {
    const env = readCommandEnvelope(req);
    if (!env.ok) { sendError(res, "invalid_payload", env.message); return; }
    const r = await executeTripCommand(kernel, {
      commandId: randomUUID(),
      tripId,
      actorUserId: user.id,   // always from token
      expectedTripVersion: env.expectedTripVersion,
      idempotencyKey: env.idempotencyKey,
      type: "ADD_PLAN",
      payload: {
        title: (place as any).name,
        category: (place as any).category ?? "activity",
        status: "tentative",
        source_type: "place",
        source_id: placeId,
        day_date: dayDate ?? null,
        starts_at: startsAt ?? null,
        location_name: (place as any).city ?? null,
        location_is_private: true,
        sort_order: 0,
        visibility: "members",
        lock_type: lockType,
      },
    });
    if (!r.ok) { sendKernelRejection(res, r, req.log); return; }
    setTripVersionHeader(res, r.version);
    res.status(201).json(toCamel(r.result));
    return;
  }

  // trip-kernel:legacy-path — flag-off twin of ADD_PLAN above.
  const { data: item, error } = await client
    .from("trip_plan_items")
    .insert({
      trip_id: tripId,
      creator_id: user.id,
      title: (place as any).name,
      category: (place as any).category ?? "activity",
      status: "tentative",
      source_type: "place",
      source_id: placeId,
      day_date: dayDate ?? null,
      starts_at: startsAt ?? null,
      location_name: (place as any).city ?? null,
      sort_order: 0,
      visibility: "members",
      lock_type: lockType,
    })
    .select("*")
    .single();

  if (error) { req.log.error({ err: error }, "add place to plan"); sendError(res, "db_error", error.message); return; }

  res.status(201).json(toCamel(item));
}));

// ── The plan-item column list, in ONE place ──────────────────────────────────

/**
 * Every column `toCamel` below consumes, EXCEPT §6.3's `privacy_scope`.
 *
 * It is the fallback list: a database without
 * `2770_trip_plans_spec_columns.sql` answers PGRST204 to the scope and the
 * caller retries with this one, so an unapplied migration costs a reader the
 * scope field and not their whole itinerary.
 */
export const PLAN_ITEM_COLUMNS_BASE =
  "id, trip_id, creator_id, title, category, status, source_type, source_id, " +
  "day_date, starts_at, ends_at, location_name, notes, sort_order, visibility, " +
  "lock_type, location_is_private, lat, lng, created_at, updated_at";

/** The list every plan reader asks for FIRST — the base plus §6.3's scope (2770, census-trips TR116). */
export const PLAN_ITEM_COLUMNS = `${PLAN_ITEM_COLUMNS_BASE}, privacy_scope`;

/**
 * Read a trip's plan items in render order, with §6.3's one-retry fallback.
 *
 * WHY THIS LIVES HERE AND NOT AT ITS CALL SITES. `resolveSelectString` in
 * check:write-path-columns follows an identifier only to a SAME-FILE
 * initializer. A `.select(PLAN_ITEM_COLUMNS)` written in routes/trips.ts or in
 * server/trips/readRoutes/tripProjections.ts — both of which IMPORT the
 * constant — is a blind spot the live column check cannot resolve, and both
 * sites were reported as exactly that. Worse, each had wrapped the select in a
 * `(columns: string) => …` helper, so the list was a parameter and not even a
 * cross-file identifier.
 *
 * Selecting through the constants in the file that DEFINES them makes both
 * lists statically resolvable, so every column in them is checked against the
 * live schema on every run. That matters more here than it looks: a select
 * list naming a column that does not exist fails the WHOLE read with PGRST100,
 * so an unchecked twenty-one-column list is an itinerary that disappears.
 *
 * The alternative was inlining the literal at both sites, which would put two
 * more copies of that list in the tree — the drift this constant exists to
 * prevent.
 *
 * `onFallback` is the caller's own log line. The two readers word it
 * differently on purpose — one is serving a plan, the other a timeline — and a
 * shared message would tell an operator the wrong route degraded.
 */
export async function readPlanItemsInOrder(
  client: any,
  tripId: string,
  onFallback: () => void,
): Promise<{ data: any[] | null; error: any }> {
  const ordered = (q: any) =>
    q
      .eq("trip_id", tripId)
      .is("removed_at", null)
      .order("day_date", { ascending: true, nullsFirst: false })
      .order("starts_at", { ascending: true, nullsFirst: false })
      .order("sort_order", { ascending: true });

  // §6.3's scope is read WITH the rest (2770, census-trips TR116), and its
  // absence must not cost the caller their itinerary: on a database without
  // 2770 the whole list would otherwise 500 on one unknown column. One retry
  // without it, and `privacyScope` then comes back null — NOT READ, which
  // toCamel documents and does not turn into a scope.
  let { data, error } = await ordered(
    client.from("trip_plan_items").select(PLAN_ITEM_COLUMNS),
  );
  if (error && isMissingColumnError(error)) {
    onFallback();
    ({ data, error } = await ordered(
      client.from("trip_plan_items").select(PLAN_ITEM_COLUMNS_BASE),
    ));
  }
  return { data: (data as any[]) ?? null, error };
}

// ── Viewer-based privacy filter ───────────────────────────────────────────────

export function filterPlanItemForViewer(row: Record<string, any>): {
  lat: number | null;
  lng: number | null;
  locationIsPrivate: boolean;
} {
  const locationIsPrivate = row.location_is_private ?? true;
  return {
    lat: locationIsPrivate ? null : (row.lat ?? null),
    lng: locationIsPrivate ? null : (row.lng ?? null),
    locationIsPrivate,
  };
}

// ── snake_case → camelCase row mapper ────────────────────────────────────────

function toCamel(row: Record<string, any>, opts: { stripCoords?: boolean; warnings?: string[] } = {}) {
  const coords = opts.stripCoords
    ? { lat: null, lng: null, locationIsPrivate: row.location_is_private ?? true }
    : filterPlanItemForViewer(row);
  return {
    id: row.id,
    tripId: row.trip_id,
    creatorId: row.creator_id,
    title: row.title,
    category: row.category,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id ?? null,
    dayDate: row.day_date ?? null,
    startsAt: row.starts_at ?? null,
    endsAt: row.ends_at ?? null,
    locationName: row.location_name ?? null,
    notes: row.notes ?? null,
    sortOrder: row.sort_order,
    visibility: row.visibility,
    /**
     * §6.3's six-value scope (2770, census-trips TR116).
     *
     * `null` means NOT READ — either the row came from a select that did not
     * name the column, or this database does not have 2770 yet. It does NOT
     * mean `crew`: deriving a scope from `visibility` here would tell a client
     * that a plan it cannot see the scope of is crew-wide, which is the one
     * answer a privacy field must never invent. `privacyScopeFromVisibility`
     * exists for a caller that has actually read `visibility` and wants the
     * pre-2770 mapping; it is deliberately not applied here.
     */
    privacyScope: row.privacy_scope ?? null,
    lockType: row.lock_type ?? "flexible",
    ...coords,
    warnings: opts.warnings ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { toCamel };
export default router;
