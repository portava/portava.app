/**
 * The MAP-OWNED half of the Trip Map projection contract (Trips spec §14.1,
 * §19.1, §19.4) — types, constants and PURE functions. No I/O.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: THE PRODUCER HAD NO CONSUMER
 * ═══════════════════════════════════════════════════════════════════════════
 * Migration 2520 and lib/mapTripProjectionWorker.ts built the §19.4 worker:
 * it drains public.trip_outbox into public.trip_map_projections, ordered by
 * aggregate_version, idempotent by event_id, with a rebuild path. It is
 * correct and, until this file's reader shipped, it was DEAD — no reader
 * consumed the table, so routes/mapProjection.ts still derived the trip_stop
 * layer from canonical `trips` at request time and the projection closed zero
 * Map census rows. 2520's own header says so and defers the decision:
 * "Whether the map's trip_stop layer should read this table instead of
 * canonical `trips` is a product decision NOT taken here." This is that
 * decision, taken from MAP's needs.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONTRACT — WHAT MAP NEEDS, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 * Map does not need Trip semantics; it needs to draw a pin. The whole of what
 * `lib/mapProjection.projectTrip` reads is ten fields, so the contract is
 * exactly ten fields — deliberately far narrower than `AuthorizedTripView`,
 * which carries budget, notes, documents, cover media, permissions and every
 * privacy toggle. None of those can appear on a map, so none of them are here.
 *
 *   identity        trip_id                → the object id `trip:<id>`
 *   eligibility     visibility             → the ONE privacy decision the Map
 *                                            makes: a `private` trip is never
 *                                            a pin (the client's
 *                                            isMapVisibleTrip, server-side)
 *   location        destination_lat/lng    → the geometry. Without it there is
 *                                            no pin at all; see THE MISSING
 *                                            FIELD below.
 *   time window     start_date, end_date   → the subtitle's date range
 *   display state   stage (trips.status)   → cancellation/completion, shown in
 *                                            the payload
 *   label           title, destination_city,
 *                   destination_country    → title, subtitle, payload
 *   version         source_trip_version    → §19.1 freshness; the ordering
 *                                            contract the fold below enforces
 *
 * Participant/crew counts and plan counts ARE in 2520's body and are NOT in
 * this contract: no map object renders them, and a field a consumer does not
 * use is a field that rots. They stay available for a future surface.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MISSING FIELD: 2520's BODY IS COORDINATE-FREE, AND A PIN IS A COORDINATE
 * ═══════════════════════════════════════════════════════════════════════════
 * 2520 deliberately strips coordinates from `body` (§5.3, §14.4) and carries
 * only `has_destination_coordinates`. That is the right call for a broad
 * social projection and it makes the projection UNUSABLE as a map source on
 * its own: `projectTrip` returns null without lat/lng, so a straight switch
 * would have served an empty trip layer forever — the same silent-nothing this
 * whole exercise is about.
 *
 * The fix is NOT to read canonical `trips` for the coordinate behind the
 * projection's back (that would leave the projection decorative) and NOT to
 * edit the Trips-owned event contract. It is migration 2610, which adds a
 * MAP-OWNED anchor to the MAP-OWNED projection table — `destination_lat`,
 * `destination_lng` and `map_contract_version` as real columns, filled from
 * canonical state by a trigger on the same write 2520's drain already makes.
 * 2520's `body` stays byte-for-byte coordinate-free; the anchor is a separate,
 * service-role-only column set that no client role can select. It widens
 * nothing: the canonical path already hands `destinationLat/Lng` verbatim to
 * exactly these viewers through `toAuthorizedTripView`.
 *
 * Because the anchor is a COLUMN and not a jsonb key, the capability probe can
 * see it. That is the point — a probe cannot look inside `body`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A CAPABILITY AND NOT A FLAG
 * ═══════════════════════════════════════════════════════════════════════════
 * Production (measured 2026-09-07) has NO trips.version, NO trip_events, NO
 * trip_outbox and NO trip_map_projections; portava-ci has 2420 but NOT 2520,
 * so `trip_map_projections` does not exist there either. On both, the
 * projection is not merely empty — the table is absent. A bare feature flag
 * would answer "on" and the layer would read nothing, which on a Map is
 * indistinguishable from "you have no trips": 43 real production trips would
 * vanish from the map the moment an operator flipped a switch.
 *
 * So the gate is the existing capability contract,
 * `FLAG_ENABLED && SCHEMA_CAPABILITY_READY`, fail-closed — see
 * lib/capability/schemaRequirement.ts. `resolveCapability` probes for the
 * columns below and REFUSES on `missing` AND on `unknown`; the canonical path
 * stays as the not-ready branch and is what runs today, everywhere.
 */
import {
  SCHEMA_PROBE_SENTINEL_ID,
  type CapabilityDefinition,
} from "./capability/schemaRequirement.js";
import type { TripViewLike } from "./mapProjection.js";

/**
 * The flag. Seeded FALSE by 2610 — a flag no migration seeds is a wall, not a
 * gate (src/test/flagPhantomReads.test.ts).
 */
export const MAP_TRIP_PROJECTION_READ_FLAG = "map_trip_projection_read_enabled";

/**
 * 2520's own `projection_schema_version` (the shape of `body`). This reader
 * understands version 1 and REFUSES anything else rather than guessing at a
 * body it was not written for.
 */
export const EXPECTED_PROJECTION_SCHEMA_VERSION = 1;

/**
 * The Map-owned contract version, carried in `trip_map_projections
 * .map_contract_version`. 1 = a row written before 2610 (no anchor);
 * 2 = the anchor is present and current. The reader refuses a layer containing
 * any row below this, because a row without an anchor silently drops a pin and
 * a partly-drawn trip layer is indistinguishable from a smaller one.
 */
export const MAP_TRIP_CONTRACT_VERSION = 2;

/** Columns the reader selects. The capability probe names exactly these. */
export const MAP_TRIP_PROJECTION_COLUMNS = [
  "trip_id",
  "source_trip_version",
  "projection_schema_version",
  "map_contract_version",
  "generated_at",
  "destination_lat",
  "destination_lng",
  "body",
] as const;

/**
 * The capability. NOTE the `probe` override: `trip_map_projections` is keyed
 * by `trip_id`, not `id`, and the default probe filter would make PostgreSQL
 * answer 42703 — classified `unknown`, therefore REFUSED, which is safe but
 * wrong and would have hidden a working database behind a permanent refusal.
 *
 * NOT YET IN lib/capability/registry.ts (owned by another lane). The runtime
 * contract does not need the registry — `resolveCapability` takes the
 * definition — but the CI ratchet enumerates the registry, so until this is
 * added there `check:flag-schema-prerequisites` classifies the flag `latent`
 * (no production row) rather than `guarded`.
 */
export const MAP_TRIP_PROJECTION_CAPABILITY: CapabilityDefinition = {
  flag: MAP_TRIP_PROJECTION_READ_FLAG,
  providedBy: [
    "2420_trip_kernel_foundation.sql",
    "2520_trip_map_projection_worker.sql",
    "2610_map_trip_projection_anchor.sql",
  ],
  requires: {
    tables: {
      trip_map_projections: {
        columns: [...MAP_TRIP_PROJECTION_COLUMNS],
        probe: { column: "trip_id", value: SCHEMA_PROBE_SENTINEL_ID },
      },
    },
  },
  consumers: ["lib/mapProjectionTripRead.ts"],
  note:
    "The Map trip_stop layer would read an absent table and serve an empty trip layer, " +
    "which on a map is indistinguishable from 'you have no trips'; refusing keeps the " +
    "canonical `trips` path authoritative until 2420 -> 2520 -> 2610 are applied.",
};

// ── Row shape ────────────────────────────────────────────────────────────────

/** 2520's body, as far as MAP reads it. Everything else in it is ignored. */
export interface TripMapProjectionBody {
  stage?: string | null;
  visibility?: string | null;
  title?: string | null;
  destination_city?: string | null;
  destination_country?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  has_destination_coordinates?: boolean | null;
}

/** One `trip_map_projections` row, as selected by MAP_TRIP_PROJECTION_COLUMNS. */
export interface TripMapProjectionRow {
  trip_id?: string | null;
  /** bigint — PostgREST may hand it back as a string. */
  source_trip_version?: number | string | null;
  projection_schema_version?: number | string | null;
  map_contract_version?: number | string | null;
  generated_at?: string | null;
  destination_lat?: number | string | null;
  destination_lng?: number | string | null;
  body?: TripMapProjectionBody | null;
}

/** Why a fold discarded a row. Counted, never silent. */
export interface FoldCounts {
  /** Rows carrying a version already superseded — ignored, never applied backwards. */
  staleIgnored: number;
  /** Rows repeating a version already folded — a no-op by construction. */
  duplicatesIgnored: number;
  /** Rows with no trip_id or an unusable version — refused. */
  invalid: number;
}

export interface FoldResult {
  rows: Map<string, TripMapProjectionRow>;
  counts: FoldCounts;
  /** The highest source_trip_version folded, for observability. */
  maxSourceTripVersion: number | null;
  /**
   * The lowest map_contract_version seen among ACCEPTED rows, or null when
   * none were accepted. Below MAP_TRIP_CONTRACT_VERSION the layer is refused.
   */
  minMapContractVersion: number | null;
  /** The lowest projection_schema_version seen among ACCEPTED rows. */
  minProjectionSchemaVersion: number | null;
}

function toVersion(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function toCoord(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Fold a delivered row list into at most one row per trip, keeping the
 * HIGHEST `source_trip_version` — the §19.4 ordering contract, restated on the
 * read side where it is also load-bearing.
 *
 * WHY THE READER FOLDS AT ALL, given `trip_id` is the primary key.
 * Because the reader receives a LIST OVER A NETWORK, not a table. 2520's
 * drain and its rebuild can both write the same trip (the rebuild exists
 * precisely to regenerate a projection out of band), a retried PostgREST read
 * can repeat a page, and a future paged read would stitch pages together in
 * the reader. In every one of those the reader is the last place that can
 * refuse to apply a version backwards, and "the primary key makes it
 * impossible" is exactly the reasoning that leaves a system with no defence
 * when it turns out to be possible. The fold is:
 *
 *   higher version  → replaces
 *   equal version   → duplicate, NO-OP (the first row stands; a replay cannot
 *                     change what is served)
 *   lower version   → stale, IGNORED (never applied backwards)
 *
 * Order-independent by construction: the same rows in any order fold to the
 * same result. PURE.
 */
export function foldTripProjectionRows(rows: readonly TripMapProjectionRow[]): FoldResult {
  const out = new Map<string, TripMapProjectionRow>();
  const versions = new Map<string, number>();
  const counts: FoldCounts = { staleIgnored: 0, duplicatesIgnored: 0, invalid: 0 };
  let maxSourceTripVersion: number | null = null;

  for (const row of rows) {
    const id = typeof row?.trip_id === "string" && row.trip_id ? row.trip_id : null;
    const version = toVersion(row?.source_trip_version);
    if (!id || version === null) {
      counts.invalid += 1;
      continue;
    }
    const held = versions.get(id);
    if (held === undefined) {
      out.set(id, row);
      versions.set(id, version);
    } else if (version > held) {
      out.set(id, row);
      versions.set(id, version);
    } else if (version === held) {
      counts.duplicatesIgnored += 1;
      continue;
    } else {
      counts.staleIgnored += 1;
      continue;
    }
    if (maxSourceTripVersion === null || version > maxSourceTripVersion) {
      maxSourceTripVersion = version;
    }
  }

  let minMapContractVersion: number | null = null;
  let minProjectionSchemaVersion: number | null = null;
  for (const row of out.values()) {
    // An unreadable version is treated as 0 — the floor, so it refuses. An
    // absent contract version is a pre-2610 row, which is exactly what the
    // floor exists to catch.
    const mc = toVersion(row.map_contract_version) ?? 0;
    const ps = toVersion(row.projection_schema_version) ?? 0;
    if (minMapContractVersion === null || mc < minMapContractVersion) minMapContractVersion = mc;
    if (minProjectionSchemaVersion === null || ps < minProjectionSchemaVersion) {
      minProjectionSchemaVersion = ps;
    }
  }

  return { rows: out, counts, maxSourceTripVersion, minMapContractVersion, minProjectionSchemaVersion };
}

/**
 * One projection row → the exact `TripViewLike` shape `projectTrip` consumes.
 *
 * THE POINT OF RETURNING `TripViewLike` RATHER THAN A MapObject: both branches
 * then go through the SAME `projectTrip`, so the served object cannot drift
 * between the projection path and the canonical path. Byte-identity of the
 * layer output is structural, not a promise maintained by hand in two places.
 *
 * Null when the row carries no usable anchor — the projection said the trip
 * exists, but a trip with no coordinate is not a map object. `projectTrip`
 * would drop it anyway; doing it here lets the reader COUNT it.
 *
 * PURE.
 */
export function projectionRowToTripView(row: TripMapProjectionRow): TripViewLike | null {
  const id = typeof row?.trip_id === "string" && row.trip_id ? row.trip_id : null;
  if (!id) return null;
  const lat = toCoord(row.destination_lat);
  const lng = toCoord(row.destination_lng);
  if (lat === null || lng === null) return null;
  const body = (row.body ?? {}) as TripMapProjectionBody;

  return {
    id,
    title: body.title ?? null,
    // The one privacy decision on this layer. Carried through verbatim so
    // projectTrip's `visibility === "private"` drop fires identically on both
    // paths; a body without a visibility is NOT assumed public — see below.
    visibility: body.visibility ?? null,
    destinationCity: body.destination_city ?? null,
    destinationCountry: body.destination_country ?? null,
    destinationLat: lat,
    destinationLng: lng,
    startDate: body.start_date ?? null,
    endDate: body.end_date ?? null,
    status: body.stage ?? null,
  };
}

/**
 * The Map eligibility predicate, applied to a projection row BEFORE the view
 * is built, so a refusal can be counted rather than inferred from a shorter
 * list. It must never be more permissive than `projectTrip`.
 *
 * A row whose body carries NO `visibility` at all is NOT eligible. `projectTrip`
 * would let it through (it only drops the literal `"private"`), but on the
 * canonical path the column is NOT NULL and always present, so an absent
 * visibility can only mean a body this reader does not understand — and
 * guessing "public" for a trip whose privacy setting is unreadable is precisely
 * the widening the projection is forbidden to do. PURE.
 */
export function isProjectionRowMapEligible(row: TripMapProjectionRow): boolean {
  const body = (row?.body ?? {}) as TripMapProjectionBody;
  if (typeof body.visibility !== "string" || body.visibility === "") return false;
  if (body.visibility === "private") return false;
  return toCoord(row?.destination_lat) !== null && toCoord(row?.destination_lng) !== null;
}
