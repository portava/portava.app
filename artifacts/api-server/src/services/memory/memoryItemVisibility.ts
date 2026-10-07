/**
 * memoryItemVisibility — §10 "Media visibility is independent from Memory
 * visibility", for the API server's readers (migration 3672). Census H80.
 *
 * `memory_items.visibility` is NULL (the photo inherits its Memory's audience)
 * or 'only_me' (the owner's alone). A reader that serves a photo — its URL or
 * its caption — to anyone but the Memory's owner asks `hiddenItemKeys` first
 * and drops every hidden one.
 *
 * WHY A SEPARATE READ, NOT A WIDER SELECT. Every existing item read stays
 * byte-identical, so a database without 3672 is served exactly as today. The
 * hidden set is a second, narrow query:
 *   - the column does not exist (3672 not applied: 42703 / PGRST204 naming
 *     `visibility`): no photo can be hidden, so the set is empty — TRUE;
 *   - any other failure: `ok: false`, and the caller REFUSES the read rather
 *     than serving photos it could not check (fail closed).
 * The owner never needs the read: the owner sees every photo.
 *
 * Items are keyed by `${memory_id}#${position}` because every reader in
 * routes/memories.ts selects those two, and the cover reads select no id.
 */
export const HIDDEN_ITEM_VISIBILITY = "only_me";

export type HiddenItems = { ok: true; keys: ReadonlySet<string> } | { ok: false; detail: string };

export const itemKey = (memoryId: unknown, position: unknown): string => `${String(memoryId)}#${String(position)}`;

/** The column is not deployed — and only that. A missing TABLE is not this. */
function visibilityColumnAbsent(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? "");
  return (code === "42703" || code === "PGRST204") && /visibility/.test(message);
}

/**
 * The hidden (only_me) items among these Memories, for a reader who is NOT the
 * owner of every one of them. Chunked so a page of Memories cannot outgrow a URL.
 */
export async function hiddenItemKeys(sc: any, memoryIds: readonly string[]): Promise<HiddenItems> {
  const ids = [...new Set(memoryIds)];
  const keys = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const { data, error } = await sc
        .from("memory_items")
        .select("memory_id, position")
        .in("memory_id", batch)
        .eq("visibility", HIDDEN_ITEM_VISIBILITY);
      if (error) {
        if (visibilityColumnAbsent(error)) return { ok: true, keys: new Set() };
        return { ok: false, detail: String((error as { message?: unknown }).message ?? "memory_items unreadable") };
      }
      if (!Array.isArray(data)) return { ok: false, detail: "memory_items returned no row array" };
      for (const r of data as Array<{ memory_id: string; position: number }>) keys.add(itemKey(r.memory_id, r.position));
    } catch (err) {
      return { ok: false, detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  return { ok: true, keys };
}

/** Set or clear a photo's own audience. Owner-checked by the caller. */
export async function setItemVisibility(
  sc: any,
  input: { memoryId: string; itemId: string; visibility: typeof HIDDEN_ITEM_VISIBILITY | null },
): Promise<{ ok: true } | { ok: false; reason: "not_deployed" | "not_found" | "unavailable"; detail: string }> {
  const { data, error } = await sc
    .from("memory_items")
    .update({ visibility: input.visibility })
    .eq("id", input.itemId)
    .eq("memory_id", input.memoryId)
    .select("id");
  if (error) {
    if (visibilityColumnAbsent(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "") };
    return { ok: false, reason: "unavailable", detail: String(error.message ?? "") };
  }
  if (!Array.isArray(data) || data.length !== 1) return { ok: false, reason: "not_found", detail: "no such photo on this Memory" };
  return { ok: true };
}
