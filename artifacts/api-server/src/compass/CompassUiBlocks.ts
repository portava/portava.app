/**
 * CompassUiBlocks — Phase 5 dynamic UI rendering contract.
 *
 * The model may declare which UI block(s) a reply needs by putting a
 * `blocks` array inside its JSON payload. Each block references real
 * entities (place / event / person / trip) **by id or handle from tool
 * results in the same conversation turn**. This module:
 *
 *   1. Collects the candidate index from the executed tool log
 *      (search_places, get_place_details, search_events,
 *      get_circle_activity, get_current_trip).
 *   2. Validates every block reference against that index — any id the
 *      tools did not return is silently dropped (the model must never
 *      invent candidates; Phase 4 rule extended to UI blocks).
 *   3. Hydrates validated references with the real candidate data, and
 *      (for places) re-fetches coordinates from the DB so the client can
 *      deep-link to the map. Coordinates never pass through the model.
 *
 * When no blocks are declared (plain-text reply, or JSON without a
 * "blocks" key), the module synthesises blocks directly from whatever
 * the tools already fetched — so clients always see rich cards when
 * real data is available, regardless of whether the model included a
 * block envelope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolExecution } from "./CompassTools.js";

// ── Wire types (shared shape with the mobile client) ──────────────────────────

/** Phase 8 — confidence source class, carried from tool result to the client. */
export type UiSourceClass =
  | "verified_live"
  | "community_reported"
  | "historical"
  | "ai_inference";

export interface UiConfidence {
  sourceClass: UiSourceClass;
  label: string;
  checkedAt?: string;
  dataNote?: string;
}

const VALID_SOURCE_CLASSES = new Set<UiSourceClass>([
  "verified_live", "community_reported", "historical", "ai_inference",
]);

/** Validate + copy a confidence object from a tool result; null when absent/invalid. */
function pickConfidence(c: any): UiConfidence | null {
  if (!c || typeof c !== "object" || !VALID_SOURCE_CLASSES.has(c.sourceClass)) return null;
  return {
    sourceClass: c.sourceClass,
    label: typeof c.label === "string" ? c.label : c.sourceClass,
    ...(typeof c.checkedAt === "string" ? { checkedAt: c.checkedAt } : {}),
    ...(typeof c.dataNote === "string" ? { dataNote: c.dataNote } : {}),
  };
}

export interface UiPlace {
  id: string;
  name: string;
  category: string | null;
  city: string | null;
  neighborhood: string | null;
  rating: number | null;
  blurb: string | null;
  verified: boolean;
  lat: number | null;
  lng: number | null;
  /** Phase 8 — confidence label for this place's data. */
  confidence: UiConfidence | null;
  /** Phase 8 — live open-now status; null when the live source couldn't verify. */
  openNow: boolean | null;
  /** Signed recommendation token for outcome attribution — set by the ask route. */
  recommendationToken?: string;
}

export interface UiEvent {
  id: string;
  title: string;
  city: string | null;
  country: string | null;
  startsAt: string | null;
  category: string | null;
  description: string | null;
  /** Phase 8 — confidence label for this event's data. */
  confidence: UiConfidence | null;
  /** Venue coordinates — hydrated server-side, only when show_exact_location allows. */
  lat: number | null;
  lng: number | null;
  /** Signed recommendation token for outcome attribution — set by the ask route. */
  recommendationToken?: string;
}

export interface UiPerson {
  handle: string;
  circleName: string | null;
}

export type CompassUiBlock =
  | { type: "place_cards"; places: UiPlace[] }
  | { type: "event_cards"; events: UiEvent[] }
  | { type: "person_cards"; people: UiPerson[] }
  | { type: "map"; places: UiPlace[] }
  | {
      type: "comparison";
      columns: string[];
      rows: Array<{
        kind: "place" | "event";
        id: string;
        label: string;
        values: string[];
        place?: UiPlace;
        event?: UiEvent;
      }>;
    };

const MAX_ITEMS_PER_BLOCK = 6;
const MAX_BLOCKS = 4;
const MAX_COMPARISON_COLUMNS = 4;

// ── UGC unwrap ────────────────────────────────────────────────────────────────

const UGC_RE = /<\/?portava:ugc>/g;
function unwrapUgc(v: unknown): string {
  return String(v ?? "").replace(UGC_RE, "").trim();
}

// ── Candidate index from the tool log ─────────────────────────────────────────

export interface ToolCandidateIndex {
  places: Map<string, UiPlace>;
  events: Map<string, UiEvent>;
  people: Map<string, UiPerson>; // keyed by lowercase handle
}

export function collectToolCandidates(toolLog: ToolExecution[]): ToolCandidateIndex {
  const places = new Map<string, UiPlace>();
  const events = new Map<string, UiEvent>();
  const people = new Map<string, UiPerson>();

  const addPlace = (p: any) => {
    if (!p || typeof p.id !== "string" || !p.id) return;
    places.set(p.id, {
      id: p.id,
      name: unwrapUgc(p.name) || "Place",
      category: p.category ?? p.primary_category ?? null,
      city: p.city ?? null,
      neighborhood: p.neighborhood ?? null,
      rating: typeof p.rating === "number" ? p.rating : null,
      blurb: p.blurb ? unwrapUgc(p.blurb) : null,
      verified: Boolean(p.verified),
      lat: null,
      lng: null,
      confidence:
        // A verified-live open-now datum upgrades the card's label honestly;
        // an unavailable live source leaves the underlying catalog label.
        (p.liveStatus?.available === true ? pickConfidence(p.liveStatus.confidence) : null)
        ?? pickConfidence(p.confidence),
      openNow:
        p.liveStatus?.available === true && typeof p.liveStatus.openNow === "boolean"
          ? p.liveStatus.openNow
          : null,
    });
  };

  const addEvent = (e: any) => {
    if (!e || typeof e.id !== "string" || !e.id) return;
    events.set(e.id, {
      id: e.id,
      title: unwrapUgc(e.title) || "Event",
      city: e.city ?? null,
      country: e.country ?? null,
      startsAt: e.startsAt ?? e.starts_at ?? null,
      category: e.category ?? null,
      description: e.description ? unwrapUgc(e.description) : null,
      confidence: pickConfidence(e.confidence),
      lat: null,
      lng: null,
    });
  };

  for (const t of toolLog) {
    const r = t.result as any;
    if (!r || typeof r !== "object") continue;
    switch (t.name) {
      case "search_places":
        for (const p of Array.isArray(r.candidates) ? r.candidates : []) addPlace(p);
        break;
      case "get_place_details":
        if (r.place) addPlace(r.place);
        break;
      case "search_events":
        for (const e of Array.isArray(r.candidates) ? r.candidates : []) addEvent(e);
        break;
      case "get_circle_activity":
        for (const c of Array.isArray(r.circles) ? r.circles : []) {
          const circleName = c?.name ? unwrapUgc(c.name) : null;
          const members = Array.isArray(c?.memberHandles)
            ? c.memberHandles
            : Array.isArray(c?.members) ? c.members : [];
          for (const m of members) {
            const handle = unwrapUgc(typeof m === "string" ? m : m?.handle).replace(/^@/, "");
            if (!handle) continue;
            people.set(handle.toLowerCase(), { handle, circleName });
          }
        }
        break;
      default:
        break;
    }
  }
  return { places, events, people };
}

// ── Synthesis fallback ─────────────────────────────────────────────────────────

/**
 * Synthesise UI blocks from tool-log results when the model did not declare
 * any blocks in its JSON payload (e.g. plain-text reply, or JSON without a
 * "blocks" array). Produces:
 *
 *   - comparison  when ≥2 places were fetched (basic attribute columns so
 *                 the client can render a side-by-side view)
 *   - place_cards when exactly 1 place was fetched
 *   - event_cards when events were fetched (and block budget remains)
 *   - person_cards when circle people were fetched
 *
 * Returns [] when the tool log produced no candidates — there is nothing to
 * synthesise and the client correctly falls back to plain text.
 */
export function synthesizeUiBlocksFromToolLog(index: ToolCandidateIndex): CompassUiBlock[] {
  const blocks: CompassUiBlock[] = [];

  // person_cards — synthesised from get_circle_activity results.
  if (index.people.size > 0) {
    const people = [...index.people.values()].slice(0, MAX_ITEMS_PER_BLOCK);
    blocks.push({ type: "person_cards", people });
  }

  // comparison (≥2 places) or place_cards (1 place) from search_places / get_place_details.
  // For comparison, use basic attribute columns since the model didn't supply
  // query-specific values; still more useful than no card at all.
  if (index.places.size >= 2) {
    const places = [...index.places.values()].slice(0, MAX_ITEMS_PER_BLOCK);
    const columns = ["Category", "City", "Rating"];
    const rows: Extract<CompassUiBlock, { type: "comparison" }>["rows"] = places.map((p) => ({
      kind: "place" as const,
      id: p.id,
      label: p.name,
      values: [
        p.category ?? "—",
        p.city ?? "—",
        p.rating != null ? String(p.rating) : "—",
      ],
      place: p,
    }));
    blocks.push({ type: "comparison", columns, rows });
  } else if (index.places.size === 1) {
    blocks.push({ type: "place_cards", places: [...index.places.values()] });
  }

  // event_cards — synthesised from search_events results.
  if (index.events.size > 0 && blocks.length < MAX_BLOCKS) {
    const events = [...index.events.values()].slice(0, MAX_ITEMS_PER_BLOCK);
    blocks.push({ type: "event_cards", events });
  }

  return blocks.slice(0, MAX_BLOCKS);
}

// ── Block validation + hydration ──────────────────────────────────────────────

function strArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Build the validated, hydrated uiBlocks array from the model's raw payload
 * and the executed tool log. Returns [] when nothing valid was declared or
 * could be synthesised from tool results.
 *
 * When the model's payload contains no `blocks` array, blocks are synthesised
 * directly from the tool log so rich cards appear even on plain-text replies.
 *
 * `sc` is only used to re-fetch coordinates for validated/synthesised place
 * ids; pass null to skip coordinate hydration (e.g. in degraded mode).
 *
 * `outMeta` — optional out-parameter; when supplied, `.droppedInventedIds`
 * is set to the count of model-declared ids that were not found in the tool
 * log (hallucinated references). Always 0 for synthesised blocks.
 */
export async function buildUiBlocks(
  sc: SupabaseClient | null,
  payload: Record<string, unknown> | null,
  toolLog: ToolExecution[],
  outMeta?: { droppedInventedIds: number },
): Promise<CompassUiBlock[]> {
  const index = collectToolCandidates(toolLog);

  const rawBlocks = payload && Array.isArray((payload as any).blocks)
    ? ((payload as any).blocks as unknown[])
    : [];

  // ── Synthesis path: no model-declared blocks ──────────────────────────────
  // When the model returned plain text (payload is null), returned JSON
  // without a "blocks" key, or the blocks array is empty, synthesise blocks
  // directly from whatever the tools fetched. This ensures rich cards appear
  // for place/event/person results regardless of the model's envelope.
  if (rawBlocks.length === 0) {
    if (outMeta) outMeta.droppedInventedIds = 0;
    const synthesised = synthesizeUiBlocksFromToolLog(index);
    // Coordinate hydration for synthesised blocks (same logic as validated path).
    await hydrateBlockCoordinates(sc, synthesised);
    return synthesised;
  }

  // ── Validation path: model declared blocks ────────────────────────────────
  let droppedInventedIds = 0;
  const blocks: CompassUiBlock[] = [];
  const wantedPlaceIds = new Set<string>();
  const wantedEventIds = new Set<string>();

  for (const raw of rawBlocks) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;

    switch (b.type) {
      case "place_cards":
      case "map": {
        const ids = strArray(b.placeIds, MAX_ITEMS_PER_BLOCK);
        const places: UiPlace[] = [];
        for (const id of ids) {
          const p = index.places.get(id);
          if (p) places.push(p);
          else droppedInventedIds++;
        }
        if (places.length === 0) continue;
        for (const p of places) wantedPlaceIds.add(p.id);
        blocks.push({ type: b.type, places } as CompassUiBlock);
        break;
      }
      case "event_cards": {
        const ids = strArray(b.eventIds, MAX_ITEMS_PER_BLOCK);
        const eventsArr: UiEvent[] = [];
        for (const id of ids) {
          const e = index.events.get(id);
          if (e) eventsArr.push(e);
          else droppedInventedIds++;
        }
        if (eventsArr.length === 0) continue;
        for (const e of eventsArr) wantedEventIds.add(e.id);
        blocks.push({ type: "event_cards", events: eventsArr });
        break;
      }
      case "person_cards": {
        const handles = strArray(b.handles, MAX_ITEMS_PER_BLOCK);
        const peopleArr: UiPerson[] = [];
        for (const h of handles) {
          const p = index.people.get(h.replace(/^@/, "").toLowerCase());
          if (p) peopleArr.push(p);
          else droppedInventedIds++;
        }
        if (peopleArr.length === 0) continue;
        blocks.push({ type: "person_cards", people: peopleArr });
        break;
      }
      case "comparison": {
        const columns = strArray(b.columns, MAX_COMPARISON_COLUMNS).map((c) => c.slice(0, 40));
        const rawRows = Array.isArray(b.rows) ? b.rows.slice(0, MAX_ITEMS_PER_BLOCK) : [];
        const rows: Extract<CompassUiBlock, { type: "comparison" }>["rows"] = [];
        for (const rr of rawRows) {
          if (!rr || typeof rr !== "object") continue;
          const row = rr as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : "";
          const kind = row.kind === "event" ? "event" : "place";
          const values = strArray(row.values, MAX_COMPARISON_COLUMNS).map((v) => v.slice(0, 80));
          if (kind === "place") {
            const place = index.places.get(id);
            if (!place) { droppedInventedIds++; continue; }
            wantedPlaceIds.add(place.id);
            rows.push({ kind, id, label: place.name, values, place });
          } else {
            const event = index.events.get(id);
            if (!event) { droppedInventedIds++; continue; }
            wantedEventIds.add(event.id);
            rows.push({ kind, id, label: event.title, values, event });
          }
        }
        if (rows.length === 0 || columns.length === 0) continue;
        blocks.push({ type: "comparison", columns, rows });
        break;
      }
      default:
        break;
    }
  }

  if (outMeta) outMeta.droppedInventedIds = droppedInventedIds;

  // ── Coordinate hydration for validated place/event ids (server-side only) ─
  await hydrateBlockCoordinates(sc, blocks, wantedPlaceIds, wantedEventIds);

  return blocks;
}

// ── Coordinate hydration helper ───────────────────────────────────────────────

/**
 * Re-fetch coordinates from the DB for all place/event ids referenced in
 * `blocks` and attach them in-place. Coordinates never pass through the model.
 *
 * When `wantedPlaceIds` / `wantedEventIds` are omitted, all ids referenced
 * in the blocks are collected and fetched (used by the synthesis path).
 */
async function hydrateBlockCoordinates(
  sc: SupabaseClient | null,
  blocks: CompassUiBlock[],
  wantedPlaceIds?: Set<string>,
  wantedEventIds?: Set<string>,
): Promise<void> {
  // Collect ids when not pre-computed (synthesis path).
  if (!wantedPlaceIds) {
    wantedPlaceIds = new Set<string>();
    for (const blk of blocks) {
      if (blk.type === "place_cards" || blk.type === "map") {
        for (const p of blk.places) wantedPlaceIds.add(p.id);
      } else if (blk.type === "comparison") {
        for (const r of blk.rows) { if (r.place) wantedPlaceIds.add(r.place.id); }
      }
    }
  }
  if (!wantedEventIds) {
    wantedEventIds = new Set<string>();
    for (const blk of blocks) {
      if (blk.type === "event_cards") {
        for (const e of blk.events) wantedEventIds.add(e.id);
      } else if (blk.type === "comparison") {
        for (const r of blk.rows) { if (r.event) wantedEventIds.add(r.event.id); }
      }
    }
  }

  // ── Place coordinates ─────────────────────────────────────────────────────
  if (sc && wantedPlaceIds.size > 0) {
    try {
      const { data } = await sc
        .from("discovery_places")
        .select("id, lat, lng")
        .in("id", [...wantedPlaceIds]);
      const coords = new Map<string, { lat: number | null; lng: number | null }>();
      for (const row of (data ?? []) as any[]) {
        coords.set(row.id, {
          lat: typeof row.lat === "number" ? row.lat : null,
          lng: typeof row.lng === "number" ? row.lng : null,
        });
      }
      const apply = (p: UiPlace) => {
        const c = coords.get(p.id);
        if (c) { p.lat = c.lat; p.lng = c.lng; }
      };
      for (const blk of blocks) {
        if (blk.type === "place_cards" || blk.type === "map") blk.places.forEach(apply);
        if (blk.type === "comparison") blk.rows.forEach((r) => { if (r.place) apply(r.place); });
      }
    } catch { /* non-fatal — blocks ship without coordinates */ }
  }

  // ── Event coordinates ─────────────────────────────────────────────────────
  // Privacy: an event's exact venue coordinates are only exposed when the host
  // allows it (show_exact_location !== false — same rule as the events routes).
  if (sc && wantedEventIds.size > 0) {
    try {
      const { data } = await sc
        .from("events")
        .select("id, location_lat, location_lng, show_exact_location")
        .in("id", [...wantedEventIds]);
      const coords = new Map<string, { lat: number | null; lng: number | null }>();
      for (const row of (data ?? []) as any[]) {
        if (row.show_exact_location === false) continue;
        coords.set(row.id, {
          lat: typeof row.location_lat === "number" ? row.location_lat : null,
          lng: typeof row.location_lng === "number" ? row.location_lng : null,
        });
      }
      const apply = (e: UiEvent) => {
        const c = coords.get(e.id);
        if (c) { e.lat = c.lat; e.lng = c.lng; }
      };
      for (const blk of blocks) {
        if (blk.type === "event_cards") blk.events.forEach(apply);
        if (blk.type === "comparison") blk.rows.forEach((r) => { if (r.event) apply(r.event); });
      }
    } catch { /* non-fatal — blocks ship without coordinates */ }
  }
}
