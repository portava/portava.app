/**
 * memoryGraphShadow — §22 "Dual-read old and new projections in shadow mode;
 * compare visible behavior", then the cutover switch, for the owner's graph
 * (GET /memories/graph).
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       §22 steps 3-5, §3.4 MemoryRelation, §3.6 memory_entity_links.
 * DECISION: docs/architecture/memories-graph-model-decision.md §5, §6.
 * CENSUS: H196 (dual-read shadow comparison, then cutover).
 *
 * THE LEGACY ANSWER IS THE ANSWER until the cutover is both switched on AND
 * earned. Three flags, all seeded FALSE by migration 3674:
 *
 *   memory_graph_shadow_read_enabled   after the legacy answer is built, read
 *                                      memory_entity_links for the same Memories,
 *                                      compare, and record COUNTS ONLY in
 *                                      memory_graph_shadow_daily. Never changes
 *                                      the response; never delays it.
 *   memory_graph_read_cutover_enabled  serve trip / place / people from the graph
 *                                      — only while evaluateCutoverGate says the
 *                                      comparison has been clean (CUTOVER_GATE).
 *
 * FAIL CLOSED, NEVER EMPTY. A graph read that fails, a gate that cannot be read,
 * a flag that cannot be read: the legacy answer is served. Nothing here writes
 * after a failed read except the shadow COUNT of that failure.
 *
 * NO CONTENT LEAVES THIS MODULE. The shadow record is seven integers; the log
 * lines carry counts and an error class, never a Memory id, a person id or a
 * place.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import type { GraphMoment } from "../memoryProjections/memoryGraph.js";

export const MEMORY_GRAPH_SHADOW_FLAG = "memory_graph_shadow_read_enabled";
export const MEMORY_GRAPH_CUTOVER_FLAG = "memory_graph_read_cutover_enabled";
export const MEMORY_GRAPH_SHADOW_SURFACE = "memories_graph";

/**
 * "Comparison clean", defined. Decision doc §6. Over the trailing WINDOW_DAYS
 * complete UTC days (yesterday and before; today is still accumulating):
 * at least MIN_COMPARED comparisons, comparisons on at least MIN_DAYS_WITH_DATA
 * of those days, and NO mismatch and NO graph read failure at all.
 */
export const CUTOVER_GATE = Object.freeze({
  windowDays: 7,
  minCompared: 500,
  minDaysWithData: 5,
  maxMismatched: 0,
  maxReadFailures: 0,
});

const IN_CHUNK = 150;

export interface ShadowDailyRow {
  day: string;
  compared: number;
  mismatched: number;
  graph_read_failures: number;
}

export type GateVerdict =
  | { open: true; compared: number; daysWithData: number; window: { from: string; to: string } }
  | { open: false; reason: "unreadable" | "insufficient_volume" | "insufficient_days" | "mismatches" | "read_failures"; compared: number; daysWithData: number; window: { from: string; to: string } };

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The trailing window of complete UTC days ending YESTERDAY. */
export function gateWindow(now: Date): { from: string; to: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = new Date(today - 86_400_000);
  const from = new Date(today - CUTOVER_GATE.windowDays * 86_400_000);
  return { from: utcDay(from), to: utcDay(to) };
}

/** Pure. Rows outside the window (including today) are ignored. */
export function evaluateCutoverGate(rows: readonly ShadowDailyRow[], now: Date): GateVerdict {
  const window = gateWindow(now);
  const inWindow = rows.filter((r) => r.day >= window.from && r.day <= window.to);
  const compared = inWindow.reduce((n, r) => n + Number(r.compared ?? 0), 0);
  const mismatched = inWindow.reduce((n, r) => n + Number(r.mismatched ?? 0), 0);
  const failures = inWindow.reduce((n, r) => n + Number(r.graph_read_failures ?? 0), 0);
  const daysWithData = new Set(inWindow.filter((r) => Number(r.compared ?? 0) > 0).map((r) => r.day)).size;
  const base = { compared, daysWithData, window };
  if (mismatched > CUTOVER_GATE.maxMismatched) return { open: false, reason: "mismatches", ...base };
  if (failures > CUTOVER_GATE.maxReadFailures) return { open: false, reason: "read_failures", ...base };
  if (compared < CUTOVER_GATE.minCompared) return { open: false, reason: "insufficient_volume", ...base };
  if (daysWithData < CUTOVER_GATE.minDaysWithData) return { open: false, reason: "insufficient_days", ...base };
  return { open: true, ...base };
}

/** Read the window and decide. Any read problem is a CLOSED gate. */
export async function readCutoverGate(sc: SupabaseClient, now: Date): Promise<GateVerdict> {
  const window = gateWindow(now);
  try {
    const { data, error } = await sc
      .from("memory_graph_shadow_daily")
      .select("day, compared, mismatched, graph_read_failures")
      .eq("surface", MEMORY_GRAPH_SHADOW_SURFACE)
      .gte("day", window.from)
      .lte("day", window.to);
    if (error || !Array.isArray(data)) return { open: false, reason: "unreadable", compared: 0, daysWithData: 0, window };
    return evaluateCutoverGate(data as ShadowDailyRow[], now);
  } catch {
    return { open: false, reason: "unreadable", compared: 0, daysWithData: 0, window };
  }
}

/** One Memory's links as the graph holds them. */
export interface GraphLinks {
  trips: string[];
  places: string[];
  people: string[];
}

export type GraphLinkRead =
  | { ok: true; links: Map<string, GraphLinks> }
  | { ok: false; absent: boolean };

/**
 * memory_entity_links for these Memories, RELATED edges only, owner-scoped.
 * Chunked: `.in()` rides in the query string. Every chunk's error is bound; a
 * failure is a failed read, never "these Memories have no links".
 */
export async function readGraphLinks(sc: SupabaseClient, ownerId: string, memoryIds: readonly string[]): Promise<GraphLinkRead> {
  const links = new Map<string, GraphLinks>();
  for (const id of memoryIds) links.set(id, { trips: [], places: [], people: [] });
  try {
    for (let i = 0; i < memoryIds.length; i += IN_CHUNK) {
      const batch = memoryIds.slice(i, i + IN_CHUNK);
      const { data, error } = await sc
        .from("memory_entity_links")
        .select("memory_id, entity_type, entity_id, relation_type")
        .eq("owner_id", ownerId)
        .eq("relation_type", "RELATED")
        .in("memory_id", batch);
      if (error) return { ok: false, absent: isTableAbsentError(error) };
      if (!Array.isArray(data)) return { ok: false, absent: false };
      for (const r of data as Array<{ memory_id: string; entity_type: string; entity_id: string; relation_type: string }>) {
        const l = links.get(r.memory_id);
        if (!l || r.relation_type !== "RELATED") continue;
        if (r.entity_type === "TRIP") l.trips.push(r.entity_id);
        else if (r.entity_type === "PLACE") l.places.push(r.entity_id);
        else if (r.entity_type === "PERSON") l.people.push(r.entity_id);
      }
    }
  } catch {
    return { ok: false, absent: false };
  }
  return { ok: true, links };
}

/** '' is no value, on both paths. */
function norm(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}

export interface ShadowCounts {
  compared: number;
  mismatched: number;
  trip: number;
  place: number;
  people: number;
}

/**
 * Pure. Per Memory: the legacy trip / place / approved people against the
 * graph's. A Memory with more than one TRIP or PLACE edge cannot equal a
 * scalar, so it is a mismatch on that field.
 */
export function compareMoments(moments: readonly GraphMoment[], links: Map<string, GraphLinks>): ShadowCounts {
  const out: ShadowCounts = { compared: 0, mismatched: 0, trip: 0, place: 0, people: 0 };
  for (const m of moments) {
    const g = links.get(m.memory_id) ?? { trips: [], places: [], people: [] };
    out.compared += 1;
    const tripOk = g.trips.length <= 1 && norm(g.trips[0]) === norm(m.trip_id);
    const placeOk = g.places.length <= 1 && norm(g.places[0]) === norm(m.place_id);
    const legacyPeople = [...new Set(m.people ?? [])].sort();
    const graphPeople = [...new Set(g.people)].sort();
    const peopleOk = legacyPeople.length === graphPeople.length && legacyPeople.every((p, i) => p === graphPeople[i]);
    if (!tripOk) out.trip += 1;
    if (!placeOk) out.place += 1;
    if (!peopleOk) out.people += 1;
    if (!tripOk || !placeOk || !peopleOk) out.mismatched += 1;
  }
  return out;
}

/** The graph's links, in the moment's shape. Only the three fields the graph owns change. */
export function momentsFromGraph(moments: readonly GraphMoment[], links: Map<string, GraphLinks>): GraphMoment[] {
  return moments.map((m) => {
    const g = links.get(m.memory_id) ?? { trips: [], places: [], people: [] };
    return {
      ...m,
      trip_id: norm([...g.trips].sort()[0]),
      place_id: norm([...g.places].sort()[0]),
      people: [...new Set(g.people)].sort(),
    };
  });
}

interface Log {
  warn?: (obj: unknown, msg: string) => void;
  error?: (obj: unknown, msg: string) => void;
  info?: (obj: unknown, msg: string) => void;
}

export async function recordShadowCounts(sc: SupabaseClient, counts: ShadowCounts, readFailures: number): Promise<boolean> {
  try {
    const { error } = await (sc as any).rpc("memory_graph_shadow_record", {
      p_surface: MEMORY_GRAPH_SHADOW_SURFACE,
      p_compared: counts.compared,
      p_mismatched: counts.mismatched,
      p_trip: counts.trip,
      p_place: counts.place,
      p_people: counts.people,
      p_read_failures: readFailures,
    });
    return !error;
  } catch {
    return false;
  }
}

/** The shadow pass. Never throws; returns what it recorded (for tests). */
export async function runShadowComparison(
  sc: SupabaseClient,
  input: { ownerId: string; moments: readonly GraphMoment[]; log?: Log },
): Promise<{ recorded: boolean; counts: ShadowCounts; readFailed: boolean }> {
  const empty: ShadowCounts = { compared: 0, mismatched: 0, trip: 0, place: 0, people: 0 };
  const read = await readGraphLinks(sc, input.ownerId, input.moments.map((m) => m.memory_id));
  if (!read.ok) {
    const recorded = await recordShadowCounts(sc, empty, 1);
    input.log?.warn?.({ absent: read.absent, recorded }, "memory graph shadow: graph read failed — counted as a read failure; the legacy answer was served");
    return { recorded, counts: empty, readFailed: true };
  }
  const counts = compareMoments(input.moments, read.links);
  const recorded = await recordShadowCounts(sc, counts, 0);
  if (!recorded) input.log?.warn?.({ compared: counts.compared, mismatched: counts.mismatched }, "memory graph shadow: counts could not be recorded");
  return { recorded, counts, readFailed: false };
}

export type LinkSource = "legacy" | "graph";

/**
 * GET /memories/graph's link path. Returns the moments to build from and where
 * their links came from. The legacy moments are returned UNCHANGED unless the
 * cutover flag is on, the gate is open and the graph read succeeded.
 *
 * The shadow pass is started, not awaited: it must not delay the response. Its
 * promise is returned so a test can await it.
 */
export async function memoryGraphLinkPath(
  sc: SupabaseClient,
  input: { ownerId: string; moments: GraphMoment[]; log?: Log; now?: Date },
): Promise<{ moments: GraphMoment[]; source: LinkSource; shadow: Promise<unknown> | null; gate: GateVerdict | null }> {
  const now = input.now ?? new Date();
  let moments = input.moments;
  let source: LinkSource = "legacy";
  let gate: GateVerdict | null = null;

  if (input.moments.length > 0 && await isFlagEnabled(sc, MEMORY_GRAPH_CUTOVER_FLAG)) {
    gate = await readCutoverGate(sc, now);
    if (gate.open) {
      const read = await readGraphLinks(sc, input.ownerId, input.moments.map((m) => m.memory_id));
      if (read.ok) {
        moments = momentsFromGraph(input.moments, read.links);
        source = "graph";
      } else {
        input.log?.error?.({ absent: read.absent }, "memory graph cutover: graph read failed — serving the legacy answer");
      }
    } else {
      input.log?.info?.({ reason: gate.reason, compared: gate.compared, daysWithData: gate.daysWithData }, "memory graph cutover: flag on, gate closed — serving the legacy answer");
    }
  }

  let shadow: Promise<unknown> | null = null;
  if (input.moments.length > 0 && await isFlagEnabled(sc, MEMORY_GRAPH_SHADOW_FLAG)) {
    // Compares the LEGACY moments with the graph, whichever path served.
    shadow = runShadowComparison(sc, { ownerId: input.ownerId, moments: input.moments, log: input.log })
      .catch(() => undefined);
  }
  return { moments, source, shadow, gate };
}
