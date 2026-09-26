/**
 * MediaSearchService (§38) — the Media search reader.
 *
 * census-media MD349/MD367 both read **N**: there was no media search service
 * and no `/media/search` route, and §38's seven example queries (MD287–MD293)
 * therefore had nothing to answer them. This is the SERVER half. The client half
 * (`services/mediaSearch.ts`, `MediaSearchScreen`) is still unbuilt and its
 * census rows stay N.
 *
 * ── IT IS NOT A SECOND READ PATH ─────────────────────────────────────────────
 * A search endpoint is the classic way a privacy gate gets forked: someone
 * writes a fresh query against `posts` and blocks / mutes / private accounts /
 * moderation / delayed publish / hidden-gem ceilings are re-implemented, or
 * quietly forgotten. Nothing here queries `posts` itself. It calls
 * `MediaProjectionService.loadEligibleCandidatesOrRefuse` (the shared candidate
 * loader with the eligibility gate and the private-account guard, which
 * REFUSES rather than reporting an unreadable table as no rows) and
 * `projectCandidatesProtected` (the coarse projector behind the
 * lib/mediaLocationVisibility choke point) — the same two functions every §43
 * lens uses. A gate added to either binds here for free; a gate removed from
 * either breaks every media surface at once, which is the point.
 *
 * ── THE HAYSTACK IS WHAT THE VIEWER MAY ALREADY SEE ──────────────────────────
 * Free text is matched AFTER projection, against the caption plus the
 * DISCLOSURE-APPLIED labels (venue / neighborhood / city / country / category).
 * Matching the raw `posts.location_name` instead would be an inference leak: a
 * viewer could confirm "there is media at a place called X" for a venue the
 * disclosure choke point had just decided not to name them. Post-projection
 * matching makes that structurally impossible.
 *
 * ── WHAT THIS SEARCH CANNOT DO, STATED RATHER THAN IMPLIED ───────────────────
 * See MEDIA_SEARCH_UNSUPPORTED. The two that matter:
 *
 *   • NO VISUAL SIMILARITY. §38's "Find places that look like this" is not
 *     answered. The tree has a perceptual-hash module (lib/media/pHashUtils +
 *     mediaDedupWorker) but it is a NEAR-DUPLICATE collapser over one place's
 *     own uploads, not a cross-place similarity index, and pretending otherwise
 *     would be the worst kind of half-build.
 *   • RECALL IS BOUNDED BY THE SHARED LOADER'S PAGE. Structural criteria (city,
 *     category, place, trip, author) are pushed into the DB query; free text is
 *     applied in memory over the page that comes back. A caption word on the
 *     201st most recent matching post is not found. Widening that needs either a
 *     text index on `posts` or a search-side query — and a search-side query is
 *     exactly the fork this file refuses to make. Stated, not hidden.
 *
 * ── EMPTY MEANS EMPTY ────────────────────────────────────────────────────────
 * A search with NO criteria returns nothing. It must never degrade into "show
 * me the feed": that would make an unauthenticated-looking browse surface out of
 * a search box, and it is how a search endpoint becomes a scraper.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadEligibleCandidatesOrRefuse,
  projectCandidatesProtected,
  type ViewerResolved,
} from "./MediaProjectionService.js";
import { resolveExperience, type MediaExperienceProjection } from "./MediaExperienceResolver.js";
import { mayDiscloseGemIdentity } from "../hiddenGems/HiddenGemPrivacyGuard.js";
import type { MediaCandidateRow, MediaProjection } from "../../lib/media/mediaProjection.js";
import {
  aggregateFreshness,
  countFresh,
  isFreshEnoughForLabel,
  type FreshnessState,
} from "../../lib/media/mediaFreshness.js";

/** Honest capability boundary, exported so a caller can render it. */
export const MEDIA_SEARCH_UNSUPPORTED: readonly string[] = [
  "visual similarity (\"find places that look like this\") — no cross-place visual index exists",
  "\"near X\" wider than 5 km, or with no center given — then search is city-coarse; the canonical Map owns proximity",
  "free-text recall beyond the shared candidate loader's page",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bound on experiences resolved per search — each one is its own gated read. */
const MAX_EXPERIENCES = 5;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 60;

export type MediaSearchScope = "all" | "me" | "trip";

export interface MediaSearchQuery {
  /** Free text. Matched post-projection; see the header. */
  q?: string | null;
  city?: string | null;
  category?: string | null;
  placeId?: string | null;
  tripId?: string | null;
  /** `me` restricts to the viewer's own media; `trip` requires `tripId`. */
  scope?: MediaSearchScope;
  /** Only perspectives inside the fresh window ("right now" / "tonight"). */
  freshOnly?: boolean;
  /** §38 "Where was this photo taken?" — resolve one media id to its coarse place. */
  mediaId?: string | null;
  limit?: number;
}

export interface MediaSearchPlaceResult {
  placeId: string;
  label: string | null;
  neighborhood: string | null;
  city: string | null;
  country: string | null;
  perspectiveCount: number;
  freshPerspectiveCount: number;
  freshness: FreshnessState;
}

export interface MediaSearchPersonResult {
  id: string;
  username: string | null;
  name: string | null;
  avatarUrl: string | null;
  verified: boolean;
  isOfficial: boolean;
  perspectiveCount: number;
}

export interface MediaSearchGemResult {
  gemId: string;
  name: string | null;
  placeId: string;
}

export interface MediaSearchResults {
  generatedAt: string;
  /** The criteria that were actually applied. Empty ⇒ every result list is empty. */
  criteriaUsed: string[];
  media: MediaProjection[];
  places: MediaSearchPlaceResult[];
  people: MediaSearchPersonResult[];
  hiddenGems: MediaSearchGemResult[];
  experiences: MediaExperienceProjection[];
  totals: {
    media: number;
    places: number;
    people: number;
    hiddenGems: number;
    experiences: number;
  };
  /** What this search cannot answer. Copied from MEDIA_SEARCH_UNSUPPORTED. */
  unsupported: readonly string[];
  /**
   * Result lists that could NOT be determined on this request because a
   * secondary read failed — NOT lists that came back empty.
   *
   * The primary media read refuses outright (MediaCandidatesUnavailableError):
   * without it there is no answer at all. The gem and experience roll-ups are
   * different — they narrow an answer that already exists — so failing the
   * whole search on them would be worse for the caller than saying so. What is
   * NOT acceptable is the old behaviour: returning `hiddenGems: []` when the
   * gem table could not be read, which tells the viewer "there are no hidden
   * gems here" on the strength of a query that did not answer. A name in this
   * array means "not looked at", and the matching list is empty for that reason
   * rather than the factual one.
   */
  undetermined: readonly string[];
}

function emptyResults(nowMs: number, criteriaUsed: string[] = []): MediaSearchResults {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    criteriaUsed,
    media: [],
    places: [],
    people: [],
    hiddenGems: [],
    experiences: [],
    totals: { media: 0, places: 0, people: 0, hiddenGems: 0, experiences: 0 },
    unsupported: MEDIA_SEARCH_UNSUPPORTED,
    undetermined: [],
  };
}

/** Trim + cap a free-text term. Empty / whitespace-only ⇒ null (not a criterion). */
export function normalizeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > 120) return null;
  return t;
}

/**
 * The searchable text of ONE projected item: the author's own caption plus the
 * labels the disclosure choke point decided this viewer may see. Nothing that
 * was withheld can be matched on.
 */
function haystack(p: MediaProjection, caption: string | null): string {
  return [caption ?? "", p.placeLabel ?? "", p.neighborhood ?? "", p.city ?? "", p.country ?? "", p.category ?? ""]
    .join("  ")
    .toLowerCase();
}

/** Captions keyed by post id, read off the candidate rows (never projected). */
function captionsById(rows: MediaCandidateRow[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of rows) {
    const id = (r as any)?.id;
    if (id == null) continue;
    const content = (r as any)?.content;
    out.set(String(id), typeof content === "string" ? content : null);
  }
  return out;
}

/** Trip ids on the candidate rows, in first-seen order. */
function tripIdsOf(rows: MediaCandidateRow[], matched: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const id = (r as any)?.id;
    if (id == null || !matched.has(String(id))) continue;
    const t = (r as any)?.trip_id;
    if (typeof t === "string" && t.length > 0 && !out.includes(t)) out.push(t);
  }
  return out;
}

function rollUpPlaces(media: MediaProjection[], nowMs: number): MediaSearchPlaceResult[] {
  const byPlace = new Map<string, MediaProjection[]>();
  for (const m of media) {
    if (!m.placeId) continue; // a place the viewer may not be told about is not a result
    const list = byPlace.get(m.placeId) ?? [];
    list.push(m);
    byPlace.set(m.placeId, list);
  }
  const out: MediaSearchPlaceResult[] = [];
  for (const [placeId, items] of byPlace.entries()) {
    const capturedAts = items.map((m) => m.capturedAt);
    out.push({
      placeId,
      label: items.find((m) => m.placeLabel)?.placeLabel ?? null,
      neighborhood: items.find((m) => m.neighborhood)?.neighborhood ?? null,
      city: items.find((m) => m.city)?.city ?? null,
      country: items.find((m) => m.country)?.country ?? null,
      perspectiveCount: items.length,
      freshPerspectiveCount: countFresh(capturedAts, nowMs),
      freshness: aggregateFreshness(capturedAts, nowMs),
    });
  }
  out.sort((a, b) => b.perspectiveCount - a.perspectiveCount || b.freshPerspectiveCount - a.freshPerspectiveCount);
  return out;
}

function rollUpPeople(media: MediaProjection[]): MediaSearchPersonResult[] {
  const byId = new Map<string, MediaSearchPersonResult>();
  for (const m of media) {
    const c = m.contributor;
    if (!c?.id) continue;
    const existing = byId.get(c.id);
    if (existing) {
      existing.perspectiveCount += 1;
      continue;
    }
    byId.set(c.id, {
      id: c.id,
      username: c.username ?? null,
      name: c.name ?? null,
      avatarUrl: c.avatarUrl ?? null,
      verified: Boolean(c.verified),
      isOfficial: Boolean(c.isOfficial),
      perspectiveCount: 1,
    });
  }
  return [...byId.values()].sort((a, b) => b.perspectiveCount - a.perspectiveCount);
}

/**
 * Hidden-gem results for the places the matched media resolved to.
 *
 * The predicate is `mayDiscloseGemIdentity` — the `hidden_gems_public_read` RLS
 * policy plus the owner bypass — exactly as MediaActionResolver uses it, because
 * naming a gem against a searchable place de-anonymizes it just as surely as
 * handing out its coordinates.
 *
 * FAIL CLOSED AND SAY SO. An unreadable lookup still yields no gems — that part
 * was right and is unchanged — but it now reports `determined: false` so the
 * caller can distinguish "no gems here" from "the gem table did not answer".
 * Withholding the rows is the privacy decision; claiming the rows do not exist
 * is a separate, false statement that the old `return []` made for free.
 */
async function resolveGemResults(
  sc: SupabaseClient,
  viewerId: string,
  placeIds: string[],
): Promise<{ gems: MediaSearchGemResult[]; determined: boolean }> {
  if (placeIds.length === 0) return { gems: [], determined: true };
  try {
    const { data, error } = await (sc as any)
      .from("hidden_gems")
      .select("id, name, status, sensitivity_level, submitted_by, canonical_place_id")
      .in("canonical_place_id", placeIds.slice(0, MAX_LIMIT));
    if (error || !Array.isArray(data)) return { gems: [], determined: false };
    const out: MediaSearchGemResult[] = [];
    for (const g of data as any[]) {
      if (!g?.id || !mayDiscloseGemIdentity(g, viewerId)) continue;
      out.push({
        gemId: String(g.id),
        name: typeof g.name === "string" ? g.name : null,
        placeId: String(g.canonical_place_id),
      });
    }
    return { gems: out, determined: true };
  } catch {
    return { gems: [], determined: false };
  }
}

/**
 * Run a §38 media search for one viewer.
 *
 * An empty or criteria-free query yields a well-formed EMPTY result, never the
 * feed. A query whose CANDIDATE READ FAILED yields neither: it throws
 * `MediaCandidatesUnavailableError`, which the global error handler turns into
 * a retryable 503. A search that could not read is not a search that found
 * nothing, and reporting the second when the first happened is the defect this
 * signature used to guarantee.
 */
export async function searchMedia(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  query: MediaSearchQuery & MediaSearchNearQuery,
  nowMs: number,
): Promise<MediaSearchResults & MediaSearchNearResult> {
  const q = normalizeSearchTerm(query.q);
  const city = normalizeSearchTerm(query.city);
  const category = normalizeSearchTerm(query.category)?.toLowerCase() ?? null;
  const placeId = typeof query.placeId === "string" && UUID_RE.test(query.placeId) ? query.placeId : null;
  const tripId = typeof query.tripId === "string" && query.tripId.length > 0 ? query.tripId : null;
  const mediaId = typeof query.mediaId === "string" && UUID_RE.test(query.mediaId) ? query.mediaId : null;
  const scope: MediaSearchScope = query.scope === "me" || query.scope === "trip" ? query.scope : "all";
  const freshOnly = query.freshOnly === true;
  const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const criteriaUsed: string[] = [];
  if (q) criteriaUsed.push("q");
  if (city) criteriaUsed.push("city");
  if (category) criteriaUsed.push("category");
  if (placeId) criteriaUsed.push("placeId");
  if (tripId) criteriaUsed.push("tripId");
  if (mediaId) criteriaUsed.push("mediaId");
  if (scope !== "all") criteriaUsed.push("scope");
  if (freshOnly) criteriaUsed.push("freshOnly");
  if (query.near) criteriaUsed.push("near");
  let nearCtx: NearContext | null = null;
  const answer = (r: MediaSearchResults) => ({ ...r, near: nearCtx?.report ?? null });

  // EMPTY MEANS EMPTY — a criteria-free search is not a browse surface.
  if (criteriaUsed.length === 0) return answer(emptyResults(nowMs));
  // `scope=trip` without a trip is not a criterion, it is a mistake.
  if (scope === "trip" && !tripId) return answer(emptyResults(nowMs, criteriaUsed));
  // §38 "near X" (census-media §24, MD288): the center is resolved BEFORE any media read.
  if (query.near) nearCtx = await openNearContext(sc, query.near);
  if (nearCtx?.report.refusal) return answer(emptyResults(nowMs, criteriaUsed));

  // The shared, fail-closed candidate loader. `scope=me` narrows through the
  // loader's own single-author escape hatch, which keeps the viewer's own
  // unlisted media reachable to the viewer and to nobody else.
  const candidates = await loadEligibleCandidatesOrRefuse(sc, viewer, {
    feedType: scope === "me" ? "following" : "for_you",
    authorId: scope === "me" ? viewer.viewerId : null,
    city: city ?? undefined,
    category,
    placeId,
    tripId,
    postIds: mediaId ? [mediaId] : null,
    limit: 200,
    nowMs,
  });
  if (candidates.length === 0) return answer(emptyResults(nowMs, criteriaUsed));

  const captions = captionsById(candidates);
  const projected = await projectCandidatesProtected(sc, viewer, candidates, nowMs);

  let matched = projected;
  if (q) {
    const needle = q.toLowerCase();
    matched = matched.filter((p) => haystack(p, captions.get(p.id) ?? null).includes(needle));
  }
  if (freshOnly) {
    matched = matched.filter((p) => isFreshEnoughForLabel(nowMs - new Date(p.capturedAt).getTime()));
  }
  if (nearCtx) matched = await keepWithinRadius(sc, nearCtx, matched);
  if (matched.length === 0) return answer(emptyResults(nowMs, criteriaUsed));

  const media = matched.slice(0, limit);
  const places = rollUpPlaces(matched, nowMs);
  const people = rollUpPeople(matched);
  const undetermined: string[] = [];
  const gemResult = await resolveGemResults(sc, viewer.viewerId, places.map((p) => p.placeId));
  const hiddenGems = gemResult.gems;
  if (!gemResult.determined) undetermined.push("hiddenGems");

  // Experiences (§23) — resolved through the EXISTING viewer-gated resolver, so
  // a trip/event the viewer may not see resolves to null and never appears.
  //
  // `null` from the resolver is a DECISION (not visible to this viewer, or no
  // perspectives). A rejection is not: it means the resolver's own candidate
  // read refused, and dropping it silently would put this list back in the
  // state the rest of this change is removing. So the two are separated: a null
  // is skipped, a rejection marks the list undetermined.
  const matchedIds = new Set(matched.map((m) => m.id));
  const experiences: MediaExperienceProjection[] = [];
  for (const t of tripIdsOf(candidates, matchedIds).slice(0, MAX_EXPERIENCES)) {
    let exp: MediaExperienceProjection | null = null;
    try {
      exp = await resolveExperience(sc, viewer, t, nowMs);
    } catch {
      if (!undetermined.includes("experiences")) undetermined.push("experiences");
      continue;
    }
    if (exp) experiences.push(exp);
  }

  return answer({
    generatedAt: new Date(nowMs).toISOString(),
    criteriaUsed,
    media,
    places,
    people,
    hiddenGems,
    experiences,
    totals: {
      media: matched.length,
      places: places.length,
      people: people.length,
      hiddenGems: hiddenGems.length,
      experiences: experiences.length,
    },
    unsupported: MEDIA_SEARCH_UNSUPPORTED,
    undetermined,
  });
}

// ── §38 result types EVENTS and TRIPS, found by what they ARE ────────────────
//
// census-media MD294 (§19 of that document). The five kinds above reach an
// event or a trip only as an `experience`, and only through a MATCHED POST's
// `trip_id` — so a search could not return an event nobody had photographed,
// or a trip with no perspectives. MD294's falsifier, verbatim: "a search that
// finds the Beach Festival because it is called Beach Festival, not because
// somebody photographed it."
//
// APPENDED AT THE END OF THE FILE ON PURPOSE: census-media anchors citations at
// `searchMedia` and `MediaSearchResults` above, and nothing may move them.
//
// NOT A NEW GATE. Candidates are found by title in the canonical `events` and
// `trips` tables, and every candidate is then passed through
// `resolveExperience` — the SAME per-kind visibility gate `GET
// /media/experiences/:id` uses (public-or-participant plus
// `checkEventEligibility` for events; public-or-owner-or-member for trips). A
// candidate the viewer may not see resolves to null and is dropped whole: no
// id, no title. The title read itself never leaves the server.

/** At most this many of each kind are gated per search — each gate is its own read. */
const MAX_CANONICAL_PER_KIND = 3;
/** Candidate page read by title before gating. */
const CANONICAL_CANDIDATE_LIMIT = 10;

export interface MediaSearchCanonicalResult {
  id: string;
  kind: "event" | "trip";
  title: string | null;
  startedAt: string | null;
  expectedEndAt: string | null;
  placeIds: string[];
  /** Perspectives the viewer may see — 0 is a real answer: found by name, not by photo. */
  perspectiveCount: number;
  freshness: FreshnessState;
}

export interface MediaSearchCanonicalKinds {
  events: MediaSearchCanonicalResult[];
  trips: MediaSearchCanonicalResult[];
  /** "events" / "trips" when that kind could not be determined on this request. */
  undetermined: string[];
}

/**
 * Events and trips whose TITLE matches the free-text term, each gated through
 * `resolveExperience`. Only for `scope: "all"` — a "my world" or "this trip"
 * search is about the viewer's media, not about the world's events.
 */
export async function searchCanonicalEventsAndTrips(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  query: Pick<MediaSearchQuery, "q" | "scope"> & MediaSearchNearQuery,
  nowMs: number,
): Promise<MediaSearchCanonicalKinds> {
  const out: MediaSearchCanonicalKinds = { events: [], trips: [], undetermined: [] };
  const scope: MediaSearchScope = query.scope === "me" || query.scope === "trip" ? query.scope : "all";
  const term = canonicalTitleTerm(normalizeSearchTerm(query.q));
  if (!term || scope !== "all") return out;

  const candidates = async (table: "events" | "trips"): Promise<string[] | null> => {
    try {
      const { data, error } =
        table === "events"
          ? await (sc as any)
              .from("events")
              .select("id")
              .not("state", "in", '("draft","cancelled","archived")')
              .ilike("title", `%${term}%`)
              .limit(CANONICAL_CANDIDATE_LIMIT)
          : await (sc as any)
              .from("trips")
              .select("id")
              .ilike("title", `%${term}%`)
              .limit(CANONICAL_CANDIDATE_LIMIT);
      if (error || !Array.isArray(data)) return null;
      return (data as any[])
        .map((r) => (typeof r?.id === "string" ? r.id : null))
        .filter((id): id is string => !!id && UUID_RE.test(id));
    } catch {
      return null;
    }
  };

  for (const kind of ["event", "trip"] as const) {
    const ids = await candidates(kind === "event" ? "events" : "trips");
    const list = kind === "event" ? out.events : out.trips;
    if (ids === null) {
      out.undetermined.push(kind === "event" ? "events" : "trips");
      continue;
    }
    for (const id of ids) {
      if (list.length >= MAX_CANONICAL_PER_KIND) break;
      let exp: MediaExperienceProjection | null = null;
      try {
        exp = await resolveExperience(sc, viewer, id, nowMs);
      } catch {
        const key = kind === "event" ? "events" : "trips";
        if (!out.undetermined.includes(key)) out.undetermined.push(key);
        continue;
      }
      // The gate said no, or the id resolved to the OTHER kind: not a result here.
      if (!exp || exp.kind !== kind) continue;
      // §38 "near X": found by name, but near only through a place of its own that
      // the canonical Map positions inside the radius (census-media §24, MD288).
      if (query.near && !(await anyPlaceWithinRadius(sc, query.near, exp.placeIds))) continue;
      list.push({
        id: exp.id,
        kind: exp.kind,
        title: exp.title,
        startedAt: exp.startedAt,
        expectedEndAt: exp.expectedEndAt,
        placeIds: exp.placeIds,
        perspectiveCount: exp.perspectiveCount,
        freshness: exp.freshness,
      });
    }
  }
  return out;
}

/**
 * Fold the canonical kinds into a search response. The five existing lists are
 * untouched; `events` / `trips` and their totals are added, and their
 * undetermined names join the response's own.
 */
export function withCanonicalKinds(
  results: MediaSearchResults,
  kinds: MediaSearchCanonicalKinds,
): MediaSearchResults & {
  events: MediaSearchCanonicalResult[];
  trips: MediaSearchCanonicalResult[];
  totals: MediaSearchResults["totals"] & { events: number; trips: number };
} {
  return {
    ...results,
    events: kinds.events,
    trips: kinds.trips,
    totals: { ...results.totals, events: kinds.events.length, trips: kinds.trips.length },
    undetermined: [...results.undetermined, ...kinds.undetermined.filter((u) => !results.undetermined.includes(u))],
  };
}

/** A title term safe inside a PostgREST `ilike` pattern: wildcard and list syntax removed. */
export function canonicalTitleTerm(q: string | null): string | null {
  if (!q) return null;
  const t = q.replace(/[%_\\,()*]/g, " ").replace(/\s+/g, " ").trim();
  return t.length >= 2 ? t : null;
}
// (Moved here unchanged from above `searchCanonicalEventsAndTrips` so the lines
// `searchMedia` gained for "near" did not move a cited line below them.)

// ── §38 "near X": a bounded radius, resolved through the canonical Map ───────
//
// census-media MD288 (§19.6): "near" was city-coarse by design, and the row's
// falsifier is "Search accepts a radius resolved through the canonical Map".
//
// WHAT "RESOLVED THROUGH THE CANONICAL MAP" MEANS HERE, EXACTLY. A place's
// position for this test is the position the Map's own pipeline would publish
// for it, and nothing else:
//   • the canonical `places` row, shaped by the Map's own place projector
//     (`lib/mapProjectPlace.projectPlace`, which drops an inactive, merged or
//     coordinate-less row and anything `isServable` rejects);
//   • then the §24 gate (`lib/protectedLocations.applyProtection`) over the ONE
//     policy reader (`lib/protectedZoneStore.loadActiveProtectedZones`). A place
//     in a suppress-class zone has NO position here, so it is never "near"
//     anything; one in a coarsen-class zone sits at the zone's anchor, where the
//     Map would draw it.
// Distance is great-circle from that position (`protectedLocations.haversineMeters`).
//
// THE RULES IT STAYS INSIDE.
//   • It calls none of the readers src/test/gatewayBypassGuard.test.ts reserves
//     for the gateway, `loadViewportPlaceRows` among them. It reads `places` BY
//     ID, and only the places a result already names: the narrower read that
//     routes/discoverySearch.ts's `searchSaved` takes for the same reason (search
//     is not a projection: it has no viewport and serves no MapObject).
//   • It reads no `geo_zones` and resolves no zone for a place. The flow-zone
//     model is routes/mapProjection.ts's alone (census-media MD162).
//   • NO COORDINATE LEAVES. Positions exist only inside this module. The response
//     names the center's KIND and the radius, never a point, and the router's
//     boundary scrub still stands behind it.
//   • Candidates are only places the disclosure choke point already lets this
//     viewer be told about (`MediaProjection.placeId` is null otherwise), so the
//     radius narrows an answer and never widens one. A Hidden Gem's ceiling binds
//     there first: an item at a gem whose ceiling is below `place` has no
//     placeId, so it cannot be a result.
//   • A place CENTER goes through the same two steps and nothing else. It is
//     deliberately NOT refused for hosting a gem: the Map's place layer publishes
//     that place at this same position, so there is nothing to protect, and a
//     gem-dependent refusal would itself be the leak ("is this a hidden gem?").
//
// FAIL-CLOSED, IN TWO DIFFERENT WAYS.
//   • The §24 policy or the place read cannot be read: the radius cannot be
//     resolved safely, so the search REFUSES (503, retryable), as it already
//     does when the media read fails. "Nothing near you" may not be said by a
//     query that could not look.
//   • The Map would not place the CENTER (unknown, merged, no coordinate, or
//     withheld by §24): an empty answer that SAYS so (`near.refusal`).
//
// RECALL, STATED: the radius narrows the shared loader's page, as free text
// does. With `city` too, that page is the city's; without it, it is the most
// recent eligible media anywhere.

/** Bounds on `radiusM`. A few kilometres is "near"; wider is a city question. */
export const NEAR_RADIUS_MIN_M = 100;
export const NEAR_RADIUS_MAX_M = 5_000;

/** A validated center and radius. Built only by `parseMediaSearchNear` or a typed caller. */
export type MediaSearchNear =
  | { center: "place"; placeId: string; radiusM: number }
  | { center: "point"; lat: number; lng: number; radiusM: number };

export interface MediaSearchNearQuery {
  near?: MediaSearchNear | null;
}

/** What a "near" answer says about itself. Never a coordinate. */
export interface MediaSearchNearReport {
  center: "place" | "point";
  radiusM: number;
  /** Non-null ⇒ every list is empty BECAUSE the canonical Map would not place the center. */
  refusal: "center_unpositioned" | null;
}

export interface MediaSearchNearResult {
  near: MediaSearchNearReport | null;
}

const NEAR_QUERY_KEYS = ["nearPlaceId", "nearLat", "nearLng", "radiusM"] as const;

const nearQuerySchema = z.object({
  nearPlaceId: z.string().regex(UUID_RE).optional(),
  nearLat: z.coerce.number().min(-90).max(90).optional(),
  nearLng: z.coerce.number().min(-180).max(180).optional(),
  radiusM: z.coerce.number().int().min(NEAR_RADIUS_MIN_M).max(NEAR_RADIUS_MAX_M).optional(),
});

const NEAR_USAGE =
  `"near" needs ONE center (nearPlaceId, or nearLat with nearLng) and radiusM, ` +
  `a whole number of metres from ${NEAR_RADIUS_MIN_M} to ${NEAR_RADIUS_MAX_M}`;

/**
 * Parse the "near" query parameters. No near parameter at all ⇒ `near: null`
 * (not a criterion). Any near parameter ⇒ exactly one center form AND a radius
 * in bounds, or the request is invalid: a half-specified "near" is refused, not
 * guessed at, and a radius past the bound is refused rather than clamped.
 */
export function parseMediaSearchNear(
  raw: unknown,
): { ok: true; near: MediaSearchNear | null } | { ok: false; message: string } {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!NEAR_QUERY_KEYS.some((k) => src[k] !== undefined)) return { ok: true, near: null };
  const parsed = nearQuerySchema.safeParse(src);
  if (!parsed.success) return { ok: false, message: NEAR_USAGE };
  const { nearPlaceId, nearLat, nearLng, radiusM } = parsed.data;
  if (radiusM === undefined) return { ok: false, message: NEAR_USAGE };
  const pointGiven = nearLat !== undefined || nearLng !== undefined;
  if (nearPlaceId !== undefined && !pointGiven) {
    return { ok: true, near: { center: "place", placeId: nearPlaceId, radiusM } };
  }
  if (nearPlaceId === undefined && nearLat !== undefined && nearLng !== undefined) {
    return { ok: true, near: { center: "point", lat: nearLat, lng: nearLng, radiusM } };
  }
  return { ok: false, message: NEAR_USAGE };
}

/**
 * A "near" read that could not be performed. Read by the global error handler
 * (lib/errorEnvelope.ts) exactly as `MediaCandidatesUnavailableError` is:
 * 503 `degraded_unavailable`, retryable.
 */
export class MediaSearchNearUnavailableError extends Error {
  readonly input: "protected_zones" | "places";
  readonly status: number = 503;
  readonly code = "degraded_unavailable" as const;
  constructor(input: "protected_zones" | "places", detail: string) {
    super(`media search near: ${input} unavailable — refusing to answer: ${detail}`);
    this.name = "MediaSearchNearUnavailableError";
    this.input = input;
  }
}

interface NearContext {
  report: MediaSearchNearReport;
  /** Null ⇒ the canonical Map would not place the center; `report.refusal` says so. */
  center: { lat: number; lng: number } | null;
  zones: ProtectedZone[];
  radiusM: number;
}

/** `.in()` chunk for the by-id place read, well inside a PostgREST URL. */
const PLACE_ID_CHUNK = 100;

/**
 * Canonical places by id, positioned exactly as the Map would publish them (see
 * the header). A place absent from the result has no position for this viewer
 * or anyone: unknown, inactive, merged, coordinate-less or suppressed by §24.
 * THROWS `MediaSearchNearUnavailableError` on a failed read — never an empty map.
 */
async function mapPositions(
  sc: SupabaseClient,
  placeIds: readonly (string | null | undefined)[],
  zones: ProtectedZone[],
): Promise<Map<string, { lat: number; lng: number }>> {
  const ids = [...new Set(placeIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))];
  const out = new Map<string, { lat: number; lng: number }>();
  const rows: PlaceRowLike[] = [];
  for (let i = 0; i < ids.length; i += PLACE_ID_CHUNK) {
    let data: unknown;
    let error: unknown;
    try {
      ({ data, error } = await (sc as any)
        .from("places")
        .select(PLACE_SELECT_COLUMNS)
        .in("id", ids.slice(i, i + PLACE_ID_CHUNK)));
    } catch (e) {
      throw new MediaSearchNearUnavailableError("places", e instanceof Error ? e.message : "read threw");
    }
    if (error || !Array.isArray(data)) {
      throw new MediaSearchNearUnavailableError("places", String((error as any)?.message ?? "no rows"));
    }
    rows.push(...(data as PlaceRowLike[]));
  }
  const objects = rows.map((r) => projectPlace(r)).filter((o): o is MapObject => o !== null);
  for (const obj of applyProtection(objects, zones).objects) {
    const id = obj.id.startsWith("place:") ? obj.id.slice("place:".length) : null;
    const at = centroidOf(obj.geometry);
    if (id && at) out.set(id, at);
  }
  return out;
}

async function resolveNearContext(sc: SupabaseClient, near: MediaSearchNear): Promise<NearContext> {
  // Clamped like `limit`: a typed in-process caller cannot widen "near" past the
  // bound the route refuses outright.
  const radiusM = Math.min(Math.max(Math.round(near.radiusM), NEAR_RADIUS_MIN_M), NEAR_RADIUS_MAX_M);
  const zones = await loadActiveProtectedZones(sc);
  if (zones === null) {
    throw new MediaSearchNearUnavailableError("protected_zones", "the §24 policy could not be read");
  }
  let center: { lat: number; lng: number } | null = null;
  if (near.center === "point") {
    if (Number.isFinite(near.lat) && Number.isFinite(near.lng)) center = { lat: near.lat, lng: near.lng };
  } else {
    center = (await mapPositions(sc, [near.placeId], zones)).get(near.placeId) ?? null;
  }
  return {
    report: { center: near.center, radiusM, refusal: center ? null : "center_unpositioned" },
    center,
    zones,
    radiusM,
  };
}

/**
 * One resolution per `near` object, so a request's media half and its
 * events/trips half share a center and a policy read. Keyed by identity: the
 * router parses one object per request and hands the same one to both.
 */
const nearContexts = new WeakMap<MediaSearchNear, Promise<NearContext>>();

function openNearContext(sc: SupabaseClient, near: MediaSearchNear): Promise<NearContext> {
  let ctx = nearContexts.get(near);
  if (!ctx) {
    ctx = resolveNearContext(sc, near);
    nearContexts.set(near, ctx);
  }
  return ctx;
}

function isWithin(ctx: NearContext, at: { lat: number; lng: number }): boolean {
  return ctx.center !== null && haversineMeters(ctx.center.lat, ctx.center.lng, at.lat, at.lng) <= ctx.radiusM;
}

/** The matched items whose (disclosed) place the canonical Map positions inside the radius. */
async function keepWithinRadius(
  sc: SupabaseClient,
  ctx: NearContext,
  items: MediaProjection[],
): Promise<MediaProjection[]> {
  if (!ctx.center || items.length === 0) return [];
  const positions = await mapPositions(sc, items.map((m) => m.placeId), ctx.zones);
  return items.filter((m) => {
    const at = m.placeId ? positions.get(m.placeId) : undefined;
    return at !== undefined && isWithin(ctx, at);
  });
}

/** True when any of an experience's own places is positioned inside the radius. */
async function anyPlaceWithinRadius(
  sc: SupabaseClient,
  near: MediaSearchNear,
  placeIds: readonly string[],
): Promise<boolean> {
  const ctx = await openNearContext(sc, near);
  if (!ctx.center || placeIds.length === 0) return false;
  const positions = await mapPositions(sc, placeIds, ctx.zones);
  return [...positions.values()].some((at) => isWithin(ctx, at));
}

// Imported at the TAIL so no cited line above moves (census-media §12.9); ESM hoists them.
import { z } from "zod";
import { loadActiveProtectedZones } from "../../lib/protectedZoneStore.js";
import { applyProtection, haversineMeters, type ProtectedZone } from "../../lib/protectedLocations.js";
import { PLACE_SELECT_COLUMNS, projectPlace, type PlaceRowLike } from "../../lib/mapProjectPlace.js";
import { centroidOf, type MapObject } from "../../lib/mapObjects.js";
