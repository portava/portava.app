/**
 * Discovery's consumer of the Trip-owned TripDiscoveryProjection
 * (lib/tripDiscoveryProjection.ts) — the switch, the acceptance check and the
 * card mapping, and nothing that reads `trips`.
 *
 * Spec: docs/specs/Portava_Trips_Development_Architecture_Spec_v4.txt
 *   §19.1 "Consumers reject or visibly degrade on stale/incompatible critical
 *         projections."                                    (acceptProjections)
 *   §25   "Map, Compass, Discovery ... consume explicit Trip projections /
 *         contracts rather than duplicating Trip semantics."
 * docs/architecture/census-discovery.md A10 / D3.
 *
 * WHY A CAPABILITY, AND WHY IT SEEDS OFF
 * =======================================
 * TRIP_DISCOVERY_SOURCE_COLUMNS ends with `version` (migration 2420).
 * Production (ajrurzioarfkagpuxfnb), measured 2026-09-07: trips.version does
 * NOT exist (2420 unapplied), 43 trips, 12 discoverable. Both projection
 * readers fail CLOSED on a resolved `.error`, so an ungated switch would turn
 * every production trip search into `[]` the moment it deployed — a 42703 on
 * a missing column, silent to the user.
 *
 * A BARE FLAG IS NOT ENOUGH, AND THIS MODULE USED TO BE ONE. A flag row is a
 * statement of intent; it is not evidence that the schema behind it exists
 * (lib/capability/schemaRequirement.ts — `media_canonical_enabled` was TRUE in
 * production for three weeks over columns that were not there). With a bare
 * flag, ONE `update feature_flags set enabled = true` on a database without
 * 2420 turns every trips and plans search into `[]`. Nothing in the flag row
 * can know that. So the gate is the capability contract:
 *
 *     capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY
 *
 * `discovery_trip_projection_enabled` (migration 2550, seeded FALSE) is the
 * flag half; DISCOVERY_TRIP_PROJECTION below is the schema half, declaring
 * exactly the `trips` columns the projection reader selects. The composition
 * is the MEDIA precedent — `isFlagEnabled` for the flag, `probeSchemaReadiness`
 * for the schema, behind a per-feature wrapper (lib/media/mediaSchemaCapability.ts
 * is the model, and lib/capability/registry.ts names that shape explicitly).
 * No second mechanism is invented here.
 *
 * BOTH HALVES FAIL TOWARD LEGACY
 * ==============================
 * isFlagEnabled returns false on an absent row, a resolved `.error`, and a
 * thrown client. probeSchemaReadiness returns `missing` when a required column
 * is absent and `unknown` for every other failure, and only `ready` opens the
 * gate. Each of those means "legacy path" — the pre-2420 `trips` read in
 * routes/discoverySearch.ts, which works on every database. Refusing here is
 * therefore NOT a degraded empty answer: it is the answer Discovery has always
 * given. That is why this consumer uses probeSchemaReadiness rather than
 * requireCapability (which throws 503): there is a correct legacy answer to
 * fall back to, and a 503 would be worse than the truth.
 *
 * The verdict is cached for 30 s PER CLIENT OBJECT (identity-checked, so a
 * test client cannot serve a verdict to the next test's client) for the same
 * reason the buddy launch gate in routes/discoverySearch.ts is: type=all fans
 * out through trips AND plans on every search.
 *
 * WHICH BRANCH RAN IS OBSERVABLE
 * ==============================
 * `recordDiscoveryTripSource` keeps a bounded ring of the last decisions —
 * surface, source, and the reason a refusal refused. A gate whose branch you
 * cannot see is a gate you cannot audit, and this one has a failure mode
 * (flag ON, schema absent) whose whole point is that it is silent.
 *
 * WHAT CHANGES FOR A USER WHEN THE FLAG IS ON (stated, not buried)
 * ================================================================
 * The projection is built on toPrivateTripPreview, so the owner's
 * show_exact_dates / show_destination_city / show_header_publicly toggles
 * apply to a Discovery searcher. Today Discovery ignores them and shows the
 * true start_date, city and cover of every discoverable trip. Production
 * 2026-09-07: 12 discoverable trips, 0 with any toggle off — unobservable
 * today, real the moment an owner sets one. The Trips lane chose this
 * deliberately (one non-member rule, one place) and it is the more private
 * direction; this consumer does not bypass it.
 *
 * WHAT STAYS IN DISCOVERY
 * =======================
 * The blocked-set, age-restricted-set and active-owner filters. They are
 * Trust / Discovery rules about `ownerId`, not Trip semantics; the projection
 * carries ownerId for exactly that purpose and never decides them.
 */
import { isFlagEnabled } from "./featureFlags.js";
import { probeSchemaReadiness } from "./capability/schemaCapability.js";
import type {
  CapabilityDefinition,
  SchemaReadiness,
} from "./capability/schemaRequirement.js";
import { logger } from "./logger.js";
import {
  TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION,
  TRIP_DISCOVERY_SOURCE_COLUMNS,
  type TripDiscoveryProjection,
} from "./tripDiscoveryProjection.js";

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ CAPABILITY, read fail-closed. */
export const DISCOVERY_TRIP_PROJECTION_FLAG = "discovery_trip_projection_enabled";

/**
 * The one projection schema version this consumer can read. A bump on the
 * Trips side is a compile error here (the literal types diverge) and a runtime
 * rejection in acceptTripDiscoveryProjections — §19.1 makes rejecting the
 * consumer's duty, and the readers deliberately do not do it for us.
 */
export const DISCOVERY_TRIP_PROJECTION_ACCEPTED_SCHEMA_VERSION: typeof TRIP_DISCOVERY_PROJECTION_SCHEMA_VERSION = 1;

/**
 * The `trips` columns the guarded path names, derived from the Trips-owned
 * select list itself so the declaration cannot drift from the read. Every one
 * but `version` is baseline schema; `version` is migration 2420 and is the one
 * production lacks (measured 2026-09-07). Declaring the whole list rather than
 * just `version` is registry rule 4 — "the requirement is what the guarded
 * code ACTUALLY names" — and costs the same single probe round trip.
 */
export const DISCOVERY_TRIP_PROJECTION_COLUMNS: readonly string[] =
  TRIP_DISCOVERY_SOURCE_COLUMNS.split(",").map((c) => c.trim()).filter((c) => c.length > 0);

/**
 * The schema half of `capability = FLAG_ENABLED && SCHEMA_CAPABILITY_READY`.
 *
 * NOT YET AN ENTRY IN lib/capability/registry.ts — that file is owned by
 * another lane and this one may not edit it. The definition lives here, is
 * consumed here, and the registry entry is a reported handover (see the lane
 * report): copy this constant into CAPABILITIES with
 * `consumers: ["routes/discoverySearch.ts"]`. Until then the CI ratchet
 * (scripts/checkFlagSchemaPrerequisites.ts) has nothing to say about this flag
 * anyway: it reports flags that are ON IN PRODUCTION over absent schema, and
 * `discovery_trip_projection_enabled` has no production row at all (2550 is
 * unapplied there, measured 2026-09-07).
 */
export const DISCOVERY_TRIP_PROJECTION: CapabilityDefinition = {
  flag: DISCOVERY_TRIP_PROJECTION_FLAG,
  providedBy: [
    "2420_trip_kernel_foundation.sql (adds trips.version; requires 2334 -> 2337)",
    "2550_discovery_trip_projection_consumer_flag.sql (seeds the flag FALSE)",
  ],
  requires: {
    tables: {
      trips: { columns: DISCOVERY_TRIP_PROJECTION_COLUMNS },
    },
  },
  consumers: ["routes/discoverySearch.ts"],
  note:
    "With the flag ON over a database without trips.version, both projection readers 42703 and every trips " +
    "and plans search answers []. Refusing keeps the pre-2420 legacy read authoritative, which is a correct " +
    "answer on every database rather than a degraded one.",
};

/** Which source answered a Discovery trip read. */
export type DiscoveryTripSource = "projection" | "legacy";

/** Why the gate landed where it did. `ready` is the only value that opens it. */
export type DiscoveryTripGateReason = "flag_off" | "schema_missing" | "schema_unknown" | "ready";

export interface DiscoveryTripGate {
  source: DiscoveryTripSource;
  reason: DiscoveryTripGateReason;
  /** null when the flag was not on — a dark flag makes no schema contact. */
  schema: SchemaReadiness | null;
}

const FLAG_TTL_MS = 30_000;
/**
 * Identity-checked single-entry cache. Keyed on the client OBJECT: a verdict
 * reached for one client is never served to another (the previous module-global
 * boolean could bleed one test's database into the next test's).
 */
let _gateCache: { sc: object; gate: DiscoveryTripGate; at: number } | null = null;

/** Drop the cached verdict. Exported for tests; also clears the decision ring. */
export function invalidateDiscoveryTripProjectionFlagCache(): void {
  _gateCache = null;
  _decisions.length = 0;
}

/**
 * THE GATE: `FLAG_ENABLED && SCHEMA_CAPABILITY_READY`, fail-closed toward
 * legacy in both halves.
 *
 * The schema is probed ONLY when the flag is on — a dark flag makes no
 * database contact beyond the flag read, exactly as resolveCapability does it.
 * `unknown` (probe threw, transport failed, a fake without the method) refuses
 * for the same reason `missing` does: a guard that opens because it could not
 * check is not a guard.
 */
export async function discoveryTripProjectionGate(sc: any): Promise<DiscoveryTripGate> {
  if (_gateCache && _gateCache.sc === sc && Date.now() - _gateCache.at < FLAG_TTL_MS) return _gateCache.gate;

  let gate: DiscoveryTripGate;
  if (!(await isFlagEnabled(sc, DISCOVERY_TRIP_PROJECTION_FLAG))) {
    gate = { source: "legacy", reason: "flag_off", schema: null };
  } else {
    const schema = await probeSchemaReadiness(sc, DISCOVERY_TRIP_PROJECTION);
    if (schema.state === "ready") {
      gate = { source: "projection", reason: "ready", schema };
    } else {
      gate = {
        source: "legacy",
        reason: schema.state === "missing" ? "schema_missing" : "schema_unknown",
        schema,
      };
      logger.error(
        {
          capability: DISCOVERY_TRIP_PROJECTION_FLAG,
          schemaState: schema.state,
          missing: schema.missing,
          errorCode: schema.errorCode,
          providedBy: DISCOVERY_TRIP_PROJECTION.providedBy,
        },
        `capability ${DISCOVERY_TRIP_PROJECTION_FLAG} is ON but its schema is ` +
          `${schema.state === "missing" ? "ABSENT" : "UNVERIFIABLE"} — Discovery stays on the LEGACY trips read. ` +
          `${DISCOVERY_TRIP_PROJECTION.note} Apply ${DISCOVERY_TRIP_PROJECTION.providedBy.join(", ")} or turn the flag off.`,
      );
    }
  }
  _gateCache = { sc, gate, at: Date.now() };
  return gate;
}

/**
 * Is Discovery to consume the projection? false on an absent flag row, an
 * unreadable table, a thrown client, AND on a database whose `trips` lacks a
 * column the projection reader selects — legacy in every one of them.
 */
export async function discoveryTripProjectionEnabled(sc: any): Promise<boolean> {
  return (await discoveryTripProjectionGate(sc)).source === "projection";
}

// ── Which branch ran: observable, bounded ────────────────────────────────────

export interface DiscoveryTripSourceDecision {
  surface: "trips" | "plans";
  source: DiscoveryTripSource;
  reason: DiscoveryTripGateReason;
  /** Objects the probe established as absent; empty unless reason is schema_missing. */
  missing: readonly string[];
}

/** Bounded so a long-running process cannot grow it without limit. */
export const DISCOVERY_TRIP_SOURCE_RING = 64;
const _decisions: DiscoveryTripSourceDecision[] = [];

/** Record which source answered one Discovery surface. Called by both branches. */
export function recordDiscoveryTripSource(surface: "trips" | "plans", gate: DiscoveryTripGate): DiscoveryTripSourceDecision {
  const d: DiscoveryTripSourceDecision = {
    surface,
    source: gate.source,
    reason: gate.reason,
    missing: gate.schema?.missing ?? [],
  };
  _decisions.push(d);
  if (_decisions.length > DISCOVERY_TRIP_SOURCE_RING) _decisions.shift();
  return d;
}

/** The decisions since the last invalidate, oldest first. */
export function readDiscoveryTripSourceDecisions(): readonly DiscoveryTripSourceDecision[] {
  return [..._decisions];
}

/**
 * §19.1: keep only projections of a schema version this consumer can read.
 * A rejected projection is dropped (degrade), never rendered from a shape we
 * do not understand. Returns the count rejected so a caller can log it.
 */
export function acceptTripDiscoveryProjections(
  projections: readonly TripDiscoveryProjection[],
): { accepted: TripDiscoveryProjection[]; rejected: number } {
  const accepted: TripDiscoveryProjection[] = [];
  let rejected = 0;
  for (const p of projections) {
    if (p.projectionSchemaVersion === DISCOVERY_TRIP_PROJECTION_ACCEPTED_SCHEMA_VERSION) accepted.push(p);
    else rejected += 1;
  }
  return { accepted, rejected };
}

/**
 * The fields a trip search card is built from, in one shape for BOTH paths so
 * the mapping to SearchResult is one function and the two paths cannot drift
 * in the card. The legacy row (routes/discoverySearch.ts searchTrips) fills
 * this from its own select; the projection fills it below.
 */
export interface DiscoveryTripCardSource {
  id: string;
  ownerId: string;
  title: string | null;
  destinationCity: string | null;
  destinationCountry: string | null;
  coverUrl: string | null;
  startDate: string | null;
  status: string;
  createdAt: string | null;
}

/** Projection → card source. `title ?? destinationCity` is the legacy card's own fallback. */
export function tripCardSourceFromProjection(p: TripDiscoveryProjection): DiscoveryTripCardSource {
  return {
    id: p.tripId,
    ownerId: p.ownerId,
    title: p.title ?? null,
    destinationCity: p.destinationCity,
    destinationCountry: p.destinationCountry,
    coverUrl: p.coverUrl,
    startDate: p.startDate,
    status: p.status,
    createdAt: p.createdAt ?? null,
  };
}

/**
 * What searchPlans needs of a parent trip, in one shape for both paths:
 * whether this viewer may see its plans (Trip semantics — tripDiscoveryAdmits
 * on the projection path, the legacy predicate on the other), the owner for
 * Discovery's own filters, and the start date for the time-intent bound.
 */
export interface DiscoveryPlanParentTrip {
  id: string;
  ownerId: string;
  startDate: string | null;
  admitted: boolean;
}
