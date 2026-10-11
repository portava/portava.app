/**
 * memoryReaderGuard — the owner's per-Memory controls, for the readers that
 * hand a Memory to SOMEONE OTHER THAN its owner's own Memories screens: the
 * Compass memory tools (a language model), the intelligence graph (public-world
 * intelligence AND the owner's own rediscovery projections, which 2963's
 * projector builds from compass_graph_edges) and Discovery's place-trend count
 * (an aggregate). Census H10, H48, H49, H73, H80, H87, H92, H187, H188, H210
 * (RECON-W cluster A1).
 *
 * The three controls it applies were stored and settable, and these readers did
 * not read them:
 *   - 3671 `memory_resurfacing_preferences` (memoryResurfacingControls.ts):
 *     DO_NOT_RESURFACE, KEEP_PRIVATE_FOREVER, RETAIN_BUT_DO_NOT_PERSONALIZE;
 *   - 3673 `memory_corrections` (memoryCorrections.ts): the owner's asserted
 *     and rejected place references;
 *   - 3672 `memory_items.visibility` (memoryItemVisibility.ts): a photo the
 *     owner keeps to themself. That one is per item and is applied by the one
 *     reader that serves items (Compass `memory_get_evidence`) through
 *     `hiddenItemKeys` directly.
 *
 * WHICH CONTROL EXCLUDES A MEMORY FROM WHICH READER. Not restated: derived from
 * services/highlights/highlightResurfacing.ts CONTROL_EFFECTS, the one table of
 * what each §11 control suppresses. A reader names the SURFACES it is
 * (`READER_SURFACES`), and a Memory carrying any control that suppresses one of
 * them is excluded. Proposed ruling W-HM-PRIV-1 (fail-closed default):
 *   - compass_tools      proactive_resurfacing + personalization. Compass is
 *                        model-mediated: what it is handed it may bring up
 *                        unasked and reason from. The owner's own Memories
 *                        screens and search are untouched (§21's "retain and
 *                        search privately").
 *   - intelligence_graph proactive_resurfacing + personalization +
 *                        public_projection: it feeds the world model every
 *                        user reads AND the owner's own Compass rediscovery.
 *   - aggregate_count    personalization + public_projection (an anonymous
 *                        count resurfaces nothing to anyone).
 *
 * FAILS CLOSED, NEVER CRASHES, ON A DATABASE WITHOUT 3671/3673.
 *   - table ABSENT (42P01 / PGRST205 only, lib/tableAbsence.ts): no control and
 *     no correction can exist, so "none" is TRUE and every Memory passes;
 *   - any other failure, a page that may be truncated, or a throw: `ok:false`,
 *     and the caller withholds every Memory it was about to use.
 * Never throws.
 */
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { CONTROL_EFFECTS, type SuppressibleSurface } from "../highlights/highlightResurfacing.js";
import { CONTROLS_PAGE, MEMORY_RESURFACING_CONTROLS, isMemoryResurfacingControl, readMemoryControls, type MemoryResurfacingControl } from "./memoryResurfacingControls.js";
import { CORRECTIONS_ID_CHUNK, CORRECTIONS_PAGE, placesThroughCorrections, type MemoryPlaceRow } from "./memoryCorrections.js";

export type MemoryReader = "compass_tools" | "intelligence_graph" | "aggregate_count";

/** The surfaces each reader IS (W-HM-PRIV-1). */
export const READER_SURFACES: Readonly<Record<MemoryReader, readonly SuppressibleSurface[]>> = Object.freeze({
  compass_tools: ["proactive_resurfacing", "personalization"],
  intelligence_graph: ["proactive_resurfacing", "personalization", "public_projection"],
  aggregate_count: ["personalization", "public_projection"],
});

/** The Memory-scoped controls that keep a Memory out of this reader. */
export function controlsExcluding(reader: MemoryReader): ReadonlySet<MemoryResurfacingControl> {
  const surfaces = READER_SURFACES[reader];
  return new Set(MEMORY_RESURFACING_CONTROLS.filter((c) => CONTROL_EFFECTS[c].suppresses.some((s) => surfaces.includes(s))));
}

/** The controls that say "do not use this Memory for personalization". */
export const PERSONALIZATION_BLOCKING_CONTROLS: ReadonlySet<MemoryResurfacingControl> = new Set(
  MEMORY_RESURFACING_CONTROLS.filter((c) => CONTROL_EFFECTS[c].suppresses.includes("personalization")),
);

/** A Memory as these readers must hand it over: which Memory, and whose. */
export interface MemoryRef { id: string; owner_id: string }

export type Exclusions =
  | { ok: true; excluded: ReadonlySet<string>; absent: boolean }
  | { ok: false; detail: string };

/**
 * Which of these Memories carry a control that keeps them out of `reader`.
 * Read by Memory id in chunks (one read per 100 Memories, whatever the number
 * of owners) and kept only where the control's owner IS the Memory's owner.
 * No read at all for no rows.
 */
export async function excludedMemories(sc: any, reader: MemoryReader, rows: readonly MemoryRef[]): Promise<Exclusions> {
  const ownerOf = new Map<string, string>();
  for (const r of rows) {
    if (typeof r?.id !== "string" || !r.id || typeof r.owner_id !== "string" || !r.owner_id) return { ok: false, detail: "a Memory without its id or owner" };
    ownerOf.set(r.id, r.owner_id);
  }
  const blocking = controlsExcluding(reader);
  const excluded = new Set<string>();
  const ids = [...ownerOf.keys()].sort();
  for (let i = 0; i < ids.length; i += CORRECTIONS_ID_CHUNK) {
    const batch = ids.slice(i, i + CORRECTIONS_ID_CHUNK);
    try {
      const { data, error } = await sc.from("memory_resurfacing_preferences").select("memory_id, owner_id, control").in("memory_id", batch);
      if (error) {
        if (isTableAbsentError(error)) return { ok: true, excluded: new Set(), absent: true };
        return { ok: false, detail: `memory_resurfacing_preferences unreadable: ${String(error.message ?? "read failed")}` };
      }
      if (!Array.isArray(data)) return { ok: false, detail: "memory_resurfacing_preferences returned no row array" };
      if (data.length >= CONTROLS_PAGE) return { ok: false, detail: `controls page full (${data.length} rows): refusing rather than missing a control past it` };
      for (const r of data as Array<{ memory_id: string; owner_id: string; control: string }>) {
        const id = String(r.memory_id);
        if (ownerOf.get(id) !== String(r.owner_id)) continue;
        if (isMemoryResurfacingControl(r.control) && blocking.has(r.control)) excluded.add(id);
      }
    } catch (err) {
      return { ok: false, detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  return { ok: true, excluded, absent: false };
}

/**
 * §16/§21 `canUseForPersonalization(userId, memoryId)` (census H210): may this
 * owner's Memory feed preference or recommendation inference? FALSE when it
 * carries KEEP_PRIVATE_FOREVER or RETAIN_BUT_DO_NOT_PERSONALIZE, and FALSE when
 * the controls cannot be read. TRUE when none is set, or 3671 is not applied.
 */
export async function canUseForPersonalization(sc: any, ownerId: string, memoryId: string): Promise<boolean> {
  if (!ownerId || !memoryId) return false;
  const read = await readMemoryControls(sc, ownerId, [memoryId]);
  if (read.state === "absent") return true;
  if (read.state === "unreadable") return false;
  for (const c of read.byMemory.get(memoryId) ?? []) if (PERSONALIZATION_BLOCKING_CONTROLS.has(c)) return false;
  return true;
}

export type CorrectedPlaces<T> = { ok: true; rows: T[] } | { ok: false; detail: string };

/**
 * Each row's place reference as the OWNER says it is (memoryCorrections
 * placesThroughCorrections: the owner's assertion wins by §4 precedence, a
 * rejected value is removed, and a reference whose automatic match reaches a
 * rejected place is dropped whole — H-17). A cheap probe by Memory id first
 * finds the Memories that HAVE a place correction; only those go through
 * placesThroughCorrections (whose per-owner read is then bounded by the
 * corrected Memories, not by every owner in an aggregate). A row with no
 * correction is returned as it is — exactly what placesThroughCorrections would
 * return for it. Absent table ⇒ every row as it is. Any failed read ⇒ ok:false.
 */
export async function correctedPlaces<T extends MemoryPlaceRow>(sc: any, rows: readonly T[], now: Date): Promise<CorrectedPlaces<T>> {
  for (const r of rows) {
    if (typeof r?.id !== "string" || !r.id || typeof r.owner_id !== "string" || !r.owner_id) return { ok: false, detail: "a place row without its Memory id or owner" };
  }
  const ids = [...new Set(rows.map((r) => r.id))].sort();
  const ownerOf = new Map(rows.map((r) => [r.id, r.owner_id] as const));
  const corrected = new Set<string>();
  for (let i = 0; i < ids.length; i += CORRECTIONS_ID_CHUNK) {
    const batch = ids.slice(i, i + CORRECTIONS_ID_CHUNK);
    try {
      const { data, error } = await sc.from("memory_corrections").select("memory_id, owner_id").eq("field", "place").in("memory_id", batch).limit(CORRECTIONS_PAGE);
      if (error) {
        if (isTableAbsentError(error)) return { ok: true, rows: [...rows] };
        return { ok: false, detail: `memory_corrections unreadable: ${String(error.message ?? "read failed")}` };
      }
      if (!Array.isArray(data)) return { ok: false, detail: "memory_corrections returned no row array" };
      if (data.length >= CORRECTIONS_PAGE) { for (const id of batch) corrected.add(id); continue; } // a full page: every Memory in it goes the whole way
      for (const r of data as Array<{ memory_id: string; owner_id: string }>) {
        if (ownerOf.get(String(r.memory_id)) === String(r.owner_id)) corrected.add(String(r.memory_id));
      }
    } catch (err) {
      return { ok: false, detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  if (corrected.size === 0) return { ok: true, rows: [...rows] };
  const through = await placesThroughCorrections(sc, rows.filter((r) => corrected.has(r.id)), now);
  if (!through.ok) return { ok: false, detail: through.detail };
  const byId = new Map(through.rows.map((r) => [r.id, r] as const));
  return { ok: true, rows: rows.map((r) => byId.get(r.id) ?? r) };
}

export type GuardedRows<T> = { ok: true; rows: T[]; excluded: ReadonlySet<string> } | { ok: false; detail: string };

/**
 * Both, in the order every reader needs: a Memory its owner's controls keep out
 * of `reader` is dropped, and every remaining one carries its owner's place.
 */
export async function guardMemoryRows<T extends MemoryPlaceRow>(sc: any, reader: MemoryReader, rows: readonly T[], now: Date): Promise<GuardedRows<T>> {
  if (rows.length === 0) return { ok: true, rows: [], excluded: new Set() };
  const ex = await excludedMemories(sc, reader, rows);
  if (!ex.ok) return ex;
  const kept = rows.filter((r) => !ex.excluded.has(r.id));
  const placed = await correctedPlaces(sc, kept, now);
  if (!placed.ok) return placed;
  return { ok: true, rows: placed.rows, excluded: ex.excluded };
}

export type RejectedStoredPlaces = { ok: true; rejected: ReadonlySet<string>; absent: boolean } | { ok: false; detail: string };

/**
 * For an anonymous AGGREGATE keyed on the STORED `place_id` (Discovery's
 * place-trend count, which has a stored SQL twin and so cannot run the H-15
 * fold): the Memories whose stored place the OWNER has rejected — any `reject`
 * correction by the Memory's owner naming that exact `place_id`, whatever came
 * after it. Proposed ruling W-HM-PRIV-2: a Memory counts at a place only while
 * its owner has never said it was not there (fail closed; a later re-assertion
 * of the same place does not re-admit it to the count). Absent table ⇒ none.
 */
export async function rejectedStoredPlaces(sc: any, rows: ReadonlyArray<MemoryRef & { place_id?: string | null }>): Promise<RejectedStoredPlaces> {
  const byId = new Map<string, { owner: string; place: string }>();
  for (const r of rows) {
    if (typeof r?.id !== "string" || !r.id || typeof r.owner_id !== "string" || !r.owner_id) return { ok: false, detail: "a Memory without its id or owner" };
    if (typeof r.place_id === "string" && r.place_id) byId.set(r.id, { owner: r.owner_id, place: r.place_id });
  }
  const rejected = new Set<string>();
  const ids = [...byId.keys()].sort();
  for (let i = 0; i < ids.length; i += CORRECTIONS_ID_CHUNK) {
    const batch = ids.slice(i, i + CORRECTIONS_ID_CHUNK);
    try {
      const { data, error } = await sc
        .from("memory_corrections")
        .select("memory_id, owner_id, place_id")
        .eq("field", "place")
        .eq("kind", "reject")
        .in("memory_id", batch)
        .limit(CORRECTIONS_PAGE);
      if (error) {
        if (isTableAbsentError(error)) return { ok: true, rejected: new Set(), absent: true };
        return { ok: false, detail: `memory_corrections unreadable: ${String(error.message ?? "read failed")}` };
      }
      if (!Array.isArray(data)) return { ok: false, detail: "memory_corrections returned no row array" };
      if (data.length >= CORRECTIONS_PAGE) return { ok: false, detail: `rejections page full (${data.length} rows): refusing rather than missing a rejection past it` };
      for (const r of data as Array<{ memory_id: string; owner_id: string; place_id: string | null }>) {
        const m = byId.get(String(r.memory_id));
        if (m && m.owner === String(r.owner_id) && m.place === r.place_id) rejected.add(String(r.memory_id));
      }
    } catch (err) {
      return { ok: false, detail: String((err as { message?: unknown })?.message ?? err) };
    }
  }
  return { ok: true, rejected, absent: false };
}

/**
 * An aggregate COUNT's rows (READER_SURFACES.aggregate_count): without every
 * Memory its owner keeps out of personalization or public projection (3671) and
 * every Memory whose stored place its owner rejected (3673,
 * rejectedStoredPlaces). Null when either table is unreadable: the caller
 * reports the count unread, never a count over Memories it could not check.
 */
export async function aggregateMemoryRows<T extends MemoryRef & { place_id?: string | null }>(sc: any, rows: readonly T[]): Promise<T[] | null> {
  if (rows.length === 0) return [];
  const ex = await excludedMemories(sc, "aggregate_count", rows);
  if (!ex.ok) return null;
  const rj = await rejectedStoredPlaces(sc, rows);
  if (!rj.ok) return null;
  return rows.filter((r) => !ex.excluded.has(r.id) && !rj.rejected.has(r.id));
}
