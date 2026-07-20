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
 * A block that ends up with no valid entities is dropped entirely, so the
 * client falls back to plain text.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolExecution } from "./CompassTools.js";

// ── Wire types (shared shape with the mobile client) ──────────────────────────

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
}

export interface UiEvent {
  id: string;
  title: string;
  city: string | null;
  country: string | null;
  startsAt: string | null;
  category: string | null;
  description: string | null;
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
 * and the executed tool log. Returns [] when nothing valid was declared.
 *
 * `sc` is only used to re-fetch coordinates for validated place ids; pass
 * null to skip coordinate hydration (e.g. in degraded mode).
 */
export async function buildUiBlocks(
  sc: SupabaseClient | null,
  payload: Record<string, unknown> | null,
  toolLog: ToolExecution[],
): Promise<CompassUiBlock[]> {
  const rawBlocks = payload && Array.isArray((payload as any).blocks)
    ? ((payload as any).blocks as unknown[])
    : [];
  if (rawBlocks.length === 0) return [];

  const index = collectToolCandidates(toolLog);
  const blocks: CompassUiBlock[] = [];
  const wantedPlaceIds = new Set<string>();

  for (const raw of rawBlocks) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;

    switch (b.type) {
      case "place_cards":
      case "map": {
        const ids = strArray(b.placeIds, MAX_ITEMS_PER_BLOCK);
        const places = ids
          .map((id) => index.places.get(id))
          .filter((p): p is UiPlace => Boolean(p));
        if (places.length === 0) continue;
        for (const p of places) wantedPlaceIds.add(p.id);
        blocks.push({ type: b.type, places } as CompassUiBlock);
        break;
      }
      case "event_cards": {
        const ids = strArray(b.eventIds, MAX_ITEMS_PER_BLOCK);
        const eventsArr = ids
          .map((id) => index.events.get(id))
          .filter((e): e is UiEvent => Boolean(e));
        if (eventsArr.length === 0) continue;
        blocks.push({ type: "event_cards", events: eventsArr });
        break;
      }
      case "person_cards": {
        const handles = strArray(b.handles, MAX_ITEMS_PER_BLOCK);
        const peopleArr = handles
          .map((h) => index.people.get(h.replace(/^@/, "").toLowerCase()))
          .filter((p): p is UiPerson => Boolean(p));
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
            if (!place) continue;
            wantedPlaceIds.add(place.id);
            rows.push({ kind, id, label: place.name, values, place });
          } else {
            const event = index.events.get(id);
            if (!event) continue;
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

  // ── Coordinate hydration for validated place ids (server-side only) ────────
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

  return blocks;
}
