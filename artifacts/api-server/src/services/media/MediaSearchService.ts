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
  "geographic radius (\"near X\") — search is city-coarse; the canonical Map owns proximity",
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
  query: MediaSearchQuery,
  nowMs: number,
): Promise<MediaSearchResults> {
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

  // EMPTY MEANS EMPTY — a criteria-free search is not a browse surface.
  if (criteriaUsed.length === 0) return emptyResults(nowMs);
  // `scope=trip` without a trip is not a criterion, it is a mistake.
  if (scope === "trip" && !tripId) return emptyResults(nowMs, criteriaUsed);

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
  });
  if (candidates.length === 0) return emptyResults(nowMs, criteriaUsed);

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
  if (matched.length === 0) return emptyResults(nowMs, criteriaUsed);

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

  return {
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
  };
}
