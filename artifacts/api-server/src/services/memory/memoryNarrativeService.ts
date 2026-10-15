/**
 * memoryNarrativeService — §2 MemoryNarrativeService's I/O half: read the
 * facts, decide whether the optional AI draft may run, run it, and check it.
 * The pure half (facts, renderer, the check) is memoryNarrative.ts.
 *
 * CENSUS: census-highlights-memories H14, H172, H265 (B58 cluster MEM-NARR-1).
 *
 * ── THE DETERMINISTIC SUMMARY (always available, the default) ───────────────
 * `loadOwnerNarrativeSource` reads ONE Memory for its OWNER: the row, how many
 * items it holds, how many tags were approved. Any failed read is `unreadable`
 * (the route answers 503) — a summary built over a failed count would say
 * "no photos" about a Memory full of them (§28.11). Someone else's Memory, a
 * missing one and a deleted one are the same `not_found`. Nothing is written.
 *
 * ── THE OPTIONAL AI DRAFT — every gate fails closed, in this order ───────────
 *   1. FLAG `memory_narrative_ai_enabled` (3802, seeded FALSE): off or absent ⇒
 *      `feature_disabled`; unreadable ⇒ `unavailable` (never read as off-or-on);
 *   2. CONSENT `memory_narrative_ai_consent` (3802): one table for this one
 *      purpose (the inputConsent.ts / 3780 / 3782 pattern, copied, not shared:
 *      a grant elsewhere is never a grant here). Absent table or row ⇒ not
 *      consented; any other failure ⇒ `unavailable`, never "not consented";
 *   3. the OWNER's controls on THIS Memory (3671): DO_NOT_RESURFACE,
 *      KEEP_PRIVATE_FOREVER and RETAIN_BUT_DO_NOT_PERSONALIZE keep it from the
 *      model — the controls memoryReaderGuard excludes from `compass_tools`,
 *      the model-mediated reader of proposed ruling W-HM-PRIV-1 (taken as the
 *      fail-closed default for open owner question Q-NARR-3; it does NOT decide
 *      OD-1012-PRIV-3's open Compass half). Unreadable ⇒ `unavailable`.
 * Only then is the model called, through the EXISTING path (lib/openai.ts
 * getOpenAI → gpt-5-mini via the Replit AI-integrations proxy; no new provider),
 * with `narrativeAiFacts` only — the owner's own facts, the place at the
 * Memory's §10 rung, no coordinate, no tagged person's name, no other person's
 * text. Its draft must pass `checkAiNarrative`; otherwise, and on any model
 * error, the caller gets the deterministic summary and the reason.
 *
 * NOTHING IS STORED. Not the facts sent, not the draft, not the fallback
 * (fail-closed default for open owner question Q-NARR-4). The only write in
 * this module is the person's own consent row.
 */
import { getOpenAI } from "../../lib/openai.js";
import { readFlagState } from "../../lib/capability/schemaCapability.js";
import { isTableAbsentError } from "../../lib/tableAbsence.js";
import { readMemoryPrecisionGate, precisionColumnSelectable, type MemoryPrecisionGate } from "../../lib/memoryPrecisionGate.js";
import { hasValidInputConsent, type InputConsentRead, type InputConsentState } from "../../lib/inputAssistance/inputConsent.js";
import { readMemoryControls, type MemoryResurfacingControl } from "./memoryResurfacingControls.js";
import { controlsExcluding } from "./memoryReaderGuard.js";
import {
  MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION,
  NARRATIVE_AI_MODEL,
  NARRATIVE_AI_RENDERER,
  aiSupportingFactIds,
  buildNarrativeAiMessages,
  checkAiNarrative,
  narrativeAiFacts,
  renderDeterministicNarrative,
  type AiNarrativeRejection,
  type MemoryNarrative,
  type NarrativeCounts,
  type NarrativeMemoryRow,
  type OriginalText,
} from "./memoryNarrative.js";

// ── The source ────────────────────────────────────────────────────────────────

/**
 * The columns a narrative reads, as same-file literals (check:write-path-columns
 * resolves only literals and same-file string consts). `location_precision`
 * only when the §10 gate is ON — the column exists only where 2338 is applied.
 * The coordinate is read for ONE purpose: the time zone that decides which DAY
 * the Memory started on. It is never rendered and never sent.
 */
export const NARRATIVE_MEMORY_COLUMNS =
  "id, owner_id, title, caption, state, starts_at, location_city, location_country, location_lat, location_lng";
export const NARRATIVE_MEMORY_COLUMNS_WITH_PRECISION =
  "id, owner_id, title, caption, state, starts_at, location_city, location_country, location_lat, location_lng, location_precision";

export type NarrativeSource =
  | { state: "ok"; memory: NarrativeMemoryRow; counts: NarrativeCounts; precisionGate: MemoryPrecisionGate }
  | { state: "not_found" }
  | { state: "unreadable"; detail: string };

function countOf(res: { count?: number | null; error?: { message?: unknown } | null } | null | undefined, what: string): { ok: true; n: number } | { ok: false; detail: string } {
  if (!res) return { ok: false, detail: `${what}: no response` };
  if (res.error) return { ok: false, detail: `${what} unreadable: ${String(res.error.message ?? "read failed")}` };
  if (typeof res.count !== "number" || !Number.isFinite(res.count) || res.count < 0) return { ok: false, detail: `${what}: no count returned` };
  return { ok: true, n: res.count };
}

/**
 * ONE Memory, for its OWNER only. Three answers, never two: a Memory that could
 * not be READ is `unreadable`, not `not_found`.
 */
export async function loadOwnerNarrativeSource(sc: any, memoryId: string, ownerId: string): Promise<NarrativeSource> {
  const precisionGate = await readMemoryPrecisionGate(sc);
  // Two sites, one per gate state, each with a same-file constant (memoryActionService's shape).
  const { data, error } = precisionColumnSelectable(precisionGate)
    ? await sc.from("memories").select(NARRATIVE_MEMORY_COLUMNS_WITH_PRECISION).eq("id", memoryId).maybeSingle()
    : await sc.from("memories").select(NARRATIVE_MEMORY_COLUMNS).eq("id", memoryId).maybeSingle();
  if (error) return { state: "unreadable", detail: `memories unreadable: ${String(error.message ?? "read failed")}` };
  const row = data as (NarrativeMemoryRow & { state?: unknown }) | null;
  // Someone else's, missing, or deleted: the same answer. A narrative is the owner's alone.
  if (!row || row.owner_id !== ownerId || row.state === "deleted" || row.state === "removed") return { state: "not_found" };

  const [tags, items] = await Promise.all([
    sc.from("memory_tags").select("memory_id", { count: "exact", head: true }).eq("memory_id", memoryId).eq("status", "approved"),
    sc.from("memory_items").select("memory_id", { count: "exact", head: true }).eq("memory_id", memoryId),
  ]);
  const people = countOf(tags, "memory_tags");
  if (!people.ok) return { state: "unreadable", detail: people.detail };
  const photos = countOf(items, "memory_items");
  if (!photos.ok) return { state: "unreadable", detail: photos.detail };
  return { state: "ok", memory: row, counts: { photos: photos.n, people: people.n }, precisionGate };
}

/** The deterministic summary over a loaded source. Pure; the route's default. */
export function deterministicNarrativeOf(source: Extract<NarrativeSource, { state: "ok" }>): MemoryNarrative {
  return renderDeterministicNarrative(source.memory, source.counts);
}

// ── Gate 1: the flag ──────────────────────────────────────────────────────────

/**
 * on / off (off or absent: the seed has not run, or says no) / unreadable.
 * The flag name is written as a literal so check:flag-polarity can see the read;
 * it is MEMORY_NARRATIVE_AI_FLAG, and a test pins the two equal.
 */
export async function readNarrativeAiFlag(sc: any): Promise<"on" | "off" | "unreadable"> {
  const s = await readFlagState(sc, "memory_narrative_ai_enabled");
  if (s === "on") return "on";
  if (s === "unreadable") return "unreadable";
  return "off";
}

// ── Gate 2: the person's consent (3802) ───────────────────────────────────────

/**
 * The inputConsent.ts read, against THIS purpose's table, written as a literal.
 * An absent table holds nobody's consent, so "not consented" is a structural fact
 * there (42P01 / PGRST205 only). Every other failure is `{ ok: false }`.
 */
export async function readNarrativeAiConsent(sc: any, userId: string): Promise<InputConsentRead> {
  if (!userId) return { ok: false };
  try {
    const { data, error } = await sc
      .from("memory_narrative_ai_consent")
      .select("enabled, consent_version, consented_at, withdrawn_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return isTableAbsentError(error) ? { ok: true, state: null } : { ok: false };
    if (!data) return { ok: true, state: null };
    const r = data as Record<string, unknown>;
    return {
      ok: true,
      state: {
        enabled: r.enabled === true,
        consentVersion: typeof r.consent_version === "string" ? r.consent_version : null,
        consentedAt: typeof r.consented_at === "string" ? r.consented_at : null,
        withdrawnAt: typeof r.withdrawn_at === "string" ? r.withdrawn_at : null,
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * VALID for this feature: enabled, not withdrawn, AND stamped with the CURRENT
 * disclosure version. A grant recorded under older words is not consent to the
 * words shown today.
 */
export function narrativeAiConsentValid(state: InputConsentState | null | undefined): boolean {
  return hasValidInputConsent(state) && state!.consentVersion === MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION;
}

/** Did the client display exactly the current disclosure? */
export function displayedNarrativeDisclosureMatches(seen: unknown): boolean {
  return seen === MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION;
}

/**
 * Record a grant (server-stamped with the current version) or a withdrawal (the
 * record of what was once agreed to is kept; it is switched off and stamped).
 * The state is re-read; if the re-read fails, the state just written is returned.
 */
export async function writeNarrativeAiConsent(
  sc: any,
  userId: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<{ ok: true; state: InputConsentState } | { ok: false }> {
  if (!userId) return { ok: false };
  const at = now.toISOString();
  try {
    const { error } = enabled
      ? await sc.from("memory_narrative_ai_consent").upsert(
          { user_id: userId, enabled: true, consent_version: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, consented_at: at, withdrawn_at: null, updated_at: at },
          { onConflict: "user_id" },
        )
      : await sc.from("memory_narrative_ai_consent").upsert(
          { user_id: userId, enabled: false, withdrawn_at: at, updated_at: at },
          { onConflict: "user_id" },
        );
    if (error) return { ok: false };
  } catch {
    return { ok: false };
  }
  const read = await readNarrativeAiConsent(sc, userId);
  const state: InputConsentState =
    read.ok && read.state
      ? read.state
      : enabled
        ? { enabled: true, consentVersion: MEMORY_NARRATIVE_AI_DISCLOSURE_VERSION, consentedAt: at, withdrawnAt: null }
        : { enabled: false, consentVersion: null, consentedAt: null, withdrawnAt: at };
  return { ok: true, state };
}

// ── Gate 3: the owner's controls on this Memory (3671) ────────────────────────

/** The controls that keep a Memory from the model: memoryReaderGuard's model-mediated reader. */
export const NARRATIVE_AI_EXCLUDING_CONTROLS: ReadonlySet<MemoryResurfacingControl> = controlsExcluding("compass_tools");

export type NarrativeControls =
  | { state: "clear" }
  | { state: "excluded"; controls: MemoryResurfacingControl[] }
  | { state: "unreadable"; detail: string };

export async function narrativeAiControls(sc: any, ownerId: string, memoryId: string): Promise<NarrativeControls> {
  const read = await readMemoryControls(sc, ownerId, [memoryId]);
  if (read.state === "absent") return { state: "clear" }; // 3671 not applied: no control can exist
  if (read.state === "unreadable") return { state: "unreadable", detail: read.detail };
  const set = [...(read.byMemory.get(memoryId) ?? [])].filter((c) => NARRATIVE_AI_EXCLUDING_CONTROLS.has(c)).sort();
  return set.length > 0 ? { state: "excluded", controls: set } : { state: "clear" };
}

// ── The whole gate, for the GET's offer and the POST's refusal ────────────────

export type NarrativeAiGate =
  | { open: true }
  | { open: false; reason: "feature_disabled" | "unavailable" | "consent_required" }
  | { open: false; reason: "excluded_by_control"; controls: MemoryResurfacingControl[] };

/** Flag, then consent, then controls; the first "no" wins. Never throws. */
export async function narrativeAiGate(sc: any, ownerId: string, memoryId: string): Promise<NarrativeAiGate> {
  const flag = await readNarrativeAiFlag(sc);
  if (flag === "off") return { open: false, reason: "feature_disabled" };
  if (flag === "unreadable") return { open: false, reason: "unavailable" };
  const consent = await readNarrativeAiConsent(sc, ownerId);
  if (!consent.ok) return { open: false, reason: "unavailable" };
  if (!narrativeAiConsentValid(consent.state)) return { open: false, reason: "consent_required" };
  const controls = await narrativeAiControls(sc, ownerId, memoryId);
  if (controls.state === "unreadable") return { open: false, reason: "unavailable" };
  if (controls.state === "excluded") return { open: false, reason: "excluded_by_control", controls: controls.controls };
  return { open: true };
}

// ── The model ─────────────────────────────────────────────────────────────────

export const NARRATIVE_AI_TIMEOUT_MS = 20_000;
export const NARRATIVE_AI_MAX_COMPLETION_TOKENS = 600;

export type AiFallbackReason = "model_unavailable" | AiNarrativeRejection;

export interface AiNarrative {
  memory_id: string;
  renderer: string;
  summary: string;
  supporting_fact_ids: string[];
  original_text: OriginalText;
  original_language: MemoryNarrative["original_language"];
  editable: true;
  stored: false;
}

export type AiNarrativeOutcome =
  | { accepted: true; narrative: AiNarrative; deterministic: MemoryNarrative }
  | { accepted: false; fallback_reason: AiFallbackReason; deterministic: MemoryNarrative; /** for tests; never sent, never logged */ detail: string };

/**
 * Call the model with the AI-eligible facts and accept the draft only if it
 * passes `checkAiNarrative`. CALL ONLY WHEN `narrativeAiGate` IS OPEN — the gate
 * is not repeated here so a test can prove the CALLER checks it. Never throws.
 */
export async function draftAiNarrative(source: Extract<NarrativeSource, { state: "ok" }>): Promise<AiNarrativeOutcome> {
  const deterministic = renderDeterministicNarrative(source.memory, source.counts);
  const facts = narrativeAiFacts(source.memory, source.counts, source.precisionGate);
  let content = "";
  try {
    const completion: any = await getOpenAI().chat.completions.create(
      {
        model: NARRATIVE_AI_MODEL,
        max_completion_tokens: NARRATIVE_AI_MAX_COMPLETION_TOKENS,
        reasoning_effort: "low",
        messages: buildNarrativeAiMessages(facts),
      } as any,
      { timeout: NARRATIVE_AI_TIMEOUT_MS },
    );
    content = String(completion?.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    return { accepted: false, fallback_reason: "model_unavailable", deterministic, detail: String((err as { message?: unknown })?.message ?? err) };
  }
  const check = checkAiNarrative(content, facts);
  if (!check.ok) return { accepted: false, fallback_reason: check.reason, deterministic, detail: check.detail };
  return {
    accepted: true,
    deterministic,
    narrative: {
      memory_id: source.memory.id,
      renderer: NARRATIVE_AI_RENDERER,
      summary: check.summary,
      supporting_fact_ids: aiSupportingFactIds(source.memory.id, facts),
      original_text: deterministic.original_text,
      original_language: deterministic.original_language,
      editable: true,
      stored: false,
    },
  };
}
