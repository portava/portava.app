/**
 * mapSearch — the normalized envelope for GET /api/map/search.
 *
 * The map surfaces several entity types (travelers, hidden gems, events, …) that
 * each have their own privacy-safe source. This module does NOT re-query or
 * re-decide privacy — the route calls each existing privacy-complete source and
 * hands the already-safe rows here to be shaped into ONE normalized result type.
 * Keeping the shaping pure (no DB, no side effects) makes ranking + pagination
 * unit-testable and guarantees this layer can never widen what a source exposed.
 *
 * Contract note: coordinates on a result are whatever the source already decided
 * to expose (coarsened traveler pins, gem coords per sensitivity, event venue).
 * This module never sharpens them.
 */

export type MapResultType = "traveler" | "gem" | "event";

export interface MapSearchResult {
  resultType: MapResultType;
  id: string;
  coordinates: { lat: number; lng: number } | null;
  preview: {
    title: string;
    subtitle: string | null;
    thumbnailUrl: string | null;
    badges: string[];
  };
  /** Server-supplied capability hints; the CLIENT shows affordances off these,
   *  but each action re-checks on the server when invoked (no client-only gate). */
  permissions: { canMessage?: boolean; canViewExact?: boolean };
  /** Capability slugs the map card may offer (drives the action row). */
  actions: string[];
  freshness: "live" | "recent" | null;
  /** Human "why this?" line, safe to show. */
  rankingReason: string | null;
  /** Distance from the viewport centre (km), filled by rankResults. */
  distanceKm?: number | null;
}

export interface MapSearchEnvelope {
  results: MapSearchResult[];
  viewport: { lat: number; lng: number; radiusKm: number };
  total: number;
  nextCursor: string | null;
  generatedAt: string;
}

// ── Normalizers (pure) ────────────────────────────────────────────────────────

function joinParts(parts: (string | null | undefined)[], sep: string): string | null {
  const s = parts.filter((p) => p != null && String(p).trim() !== "").join(sep);
  return s === "" ? null : s;
}

/** A coarsened map-traveler payload (from lib/mapTravelers.listMapTravelers). */
export function normalizeTraveler(t: any): MapSearchResult {
  return {
    resultType: "traveler",
    id: String(t.id),
    coordinates: t.lat != null && t.lng != null ? { lat: t.lat, lng: t.lng } : null,
    preview: {
      title: t.displayName ?? "Traveler",
      subtitle: joinParts([t.city, t.country], ", "),
      thumbnailUrl: t.avatarUrl ?? null,
      badges: [t.verified ? "verified" : null, t.openToMeet ? "open to meet" : null]
        .filter(Boolean) as string[],
    },
    permissions: { canMessage: t.openToMeet === true, canViewExact: false },
    actions: ["view", "message", "follow", "report", "block"],
    freshness: t.freshness ?? null,
    rankingReason: t.precision ? `${t.precision} precision${t.freshness ? " · " + t.freshness : ""}` : null,
  };
}

/** A privacy-guarded gem (from applyGemPrivacy) plus its ranked distance. */
export function normalizeGem(g: any, distanceKm: number | null = null): MapSearchResult {
  return {
    resultType: "gem",
    id: String(g.id),
    coordinates: g.lat != null && g.lng != null ? { lat: g.lat, lng: g.lng } : null,
    preview: {
      title: g.name ?? "Hidden gem",
      subtitle: joinParts([g.category, g.city], " · "),
      // `image_url` is the column hidden_gems has and findNearbyGems selects;
      // `thumbnail_url` is not a column on that table at all, so map-search gem
      // results have never carried a thumbnail. Same defect as projectGem in
      // lib/mapProjection.ts, fixed in the same change.
      thumbnailUrl: g.image_url ?? null,
      badges: [g.verification_level, g.coordsPrecision === "approximate" ? "approx. location" : null]
        .filter(Boolean) as string[],
    },
    permissions: { canViewExact: g.coordsPrecision === "exact" },
    actions: ["view", "save", "share", "directions", "add-to-trip", "report"],
    freshness: null,
    rankingReason: distanceKm != null ? `${distanceKm.toFixed(1)} km away` : null,
  };
}

/** A raw (already eligibility/block-filtered) event row. */
export function normalizeEvent(ev: any): MapSearchResult {
  return {
    resultType: "event",
    id: String(ev.id),
    coordinates:
      ev.location_lat != null && ev.location_lng != null
        ? { lat: Number(ev.location_lat), lng: Number(ev.location_lng) }
        : null,
    preview: {
      title: ev.title ?? "Event",
      subtitle: joinParts([ev.location_name, ev.starts_at ? String(ev.starts_at).slice(0, 10) : null], " · "),
      thumbnailUrl: ev.cover_url ?? null,
      badges: ["event", ev.visibility === "friends_only" ? "friends only" : null].filter(Boolean) as string[],
    },
    permissions: {},
    actions: ["view", "join", "share", "directions", "add-to-trip", "report"],
    freshness: null,
    rankingReason: ev.starts_at ? `starts ${String(ev.starts_at).slice(0, 10)}` : null,
  };
}

// ── Ranking + pagination (pure) ───────────────────────────────────────────────

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Attach distance-from-centre and sort: nearest first; results without
 * coordinates sink to the end. Stable for equal distances (by id) so paging is
 * deterministic. Pure — safe to unit-test.
 */
export function rankResults(
  results: MapSearchResult[],
  center: { lat: number; lng: number },
): MapSearchResult[] {
  const withD = results.map((r) => ({
    r,
    d: r.coordinates ? haversineKm(center.lat, center.lng, r.coordinates.lat, r.coordinates.lng) : Infinity,
  }));
  withD.sort((a, b) => (a.d !== b.d ? a.d - b.d : a.r.id.localeCompare(b.r.id)));
  return withD.map(({ r, d }) => ({ ...r, distanceKm: Number.isFinite(d) ? Number(d.toFixed(2)) : null }));
}

/** Case-insensitive substring filter over title + subtitle. */
export function filterByQuery(results: MapSearchResult[], query: string | null | undefined): MapSearchResult[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return results;
  return results.filter((r) =>
    `${r.preview.title} ${r.preview.subtitle ?? ""}`.toLowerCase().includes(q),
  );
}

/** Opaque numeric-offset cursor. */
export function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(String(cursor), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function paginate(
  results: MapSearchResult[],
  cursor: string | null | undefined,
  limit: number,
): { page: MapSearchResult[]; nextCursor: string | null } {
  const off = decodeCursor(cursor);
  const lim = Math.min(100, Math.max(1, limit));
  const page = results.slice(off, off + lim);
  const nextOff = off + lim;
  return { page, nextCursor: nextOff < results.length ? String(nextOff) : null };
}
