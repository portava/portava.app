import { Router } from "express";
import { provenanceStamp } from "../lib/placeProvenance.js";
import { z } from "zod";
import { logger as rootLogger } from "../lib/logger.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { patchOsmSavedCount } from "./discovery.js";

const wishlistLogger = rootLogger.child({ route: "wishlist" });

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

  // Non-blocking — wishlist save already committed; failures are logged, never thrown.
  const name       = typeof placeData["name"]     === "string" ? placeData["name"]     : osmId;
  const category   = typeof placeData["category"] === "string" ? placeData["category"] : "places";
  const placeType  = typeof placeData["type"]     === "string" ? placeData["type"]     : null;
  const lat        = typeof placeData["lat"]       === "number" ? placeData["lat"]       : null;
  const lng        = typeof placeData["lng"]       === "number" ? placeData["lng"]       : null;

  // Step 1: Ensure a discovery_places row exists for this OSM place.
  // ignoreDuplicates: true = INSERT ... ON CONFLICT DO NOTHING, so existing
  // rows (with their accumulated saved_count) are never overwritten.
  const { error: upsertError } = await svc
    .from("discovery_places")
    .upsert(
      {
        osm_id:     osmId,
        name,
        city:       "",           // OSM rows track popularity only; city="" keeps them out of city-filtered queries
        place_type: placeType ?? "place",
        category,
        source:     "osm",

        // Written as an explicit key rather than `...(await provenanceStamp(…))`.
        // The spread made this payload statically unresolvable, so
        // check:write-path-columns could not verify ANY column here against the
        // live schema — the site was a blind spot, and the check fails on new
        // blind spots by design. provenanceStamp can only ever contribute
        // source_id ({ source_id } or {}), and source_id is nullable with no
        // default, so writing NULL is equivalent to omitting the key.
        source_id:  (await provenanceStamp(svc, "osm")).source_id ?? null,
        status:     "active",
        saved_count: 0,
        lat,
        lng,
      },
      { onConflict: "osm_id", ignoreDuplicates: true },
    );
  if (upsertError) {
    wishlistLogger.warn({ err: upsertError, osmId }, "trackOsmPlaceSave: discovery_places upsert failed (non-blocking)");
    return;
  }

  // Step 2: Look up the UUID assigned to this OSM place.
  const { data: dpRow, error: lookupError } = await svc
    .from("discovery_places")
    .select("id, saved_count")
    .eq("osm_id", osmId)
    .maybeSingle();

  if (lookupError) {
    wishlistLogger.warn({ err: lookupError, osmId }, "trackOsmPlaceSave: discovery_places lookup failed (non-blocking)");
    return;
  }
  if (!dpRow) return;

  // Step 3 (atomic): Record the per-user save.  The INSERT ... ON CONFLICT
  // DO NOTHING is evaluated atomically by PostgreSQL — exactly one of any
  // concurrent requests for the same (user_id, place_id) pair will see a
  // non-empty return; all others receive an empty array.  We only increment
  // saved_count when our INSERT actually created a new row, eliminating the
  // SELECT-then-INSERT race that could double-count concurrent saves.
  const { data: newSaveRows, error: saveError } = await svc
    .from("discovery_place_saves")
    .upsert(
      { user_id: userId, place_id: (dpRow as any).id },
      { onConflict: "user_id,place_id", ignoreDuplicates: true },
    )
    .select("place_id");
  if (saveError) {
    wishlistLogger.warn({ err: saveError, osmId }, "trackOsmPlaceSave: save record upsert failed (non-blocking)");
    return;
  }

  if (newSaveRows && newSaveRows.length > 0) {
    // A brand-new row was inserted — safe to increment.
    const newCount = ((dpRow as any).saved_count ?? 0) + 1;
    const { error: countError } = await svc
      .from("discovery_places")
      .update({ saved_count: newCount })
      .eq("id", (dpRow as any).id);
    if (countError) {
      wishlistLogger.warn({ err: countError, osmId }, "trackOsmPlaceSave: saved_count update failed (non-blocking)");
      return;
    }
    // Patch the in-memory discovery cache so the popular sort reflects the
    // new count on the very next request without waiting for the 2-hour TTL.
    patchOsmSavedCount(osmId, newCount);
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

  // Non-blocking — failures are logged, never thrown.
  {
    // Step 1: Look up the discovery_places row.  If it doesn't exist the
    // place was never saved via the tracking path — nothing to decrement.
    const { data: dpRow, error: lookupError } = await svc
      .from("discovery_places")
      .select("id, saved_count")
      .eq("osm_id", osmId)
      .maybeSingle();
    if (lookupError) {
      wishlistLogger.warn({ err: lookupError, osmId }, "trackOsmPlaceUnsave: discovery_places lookup failed (non-blocking)");
      return;
    }
    if (!dpRow) return;

    // Step 2: Check whether any other wishlist entries remain for this user
    // and place (the DELETE route already removed the targeted list entry).
    // If other lists/trips still hold the place, the user still wants it
    // saved — no decrement yet.
    const { data: remaining, error: remainingError } = await svc
      .from("wishlist_places")
      .select("place_id")
      .eq("user_id", userId)
      .eq("place_id", osmId)
      .limit(1);
    if (remainingError) {
      wishlistLogger.warn({ err: remainingError, osmId }, "trackOsmPlaceUnsave: remaining-entries check failed (non-blocking)");
      return;
    }
    if (Array.isArray(remaining) && remaining.length > 0) return;

    // Step 3 (atomic): Delete the per-user save record and return the deleted
    // row.  PostgreSQL guarantees that for any given (user_id, place_id) row,
    // exactly one concurrent DELETE will return a non-empty result — the
    // "winner" owns the decrement; all other concurrent calls see an empty
    // array and skip the count update.  This eliminates the race where two
    // concurrent same-user unsave calls both see the record, both attempt to
    // delete (one silently deletes 0 rows with no error), and both decrement.
    //
    // If the user never saved this place (no save record exists), the DELETE
    // returns empty — safely guarding against count manipulation without a
    // separate pre-flight SELECT.
    const { data: deletedRows, error: deleteError } = await svc
      .from("discovery_place_saves")
      .delete()
      .eq("user_id", userId)
      .eq("place_id", (dpRow as any).id)
      .select("place_id");
    if (deleteError) {
      wishlistLogger.warn({ err: deleteError, osmId }, "trackOsmPlaceUnsave: save record delete failed (non-blocking)");
      return;
    }

    if (deletedRows && deletedRows.length > 0) {
      // Atomically decrement saved_count using a DB function that evaluates
      // GREATEST(0, saved_count - 1) inside PostgreSQL's own transaction.
      // Unlike computing newCount = snapshot - 1 in Node and then SET-ing
      // an absolute value, this form is immune to the stale-snapshot race
      // where two concurrent different-user unsaves both read the same
      // saved_count and both overwrite the DB with snapshot-1.
      const { data: newCount, error: rpcError } = await svc.rpc(
        "decrement_discovery_place_saved_count",
        { p_id: (dpRow as any).id },
      );
      if (rpcError) {
        wishlistLogger.warn({ err: rpcError, osmId }, "trackOsmPlaceUnsave: decrement rpc failed (non-blocking)");
      }
      // Patch the in-memory discovery cache so the popular sort reflects the
      // decremented count immediately.  Prefer the value returned by the RPC;
      // fall back to a best-effort approximation if it is not numeric.
      patchOsmSavedCount(
        osmId,
        typeof newCount === "number"
          ? newCount
          : Math.max(0, ((dpRow as any).saved_count ?? 1) - 1),
      );
    }
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
