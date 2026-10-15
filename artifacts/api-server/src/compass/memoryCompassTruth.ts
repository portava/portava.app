/**
 * memoryCompassTruth — what the Compass Memory tools may CLAIM about the thing
 * they were asked for, and what they read to back a claim.
 *
 * census-highlights-memories H262 H265 (cluster MEM-COMPASS-2) and H120 H123
 * H124 (cluster HM-A3), plus MEM-POLICY's follow-up (b58 lane HM-A3).
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §28.3  "Never query a semantic substitute for an unknown canonical
 *          place/person and pretend it is the requested entity."
 *   §28.14 "Always support unknown/unresolved entities truthfully."
 *   §28.16 "Always preserve original user voice and original-language text when
 *          generating summaries/translations."
 *   §16    "May summarize supported evidence." / "May propose a
 *          merge/split/correction."
 *   §3.3   MemoryEvidence { truth_level, confidence, provenance_json, … }
 *   §10    the person visibility ladder, which a participant COUNT is part of.
 *
 * ── §28.3, MEASURED BEFORE THIS FILE ─────────────────────────────────────────
 * `memory_search` and `memory_get_place_history` matched a city with
 * `location_city.toLowerCase().includes(city)`. A question about "York" came
 * back with every New York Memory and nothing marking them as a different
 * place. And a handle went to PostgREST's `ilike` unescaped, where `_` is a
 * single-character wildcard (and `*` becomes `%`): "@jo_n" resolved to "@john"
 * when no "@jo_n" exists — in `memory_get_shared` AND in `memory_create_draft`,
 * whose whole claim (census H74) is that a participant is an EXACT handle.
 *
 * Both are substitutes for an unknown entity presented as the asked one. What
 * replaces them:
 *   - names are compared EQUAL after NFC, whitespace collapse and case folding
 *     (`foldEntityName`) — never by substring, prefix, edit distance, diacritic
 *     stripping or any other resemblance;
 *   - a named city/country/place that matches nothing in the user's history is
 *     `UNRESOLVED` with zero rows, and one that names several countries'
 *     cities is `AMBIGUOUS` with the candidates and zero rows — the tool never
 *     picks;
 *   - a handle is matched literally (wildcards escaped, wildcard-shaped input
 *     refused before any query) and checked equal again in code.
 *
 * WHAT IT DOES NOT DO. A transliteration ("Da Nang" for "Đà Nẵng") is a
 * different string and is UNRESOLVED. That is the honest failure direction: a
 * false "nothing here" is recoverable by the user, a substituted place is not.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { escapeLikePattern } from "../lib/postgrestFilter.js";
import { isTableAbsentError } from "../lib/tableAbsence.js";
import { blockedAmong } from "../services/memory/memoryReadPolicy.js";
import {
  loadParticipantVisibility,
  projectParticipants,
  type ParticipantVisibilityContext,
} from "../services/memory/memoryParticipantVisibility.js";

// ═══════════════════════════════════════════════════════════════════════════
// §28.3 — a name is equal or it is not
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The ONE comparison a place word goes through. NFC (so a decomposed "Huế"
 * equals the composed one), whitespace runs collapsed and trimmed, then full
 * case folding (upper-then-lower folds "ß" to "ss" the way Unicode's
 * CaseFolding does). Nothing else: no accent stripping, no substring, no
 * synonym table. A non-string is the empty string, which no asked name equals.
 */
export function foldEntityName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim().toUpperCase().toLowerCase().normalize("NFC");
}

export type NamedEntityResolution = "NOT_ASKED" | "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS";

/** What the caller named, as given (trimmed, bounded) — never as matched. */
export interface PlaceAsk {
  readonly city: string | null;
  readonly country: string | null;
}

export interface PlaceCandidate {
  readonly city: string;
  readonly country: string | null;
  readonly memory_count: number;
}

export interface NamedPlaceOutcome {
  readonly resolution: NamedEntityResolution;
  readonly asked: PlaceAsk | null;
  /** Only for AMBIGUOUS: every distinct (city, country) the name matched. */
  readonly candidates: readonly PlaceCandidate[];
  /** Whether a row is one of the rows the asked name resolved to. */
  admits(row: unknown): boolean;
}

const MAX_NAME_CHARS = 100;

function askedWord(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.normalize("NFC").replace(/\s+/gu, " ").trim().slice(0, MAX_NAME_CHARS);
  return t.length > 0 ? t : null;
}

/** The `city` / `country` a memory tool was called with. */
export function readPlaceAsk(args: Record<string, unknown>): PlaceAsk {
  return { city: askedWord(args["city"]), country: askedWord(args["country"]) };
}

/**
 * Resolve a named city (and optional country) against the rows the viewer may
 * be told about — AFTER §10's clamp, so a city the owner's rung withholds is
 * not in the row and cannot be matched (no oracle).
 *
 *   nothing named            → NOT_ASKED, every row admitted (other filters apply)
 *   no row equal to the name → UNRESOLVED, no row admitted
 *   a city alone, and its equal rows carry ≥2 distinct recorded countries
 *                            → AMBIGUOUS, the candidates, no row admitted
 *   otherwise                → RESOLVED, exactly the equal rows admitted
 *
 * Ambiguity is judged over the WHOLE history, not after date or trip filters:
 * a date range does not say which Portland the user meant, so narrowing to one
 * would still be the tool's pick. A row whose country is not recorded does not
 * make a name ambiguous by itself — it IS a row with that city name.
 */
export function resolveNamedPlace(rows: readonly unknown[], ask: PlaceAsk): NamedPlaceOutcome {
  if (!ask.city && !ask.country) {
    return { resolution: "NOT_ASKED", asked: null, candidates: [], admits: () => true };
  }
  const wantCity = ask.city ? foldEntityName(ask.city) : null;
  const wantCountry = ask.country ? foldEntityName(ask.country) : null;
  const matched = new Set<unknown>();
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>;
    if (wantCity !== null && foldEntityName(row["location_city"]) !== wantCity) continue;
    if (wantCountry !== null && foldEntityName(row["location_country"]) !== wantCountry) continue;
    matched.add(r);
  }
  if (matched.size === 0) {
    return { resolution: "UNRESOLVED", asked: ask, candidates: [], admits: () => false };
  }
  if (wantCity !== null && wantCountry === null) {
    const countries = new Set<string>();
    const groups = new Map<string, { city: string; country: string | null; memory_count: number }>();
    for (const r of matched) {
      const row = (r ?? {}) as Record<string, unknown>;
      const folded = foldEntityName(row["location_country"]);
      if (folded) countries.add(folded);
      const g = groups.get(folded);
      if (g) g.memory_count += 1;
      else {
        groups.set(folded, {
          city: String(row["location_city"]).trim(),
          country: folded ? String(row["location_country"]).trim() : null,
          memory_count: 1,
        });
      }
    }
    if (countries.size >= 2) {
      const candidates = [...groups.values()].sort((a, b) => String(a.country ?? "").localeCompare(String(b.country ?? "")));
      return { resolution: "AMBIGUOUS", asked: ask, candidates, admits: () => false };
    }
  }
  return { resolution: "RESOLVED", asked: ask, candidates: [], admits: (row) => matched.has(row) };
}

/**
 * The answer a list tool gives when the named place is UNRESOLVED or AMBIGUOUS:
 * zero rows under the tool's own list key, the name as ASKED, and for an
 * ambiguous name the candidates — never a guess at which one was meant.
 */
export function unresolvedPlaceAnswer(
  outcome: NamedPlaceOutcome,
  listKey: "memories" | "visits",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const asked = outcome.asked;
  const name = [asked?.city, asked?.country].filter(Boolean).join(", ");
  return {
    resolution: outcome.resolution,
    asked,
    [listKey]: [],
    ...(outcome.resolution === "AMBIGUOUS" ? { candidates: outcome.candidates } : {}),
    ...extra,
    info:
      outcome.resolution === "AMBIGUOUS"
        ? `Several places in the user's own Memories are called "${name}" (see candidates). Ask which one they mean; do not pick one, and do not describe any of them as the place asked about until they say.`
        : `Nothing in the user's own Memories is "${name}". Say so. Do not offer a Memory from a place with a similar or longer name as this one.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §28.3 for people — a handle is matched literally
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input that cannot be a literal handle: PostgREST turns `*` into `%`, `%` and
 * `\` are LIKE syntax, and no handle has whitespace. Refused before any query.
 * (`_` IS legal in a handle — `lib/usernameRules.ts` USERNAME_RE — so it is
 * escaped, not refused.)
 */
const NOT_A_LITERAL_HANDLE = /[*%\\\s]/u;
const MAX_HANDLE_CHARS = 64;

export type HandleLookup =
  | { readonly state: "found"; readonly id: string; readonly handle: string }
  | { readonly state: "no_such_handle"; readonly asked: string }
  | { readonly state: "unavailable" };

/**
 * One exact, case-insensitive handle lookup. `_` and `%` are escaped so the
 * pattern is a literal, the result is checked EQUAL in code as well, and two
 * profiles that both equal the handle (a legacy case-variant pair) are
 * `unavailable` rather than a pick.
 */
export async function resolveExactHandle(sc: SupabaseClient, raw: string): Promise<HandleLookup> {
  const asked = String(raw ?? "").trim().replace(/^@/, "");
  if (!asked || asked.length > MAX_HANDLE_CHARS || NOT_A_LITERAL_HANDLE.test(asked)) return { state: "no_such_handle", asked };
  try {
    const { data, error } = await sc.from("profiles").select("id, handle").ilike("handle", escapeLikePattern(asked)).limit(2);
    if (error) return { state: "unavailable" };
    const want = asked.toLowerCase();
    const exact = ((data as Array<{ id: unknown; handle: unknown }> | null) ?? [])
      .filter((p) => typeof p.handle === "string" && p.handle.toLowerCase() === want);
    if (exact.length === 0) return { state: "no_such_handle", asked };
    if (exact.length > 1) return { state: "unavailable" };
    return { state: "found", id: String(exact[0]!.id), handle: String(exact[0]!.handle) };
  } catch {
    return { state: "unavailable" };
  }
}

/** `memory_get_shared`'s answer for a handle no profile has. */
export function unresolvedPersonAnswer(asked: string): Record<string, unknown> {
  return {
    resolution: "UNRESOLVED",
    asked: { person: `@${asked}` },
    person: null,
    memories: [],
    unconfirmed_participation: [],
    info: `No user has the handle @${asked}. Say so. Do not offer Memories with a person whose handle or name merely resembles it.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §28.16 — the owner's words, as stored
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BCP 47 "undetermined". `memories` stores no language for a title or caption
 * (no column anywhere in the tree), so none is claimed. ONE constant with the
 * owner's narrative (MEM-NARR-1, census §BI): both halves of H265 say the same
 * thing about the same words. A guessed language would be an invented fact.
 */
export { ORIGINAL_LANGUAGE_UNDETERMINED } from "../services/memory/memoryNarrative.js";

/**
 * The owner's own title and caption exactly as stored, inside the same
 * `<portava:ugc>` envelope every user-written string reaches the model in
 * (`CompassStructuredContext.wrapUgc`, passed in to keep this file free of the
 * prompt module). The envelope is transport: the text between the markers is
 * the stored bytes.
 */
export function originalTextOf(
  row: { title?: unknown; caption?: unknown } | null | undefined,
  wrap: (s: string) => string,
): { title: string | null; caption: string | null } {
  return {
    title: typeof row?.title === "string" ? wrap(row.title) : null,
    caption: typeof row?.caption === "string" ? wrap(row.caption) : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §16 getMemoryEvidence — §3.3's provenance, read where it exists (H120, H123)
// ═══════════════════════════════════════════════════════════════════════════

export const PROVENANCE_MAX_EPISODES = 10;
export const PROVENANCE_MAX_RECORDS = 50;

// Literals, not joins: check:write-path-columns reads a select list only when
// it is a literal or a same-file string const.
const EVIDENCE_LINK_SELECT = "episode_id";
const EPISODE_PROVENANCE_SELECT = "id, detection_reason, detector_version, significance, significance_basis, state, started_at, ended_at";
const EVIDENCE_PROVENANCE_SELECT = "episode_id, truth_level, source_class, source_table, observed_at, weight";

export interface ProvenanceRecord {
  /** 2320: asserted | observed | corroborated | inferred — how well it is known. */
  truth_level: string | null;
  /** 2320: explicit | system | inferred | live — what class of source. */
  source_class: string | null;
  /** What the record cites, as a kind and never as an id or a coordinate. */
  source_kind: "owner_confirmation" | "captured_media" | "other_record";
  observed_at: string | null;
  /** 2320 `weight`, 0..1: the confidence the producer gave this record. */
  confidence: number | null;
}

export interface ProvenanceEpisode {
  detection_reason: string | null;
  detector_version: number | null;
  significance: number | null;
  significance_basis: string | null;
  state: string | null;
  started_at: string | null;
  ended_at: string | null;
  records: ProvenanceRecord[];
}

export type ProvenanceRead =
  | { store: "present"; reason: string; provenance: ProvenanceEpisode[]; truncated: boolean }
  | { store: "not_deployed"; reason: string }
  | { store: "unavailable"; reason: string }
  | { store: "owner_only"; reason: string };

export const PROVENANCE_REASONS = Object.freeze({
  present:
    "Assertion-level provenance comes from §3.3's memory_evidence (migration 2320). Each record carries its truth_level — asserted (the owner said so), observed (a captured photo or video), corroborated, inferred — and a 0-1 confidence. It records how the app came to suggest this Memory; it is NOT proof that anything happened.",
  presentNone:
    "memory_evidence holds no record for this Memory: it was not kept from a detected episode, so its facts are the owner's own entries, with no recorded provenance or confidence.",
  notDeployed:
    "§3.3's memory_evidence is created by migration 2320, which is not applied on this deployment, so no assertion in this Memory has a provenance record, a confidence score or an eligibility verdict attached to it.",
  unavailable:
    "The provenance store could not be read. This does NOT mean the Memory has no recorded provenance — say that it could not be looked up.",
  ownerOnly:
    "Provenance records are shown only to the Memory's owner, so none is described here.",
});

function sourceKindOf(table: unknown): ProvenanceRecord["source_kind"] {
  if (table === "memories") return "owner_confirmation";
  if (table === "media_assets") return "captured_media";
  return "other_record";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * The provenance §3.3 asks for, for ONE Memory, read from the 2320 spine.
 *
 *   viewer is not the owner → `owner_only`, and NOTHING is read: the answer is
 *                             the same whether provenance exists or not, so it
 *                             is not an oracle for "was this auto-detected"
 *                             (owner question Q-HMA3-1).
 *   table absent            → `not_deployed` (42P01 / PGRST205 only)
 *   any other read failure  → `unavailable` — never "none"
 *   no link row             → `present`, `provenance: []`, said in words
 *   link rows               → `present`, each episode with its records
 *
 * Every read is scoped to the OWNER's `user_id` as well as the id it follows.
 * Nothing returned names a source id, a `source_ref`, a place or a coordinate.
 */
export async function readMemoryProvenance(
  sc: SupabaseClient,
  memory: { id: unknown; owner_id: unknown },
  viewerId: string,
): Promise<ProvenanceRead> {
  if (memory.owner_id !== viewerId) return { store: "owner_only", reason: PROVENANCE_REASONS.ownerOnly };
  const ownerId = String(memory.owner_id);
  const memoryId = String(memory.id);
  const unavailable: ProvenanceRead = { store: "unavailable", reason: PROVENANCE_REASONS.unavailable };
  try {
    const links = await sc
      .from("memory_evidence")
      .select(EVIDENCE_LINK_SELECT)
      .eq("user_id", ownerId)
      .eq("source_table", "memories")
      .eq("source_id", memoryId)
      .limit(PROVENANCE_MAX_EPISODES + 1);
    if (links.error) {
      return isTableAbsentError(links.error) ? { store: "not_deployed", reason: PROVENANCE_REASONS.notDeployed } : unavailable;
    }
    if (!Array.isArray(links.data)) return unavailable;
    const allIds = [...new Set((links.data as Array<{ episode_id: unknown }>).map((l) => String(l.episode_id ?? "")).filter(Boolean))];
    if (allIds.length === 0) return { store: "present", reason: PROVENANCE_REASONS.presentNone, provenance: [], truncated: false };
    const episodeIds = allIds.slice(0, PROVENANCE_MAX_EPISODES);

    const episodes = await sc.from("memory_episodes").select(EPISODE_PROVENANCE_SELECT).eq("user_id", ownerId).in("id", episodeIds);
    // An absent memory_episodes beside a readable memory_evidence is half a
    // spine: unreadable, not "not deployed".
    if (episodes.error || !Array.isArray(episodes.data)) return unavailable;
    const records = await sc
      .from("memory_evidence")
      .select(EVIDENCE_PROVENANCE_SELECT)
      .eq("user_id", ownerId)
      .in("episode_id", episodeIds)
      .limit(PROVENANCE_MAX_RECORDS + 1);
    if (records.error || !Array.isArray(records.data)) return unavailable;

    const recordRows = records.data as Array<Record<string, unknown>>;
    const byEpisode = new Map<string, ProvenanceRecord[]>();
    for (const r of recordRows.slice(0, PROVENANCE_MAX_RECORDS)) {
      const list = byEpisode.get(String(r["episode_id"])) ?? [];
      list.push({
        truth_level: strOrNull(r["truth_level"]),
        source_class: strOrNull(r["source_class"]),
        source_kind: sourceKindOf(r["source_table"]),
        observed_at: strOrNull(r["observed_at"]),
        confidence: numOrNull(r["weight"]),
      });
      byEpisode.set(String(r["episode_id"]), list);
    }
    const provenance: ProvenanceEpisode[] = [];
    for (const e of episodes.data as Array<Record<string, unknown>>) {
      provenance.push({
        detection_reason: strOrNull(e["detection_reason"]),
        detector_version: numOrNull(e["detector_version"]),
        significance: numOrNull(e["significance"]),
        significance_basis: strOrNull(e["significance_basis"]),
        state: strOrNull(e["state"]),
        started_at: strOrNull(e["started_at"]),
        ended_at: strOrNull(e["ended_at"]),
        records: byEpisode.get(String(e["id"])) ?? [],
      });
    }
    const truncated = allIds.length > PROVENANCE_MAX_EPISODES || recordRows.length > PROVENANCE_MAX_RECORDS;
    return { store: "present", reason: PROVENANCE_REASONS.present, provenance, truncated };
  } catch {
    return unavailable;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §10 — a participant COUNT goes through the same ladder as a participant
// ═══════════════════════════════════════════════════════════════════════════

export type EvidenceParticipantCounts =
  | { ok: true; confirmed: number; unconfirmed: number; unidentified: number }
  | { ok: false; detail: string };

/**
 * The counts `memory_get_evidence` may state, decided by the ladder the detail
 * read (`GET /memories/:id`) applies — `loadParticipantVisibility` +
 * `projectParticipants` — so a person this viewer may not see is not counted
 * here either. Before this, the tool counted every approved and pending tag for
 * any Memory Compass could read: a participant who had blocked the viewer, or
 * whom the viewer had blocked, was still "1 confirmed participant", and a
 * crew-scoped participant was counted for a viewer outside the crew.
 *
 *   confirmed     approved, and identifiable to this viewer
 *   unconfirmed   pending, and identifiable to this viewer (the owner; the
 *                 participant themself)
 *   unidentified  §10's ANONYMOUS_COUNT — people this viewer may know were
 *                 tagged but not who; never attendance
 *
 * FAIL CLOSED, AS A WITHHELD COUNT. The block read here is the definitive one
 * (`blockedAmong`, which reports a failure instead of folding it into
 * "blocked"): unreadable ⇒ `ok: false` and the caller states NO number, because
 * a zero computed from a failed read is a claim about the Memory (§28.11).
 * The owner's people ceiling (MEM-POLICY, migration 3810, PR #736 — not on main
 * when this was written) arrives through `loadParticipantVisibility`, which
 * reads it from the Memory row's `id`; when it lands, an UNREADABLE ceiling is
 * withheld here too (`countParticipantsUnderLadder`) rather than counted as the
 * HIDDEN it collapses to.
 */
export async function evidenceParticipantCounts(
  sc: SupabaseClient,
  memory: { id?: unknown; owner_id: string; visibility?: string | null; trip_id?: string | null },
  viewerId: string,
  tagRows: ReadonlyArray<{ tagged_user_id?: unknown; status?: unknown }>,
): Promise<EvidenceParticipantCounts> {
  const tags = tagRows
    .filter((t) => typeof t?.tagged_user_id === "string" && t.tagged_user_id.length > 0)
    .map((t) => ({ tagged_user_id: String(t.tagged_user_id), status: t.status ?? null }));
  if (tags.length === 0) return { ok: true, confirmed: 0, unconfirmed: 0, unidentified: 0 };
  const ids = [...new Set(tags.map((t) => t.tagged_user_id))];
  try {
    const blocked = await blockedAmong(sc, viewerId, ids);
    if (!blocked.ok) return { ok: false, detail: "blocks unreadable" };
    const ctx = await loadParticipantVisibility(sc, memory, viewerId, ids);
    return countParticipantsUnderLadder({ ...ctx, blockedIds: blocked.blocked }, tags);
  } catch (err) {
    return { ok: false, detail: String((err as { message?: unknown })?.message ?? err) };
  }
}

/** Pure half of `evidenceParticipantCounts`, so the ladder can be driven directly. */
export function countParticipantsUnderLadder(
  ctx: ParticipantVisibilityContext,
  tags: ReadonlyArray<{ tagged_user_id: string; status?: unknown }>,
): EvidenceParticipantCounts {
  // Structural, so it binds the day MEM-POLICY's `personCeilings` exists on the
  // context and is inert until then.
  const ceilingState = (ctx as unknown as { personCeilings?: { state?: unknown } }).personCeilings?.state;
  if (ceilingState === "unreadable") return { ok: false, detail: "the owner's people ceiling is unreadable" };
  const projected = projectParticipants(ctx, tags);
  return {
    ok: true,
    confirmed: projected.participants.filter((p) => p.status === "approved").length,
    unconfirmed: projected.participants.filter((p) => p.status === "pending").length,
    unidentified: projected.anonymousCount,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §16 "May propose a merge/split" (H124) — the preconditions and the schemas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The flag `routes/memoryGraph.ts` gates `POST /memories/merge` and
 * `POST /memories/:id/split` on (migration 3674, seeded FALSE). Restated here
 * rather than imported because importing a route module into the tool layer
 * drags the deletion lifecycle into Compass's import graph;
 * memoryCompassTruth.test.ts pins the two equal, with the two bounds below.
 */
export const MEMORY_MERGE_SPLIT_FLAG = "memory_merge_split_enabled";
export const PROPOSE_MERGE_MAX_ABSORBED = 20;
export const PROPOSE_SPLIT_MAX_ITEMS = 200;

/** The two proposals, as §16's LLM-boundary sentence names them. */
export const MEMORY_PROPOSAL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "propose a merge": "memory_propose_merge",
  "propose a split": "memory_propose_split",
});

function sortedDistinct(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.map(String))].sort() : [];
}

/**
 * 3676's audience rule, restated so a proposal is never one the kernel would
 * refuse with MEMORY_MERGE_AUDIENCE_MISMATCH: state, visibility, the allow-list
 * and the hide-list as sets, and the trip under `trip_crew`, must be identical.
 * A merge never moves content to a wider audience and never publishes a draft.
 */
export function mergeAudienceKey(row: Record<string, unknown>): string {
  return JSON.stringify([
    row["state"] ?? null,
    row["visibility"] ?? null,
    sortedDistinct(row["allowed_user_ids"]),
    sortedDistinct(row["hidden_user_ids"]),
    row["visibility"] === "trip_crew" ? (row["trip_id"] ?? null) : null,
  ]);
}

export function mergeAudiencesDiffer(rows: ReadonlyArray<Record<string, unknown>>): boolean {
  return new Set(rows.map(mergeAudienceKey)).size > 1;
}

export const MEMORY_PROPOSAL_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "memory_propose_merge",
      description:
        "Propose merging several of the user's OWN Memories of the same moment into one (§16 'may propose a merge'). WRITES NOTHING — returns the proposal for the user to confirm in the app. Refused when merging is not available, when any Memory is not the user's, or when the Memories do not share one audience (a merge never widens who can see something).",
      parameters: {
        type: "object",
        properties: {
          survivorId:  { type: "string", description: "The Memory that remains." },
          absorbedIds: { type: "array", items: { type: "string" }, description: `The Memories folded into it (1-${PROPOSE_MERGE_MAX_ABSORBED}).` },
        },
        required: ["survivorId", "absorbedIds"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_propose_split",
      description:
        "Propose moving some photos/videos of one of the user's OWN Memories into a new Memory (§16 'may propose a split'). WRITES NOTHING — returns the proposal for the user to confirm in the app. At least one item must stay on the original.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "The Memory to split." },
          itemIds:  { type: "array", items: { type: "string" }, description: `The items that move to the new Memory (1-${PROPOSE_SPLIT_MAX_ITEMS}).` },
          title:    { type: "string", description: "Optional title for the new Memory." },
        },
        required: ["memoryId", "itemIds"],
        additionalProperties: false,
      },
    },
  },
];

