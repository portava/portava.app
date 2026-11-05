/**
 * Take an item out of every collection its owner filed it in.
 *
 * A post can be saved in two places at once: post_saves (the Saved tab and the
 * post's save count) and collection_items (a collection picked with "Save to
 * collection"). Only DELETE /saves cleared the second, so unsaving a post from
 * Watch (DELETE /media/:id/save) or from the post itself (DELETE
 * /posts/:id/save) left it listed in the collection, still saved to the person
 * looking at it. Every unsave of a post now goes through here first.
 *
 * The collection read is bound: a failed read is "could not unsave", never
 * "nothing to remove", so nothing is half-removed on a bad read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type UnfileResult = { ok: true; removedFrom: number } | { ok: false; error: string };

export async function removeFromOwnCollections(
  sc: SupabaseClient,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<UnfileResult> {
  const { data: cols, error: readErr } = await sc.from("collections").select("id").eq("owner_id", userId);
  if (readErr) return { ok: false, error: readErr.message };
  const colIds = (cols ?? []).map((c: { id: string }) => c.id);
  if (colIds.length === 0) return { ok: true, removedFrom: 0 };
  const { error: delErr } = await sc
    .from("collection_items")
    .delete()
    .in("collection_id", colIds)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId);
  if (delErr) return { ok: false, error: delErr.message };
  return { ok: true, removedFrom: colIds.length };
}
