/**
 * placeIdBridge — the id-space bridge between the Discovery SERVE id space and
 * the CANONICAL place id used by place memory + saved_places.
 *
 * WHY THIS EXISTS (the New-to-Me / §13 unblocker)
 * -----------------------------------------------
 * The New-to-Me primitive `memory_is_new_to_user` (migration 2185) and the
 * Discovery memory-consumer (§13) both key on the id place memory is projected
 * under: `subject_type = 'place'`, `subject_id = saved_places.place_id`, which is
 * a `discovery_places.id` (a uuid). The projector proves this — it joins
 * `saved_places s LEFT JOIN discovery_places dp ON dp.id = s.place_id` (2191).
 *
 * The Discovery serve path emits a DIFFERENT id space:
 *   - `db/<discovery_places.id>` — curated / traveler / osm-mirror rows
 *     (queryDbPlaces).
 *   - `db/<places.id>`           — canonical public.places rows
 *     (queryCanonicalPlaces). The uuid here is a places.id, NOT a
 *     discovery_places.id; the two are linked by
 *     `discovery_places.canonical_location_id -> places.id` (migration 2053).
 *   - `<type>/<id>` e.g. `node/12345678` — live OSM elements
 *     (mapOsmElementToPlace). An `osm/`-prefixed form is also accepted. These map
 *     to a `discovery_places` row by `discovery_places.osm_id` (migration 0086),
 *     which is created lazily on first save (wishlist trackOsmPlaceSave).
 *
 * Calling `memory_is_new_to_user` with a raw served id therefore matches nothing
 * for the canonical-places and OSM cases and reports EVERY place as "new to me" —
 * the silent, confident wrong answer 2185's comment warns about. This module maps
 * a page of served ids to the `discovery_places.id`s place memory could be keyed
 * under, so novelty and already-known feedback land on the right subject.
 *
 * DESIGN
 * ------
 *   - Batch-friendly: one PostgREST round-trip resolves a whole page of
 *     candidates (a single `.or()` over id / canonical_location_id / osm_id).
 *   - Non-fatal: any error resolves to "no mapping" (⇒ treated as new), never
 *     throws into the serve path.
 *   - Cached: the id-space mapping is STRUCTURAL (per served id, NOT per user),
 *     so it is safe to cache with a short TTL. Per-user novelty is never cached.
 *   - Reusable: `resolvePlaceIdBridge` is the same bridge §13 needs; the
 *     serve-path annotation and the already-known emitter are thin layers on it.
 */
import { pruneAndBound } from "./boundedMapCache.js";
import { isFlagEnabled } from "./featureFlags.js";

/**
 * Structural DB reader — the subset of the Supabase client we use. Typed loosely
 * (the codebase convention, cf. featureFlags.isFlagEnabled) so the real client's
 * thenable query/rpc builders are assignable without fighting its generics.
 */
type DbLike = {
  from: (table: string) => any;
  rpc: (fn: string, args: Record<string, unknown>) => any;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OSM_KEY_RE = /^(node|way|relation)\/\d+$/;

/** The feature flag that gates the whole New-to-Me surface (off by default). */
export const MEMORY_PROJECTION_FLAG = "memory_projection";

/** Parsed classification of a single Discovery-served place id. */
type ParsedId =
  | { kind: "db"; uuid: string }
  | { kind: "osm"; osmKey: string }
  | { kind: "unknown" };

/**
 * Classify a served id into the bridgeable spaces. A `db/<uuid>` uuid may be a
 * discovery_places.id OR a places.id — the resolver handles both. An OSM key is
 * accepted both bare (`node/123`, as the serve path emits) and `osm/`-prefixed.
 */
export function parseServedPlaceId(servedId: string): ParsedId {
  if (typeof servedId !== "string" || servedId.length === 0) return { kind: "unknown" };
  if (servedId.startsWith("db/")) {
    const uuid = servedId.slice(3);
    return UUID_RE.test(uuid) ? { kind: "db", uuid } : { kind: "unknown" };
  }
  const osmCandidate = servedId.startsWith("osm/") ? servedId.slice(4) : servedId;
  if (OSM_KEY_RE.test(osmCandidate)) return { kind: "osm", osmKey: osmCandidate };
  return { kind: "unknown" };
}

export interface PlaceBridgeResult {
  /**
   * servedId -> the set of `discovery_places.id`s place memory could be keyed
   * under for that served place. Empty (or absent) means no such row exists — the
   * place has never entered discovery_places, so no place memory can key on it
   * and it is genuinely new.
   */
  toCanonical: Map<string, Set<string>>;
  /** discovery_places.id -> a served id that references it (first match wins). */
  toServed: Map<string, string>;
}

// ── Structural cache (per served id → discovery_places.ids). NOT per user. ──────
interface CacheRow { dpIds: string[]; at: number }
const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes — a hint, not a source of truth
const CACHE_MAX_ENTRIES = 5_000;
const _bridgeCache = new Map<string, CacheRow>();

/** Test hook — drop the structural cache so a test controls every resolution. */
export function _clearPlaceIdBridgeCache(): void {
  _bridgeCache.clear();
}

function csv(values: Iterable<string>): string {
  return [...values].join(",");
}

/**
 * Resolve a page of Discovery-served ids to the canonical `discovery_places.id`s
 * place memory keys on. One round-trip; non-fatal; structurally cached.
 *
 * @param opts.noCache bypass the structural cache (used by the already-known
 *   emitter, which must never write feedback to a stale/missing subject).
 */
export async function resolvePlaceIdBridge(
  sc: DbLike,
  servedIds: Iterable<string>,
  opts: { noCache?: boolean } = {},
): Promise<PlaceBridgeResult> {
  const toCanonical = new Map<string, Set<string>>();
  const toServed = new Map<string, string>();

  const add = (served: string, dpId: string): void => {
    let set = toCanonical.get(served);
    if (!set) { set = new Set<string>(); toCanonical.set(served, set); }
    set.add(dpId);
    if (!toServed.has(dpId)) toServed.set(dpId, served);
  };

  // Classify and de-dup the page. Map lookup keys back to their served ids so we
  // can re-attribute the DB rows (which carry only id / canonical / osm_id).
  const dbUuidToServed = new Map<string, string>();      // uuid -> "db/<uuid>"
  const osmKeyToServed = new Map<string, Set<string>>(); // osmKey -> served ids
  const needQuery: string[] = [];                        // served ids not cache-served

  for (const servedId of servedIds) {
    if (toCanonical.has(servedId)) continue; // already handled this served id

    // Cache hit — reuse the structural mapping.
    if (!opts.noCache) {
      const cached = _bridgeCache.get(servedId);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        if (cached.dpIds.length === 0) {
          toCanonical.set(servedId, new Set()); // known-empty, still recorded
        } else {
          for (const dpId of cached.dpIds) add(servedId, dpId);
        }
        continue;
      }
    }

    const parsed = parseServedPlaceId(servedId);
    if (parsed.kind === "db") {
      dbUuidToServed.set(parsed.uuid, servedId);
      needQuery.push(servedId);
    } else if (parsed.kind === "osm") {
      let set = osmKeyToServed.get(parsed.osmKey);
      if (!set) { set = new Set<string>(); osmKeyToServed.set(parsed.osmKey, set); }
      set.add(servedId);
      needQuery.push(servedId);
    }
    // unknown ids resolve to no mapping — genuinely new.
  }

  const dbUuids = [...dbUuidToServed.keys()];
  const osmKeys = [...osmKeyToServed.keys()];

  if (dbUuids.length > 0 || osmKeys.length > 0) {
    try {
      const orParts: string[] = [];
      if (dbUuids.length > 0) {
        orParts.push(`id.in.(${csv(dbUuids)})`);
        orParts.push(`canonical_location_id.in.(${csv(dbUuids)})`);
      }
      if (osmKeys.length > 0) {
        orParts.push(`osm_id.in.(${csv(osmKeys)})`);
      }
      const { data, error } = await sc
        .from("discovery_places")
        .select("id, canonical_location_id, osm_id")
        .or(orParts.join(","));
      if (!error && Array.isArray(data)) {
        for (const row of data as Array<{ id?: string | null; canonical_location_id?: string | null; osm_id?: string | null }>) {
          const dpId = row.id;
          if (!dpId) continue;
          // Direct discovery_places.id — served as db/<dp.id>.
          const directServed = dbUuidToServed.get(dpId);
          if (directServed) add(directServed, dpId);
          // Canonical mirror — served as db/<places.id> (places.id == canonical_location_id).
          const canon = row.canonical_location_id;
          if (canon) {
            const canonServed = dbUuidToServed.get(canon);
            if (canonServed) add(canonServed, dpId);
          }
          // OSM mirror — served as node/<id> (or osm/node/<id>).
          const osm = row.osm_id;
          if (osm) {
            const osmServedSet = osmKeyToServed.get(osm);
            if (osmServedSet) for (const s of osmServedSet) add(s, dpId);
          }
        }
      }
    } catch {
      // Non-fatal: leave unresolved served ids with no mapping (⇒ treated new).
    }
  }

  // Write structural results back to the cache — including known-empties, so a
  // place with no discovery_places row is not re-queried every page.
  if (!opts.noCache) {
    for (const servedId of needQuery) {
      const set = toCanonical.get(servedId);
      _bridgeCache.set(servedId, { dpIds: set ? [...set] : [], at: Date.now() });
    }
    pruneAndBound(_bridgeCache, {
      max: CACHE_MAX_ENTRIES,
      ttlMs: CACHE_TTL_MS,
      timestampOf: (e) => e.at,
    });
  }

  return { toCanonical, toServed };
}

/**
 * Annotate a page of served place-like objects with a `newToMe` boolean, gated
 * on the `memory_projection` flag.
 *
 * ADDITIVE + FAIL-SAFE by contract:
 *   - flag off, no user, empty page, or ANY error ⇒ the input array is returned
 *     UNCHANGED (same object references, same order, no `newToMe` field), so the
 *     serve path behaves exactly as it does today until the owner flips the flag.
 *   - on success ⇒ a NEW array in the SAME order, each element a shallow copy
 *     carrying `newToMe`. Order is never touched, so it cannot disturb the pde /
 *     legacy serve order shipped in #250.
 *
 * `newToMe` is true when the place has no canonical mapping, OR none of its
 * canonical `discovery_places.id`s has active memory or an already_known /
 * not_interested signal — the exact semantics of `memory_is_new_to_user` (2185),
 * evaluated for the whole page in ONE round-trip via `memory_are_new_to_user`.
 */
export async function annotateNewToMe<T extends { id: string }>(
  sc: DbLike | null | undefined,
  userId: string | null | undefined,
  items: T[],
): Promise<T[] | (T & { newToMe: boolean })[]> {
  if (!sc || !userId || items.length === 0) return items;
  try {
    if (!(await isFlagEnabled(sc, MEMORY_PROJECTION_FLAG))) return items;

    const bridge = await resolvePlaceIdBridge(sc, items.map((i) => i.id));

    const allSubjects = new Set<string>();
    for (const set of bridge.toCanonical.values()) {
      for (const dpId of set) allSubjects.add(dpId);
    }

    const isNewById = new Map<string, boolean>();
    if (allSubjects.size > 0) {
      const { data, error } = await sc.rpc("memory_are_new_to_user", {
        p_user_id: userId,
        p_subject_type: "place",
        p_subject_ids: [...allSubjects],
      });
      if (error) return items; // fail-safe — omit the annotation entirely
      for (const row of (data as Array<{ subject_id?: string; is_new?: boolean }>) ?? []) {
        if (typeof row.subject_id === "string") isNewById.set(row.subject_id, Boolean(row.is_new));
      }
    }

    return items.map((item) => {
      const cands = bridge.toCanonical.get(item.id);
      let newToMe = true;
      if (cands && cands.size > 0) {
        for (const dpId of cands) {
          // Known when any candidate subject is explicitly not-new.
          if (isNewById.get(dpId) === false) { newToMe = false; break; }
        }
      }
      return { ...item, newToMe };
    });
  } catch {
    return items; // never break the serve
  }
}

export type AlreadyKnownResult = "recorded" | "not_found" | "error";

/**
 * Record an `already_known` memory-feedback signal for a Discovery-served place,
 * bridging the served id to the canonical `discovery_places.id` that place memory
 * (and memory_retrieve's discovery suppression, 2185/2196) keys on.
 *
 * Reuses the existing memory_feedback write path (routes/compass.ts) — same
 * table, same kind vocabulary — rather than inventing a new one. Ownership is
 * enforced by writing user_id from auth, never client input. Idempotent: the
 * dedupe unique index makes a repeat a no-op (23505 ⇒ success).
 */
export async function recordDiscoveryAlreadyKnown(
  sc: DbLike,
  userId: string,
  servedPlaceId: string,
): Promise<AlreadyKnownResult> {
  try {
    // Resolve fresh (noCache) — feedback must never land on a stale/missing id.
    const bridge = await resolvePlaceIdBridge(sc, [servedPlaceId], { noCache: true });
    const cands = bridge.toCanonical.get(servedPlaceId);
    const subjectId = cands && cands.size > 0 ? [...cands][0] : null;
    if (!subjectId) return "not_found";

    const { error } = await sc.from("memory_feedback").insert({
      user_id: userId,
      kind: "already_known",
      projection_id: null,
      memory_type: null,
      subject_type: "place",
      subject_id: subjectId,
    });
    if (error && (error as { code?: string }).code !== "23505") return "error";
    return "recorded";
  } catch {
    return "error";
  }
}
