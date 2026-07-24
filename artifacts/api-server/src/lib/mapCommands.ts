/**
 * mapCommands — the validated Compass→map command protocol.
 *
 * Compass (or any assistant surface) can drive a running map, but ONLY through
 * this closed set of commands, each range-validated on the server before it
 * leaves. The client applies them to its canonical map store. This is what lets
 * us replace the old client-side "geocode the query string and fly" heuristic:
 * the server resolves coordinates (via a real geocoder) and emits a structured
 * set-viewport, instead of the client guessing.
 *
 * Every command is validated here again right before the response is sent
 * (defense in depth) so a malformed builder can never emit an out-of-range
 * viewport or an unknown filter key.
 */

export type MapCommand =
  | { type: "set-viewport"; lat: number; lng: number; radiusKm: number; label?: string }
  | { type: "search-area"; lat: number; lng: number; radiusKm: number; query?: string; types?: string[] }
  | { type: "select-entity"; entityId: string }
  | { type: "add-filter"; key: string; value: string | boolean }
  | { type: "clear-filters" };

/** The only entity types a search-area / filter command may reference. */
export const ALLOWED_RESULT_TYPES = ["traveler", "gem", "event"] as const;
/** The only filter keys the map understands (mirrors MapFilterSheet). */
export const ALLOWED_FILTER_KEYS = new Set(["type", "openToMeet", "verified", "category", "freshness"]);

function finiteInRange(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function clampRadius(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 25;
  return Math.min(200, Math.max(1, n));
}

/**
 * Validate an untrusted command object. Returns a clean, typed command or null
 * (drop it — never pass a partially-valid command through).
 */
export function validateMapCommand(raw: any): MapCommand | null {
  if (!raw || typeof raw !== "object" || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "set-viewport": {
      const lat = finiteInRange(raw.lat, -90, 90);
      const lng = finiteInRange(raw.lng, -180, 180);
      if (lat == null || lng == null) return null;
      const cmd: MapCommand = { type: "set-viewport", lat, lng, radiusKm: clampRadius(raw.radiusKm) };
      if (typeof raw.label === "string" && raw.label.trim()) cmd.label = raw.label.trim().slice(0, 120);
      return cmd;
    }
    case "search-area": {
      const lat = finiteInRange(raw.lat, -90, 90);
      const lng = finiteInRange(raw.lng, -180, 180);
      if (lat == null || lng == null) return null;
      const cmd: any = { type: "search-area", lat, lng, radiusKm: clampRadius(raw.radiusKm) };
      if (typeof raw.query === "string" && raw.query.trim()) cmd.query = raw.query.trim().slice(0, 200);
      if (Array.isArray(raw.types)) {
        const types = raw.types.filter((t: any) => (ALLOWED_RESULT_TYPES as readonly string[]).includes(t));
        if (types.length) cmd.types = types;
      }
      return cmd as MapCommand;
    }
    case "select-entity": {
      const id = typeof raw.entityId === "string" ? raw.entityId.trim() : "";
      return id ? { type: "select-entity", entityId: id.slice(0, 200) } : null;
    }
    case "add-filter": {
      const key = typeof raw.key === "string" ? raw.key : "";
      if (!ALLOWED_FILTER_KEYS.has(key)) return null;
      const value = typeof raw.value === "boolean" ? raw.value
        : typeof raw.value === "string" ? raw.value.trim().slice(0, 80)
        : null;
      return value == null || value === "" ? null : { type: "add-filter", key, value };
    }
    case "clear-filters":
      return { type: "clear-filters" };
    default:
      return null;
  }
}

/** Validate a list, dropping any invalid command (never throws). */
export function validateMapCommands(raw: any[]): MapCommand[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(validateMapCommand).filter((c): c is MapCommand => c !== null);
}

// ── Intent → commands ─────────────────────────────────────────────────────────

export interface MapIntent {
  kind: "go_to" | "search" | "select" | "filter" | "clear";
  query?: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null;
  entityId?: string | null;
  types?: string[] | null;
  filters?: Array<{ key: string; value: string | boolean }> | null;
}

export interface GeocodeHit {
  lat: number;
  lng: number;
  label: string;
}

/**
 * Turn a structured intent into a validated command list + a "why this" line.
 * `resolve` forward-geocodes a query string to coordinates (server-side) when the
 * intent has no explicit lat/lng. Fail-soft: if geocoding yields nothing, a
 * go_to/search with only a query returns no viewport command (and an honest
 * explanation) rather than guessing.
 */
export async function buildCommandsFromIntent(
  intent: MapIntent,
  resolve: (query: string) => Promise<GeocodeHit | null>,
): Promise<{ commands: MapCommand[]; explanation: string }> {
  const out: MapCommand[] = [];
  let why = "";

  const explicit =
    intent.lat != null && intent.lng != null ? { lat: intent.lat, lng: intent.lng, label: undefined as string | undefined } : null;

  const resolveCenter = async (): Promise<{ lat: number; lng: number; label?: string } | null> => {
    if (explicit) return explicit;
    if (intent.query && intent.query.trim()) {
      const hit = await resolve(intent.query.trim());
      if (hit) return { lat: hit.lat, lng: hit.lng, label: hit.label };
    }
    return null;
  };

  switch (intent.kind) {
    case "go_to": {
      const c = await resolveCenter();
      if (c) {
        out.push({ type: "set-viewport", lat: c.lat, lng: c.lng, radiusKm: clampRadius(intent.radiusKm), ...(c.label ? { label: c.label } : {}) });
        why = c.label ? `Centred the map on ${c.label}.` : "Centred the map on the requested point.";
      } else {
        why = "Couldn't resolve that place to a location, so the map was left where it is.";
      }
      break;
    }
    case "search": {
      const c = await resolveCenter();
      if (c) {
        out.push({ type: "set-viewport", lat: c.lat, lng: c.lng, radiusKm: clampRadius(intent.radiusKm), ...(c.label ? { label: c.label } : {}) });
        const sa: any = { type: "search-area", lat: c.lat, lng: c.lng, radiusKm: clampRadius(intent.radiusKm) };
        if (intent.query && intent.query.trim()) sa.query = intent.query.trim();
        if (intent.types && intent.types.length) sa.types = intent.types;
        out.push(sa);
        why = c.label ? `Searching ${c.label} for matches.` : "Searching this area for matches.";
      } else {
        why = "Couldn't resolve a place to search, so nothing was changed.";
      }
      break;
    }
    case "select": {
      if (intent.entityId && intent.entityId.trim()) {
        out.push({ type: "select-entity", entityId: intent.entityId.trim() });
        why = "Selected the requested item on the map.";
      } else {
        why = "No item id was provided to select.";
      }
      break;
    }
    case "filter": {
      for (const f of intent.filters ?? []) {
        out.push({ type: "add-filter", key: f.key, value: f.value });
      }
      why = out.length ? "Applied the requested filters." : "No valid filters to apply.";
      break;
    }
    case "clear": {
      out.push({ type: "clear-filters" });
      why = "Cleared the map filters.";
      break;
    }
    default:
      why = "Unrecognized request.";
  }

  // Defense in depth: re-validate everything before returning.
  return { commands: validateMapCommands(out), explanation: why };
}
