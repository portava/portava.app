/**
 * Compass's deterministic fallback renderer for Memory facts — census-highlights-memories H266.
 *
 * SPEC §28.17: "always provide a deterministic fallback renderer when AI
 * presentation fails". The Memory narrative surface has one
 * (`services/memory/memoryNarrativeService.ts`: a refused or failed AI draft is
 * the template summary). Compass did not: on a failed model call `POST
 * /compass/ask` answered one sentence, "Compass AI assistant is temporarily
 * unavailable", even when the turn had ALREADY read the person's Memories
 * through §16's accessors (`compass/MemoryCompassTools.ts`) and only the
 * presentation failed. The facts were in hand and were thrown away.
 *
 * WHAT THIS RENDERS, AND FROM WHAT
 * ================================
 * The Memory facts the turn's own tool calls returned — nothing else is read,
 * so nothing reaches the person that the model was not already given under the
 * same read policy (`canCompassReadMemory`, the owner's controls, the §10 place
 * rung all ran inside the tools). Each fact is rendered by its `historical.claim`,
 * the past-tense sentence `MemoryCompassTools.claimOf` composes from columns
 * ("Recorded: "Sunset walk" — Lisbon, Portugal, on 2026-03-02."): an app-stated
 * claim, never model prose. Order is the order the tools returned; a Memory
 * returned twice is rendered once; at most `MAX_RENDERED_FACTS`.
 *
 * WHEN THE MODEL FAILED BEFORE READING ANY MEMORY — the common shape of an
 * outage, the first call throwing — `compassAiFailureFallbackWithRetrieval`
 * reads the facts itself, once, through the SAME accessor and the same gates
 * the model would have used (`memory_search` via `executeCompassTool`, with the
 * person's own question as the query: deterministic token overlap over their
 * own history, `canCompassReadMemory`, the owner's controls, the §10 rung,
 * `sanitizeToolResult`). No model is asked.
 *
 * WHERE THERE ARE NO FACTS, the honest sentence the caller passes is returned
 * unchanged. A refusal, an unreadable history, a draft, a proposed correction
 * and an evidence read are not facts to present, so they render nothing; a
 * retrieval that throws is the honest sentence.
 *
 * THE PARTIAL TOOL LOG. `runToolCallingLoop` keeps its tool log in a local
 * array, so a model call that throws after the tools ran used to take the log
 * with it. `trackPartialToolLog` hands the loop an array registered against the
 * caller's `messages` object (a WeakMap: nothing outlives the request), and the
 * failure branch reads it back with `partialToolLogOf`.
 */

export const COMPASS_MEMORY_FALLBACK_RENDERER = "compass-memory-fallback@1";
export const MAX_RENDERED_FACTS = 5;

/** The tools whose results carry presentable Memory facts, and where. */
const FACT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  memory_get: ["memory"],
  memory_search: ["memories"],
  memory_get_shared: ["memories"],
  memory_get_place_history: ["visits"],
  memory_get_trip_memories: ["memories"],
});

export interface ToolLogEntryLike {
  name: string;
  result: unknown;
}

export interface RenderableMemoryFact {
  memoryId: string;
  claim: string;
}

const partialLogs = new WeakMap<object, unknown[]>();

/** A fresh tool log for one loop, readable by whoever holds `key` if the loop throws. */
export function trackPartialToolLog<T>(key: object): T[] {
  const log: T[] = [];
  partialLogs.set(key, log as unknown[]);
  return log;
}

/** The tool log a loop over `key` had built when it stopped; empty if none ran. */
export function partialToolLogOf(key: object): readonly ToolLogEntryLike[] {
  return (partialLogs.get(key) ?? []) as ToolLogEntryLike[];
}

function asFact(v: unknown): RenderableMemoryFact | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = o["memory_id"];
  const h = o["historical"];
  const claim = h && typeof h === "object" ? (h as Record<string, unknown>)["claim"] : undefined;
  if (typeof id !== "string" || !id || typeof claim !== "string" || !claim.trim()) return null;
  return { memoryId: id, claim: claim.trim() };
}

/** Every presentable Memory fact in a tool log, deduplicated, in the order returned. */
export function memoryFactsFromToolLog(toolLog: readonly ToolLogEntryLike[]): RenderableMemoryFact[] {
  const out: RenderableMemoryFact[] = [];
  const seen = new Set<string>();
  for (const entry of toolLog) {
    const keys = FACT_KEYS[entry?.name];
    const result = entry?.result;
    if (!keys || !result || typeof result !== "object") continue;
    for (const k of keys) {
      const v = (result as Record<string, unknown>)[k];
      for (const item of Array.isArray(v) ? v : [v]) {
        const f = asFact(item);
        if (f && !seen.has(f.memoryId)) { seen.add(f.memoryId); out.push(f); }
      }
    }
  }
  return out;
}

/** The deterministic rendering of the turn's Memory facts, or null when there are none. */
export function renderCompassMemoryFallback(toolLog: readonly ToolLogEntryLike[]): { text: string; factCount: number } | null {
  const facts = memoryFactsFromToolLog(toolLog);
  if (facts.length === 0) return null;
  const shown = facts.slice(0, MAX_RENDERED_FACTS);
  const lines = [
    "Compass couldn't put an answer into words just now. Here is what it found in your Memories:",
    ...shown.map((f) => `• ${f.claim}`),
  ];
  if (facts.length > shown.length) lines.push(`…and ${facts.length - shown.length} more.`);
  return { text: lines.join("\n"), factCount: facts.length };
}

/**
 * The answer for a turn whose AI presentation failed: the rendered facts when
 * there are any, otherwise `honest` unchanged. Spread into the response body.
 */
export function compassAiFailureFallback(
  toolLog: readonly ToolLogEntryLike[],
  honest: string,
): { message: string; fallbackRenderer?: string; memoryFactCount?: number } {
  const r = renderCompassMemoryFallback(toolLog);
  return r
    ? { message: r.text, fallbackRenderer: COMPASS_MEMORY_FALLBACK_RENDERER, memoryFactCount: r.factCount }
    : { message: honest };
}

/**
 * `compassAiFailureFallback`, and when the turn read no Memory fact, one
 * deterministic retrieval through `retrieve` (the route passes `memory_search`
 * over the person's question). Never throws.
 */
export async function compassAiFailureFallbackWithRetrieval(
  toolLog: readonly ToolLogEntryLike[],
  retrieve: () => Promise<unknown>,
  honest: string,
): Promise<{ message: string; fallbackRenderer?: string; memoryFactCount?: number }> {
  const fromTurn = compassAiFailureFallback(toolLog, honest);
  if (fromTurn.fallbackRenderer) return fromTurn;
  try {
    return compassAiFailureFallback([{ name: "memory_search", result: await retrieve() }], honest);
  } catch {
    return { message: honest };
  }
}
