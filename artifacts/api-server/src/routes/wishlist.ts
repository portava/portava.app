import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";

const router = Router();

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
