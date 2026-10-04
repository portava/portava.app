/**
 * viewerSavedReads — the viewer's own saved state, read WHOLE or not at all.
 *
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's B44).
 *
 * Three Discovery answers decide "have I saved this?" from the viewer's collections: every events list and the event
 * screen (`viewerSavedEventIds`, routes/events.ts), and GET /discovery/community. Each read the viewer's `collections`
 * with one unbounded read and then the `collection_items` of those collections with another; GET
 * /discovery/community/saved-ids read `discovery_place_saves` the same way. PostgREST cuts a response at db-max-rows
 * (1000 on this deployment) and reports nothing, so past the cap the answer was computed from a prefix of the set and
 * served as measured: an item the viewer had saved in a collection past the cut was `isSaved: false`.
 *
 * The rule here is `lib/feedReads.ts`'s (census-media §47): a set is read whole, by key, and a read that cannot be read
 * whole is a FAILURE the caller names, never the rows it happened to get. Each read is first made the plain way with
 * an exact count, so a set under the cap still costs one request; only when the count says rows were left out is it
 * read again by key until none remain.
 *
 * The viewer's collection ids are consulted in chunks (`COLLECTION_ID_CHUNK`): one `in.(…)` filter holding every id of
 * a viewer with a thousand collections is a request line no gateway accepts, which would turn "saved somewhere past the
 * cap" into "the read failed" for exactly the viewers this fixes.
 */
import { readWhole, afterKey, type ReadIssue } from "./feedReads.js";

/** Collection ids per `collection_items` request. 50 uuids is under 2 kB of query string. */
export const COLLECTION_ID_CHUNK = 50;

/** The entity kinds a Discovery answer asks about. `collection_items.entity_type` holds more. */
export type SavedEntityType = "event" | "place";

/** The saved ids, or which read left them unknown. */
export type SavedIdsRead =
  | { ok: true; ids: Set<string> }
  | { ok: false; source: "collections" | "collection_items"; error: ReadIssue };

function thrown(e: unknown): ReadIssue {
  return { message: String((e as { message?: unknown } | null | undefined)?.message ?? e ?? "read threw") };
}

/**
 * Which of `entityIds` sit in ANY collection `ownerId` owns.
 *
 * `{ ok: false, source }` when the collections list, or any chunk of their items, failed, threw, or could not be read
 * whole. The caller serves the state as unknown (`null`) or refuses; it never serves "not saved" over this.
 */
export async function viewerCollectionSavedIds(
  sc: any,
  ownerId: string,
  entityType: SavedEntityType,
  entityIds: readonly string[],
): Promise<SavedIdsRead> {
  const ids = [...new Set(entityIds)];
  const saved = new Set<string>();
  if (ids.length === 0) return { ok: true, ids: saved };

  let collectionIds: string[];
  try {
    const base = () => sc.from("collections").select("id", { count: "exact" }).eq("owner_id", ownerId);
    const cols = await readWhole<{ id: unknown }>(
      (after, size) => afterKey(base().order("id", { ascending: true }).limit(size), "id", after),
      (r) => String(r.id),
      { first: base },
    );
    if (!cols.ok) return { ok: false, source: "collections", error: cols.error };
    collectionIds = cols.value.map((c) => String(c.id));
  } catch (e) {
    return { ok: false, source: "collections", error: thrown(e) };
  }
  if (collectionIds.length === 0) return { ok: true, ids: saved };

  try {
    for (let i = 0; i < collectionIds.length; i += COLLECTION_ID_CHUNK) {
      const chunk = collectionIds.slice(i, i + COLLECTION_ID_CHUNK);
      const base = () => sc
        .from("collection_items")
        .select("id, entity_id", { count: "exact" })
        .eq("entity_type", entityType)
        .in("collection_id", chunk)
        .in("entity_id", ids);
      const items = await readWhole<{ id: unknown; entity_id: unknown }>(
        (after, size) => afterKey(base().order("id", { ascending: true }).limit(size), "id", after),
        (r) => String(r.id),
        { first: base },
      );
      if (!items.ok) return { ok: false, source: "collection_items", error: items.error };
      for (const r of items.value) saved.add(String(r.entity_id));
    }
  } catch (e) {
    return { ok: false, source: "collection_items", error: thrown(e) };
  }
  return { ok: true, ids: saved };
}

/**
 * Every community place `userId` has saved (`discovery_place_saves.place_id`), whole. The table is unique on
 * `(user_id, place_id)`, so `place_id` keys the viewer's rows. A failed or cut read is `{ ok: false }`.
 */
export async function viewerSavedPlaceIds(sc: any, userId: string): Promise<{ ok: true; ids: string[] } | { ok: false; error: ReadIssue }> {
  try {
    const base = () => sc.from("discovery_place_saves").select("place_id", { count: "exact" }).eq("user_id", userId);
    const rows = await readWhole<{ place_id: unknown }>(
      (after, size) => afterKey(base().order("place_id", { ascending: true }).limit(size), "place_id", after),
      (r) => String(r.place_id),
      { first: base },
    );
    if (!rows.ok) return { ok: false, error: rows.error };
    return { ok: true, ids: rows.value.map((r) => String(r.place_id)) };
  } catch (e) {
    return { ok: false, error: thrown(e) };
  }
}
