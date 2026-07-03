import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { patchOsmSavedCount } from "./discovery.js";

const router = Router();

/**
 * Matches Overpass OSM element IDs used as place IDs in the Discovery API.
 * Examples: "node/12345678", "way/987654", "relation/42"
 */
const OSM_ID_RE = /^(node|way|relation)\/\d+$/;

/**
 * Track a save for an OSM place in discovery_places so that the popular sort
 * can use real save counts instead of relying solely on the OSM rating field.
 *
 * On first save:  upserts a lightweight discovery_places row (source="osm") and
 *                 records the user in discovery_place_saves.
 * On repeat save: the discovery_place_saves upsert is a no-op (onConflict), so
 *                 saved_count is only incremented once per unique user.
 *
 * Failures are non-blocking — the wishlist upsert already succeeded when this
 * is called, so we log and return without surfacing an error to the client.
 */
export async function trackOsmPlaceSave(
  userId: string,
  osmId: string,
  placeData: Record<string, unknown>,
): Promise<void> {
  const svc = getServiceClient();
  if (!svc) return;

  try {
    const name       = typeof placeData["name"]     === "string" ? placeData["name"]     : osmId;
    const category   = typeof placeData["category"] === "string" ? placeData["category"] : "places";
    const placeType  = typeof placeData["type"]     === "string" ? placeData["type"]     : null;
    const lat        = typeof placeData["lat"]       === "number" ? placeData["lat"]       : null;
    const lng        = typeof placeData["lng"]       === "number" ? placeData["lng"]       : null;

    // Step 1: Ensure a discovery_places row exists for this OSM place.
    // ignoreDuplicates: true = INSERT ... ON CONFLICT DO NOTHING, so existing
    // rows (with their accumulated saved_count) are never overwritten.
    await svc
      .from("discovery_places")
      .upsert(
        {
          osm_id:     osmId,
          name,
          city:       "",           // OSM rows track popularity only; city="" keeps them out of city-filtered queries
          place_type: placeType ?? "place",
          category,
          source:     "osm",
          status:     "active",
          saved_count: 0,
          lat,
          lng,
        },
        { onConflict: "osm_id", ignoreDuplicates: true },
      );

    // Step 2: Look up the UUID assigned to this OSM place.
    const { data: dpRow } = await svc
      .from("discovery_places")
      .select("id, saved_count")
      .eq("osm_id", osmId)
      .maybeSingle();

    if (!dpRow) return;

    // Step 3 (atomic): Record the per-user save.  The INSERT ... ON CONFLICT
    // DO NOTHING is evaluated atomically by PostgreSQL — exactly one of any
    // concurrent requests for the same (user_id, place_id) pair will see a
    // non-empty return; all others receive an empty array.  We only increment
    // saved_count when our INSERT actually created a new row, eliminating the
    // SELECT-then-INSERT race that could double-count concurrent saves.
    const { data: newSaveRows } = await svc
      .from("discovery_place_saves")
      .upsert(
        { user_id: userId, place_id: (dpRow as any).id },
        { onConflict: "user_id,place_id", ignoreDuplicates: true },
      )
      .select("place_id");

    if (newSaveRows && newSaveRows.length > 0) {
      // A brand-new row was inserted — safe to increment.
      const newCount = ((dpRow as any).saved_count ?? 0) + 1;
      await svc
        .from("discovery_places")
        .update({ saved_count: newCount })
        .eq("id", (dpRow as any).id);
      // Patch the in-memory discovery cache so the popular sort reflects the
      // new count on the very next request without waiting for the 2-hour TTL.
      patchOsmSavedCount(osmId, newCount);
    }
  } catch {
    // Non-blocking — wishlist save already committed
  }
}

/**
 * Decrement saved_count for an OSM place when the user removes their last
 * wishlist entry for it.
 *
 * Safety properties:
 * 1. We confirm the user actually has a discovery_place_saves record before
 *    touching saved_count.  Without this guard, any authenticated user could
 *    call DELETE /wishlist/:osmId repeatedly and drive any place's popularity
 *    to zero.
 * 2. We check that no other wishlist entries (other lists/trips) remain for
 *    this user before decrementing — the user may still want the place saved.
 * 3. The UPDATE uses .gt("saved_count", 0) so a race between concurrent
 *    unsave calls cannot push the count below zero.
 */
export async function trackOsmPlaceUnsave(
  userId: string,
  osmId: string,
): Promise<void> {
  const svc = getServiceClient();
  if (!svc) return;

  try {
    // Step 1: Look up the discovery_places row.  If it doesn't exist the
    // place was never saved via the tracking path — nothing to decrement.
    const { data: dpRow } = await svc
      .from("discovery_places")
      .select("id, saved_count")
      .eq("osm_id", osmId)
      .maybeSingle();
    if (!dpRow) return;

    // Step 2: Confirm this user has a save record.  This is the primary
    // guard against manipulation: if no record exists (user never saved, or
    // already decremented) we return immediately without touching counts.
    const { data: saveRecord } = await svc
      .from("discovery_place_saves")
      .select("place_id")
      .eq("user_id", userId)
      .eq("place_id", (dpRow as any).id)
      .maybeSingle();
    if (!saveRecord) return;

    // Step 3: Check whether any other wishlist entries remain for this user
    // and place (the DELETE route already removed the targeted list entry).
    // If other lists/trips still hold the place, the user still wants it
    // saved — no decrement yet.
    const { data: remaining } = await svc
      .from("wishlist_places")
      .select("place_id")
      .eq("user_id", userId)
      .eq("place_id", osmId)
      .limit(1);
    if (Array.isArray(remaining) && remaining.length > 0) return;

    // Step 4: Remove the per-user save record.  If this delete fails for any
    // reason (concurrent call already removed it) we skip the count update.
    const { error: delErr } = await svc
      .from("discovery_place_saves")
      .delete()
      .eq("user_id", userId)
      .eq("place_id", (dpRow as any).id);

    if (!delErr) {
      // .gt("saved_count", 0) ensures a concurrent unsave cannot push the
      // count negative — the UPDATE becomes a no-op if the race is lost.
      const newCount = Math.max(0, ((dpRow as any).saved_count ?? 1) - 1);
      await svc
        .from("discovery_places")
        .update({ saved_count: newCount })
        .eq("id", (dpRow as any).id)
        .gt("saved_count", 0);
      // Patch the in-memory discovery cache so the popular sort reflects the
      // decremented count immediately.
      patchOsmSavedCount(osmId, newCount);
    }
  } catch {
    // Non-blocking
  }
}

// GET /api/wishlist[?list=<listId>]
// Returns all saved places for the authenticated user, optionally filtered by
// list_id.  The response shape mirrors BookmarkedPlace so the mobile client can
// use it directly without transformation.
router.get("/wishlist", async (req, res) => {
  const sc = await requireUser(req, res);
  if (!sc) return;

  const listId = typeof req.query["list"] === "string" ? req.query["list"] : null;

  let query = sc.client
    .from("wishlist_places")
    .select("place_id, place_data, list_id, saved_at")
    .eq("user_id", sc.user.id)
    .order("saved_at", { ascending: false });

  if (listId) {
    query = (query as any).eq("list_id", listId);
  }

  const { data, error } = await (query as any);

  if (error) {
    sendError(res, "db_error", (error as { message: string }).message);
    return;
  }

  const places = ((data ?? []) as Array<{ place_data: object; saved_at: string }>).map((row) => ({
    ...(row.place_data as object),
    savedAt: new Date(row.saved_at).getTime(),
  }));

  res.json({ places });
});

// POST /api/wishlist
// Upserts a saved place (idempotent — safe to call multiple times).
const SaveBodySchema = z.object({
  placeId:   z.string().min(1),
  placeData: z.record(z.unknown()),
  listId:    z.string().min(1).default("global"),
});

router.post("/wishlist", async (req, res) => {
  const sc = await requireUser(req, res);
  if (!sc) return;

  const parsed = SaveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.message);
    return;
  }

  const { placeId, placeData, listId } = parsed.data;

  const { error } = await sc.client.from("wishlist_places").upsert(
    {
      user_id:    sc.user.id,
      place_id:   placeId,
      place_data: placeData,
      list_id:    listId,
      saved_at:   new Date().toISOString(),
    },
    { onConflict: "user_id,place_id,list_id" },
  );

  if (error) {
    sendError(res, "db_error", (error as { message: string }).message);
    return;
  }

  // Track save counts for OSM places so the popular sort reflects real interest.
  // Runs after a successful wishlist upsert; failures are non-blocking.
  if (OSM_ID_RE.test(placeId)) {
    void trackOsmPlaceSave(sc.user.id, placeId, placeData);
  }

  res.status(201).json({ ok: true });
});

// DELETE /api/wishlist/:placeId[?list=<listId>]
// Removes a specific place from the wishlist.  If ?list is omitted all list
// entries for that place_id are removed.
router.delete("/wishlist/:placeId", async (req, res) => {
  const sc = await requireUser(req, res);
  if (!sc) return;

  const placeId = req.params["placeId"];
  const listId  = typeof req.query["list"] === "string" ? req.query["list"] : null;

  let query = sc.client
    .from("wishlist_places")
    .delete()
    .eq("user_id", sc.user.id)
    .eq("place_id", placeId);

  if (listId) {
    query = (query as any).eq("list_id", listId);
  }

  const { error } = await (query as any);

  if (error) {
    sendError(res, "db_error", (error as { message: string }).message);
    return;
  }

  // Decrement saved_count for OSM places when the user removes their save.
  // The helper checks for remaining wishlist entries before decrementing.
  if (OSM_ID_RE.test(placeId)) {
    void trackOsmPlaceUnsave(sc.user.id, placeId);
  }

  res.json({ ok: true });
});

// DELETE /api/wishlist  — clear ALL saved places for the user
router.delete("/wishlist", async (req, res) => {
  const sc = await requireUser(req, res);
  if (!sc) return;

  const { error } = await sc.client
    .from("wishlist_places")
    .delete()
    .eq("user_id", sc.user.id);

  if (error) {
    sendError(res, "db_error", (error as { message: string }).message);
    return;
  }

  res.json({ ok: true });
});

export default router;
