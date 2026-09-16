/**
 * MediaExperienceResolver (§23/§41) — resolves an experience (a canonical Event
 * or a Trip) into a coarse MediaExperienceProjection.
 *
 * VIEWER ELIGIBILITY FIRST. An experience the viewer may not see resolves to
 * null and the route answers with a well-formed "not available" projection —
 * private events and private trips are excluded, blocks are honored. Event
 * eligibility reuses routes/events.checkEventEligibility (the same age / trust /
 * verified / block / ban gate the event routes use); it is NEVER re-implemented.
 *
 * The hero media is drawn through the SHARED eligibility gate + coarse projector,
 * so an experience projection carries NO precise coordinate and NO fabricated
 * live label (current state, if any, comes only from the gated live-claim read).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkEventEligibility } from "../../routes/events.js";
import {
  type MediaCandidateRow,
  type MediaProjection,
} from "../../lib/media/mediaProjection.js";
import {
  loadEligibleCandidatesOrRefuse,
  isMediaCandidatesUnavailable,
  projectCandidatesProtected,
  readCurrentState,
  type CurrentState,
  type ViewerResolved,
} from "./MediaProjectionService.js";
import { rankMediaCandidates } from "./MediaRankingService.js";
import { aggregateFreshness, type FreshnessState } from "../../lib/media/mediaFreshness.js";

/**
 * §23.1 EXPERIENCE CHAINS — "Dinner → Rooftop → Nightclub".
 *
 * A chain is an ORDERED multi-place experience, and the only honest evidence
 * Media holds for an order is WHEN each place was photographed. So a stop's
 * position is the FIRST observed perspective at that place inside the
 * experience, `derivedFrom` says exactly that on the object, and nothing here
 * infers a route, a traveller's path or an intention.
 *
 * WHAT IS NOT A STOP: a place with no perspective (an itinerary entry is not an
 * observation), and a place whose id the lib/mediaLocationVisibility choke point
 * withheld — the chain is built from the PROJECTED media, so a coarsened item
 * contributes no stop rather than a named one. One place is not a chain
 * (`isChain` false), and an empty experience gets an empty chain rather than a
 * fabricated one.
 */
export interface ExperienceChainStop {
  /** Canonical places.id — opaque, never a coordinate. */
  placeId: string;
  /** Coarse label, post-disclosure. */
  label: string | null;
  /** ISO — the first observed perspective at this stop. This is the ORDER KEY. */
  firstPerspectiveAt: string;
  /** ISO — the last observed perspective at this stop. */
  lastPerspectiveAt: string;
  perspectiveCount: number;
}

export interface ExperienceChain {
  /** Ordered ascending by `firstPerspectiveAt`. */
  stops: ExperienceChainStop[];
  /** True only with two or more distinct disclosable places. */
  isChain: boolean;
  /** How the order was obtained. A constant, so the claim travels with the data. */
  derivedFrom: "observed_capture_times";
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * Derive the §23.1 chain from already-projected, already-eligible media. PURE —
 * no DB, no clock. Newest-first or oldest-first input makes no difference: the
 * order comes from the capture times, not from the page order.
 */
export function buildExperienceChain(media: readonly MediaProjection[]): ExperienceChain {
  const byPlace = new Map<string, { label: string | null; times: number[] }>();
  for (const m of media) {
    if (!m.placeId) continue; // withheld by the disclosure choke point ⇒ not a stop
    const t = new Date(m.capturedAt).getTime();
    if (!Number.isFinite(t)) continue;
    const entry = byPlace.get(m.placeId) ?? { label: null, times: [] };
    if (entry.label === null && m.placeLabel) entry.label = m.placeLabel;
    entry.times.push(t);
    byPlace.set(m.placeId, entry);
  }

  const stops: ExperienceChainStop[] = [];
  for (const [placeId, entry] of byPlace.entries()) {
    const sorted = [...entry.times].sort((a, b) => a - b);
    stops.push({
      placeId,
      label: entry.label,
      firstPerspectiveAt: new Date(sorted[0]).toISOString(),
      lastPerspectiveAt: new Date(sorted[sorted.length - 1]).toISOString(),
      perspectiveCount: sorted.length,
    });
  }
  stops.sort((a, b) => Date.parse(a.firstPerspectiveAt) - Date.parse(b.firstPerspectiveAt));

  return {
    stops,
    isChain: stops.length >= 2,
    derivedFrom: "observed_capture_times",
    startedAt: stops.length > 0 ? stops[0].firstPerspectiveAt : null,
    endedAt: stops.length > 0 ? stops[stops.length - 1].lastPerspectiveAt : null,
  };
}

export interface MediaExperienceProjection {
  id: string;
  kind: "event" | "trip";
  title: string | null;
  placeIds: string[];
  eventId?: string;
  tripId?: string;
  startedAt: string | null;
  expectedEndAt: string | null;
  currentState: CurrentState;
  perspectiveCount: number;
  contributorCount: number;
  freshness: FreshnessState;
  /** §23.1 — the ordered multi-place chain, or an empty one. Never fabricated. */
  chain: ExperienceChain;
  confidence: ExperienceConfidence; heroMedia: MediaProjection[]; // §23 confidence: see buildExperienceConfidence, end of file
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Roles that count as trip membership (mirrors mediaEligibility.ACCEPTED_TRIP_ROLES). */
const TRIP_MEMBER_ROLES = ["owner", "co_host", "member", "viewer"];

/**
 * Resolve an experience id into a projection, or null when the viewer may not
 * see it (private / blocked / ineligible) or it does not exist. Never throws.
 */
/**
 * A catch handler that lets THIS lane's refusal through and swallows the rest.
 * Written once so the two branches below cannot drift apart.
 */
function rethrowUnavailable(err: unknown): null {
  if (isMediaCandidatesUnavailable(err)) throw err;
  return null;
}

export async function resolveExperience(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  experienceId: string,
  nowMs: number,
): Promise<MediaExperienceProjection | null> {
  if (!UUID_RE.test(experienceId)) return null;

  // Try Event first, then Trip. Both are uuids; an id that is neither → null.
  //
  // `null` MEANS "NOT AVAILABLE TO YOU", AND THE ROUTE SAYS SO. Both branches
  // used to be `.catch(() => null)`, which folded a REFUSED read into that
  // answer: `GET /media/experiences/:id` then served a 200 carrying
  // `available: false` — a confident statement that looks like an authorization
  // outcome — on the strength of a query that never answered. A caller cannot
  // tell that from a genuine private trip, and would not retry.
  //
  // So the lane's refusal is re-thrown and becomes a retryable 503 through the
  // global error handler. Everything else is still swallowed: an unexpected
  // error here is not evidence the viewer may see the experience, and widening
  // that is a separate change with its own tests.
  const asEvent = await resolveEvent(sc, viewer, experienceId, nowMs).catch(rethrowUnavailable);
  if (asEvent) return asEvent;
  const asTrip = await resolveTrip(sc, viewer, experienceId, nowMs).catch(rethrowUnavailable);
  return asTrip;
}

async function resolveEvent(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  eventId: string,
  nowMs: number,
): Promise<MediaExperienceProjection | null> {
  let ev: any = null;
  try {
    const { data } = await (sc as any).from("events").select("*").eq("id", eventId).maybeSingle();
    ev = data ?? null;
  } catch {
    return null;
  }
  if (!ev) return null;

  // Visibility: only surface public events, unless the viewer is the host or an
  // accepted participant. This is a conservative subset of canViewEvent that
  // never widens access — fail-closed for anything non-public.
  const visibility = (ev.visibility as string | null) ?? "public";
  let mayView = visibility === "public" || ev.host_id === viewer.viewerId;
  if (!mayView) {
    try {
      const [{ data: rsvp }, { data: role }] = await Promise.all([
        (sc as any)
          .from("event_rsvps")
          .select("status")
          .eq("event_id", eventId)
          .eq("user_id", viewer.viewerId)
          .in("status", ["going", "maybe"])
          .maybeSingle(),
        (sc as any)
          .from("event_roles")
          .select("role")
          .eq("event_id", eventId)
          .eq("user_id", viewer.viewerId)
          .in("role", ["co_host", "moderator"])
          .maybeSingle(),
      ]);
      mayView = Boolean(rsvp) || Boolean(role);
    } catch {
      mayView = false;
    }
  }
  if (!mayView) return null;

  // Age / trust / verified / block / ban gate (shared with the event routes).
  const elig = await checkEventEligibility(sc, ev, viewer.viewerId).catch(() => ({ ok: false }) as any);
  if (!elig.ok) return null;

  // Hero media: posts explicitly linked to the event (post_event_links), run
  // through the shared eligibility gate + coarse projector.
  let linkedPostIds: string[] = [];
  try {
    const { data } = await (sc as any)
      .from("post_event_links")
      .select("post_id")
      .eq("event_id", eventId)
      .limit(200);
    linkedPostIds = ((data as any[]) ?? []).map((r) => String(r.post_id)).filter(Boolean);
  } catch {
    linkedPostIds = [];
  }

  let media: MediaProjection[] = [];
  if (linkedPostIds.length > 0) {
    const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
      feedType: "for_you",
      postIds: linkedPostIds,
      limit: 200,
      nowMs,
    });
    // Ranked BEFORE the choke point, not after: see MediaProjectionService's
    // rankAndProject — the ranker reads raw-row signals the projection coarsens,
    // and it only reorders, so the projected SET is identical either way.
    media = await projectCandidatesProtected(
      sc,
      viewer,
      rankMediaCandidates(candidates as MediaCandidateRow[], {
        viewerId: viewer.viewerId,
        viewerTripIds: viewer.viewerTripIds,
        intentMediaIds: viewer.intentMediaIds,
        nowMs,
      }),
      nowMs,
    );
  }

  const placeIds = typeof ev.place_id === "string" && ev.place_id ? [ev.place_id] : [];
  // Current state only if the event's place resolves to a canonical uuid place.
  const canonicalPlace = UUID_RE.test(String(ev.place_id ?? "")) ? String(ev.place_id) : null;
  const currentState = await readCurrentState(sc, canonicalPlace, nowMs);

  const contributors = new Set(media.map((m) => m.contributor?.id).filter(Boolean));
  return {
    id: eventId,
    kind: "event",
    title: typeof ev.title === "string" ? ev.title : null,
    placeIds,
    eventId,
    startedAt: ev.start_at ?? ev.starts_at ?? ev.start_time ?? null,
    expectedEndAt: ev.end_at ?? ev.ends_at ?? ev.end_time ?? null,
    currentState,
    perspectiveCount: media.length,
    contributorCount: contributors.size,
    freshness: aggregateFreshness(media.map((m) => m.capturedAt), nowMs),
    // Built from the FULL projected set, not the hero slice: a chain truncated
    // to the first 24 items would drop the end of the night.
    chain: buildExperienceChain(media), confidence: buildExperienceConfidence(media, currentState.claims, nowMs),
    heroMedia: media.slice(0, 24),
  };
}

async function resolveTrip(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  tripId: string,
  nowMs: number,
): Promise<MediaExperienceProjection | null> {
  let trip: any = null;
  try {
    const { data } = await (sc as any)
      .from("trips")
      .select("id, title, owner_id, visibility, start_date, end_date")
      .eq("id", tripId)
      .maybeSingle();
    trip = data ?? null;
  } catch {
    return null;
  }
  if (!trip) return null;

  const visibility = (trip.visibility as string | null) ?? "members";
  let mayView = visibility === "public" || trip.owner_id === viewer.viewerId;
  if (!mayView) {
    try {
      const { data: member } = await (sc as any)
        .from("trip_members")
        .select("role")
        .eq("trip_id", tripId)
        .eq("user_id", viewer.viewerId)
        .in("role", TRIP_MEMBER_ROLES)
        .maybeSingle();
      mayView = Boolean(member);
    } catch {
      mayView = false;
    }
  }
  if (!mayView) return null;

  // Hero media: the viewer's-eligible posts attached to this trip.
  const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: "for_you",
    tripId,
    limit: 200,
    nowMs,
  });
  const media = await projectCandidatesProtected(
    sc,
    viewer,
    rankMediaCandidates(candidates as MediaCandidateRow[], {
      viewerId: viewer.viewerId,
      viewerTripIds: viewer.viewerTripIds,
      intentMediaIds: viewer.intentMediaIds,
      nowMs,
    }),
    nowMs,
  );

  const placeIds = Array.from(new Set(media.map((m) => m.placeId).filter((x): x is string => Boolean(x))));
  const contributors = new Set(media.map((m) => m.contributor?.id).filter(Boolean));
  return {
    id: tripId,
    kind: "trip",
    title: typeof trip.title === "string" ? trip.title : null,
    placeIds,
    tripId,
    startedAt: trip.start_date ?? null,
    expectedEndAt: trip.end_date ?? null,
    currentState: { live: false, claims: [], crowdLabel: null },
    perspectiveCount: media.length,
    contributorCount: contributors.size,
    freshness: aggregateFreshness(media.map((m) => m.capturedAt), nowMs),
    chain: buildExperienceChain(media), confidence: buildExperienceConfidence(media, [], nowMs),
    heroMedia: media.slice(0, 24),
  };
}

// ── §23 `confidence` — census-media MD169 ────────────────────────────────────
//
// EVERYTHING BELOW IS APPENDED AT THE END OF THE FILE ON PURPOSE. Four ANCHORED
// census citations point into this file above (`:110`, `:112`, `:76`, and
// `buildExperienceChain` at `:266` and `:330`), and census-media §12.9 records
// what happens when a lane adds a declaration next to its use: the anchors decay
// and every citing document has to be repointed by a lane that may not edit it.
// So the type, its imports and its builder live here, where nothing follows
// them, and the interface above carries a one-line reference. TypeScript hoists
// both the type and the ESM imports, so the file behaves identically either way.
//
// ── WHAT THIS IS, AND THE TWO THINGS IT REFUSES TO BE ───────────────────────
// MD169 graded §23's `confidence` **W**: "the field exists on the shape but no
// experience-level confidence is computed … a declared-but-unfilled field."
//
// IT IS NOT A THIRD SCORER. `lib/confidenceScore` is this tree's ONE confidence
// formula and its header states that the formula is the specification's and that
// the module "never invents" one. This function supplies that formula's
// components; it does not weight anything itself.
//
// IT IS NOT A NEW SIGNAL. The two facts a set of photographs can honestly carry
// come from `MediaConsensusService.buildVisualConsensus` (§18), which is already
// built, shipped and tested: how many INDEPENDENT sources witnessed this inside
// the fresh window (with `lib/intelIndependence`'s clustering already applied,
// so one account's eight files are one witness and a trip crew is one party),
// and what the canonical conflict engine says about the gated live claims. This
// assembles those into the ladder; it observes nothing of its own.
//
// ── WHY PRESENCE IS COUNTED IN WITNESSES, NOT IN FILES ─────────────────────
// MediaPerspectiveService's header is explicit that "a photograph ASSERTS NO
// VALUE", and MediaConsensusService's that two perspectives of one place cannot
// corroborate each other unless they come from independent parties. A presence
// term keyed on the raw perspective COUNT would therefore let one loud account
// out-score two witnesses, which is popularity wearing an evidence label — the
// precise thing §45 and §16.2 forbid elsewhere in this spec. So both `presence`
// and `independence` read the clustered source count.
//
// ── THE TWO COMPONENTS MEDIA CANNOT SUPPLY ARE NAMED ───────────────────────
// `sourceReliability` and `evidenceQuality` are asset-provenance questions:
// they need `media_assets.source_type` and the capture provenance, and
// census-media family F5 records that store as dark — `canonical_media` is
// absent on every projected row, so no projection path can read it. Scoring them
// ZERO is `lib/confidenceScore`'s documented fail-closed rule ("absent evidence
// is not partial credit") and is correct, but a zero nobody can see is how a
// STRUCTURAL absence turns into an apparently-measured low score. They are
// therefore listed in `absentComponents` on every result. When F5 closes, this
// list is what says where to wire them in.
import {
  scoreConfidence,
  CONFIDENCE_FORMULA_VERSION,
  type ConfidenceComponents,
  type ConfidencePenalties,
} from "../../lib/confidenceScore.js";
import type { ConfidenceBand } from "../../lib/intelContracts.js";
import { buildVisualConsensus } from "./MediaConsensusService.js";
import { isFreshEnoughForLabel, FRESH_WINDOW_MS } from "../../lib/media/mediaFreshness.js";
import type { LiveClaimEnvelope } from "../../lib/liveClaimRead.js";

/**
 * Components this tree cannot supply for a media experience today, named rather
 * than left as an invisible zero. Both need asset provenance (family F5).
 */
export const EXPERIENCE_CONFIDENCE_ABSENT_COMPONENTS = [
  "sourceReliability",
  "evidenceQuality",
] as const;

/**
 * Independent witnesses at which `presence` saturates. TWO, because one witness
 * establishes that something was there and a second establishes it was not one
 * person's account of it — which is the whole of what a photograph proves.
 */
const PRESENCE_SATURATION_SOURCES = 2;

/**
 * Independent witnesses at which `independence` saturates, counted ABOVE the
 * first: a single source has independence 0 by definition, not a small positive
 * number.
 */
const INDEPENDENCE_SATURATION_SOURCES = 3;

/** §23 `ConfidenceState` — replayable, per lib/confidenceScore's contract. */
export interface ExperienceConfidence {
  /** 0..1 bounded evidence score. NOT a probability of enjoyment. */
  score: number;
  band: ConfidenceBand;
  components: ConfidenceComponents;
  penalties: ConfidencePenalties;
  formulaVersion: typeof CONFIDENCE_FORMULA_VERSION;
  /** Perspectives inside FRESH_WINDOW_MS. Stale ones corroborate nothing about now. */
  freshPerspectiveCount: number;
  /** Independent SOURCES among those, after §18's clustering. */
  independentSourceCount: number;
  /** Components no media path can fill today. See the header. */
  absentComponents: readonly string[];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * Compute §23 `confidence` for one experience. PURE: no DB, no network, no clock
 * beyond the `nowMs` it is handed — the same contract MediaConsensusService
 * holds, so both are replayable from a stored row.
 *
 * `claims` are the GATED live-claim envelopes already on the projection's
 * `currentState`. The trip branch passes `[]` because a trip has no place-scoped
 * live read; that is an absence, and an absence scores zero rather than a
 * default.
 */
export function buildExperienceConfidence(
  media: readonly MediaProjection[],
  claims: readonly LiveClaimEnvelope[],
  nowMs: number,
): ExperienceConfidence {
  const consensus = buildVisualConsensus(media, claims, nowMs);
  const freshPerspectiveCount = consensus.corroboration.freshPerspectiveCount;
  const independentSourceCount = consensus.corroboration.independentSourceCount;

  const fresh = (media ?? []).filter((m) =>
    isFreshEnoughForLabel(nowMs - new Date(m.capturedAt).getTime()),
  );

  // presence — independently witnessed, inside the fresh window.
  const presence = clamp01(independentSourceCount / PRESENCE_SATURATION_SOURCES);

  // independence — parties ABOVE the first. One source is not independent of itself.
  const independence = clamp01(
    (independentSourceCount - 1) / (INDEPENDENCE_SATURATION_SOURCES - 1),
  );

  // freshness — how recent the NEWEST fresh perspective is, decaying across the
  // window. No fresh perspective ⇒ 0; the experience is not evidenced NOW.
  let freshness = 0;
  if (fresh.length > 0) {
    const newestAgeMs = Math.min(
      ...fresh.map((m) => Math.max(0, nowMs - new Date(m.capturedAt).getTime())),
    );
    freshness = clamp01(1 - newestAgeMs / FRESH_WINDOW_MS);
  }

  // agreement — read ONLY from the canonical conflict engine's state on the
  // gated live claims. Two photographs of one place cannot agree or disagree
  // (MediaConsensusService's header), so no photograph contributes here: with no
  // live claim there is nothing to agree ABOUT and the term is 0.
  const contradictionState = consensus.contradiction?.state ?? null;
  const agreement =
    claims.length === 0
      ? 0
      : contradictionState === "material"
        ? 0
        : contradictionState === "minor"
          ? 0.5
          : 1;

  // specificity — the share of fresh perspectives that resolve to a canonical
  // place THIS VIEWER MAY BE TOLD ABOUT. `placeId` is null when the
  // location/gem choke point withheld it, and an observation of somewhere
  // unnameable is not a specific one.
  const specificity =
    fresh.length === 0 ? 0 : clamp01(fresh.filter((m) => !!m.placeId).length / fresh.length);

  const result = scoreConfidence(
    {
      presence,
      freshness,
      independence,
      agreement,
      specificity,
      // Named in EXPERIENCE_CONFIDENCE_ABSENT_COMPONENTS — see the header.
      sourceReliability: 0,
      evidenceQuality: 0,
    },
    {
      // §18's threshold, not a second one: only a MATERIAL conflict penalises.
      materialConflict: contradictionState === "material" ? 1 : 0,
      commercialRisk: 0,
      manipulationRisk: 0,
      instability: 0,
    },
  );

  return {
    score: result.confidence,
    band: result.band,
    components: result.components,
    penalties: result.penalties,
    formulaVersion: result.formulaVersion,
    freshPerspectiveCount,
    independentSourceCount,
    absentComponents: EXPERIENCE_CONFIDENCE_ABSENT_COMPONENTS,
  };
}
