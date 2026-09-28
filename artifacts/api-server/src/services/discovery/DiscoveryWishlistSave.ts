/**
 * DiscoveryWishlistSave — the ONE write path for "save this Discovery place".
 *
 * census-discovery A21 (§56.4, §56.9 Q4, §81; register D-W10S2-5). The shared
 * Discovery card's Save button calls `POST /api/wishlist` (Discovery's bookmark
 * sync, `travel-buddy-standalone/src/services/discoveryBookmarks.ts`), and that
 * route wrote `wishlist_places` inline. A Telegraph action on the same object
 * must perform the SAME canonical write through the owning domain — Telegraph
 * spec §30A.11 *"tap -> command -> owning domain authorization/write"* — and a
 * second inline upsert in Telegraph would be a second writer of Discovery's
 * truth. So the write moved here, unchanged, and both callers use it:
 *
 *   POST /api/wishlist                 (routes/wishlist.ts)
 *   Telegraph `discovery_save_place`   (services/telegraph/actionRegistry.ts)
 *
 * The row, its conflict key and its payload are byte-for-byte what the route
 * wrote. The popularity side effect for an OSM place (`trackOsmPlaceSave`,
 * non-blocking, after a successful write) stays the route's own hook and is
 * run for the Telegraph caller through the same exported function, so a save
 * counts the same whichever door it came through.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Overpass element ids Discovery serves as place ids (`node/123`, `way/9`, `relation/4`). */
export const DISCOVERY_OSM_PLACE_ID = /^(node|way|relation)\/\d+$/;

export interface DiscoveryPlaceSave {
  placeId: string;
  placeData: Record<string, unknown>;
  listId: string;
}

export type DiscoveryPlaceSaveResult =
  | { ok: true; created: boolean | null }
  | { ok: false; message: string };

/**
 * Upsert the save. `detectCreated` reads the row first so a caller that must
 * be able to UNDO exactly its own write (Telegraph's compensate) knows whether
 * the save already existed; the route does not ask, and makes no extra read.
 */
export async function saveDiscoveryPlace(
  client: SupabaseClient,
  userId: string,
  save: DiscoveryPlaceSave,
  opts: { detectCreated?: boolean; trackOsm?: (userId: string, osmId: string, placeData: Record<string, unknown>) => Promise<void> } = {},
): Promise<DiscoveryPlaceSaveResult> {
  let created: boolean | null = null;
  if (opts.detectCreated) {
    const prior = await client
      .from("wishlist_places")
      .select("place_id")
      .eq("user_id", userId)
      .eq("place_id", save.placeId)
      .eq("list_id", save.listId)
      .maybeSingle();
    if (prior.error) return { ok: false, message: String(prior.error.message ?? "wishlist_places unreadable") };
    created = !prior.data;
  }
  const { error } = await client.from("wishlist_places").upsert(
    {
      user_id:    userId,
      place_id:   save.placeId,
      place_data: save.placeData,
      list_id:    save.listId,
      saved_at:   new Date().toISOString(),
    },
    { onConflict: "user_id,place_id,list_id" },
  );
  if (error) return { ok: false, message: String((error as { message?: string }).message ?? "wishlist_places write failed") };
  if (opts.trackOsm && DISCOVERY_OSM_PLACE_ID.test(save.placeId)) void opts.trackOsm(userId, save.placeId, save.placeData);
  return { ok: true, created };
}

/** Remove one save from one list. The route's DELETE and Telegraph's compensate both mean this. */
export async function unsaveDiscoveryPlace(
  client: SupabaseClient,
  userId: string,
  placeId: string,
  listId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await client
    .from("wishlist_places")
    .delete()
    .eq("user_id", userId)
    .eq("place_id", placeId)
    .eq("list_id", listId);
  if (error) return { ok: false, message: String((error as { message?: string }).message ?? "wishlist_places delete failed") };
  return { ok: true };
}
