/**
 * portavaRank — Portava's unified ranking core (spec §42).
 *
 * ONE scoring foundation consumed by Pulse, Discover, Compass, and Events,
 * so surfaces never invent contradictory definitions of relevance.
 *
 * Design principle: TikTok/Instagram optimize predicted WATCH TIME. Portava
 * optimizes predicted REALIZED VALUE — the probability that a recommendation
 * leads to something real in the physical world (a plan joined, an event
 * attended, a gem visited, a traveler met). That objective is encoded here as
 * feature weights that favor actionability (time-to-start kernels,
 * availability fit, proximity) and trusted humans (social proximity,
 * trust-weighted engagement) over raw virality.
 *
 * The module is PURE: callers assemble a ViewerContext and Candidates from
 * whatever data their surface already loads, and get back a scored,
 * diversified, exploration-mixed ordering. Missing signals simply contribute
 * 0 — every surface can adopt it incrementally.
 *
 * It has exactly ONE import, and it is deliberate: `trailAffinityContribution`
 * from lib/discoveryTrailAffinity.ts. The Trail modifier's cap is enforced in
 * that module rather than restated here, because a cap written down twice is a
 * cap that can disagree with itself — and `02_Trails.md` §11's bound is the
 * whole reason Trails is allowed near this file at all (see
 * TRAIL_AFFINITY_MAX_CONTRIBUTION). Nothing else may be added: this stays a
 * scoring kernel, not a place where data is loaded.
 *
 * Phases:
 *   v1 (now)  — hand-tuned DEFAULT_WEIGHTS, deterministic exploration.
 *   v2        — weights fitted offline from the impression→join→attended
 *               funnel (see rank_events logging in PORTAVA-ALGORITHM.md).
 *   v3        — per-user weight deltas + embedding recall for candidates.
 */

import {
  trailAffinityContribution, TRAIL_AFFINITY_MAX_CONTRIBUTION,
} from "./discoveryTrailAffinity.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CandidateKind =
  | 'post' | 'postcard' | 'event' | 'plan' | 'trip' | 'gem' | 'buddy' | 'traveler' | 'place';

export interface RankCandidate {
  id: string;
  kind: CandidateKind;
  /** ISO creation time — recency signal. */
  createdAt?: string | null;
  /** ISO start time for time-bound items (events/plans) — actionability. */
  startsAt?: string | null;
  /** City name (lowercase compare) — geo relevance. */
  city?: string | null;
  neighborhood?: string | null;
  /** Author / host / owner id — social + diversity key. */
  authorId?: string | null;
  /** Lowercased hashtag/interest slugs carried by the item. */
  tags?: string[] | null;
  /** Category slug (nightlife, food, beach…) — affinity matching. */
  category?: string | null;
  /** Engagement counts if the surface has them (0 when absent). */
  likeCount?: number | null;
  joinCount?: number | null;
  /** Host/author trust score 0–100 when known — quality + abuse resistance. */
  authorTrustScore?: number | null;
  /** GPS-verified item (verified check-in / verified host). */
  verified?: boolean | null;
  /** Distance from viewer in km when known (place/event surfaces). */
  distanceKm?: number | null;
  /** Free capacity for capacity-bound items (events) — joinability. */
  hasCapacity?: boolean | null;
  /**
   * True when the author is an official Portava publisher (is_official = true
   * on their profile row). Triggers a configurable lift in Pulse, Roam, and
   * Discovery and exempts the item from per-creator frequency caps.
   */
  isOfficialPublisher?: boolean | null;
  /**
   * Canonical places.id for this item — used by the place engagement boost
   * when the viewer has affinity signals (place_view events) for this place.
   */
  placeId?: string | null;
}

export interface ViewerContext {
  userId: string;
  /** Lowercased current city ('' when unknown). */
  city?: string | null;
  /** Ids the viewer follows. */
  followedIds?: Set<string>;
  /** Ids with MUTUAL follow — stronger than follow. */
  mutualIds?: Set<string>;
  /** Lowercased interest/hashtag slugs. */
  interestTags?: Set<string>;
  /** Category → affinity 0–1 (learned preference engine). */
  categoryAffinities?: Record<string, number>;
  /** Viewer availability right now (explicit opt-in systems only). */
  availableNow?: boolean;
  /** Minutes of free window (layover mode / availability) — actionability cap. */
  availableMinutes?: number | null;
  /** Author ids the viewer recently engaged with (saves/likes/comments). */
  engagedAuthorIds?: Set<string>;
  /** Item ids already seen recently — fatigue. */
  seenIds?: Set<string>;
  /** Epoch ms "now" — injectable for tests. */
  nowMs?: number;
  /**
   * place_id → count of place_view rank_events in the last 30 days.
   * Built by callers from the rank_events table; drives the place engagement
   * boost in scoreCandidate — a ×1.15 multiplier for affinity-positive places.
   */
  placeAffinities?: Record<string, number>;
  /**
   * place_id → local momentum in [0, 1] (lib/discoveryLocalMomentum.ts): how
   * much MORE a place is being served/saved/acted on in the last 48 h than its
   * own baseline. USER-INDEPENDENT — it rides on the context only because the
   * context is the per-request bag the ranker receives. Absent ⇒ 0 for every
   * candidate, which is today's behaviour. Its contribution is HARD-CAPPED at
   * LOCAL_MOMENTUM_MAX_CONTRIBUTION regardless of weights (ROADMAP step 7:
   * "capped local_momentum as modifiers only").
   */
  localMomentum?: Record<string, number>;
  /**
   * place_id → Trail affinity in [0, 1]
   * (services/trails/TrailService.loadViewerTrailModifier, assembled into the
   * request by lib/discoveryModifiers.ts): how strongly this place sits in a
   * Trail the VIEWER FOLLOWS, already scaled by `02` §11 Trail health and by
   * DV-25 Trail momentum before it arrives here.
   *
   * UNLIKE `localMomentum` this one IS user-dependent — it is the viewer's own
   * follow graph — which is why it is a per-request input and never cacheable
   * across viewers (`06` §4: "Candidate caches may be user-independent. Final
   * ranking must not be.").
   *
   * Absent ⇒ 0 for every candidate, which is the behaviour of every deployment
   * where `discovery_ranking_modifiers_enabled` is off or migration 2910 is not
   * applied. Its contribution is HARD-CAPPED at TRAIL_AFFINITY_MAX_CONTRIBUTION
   * regardless of weights, for the reason ROADMAP step 7 gives: trails are "a
   * future MODIFIER to the ranker, never a parallel engine".
   */
  trailAffinity?: Record<string, number>;
}

export interface RankWeights {
  recency: number;
  followedAuthor: number;
  mutualAuthor: number;
  engagedAuthor: number;
  interestTag: number;
  categoryAffinity: number;
  cityMatch: number;
  neighborhoodMatch: number;
  distance: number;
  actionability: number;
  availabilityFit: number;
  socialProof: number;
  trust: number;
  verifiedBonus: number;
  capacityOpen: number;
  seenPenalty: number;
  /**
   * Weight on the local-momentum modifier. Whatever this is set to, the
   * feature's contribution is clamped to LOCAL_MOMENTUM_MAX_CONTRIBUTION in
   * scoreCandidate — the cap is enforced in code, not by the weight table, so
   * an admin weight override cannot turn a modifier into a driver.
   */
  localMomentum: number;
  /**
   * Weight on the Trail-affinity modifier. Same contract as `localMomentum`:
   * the contribution is clamped to TRAIL_AFFINITY_MAX_CONTRIBUTION inside
   * `trailAffinityContribution`, so an admin weight override cannot turn the
   * modifier into a driver.
   */
  trailAffinity: number;
  kindPrior: Partial<Record<CandidateKind, number>>;
}

/**
 * THE MOMENTUM CAP — the largest score contribution local momentum may ever
 * make, whatever the weights say.
 *
 * Why 0.15: it is below every taste-side signal in DEFAULT_WEIGHTS —
 * categoryAffinity 0.4, interestTag 0.3, cityMatch 0.45, actionability 0.9 —
 * and equal to the smallest positive one (verifiedBonus 0.15). A fully
 * saturated momentum can therefore break a tie between two places the
 * viewer's taste rates alike, and cannot lift a place over one the viewer's
 * taste prefers by even a single interest tag. That is the ROADMAP step 7
 * boundary made numeric: momentum is a MODIFIER, taste is the spine. Change
 * this constant only with a ruling; the `portavaRank` cap test pins it.
 */
export const LOCAL_MOMENTUM_MAX_CONTRIBUTION = 0.15;

/**
 * Trusted-publisher boost multiplier applied to the total score when
 * `candidate.isOfficialPublisher` is true.  Configurable via the
 * PORTAVA_PUBLISHER_BOOST_ENABLED feature flag; callers opt in by passing
 * `applyPublisherBoost: true` to `scoreCandidate`.
 *
 * Default 1.2× — gives @Portava a 20 % lift without overriding normal
 * relevance signals (a completely off-topic post still ranks low).
 */
export const PUBLISHER_BOOST = 1.2;

/**
 * Place engagement boost — applied when the viewer has visited the candidate's
 * canonical place page ≥ PLACE_ENGAGEMENT_BOOST_THRESHOLD times in the last
 * 30 days (recorded as rank_events rows with event_type='place_view').
 *
 * 1.15× lift: meaningful but never overwhelming — a familiar place rises
 * gently above equal-signal strangers without locking the feed into a
 * single destination loop.
 */
export const PLACE_ENGAGEMENT_BOOST_THRESHOLD = 2;
export const PLACE_ENGAGEMENT_BOOST = 1.15;

/**
 * v1 hand-tuned weights. Sum-scale is arbitrary; relative magnitude is what
 * matters. Tuned so that: a joinable event starting soon in your city from a
 * trusted host beats a viral post from nowhere — that ordering IS the product.
 */
export const DEFAULT_WEIGHTS: RankWeights = {
  recency: 1.0,
  followedAuthor: 0.5,
  mutualAuthor: 0.35,          // stacked on top of followedAuthor
  engagedAuthor: 0.3,
  interestTag: 0.3,
  categoryAffinity: 0.4,
  cityMatch: 0.45,
  neighborhoodMatch: 0.2,      // stacked on top of cityMatch
  distance: 0.35,
  actionability: 0.9,          // the Portava edge: things you can DO
  availabilityFit: 0.5,
  socialProof: 0.25,
  trust: 0.3,
  verifiedBonus: 0.15,
  capacityOpen: 0.1,
  seenPenalty: -0.6,
  localMomentum: LOCAL_MOMENTUM_MAX_CONTRIBUTION,   // the weight IS the cap; see above
  trailAffinity: TRAIL_AFFINITY_MAX_CONTRIBUTION,   // 0.10 — the owner's approved
                                                    // initial setting, 2026-09-14;
                                                    // see lib/discoveryTrailAffinity.ts
  kindPrior: { event: 0.15, plan: 0.15, gem: 0.05, buddy: 0.0, post: 0.0 },
};

// ── Feature kernels ───────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Exponential recency decay with a 36h half-life (fresher than the old 7-day linear). */
export function recencyScore(createdAt: string | null | undefined, nowMs: number): number {
  if (!createdAt) return 0;
  const age = nowMs - new Date(createdAt).getTime();
  if (!Number.isFinite(age) || age < 0) return 1;
  return Math.pow(0.5, age / (36 * HOUR));
}

/**
 * Actionability kernel for time-bound items — a bell around "soon".
 * Peaks 0–6h before start ("you can still make it"), fades by 48h out,
 * drops hard once started, zero when over ~2h past start.
 */
export function actionabilityScore(startsAt: string | null | undefined, nowMs: number): number {
  if (!startsAt) return 0;
  const dt = new Date(startsAt).getTime() - nowMs; // ms until start
  if (!Number.isFinite(dt)) return 0;
  if (dt < -2 * HOUR) return 0;          // long over
  if (dt < 0) return 0.25;               // ongoing — still joinable, reduced
  if (dt <= 6 * HOUR) return 1;          // starting soon — peak
  if (dt <= 24 * HOUR) return 0.7;       // today/tonight
  if (dt <= 48 * HOUR) return 0.4;       // tomorrow
  if (dt <= 7 * DAY) return 0.2;         // this week
  return 0.08;                           // plannable future
}

/**
 * Availability fit — does the item fit the viewer's actual free window?
 * Only meaningful when the viewer has explicitly shared availability;
 * absent data contributes 0 (never inferred).
 */
export function availabilityFitScore(
  c: RankCandidate, ctx: ViewerContext, nowMs: number,
): number {
  if (!c.startsAt) return 0;
  const startMs = new Date(c.startsAt).getTime();
  if (!Number.isFinite(startMs)) return 0;
  if (ctx.availableMinutes != null) {
    // Layover/limited-window mode: must start within the window.
    const minutesUntil = (startMs - nowMs) / 60_000;
    return minutesUntil >= 0 && minutesUntil <= ctx.availableMinutes ? 1 : -0.5;
  }
  if (ctx.availableNow) {
    const dt = startMs - nowMs;
    return dt >= 0 && dt <= 8 * HOUR ? 1 : 0;
  }
  return 0;
}

/** Distance decay — near beats far, gently (city-level product; never GPS-precise). */
export function distanceScore(distanceKm: number | null | undefined): number {
  if (distanceKm == null || !Number.isFinite(distanceKm) || distanceKm < 0) return 0;
  return 1 / (1 + distanceKm / 5); // 0km→1, 5km→0.5, 20km→0.2
}

/**
 * Social proof with diminishing returns AND trust-aware dampening:
 * log-scaled so 10k likes isn't 1000× 10 likes (anti-virality), and scaled
 * DOWN when the author's trust is unknown/low (manipulation resistance —
 * engagement farmed on low-trust accounts buys little rank).
 */
export function socialProofScore(c: RankCandidate): number {
  const raw = (c.likeCount ?? 0) + 2 * (c.joinCount ?? 0); // joins are worth more than likes
  if (raw <= 0) return 0;
  const base = Math.log10(1 + raw) / 3; // 0–1 around 1k
  const trustFactor = c.authorTrustScore != null
    ? 0.5 + 0.5 * Math.min(100, Math.max(0, c.authorTrustScore)) / 100
    : 0.6;
  return Math.min(1, base) * trustFactor;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface ScoredCandidate<T extends RankCandidate = RankCandidate> {
  candidate: T;
  score: number;
  /** Per-feature contributions — logged for the learning loop + debugging. */
  features: Record<string, number>;
}

export function scoreCandidate<T extends RankCandidate>(
  c: T,
  ctx: ViewerContext,
  w: RankWeights = DEFAULT_WEIGHTS,
  applyPublisherBoost = false,
): ScoredCandidate<T> {
  const nowMs = ctx.nowMs ?? Date.now();
  const f: Record<string, number> = {};

  f.recency = w.recency * recencyScore(c.createdAt, nowMs);

  const authorId = c.authorId ?? '';
  f.followedAuthor = authorId && ctx.followedIds?.has(authorId) ? w.followedAuthor : 0;
  f.mutualAuthor = authorId && ctx.mutualIds?.has(authorId) ? w.mutualAuthor : 0;
  f.engagedAuthor = authorId && ctx.engagedAuthorIds?.has(authorId) ? w.engagedAuthor : 0;

  const tags = c.tags ?? [];
  f.interestTag =
    ctx.interestTags && ctx.interestTags.size > 0 && tags.some((t) => ctx.interestTags!.has(t))
      ? w.interestTag : 0;

  const affinity = c.category ? ctx.categoryAffinities?.[c.category] ?? 0 : 0;
  f.categoryAffinity = w.categoryAffinity * Math.min(1, Math.max(0, affinity));

  const viewerCity = (ctx.city ?? '').toLowerCase();
  const cityHit = !!viewerCity && (c.city ?? '').toLowerCase().includes(viewerCity);
  f.cityMatch = cityHit ? w.cityMatch : 0;
  f.neighborhoodMatch = cityHit && c.neighborhood ? w.neighborhoodMatch : 0;

  f.distance = w.distance * distanceScore(c.distanceKm);
  f.actionability = w.actionability * actionabilityScore(c.startsAt, nowMs);
  f.availabilityFit = w.availabilityFit * availabilityFitScore(c, ctx, nowMs);
  f.socialProof = w.socialProof * socialProofScore(c);

  f.trust = c.authorTrustScore != null
    ? w.trust * Math.min(100, Math.max(0, c.authorTrustScore)) / 100
    : 0;
  f.verifiedBonus = c.verified ? w.verifiedBonus : 0;
  f.capacityOpen = c.hasCapacity ? w.capacityOpen : 0;
  f.seenPenalty = ctx.seenIds?.has(c.id) ? w.seenPenalty : 0;
  f.kindPrior = w.kindPrior[c.kind] ?? 0;

  // Local momentum — a CAPPED modifier (ROADMAP step 7). Absent map or absent
  // id ⇒ 0. The clamp on the input keeps a malformed value in [0,1]; the clamp
  // on the output is the cap itself, applied AFTER the weight so that no weight
  // table can exceed LOCAL_MOMENTUM_MAX_CONTRIBUTION.
  const momentumRaw = ctx.localMomentum?.[c.id];
  const momentum = typeof momentumRaw === 'number' && Number.isFinite(momentumRaw)
    ? Math.min(1, Math.max(0, momentumRaw)) : 0;
  f.localMomentum = momentum > 0
    ? Math.min(LOCAL_MOMENTUM_MAX_CONTRIBUTION, Math.max(0, w.localMomentum * momentum))
    : 0;

  // Trail affinity — the second CAPPED modifier, clamped the same way and for
  // the same reason (`docs/architecture/02_Trails.md:5-12`: trails are "a
  // future MODIFIER to the ranker, never a parallel engine"). The clamp lives
  // in lib/discoveryTrailAffinity.trailAffinityContribution so the cap has ONE
  // definition; a negative or non-finite affinity contributes 0 rather than a
  // penalty, because a place belonging to no Trail says nothing bad about it.
  // Keyed by candidate id, exactly as localMomentum is, so a surface that maps
  // place ids to candidate ids needs no second key space.
  f.trailAffinity = trailAffinityContribution(
    ctx.trailAffinity?.[c.id] ?? 0, w.trailAffinity,
  );

  let score = 0;
  for (const k of Object.keys(f)) score += f[k];

  // Official-publisher boost: multiply the total score when the caller has
  // opted in via `applyPublisherBoost` (controlled by feature flag at the
  // call site) and the candidate carries the publisher signal.
  if (applyPublisherBoost && c.isOfficialPublisher) {
    f.officialPublisher = score * (PUBLISHER_BOOST - 1); // record the additive delta
    score *= PUBLISHER_BOOST;
  }

  // Place engagement boost: ×1.15 when the viewer has ≥2 place_view events
  // for this candidate's canonical place in the last 30 days.  Only fires
  // when both candidate.placeId and ctx.placeAffinities are supplied by the
  // caller — surfaces that don't track place views contribute 0 cleanly.
  if (c.placeId && ctx.placeAffinities) {
    const placeViews = ctx.placeAffinities[c.placeId] ?? 0;
    if (placeViews >= PLACE_ENGAGEMENT_BOOST_THRESHOLD) {
      f.placeEngagement = score * (PLACE_ENGAGEMENT_BOOST - 1);
      score *= PLACE_ENGAGEMENT_BOOST;
    }
  }

  return { candidate: c, score, features: f };
}

// ── Diversity (greedy MMR-style re-rank) ─────────────────────────────────────

export interface DiversityOptions {
  /** Penalty applied per prior consecutive-window item sharing the key. */
  authorPenalty?: number;
  kindPenalty?: number;
  /** Sliding window size the penalties look back over. */
  window?: number;
}

/**
 * Greedy re-rank: repeatedly pick the best remaining candidate after applying
 * repetition penalties against the last `window` picks. Keeps feeds from
 * collapsing into one loud author, one content type, one place or one
 * neighbourhood — see repetitionPenalty and DiversityOptions at the file end.
 */
export function diversify<T extends RankCandidate>(
  scored: ScoredCandidate<T>[], opts: DiversityOptions = {},
): ScoredCandidate<T>[] {
  // Resolved once; the derivation of each magnitude — and the reason two of
  // the four have no default — is on DiversityOptions, merged at the file end.
  const pen = resolveDiversityPenalties(opts);
  const window = Math.max(1, opts.window ?? 3);

  const pool = [...scored].sort((a, b) => b.score - a.score);
  const out: ScoredCandidate<T>[] = [];
  while (pool.length > 0) {
    const recent = out.slice(-window);
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let penalty = 0;
      for (const r of recent) {
        penalty += repetitionPenalty(c.candidate, r.candidate, pen);
      }
      const val = c.score - penalty;
      if (val > bestVal) { bestVal = val; bestIdx = i; }
    }
    out.push(pool.splice(bestIdx, 1)[0]);
  }
  return out;
}

// ── Exploration ───────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) — stable feeds within a session hour. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export interface ExplorationOptions {
  /** One exploration slot every N positions (0 disables). */
  everyN?: number;
  /** Pool = candidates ranked below this position get a chance to surface. */
  poolStart?: number;
}

/**
 * Epsilon-slot exploration: every Nth position is filled from the long tail
 * instead of the head. This is how new creators, new gems, and new cities get
 * discovered before they have engagement history — and how the system keeps
 * learning instead of feeding back its own priors. Seeded per (user, hour) so
 * pagination within a session stays stable.
 */
export function injectExploration<T extends RankCandidate>(
  ranked: ScoredCandidate<T>[], ctx: ViewerContext, opts: ExplorationOptions = {},
): ScoredCandidate<T>[] {
  const everyN = opts.everyN ?? 7;
  if (everyN <= 0 || ranked.length < everyN + 2) return ranked;
  const poolStart = opts.poolStart ?? Math.min(ranked.length, everyN * 2);
  const nowMs = ctx.nowMs ?? Date.now();
  const rand = seededRandom(hashString(ctx.userId) ^ Math.floor(nowMs / HOUR));

  const out = [...ranked];
  for (let pos = everyN - 1; pos < out.length; pos += everyN) {
    const lo = Math.max(poolStart, pos + 1);
    if (lo >= out.length) break;
    const pick = lo + Math.floor(rand() * (out.length - lo));
    const [chosen] = out.splice(pick, 1);
    out.splice(pos, 0, chosen);
  }
  return out;
}

// ── One-call pipeline ─────────────────────────────────────────────────────────

export interface RankOptions {
  weights?: RankWeights;
  diversity?: DiversityOptions | false;
  exploration?: ExplorationOptions | false;
  /**
   * When true, candidates with `isOfficialPublisher = true` receive a
   * PUBLISHER_BOOST multiplier on their total score.  Controlled by the
   * PORTAVA_PUBLISHER_BOOST_ENABLED feature flag at each call site.
   */
  publisherBoost?: boolean;
}

/**
 * Score → diversify → explore. The single entry point every surface calls.
 * Returns ScoredCandidates (features included) so callers can log the
 * feature vector alongside impressions for the v2 learning loop.
 */
export function rankCandidates<T extends RankCandidate>(
  candidates: T[], ctx: ViewerContext, opts: RankOptions = {},
): ScoredCandidate<T>[] {
  const scored = candidates.map((c) => scoreCandidate(c, ctx, opts.weights ?? DEFAULT_WEIGHTS, opts.publisherBoost ?? false));
  const diversified = opts.diversity === false ? scored.sort((a, b) => b.score - a.score)
    : diversify(scored, opts.diversity ?? {});
  return opts.exploration === false ? diversified
    : injectExploration(diversified, ctx, opts.exploration ?? {});
}

// ── Diversity, continued: the axes and their magnitudes ──────────────────────
//
// MERGED RATHER THAN INSERTED, for the reason lib/discoveryPde.ts states at its
// own merged block: the lines above are the target of anchored citations in
// docs/architecture and docs/discovery, this file is in the COVERED registry of
// scripts/check-doc-citations.mjs, and shifting one silently repoints somebody
// else's evidence. Adding below the last cited line moves nothing.

export interface DiversityOptions {
  /**
   * Same canonical place (`candidate.placeId`) and same geography
   * (`candidate.neighborhood`) as a prior pick inside the window.
   *
   * DELIBERATELY UNDEFAULTED, and that absence is the substance of this pair
   * rather than an oversight in it.
   *
   * `authorPenalty` 0.35 and `kindPenalty` 0.15 are v1 hand-tuned constants:
   * they arrived with the engine (commit b542f4456, "Portava ranking engine
   * v1") carrying no recorded derivation, and this file's own header still
   * describes v1 as hand-tuned. There is therefore no METHOD here to derive a
   * third and fourth magnitude from, and choosing one by resemblance to 0.35 or
   * 0.15 would be inventing a ranking constant and presenting it as an
   * inference — which is worse than leaving the number open, because it reads
   * as settled.
   *
   * The two constants in this file that DO carry a derivation
   * (LOCAL_MOMENTUM_MAX_CONTRIBUTION, TRAIL_AFFINITY_MAX_CONTRIBUTION) each say
   * in their own comment that an owner ruling set them and only another may
   * change them. These two need exactly that and nothing else.
   *
   * So: absent means zero, which is byte-identical ordering for every caller in
   * the tree today, and the axis turns on the moment a ruled value is passed —
   * either at a `diversity: { ... }` call site (the Discovery one is the
   * `rankCandidates` call in lib/discoveryPde.ts) or as a named constant here
   * beside the two above.
   *
   * THE TWO AXES ARE NOT EQUALLY READY. `placePenalty` needs only a magnitude:
   * `placeId` is already set on every Discovery candidate. `geoPenalty` needs a
   * magnitude AND a key — no call site in the tree sets `candidate.neighborhood`,
   * and lib/discoveryPde.ts deliberately still does not, because threading it
   * would also switch on the `neighborhoodMatch` weight above, which rewards
   * label PRESENCE rather than geo relevance and which DB-backed places cannot
   * earn. That module's closing note states the decision and names what would
   * unblock it; it is an owner call, not an oversight here.
   */
  placePenalty?: number;
  geoPenalty?: number;
}

/** The four repetition magnitudes, resolved once per `diversify` call. */
export interface ResolvedDiversityPenalties {
  author: number;
  kind: number;
  place: number;
  geo: number;
}

function resolveDiversityPenalties(opts: DiversityOptions): ResolvedDiversityPenalties {
  return {
    author: opts.authorPenalty ?? 0.35,
    kind:   opts.kindPenalty ?? 0.15,
    // No default — see the note on DiversityOptions above.
    place:  opts.placePenalty ?? 0,
    geo:    opts.geoPenalty ?? 0,
  };
}

/**
 * How much `c` is penalised for following `r` inside the re-rank window.
 *
 * The place and geography clauses are guarded on the CANDIDATE's own key, like
 * `authorId` and unlike `kind` (which is required and so always comparable).
 * Without that guard every candidate lacking a place id would count as a repeat
 * of every other one through `null === null`, and a penalty every candidate
 * incurs equally cannot reorder anything — it is a constant, not diversity.
 */
export function repetitionPenalty(
  c: RankCandidate, r: RankCandidate, pen: ResolvedDiversityPenalties,
): number {
  let penalty = 0;
  if (c.authorId && r.authorId === c.authorId) penalty += pen.author;      // creator
  if (r.kind === c.kind) penalty += pen.kind;                              // content type
  if (c.placeId && r.placeId === c.placeId) penalty += pen.place;          // place
  if (c.neighborhood && r.neighborhood === c.neighborhood) penalty += pen.geo; // geography
  return penalty;
}
