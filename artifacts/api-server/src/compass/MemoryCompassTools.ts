/**
 * MemoryCompassTools — §16's Compass contract, as eight accessors and two proposals.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *       §16 "Compass Contract" names exactly eight:
 *           getMemory(memoryId)          searchMemories(query)
 *           getSharedMemories(personId)  getPlaceHistory(placeId)
 *           getTripMemories(tripId)      getMemoryEvidence(memoryId)
 *           createMemoryDraft(input)     suggestMemoryCorrection(memoryId, patch)
 *       followed by the sentence that decides what they may do: "Compass is a
 *       consumer of Memory facts, not the owner of historical truth. It may
 *       explain and compare Memories, suggest drafts, and turn them into current
 *       actions, but it must not mutate canonical facts through prose generation."
 *
 * CENSUS: census-highlights-memories.md graded H115–H122 as NOT-BUILT ×8 with one
 *         piece of evidence — none of the Compass tools is memory-facing — and
 *         H123–H128 as NOT-BUILT ×6 because "no memory-facing LLM path exists to
 *         constrain". Section B.7 re-tested the first claim mechanically on the
 *         merged tree and recorded the greps that decide it:
 *
 *             grep -cE 'name: "[a-z_]*(memor|highlight|storie)'   → 0
 *             grep -E  '\.from\("(memories|memory_*|highlights|…)"' → nothing
 *
 *         Both are FALSE once this file is registered. That is the point of it,
 *         and section C re-runs both greps rather than asserting the change.
 *
 * ONE GATE, CALLED BY ALL EIGHT
 * =============================
 * `canCompassReadMemory` (`services/memory/memoryReadPolicy.ts`) is §23's
 * `canReadMemory(userId, memoryId, surface)` on the `"compass"` surface AND the
 * bidirectional block check, in one call. These tools do not re-derive the
 * audience ladder; they call the same function `routes/memories.ts` calls, which
 * is why moving it out of that route file was the first change in this pass.
 *
 * WHAT THESE TOOLS STRUCTURALLY CANNOT DO
 * =======================================
 *   - WRITE. Not one of the ten issues an INSERT, UPDATE or DELETE. The four
 *     write-shaped ones return a PROPOSAL the user confirms through the existing
 *     authenticated routes (`POST /memories`, `PATCH /memories/:id`, merge, split), which
 *     re-authorize from scratch. This is `add_to_trip`'s posture and Telegraph's
 *     `telegraph_create_plan_draft`'s, not a new one. Census H129 ("Compass must
 *     not mutate canonical Memory facts through prose") is BUILT-AND-CORRECT and
 *     must stay that way after this file exists.
 *   - RETURN A COORDINATE. `MEMORY_FACT_COLUMNS` does not select
 *     `location_lat` / `location_lng`, and `executeCompassTool` runs every
 *     result through `sanitizeToolResult` afterwards as defence in depth.
 *   - STATE A CURRENT FACT. Every Memory fact leaves here as a `HistoricalFact`
 *     carrying `establishes_current_status: false` (§14). The one tool with a
 *     current-world half, `memory_get_place_history`, gets it from a FRESH
 *     reading or not at all.
 *   - ASSERT AN UNCONFIRMED PARTICIPANT. `memory_tags` has three statuses and
 *     only `approved` is attendance. A `pending` tag is the OWNER'S assertion
 *     that somebody was there; it is reported under `unconfirmed_participants`
 *     with that word in the key, and `removed` is not reported at all. §16:
 *     "May not invent … participants … attendance".
 *
 * THE CEILING, BEFORE ANYONE READS THE ROWS AS MORE THAN THEY ARE
 * ===============================================================
 *   - `memory_get_evidence` reads §3.3's `memory_evidence` where it exists. It
 *     is migration 2320 (written, and applied to no database when this was
 *     written), so without it the honest answer is `not_deployed`; an unreadable
 *     store is `unavailable`, never "none"; provenance goes to the OWNER only. The
 *     artifacts ATTACHED to a Memory are returned too, and the payload says they
 *     are not §6-normalized evidence.
 *   - `memory_search` is a deterministic query over canonical `memories`, not
 *     §15's derivative-backed `services/memoryRetrieval/searchMemories.ts`. That
 *     module reads registered derivatives out of `memory_derivative_registry`,
 *     which is migration 2730 and unapplied, so it cannot serve a production
 *     request. H110–H114 are unmoved by this file.
 *   - Merge and split are PROPOSED, never performed: `memory_propose_merge` and
 *     `memory_propose_split` (end of file) return what `POST /memories/merge` and
 *     `POST /memories/:id/split` would do, and refuse while those routes' flag
 *     (`memory_merge_split_enabled`, migration 3674) is off. Both write nothing.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../lib/logger.js";
import { wrapUgc } from "./CompassStructuredContext.js";
import { getLiveVenueStatus, liveVenueAnchorOf } from "../lib/liveIntelligence.js";
import { readMemoryPrecisionGate, precisionColumnSelectable, precisionClampApplies } from "../lib/memoryPrecisionGate.js";
import { memoryPlaceLabelsForNonOwner } from "./memoryPlaceLabels.js";
import { publicationPrecision } from "../lib/memoryLocationPrecision.js";
import {
  canCompassReadMemory,
  acceptedCrewOfTrip,
  VISIBILITY_VALUES,
} from "../services/memory/memoryReadPolicy.js";
import {
  asHistoricalFact,
  currentWorldReading,
  currentWorldUnknown,
  fuseHistoricalWithCurrent,
  type CurrentWorldReading,
  type FusedAnswer,
  type HistoricalFact,
} from "../services/memory/historicalTruth.js";
import { guardMemoryRows } from "../services/memory/memoryReaderGuard.js"; // census H48 H49 H73 H87 H187 H188 H210 (RECON-W A1): the owner's per-Memory controls
import { hiddenItemKeys, itemKey } from "../services/memory/memoryItemVisibility.js"; import { readPlaceAsk, resolveNamedPlace, unresolvedPlaceAnswer, resolveExactHandle, unresolvedPersonAnswer, originalTextOf, ORIGINAL_LANGUAGE_UNDETERMINED, readMemoryProvenance, evidenceParticipantCounts, MEMORY_MERGE_SPLIT_FLAG, PROPOSE_MERGE_MAX_ABSORBED, PROPOSE_SPLIT_MAX_ITEMS, mergeAudiencesDiffer, MEMORY_PROPOSAL_TOOL_DEFINITIONS } from "./memoryCompassTruth.js"; import { isFlagEnabled } from "../lib/featureFlags.js"; // census H80: a photo the owner keeps to themself; census H262 H265 H120 H123 H124 (b58 HM-A3): one line, because the lines below are cited

const log = rootLogger.child({ mod: "memoryCompassTools" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** §16's eight names, in the spec's order, mapped to the tool names used here. */
export const MEMORY_TOOL_SPEC_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "getMemory(memoryId)": "memory_get",
  "searchMemories(query)": "memory_search",
  "getSharedMemories(personId)": "memory_get_shared",
  "getPlaceHistory(placeId)": "memory_get_place_history",
  "getTripMemories(tripId)": "memory_get_trip_memories",
  "getMemoryEvidence(memoryId)": "memory_get_evidence",
  "createMemoryDraft(input)": "memory_create_draft",
  "suggestMemoryCorrection(memoryId, patch)": "memory_suggest_correction",
});

/**
 * The columns a Memory fact is built from.
 *
 * `allowed_user_ids` and `hidden_user_ids` are selected because §23's ladder
 * reads them, and they are NEVER placed in a result — `toMemoryFact` builds the
 * payload field by field rather than spreading the row, so a column added to
 * this list cannot leak by default.
 *
 * NO COORDINATE COLUMN IS SELECTED. `routes/memories.ts` selects them and then
 * coarsens through `protectMemoryRow`, because a map pin needs a number. A chat
 * answer does not, so the safe thing here is not to have them: `location_city`
 * and `location_country` are the whole of the disclosed geography.
 *
 * The §10 rung (`memories.location_precision`) is NOT in this list, because
 * the column is migration 2338 and production does not have it. It is read
 * separately, and only when the gate is definitely on, by
 * `withPlaceLabelsForViewer` below, which every tool runs over its rows before
 * a city or country is matched, scored or returned. (Until 2026-10-07 the rung
 * was not consulted at all, so an owner's `country` or `hidden` rung was
 * ignored here; lane R found it.)
 */
const MEMORY_FACT_COLUMNS =
  "id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, state, " +
  "trip_id, event_id, place_id, canonical_location_id, starts_at, ends_at, created_at, updated_at, " +
  "location_city, location_country";

/** The rung read, by id, when the precision gate is definitely on. A literal. */
const MEMORY_PRECISION_COLUMNS = "id, location_precision";

// memoryPlaceLabelsForNonOwner lives in ./memoryPlaceLabels.ts (shared with the
// intelligence graph, census-compass §47); re-exported here for this file's callers.
export { memoryPlaceLabelsForNonOwner } from "./memoryPlaceLabels.js";

/**
 * §10 on every row a tool is about to match, score or return. Another person's
 * Memory carries only the place words its owner's rung allows the viewer; the
 * viewer's own rows are unchanged; nothing is read when every row is the viewer's.
 *
 * The gate is the routes' three-state one (lib/memoryPrecisionGate.ts):
 *   - definitely OFF: rows unchanged (production today: the column does not exist);
 *   - UNREADABLE: clamp, and do NOT name the column (it may not exist), so every
 *     other person's row resolves to 'hidden' and loses both words;
 *   - ON: read `location_precision` by id. A failed read is not "exact". The
 *     rows keep no rung, so they are 'hidden' too.
 * A `location_precision` already on a row is dropped first: only the dedicated
 * read decides.
 *
 * Applied BEFORE the city and place filters and the token scorer, so neither a
 * city nor a placeId argument can be used to test where a hidden Memory is. The
 * place, canonical location and event ids are served only at `exact`/`venue`.
 * A tripId argument is the same oracle in trip form: `memory_get_trip_memories`
 * drops another person's row whose clamped `trip_id` no longer names the trip.
 */
async function withPlaceLabelsForViewer(sc: SupabaseClient, rows: any[], viewerId: string): Promise<any[]> {
  const others = rows.filter((r) => r?.owner_id !== viewerId);
  if (others.length === 0) return rows;
  const gate = await readMemoryPrecisionGate(sc);
  const clamp = precisionClampApplies(gate);
  if (!clamp) return rows;
  const rungs = new Map<string, unknown>();
  if (precisionColumnSelectable(gate)) {
    const ids = [...new Set(others.map((r) => String(r.id)))].slice(0, CANDIDATE_SCAN_LIMIT);
    const { data, error } = await sc.from("memories").select(MEMORY_PRECISION_COLUMNS).in("id", ids);
    if (error) {
      log.warn({ err: error, viewerId }, "memory tools: location_precision read failed — other people's place words withheld");
    } else {
      for (const r of ((data as any[]) ?? [])) rungs.set(String(r.id), r.location_precision);
    }
  }
  return rows.map((r) => {
    if (r?.owner_id === viewerId) return r;
    const { location_precision: _unread, ...base } = r ?? {};
    const withRung = rungs.has(String(r.id)) ? { ...base, location_precision: rungs.get(String(r.id)) } : base;
    const { city, country } = memoryPlaceLabelsForNonOwner(withRung, clamp);
    // A place, a canonical location or an event names a VENUE: served only at
    // the `exact` or `venue` rung, with the same failure direction as the words
    // (unreadable gate or label -> 'hidden' -> none). census-compass §48.
    const rung = publicationPrecision(withRung, clamp);
    const venue = rung === "exact" || rung === "venue";
    const had = (v: unknown) => (typeof v === "string" && v.trim().length > 0) || (typeof v === "number");
    const venueIdsWithheld = !venue && (had(base.place_id) || had(base.canonical_location_id) || had(base.event_id));
    // A trip names its destination: a CITY fact (the graph's during_trip rule,
    // census-compass §47), so its id goes only where the city word may.
    const cityAllowed = rung !== "country" && rung !== "hidden";
    const tripWithheld = !cityAllowed && had(base.trip_id);
    const withheld = (had(base.location_city) && !city) || (had(base.location_country) && !country) || venueIdsWithheld || tripWithheld;
    return {
      ...base,
      location_city: city,
      location_country: country,
      ...(venue ? {} : { place_id: null, canonical_location_id: null, event_id: null }),
      ...(cityAllowed ? {} : { trip_id: null }),
      ...(withheld ? { place_withheld: true } : {}),
    };
  });
}

/**
 * THE OWNER'S CONTROLS (census H48 H49 H73 H87 H187 H188 H210; RECON-W A1).
 * Every Memory row a tool is about to match, score or return goes through
 * `guardMemoryRows` on the `compass_tools` reader FIRST, before §10's labels:
 *   - a Memory whose owner set DO_NOT_RESURFACE, KEEP_PRIVATE_FOREVER or
 *     RETAIN_BUT_DO_NOT_PERSONALIZE (3671) is not handed to the model at all,
 *     whoever is asking (proposed ruling W-HM-PRIV-1);
 *   - every other one carries the place its owner asserted, minus every place
 *     they rejected (3673, memoryCorrections.placesThroughCorrections), so the
 *     place filter and the place ids below are the owner's word, not the stored
 *     pick or the automatic match.
 * Either table unreadable (not absent) ⇒ `ok:false`, and the tool refuses: a
 * Memory whose owner's settings could not be checked is not described.
 */
async function honourOwnerControls(sc: SupabaseClient, rows: any[], viewerId: string): Promise<{ ok: true; rows: any[]; excluded: ReadonlySet<string> } | { ok: false; reason: string }> {
  const guarded = await guardMemoryRows(sc, "compass_tools", rows, new Date());
  if (!guarded.ok) {
    log.error({ detail: guarded.detail, viewerId }, "memory tools: owner controls unreadable — withholding every Memory rather than ignoring them");
    return { ok: false, reason: CONTROLS_UNREADABLE };
  }
  return guarded;
}

const CONTROLS_UNREADABLE = "The privacy settings on these Memories could not be checked right now, so none of them is shared with the assistant. Say that it could not be looked up.";
const OWNER_EXCLUDED = "The user has set this Memory so the assistant does not bring it up or use it. Tell them it can be changed in the Memory's settings; do not describe it.";

/** Bound on every list this file returns, so a tool result stays a tool result. */
const MAX_RESULTS = 10;
const CANDIDATE_SCAN_LIMIT = 200;

export interface MemoryToolRefusal {
  authorized: false;
  reason: string;
}

function refuse(reason: string): MemoryToolRefusal {
  return { authorized: false, reason };
}

/** A Memory as §16 hands it to the model: past tense, no coordinates, no owner id. */
export interface MemoryFactPayload {
  memory_id: string;
  owned_by_viewer: boolean;
  title: string | null;
  caption: string | null; /** §28.16 (H265): the owner's own words exactly as stored, and their language — "und", because none is stored. */ original_text: { title: string | null; caption: string | null }; original_language: typeof ORIGINAL_LANGUAGE_UNDETERMINED;
  city: string | null;
  country: string | null;
  /** §10: the owner's location-precision rung withholds some of this Memory's place words from this viewer. */
  place_withheld?: true;
  place_id: string | null;
  trip_id: string | null;
  event_id: string | null;
  occurred_at: string | null;
  occurred_until: string | null;
  recorded_at: string | null;
  visibility: string | null;
  historical: HistoricalFact;
}

function subjectOf(row: any): string {
  const t = typeof row?.title === "string" && row.title.trim() ? String(row.title).trim() : null;
  if (t) return t;
  const city = typeof row?.location_city === "string" && row.location_city.trim() ? String(row.location_city).trim() : null;
  return city ?? "an unnamed Memory";
}

/**
 * The past-tense sentence a Memory supports, built from columns and nothing else.
 *
 * It is assembled here rather than left to the model because §16 forbids
 * inventing "historical outcomes": a claim the app states itself is a claim the
 * app can be held to, and a claim the model composes from loose fields is not.
 */
function claimOf(row: any): string {
  const where = [row?.location_city, row?.location_country]
    .filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)
    .join(", ");
  const when = typeof row?.starts_at === "string" ? row.starts_at.slice(0, 10) : null;
  const head = subjectOf(row);
  if (where && when) return `Recorded: "${head}" — ${where}, on ${when}.`;
  if (where) return `Recorded: "${head}" — ${where}. No date is recorded.`;
  // §10: a place the owner's rung withholds from this viewer is not "no place".
  const unplaced = row?.place_withheld === true ? "Its place is not shared with this user." : null;
  if (when) return `Recorded: "${head}" — on ${when}. ${unplaced ?? "No place is recorded."}`;
  return unplaced ? `Recorded: "${head}". No date is recorded. ${unplaced}` : `Recorded: "${head}". Neither a place nor a date is recorded.`;
}

function toMemoryFact(row: any, viewerId: string, nowMs: number): MemoryFactPayload {
  const occurredAt: string | null = (row?.starts_at as string | null) ?? null;
  return {
    memory_id: String(row.id),
    owned_by_viewer: row.owner_id === viewerId,
    title: typeof row.title === "string" ? wrapUgc(row.title) : null,
    caption: typeof row.caption === "string" ? wrapUgc(row.caption) : null, original_text: originalTextOf(row, wrapUgc), original_language: ORIGINAL_LANGUAGE_UNDETERMINED,
    city: (row.location_city as string | null) ?? null,
    country: (row.location_country as string | null) ?? null,
    ...(row?.place_withheld === true ? { place_withheld: true as const } : {}),
    place_id: (row.place_id as string | null) ?? null,
    trip_id: (row.trip_id as string | null) ?? null,
    event_id: (row.event_id as string | null) ?? null,
    occurred_at: occurredAt,
    occurred_until: (row.ends_at as string | null) ?? null,
    recorded_at: (row.created_at as string | null) ?? null,
    visibility: (row.visibility as string | null) ?? null,
    historical: asHistoricalFact({
      subject: subjectOf(row),
      claim: claimOf(row),
      asOf: occurredAt ?? ((row.created_at as string | null) ?? null),
      nowMs,
    }),
  };
}

// ── Candidate sets ────────────────────────────────────────────────────────────

/**
 * The viewer's OWN history: Memories they own, plus Memories they are tagged in.
 *
 * This is the namespace `memory_search`, `memory_get_shared` and
 * `memory_get_place_history` draw from, and it is narrow on purpose. §15 names
 * three namespaces and says they must have hard isolation; this file implements
 * ONE of them — the private personal one — and does not pretend to the other
 * two. A question to your own assistant about your own past is answered from
 * your own past.
 *
 * FAIL CLOSED. An unreadable `memory_tags` read returns `ok: false` rather than
 * an empty set, because "you are tagged in nothing" and "I could not find out"
 * are different answers and supabase-js resolves on a database error.
 */
async function ownHistoryIds(
  sc: SupabaseClient,
  viewerId: string,
): Promise<{ ok: true; taggedIds: string[] } | { ok: false; reason: string }> {
  const { data, error } = await sc
    .from("memory_tags")
    .select("memory_id, status")
    .eq("tagged_user_id", viewerId)
    .limit(CANDIDATE_SCAN_LIMIT);
  if (error) {
    log.error({ err: error, viewerId }, "memory tools: memory_tags read failed — refusing rather than answering from a partial history");
    return { ok: false, reason: "The user's tagged Memories could not be read, so this answer would be incomplete in a way the user could not see." };
  }
  const ids = (data ?? [])
    .filter((r: any) => r.status !== "removed")
    .map((r: any) => String(r.memory_id));
  return { ok: true, taggedIds: ids };
}

/** Owned + tagged rows, deduped, authorized one by one, newest first. */
async function loadOwnHistory(
  sc: SupabaseClient,
  viewerId: string,
): Promise<{ ok: true; rows: any[] } | { ok: false; reason: string }> {
  const tagged = await ownHistoryIds(sc, viewerId);
  if (!tagged.ok) return tagged;

  const owned = await sc
    .from("memories")
    .select(MEMORY_FACT_COLUMNS)
    .eq("owner_id", viewerId)
    .neq("state", "deleted")
    .order("starts_at", { ascending: false, nullsFirst: false })
    .limit(CANDIDATE_SCAN_LIMIT);
  if (owned.error) {
    log.error({ err: owned.error, viewerId }, "memory tools: owned memories read failed");
    return { ok: false, reason: "The user's own Memories could not be read right now." };
  }

  const rows: any[] = [...((owned.data as any[]) ?? [])];
  const have = new Set(rows.map((r) => String(r.id)));
  const missing = tagged.taggedIds.filter((id) => !have.has(id));
  if (missing.length > 0) {
    const extra = await sc
      .from("memories")
      .select(MEMORY_FACT_COLUMNS)
      .in("id", missing.slice(0, CANDIDATE_SCAN_LIMIT))
      .neq("state", "deleted");
    if (extra.error) {
      log.error({ err: extra.error, viewerId }, "memory tools: tagged memories read failed");
      return { ok: false, reason: "Memories the user is tagged in could not be read right now." };
    }
    for (const r of ((extra.data as any[]) ?? [])) {
      if (!have.has(String(r.id))) { rows.push(r); have.add(String(r.id)); }
    }
  }

  const authorized: any[] = [];
  for (const r of rows) {
    if (await canCompassReadMemory(sc, r, viewerId)) authorized.push(r);
  }
  authorized.sort((a, b) => String(b.starts_at ?? b.created_at ?? "").localeCompare(String(a.starts_at ?? a.created_at ?? "")));
  // The owner's controls, then §10, before any tool filters, scores or returns these rows.
  const honoured = await honourOwnerControls(sc, authorized, viewerId);
  if (!honoured.ok) return honoured;
  return { ok: true, rows: await withPlaceLabelsForViewer(sc, honoured.rows, viewerId) };
}

/** Deterministic token overlap. No model, no embedding — §15's "deterministic first". */
function tokenScore(row: any, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1;
  const hay = [row.title, row.caption, row.location_city, row.location_country, row.place_id]
    .filter((x: unknown) => typeof x === "string")
    .join(" ")
    .toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits++;
  return hits / tokens.length;
}

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t.length >= 2).slice(0, 12);
}

// ── The eight ─────────────────────────────────────────────────────────────────

/** §16 `getMemory(memoryId)`. */
async function toolMemoryGet(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const memoryId = String(args["memoryId"] ?? "");
  if (!UUID_RE.test(memoryId)) return refuse("A memoryId is required and must be a UUID.");

  const { data, error } = await sc
    .from("memories")
    .select(MEMORY_FACT_COLUMNS)
    .eq("id", memoryId)
    .maybeSingle();
  // The SAME refusal for "does not exist", "cannot be read" and "not permitted".
  // Three different answers here would turn this tool into an existence oracle
  // for other people's Memory ids.
  const opaque = refuse("That Memory is not available to this user.");
  if (error) {
    log.error({ err: error, memoryId, viewerId }, "memory tools: memory read failed");
    return opaque;
  }
  if (!data) return opaque;
  if (!(await canCompassReadMemory(sc, data, viewerId))) return opaque;
  const honoured = await honourOwnerControls(sc, [data], viewerId);
  if (!honoured.ok) return refuse(honoured.reason);
  if (honoured.rows.length === 0) return (data as any).owner_id === viewerId ? refuse(OWNER_EXCLUDED) : opaque; // another person's controls are not told

  const [shown] = await withPlaceLabelsForViewer(sc, honoured.rows, viewerId); // §10
  return { memory: toMemoryFact(shown, viewerId, Date.now()) };
}

/** §16 `searchMemories(query)`, over the viewer's own history. */
async function toolMemorySearch(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const history = await loadOwnHistory(sc, viewerId);
  if (!history.ok) return refuse(history.reason);

  const query = typeof args["query"] === "string" ? (args["query"] as string).slice(0, 200) : "";
  const named = resolveNamedPlace(history.rows, readPlaceAsk(args)); if (named.resolution === "UNRESOLVED" || named.resolution === "AMBIGUOUS") return { ...unresolvedPlaceAnswer(named, "memories"), searched: "the user's own Memories and Memories they are tagged in" }; // §28.3 (H262): the named place, equal or nothing
  const tripId = typeof args["tripId"] === "string" && UUID_RE.test(args["tripId"] as string) ? (args["tripId"] as string) : null;
  const from = typeof args["from"] === "string" ? (args["from"] as string).slice(0, 10) : null;
  const to = typeof args["to"] === "string" ? (args["to"] as string).slice(0, 10) : null;
  const limit = Math.min(Math.max(Number(args["limit"] ?? 5) || 5, 1), MAX_RESULTS);

  const tokens = tokenize(query);
  const nowMs = Date.now();
  const scored = history.rows
    .filter((r) => named.admits(r)) // §28.3: the asked city/country EXACTLY (memoryCompassTruth.foldEntityName), never a substring
    .filter((r) => (tripId ? r.trip_id === tripId : true))
    .filter((r) => {
      const d = typeof r.starts_at === "string" ? r.starts_at.slice(0, 10) : null;
      if (from && (!d || d < from)) return false;
      if (to && (!d || d > to)) return false;
      return true;
    })
    .map((r) => ({ r, score: tokenScore(r, tokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.r.starts_at ?? "").localeCompare(String(a.r.starts_at ?? "")))
    .slice(0, limit);

  return {
    memories: scored.map((x) => toMemoryFact(x.r, viewerId, nowMs)),
    searched: "the user's own Memories and Memories they are tagged in", ...(named.resolution === "RESOLVED" ? { resolution: "RESOLVED", asked: named.asked } : {}),
    // Named so nobody reads this as §15's retrieval. It is not.
    retrieval: "deterministic_token_overlap_over_canonical_rows",
    ceiling:
      "No semantic index and no §15 derivative was consulted: memory_derivative_registry (migration 2730) is not applied, so there is no registered derivative to read.",
    ...(scored.length === 0 ? { info: "No Memory in the user's own history matches that." } : {}),
  };
}

/** §16 `getSharedMemories(personId)`. */
async function toolMemoryGetShared(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const handleArg = typeof args["personHandle"] === "string" ? (args["personHandle"] as string).trim().replace(/^@/, "") : "";
  const idArg = typeof args["personId"] === "string" && UUID_RE.test(args["personId"] as string) ? (args["personId"] as string) : null;
  if (!handleArg && !idArg) return refuse("A personHandle or personId is required.");

  // One opaque refusal for a failed or undecidable lookup, the same reason
  // toolMemoryGet is opaque. A handle NOBODY has is UNRESOLVED instead (§28.3, H262): handles are public, and memory_create_draft already says so.
  const opaque = refuse("Shared Memories are not available for that person.");

  let personId = idArg;
  let personHandle: string | null = handleArg || null;
  if (!personId) {
    const found = await resolveExactHandle(sc, handleArg); // §28.3 (H262): the handle EXACTLY — `_` and `%` escaped, a wildcard-shaped name refused
    if (found.state === "unavailable") return opaque; if (found.state === "no_such_handle") return unresolvedPersonAnswer(found.asked);
    personId = found.id;
    personHandle = found.handle;
  }
  if (personId === viewerId) return refuse("That is the user themself.");

  const history = await loadOwnHistory(sc, viewerId);
  if (!history.ok) return refuse(history.reason);
  if (history.rows.length === 0) return { memories: [], person: personHandle, resolution: "RESOLVED", info: "The user has no Memories yet." };

  const ids = history.rows.map((r) => String(r.id));
  const tags = await sc
    .from("memory_tags")
    .select("memory_id, status")
    .eq("tagged_user_id", personId)
    .in("memory_id", ids.slice(0, CANDIDATE_SCAN_LIMIT));
  if (tags.error) {
    log.error({ err: tags.error, viewerId }, "memory tools: shared-memory tag read failed");
    return opaque;
  }

  // §16 "may not invent … participants … attendance": only an APPROVED tag is
  // attendance. A pending tag is the owner's claim about somebody who has not
  // confirmed it, and it is reported separately, under a key that says so.
  const approved = new Set<string>();
  const unconfirmed = new Set<string>();
  for (const t of ((tags.data as any[]) ?? [])) {
    if (t.status === "approved") approved.add(String(t.memory_id));
    else if (t.status === "pending") unconfirmed.add(String(t.memory_id));
  }

  const nowMs = Date.now();
  const shared = history.rows
    .filter((r) => approved.has(String(r.id)) || r.owner_id === personId)
    .slice(0, MAX_RESULTS)
    .map((r) => toMemoryFact(r, viewerId, nowMs));
  const pending = history.rows
    .filter((r) => unconfirmed.has(String(r.id)))
    .slice(0, MAX_RESULTS)
    .map((r) => toMemoryFact(r, viewerId, nowMs));

  return {
    person: personHandle, resolution: "RESOLVED",
    memories: shared,
    unconfirmed_participation: pending,
    participation_rule:
      "`memories` are Memories where this person's tag is APPROVED (they confirmed being there). `unconfirmed_participation` are Memories where the owner tagged them and they have not confirmed — say 'tagged, not confirmed', never that the person was there.",
    ...(shared.length === 0 && pending.length === 0 ? { info: "No shared Memory with that person." } : {}),
  };
}

/** §16 `getPlaceHistory(placeId)` — and the one place §14's fusion is exercised. */
async function toolMemoryGetPlaceHistory(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const placeId = typeof args["placeId"] === "string" ? (args["placeId"] as string).slice(0, 200).trim() : "";
  const placeAsk = readPlaceAsk(args); // §28.3 (H262): the city/country as ASKED, resolved below by equality
  if (!placeId && !placeAsk.city && !placeAsk.country) return refuse("A placeId or a city is required.");

  const history = await loadOwnHistory(sc, viewerId);
  if (!history.ok) return refuse(history.reason);
  const named = resolveNamedPlace(history.rows, placeAsk); if (named.resolution === "UNRESOLVED" || named.resolution === "AMBIGUOUS") return unresolvedPlaceAnswer(named, "visits", { place_id: placeId || null, place_name: null, visit_count: 0 });
  const nowMs = Date.now();
  const rows = history.rows
    .filter((r) => (placeId ? String(r.place_id ?? "") === placeId || String(r.canonical_location_id ?? "") === placeId : true))
    .filter((r) => named.admits(r)) // §28.3: EXACTLY the asked city/country, never a substring
    .slice(0, MAX_RESULTS);

  const visits = rows.map((r) => toMemoryFact(r, viewerId, nowMs));

  // ── §14, and the only current-world reading in this file ───────────────────
  // The current half comes from getLiveVenueStatus or it does not come at all.
  // Nothing below reads a Memory row to decide what is true now.
  let current: CurrentWorldReading = currentWorldUnknown(
    "No catalog place was resolved from this Memory's place id, so there is nothing to check against a live source.",
  );
  let placeName: string | null = null;
  if (placeId && UUID_RE.test(placeId)) {
    const { data: place, error: placeError } = await sc.from("discovery_places").select("id, name, lat, lng").eq("id", placeId).maybeSingle();
    if (placeError) current = currentWorldUnknown("The catalog place could not be read, so nothing may be said about its current status."); // a failed read is not "no place"
    if (place) {
      placeName = String((place as any).name ?? "");
      const live = await getLiveVenueStatus(placeName, liveVenueAnchorOf((place as any).lat, (place as any).lng)); // lead ruling D-67: the place's own coordinates confirm the record is this place
      current = live
        ? currentWorldReading(
            live.openNow === null
              ? `${live.venueName}: a live source answered but published no opening hours.`
              : `${live.venueName} is ${live.openNow ? "open" : "closed"} right now.`,
            "verified_live",
            `checked ${live.checkedAt} via ${live.source}`,
          )
        : currentWorldUnknown(
            "No live record could be confirmed as this place, or the live source could not be reached, so nothing may be said about its current status.");
    }
  }

  const fused: FusedAnswer | null = visits.length > 0
    ? fuseHistoricalWithCurrent(visits[0]!.historical, current)
    : null;

  return {
    place_id: placeId || null, resolution: visits.length > 0 ? "RESOLVED" : "UNRESOLVED", asked: { ...(placeId ? { place_id: placeId } : {}), ...(named.asked ?? {}) },
    place_name: placeName,
    visits,
    visit_count: visits.length,
    current_world: current,
    fusion: fused,
    ...(visits.length === 0 ? { info: "Nothing in the user's own Memories is at that place. Say so; do not offer a Memory from another place as this one." } : {}),
  };
}

/** §16 `getTripMemories(tripId)`. */
async function toolMemoryGetTripMemories(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const tripId = String(args["tripId"] ?? "");
  if (!UUID_RE.test(tripId)) return refuse("A tripId is required and must be a UUID.");

  // Trip Memories are the one set that legitimately includes other people's
  // rows, so membership is checked FIRST and fail-closed: an unreadable
  // trip_members table refuses rather than falling through to the per-row gate.
  const crew = await acceptedCrewOfTrip(sc, tripId);
  if (!crew.ok) {
    log.error({ err: crew.error, tripId, viewerId }, "memory tools: trip crew read failed — refusing");
    return refuse("The trip's membership could not be established, so its Memories are withheld.");
  }
  if (!crew.ids.has(viewerId)) return refuse("The user is not an accepted member of that trip.");

  const { data, error } = await sc
    .from("memories")
    .select(MEMORY_FACT_COLUMNS)
    .eq("trip_id", tripId)
    .neq("state", "deleted")
    .order("starts_at", { ascending: true, nullsFirst: false })
    .limit(CANDIDATE_SCAN_LIMIT);
  if (error) {
    log.error({ err: error, tripId }, "memory tools: trip memories read failed");
    return refuse("That trip's Memories could not be read right now.");
  }

  const nowMs = Date.now();
  // §10 on MEMBERSHIP too (V-L6c F3, census-compass §53): a trip names its
  // destination, a CITY fact, so another person's Memory whose rung withholds
  // the city (`country`, `hidden`, an unreadable gate or rung) is not listed
  // under the trip at all — the clamp nulls its `trip_id`, and a Memory whose
  // trip the viewer may not be told is not one this list may answer with.
  // Batches of what is still missing, so a withheld row does not cost a slot.
  const read = (data as any[]) ?? [];
  const honoured = await honourOwnerControls(sc, read, viewerId);
  if (!honoured.ok) return refuse(honoured.reason);
  const rows = honoured.rows;
  const out: MemoryFactPayload[] = [];
  let next = 0;
  while (out.length < MAX_RESULTS && next < rows.length) {
    const batch: any[] = [];
    while (batch.length < MAX_RESULTS - out.length && next < rows.length) {
      const r = rows[next++];
      if (await canCompassReadMemory(sc, r, viewerId)) batch.push(r);
    }
    for (const shown of await withPlaceLabelsForViewer(sc, batch, viewerId)) {
      if (shown?.owner_id !== viewerId && shown?.trip_id !== tripId) continue;
      out.push(toMemoryFact(shown, viewerId, nowMs));
    }
  }
  return {
    trip_id: tripId,
    memories: out,
    ...(out.length === 0 ? { info: "No Memory on that trip is visible to this user." } : {}),
  };
}

/** §16 `getMemoryEvidence(memoryId)` — the accessor that has to say "there is none". */
async function toolMemoryGetEvidence(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const memoryId = String(args["memoryId"] ?? "");
  if (!UUID_RE.test(memoryId)) return refuse("A memoryId is required and must be a UUID.");

  const { data, error } = await sc.from("memories").select(MEMORY_FACT_COLUMNS).eq("id", memoryId).maybeSingle();
  const opaque = refuse("That Memory is not available to this user.");
  if (error || !data) return opaque;
  if (!(await canCompassReadMemory(sc, data, viewerId))) return opaque;
  const honoured = await honourOwnerControls(sc, [data], viewerId);
  if (!honoured.ok) return refuse(honoured.reason);
  if (honoured.rows.length === 0) return (data as any).owner_id === viewerId ? refuse(OWNER_EXCLUDED) : opaque;

  // §10 "Media visibility is independent from Memory visibility" (3672, census
  // H80): a photo its owner keeps to themself is not described to anyone else,
  // caption or count. An unreadable hidden set withholds the whole list (fail
  // closed), reported as unavailable rather than empty. The owner sees every one.
  const hidden = (data as any).owner_id === viewerId ? { ok: true as const, keys: new Set<string>() } : await hiddenItemKeys(sc, [memoryId]);
  if (!hidden.ok) log.error({ detail: hidden.detail, memoryId, viewerId }, "memory tools: hidden-photo read failed — withholding the attachment list");

  const items = await sc
    .from("memory_items")
    .select("id, media_type, caption, position, created_at")
    .eq("memory_id", memoryId)
    .order("position", { ascending: true })
    .limit(MAX_RESULTS);
  const tags = await sc.from("memory_tags").select("tagged_user_id, status").eq("memory_id", memoryId).limit(50); const participantCounts = tags.error ? null : await evidenceParticipantCounts(sc, data as any, viewerId, ((tags.data as any[]) ?? [])); const provenance = await readMemoryProvenance(sc, data as any, viewerId); // MEM-POLICY follow-up: counts through the detail read's §10 ladder; H120/H123: §3.3 provenance where 2320 exists

  // §28.11 — "Never swallow projection/schema failures into plausible-looking
  // empty history without structured error state."
  //
  // These two reads used to be the file's only unchecked ones. supabase-js
  // RESOLVES on a database failure, so `{ data: null }` is what an empty table
  // and an unreadable table both look like, and `?? []` turned the second into
  // the first: an unreadable `memory_tags` was reported as
  // `confirmed_participants: 0` — a claim that nobody was there — and an
  // unreadable `memory_items` as `attached_artifacts: []`. Both go to a
  // language model beside a field called `evidence_store_reason`, which is the
  // worst possible place for a confident guess. Every other read here already
  // checks and refuses; `ownHistoryIds` says why in its own header.
  //
  // The whole tool is not refused, because the honest headline — there is no
  // §6 evidence store — is true whatever these two reads did, and losing it
  // would trade one silence for another. What changes is that a count nobody
  // could compute is `null` and is NAMED as unavailable, so the difference
  // between "zero" and "unknown" survives all the way to the prompt.
  const tagsUnavailable = Boolean(tags.error) || !participantCounts?.ok; // a count the ladder could not decide (blocks, the owner's ceiling) is withheld, never 0
  const itemsUnavailable = Boolean(items.error) || !hidden.ok;
  if (tagsUnavailable) {
    log.error({ err: tags.error, detail: participantCounts && !participantCounts.ok ? participantCounts.detail : undefined, memoryId, viewerId }, "memory tools: evidence participant read failed — reporting unavailable rather than zero");
  }
  if (itemsUnavailable) {
    log.error({ err: items.error, memoryId, viewerId }, "memory tools: evidence artifact read failed — reporting unavailable rather than empty");
  }
  const counts = participantCounts?.ok ? participantCounts : null;
  return {
    memory_id: memoryId,
    // The honest headline, first, so a truncated payload still carries it.
    evidence_store: provenance.store,
    evidence_store_reason:
      provenance.reason, ...(provenance.store === "present" ? { provenance: provenance.provenance, ...(provenance.truncated ? { provenance_truncated: true } : {}) } : {}),
    attached_artifacts: itemsUnavailable
      ? null
      : ((items.data as any[]) ?? []).filter((i: any) => hidden.ok && !hidden.keys.has(itemKey(memoryId, i.position))).map((i: any) => ({
          artifact_id: String(i.id),
          kind: "memory_item",
          media_type: (i.media_type as string | null) ?? null,
          caption: typeof i.caption === "string" ? wrapUgc(i.caption) : null,
          created_at: (i.created_at as string | null) ?? null,
        })),
    ...(itemsUnavailable
      ? {
          attached_artifacts_unavailable: true,
          attached_artifacts_unavailable_reason:
            "The attachment list could not be read. This does NOT mean the Memory has no attachments — say that it could not be looked up.",
        }
      : {}),
    confirmed_participants: counts ? counts.confirmed : null,
    unconfirmed_participants: counts ? counts.unconfirmed : null, unidentified_participants: counts ? counts.unidentified : null,
    ...(tagsUnavailable
      ? {
          participants_unavailable: true,
          participants_unavailable_reason:
            "The participant list could not be read or checked against who this user may see. This does NOT mean nobody was there — say that it could not be looked up.",
        }
      : {}),
    caveat:
      "`attached_artifacts` are files attached to the Memory. They are NOT §6-normalized evidence: nothing here says a photo was captured at the place or the time the Memory claims. Do not describe them as proof. `unidentified_participants` were tagged and may not be identified to this user: never say who, and never say they were there.",
  };
}

// ── The two write-shaped ones, which write nothing ────────────────────────────

/**
 * The fields a draft or a correction may name.
 *
 * An allow-list rather than a deny-list, and it is deliberately SHORTER than
 * `patchMemorySchema` in `routes/memories.ts`: `allowedUserIds`, `hiddenUserIds`
 * and `state` are absent, so a prose turn cannot propose changing who may see a
 * Memory or whether it exists. §21's revocation and §5's lifecycle are
 * decisions a person takes on a screen, not a sentence a model produces.
 */
export const DRAFTABLE_FIELDS = Object.freeze([
  "title", "caption", "visibility", "placeId", "locationCity", "locationCountry", "tripId", "startsAt", "endsAt",
]);

export const CORRECTABLE_FIELDS = Object.freeze([
  "title", "caption", "placeId", "locationCity", "locationCountry", "startsAt", "endsAt",
]);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

/**
 * §16 `createMemoryDraft(input)`.
 *
 * Writes nothing. Returns a draft the user confirms through `POST /memories`,
 * which re-authorizes and runs the §17 command path.
 *
 * §16 also says the model "may ask the minimum clarifying question when a
 * material fact is uncertain", and MINIMUM is taken literally: at most ONE
 * question comes back, in a fixed priority order, so a draft missing three
 * things produces one question rather than an interrogation.
 */
async function toolMemoryCreateDraft(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const proposed: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (k === "participantHandles") continue;
    if (!DRAFTABLE_FIELDS.includes(k)) { rejected.push(k); continue; }
    proposed[k] = v;
  }
  if (typeof proposed["visibility"] === "string" && !(VISIBILITY_VALUES as readonly string[]).includes(proposed["visibility"] as string)) {
    return refuse(`visibility must be one of: ${VISIBILITY_VALUES.join(", ")}.`);
  }
  for (const k of ["startsAt", "endsAt"]) {
    const v = proposed[k];
    if (v != null && !(typeof v === "string" && ISO_DATE_RE.test(v))) {
      return refuse(`${k} must be an ISO date or datetime.`);
    }
  }

  // §16: "may not invent … participants … identity". Every named participant
  // must resolve to a real profile, and one that does not REFUSES the draft
  // rather than being quietly dropped — a dropped name is a Memory the user
  // confirms believing it records somebody it does not.
  const handles = Array.isArray(args["participantHandles"])
    ? (args["participantHandles"] as unknown[]).filter((h): h is string => typeof h === "string").slice(0, 20)
    : [];
  const participants: Array<{ handle: string; user_id: string }> = [];
  for (const raw of handles) {
    const handle = raw.trim().replace(/^@/, "");
    if (!handle) continue;
    const found = await resolveExactHandle(sc, handle); // §28.3 (H262) / H74: the handle EXACTLY — `_` and `%` escaped, a wildcard-shaped name refused
    if (found.state === "unavailable") return refuse("A participant could not be checked right now, so no draft was made.");
    if (found.state === "no_such_handle") return refuse(`No user with the handle @${handle} exists. A Memory draft will not name a person this app cannot resolve.`);
    participants.push({ handle: found.handle, user_id: found.id });
  }

  // The minimum clarifying question, in priority order. WHEN first: §7 draws
  // episode boundaries from time, so a Memory with no time is the one that
  // cannot be placed in a history at all.
  let clarifyingQuestion: string | null = null;
  if (!proposed["startsAt"]) {
    clarifyingQuestion = "When did this happen? A Memory without a date cannot be placed in the user's history.";
  } else if (!proposed["placeId"] && !proposed["locationCity"] && !proposed["tripId"]) {
    clarifyingQuestion = "Where was this? A city is enough.";
  } else if (!proposed["title"] && !proposed["caption"]) {
    clarifyingQuestion = "What should this Memory be called?";
  }

  return {
    draft: {
      draft_id: randomUUID(),
      fields: proposed,
      participants,
      requires_confirmation: true,
      confirm_via: "POST /memories",
    },
    writes_nothing: true,
    clarifying_question: clarifyingQuestion,
    ...(rejected.length ? { ignored_fields: rejected, ignored_reason: `Only these may be drafted: ${DRAFTABLE_FIELDS.join(", ")}.` } : {}),
    info: "Nothing has been saved. Present this as a draft the user confirms; never say the Memory was created.",
  };
}

/**
 * §16 `suggestMemoryCorrection(memoryId, patch)`.
 *
 * Writes nothing, and refuses outright unless the caller OWNS the Memory: §21
 * and §23 make the owner the authority over their own historical facts, so a
 * correction proposed by anyone else is not a correction, it is an edit request
 * this repository has no mechanism to route.
 */
async function toolMemorySuggestCorrection(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const memoryId = String(args["memoryId"] ?? "");
  if (!UUID_RE.test(memoryId)) return refuse("A memoryId is required and must be a UUID.");

  const { data, error } = await sc.from("memories").select(MEMORY_FACT_COLUMNS).eq("id", memoryId).maybeSingle();
  const opaque = refuse("That Memory is not available to this user.");
  if (error || !data) return opaque;
  if (!(await canCompassReadMemory(sc, data, viewerId))) return opaque;
  if ((data as any).owner_id !== viewerId) {
    return refuse("Only the owner of a Memory may correct it. Suggest that the user asks the owner.");
  }
  const honoured = await honourOwnerControls(sc, [data], viewerId);
  if (!honoured.ok) return refuse(honoured.reason);
  if (honoured.rows.length === 0) return refuse(OWNER_EXCLUDED);
  const current = honoured.rows[0]; // the place as the owner corrected it (3673), not the stored pick

  const patchIn = (args["patch"] && typeof args["patch"] === "object" && !Array.isArray(args["patch"]))
    ? (args["patch"] as Record<string, unknown>)
    : null;
  if (!patchIn) return refuse("A patch object is required.");

  const patch: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(patchIn)) {
    if (!CORRECTABLE_FIELDS.includes(k)) { rejected.push(k); continue; }
    patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    return refuse(`Nothing correctable was proposed. Correctable fields: ${CORRECTABLE_FIELDS.join(", ")}.`);
  }
  for (const k of ["startsAt", "endsAt"]) {
    const v = patch[k];
    if (v != null && !(typeof v === "string" && ISO_DATE_RE.test(v))) {
      return refuse(`${k} must be an ISO date or datetime.`);
    }
  }

  const before: Record<string, unknown> = {
    title: (data as any).title ?? null,
    caption: (data as any).caption ?? null,
    placeId: current.place_id ?? null,
    locationCity: (data as any).location_city ?? null,
    locationCountry: (data as any).location_country ?? null,
    startsAt: (data as any).starts_at ?? null,
    endsAt: (data as any).ends_at ?? null,
  };

  return {
    memory_id: memoryId,
    proposed_patch: patch,
    current_values: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k] ?? null])),
    requires_confirmation: true,
    confirm_via: `PATCH /memories/${memoryId}`,
    writes_nothing: true,
    ...(rejected.length ? { refused_fields: rejected, refused_reason: `Only these may be corrected: ${CORRECTABLE_FIELDS.join(", ")}. Visibility, audience lists and deletion are not corrections.` } : {}),
    info: "Nothing has been changed. Present this as a correction the user confirms.",
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const MEMORY_COMPASS_TOOL_DEFINITIONS = [
  {
    type: "function" as const,
    function: {
      name: "memory_get",
      description:
        "Get one of the user's Memories by id (§16 getMemory). Returns the canonical facts as a HISTORICAL claim — never a statement about what is true at that place now. Refuses for any Memory the user is not authorized to read.",
      parameters: {
        type: "object",
        properties: { memoryId: { type: "string", description: "The Memory's UUID." } },
        required: ["memoryId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_search",
      description:
        "Search the user's OWN Memories — the ones they own plus the ones they are tagged in (§16 searchMemories). Deterministic keyword and filter matching over canonical rows; there is no semantic index. A city or country is matched EXACTLY (case and spacing aside): a name that matches nothing comes back resolution UNRESOLVED with no Memories, and a city name several countries share comes back AMBIGUOUS with candidates. Use for questions like 'what did I do in Da Nang'.",
      parameters: {
        type: "object",
        properties: {
          query:  { type: "string", description: "Free text matched against title, caption, city, country." },
          city:   { type: "string", description: "Restrict to Memories in exactly this city (never a partial or similar name)." }, country: { type: "string", description: "Restrict to Memories in exactly this country; use it to settle an AMBIGUOUS city." },
          tripId: { type: "string", description: "Restrict to one trip's Memories." },
          from:   { type: "string", description: "Earliest date, YYYY-MM-DD." },
          to:     { type: "string", description: "Latest date, YYYY-MM-DD." },
          limit:  { type: "integer", minimum: 1, maximum: 10 },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_get_shared",
      description:
        "Memories the user shares with one other person (§16 getSharedMemories). Only APPROVED tags count as that person having been there; tags they have not confirmed come back separately under unconfirmed_participation and must never be stated as attendance.",
      parameters: {
        type: "object",
        properties: {
          personHandle: { type: "string", description: "The other person's handle, with or without @." },
          personId:     { type: "string", description: "The other person's user id, if the handle is not known." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_get_place_history",
      description:
        "The user's history at one place (§16 getPlaceHistory), plus a SEPARATE current-world reading of that place when a live source can be reached. The two are never merged: past visits never establish that a place is open now. A city is matched EXACTLY; UNRESOLVED and AMBIGUOUS mean what they mean for memory_search.",
      parameters: {
        type: "object",
        properties: {
          placeId: { type: "string", description: "A catalog place id, or the place id stored on the Memory." },
          city:    { type: "string", description: "Or a city, when no place id is known (matched exactly)." }, country: { type: "string", description: "With a city: exactly this country, to settle an AMBIGUOUS city." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_get_trip_memories",
      description:
        "Memories recorded on one trip (§16 getTripMemories). The user must be an accepted member of that trip, and each Memory is authorized individually.",
      parameters: {
        type: "object",
        properties: { tripId: { type: "string", description: "The trip's UUID." } },
        required: ["tripId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_get_evidence",
      description:
        "What supports a Memory's claims (§16 getMemoryEvidence). For the Memory's OWNER: its provenance records (§3.3 memory_evidence, where deployed), each with a truth level and a confidence. For anyone: the files attached to the Memory, which are not proof. Never describe the result as evidence that something happened.",
      parameters: {
        type: "object",
        properties: { memoryId: { type: "string", description: "The Memory's UUID." } },
        required: ["memoryId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_create_draft",
      description:
        "Draft a new Memory for the user to confirm (§16 createMemoryDraft). WRITES NOTHING — it returns a draft plus, when a material fact is missing, ONE clarifying question. Every named participant must be a real handle or the draft is refused.",
      parameters: {
        type: "object",
        properties: {
          title:               { type: "string" },
          caption:             { type: "string" },
          visibility:          { type: "string", enum: [...VISIBILITY_VALUES] },
          placeId:             { type: "string" },
          locationCity:        { type: "string" },
          locationCountry:     { type: "string" },
          tripId:              { type: "string" },
          startsAt:            { type: "string", description: "ISO date or datetime the Memory is about." },
          endsAt:              { type: "string" },
          participantHandles:  { type: "array", items: { type: "string" }, description: "Handles of people who were there." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "memory_suggest_correction",
      description:
        "Propose a correction to a Memory the user OWNS (§16 suggestMemoryCorrection). WRITES NOTHING — it returns the proposed patch beside the current values for the user to confirm. Visibility, audience lists and deletion cannot be proposed here.",
      parameters: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "The Memory's UUID." },
          patch: {
            type: "object",
            description: "Correctable fields only: title, caption, placeId, locationCity, locationCountry, startsAt, endsAt.",
            additionalProperties: true,
          },
        },
        required: ["memoryId", "patch"],
        additionalProperties: false,
      },
    },
  }, ...MEMORY_PROPOSAL_TOOL_DEFINITIONS, // §16 "may propose a merge/split" (H124): memory_propose_merge, memory_propose_split
];

export const MEMORY_COMPASS_TOOL_NAMES = new Set(
  MEMORY_COMPASS_TOOL_DEFINITIONS.map((t) => t.function.name),
);

/**
 * The §16 LLM boundary, as prompt text.
 *
 * THIS IS THE WEAKEST OF THE THREE LAYERS AND IS LISTED LAST FOR THAT REASON.
 * The refusals above are structural; the labels on the data are structural; this
 * is instruction, and instruction is advisory. It is here because §16's "may"
 * clauses — summarize, propose, ask one question — cannot be expressed as a
 * refusal, and a permission nobody states is a permission nobody uses.
 */
export const MEMORY_COMPASS_PROMPT_RULES = `\
- MEMORY RULES (Highlights/Memories §16): the memory_* tools answer only for Memories this user is authorized to read, and they return { authorized: false, reason } when they will not answer — say the reason, never work around it with another tool.
- Every Memory fact comes back with truth_class "historical" and establishes_current_status: false. You may summarize and compare what the tools returned. You may NOT turn a past visit into a present claim: "they went there in March" never becomes "it is open" or "they like it". Only a current_world entry with available: true licenses a statement about now, and memory_get_place_history is the only tool that carries one.
- Never state that a person was present unless they appear in "memories" (an approved tag). Anyone under "unconfirmed_participation" was tagged and has not confirmed — say exactly that.
- memory_get_evidence returns attached files, not proof. Never call them evidence that something happened. Its provenance (the owner only) lists records with a truth_level — asserted (the owner said so), observed (a capture), corroborated, inferred — and a confidence: summarize only those records, keep each one's truth level, and never present an observed or inferred record as proof. Never say an unidentified_participants person was there.
- memory_create_draft, memory_suggest_correction, memory_propose_merge and memory_propose_split WRITE NOTHING. Present their output as a draft or a proposal the user must confirm; never say a Memory was created, changed, corrected, merged or split. If a draft comes back with a clarifying_question, ask exactly that one question and nothing else.
- Never invent a Memory, a participant, a place, a date or an outcome that a tool did not return.\n- §28.3: a memory_* result with resolution "UNRESOLVED" means nothing in the user's Memories is the place or person asked about — say exactly that, and NEVER present a Memory from a different place or person as the one asked about (a New York Memory is not a York Memory). "AMBIGUOUS" lists candidates: ask which one; never pick.\n- §28.16: title, caption and original_text are the owner's own words, verbatim; original_language "und" means their language is not recorded. Quote them exactly when you quote them; never translate or paraphrase them and present the result as the owner's words.`;

/** Dispatcher. Returns refusal objects rather than throwing — see the header. */
export async function executeMemoryCompassTool(
  sc: SupabaseClient,
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "memory_get":                 return toolMemoryGet(sc, userId, args);
    case "memory_search":              return toolMemorySearch(sc, userId, args);
    case "memory_get_shared":          return toolMemoryGetShared(sc, userId, args);
    case "memory_get_place_history":   return toolMemoryGetPlaceHistory(sc, userId, args);
    case "memory_get_trip_memories":   return toolMemoryGetTripMemories(sc, userId, args);
    case "memory_get_evidence":        return toolMemoryGetEvidence(sc, userId, args);
    case "memory_create_draft":        return toolMemoryCreateDraft(sc, userId, args);
    case "memory_suggest_correction":  return toolMemorySuggestCorrection(sc, userId, args); case "memory_propose_merge": return toolMemoryProposeMerge(sc, userId, args); case "memory_propose_split": return toolMemoryProposeSplit(sc, userId, args); // H124
    default:                           return refuse(`Unknown Memory tool: ${name}`);
  }
}

// ── §16 "May propose a merge/split" (census H124), which write nothing ────────
//
// Appended here, after the dispatcher, because every line above is cited by
// number (census-highlights-memories, census-compass). Function declarations
// hoist, so the dispatcher's two cases reach them.
//
// A proposal mirrors the preconditions `routes/memoryGraph.ts` and
// `memory_graph_kernel_execute` (3676) apply, so the model is never handed a
// merge or split the app would refuse: the flag (read fail-closed), the bounds,
// every Memory the caller's own and not deleted (one opaque refusal, so a
// proposal cannot probe another person's Memory ids), nothing removed, one
// audience across a merge, and a split that moves only the source's own items
// and leaves at least one behind. The owner's per-Memory controls apply exactly
// as they do to `memory_suggest_correction` (OD-1012-PRIV-3 is not touched).

const MERGE_SPLIT_OFF = "Merging and splitting Memories is not available yet, so nothing can be proposed. Say so.";

async function toolMemoryProposeMerge(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(await isFlagEnabled(sc, MEMORY_MERGE_SPLIT_FLAG))) return refuse(MERGE_SPLIT_OFF);
  const survivorId = String(args["survivorId"] ?? "");
  const absorbed = Array.isArray(args["absorbedIds"]) ? (args["absorbedIds"] as unknown[]).map((x) => String(x ?? "")) : [];
  if (!UUID_RE.test(survivorId)) return refuse("A survivorId is required and must be a UUID.");
  if (absorbed.length < 1 || absorbed.length > PROPOSE_MERGE_MAX_ABSORBED || !absorbed.every((id) => UUID_RE.test(id))) {
    return refuse(`absorbedIds must be 1-${PROPOSE_MERGE_MAX_ABSORBED} Memory UUIDs.`);
  }
  if (new Set(absorbed).size !== absorbed.length || absorbed.includes(survivorId)) {
    return refuse("absorbedIds must be distinct and must not include the survivor.");
  }

  const ids = [survivorId, ...absorbed];
  const { data, error } = await sc.from("memories").select(MEMORY_FACT_COLUMNS).in("id", ids);
  if (error || !Array.isArray(data)) {
    log.error({ err: error, viewerId }, "memory tools: merge proposal read failed");
    return refuse("Those Memories could not be read right now, so no merge was proposed.");
  }
  const byId = new Map((data as any[]).map((r) => [String(r.id), r]));
  const opaque = refuse("One or more of those Memories is not available to this user.");
  const rows: any[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.owner_id !== viewerId || r.state === "deleted" || !(await canCompassReadMemory(sc, r, viewerId))) return opaque;
    rows.push(r);
  }
  if (rows.some((r) => r.state === "removed")) return refuse("A removed Memory cannot be merged, so no merge was proposed.");
  if (mergeAudiencesDiffer(rows)) {
    return refuse("These Memories do not share one audience (who can see them, or draft vs published). The app refuses a merge that would show something to more people than chose to see it, so none was proposed. Suggest making their audiences match first.");
  }
  const honoured = await honourOwnerControls(sc, rows, viewerId);
  if (!honoured.ok) return refuse(honoured.reason);
  if (honoured.rows.length !== rows.length) return refuse(OWNER_EXCLUDED);
  const shown = await withPlaceLabelsForViewer(sc, honoured.rows, viewerId);
  const nowMs = Date.now();
  const fact = (id: string) => toMemoryFact(shown.find((r) => String(r.id) === id), viewerId, nowMs);

  return {
    proposal: {
      kind: "merge",
      survivor: fact(survivorId),
      absorbed: absorbed.map(fact),
      requires_confirmation: true,
      confirm_via: "POST /memories/merge",
      confirm_body: { survivorId, absorbedIds: absorbed },
    },
    writes_nothing: true,
    info: "Nothing has been merged. Present this as a merge the user confirms: the absorbed Memories' photos, tags, likes and saves would move to the survivor, and the absorbed Memories would be removed.",
  };
}

async function toolMemoryProposeSplit(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(await isFlagEnabled(sc, MEMORY_MERGE_SPLIT_FLAG))) return refuse(MERGE_SPLIT_OFF);
  const memoryId = String(args["memoryId"] ?? "");
  if (!UUID_RE.test(memoryId)) return refuse("A memoryId is required and must be a UUID.");
  const itemIds = Array.isArray(args["itemIds"]) ? (args["itemIds"] as unknown[]).map((x) => String(x ?? "")) : [];
  if (itemIds.length < 1 || itemIds.length > PROPOSE_SPLIT_MAX_ITEMS || !itemIds.every((id) => UUID_RE.test(id)) || new Set(itemIds).size !== itemIds.length) {
    return refuse(`itemIds must be 1-${PROPOSE_SPLIT_MAX_ITEMS} distinct item UUIDs.`);
  }
  const title = typeof args["title"] === "string" ? (args["title"] as string).slice(0, 200) : null;

  const { data, error } = await sc.from("memories").select(MEMORY_FACT_COLUMNS).eq("id", memoryId).maybeSingle();
  const opaque = refuse("That Memory is not available to this user.");
  if (error || !data) return opaque;
  if ((data as any).state === "deleted" || !(await canCompassReadMemory(sc, data, viewerId))) return opaque;
  if ((data as any).owner_id !== viewerId) return refuse("Only the owner of a Memory may split it. Suggest that the user asks the owner.");
  if ((data as any).state === "removed") return refuse("A removed Memory cannot be split, so no split was proposed.");
  const honoured = await honourOwnerControls(sc, [data], viewerId);
  if (!honoured.ok) return refuse(honoured.reason);
  if (honoured.rows.length === 0) return refuse(OWNER_EXCLUDED);

  const items = await sc.from("memory_items").select("id, media_type, caption, position").eq("memory_id", memoryId).limit(1000);
  if (items.error || !Array.isArray(items.data)) {
    log.error({ err: items.error, memoryId, viewerId }, "memory tools: split proposal item read failed");
    return refuse("The Memory's photos could not be read right now, so no split was proposed.");
  }
  const all = items.data as any[];
  const byId = new Map(all.map((i) => [String(i.id), i]));
  if (!itemIds.every((id) => byId.has(id))) return refuse("Not every one of those items is on this Memory, so no split was proposed.");
  if (itemIds.length >= all.length) return refuse("A split must leave at least one item on the original Memory, so no split was proposed.");

  const [shown] = await withPlaceLabelsForViewer(sc, honoured.rows, viewerId);
  return {
    proposal: {
      kind: "split",
      source: toMemoryFact(shown, viewerId, Date.now()),
      moving_items: itemIds.map((id) => {
        const i = byId.get(id);
        return {
          item_id: id,
          position: typeof i.position === "number" ? i.position : null,
          media_type: (i.media_type as string | null) ?? null,
          caption: typeof i.caption === "string" ? wrapUgc(i.caption) : null,
        };
      }),
      staying_item_count: all.length - itemIds.length,
      new_memory_title: title,
      requires_confirmation: true,
      confirm_via: `POST /memories/${memoryId}/split`,
      confirm_body: { itemIds, ...(title !== null ? { title } : {}) },
    },
    writes_nothing: true,
    info: "Nothing has been split. Present this as a split the user confirms: the listed items would move to a NEW Memory with the same audience and place, and nobody tagged on the original would be named on the new one.",
  };
}
