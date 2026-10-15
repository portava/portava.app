/**
 * memoryFallbackRenderer — §28.17 "Always provide a deterministic fallback
 * renderer if AI presentation fails", for the one AI presentation of Memories
 * production has: the Compass ask loop narrating `memory_*` tool results.
 *
 * census-highlights-memories H266 (b58 lane HM-A3).
 *
 * WHAT WAS THERE. When the model call failed after the memory tools had run,
 * `/compass/ask` answered with `HONEST_FALLBACK_MESSAGE` ("Compass AI assistant
 * is temporarily unavailable"), and when the model returned no text it
 * answered `SUMMARISE_EMPTY_FALLBACK_MESSAGE`. Both are honest and neither is a
 * renderer: the facts the tools had just read — authorized, gated, past-tense —
 * were thrown away, and the census (§M.1, §M.8) graded the row W on exactly
 * that ("the fallback is built and it is not a renderer").
 *
 * WHAT THIS IS. A pure function over the turn's tool log. It renders ONLY what
 * a `memory_*` tool returned, ONLY through fields the tools build from columns
 * (each Memory's app-composed `historical.claim`, counts, the resolution words),
 * in fixed sentences. No model, no clock, no database, no free text that a
 * tool did not return. It returns `null` when no memory tool answered, so every
 * other turn keeps the fallback it had.
 *
 * WHAT IT DELIBERATELY DOES NOT RENDER:
 *   - a draft's or a proposal's MODEL-SUPPLIED fields (a draft title is the
 *     model's words, not a fact) — only that one exists and that nothing was
 *     saved;
 *   - anything about NOW. `memory_get_place_history`'s current-world half is
 *     left out; the closing sentence says the list is historical.
 *   - a refusal's instruction to the model ("Say that…"): only its first
 *     sentence, which is written to be said.
 *   - the `<portava:ugc>` envelope, which is stripped (the text inside is the
 *     owner's own and is shown verbatim).
 */

export const MEMORY_FALLBACK_RENDERER_VERSION = "memory-fallback@1";

/** The Memory tools whose results this renderer knows how to read. */
const MEMORY_TOOL_PREFIX = "memory_";
const MAX_LINES_PER_TOOL = 10;
const MAX_TEXT = 2000;

export interface MemoryFallbackRendering {
  readonly text: string;
  readonly renderer: typeof MEMORY_FALLBACK_RENDERER_VERSION;
  /** The memory tools whose results were rendered, in order. */
  readonly rendered_tools: readonly string[];
}

const LEAD = "Compass could not finish writing its answer, so here is what your Memories show, exactly as recorded:";
const CLOSE = "These are historical records from your Memories, not a statement about the present.";

function unwrapUgc(s: string): string {
  return s.replace(/<\/?portava:ugc>/gi, "");
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? unwrapUgc(v.trim()) : null;
}

/** The first sentence of a refusal — the part written to be said to a person. */
function firstSentence(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^.*?[.!?](?=\s|$)/u.exec(s);
  return (m ? m[0] : s).slice(0, 200);
}

function claimOf(fact: unknown): string | null {
  const f = (fact ?? {}) as { historical?: { claim?: unknown } };
  return str(f.historical?.claim);
}

function bullets(facts: unknown, suffix = ""): string[] {
  if (!Array.isArray(facts)) return [];
  const out: string[] = [];
  for (const f of facts.slice(0, MAX_LINES_PER_TOOL)) {
    const c = claimOf(f);
    if (c) out.push(`• ${c}${suffix}`);
  }
  if (facts.length > MAX_LINES_PER_TOOL) out.push(`• …and ${facts.length - MAX_LINES_PER_TOOL} more.`);
  return out;
}

function askedName(asked: unknown): string {
  const a = (asked ?? {}) as Record<string, unknown>;
  const parts = [a["person"], a["city"], a["country"], a["place_id"] ? "that place" : null].map(str).filter((x): x is string => Boolean(x));
  return parts.join(", ") || "what was asked about";
}

/** One tool result → the lines it contributes, or [] when it says nothing renderable. */
function renderOne(name: string, result: unknown): string[] {
  const r = (result ?? {}) as Record<string, unknown>;
  if (r["authorized"] === false) {
    const why = firstSentence(r["reason"]);
    return [`• One lookup in your Memories was not answered${why ? `: ${why}` : "."}`];
  }
  if (r["resolution"] === "UNRESOLVED") return [`• Nothing in your Memories is "${askedName(r["asked"])}".`];
  if (r["resolution"] === "AMBIGUOUS") {
    const cands = Array.isArray(r["candidates"]) ? (r["candidates"] as Array<Record<string, unknown>>) : [];
    const list = cands.slice(0, MAX_LINES_PER_TOOL).map((c) => [str(c["city"]), str(c["country"]) ?? "country not recorded"].filter(Boolean).join(", ")).join("; ");
    return [`• Several places in your Memories are called "${askedName(r["asked"])}"${list ? ` (${list})` : ""}. Which one did you mean?`];
  }
  switch (name) {
    case "memory_get":
      return bullets([r["memory"]]);
    case "memory_search":
    case "memory_get_trip_memories": {
      const b = bullets(r["memories"]);
      return b.length ? b : [`• No Memory matched.`];
    }
    case "memory_get_place_history": {
      const b = bullets(r["visits"]);
      return b.length ? b : [`• No Memory at that place.`];
    }
    case "memory_get_shared": {
      const who = str(r["person"]);
      const lines = bullets(r["memories"], who ? ` (with @${who}, who confirmed being there)` : "");
      lines.push(...bullets(r["unconfirmed_participation"], who ? ` (@${who} was tagged and has not confirmed)` : " (tagged, not confirmed)"));
      return lines.length ? lines : [`• No shared Memory${who ? ` with @${who}` : ""}.`];
    }
    case "memory_get_evidence": {
      const lines: string[] = [];
      const files = Array.isArray(r["attached_artifacts"]) ? r["attached_artifacts"].length : null;
      lines.push(files === null ? "• Its attached files could not be looked up." : `• ${files} file(s) are attached to it. Attached files are not proof of what happened.`);
      const confirmed = r["confirmed_participants"];
      if (typeof confirmed === "number") lines.push(`• ${confirmed} person(s) confirmed being there.`);
      else if (r["participants_unavailable"] === true) lines.push("• Who was there could not be looked up.");
      const store = r["evidence_store"];
      const prov = Array.isArray(r["provenance"]) ? (r["provenance"] as Array<{ records?: unknown }>) : null;
      if (store === "present" && prov) {
        const levels = new Map<string, number>();
        for (const ep of prov) for (const rec of (Array.isArray(ep.records) ? ep.records : []) as Array<{ truth_level?: unknown }>) {
          const lvl = str(rec.truth_level) ?? "unknown";
          levels.set(lvl, (levels.get(lvl) ?? 0) + 1);
        }
        lines.push(levels.size
          ? `• Recorded provenance: ${[...levels.entries()].map(([k, n]) => `${n} ${k}`).join(", ")}. It records how the app suggested this Memory, not proof.`
          : "• No recorded provenance: its facts are your own entries.");
      } else if (store === "not_deployed") {
        lines.push("• No provenance is recorded on this deployment.");
      } else if (store === "unavailable") {
        lines.push("• Its provenance could not be looked up.");
      }
      return lines;
    }
    case "memory_create_draft":
      return ["• A Memory draft was prepared. Nothing was saved."];
    case "memory_suggest_correction":
      return ["• A correction was proposed. Nothing was changed."];
    case "memory_propose_merge":
      return ["• A merge was proposed. Nothing was merged."];
    case "memory_propose_split":
      return ["• A split was proposed. Nothing was split."];
    default:
      return [];
  }
}

/**
 * Render the turn's memory tool results deterministically, or `null` when no
 * `memory_*` tool answered (the caller keeps its own fallback then).
 */
export function renderMemoryToolFallback(
  toolLog: ReadonlyArray<{ readonly name?: unknown; readonly result?: unknown }> | null | undefined,
): MemoryFallbackRendering | null {
  if (!Array.isArray(toolLog)) return null;
  const lines: string[] = [];
  const rendered: string[] = [];
  for (const t of toolLog) {
    const name = typeof t?.name === "string" ? t.name : "";
    if (!name.startsWith(MEMORY_TOOL_PREFIX)) continue;
    const out = renderOne(name, t.result);
    if (out.length === 0) continue;
    lines.push(...out);
    rendered.push(name);
  }
  if (rendered.length === 0) return null;
  let text = [LEAD, ...lines, CLOSE].join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - CLOSE.length - 2)}…\n${CLOSE}`;
  return { text, renderer: MEMORY_FALLBACK_RENDERER_VERSION, rendered_tools: rendered };
}
