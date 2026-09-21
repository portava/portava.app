/**
 * mapDiscoveryCandidates — the Map's half of Map §20 "Candidate relevance".
 *
 * WHAT THIS CLOSES
 * ================
 * Map §20 (`docs/specs/…Map…:202-203`) says Discovery OWNS candidate relevance
 * and EXPOSES it to the Map as a projection; the Map consumes projections from
 * each owner rather than re-deriving place data of its own. Discovery built its
 * half — `lib/discoveryCandidate.readDiscoveryCandidatesForViewer`, the
 * privacy-complete, write-free, does-not-retrieve reader — and it had no
 * caller anywhere but its own test. census-discovery graded A25 W ("a reader
 * nobody reads") and filed the missing call site as decision D10, *Map gateway
 * consumes `readDiscoveryCandidatesForViewer`*, against the Map lane.
 *
 * This module is the Map side of that call. The CALL ITSELF stays in
 * routes/mapProjection.ts — D10 names the gateway, and a reader consumed only
 * through a helper would leave the gateway's own file still not naming it.
 * What lives here is everything around the call that is pure and therefore
 * testable without a route: which served objects may be asked about, how a Map
 * object becomes a row the Discovery reader understands, how the answer is
 * folded back, and — the part that matters most — what the response says when
 * the answer does not arrive.
 *
 * WHY IT RUNS LAST, OVER THE PAGE
 * ===============================
 * Every other layer in the gateway PRODUCES objects and then sends them through
 * servable → enrich → §24 protection → aggregation → §31 ranking → display →
 * paging. A candidate projection produces nothing: it is an ANNOTATION on place
 * objects that have already been through all of that. So it is applied to the
 * page, after every gate, and it can neither resurrect an object a gate removed
 * nor add one the viewer would not otherwise see.
 *
 * It also carries no geometry, no cohort and no count, so it adds nothing §24
 * could have withheld — with one exception, which is why `ELIGIBLE_PRIVACY_CLASS`
 * exists:
 *
 *   A place that stood inside a §24 coarsen-class zone leaves the server at
 *   `approximate` with its live axes, confidence, freshness, provenance and
 *   timestamps deleted (lib/protectedLocations coarsenForZone). Hanging a
 *   projection carrying `truthClass` + `confidence` + `freshness` off such an
 *   object would restate, one level down inside `payload`, the very fields the
 *   gate just deleted at the top level — which is precisely the defect
 *   COARSENED_PAYLOAD_KEYS was added to stop. So a coarsened place is NOT
 *   eligible: eligibility is `kind === "place"` AND the object still standing
 *   at `PLACE_PRIVACY_CLASS`, and the shortfall is REPORTED rather than
 *   silent.
 *
 * FAIL CLOSED, AND SAY SO
 * =======================
 * `11` §9, via lib/discoveryRefusal: *"A failure must not masquerade as
 * success."* A candidate set that is short — because the flag is off, because
 * the reader threw, or because fewer rows came back than went in — must not be
 * indistinguishable from a viewport where every place was genuinely projected.
 *
 * TWO VOCABULARIES MEET HERE AND NEITHER IS INVENTED:
 *   `refusal: string | null` + counts is routes/mapProjection.ts's OWN layer
 *   report shape (CrowdFlowReport, ProducerLayerReport, TripLayerReport,
 *   WorldIntelligenceReport), and the codes reused from it are spelled exactly
 *   as its siblings spell them — `flag_off` (crowdFlow) and `read_threw` (the
 *   four M5 producers).
 *   `coverage: "nothing" | "partial"` is lib/discoveryRefusal's field, with
 *   lib/discoveryRefusal's meaning: "nothing" ⇒ the empty candidate set in this
 *   body is a consequence of the refusal and is not a result; "partial" ⇒ the
 *   candidates present are real and the absences are not evidence of absence.
 *
 * No third vocabulary is coined. `coverage` is non-null exactly when `refusal`
 * is — with no refusal there is no collection whose completeness is in doubt.
 *
 * HTTP STAYS 200. The gateway already answers a read failure with a named
 * refusal inside its 200 envelope rather than a status change
 * (routes/mapProjection.ts's `block_set_unreadable` / `protection_unreadable`),
 * for the measured reason recorded there: the client treats an `enabled: true`
 * answer as owning every layer. This layer is additive and cannot blank a map,
 * so it does not touch `enabled` either.
 */
import type { MapObject } from "./mapObjects.js";
import { centroidOf } from "./mapObjects.js";
import { PLACE_PRIVACY_CLASS } from "./mapProjectPlace.js";
import type {
  CandidateReadOutcome,
  CandidateSourceRow,
  DiscoveryCandidate,
  DiscoveryRankedBy,
} from "./discoveryCandidate.js";
import type { PdePlace } from "./discoveryPde.js";

/**
 * The rung a canonical place leaves lib/mapProjectPlace at. An object that is
 * no longer standing at it has been narrowed by §24, and is not eligible — see
 * the header.
 */
export const ELIGIBLE_PRIVACY_CLASS = PLACE_PRIVACY_CLASS;

/**
 * A served place as the Discovery reader wants it: `CandidateSourceRow` for the
 * truth-class rules and `PdePlace` for the ranker's features.
 *
 * `id` is the DISCOVERY SERVED ID (`db/<places.id>`), not the Map object id and
 * not the bare uuid. That is the id space the reader, portavaRank and
 * rank_events all key on (lib/mapProjectPlace's ID BRIDGE note), so handing it
 * anything else would silently match nothing — the failure mode where every
 * ranking feature reads zero and the projection still looks like it worked.
 */
export interface MapDiscoveryPlaceRow extends CandidateSourceRow, PdePlace {
  id: string;
}

/** What `selectDiscoveryCandidateRows` found on a page. */
export interface DiscoveryCandidateSelection {
  /** Reader input, in page order. */
  rows: MapDiscoveryPlaceRow[];
  /** Discovery served id → Map object id, for folding the answer back. */
  objectIdByDiscoveryId: Map<string, string>;
  /** Place objects on this page, eligible or not. */
  servedPlaces: number;
  /**
   * Lowercased city, or null. Only set when EVERY eligible row agrees: a
   * viewport can straddle two cities, and naming one of them would hand the
   * ranker a destination half its candidates are not in.
   */
  city: string | null;
}

/**
 * Why no candidate projection is attached. `flag_off` and `read_threw` are
 * spelled as routes/mapProjection.ts's existing layer reports spell them.
 */
export type DiscoveryCandidateRefusal = "flag_off" | "read_threw" | "incomplete_projection";

/**
 * What the layer did, in counts and refusals — the same discipline every other
 * report in the gateway keeps, so an absent `candidate` is never ambiguous
 * between "the gate said no", "we could not look" and "nothing asked".
 */
export interface DiscoveryCandidateReport {
  refusal: DiscoveryCandidateRefusal | null;
  /** lib/discoveryRefusal's field, its meaning. Non-null iff `refusal` is. */
  coverage: "nothing" | "partial" | null;
  /** Place objects on this page. */
  servedPlaces: number;
  /** Of those, the ones this layer was allowed to ask about (see the header). */
  eligible: number;
  /** Of those, the ones that came back with a projection. */
  projected: number;
  /** The reader's own answer to "who ranked", verbatim. */
  rankedBy: DiscoveryRankedBy;
  /**
   * Writes the ranker attempted and the reader's no-write client intercepted.
   * Reported because it is the only externally visible proof that the Map read
   * ran with `served: false` — a Map read must never leave a rank_events
   * impression for a Discovery page the user did not see.
   */
  suppressedWrites: number;
}

/** A finite coordinate or null — geometry is already validated upstream. */
function coordOf(obj: MapObject): { lat: number | null; lng: number | null } {
  const c = centroidOf(obj.geometry);
  return c ? { lat: c.lat, lng: c.lng } : { lat: null, lng: null };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * The served place objects this layer may ask Discovery about, as reader rows.
 *
 * Pure. Takes the PAGE (post-§24, post-aggregation, post-ranking) and keeps
 * only objects that are still `kind: "place"` at `ELIGIBLE_PRIVACY_CLASS` and
 * still carry the Discovery served id lib/mapProjectPlace put in their payload.
 * Everything else — an aggregated `activity_zone` cell, a coarsened place, a
 * gem, an event — is left alone and counted, never silently dropped.
 */
export function selectDiscoveryCandidateRows(objects: MapObject[]): DiscoveryCandidateSelection {
  const rows: MapDiscoveryPlaceRow[] = [];
  const objectIdByDiscoveryId = new Map<string, string>();
  const cities = new Set<string>();
  let servedPlaces = 0;
  let cityMissing = false;

  for (const obj of objects) {
    if (!obj || obj.kind !== "place") continue;
    servedPlaces += 1;
    if (obj.privacyClass !== ELIGIBLE_PRIVACY_CLASS) continue;
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    const discoveryId = stringOrNull(payload.discoveryId);
    if (!discoveryId) continue;
    // One object per served id. A duplicate would make the fold ambiguous and
    // the count dishonest, so the first wins and the second is not eligible.
    if (objectIdByDiscoveryId.has(discoveryId)) continue;
    objectIdByDiscoveryId.set(discoveryId, obj.id);

    const { lat, lng } = coordOf(obj);
    const city = stringOrNull(payload.city);
    if (city) cities.add(city.toLowerCase());
    else cityMissing = true;

    rows.push({
      id: discoveryId,
      canonicalPlaceId: stringOrNull(payload.canonicalPlaceId),
      category: stringOrNull(payload.category),
      distanceKm: obj.distanceKm ?? null,
      lat,
      lng,
      // savedCount / tags / rating / headerImageUrl / description are NOT on a
      // projected place object. They are left undefined rather than defaulted:
      // portavaRank contributes 0 for an absent feature, and a zero is "not
      // computed", which is the truth here. A fabricated default would be a
      // ranking input nobody measured.
    });
  }

  return {
    rows,
    objectIdByDiscoveryId,
    servedPlaces,
    city: cities.size === 1 && !cityMissing ? [...cities][0] : null,
  };
}

/** The report for a layer that never got to look. */
export function refusedDiscoveryCandidates(
  refusal: DiscoveryCandidateRefusal,
  selection: DiscoveryCandidateSelection,
): DiscoveryCandidateReport {
  return {
    refusal,
    coverage: "nothing",
    servedPlaces: selection.servedPlaces,
    eligible: selection.rows.length,
    projected: 0,
    rankedBy: "none",
    suppressedWrites: 0,
  };
}

/**
 * Fold a reader outcome back onto the page.
 *
 * `outcome === null` means the read FAILED (the caller's try/catch fired). The
 * page is returned UNTOUCHED — the same array reference, not a copy — and the
 * report says `read_threw` / `"nothing"`. Attaching a half-built projection, or
 * an empty one, would be the masquerade: a body in which no place carries a
 * candidate is otherwise byte-identical to one where the reader ran and had
 * nothing to add.
 *
 * With an outcome, every row that came back is attached to its object as an
 * additive `payload.candidate` — the SAME key Discovery hangs its projection on
 * in lib/discoveryCandidate.withDiscoveryCandidates, so one consumer answers
 * one question of both surfaces. Objects are COPIED, never mutated: the page
 * shares references with `collected`, and a projection is a property of THIS
 * response, never of the object.
 *
 * Fewer rows back than went in ⇒ `incomplete_projection`, with `coverage`
 * saying whether anything at all is a result.
 */
export function foldDiscoveryCandidates(
  objects: MapObject[],
  selection: DiscoveryCandidateSelection,
  outcome: CandidateReadOutcome<MapDiscoveryPlaceRow> | null,
): { objects: MapObject[]; report: DiscoveryCandidateReport } {
  if (outcome === null) {
    return { objects, report: refusedDiscoveryCandidates("read_threw", selection) };
  }

  const byObjectId = new Map<string, DiscoveryCandidate>();
  for (const { place, candidate } of outcome.candidates) {
    const objectId = selection.objectIdByDiscoveryId.get(place.id);
    // A projection for a row we did not send is not folded in. It cannot be
    // placed on an object, and counting it would inflate `projected` past
    // `eligible` and hide a shortfall behind a stranger.
    if (objectId) byObjectId.set(objectId, candidate);
  }

  const projected = byObjectId.size;
  const eligible = selection.rows.length;
  const short = projected < eligible;

  const next = byObjectId.size === 0
    ? objects
    : objects.map((obj) => {
        const candidate = byObjectId.get(obj.id);
        if (!candidate) return obj;
        return {
          ...obj,
          payload: { ...((obj.payload ?? {}) as Record<string, unknown>), candidate },
        } as MapObject;
      });

  return {
    objects: next,
    report: {
      refusal: short ? "incomplete_projection" : null,
      coverage: short ? (projected === 0 ? "nothing" : "partial") : null,
      servedPlaces: selection.servedPlaces,
      eligible,
      projected,
      rankedBy: outcome.rankedBy,
      suppressedWrites: outcome.suppressedWrites,
    },
  };
}
