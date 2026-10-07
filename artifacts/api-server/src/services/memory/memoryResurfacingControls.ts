/**
 * memoryResurfacingControls — §11's user controls on a MEMORY (migration 3671,
 * `memory_resurfacing_preferences`). Census H36, H87, H88, H187.
 *
 * The controls on a Highlight (2720) existed; a Memory had none, so "keep this
 * Memory private forever" could not be said about the Memory itself — only
 * about each Highlight someone remembered to make from it.
 *
 * VOCABULARY. The four Memory-scoped names of 2720, verbatim
 * (services/highlights/highlightResurfacing.ts RESURFACING_CONTROLS). Their
 * surface effects are that file's CONTROL_EFFECTS; this module does not restate
 * them.
 *
 * READS FAIL CLOSED. `readMemoryControls` answers in three states:
 *   ok         the controls, read
 *   absent     3671 is not applied (42P01 / PGRST205 only): no row can exist,
 *              so "no control is set" is TRUE
 *   unreadable anything else — every consumer must treat the Memory as carrying
 *              KEEP_PRIVATE_FOREVER on the surfaces it guards
 *
 * CONSUMERS IN THIS TREE (each fails closed):
 *   - PATCH /memories/:id refuses to widen a KEEP_PRIVATE_FOREVER Memory
 *     beyond `only_me` (`refuseWideningKeptPrivate`).
 *   - A Highlight cannot be made from a KEEP_PRIVATE_FOREVER Memory
 *     (highlightSources.verifyMemorySources → `kept_private`).
 * Not yet consumed: DO_NOT_RESURFACE / DO_NOT_INCLUDE_IN_RECAPS /
 * RETAIN_BUT_DO_NOT_PERSONALIZE have no proactive MEMORY surface in this tree
 * that reads them (the §5 recaps already exclude `passport:memory`; the trip
 * recap derivative and the Compass memory tools are the next consumers).
 */
import { isTableAbsentError } from "../../lib/tableAbsence.js";

export const MEMORY_RESURFACING_CONTROLS = [
  "DO_NOT_RESURFACE",
  "DO_NOT_INCLUDE_IN_RECAPS",
  "KEEP_PRIVATE_FOREVER",
  "RETAIN_BUT_DO_NOT_PERSONALIZE",
] as const;
export type MemoryResurfacingControl = (typeof MEMORY_RESURFACING_CONTROLS)[number];

export function isMemoryResurfacingControl(v: unknown): v is MemoryResurfacingControl {
  return typeof v === "string" && (MEMORY_RESURFACING_CONTROLS as readonly string[]).includes(v);
}

export type ControlsRead =
  | { state: "ok"; byMemory: Map<string, Set<MemoryResurfacingControl>> }
  | { state: "absent"; detail: string }
  | { state: "unreadable"; detail: string };

/** The controls set on these Memories of this owner. */
export async function readMemoryControls(sc: any, ownerId: string, memoryIds: readonly string[]): Promise<ControlsRead> {
  const ids = [...new Set(memoryIds)];
  if (ids.length === 0) return { state: "ok", byMemory: new Map() };
  try {
    const { data, error } = await sc
      .from("memory_resurfacing_preferences")
      .select("memory_id, control")
      .eq("owner_id", ownerId)
      .in("memory_id", ids);
    if (error) {
      if (isTableAbsentError(error)) return { state: "absent", detail: String(error.message ?? "absent") };
      return { state: "unreadable", detail: String(error.message ?? "read failed") };
    }
    const byMemory = new Map<string, Set<MemoryResurfacingControl>>();
    for (const r of (Array.isArray(data) ? data : []) as Array<{ memory_id: string; control: string }>) {
      if (!isMemoryResurfacingControl(r.control)) continue;
      if (!byMemory.has(r.memory_id)) byMemory.set(r.memory_id, new Set());
      byMemory.get(r.memory_id)!.add(r.control);
    }
    return { state: "ok", byMemory };
  } catch (err) {
    return { state: "unreadable", detail: String((err as any)?.message ?? err) };
  }
}

/**
 * Which of these Memories may NOT be published. `kept` lists them; an
 * unreadable read puts EVERY id in `kept` (fail closed) and says so.
 */
export async function keptPrivate(sc: any, ownerId: string, memoryIds: readonly string[]): Promise<{ kept: string[]; unreadable: string | null }> {
  const read = await readMemoryControls(sc, ownerId, memoryIds);
  if (read.state === "absent") return { kept: [], unreadable: null };
  if (read.state === "unreadable") return { kept: [...new Set(memoryIds)], unreadable: read.detail };
  return { kept: [...new Set(memoryIds)].filter((id) => read.byMemory.get(id)?.has("KEEP_PRIVATE_FOREVER")), unreadable: null };
}

/**
 * PATCH /memories/:id: a KEEP_PRIVATE_FOREVER Memory may not be widened beyond
 * `only_me`. Answers the refusal itself and returns true when it refused.
 */
export async function refuseWideningKeptPrivate(
  sc: any,
  res: any,
  sendError: (res: any, code: any, message: string) => void,
  memoryId: string,
  ownerId: string,
  visibility: unknown,
): Promise<boolean> {
  if (visibility === undefined || visibility === "only_me") return false;
  const k = await keptPrivate(sc, ownerId, [memoryId]);
  if (k.unreadable !== null) {
    sendError(res, "degraded_unavailable", "We could not check this Memory's privacy settings, so its audience was not widened. Please try again.");
    return true;
  }
  if (k.kept.includes(memoryId)) {
    sendError(res, "conflict", "This Memory is set to stay private forever. Turn that off before sharing it.");
    return true;
  }
  return false;
}

export type ControlWrite =
  | { ok: true }
  | { ok: false; reason: "not_deployed" | "unavailable" | "not_private"; detail: string };

/** Set a control. KEEP_PRIVATE_FOREVER is refused on a Memory that is not `only_me` now: the owner narrows first. */
export async function setMemoryControl(
  sc: any,
  input: { ownerId: string; memoryId: string; control: MemoryResurfacingControl; currentVisibility: string | null },
): Promise<ControlWrite> {
  if (input.control === "KEEP_PRIVATE_FOREVER" && input.currentVisibility !== "only_me") {
    return { ok: false, reason: "not_private", detail: "make this Memory private (only me) before keeping it private forever" };
  }
  const { error } = await sc
    .from("memory_resurfacing_preferences")
    .upsert({ memory_id: input.memoryId, owner_id: input.ownerId, control: input.control }, { onConflict: "memory_id,control", ignoreDuplicates: true });
  if (error) {
    if (isTableAbsentError(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "") };
    return { ok: false, reason: "unavailable", detail: String(error.message ?? "") };
  }
  return { ok: true };
}

/** Clear a control (deletes the row). Clearing one that is not set is not an error. */
export async function clearMemoryControl(
  sc: any,
  input: { ownerId: string; memoryId: string; control: MemoryResurfacingControl },
): Promise<ControlWrite> {
  const { error } = await sc
    .from("memory_resurfacing_preferences")
    .delete()
    .eq("owner_id", input.ownerId)
    .eq("memory_id", input.memoryId)
    .eq("control", input.control);
  if (error) {
    if (isTableAbsentError(error)) return { ok: false, reason: "not_deployed", detail: String(error.message ?? "") };
    return { ok: false, reason: "unavailable", detail: String(error.message ?? "") };
  }
  return { ok: true };
}
