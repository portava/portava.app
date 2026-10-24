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
/** PostgREST's max-rows on Supabase. A read that returns this many may be truncated. */
export const ITEM_PAGE = 1000;

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
      // A FULL page may be truncated (PostgREST max-rows): the keys past it would
      // be missing, and a missing key SERVES the photo. Fail closed instead.
      if (data.length >= ITEM_PAGE) return { ok: false, detail: `memory_items hidden-photo page full (${data.length} rows): refusing rather than serving photos past it` };
      for (const r of data as Array<{ memory_id: string; position: number }>) keys.add(itemKey(r.memory_id, r.position));
    } catch (err) {
      return { ok: false, detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  return { ok: true, keys };
}

/** The pre-3912 direct write: the kernel-off legacy arm and the pre-3912 compat arm of `setItemVisibility` (below). Owner-checked by the caller. */
export async function writeItemVisibilityDirect(
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

// ── census-highlights-memories §CC (3912): the switch through the §17 kernel ──
// Appended at the foot so no cited line above moves. Before, the owner's switch
// was the direct UPDATE above, with no event: a photo hidden after a public
// derivative was built was never re-derived. It now dispatches
// CHANGE_ITEM_VISIBILITY, whose write and `memory.visibility_changed` are one
// transaction (3912). Kernel OFF: the direct write, unaudited, byte-identical.
// A kernel without the command (2711 / 3911) answers MEMORY_COMMAND_UNKNOWN_TYPE,
// and the direct write runs exactly as before 3912 — the compat arm.
import { dispatchMemoryCommand } from "./MemoryDomainService.js";

export type ItemVisibilityWrite =
  | { ok: true }
  | { ok: false; reason: "not_deployed" | "not_found" | "unavailable" | "invalid_payload"; detail: string };

export async function setItemVisibility(
  sc: any,
  input: {
    memoryId: string; itemId: string; visibility: typeof HIDDEN_ITEM_VISIBILITY | null;
    actorUserId: string; idempotencyKey: string; kernelEnvelopeError?: string | null;
  },
): Promise<ItemVisibilityWrite> {
  const direct = () => writeItemVisibilityDirect(sc, input);
  const outcome = await dispatchMemoryCommand<{ ok: true }>({
    sc,
    commandType: "CHANGE_ITEM_VISIBILITY",
    memoryId: input.memoryId,
    actorUserId: input.actorUserId,
    idempotencyKey: input.idempotencyKey,
    kernelEnvelopeError: input.kernelEnvelopeError ?? null,
    legacyUnaudited: true,
    payload: { item_id: input.itemId, item_visibility: input.visibility },
    fromKernelResult: () => ({ ok: true }),
    legacy: async () => {
      const r = await direct();
      return r.ok ? { ok: true, body: { ok: true } } : { ok: false, http: { code: r.reason, message: r.detail } };
    },
  });
  if (outcome.ok) return { ok: true };
  if ("http" in outcome) {
    const code = outcome.http.code;
    const reason = code === "not_deployed" || code === "not_found" || code === "invalid_payload" ? code : "unavailable";
    return { ok: false, reason, detail: outcome.http.message };
  }
  switch (outcome.rejection.reason) {
    case "MEMORY_COMMAND_UNKNOWN_TYPE": return direct(); // pre-3912 kernel: the pre-3912 write
    case "MEMORY_ITEM_NOT_FOUND":
    case "MEMORY_NOT_FOUND":
    case "MEMORY_AUTH_NOT_OWNER": return { ok: false, reason: "not_found", detail: outcome.rejection.reason };
    default: return { ok: false, reason: "unavailable", detail: `${outcome.rejection.reason}${outcome.rejection.detail ? `: ${outcome.rejection.detail}` : ""}` };
  }
}
