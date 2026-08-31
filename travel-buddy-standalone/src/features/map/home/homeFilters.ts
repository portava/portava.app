/**
 * homeFilters — the §3 Live Map / Map Home filter chips.
 *
 * §3, verbatim: "Filter chips: For You, Live, People, Events, Gems."
 *
 * CHIPS ARE NOT LAYERS
 * ====================
 * This is the one thing this module exists to keep straight, because the two
 * look identical from a distance and behave nothing alike:
 *
 *   LAYERS (§16, features/map/layers/layerModel.ts)
 *     "May this KIND be drawn at all?" — a persistent, tri-state (auto/on/off)
 *     user PREFERENCE. It survives app restarts, it survives context changes,
 *     and Safety is not even expressible in it.
 *
 *   CHIPS (§3, this module)
 *     "What am I looking for RIGHT NOW?" — a transient lens over whatever the
 *     layers already permitted. It is not stored, it is not a preference, and
 *     it has no opinion about what the user is willing to see in general.
 *
 * The trap is a chip that "helpfully" switches a layer back on: the user turns
 * People off in the Layers sheet, taps the People chip, and the map silently
 * overrides a decision they made deliberately. §16's whole design is that "an
 * explicit user choice outranks the automatic resolution"; a chip that widens
 * the set is exactly that override wearing a different hat.
 *
 * So the composition is fixed and one-directional:
 *
 *     projection  ──filterByLayers(prefs, ctx)──▶  permitted  ──filterForHome──▶  shown
 *
 * `filterForHome` is a PREDICATE FILTER over an array it is handed. It cannot
 * add an object that was not passed in, it never reads `LayerPreferences`, and
 * it exports no setter — so "a chip re-enabled a layer" is not a bug that can
 * be introduced here without changing the signature. `homeVisibleObjects` is
 * the intended entry point and bakes the ordering in so a caller cannot get it
 * backwards either.
 *
 * SINGLE-SELECT, AND WHY
 * ======================
 * The five chips are single-select (exactly one is always active; the default
 * is `for_you`). The type says so — `HomeFilterId`, a scalar, not a Set — so
 * "two chips at once" is not representable rather than merely discouraged.
 *
 * Multi-select is the tempting model, and it is wrong here for two reasons:
 *
 *  1. THE CHIPS ARE NOT THE SAME KIND OF THING. `people` / `events` / `gems`
 *     are kind filters; `live` is a truth-state filter that cuts ACROSS kinds
 *     (an event, a zone and a place can all be live); `for_you` is a RANKING
 *     lens that filters almost nothing and instead reorders. There is no
 *     honest boolean joining a ranking lens to a kind filter. "For You AND
 *     Events" would have to mean either "events, ranked" (then For You is not
 *     a chip, it is a sort control) or "the union" (then it is not a filter at
 *     all). Both readings are defensible, which is the proof that the operator
 *     is undefined — so the model refuses to define it.
 *
 *  2. UNION-OR-INTERSECTION IS UNGUESSABLE FOR THE USER. With OR, adding a
 *     chip makes the map busier, which inverts what "filter" means and
 *     collides with §16's "do not turn every layer on simultaneously". With
 *     AND, `people` + `events` is always empty (no object is both kinds), so
 *     half the combinations are dead ends the UI would have to explain.
 *
 * A user who wants two kinds at once already has the correct control for it,
 * and it is the durable one: the Layers sheet. Chips stay the fast, transient
 * "show me one thing" lens.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ============================
 * It does not rank, score, personalize, or compute freshness/confidence. Those
 * are decided server-side and arrive on the wire (§19: "The mobile client
 * should not independently reconstruct Portava intelligence rules"). `for_you`
 * in particular is a PROJECTION over server-supplied ranking, not a second
 * ranker — see its section below.
 *
 * Pure: no React, no I/O, no persistence. The only ambient input is the clock,
 * and it is injectable.
 */

import {
  CONFIDENCE_STATES,
  compareByRenderingPriority,
  mayRenderAsLive,
  type ConfidenceState,
  type MapObject,
  type MapObjectKind,
} from '../../../types/mapObjects.ts';
import {
  filterByLayers,
  type LayerContext,
  type LayerPreferences,
} from '../layers/layerModel.ts';

// ── Chip identity (§3) ────────────────────────────────────────────────────────

/**
 * §3's five chips, in the spec's own order. `for_you` leads because §3 calls
 * Map Home "the default map state" and the default lens is the personalized
 * one — the map's job on open is "what is relevant to me", not "everything".
 */
export const HOME_FILTER_IDS = ['for_you', 'live', 'people', 'events', 'gems'] as const;

export type HomeFilterId = (typeof HOME_FILTER_IDS)[number];

/** The chip the map opens on. §3: Map Home is the default state. */
export const DEFAULT_HOME_FILTER: HomeFilterId = 'for_you';

export function isHomeFilterId(value: unknown): value is HomeFilterId {
  return typeof value === 'string' && (HOME_FILTER_IDS as readonly string[]).includes(value);
}

/**
 * What KIND of question a chip asks. Recorded because the three kinds do not
 * compose (see the header), and because the renderer legitimately wants to
 * treat a ranking lens differently from a kind filter.
 */
export const HOME_FILTER_ROLES = ['ranking', 'truth_state', 'kind'] as const;
export type HomeFilterRole = (typeof HOME_FILTER_ROLES)[number];

export interface HomeFilterMeta {
  id: HomeFilterId;
  /** Chip label, in the spec's own words. */
  label: string;
  role: HomeFilterRole;
  /** One line for the a11y hint — what pressing this chip actually does. */
  description: string;
  /** Honest empty state (§39: never render a claim you cannot support). */
  emptyMessage: string;
  /**
   * The kinds this chip admits, or `null` for the chips that are not kind
   * filters (`for_you`, `live`). Never used to ADD objects — only to test the
   * ones already permitted by the layers.
   */
  kinds: readonly MapObjectKind[] | null;
}

/**
 * `people` maps to the three social kinds rather than to §16's People layer,
 * because the layer and the chip disagree on purpose: `buddy_zone` sits on the
 * Buddies layer (a different consent regime) but a user tapping "People" plainly
 * means "humans I could meet", which includes available buddies. That is safe
 * precisely because the chip cannot widen anything — if the Buddies layer is
 * off, no `buddy_zone` reached this module and the chip shows the rest.
 *
 * `crew_member` is included for the same reason (it lives on the Trip layer):
 * your crew are people. `meeting_point` is NOT — it is a place, not a person.
 */
export const HOME_FILTER_META: Record<HomeFilterId, HomeFilterMeta> = {
  for_you: {
    id: 'for_you',
    label: 'For You',
    role: 'ranking',
    description: 'Everything nearby, ordered by what Portava thinks matters to you now',
    emptyMessage: 'Nothing to show around here yet',
    kinds: null,
  },
  live: {
    id: 'live',
    label: 'Live',
    role: 'truth_state',
    description: 'Only what is confirmed to be happening right now',
    emptyMessage: 'Nothing live around here right now',
    kinds: null,
  },
  people: {
    id: 'people',
    label: 'People',
    role: 'kind',
    description: 'Where people are gathering, at the precision they allowed',
    emptyMessage: 'Nobody is sharing presence around here',
    kinds: ['social_zone', 'crew_member', 'buddy_zone'],
  },
  events: {
    id: 'events',
    label: 'Events',
    role: 'kind',
    description: 'Time-bound events happening in view',
    emptyMessage: 'No events around here right now',
    kinds: ['event'],
  },
  gems: {
    id: 'gems',
    label: 'Gems',
    role: 'kind',
    description: 'Community hidden gems in view',
    emptyMessage: 'No gems shared around here yet',
    kinds: ['hidden_gem'],
  },
};

/** The chips in display order, ready for the row. */
export const HOME_FILTERS: readonly HomeFilterMeta[] = HOME_FILTER_IDS.map(
  (id) => HOME_FILTER_META[id],
);

export function homeFilterLabel(filter: HomeFilterId): string {
  return HOME_FILTER_META[filter].label;
}

/** Honest per-chip empty state. Never a generic "No results". */
export function emptyStateFor(filter: HomeFilterId): string {
  return HOME_FILTER_META[filter].emptyMessage;
}

// ── The `live` chip's floor (§7, §37) ─────────────────────────────────────────

/**
 * §37: "Do not let stale claims remain visually live."
 *
 * Freshness alone is not enough. A busy reading from an hour ago is not Live —
 * `mayRenderAsLive` already rejects that on the freshness axis — but neither is
 * a 30-second-old guess the system barely believes. §7 keeps CERTAINTY and
 * FRESHNESS as separate axes, so the chip requires BOTH: a live/recent
 * freshness band AND a confidence band at or above this floor.
 *
 * `likely_current` is the floor because it is the first band whose §7 label
 * ("Reports indicate") asserts a present-tense observation at all; the two
 * below it read "Limited data" and "Unconfirmed", which are claims about the
 * system's ignorance, not about the world.
 *
 * Both axes fail CLOSED: a missing freshness or a missing confidence excludes
 * the object. This module never derives either — §19.
 */
export const LIVE_CHIP_MIN_CONFIDENCE: ConfidenceState = 'likely_current';

/** Position in `CONFIDENCE_STATES` (declared weakest-first). */
function confidenceRank(state: ConfidenceState): number {
  return CONFIDENCE_STATES.indexOf(state);
}

const LIVE_CHIP_MIN_CONFIDENCE_RANK = confidenceRank(LIVE_CHIP_MIN_CONFIDENCE);

export function meetsLiveConfidenceFloor(
  confidence: ConfidenceState | null | undefined,
): boolean {
  if (confidence == null) return false;
  const rank = confidenceRank(confidence);
  if (rank < 0) return false; // unrecognised band — fail closed
  return rank >= LIVE_CHIP_MIN_CONFIDENCE_RANK;
}

/**
 * Does this object genuinely qualify as Live?
 *
 * Three independent gates, all fail-closed:
 *   1. freshness band is `live` or `recent`  (mayRenderAsLive — the contract's
 *      own helper, never a re-implementation of the thresholds)
 *   2. confidence band is at or above the floor
 *   3. the server's own `expiresAt` has not passed — spec §18: "expiry always
 *      wins over the bucket", so an object the server already declared expired
 *      is not Live no matter how recent its band says it is.
 */
export function qualifiesAsLive(
  obj: MapObject,
  now?: Date | number,
): boolean {
  if (!obj) return false;
  if (!mayRenderAsLive(obj.freshness)) return false;
  if (!meetsLiveConfidenceFloor(obj.confidence)) return false;
  if (isExpired(obj, now)) return false;
  return true;
}

function nowMs(now?: Date | number | null): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/**
 * Has the server's own TTL passed? An unparseable or absent `expiresAt` is NOT
 * treated as expired — absence means "the source set no TTL", and inventing one
 * here would be the client reconstructing freshness policy (§19).
 */
function isExpired(obj: MapObject, now?: Date | number): boolean {
  const raw = obj.expiresAt;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  return t <= nowMs(now);
}

// ── The predicate ─────────────────────────────────────────────────────────────

/**
 * Context the chips are evaluated against. Deliberately TINY, and deliberately
 * NOT `LayerContext`: a chip that could see zoom band, mode or density would be
 * a second automatic-relevance engine competing with §16's. The only ambient
 * input a chip legitimately needs is the clock, for the `live` TTL check.
 */
export interface HomeFilterContext {
  /** Injectable clock. Omitted => `Date.now()`. Tests pass a fixed instant. */
  now?: Date | number;
}

const EMPTY_CONTEXT: HomeFilterContext = Object.freeze({});

/**
 * The single predicate every chip is defined by. `chipCount` and
 * `filterForHome` both go through THIS function, which is why a badge can never
 * disagree with what the map shows — there is only one answer to compute.
 */
export function matchesHomeFilter(
  obj: MapObject,
  filter: HomeFilterId,
  ctx: HomeFilterContext = EMPTY_CONTEXT,
): boolean {
  if (!obj) return false;
  switch (filter) {
    case 'for_you':
      // A ranking lens excludes nothing: everything the layers permitted is
      // "for you", it is only ORDERED differently. See rankForYou below.
      return true;
    case 'live':
      return qualifiesAsLive(obj, ctx.now);
    case 'people':
    case 'events':
    case 'gems': {
      const kinds = HOME_FILTER_META[filter].kinds;
      return kinds != null && kinds.includes(obj.kind);
    }
    default: {
      // Exhaustiveness: a new chip without a rule fails closed rather than
      // silently matching everything.
      const never: never = filter;
      void never;
      return false;
    }
  }
}

/**
 * `for_you` ordering.
 *
 * THIS IS NOT A RANKER. Real personalization is Compass's job — §14: "Compass
 * does not create live facts; it reasons over structured state produced
 * elsewhere", and §19 forbids the client reconstructing intelligence rules. The
 * server has already decided relevance and expressed it in fields the object
 * carries: `renderingPriority` (the §31 ladder, which the projection promotes
 * per-object for Compass picks, selection and active navigation), `distanceKm`,
 * and `confidence`.
 *
 * So this is a PROJECTION over server-supplied ranking: it reads those fields
 * in the order the spec already ranks them and breaks ties deterministically.
 * It invents no weights, consults no user profile, and learns nothing. If the
 * server changes its mind about relevance, this ordering changes with it — that
 * is the point.
 *
 * Order: the contract's own §31 comparator (priority, then distance, then id)
 * with ONE extra rung slipped in ahead of the id tie-break — confidence — so
 * that between two equally-prioritized, equally-near objects the better-
 * evidenced one leads (§24: evidence takes precedence over popularity). The id
 * fall-through is kept last so the sort stays a total order and paging is
 * deterministic.
 */
function distanceOf(obj: MapObject): number {
  return obj.distanceKm ?? Number.POSITIVE_INFINITY;
}

function compareForYou(a: MapObject, b: MapObject): number {
  if (a.renderingPriority !== b.renderingPriority) {
    return b.renderingPriority - a.renderingPriority;
  }
  const da = distanceOf(a);
  const db = distanceOf(b);
  if (da !== db) return da - db;

  // Priority and distance tied — evidence decides, then the §31 comparator's
  // own deterministic id fall-through.
  const ca = a.confidence == null ? -1 : confidenceRank(a.confidence);
  const cb = b.confidence == null ? -1 : confidenceRank(b.confidence);
  if (ca !== cb) return cb - ca;

  return compareByRenderingPriority(a, b);
}

/**
 * Apply a chip to an ALREADY-LAYER-FILTERED set.
 *
 * Contract, and the reason the signature looks like this:
 *   - it takes the objects it is allowed to consider and returns a SUBSET,
 *   - it takes no `LayerPreferences` and no `LayerContext`, so it has nothing
 *     to override even if it wanted to,
 *   - `result.length <= objects.length` and every element of the result is an
 *     element of the input, always, for every chip.
 *
 * Ordering: `for_you` sorts by the server's ranking (see compareForYou); the
 * other four preserve the caller's order, which is already the §31 collision
 * order the projection emitted.
 */
export function filterForHome(
  objects: readonly MapObject[],
  filter: HomeFilterId,
  ctx: HomeFilterContext = EMPTY_CONTEXT,
): MapObject[] {
  if (!Array.isArray(objects) || objects.length === 0) return [];
  const kept = objects.filter((obj) => matchesHomeFilter(obj, filter, ctx));
  if (filter === 'for_you') return kept.slice().sort(compareForYou);
  return kept;
}

/**
 * The badge number for a chip.
 *
 * Shares `matchesHomeFilter` with `filterForHome` by construction, so the count
 * on the chip and the number of objects on the map are the same computation —
 * a badge reading "12 Live" over an empty map is not a state this can produce.
 */
export function chipCount(
  objects: readonly MapObject[],
  filter: HomeFilterId,
  ctx: HomeFilterContext = EMPTY_CONTEXT,
): number {
  if (!Array.isArray(objects) || objects.length === 0) return 0;
  let n = 0;
  for (const obj of objects) {
    if (matchesHomeFilter(obj, filter, ctx)) n += 1;
  }
  return n;
}

/** Every chip's badge in one pass, for the row. */
export function chipCounts(
  objects: readonly MapObject[],
  ctx: HomeFilterContext = EMPTY_CONTEXT,
): Record<HomeFilterId, number> {
  const out = {} as Record<HomeFilterId, number>;
  for (const id of HOME_FILTER_IDS) out[id] = 0;
  if (!Array.isArray(objects)) return out;
  for (const obj of objects) {
    for (const id of HOME_FILTER_IDS) {
      if (matchesHomeFilter(obj, id, ctx)) out[id] += 1;
    }
  }
  return out;
}

// ── The composed pipeline ─────────────────────────────────────────────────────

/**
 * The one function callers should use: layers FIRST, chip SECOND.
 *
 * Written here rather than left to the screen so the ordering cannot be got
 * backwards at a call site. Running the chip first and the layers second would
 * produce the same SET (both are filters) but would invite exactly the mistake
 * this module is guarding against — a chip whose result is then "restored" by
 * layer logic.
 */
export function homeVisibleObjects(
  objects: readonly MapObject[],
  filter: HomeFilterId,
  prefs: LayerPreferences,
  layerContext: LayerContext,
  ctx: HomeFilterContext = EMPTY_CONTEXT,
): MapObject[] {
  const permitted = filterByLayers(objects ?? [], prefs, layerContext);
  return filterForHome(permitted, filter, ctx);
}

/** The same composition for the badges, so counts obey the layers too. */
export function homeChipCounts(
  objects: readonly MapObject[],
  prefs: LayerPreferences,
  layerContext: LayerContext,
  ctx: HomeFilterContext = EMPTY_CONTEXT,
): Record<HomeFilterId, number> {
  return chipCounts(filterByLayers(objects ?? [], prefs, layerContext), ctx);
}
