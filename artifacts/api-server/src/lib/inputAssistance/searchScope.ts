/**
 * searchScope — what a typed search ASKS beyond its words, carried to
 * `dispatchSearch` (census-input-intelligence G116 / G98, G283 / G71; spec §18,
 * §11, §20, §47).
 *
 * TWO DEFECTS THIS CLOSES
 * =======================
 * 1. §18's relationship operators — "with my Trip Crew", "people I follow",
 *    "near our meeting point" — were parsed (semanticParser.ts `extractGeo`) and
 *    then constrained nothing: the gateway built `SearchQueryContext` as
 *    `{ lat, lng, userCity, nearbyIntent }` and `SearchQueryContext` had no
 *    member for any of the three to occupy.
 * 2. The buddy arm read the eligibility rule with an EMPTY ask: the gateway never
 *    put the asked category or time window on the context, so `buddyAskFrom(ctx)`
 *    in `searchTravelers(isBuddy)` always answered `{ category: null, dates: null }`
 *    — no service filter, no availability filter, although both legs of the rule
 *    exist (lib/discoveryPeopleBuddy.ts, census-discovery §53).
 *
 * THE RELATIONSHIP SCOPE (resolved here once, honoured inside dispatchSearch)
 * ==========================================================================
 * The scope is the VIEWER'S OWN edges and nothing else — the same scoping
 * recipient search uses (socialIdentity.ts `fetchRecipientCandidateIds`, §47):
 *
 *   followed       `user_follows` rows whose follower is the viewer.
 *   with_crew      co-members of Trips the viewer belongs to (accepted
 *                  owner/member rows, plus each Trip's owner, who is not always
 *                  given a member row — the predicate meetingPointProducer.ts
 *                  reads). When the field lives inside a Trip
 *                  (`sessionContext.tripId`) the crew is THAT Trip's, and only
 *                  if the viewer belongs to it: a non-member asking "with my
 *                  crew" about someone else's Trip reads no member list and
 *                  gets nobody.
 *   meeting_point  the viewer's own current/next meeting point, through the ONE
 *                  privacy-complete reader (`readMeetingPoints`: participants
 *                  only, private items dropped, cancelled meetups dropped,
 *                  expired dropped). It becomes the request's proximity origin.
 *
 * NEVER WIDENING. A scope only removes candidates. People are narrowed at the
 * query (`.in("id", scope)` inside `searchTravelers`), so every privacy gate the
 * person search applies — blocks both ways, discovery opt-outs, Invisible, age
 * restriction, the hidden-name rule, buddy eligibility — still runs on what is
 * left. Blocked people are additionally removed from the scope itself.
 *
 * WHICH TYPES A SCOPE ADMITS (proposed ruling W-SCOPE-1, see the PR body):
 *   followed       PEOPLE only (travelers, buddies). A place, city or hashtag
 *                  has no follow edge, so "people I follow" cannot be about it;
 *                  serving it would be the scope constraining nothing again.
 *   with_crew      people narrowed to the crew; other types are the COMPANY
 *                  reading ("dinner with my crew" — the crew is who you go
 *                  with, not what you are looking for) and are searched by the
 *                  query's own subject, unscoped, exactly as without the phrase.
 *   meeting_point  every type, ranked from the meeting point.
 * The search text for a scoped serve is the parse's residual subject ("zork
 * with my crew" searches "zork"). A person is found by name, so a person type
 * searches only the residual; any other type falls back to the parse's
 * category when the residual is only operators ("bars near our meeting point"
 * searches "bar"). An EMPTY subject lists the scope's people ("people I
 * follow") and searches no other type — an unbounded listing is never served.
 *
 * FAIL CLOSED. A graph read that fails, a meeting point that cannot be read, or
 * a scope larger than one bounded request can carry, is NOT an empty graph: the
 * people types return nothing (followed and meeting_point: every type), and the
 * serve's coverage names the lane and the withheld types, so the envelope says
 * "partial"/"nothing" instead of reading as "nobody matches". A viewer with no
 * follows, no crew or no meeting point gets an honest empty answer — that IS
 * their graph.
 *
 * THE BUDDY ASK. For the `buddies` type the asked buddy SERVICE category (the
 * parse's category, mapped onto the marketplace vocabulary by
 * {@link buddyServiceCategoryFor}) and the request's §15 temporal window are
 * put on that type's context only — every other type keeps the context it had,
 * because the window is a RANKING term for events, never a filter (gateway.ts
 * §15 note; rankingSignals.ts "Saturday Night Market"). The buddy search then
 * runs on the parse's subject, so "zork nightlife tomorrow" asks for buddies
 * named like "zork" who are approved for nightlife and not closed tomorrow.
 *
 * A query that names none of these is untouched: no read, the same context
 * object, the same search text (searchPlatformGolden.json pins it).
 */
import { parseSemanticIntent, type ParsedIntent } from './semanticParser';
import type { SearchQueryContext } from './searchQueryHelpers';
import type { TemporalWindow } from './rankingSignals';
import type { InputContext, SuggestSessionContext } from './types';
import type { GatewayCoverage } from './gateway';
import { isSemanticContext } from './semanticIntent';
import { readMeetingPoints } from '../mapProducers/meetingPointProducer';

// ── The scope as it rides on SearchQueryContext ─────────────────────────────────

export type RelationshipScope =
  | { kind: 'with_crew' | 'followed'; personIds: readonly string[] }
  | { kind: 'meeting_point'; lat: number; lng: number };

/** The person search types a person scope narrows. */
const PERSON_TYPES: ReadonlySet<string> = new Set(['travelers', 'buddies']);

/** Coverage lanes. Neither is a dispatched search type (zeroStateLanes.ts' rule). */
export const RELATIONSHIP_GRAPH_LANE = 'relationship_graph';
export const MEETING_POINT_LANE = 'meeting_point';

/**
 * The most people one scoped request carries. PostgREST puts an `.in()` list in
 * the URL; a bounded list is the difference between a query and a 414. A larger
 * graph is truncated (most recent follows first) and the serve says it is
 * partial — never silently.
 */
export const RELATIONSHIP_SCOPE_MAX_IDS = 200;

/** Does this scope let `type` be searched at all? (pure; dispatchSearch's gate) */
export function relationshipAdmitsType(scope: RelationshipScope, type: string): boolean {
  if (scope.kind === 'followed') return PERSON_TYPES.has(type);
  return true;
}

/** The people a person search may return under this context's scope, or null for no person scope. */
export function relationshipPersonIds(ctx?: SearchQueryContext | null): readonly string[] | null {
  const s = ctx?.relationship;
  if (!s || s.kind === 'meeting_point') return null;
  return s.personIds;
}

/** A meeting-point scope makes the meeting point the request's proximity origin. */
export function withRelationshipOrigin(ctx?: SearchQueryContext): SearchQueryContext | undefined {
  const s = ctx?.relationship;
  if (!ctx || !s || s.kind !== 'meeting_point') return ctx;
  return { ...ctx, lat: s.lat, lng: s.lng };
}

// ── What the text asks ──────────────────────────────────────────────────────────

export type RelationshipAsk = 'with_crew' | 'followed' | 'meeting_point';

/** The relationship operator a parse names, or null. "near our meeting point" is the anchor. */
export function relationshipAskFrom(parsed: ParsedIntent): RelationshipAsk | null {
  if (parsed.relationship === 'with_crew' || parsed.relationship === 'followed') return parsed.relationship;
  if (parsed.anchor?.kind === 'meeting_point') return 'meeting_point';
  return null;
}

/**
 * The parser's category, read as a buddy SERVICE (lib/discoveryPeopleBuddy.ts
 * `BUDDY_SERVICE_CATEGORIES`). Only unambiguous families map; anything else
 * (beach, park, viewpoint …) constrains nothing, as `buddyAskFrom` already does
 * for a non-service intent — a guess here would withhold real buddies.
 */
const BUDDY_SERVICE_BY_PARSE_CATEGORY: Readonly<Record<string, string>> = {
  food: 'food', restaurant: 'food', street_food: 'food', cafe: 'food', food_court: 'food',
  nightlife: 'nightlife', bar: 'nightlife', cocktail_bar: 'nightlife', wine_bar: 'nightlife',
  sports_bar: 'nightlife', rooftop_bar: 'nightlife', nightclub: 'nightlife', beach_club: 'nightlife',
  live_music: 'nightlife',
  museum: 'culture', spa: 'wellness', market: 'shopping',
};

export function buddyServiceCategoryFor(parseCategory: string | undefined | null): string | null {
  if (!parseCategory) return null;
  return BUDDY_SERVICE_BY_PARSE_CATEGORY[parseCategory] ?? null;
}

// ── The viewer's own edges (each read is the viewer's; null = unreadable) ───────

interface PersonScopeRead {
  ids: string[];
  truncated: boolean;
}

function bounded(ids: Iterable<string>, viewerId: string, blocked: ReadonlySet<string>): PersonScopeRead {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '' || id === viewerId || blocked.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return { ids: out.slice(0, RELATIONSHIP_SCOPE_MAX_IDS), truncated: out.length > RELATIONSHIP_SCOPE_MAX_IDS };
}

/** The people the viewer follows, most recent first. Null when the read fails. */
export async function readFollowScope(
  sc: any,
  viewerId: string,
  blocked: ReadonlySet<string>,
): Promise<PersonScopeRead | null> {
  try {
    const { data, error } = await sc
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', viewerId)
      .order('created_at', { ascending: false })
      .limit(RELATIONSHIP_SCOPE_MAX_IDS * 2);
    if (error || !Array.isArray(data)) return null;
    return bounded((data as any[]).map((r) => r.following_id as string), viewerId, blocked);
  } catch {
    return null;
  }
}

const CREW_ROLES = ['owner', 'member'];
const accepted = (r: any) => r.status == null || r.status === 'accepted';

/**
 * The viewer's Trip crew. `tripId` narrows to one Trip, and then only when the
 * viewer belongs to it (membership is checked BEFORE that Trip's members are
 * read). Null when any read fails.
 */
export async function readCrewScope(
  sc: any,
  viewerId: string,
  tripId: string | null,
  blocked: ReadonlySet<string>,
): Promise<PersonScopeRead | null> {
  try {
    const [mine, owned] = await Promise.all([
      sc.from('trip_members').select('trip_id, role, status').eq('user_id', viewerId).in('role', CREW_ROLES),
      sc.from('trips').select('id').eq('owner_id', viewerId),
    ]);
    if (mine.error || owned.error || !Array.isArray(mine.data) || !Array.isArray(owned.data)) return null;
    const myTrips = new Set<string>();
    for (const r of mine.data as any[]) if (accepted(r) && typeof r.trip_id === 'string') myTrips.add(r.trip_id);
    for (const r of owned.data as any[]) if (typeof r.id === 'string') myTrips.add(r.id);
    const tripIds = tripId ? (myTrips.has(tripId) ? [tripId] : []) : [...myTrips].sort();
    if (tripIds.length === 0) return { ids: [], truncated: false };

    const [members, owners] = await Promise.all([
      sc.from('trip_members').select('user_id, trip_id, role, status').in('trip_id', tripIds).in('role', CREW_ROLES),
      sc.from('trips').select('id, owner_id').in('id', tripIds),
    ]);
    if (members.error || owners.error || !Array.isArray(members.data) || !Array.isArray(owners.data)) return null;
    const crew: string[] = [];
    for (const r of members.data as any[]) if (accepted(r)) crew.push(r.user_id as string);
    for (const r of owners.data as any[]) crew.push(r.owner_id as string);
    return bounded(crew.sort(), viewerId, blocked);
  } catch {
    return null;
  }
}

const WORLD = { west: -180, south: -90, east: 180, north: 90 };

/**
 * The viewer's current-or-next meeting point (inside `tripId` when the field
 * lives in a Trip). `null` = the viewer has none; `'unreadable'` = the read failed.
 */
export async function readMeetingPointOrigin(
  sc: any,
  viewerId: string,
  tripId: string | null,
  now: number,
): Promise<{ lat: number; lng: number } | null | 'unreadable'> {
  try {
    const r = await readMeetingPoints(sc, viewerId, { bbox: WORLD, now });
    if (!r.ok) return 'unreadable';
    let best: { lat: number; lng: number; at: number } | null = null;
    for (const p of r.points) {
      const payload = (p.payload ?? {}) as { tripId?: string; startsAt?: string | null };
      if (tripId && payload.tripId !== tripId) continue;
      const geom = p.geometry as { type: string; coordinates: [number, number] };
      if (geom?.type !== 'Point') continue;
      const at = payload.startsAt ? Date.parse(payload.startsAt) : NaN;
      if (!Number.isFinite(at)) continue;
      if (!best || at < best.at) best = { lng: geom.coordinates[0], lat: geom.coordinates[1], at };
    }
    return best ? { lat: best.lat, lng: best.lng } : null;
  } catch {
    return 'unreadable';
  }
}

// ── The plan the gateway's generic dispatch follows ──────────────────────────────

export interface SearchScopePlan {
  /** True when nothing was asked: every method below is the identity. */
  readonly inert: boolean;
  /** This type is not searched in this serve. */
  skip(type: string): boolean;
  /** The text this type is searched with. */
  keyFor(type: string, key: string): string;
  /** The context this type is searched with. */
  ctxFor(type: string, ctx: SearchQueryContext): SearchQueryContext;
}

const INERT: SearchScopePlan = {
  inert: true,
  skip: () => false,
  keyFor: (_t, key) => key,
  ctxFor: (_t, ctx) => ctx,
};

export interface PlanSearchScopeParams {
  context: InputContext;
  /** The alias-expanded text the gateway's other parses read. */
  text: string;
  tz: string | null;
  userId: string;
  sessionContext?: SuggestSessionContext;
  temporalWindow: TemporalWindow | null;
  dispatchTypes: readonly string[];
  blockedSet: ReadonlySet<string>;
  coverage?: GatewayCoverage;
  now?: number;
}

/**
 * Resolve, once per serve, the relationship scope (semantic contexts only) and
 * the buddy ask (whenever `buddies` is dispatched). Issues no read unless the
 * text names a relationship operator.
 */
export async function planSearchScope(sc: any, p: PlanSearchScopeParams): Promise<SearchScopePlan> {
  const wantsBuddies = p.dispatchTypes.includes('buddies');
  const semantic = isSemanticContext(p.context);
  if (!semantic && !wantsBuddies) return INERT;

  const parsed = parseSemanticIntent(p.text, { tz: p.tz });
  // A person is found by NAME: the category and the window are asks, not names.
  // Any other type is found by the subject, or by the category when the subject
  // is only operators ("bars near our meeting point" looks for bars).
  const residual = parsed.residualText.trim();
  const topical = residual || (parsed.category ? parsed.category.replace(/_/g, ' ') : '');
  const subjectFor = (t: string) => (PERSON_TYPES.has(t) ? residual : topical);

  // ── the buddy ask (G283) ──
  const buddyCategory = wantsBuddies ? buddyServiceCategoryFor(parsed.category) : null;
  const window = wantsBuddies ? p.temporalWindow : null;
  const hasWindow = window !== null && window.startsAfter !== null && window.startsBefore !== null;
  const hasBuddyAsk = buddyCategory !== null || hasWindow;

  // ── the relationship scope (G116 / G98) ──
  const ask = semantic ? relationshipAskFrom(parsed) : null;
  let scope: RelationshipScope | null = null;
  let withholdAll = false;
  if (ask) {
    const tripId = p.sessionContext?.tripId ?? null;
    const failed = (types: readonly string[]) => {
      p.coverage?.unreadableTypes.add(ask === 'meeting_point' ? MEETING_POINT_LANE : RELATIONSHIP_GRAPH_LANE);
      for (const t of types) p.coverage?.unreadableTypes.add(t);
    };
    if (ask === 'meeting_point') {
      const origin = await readMeetingPointOrigin(sc, p.userId, tripId, p.now ?? Date.now());
      if (origin === 'unreadable') { failed(p.dispatchTypes); withholdAll = true; }
      else if (origin === null) withholdAll = true;
      else scope = { kind: 'meeting_point', lat: origin.lat, lng: origin.lng };
    } else {
      const read = ask === 'followed'
        ? await readFollowScope(sc, p.userId, p.blockedSet)
        : await readCrewScope(sc, p.userId, tripId, p.blockedSet);
      const withheld = p.dispatchTypes.filter((t) => ask === 'followed' || PERSON_TYPES.has(t));
      if (read === null) { failed(withheld); scope = { kind: ask, personIds: [] }; }
      else {
        if (read.truncated) p.coverage?.unreadableTypes.add(RELATIONSHIP_GRAPH_LANE);
        scope = { kind: ask, personIds: read.ids };
      }
    }
  }

  if (!hasBuddyAsk && !ask) return INERT;

  const personScope = scope !== null && scope.kind !== 'meeting_point';
  /** Does this serve re-key `t` to its subject? Every type under a relationship; buddies under an ask. */
  const rekeyed = (t: string) => ask !== null || (t === 'buddies' && hasBuddyAsk);
  return {
    inert: false,
    skip: (t) => {
      if (withholdAll) return true;
      if (scope && !relationshipAdmitsType(scope, t)) return true;
      if (!rekeyed(t) || subjectFor(t).length > 0) return false;
      // An empty subject: only a person scope lists its people ("people I follow"),
      // and the buddy field lists the buddies its ask admits ("nightlife tonight").
      // Anything else would be an unbounded listing, so it is not searched.
      if (personScope && PERSON_TYPES.has(t)) return false;
      if (t === 'buddies' && hasBuddyAsk && p.context === 'buddy_service') return false;
      return true;
    },
    keyFor: (t, key) => (rekeyed(t) ? subjectFor(t) : key),
    ctxFor: (t, ctx) => {
      let out = ctx;
      if (scope && relationshipAdmitsType(scope, t)) out = { ...out, relationship: scope };
      if (t === 'buddies' && hasBuddyAsk) {
        out = {
          ...out,
          ...(buddyCategory ? { intentCategory: buddyCategory } : {}),
          ...(hasWindow ? { startsAfter: window!.startsAfter, startsBefore: window!.startsBefore } : {}),
        };
      }
      return out;
    },
  };
}
