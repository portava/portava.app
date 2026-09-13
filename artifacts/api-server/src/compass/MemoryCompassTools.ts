/**
 * MemoryCompassTools — §16's Compass contract, as eight accessors.
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
 *   - WRITE. Not one of the eight issues an INSERT, UPDATE or DELETE. The two
 *     write-shaped ones return a PROPOSAL the user confirms through the existing
 *     authenticated routes (`POST /memories`, `PATCH /memories/:id`), which
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
 *   - `memory_get_evidence` has no evidence store to read. §3.6's
 *     `memory_evidence` table does not exist in this repository at all (census
 *     H24: "no migration in this tree"), so the accessor exists and its honest
 *     answer is that assertion-level provenance is not recorded. It returns the
 *     artifacts ATTACHED to a Memory and says in the payload that those are not
 *     §6-normalized evidence.
 *   - `memory_search` is a deterministic query over canonical `memories`, not
 *     §15's derivative-backed `services/memoryRetrieval/searchMemories.ts`. That
 *     module reads registered derivatives out of `memory_derivative_registry`,
 *     which is migration 2730 and unapplied, so it cannot serve a production
 *     request. H110–H114 are unmoved by this file.
 *   - There is no merge and no split to propose. MERGE_MEMORY and SPLIT_MEMORY
 *     are undeclared commands (`lib/memoryCommandBus.ts`
 *     `MEMORY_COMMAND_TYPES_NOT_DECLARED`), so `suggestMemoryCorrection` is the
 *     only third of §16's "merge/split/correction" that exists.
 */

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../lib/logger.js";
import { wrapUgc } from "./CompassStructuredContext.js";
import { getLiveVenueStatus } from "../lib/liveIntelligence.js";
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
 * The §10 rung (`memories.location_precision`) is NOT consulted, for the same
 * reason `routes/memories.ts` only consults it behind a flag: the column is
 * migration 2338 and production does not have it. City-level is at or below
 * every rung on the ladder except `country` and `hidden`, so the two rungs this
 * cannot honour are the two coarsest — recorded here rather than left for a
 * reader to work out.
 */
const MEMORY_FACT_COLUMNS =
  "id, owner_id, title, caption, visibility, allowed_user_ids, hidden_user_ids, state, " +
  "trip_id, event_id, place_id, canonical_location_id, starts_at, ends_at, created_at, updated_at, " +
  "location_city, location_country";

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
  caption: string | null;
  city: string | null;
  country: string | null;
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
  if (when) return `Recorded: "${head}" — on ${when}. No place is recorded.`;
  return `Recorded: "${head}". Neither a place nor a date is recorded.`;
}

function toMemoryFact(row: any, viewerId: string, nowMs: number): MemoryFactPayload {
  const occurredAt: string | null = (row?.starts_at as string | null) ?? null;
  return {
    memory_id: String(row.id),
    owned_by_viewer: row.owner_id === viewerId,
    title: typeof row.title === "string" ? wrapUgc(row.title) : null,
    caption: typeof row.caption === "string" ? wrapUgc(row.caption) : null,
    city: (row.location_city as string | null) ?? null,
    country: (row.location_country as string | null) ?? null,
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
  return { ok: true, rows: authorized };
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

  return { memory: toMemoryFact(data, viewerId, Date.now()) };
}

/** §16 `searchMemories(query)`, over the viewer's own history. */
async function toolMemorySearch(sc: SupabaseClient, viewerId: string, args: Record<string, unknown>): Promise<unknown> {
  const history = await loadOwnHistory(sc, viewerId);
  if (!history.ok) return refuse(history.reason);

  const query = typeof args["query"] === "string" ? (args["query"] as string).slice(0, 200) : "";
  const city = typeof args["city"] === "string" ? (args["city"] as string).trim().toLowerCase() : "";
  const tripId = typeof args["tripId"] === "string" && UUID_RE.test(args["tripId"] as string) ? (args["tripId"] as string) : null;
  const from = typeof args["from"] === "string" ? (args["from"] as string).slice(0, 10) : null;
  const to = typeof args["to"] === "string" ? (args["to"] as string).slice(0, 10) : null;
  const limit = Math.min(Math.max(Number(args["limit"] ?? 5) || 5, 1), MAX_RESULTS);

  const tokens = tokenize(query);
  const nowMs = Date.now();
  const scored = history.rows
    .filter((r) => (city ? String(r.location_city ?? "").toLowerCase().includes(city) : true))
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
    searched: "the user's own Memories and Memories they are tagged in",
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

  // Uniform refusal for "no such person", "hidden" and "read failed" — the same
  // reason toolMemoryGet is opaque.
  const opaque = refuse("Shared Memories are not available for that person.");

  let personId = idArg;
  let personHandle: string | null = handleArg || null;
  if (!personId) {
    const { data, error } = await sc.from("profiles").select("id, handle").ilike("handle", handleArg).maybeSingle();
    if (error || !data) return opaque;
    personId = String((data as any).id);
    personHandle = String((data as any).handle ?? handleArg);
  }
  if (personId === viewerId) return refuse("That is the user themself.");

  const history = await loadOwnHistory(sc, viewerId);
  if (!history.ok) return refuse(history.reason);
  if (history.rows.length === 0) return { memories: [], person: personHandle, info: "The user has no Memories yet." };

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
    person: personHandle,
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
  const city = typeof args["city"] === "string" ? (args["city"] as string).trim().toLowerCase() : "";
  if (!placeId && !city) return refuse("A placeId or a city is required.");

  const history = await loadOwnHistory(sc, viewerId);
  if (!history.ok) return refuse(history.reason);

  const nowMs = Date.now();
  const rows = history.rows
    .filter((r) => (placeId ? String(r.place_id ?? "") === placeId || String(r.canonical_location_id ?? "") === placeId : true))
    .filter((r) => (city ? String(r.location_city ?? "").toLowerCase().includes(city) : true))
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
    const { data: place } = await sc.from("discovery_places").select("id, name, city").eq("id", placeId).maybeSingle();
    if (place) {
      placeName = String((place as any).name ?? "");
      const live = await getLiveVenueStatus(placeName, ((place as any).city as string | null) ?? null);
      current = live
        ? currentWorldReading(
            live.openNow === null
              ? `${live.venueName}: a live source answered but published no opening hours.`
              : `${live.venueName} is ${live.openNow ? "open" : "closed"} right now.`,
            "verified_live",
            `checked ${live.checkedAt} via ${live.source}`,
          )
        : currentWorldUnknown(
            "The live source could not be reached, so nothing may be said about this place's current status.",
          );
    }
  }

  const fused: FusedAnswer | null = visits.length > 0
    ? fuseHistoricalWithCurrent(visits[0]!.historical, current)
    : null;

  return {
    place_id: placeId || null,
    place_name: placeName,
    visits,
    visit_count: visits.length,
    current_world: current,
    fusion: fused,
    ...(visits.length === 0 ? { info: "The user has no Memory at that place." } : {}),
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
  const out: MemoryFactPayload[] = [];
  for (const r of ((data as any[]) ?? [])) {
    if (out.length >= MAX_RESULTS) break;
    if (await canCompassReadMemory(sc, r, viewerId)) out.push(toMemoryFact(r, viewerId, nowMs));
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

  const items = await sc
    .from("memory_items")
    .select("id, media_type, caption, position, created_at")
    .eq("memory_id", memoryId)
    .order("position", { ascending: true })
    .limit(MAX_RESULTS);
  const tags = await sc.from("memory_tags").select("tagged_user_id, status").eq("memory_id", memoryId).limit(50);

  const tagRows = ((tags.data as any[]) ?? []);
  return {
    memory_id: memoryId,
    // The honest headline, first, so a truncated payload still carries it.
    evidence_store: "absent",
    evidence_store_reason:
      "§3.6 names a `memory_evidence` table for assertion-level provenance and confidence. No migration in this repository creates it, so no assertion in this Memory has a provenance record, a confidence score or an eligibility verdict attached to it.",
    attached_artifacts: ((items.data as any[]) ?? []).map((i: any) => ({
      artifact_id: String(i.id),
      kind: "memory_item",
      media_type: (i.media_type as string | null) ?? null,
      caption: typeof i.caption === "string" ? wrapUgc(i.caption) : null,
      created_at: (i.created_at as string | null) ?? null,
    })),
    confirmed_participants: tagRows.filter((t) => t.status === "approved").length,
    unconfirmed_participants: tagRows.filter((t) => t.status === "pending").length,
    caveat:
      "`attached_artifacts` are files attached to the Memory. They are NOT §6-normalized evidence: nothing here says a photo was captured at the place or the time the Memory claims. Do not describe them as proof.",
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
    const { data, error } = await sc.from("profiles").select("id, handle").ilike("handle", handle).maybeSingle();
    if (error) return refuse("A participant could not be checked right now, so no draft was made.");
    if (!data) return refuse(`No user with the handle @${handle} exists. A Memory draft will not name a person this app cannot resolve.`);
    participants.push({ handle: String((data as any).handle ?? handle), user_id: String((data as any).id) });
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
    placeId: (data as any).place_id ?? null,
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
        "Search the user's OWN Memories — the ones they own plus the ones they are tagged in (§16 searchMemories). Deterministic keyword and filter matching over canonical rows; there is no semantic index. Use for questions like 'what did I do in Da Nang'.",
      parameters: {
        type: "object",
        properties: {
          query:  { type: "string", description: "Free text matched against title, caption, city, country." },
          city:   { type: "string", description: "Restrict to Memories in this city." },
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
        "The user's history at one place (§16 getPlaceHistory), plus a SEPARATE current-world reading of that place when a live source can be reached. The two are never merged: past visits never establish that a place is open now.",
      parameters: {
        type: "object",
        properties: {
          placeId: { type: "string", description: "A catalog place id, or the place id stored on the Memory." },
          city:    { type: "string", description: "Or a city, when no place id is known." },
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
        "What supports a Memory's claims (§16 getMemoryEvidence). This app does not record assertion-level provenance, so this returns the artifacts attached to the Memory and says plainly that they are not proof. Never describe the result as evidence that something happened.",
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
  },
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
- memory_get_evidence returns attached files, not proof. Never call them evidence that something happened.
- memory_create_draft and memory_suggest_correction WRITE NOTHING. Present their output as a draft or a proposal the user must confirm; never say a Memory was created, changed or corrected. If a draft comes back with a clarifying_question, ask exactly that one question and nothing else.
- Never invent a Memory, a participant, a place, a date or an outcome that a tool did not return.`;

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
    case "memory_suggest_correction":  return toolMemorySuggestCorrection(sc, userId, args);
    default:                           return refuse(`Unknown Memory tool: ${name}`);
  }
}
