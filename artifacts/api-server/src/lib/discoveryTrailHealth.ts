/**
 * discoveryTrailHealth — `02_Trails.md` §9 fair exposure, §10 saturation,
 * §11 health, §12 status. Pure: rows in, decisions out.
 *
 * WHAT THIS IS NOT
 * ================
 * It is not a ranker. Nothing here orders candidates by a score. §11's health
 * enters ranking as ONE bounded multiplier (`trailHealthScale`) with a FLOOR
 * above zero, and §10's saturation is a POST-order diversity pass of exactly
 * the kind `lib/portavaRank.ts:367` already applies to a page — the same
 * technique, scoped to a Trail, not a second ordering engine. That distinction
 * is the ROADMAP re-scope (`docs/architecture/02_Trails.md:5-12`: "a future
 * MODIFIER to the ranker, never a parallel engine") made operational.
 *
 * §11'S ONE SENTENCE THAT CONSTRAINS EVERYTHING
 * =============================================
 * "Trail health should influence ranking but not silently erase legitimate
 * content." Two obligations in one line, and both are enforced here:
 *
 *   INFLUENCE   `trailHealthScale` returns a multiplier that falls with health.
 *   NOT ERASE   it can never return 0, and never less than
 *               TRAIL_HEALTH_MIN_SCALE. A health model that can zero a row is
 *               a moderation system wearing a ranking system's clothes, and §15
 *               says moderation is its own path with its own actions.
 *
 * The same rule shapes §10: `diversifyTrailPage` never DELETES a suppressed
 * item. It returns it, with the reason, and counts the remainder per place so
 * the caller can render §10's "more from this place". Suppression that leaves
 * no trace is the erasure §11 forbids.
 *
 * WHAT IS UNMEASURED IS SAID, NOT DEFAULTED
 * =========================================
 * A metric with no input reads `null` and is named in `unmeasured`, following
 * census-discovery DV-79's precedent ("Both are reported null and NAMED in
 * every row's unmeasured list rather than defaulted to zero"). An empty Trail
 * therefore measures NOTHING; it does not score perfect health. This matters
 * because `trailHealthScale` averages the MEASURED metrics only, so a Trail
 * that cannot be judged is not penalised for being unjudgeable.
 *
 * census-discovery rows: DV-13 (§10 creator domination), DV-22 (§9 fair
 * opportunity), DV-23 (§10 duplicate saturation), DC-05 (§11 nine metrics).
 */
import type { TrailLifecycleState } from "./discoveryTrailObject.js";

// ── §11's nine metrics ───────────────────────────────────────────────────────

/** `02` §11, in the specification's own order. */
export const TRAIL_HEALTH_METRICS = [
  "contributor_concentration",
  "new_creator_exposure",
  "content_freshness",
  "duplicate_density",
  "report_rate",
  "place_diversity",
  "geographic_diversity",
  "quality_to_noise_ratio",
  "stale_object_ratio",
] as const;
export type TrailHealthMetric = (typeof TRAIL_HEALTH_METRICS)[number];

/**
 * Stamped on every `trail_health_snapshots` row. `10` §5 asks derived features
 * to carry the version that produced them; a metrics blob without one cannot be
 * compared across a definition change, which is the only thing a snapshot is
 * for.
 */
export const TRAIL_HEALTH_MODEL_VERSION = "trail-health-v2"; // §86 (DC-05): v2 — new_creator_exposure is an EXPOSURE share, geographic_diversity is measured over located members, an evergreen/featured member is not stale by age

/** Content newer than this counts as fresh for `content_freshness`. */
export const TRAIL_FRESH_WINDOW_MS = 7 * 24 * 3_600_000;
/** Content older than this counts toward `stale_object_ratio`. */
export const TRAIL_STALE_WINDOW_MS = 90 * 24 * 3_600_000;
/** `content_trails.confidence` at or above this is signal, below it is noise. */
export const TRAIL_QUALITY_CONFIDENCE_FLOOR = 0.5;
/** Share of members from the last 24 h at which §12 reads "Fresh today". */
export const TRAIL_FRESH_TODAY_SHARE = 0.25;

/**
 * The floor on the health multiplier. 0.85 — enough that a badly saturated,
 * heavily reported Trail loses ties it would otherwise win, and far too little
 * to remove anything from a page. See the header: §11 forbids silent erasure,
 * and a multiplier that can reach 0 is silent erasure with a decimal point.
 */
export const TRAIL_HEALTH_MIN_SCALE = 0.85;

export interface TrailMemberForHealth {
  source_id: string;
  contributor_id: string | null;
  confidence: number;
  content_state: string;
  created_at: string;
}

export interface TrailHealthInput {
  members: readonly TrailMemberForHealth[];
  /**
   * Open `trail_reports` rows for the Trail, or `null` when that read FAILED.
   *
   * The two are not the same fact and must not arrive as the same number.
   * supabase-js resolves on a database error, so a caller that discarded the
   * error would hand 0 to this function and the Trail would measure
   * `report_rate: 0` — a POSITIVE claim that nobody has reported it, made from
   * no evidence, which then raises `trailHealthScale` and so raises served
   * rank. `null` is how the caller says "unknown", and the header's rule
   * applies: what is unmeasured is said, not defaulted.
   */
  reportCount: number | null;
  nowMs: number;
  /**
   * item id → coarse geographic cell. OPTIONAL, and its absence is the reason
   * `geographic_diversity` reads null: `content_trails` carries no coordinate,
   * and inventing one from the place id would be a join this module does not
   * do. The caller supplies it when it has the places in hand.
   */
  geoCellByItem?: Record<string, string>; /** §86 (DC-05): source_id → impressions over MOMENTUM_BASELINE_WINDOW_MS (rank_events, every surface); `null`/absent = unread, so new_creator_exposure is unmeasured. */ impressionsBySource?: Record<string, number> | null;
}

export interface TrailHealth {
  metrics: Record<TrailHealthMetric, number | null>;
  unmeasured: TrailHealthMetric[];
  modelVersion: string;
  /**
   * NOT one of §11's nine. The share of members created in the last 24 h,
   * carried because §12's "Fresh today" needs it and recomputing it at the call
   * site would let the label and the metrics disagree.
   */
  freshTodayShare: number | null;
  /** Member count the metrics were computed over — §11's exposure denominator. */
  memberCount: number; /** §75 (DC-17, H-P21-3): `10` §5's other three facts — see `TrailHealthProvenance` at the foot. */ featureVersion: string; computedAt: number; sourceWindow: DerivedStoreWindow;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
/**
 * A count over its denominator. The denominator is never 0 at any call site —
 * every one is behind an `n > 0` or `attributed > 0` guard — so this does NOT
 * carry a null branch. It used to, and a mutation test showed the branch was
 * unreachable: a fallback nothing can reach is a claim about the code that is
 * not true, and the next reader would take it for the reason the metrics can be
 * null. They can be null for one reason only, and it is the one below: a metric
 * that was never ASSIGNED, because there was nothing to measure it from.
 */
const share = (n: number, d: number) => round3(n / d);

/**
 * `02` §11's nine metrics over one Trail's membership.
 *
 * `duplicate_density` and `place_diversity` are complements here, and that is
 * stated rather than dressed up: with only `content_trails.source_id` to go on,
 * "how many members repeat a subject" and "how many distinct subjects are
 * there" are the same count read two ways. Separating them properly needs
 * media- or text-similarity clustering, which this repository has nowhere on
 * the Discovery path. Both are listed because §11 lists both, and the shared
 * denominator is a limit of the input, not a bug in the arithmetic.
 */
export function computeTrailHealth(input: TrailHealthInput): TrailHealth {
  const members = Array.isArray(input?.members) ? input.members.filter(Boolean) : [];
  const n = members.length;
  const nowMs = Number.isFinite(input?.nowMs) ? input.nowMs : Date.now();

  const metrics = Object.fromEntries(
    TRAIL_HEALTH_METRICS.map((k) => [k, null]),
  ) as Record<TrailHealthMetric, number | null>;

  if (n === 0) {
    return {
      metrics,
      unmeasured: [...TRAIL_HEALTH_METRICS],
      modelVersion: TRAIL_HEALTH_MODEL_VERSION,
      freshTodayShare: null,
      memberCount: 0, ...trailHealthProvenance(nowMs),  // §75: an empty measurement is still a measurement at a clock
    };
  }

  // Contributors
  const byContributor = new Map<string, number>();
  let attributed = 0;
  for (const m of members) {
    if (typeof m.contributor_id === "string" && m.contributor_id.length > 0) {
      byContributor.set(m.contributor_id, (byContributor.get(m.contributor_id) ?? 0) + 1);
      attributed += 1;
    }
  }
  if (attributed > 0) {
    metrics.contributor_concentration = share(Math.max(...byContributor.values()), attributed);
    // §86 (DC-05): an EXPOSURE share — impressions on members from contributors NEW to this Trail over impressions on
    // every attributed member — not the membership share it was (census §51.6). Unmeasured without exposures.
    metrics.new_creator_exposure = newCreatorExposureShare(members, input?.impressionsBySource ?? null, nowMs);
  }

  // Freshness / staleness
  let fresh = 0, freshToday = 0, stale = 0;
  for (const m of members) {
    const at = Date.parse(m.created_at ?? "");
    const age = Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
    if (age <= TRAIL_FRESH_WINDOW_MS) fresh += 1;
    if (age <= 24 * 3_600_000) freshToday += 1;
    if (isTrailStaleObject(m, nowMs)) stale += 1; // §86 (E-11): archived from rotation, or old AND not evergreen/featured
  }
  metrics.content_freshness = share(fresh, n);
  metrics.stale_object_ratio = share(stale, n);

  // Subjects
  const distinctSubjects = new Set(members.map((m) => m.source_id)).size;
  metrics.place_diversity = share(distinctSubjects, n);
  metrics.duplicate_density = share(n - distinctSubjects, n);

  // Reports — capped at 1: more reports than members is still "as bad as it gets".
  // A `null` (or non-finite) count is UNMEASURED and stays null: it is named in
  // `unmeasured`, excluded from `goodness`'s average, and stored as JSON null in
  // `trail_health_snapshots.metrics`, which is what migration 2910 already says
  // an input-less metric does.
  const reported = input?.reportCount;
  if (typeof reported === "number" && Number.isFinite(reported)) {
    metrics.report_rate = Math.min(1, round3(Math.max(0, reported) / n));
  }

  // Geography — only when the caller supplied cells for the members.
  const cells = input?.geoCellByItem;
  if (cells && typeof cells === "object") {
    const known = members.map((m) => cells[m.source_id]).filter((c) => typeof c === "string" && c.length > 0);
    if (known.length > 0) metrics.geographic_diversity = share(new Set(known).size, known.length); // §86 (DC-05): over the members that HAVE a cell (a route has none)
  }

  // Quality
  let quality = 0;
  for (const m of members) {
    if (typeof m.confidence === "number" && m.confidence >= TRAIL_QUALITY_CONFIDENCE_FLOOR) quality += 1;
  }
  metrics.quality_to_noise_ratio = share(quality, n);

  return {
    metrics,
    unmeasured: TRAIL_HEALTH_METRICS.filter((k) => metrics[k] === null),
    modelVersion: TRAIL_HEALTH_MODEL_VERSION,
    freshTodayShare: share(freshToday, n),
    memberCount: n, ...trailHealthProvenance(nowMs),  // §75 (DC-17, H-P21-3)
  };
}

/**
 * Each metric normalised so 1 = healthiest ACHIEVABLE for this Trail's size.
 *
 * Why "achievable" and not the raw value: with four members the very best
 * possible `contributor_concentration` is 0.25, not 0, and the best possible
 * `place_diversity` is 1 only because n happens to equal the subject count. A
 * naive `1 - concentration` would score a perfectly diverse small Trail at 0.75
 * and permanently dock every small Trail for being small. The floor for a
 * count-over-n metric is 1/n, so each is rescaled onto [0,1] against its own
 * achievable range.
 */
function goodness(health: TrailHealth): number | null {
  const n = health.memberCount;
  if (n === 0) return null;
  const floor = 1 / n;
  const span = 1 - floor;
  /** count-over-n metric where HIGH is good (diversity-shaped). */
  const hi = (v: number) => (span <= 0 ? 1 : Math.min(1, Math.max(0, (v - floor) / span)));
  /** count-over-n metric where HIGH is bad (concentration-shaped). */
  const lo = (v: number) => (span <= 0 ? 1 : 1 - Math.min(1, Math.max(0, (v - floor) / span)));

  const parts: number[] = [];
  const m = health.metrics;
  if (m.contributor_concentration !== null) parts.push(lo(m.contributor_concentration));
  if (m.new_creator_exposure !== null)      parts.push(m.new_creator_exposure);
  if (m.content_freshness !== null)         parts.push(m.content_freshness);
  // duplicate_density's worst achievable value is (n-1)/n, i.e. `span`.
  if (m.duplicate_density !== null)         parts.push(span <= 0 ? 1 : 1 - Math.min(1, m.duplicate_density / span));
  if (m.report_rate !== null)               parts.push(1 - m.report_rate);
  if (m.place_diversity !== null)           parts.push(hi(m.place_diversity));
  if (m.geographic_diversity !== null)      parts.push(hi(m.geographic_diversity));
  if (m.quality_to_noise_ratio !== null)    parts.push(m.quality_to_noise_ratio);
  if (m.stale_object_ratio !== null)        parts.push(1 - m.stale_object_ratio);

  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/**
 * §11: health influences ranking — as a multiplier in
 * [TRAIL_HEALTH_MIN_SCALE, 1], never below the floor and never above 1.
 *
 * A Trail whose health cannot be measured scales by 1. Absence of evidence
 * about a Trail is not evidence against it, and the alternative — defaulting an
 * unmeasurable Trail to the floor — would punish exactly the newest Trails §9
 * exists to protect.
 */
export function trailHealthScale(health: TrailHealth): number {
  const g = goodness(health);
  if (g === null) return 1;
  const scale = TRAIL_HEALTH_MIN_SCALE + (1 - TRAIL_HEALTH_MIN_SCALE) * Math.min(1, Math.max(0, g));
  return Math.round(scale * 10000) / 10000;
}

// ── §12 status ───────────────────────────────────────────────────────────────

/**
 * `02` §12's user-facing words. §12: "Avoid exposing opaque quality scores" —
 * so this returns one of five fixed strings and NEVER a number, which is also
 * what keeps census-discovery DV-27 (`C`) true on this surface.
 *
 * "Seasonal" is in the vocabulary and is never returned yet: §14's seasonal
 * contexts do not exist as objects, and emitting the word without one would be
 * a label with nothing behind it.
 */
export function trailStatusLabel(
  lifecycle: TrailLifecycleState,
  health: TrailHealth,
): "Active" | "Fresh today" | "Needs updates" | "Seasonal" | "Quiet right now" {
  if (lifecycle === "needs_update") return "Needs updates";
  if (lifecycle !== "active") return "Quiet right now";
  if ((health.freshTodayShare ?? 0) >= TRAIL_FRESH_TODAY_SHARE) return "Fresh today";
  if ((health.metrics.content_freshness ?? 0) > 0) return "Active";
  return "Quiet right now";
}

// ── §10 saturation (DV-13, DV-23) ────────────────────────────────────────────

/** `02` §10 "diversify creators" — DV-13's "never let one creator dominate". */
export const MAX_PER_CONTRIBUTOR_PER_PAGE = 2;
/** `02` §10 "cluster by place/content similarity" — the per-subject bound. */
export const MAX_PER_PLACE_PER_PAGE = 2;

export interface SaturationItem {
  id: string;
  placeId: string | null;
  contributorId: string | null;
  mediaType?: string | null;
}

export type SuppressionReason = "contributor_cap" | "place_cap" | "media_cap" | "viewpoint_cap" | "near_duplicate" | "beyond_page"; // §86 (DV-23): the last three

export interface SaturationResult<T extends SaturationItem> {
  page: T[];
  /** Everything the caps held back, WITH its reason. Never silently dropped. */
  suppressed: Array<{ id: string; reason: SuppressionReason }>;
  /** §10 "preserve access through 'more from this place'" — the per-place remainder. */
  moreFromThisPlace: Record<string, number>;
}

export interface SaturationOptions {
  pageSize: number;
  maxPerContributor?: number;
  maxPerPlace?: number;
  /**
   * OFF by default. `content_trails` carries no media type, so a default cap
   * would silently suppress rows on a field the caller never populated — a
   * guard that fires on missing data rather than on saturation.
   */
  maxPerMediaType?: number | null;
}

/**
 * `02` §10 applied to one Trail page, in input order.
 *
 * An item with NO contributor and NO place is never suppressed: an unknown is
 * not a cap hit, and treating missing attribution as a repeated creator would
 * make the diversity pass strictest exactly where it knows least.
 */
export function diversifyTrailPage<T extends SaturationItem>(
  items: readonly T[],
  opts: SaturationOptions,
): SaturationResult<T> {
  const maxContributor = opts?.maxPerContributor ?? MAX_PER_CONTRIBUTOR_PER_PAGE;
  const maxPlace = opts?.maxPerPlace ?? MAX_PER_PLACE_PER_PAGE;
  const maxMedia = opts?.maxPerMediaType ?? null;
  const pageSize = Math.max(0, opts?.pageSize ?? 0);

  const page: T[] = [];
  const suppressed: Array<{ id: string; reason: SuppressionReason }> = [];
  const moreFromThisPlace: Record<string, number> = {};
  const byContributor = new Map<string, number>();
  const byPlace = new Map<string, number>();
  const byMedia = new Map<string, number>();

  for (const item of items ?? []) {
    if (!item || typeof item.id !== "string") continue;
    if (page.length >= pageSize) {
      // Beyond the page is NOT a suppression — it is pagination, and conflating
      // the two would make "more from this place" count the next page as loss.
      continue;
    }
    const c = item.contributorId;
    const p = item.placeId;
    const md = item.mediaType;

    if (typeof c === "string" && c && (byContributor.get(c) ?? 0) >= maxContributor) {
      suppressed.push({ id: item.id, reason: "contributor_cap" }); continue;
    }
    if (typeof p === "string" && p && (byPlace.get(p) ?? 0) >= maxPlace) {
      suppressed.push({ id: item.id, reason: "place_cap" });
      moreFromThisPlace[p] = (moreFromThisPlace[p] ?? 0) + 1;
      continue;
    }
    if (maxMedia !== null && typeof md === "string" && md && (byMedia.get(md) ?? 0) >= maxMedia) {
      suppressed.push({ id: item.id, reason: "media_cap" }); continue;
    }

    if (typeof c === "string" && c) byContributor.set(c, (byContributor.get(c) ?? 0) + 1);
    if (typeof p === "string" && p) byPlace.set(p, (byPlace.get(p) ?? 0) + 1);
    if (typeof md === "string" && md) byMedia.set(md, (byMedia.get(md) ?? 0) + 1);
    page.push(item);
  }

  return { page, suppressed, moreFromThisPlace };
}

// ── §9 fair exposure (DV-22) ─────────────────────────────────────────────────

/**
 * Share of a page reserved for §9's bounded exploration opportunity. 20 % sits
 * inside ROADMAP step 8's ruled "budget ~15-25 %", so Trails does not invent a
 * second exploration budget beside the one the allocator already honours.
 */
export const TRAIL_EXPLORATION_SLOT_PCT = 20;
/** Above this many impressions an item is no longer NEW and takes no reserved slot. */
export const TRAIL_EXPLORATION_IMPRESSION_CEILING = 500;
/** Below this many impressions a response RATE is noise, not a verdict. */
export const TRAIL_EXPOSURE_MIN_EVIDENCE = 25;
/** Normalized response at or above which §9 step 4 expands rather than tapers. */
export const TRAIL_EXPOSURE_EXPAND_RATE = 0.05;

export interface ExposureCandidate {
  id: string;
  state: string;
  /** §9 "Use exposure denominators" — the denominator, not a promise. */
  impressions: number;
  positives: number;
}

export interface FairExposureResult {
  /** Ids granted a reserved exploration slot on this page. */
  slots: string[];
  /** id → the exposure denominator it was judged on. Every candidate appears. */
  denominators: Record<string, number>;
  /** §9 step 4. `evaluating` when the denominator is too thin to judge. */
  decisions: Record<string, "expand" | "taper" | "evaluating">;
  /** §9 step 5 — cooled items that remain eligible for a retest. */
  retestable: string[];
}

/**
 * `02` §9's five internal steps, as one pure function.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN: any per-item impression target. §9 —
 * "Do not promise a fixed number of impressions publicly." A promise made in a
 * return value becomes a promise rendered in a UI, so the number does not exist
 * here to be rendered. What is returned is a slot allocation, a denominator, a
 * decision and a retest set.
 *
 * The slot count is bounded by TRAIL_EXPLORATION_SLOT_PCT of the page, so a
 * Trail with fifty new items cannot become an all-exploration page — §9's
 * "small relevant audience" is small in both directions.
 */
export function fairExposureSlots(
  items: readonly ExposureCandidate[],
  opts: { pageSize: number },
): FairExposureResult {
  const denominators: Record<string, number> = {};
  const decisions: Record<string, "expand" | "taper" | "evaluating"> = {};
  const retestable: string[] = [];
  const qualified: string[] = [];

  for (const it of items ?? []) {
    if (!it || typeof it.id !== "string") continue;
    const impressions = Number.isFinite(it.impressions) ? Math.max(0, it.impressions) : 0;
    const positives = Number.isFinite(it.positives) ? Math.max(0, it.positives) : 0;
    denominators[it.id] = impressions;

    // Step 3 — evaluate the NORMALIZED response, never the raw count.
    if (impressions < TRAIL_EXPOSURE_MIN_EVIDENCE) decisions[it.id] = "evaluating";
    else decisions[it.id] = positives / impressions >= TRAIL_EXPOSURE_EXPAND_RATE ? "expand" : "taper";

    // Step 5 — a cooled item stays retestable; exclusion must be reversible.
    if (it.state === "archived_from_active_rotation") retestable.push(it.id);

    // Steps 1-2 — qualifies, and has not already had its bounded opportunity.
    if ((it.state === "just_arrived" || it.state === "rediscovered")
      && impressions < TRAIL_EXPLORATION_IMPRESSION_CEILING) {
      qualified.push(it.id);
    }
  }

  const pageSize = Math.max(0, opts?.pageSize ?? 0);
  const budget = Math.floor((pageSize * TRAIL_EXPLORATION_SLOT_PCT) / 100);
  const slotCount = qualified.length === 0 ? 0 : Math.max(1, Math.min(budget, qualified.length));

  return { slots: qualified.slice(0, slotCount), denominators, decisions, retestable };
}

// ── census-discovery §75 (DC-17, lane P33, H-P21-3): the other three facts ─────
//
// `10` §5: "Derived features must retain: source event window · feature
// version · model version · computation time". Trail health kept the model
// version only (`TRAIL_HEALTH_MODEL_VERSION`); the snapshot added its clock as
// `captured_at`, and nothing kept a window or a feature version (§68.2: 1 of 4
// in memory, 2 of 4 stored). Declared at the foot so no cited line above moves.

/**
 * What ONE input row contributes to §11's nine metrics: a `content_trails`
 * member's source_id, contributor_id, confidence, content_state and created_at,
 * and the Trail's open-report count (distinct reporters per member). Bump when
 * a metric reads a new member field or counts a row differently. The ARITHMETIC
 * over those rows is `TRAIL_HEALTH_MODEL_VERSION`'s.
 */
export const TRAIL_HEALTH_FEATURE_VERSION = "trail-member-rows-v2"; // §86: v2 reads each member's impressions and geographic cell as well

/** The three facts `computeTrailHealth` stamps beside its model version. */
export interface TrailHealthProvenance {
  featureVersion: string;
  /** Epoch ms the metrics were computed against — the `nowMs` every age above is measured from. */
  computedAt: number;
  /**
   * Members of ANY age count (freshness and staleness are metrics OVER the
   * members, not a filter on them), so the corpus has no oldest event:
   * `unbounded_start`, ending at the computation clock. The stated limit is the
   * caller's read, not this function: TrailService reads a Trail's newest 500
   * members, as the momentum loader's window is its newest MOMENTUM_ROW_LIMIT rows.
   */
  sourceWindow: DerivedStoreWindow;
}

/** Pure: the provenance of one health computation at `nowMs`. */
export function trailHealthProvenance(nowMs: number): TrailHealthProvenance {
  return {
    featureVersion: TRAIL_HEALTH_FEATURE_VERSION,
    computedAt:     nowMs,
    sourceWindow:   { kind: "unbounded_start", startMs: null, endMs: nowMs },
  };
}

import type { DerivedStoreWindow } from "./discoveryRankProvenance.js";

// ── census-discovery §86 (lane W10-T): the Trail's own §10 and §11 rules ─────
//
// Declared at the foot, with their import, so no cited line above moves. Every
// constant below is a decision recorded in docs/architecture/discovery-decision-
// register.md (section "W10-T — Trails product rules and admin actions"), with
// the spec clause it implements; none is tuned on data (there is no production
// Trail to tune it on, §51.1).

import { titleSimilarity, DUPLICATE_TITLE_SIMILARITY } from "./discoveryTrailObject.js";

/**
 * E-11 (D-W10T-5): what "stale" means for a Trail member. A member that left
 * active rotation is stale; an OLD member is stale unless §7 already says it
 * lasts — `evergreen` is `03` §3's "persistent usefulness over long periods" and
 * `featured` is on its way there, so age alone cannot make either stale. Read by
 * §11's `stale_object_ratio` and by the health order below, so the metric and
 * the order it drives can never disagree.
 */
export function isTrailStaleObject(m: { content_state: string; created_at: string }, nowMs: number): boolean {
  if (m.content_state === "archived_from_active_rotation") return true;
  if (m.content_state === "evergreen" || m.content_state === "featured") return false;
  const at = Date.parse(m.created_at ?? "");
  const age = Number.isFinite(at) ? nowMs - at : Number.POSITIVE_INFINITY;
  return age >= TRAIL_STALE_WINDOW_MS;
}

/**
 * DC-05 (D-W10T-7): a contributor is NEW to a Trail while their first member in
 * it is younger than this — the same 30-day window the exposure denominator is
 * read over (`lib/discoveryLocalMomentum.MOMENTUM_BASELINE_WINDOW_MS`), so "new"
 * and "exposed" are measured over one period. `06` §9's "exploration window" for
 * a new creator, scoped to the Trail.
 */
export const TRAIL_NEW_CREATOR_WINDOW_MS = 30 * 24 * 3_600_000;

/**
 * §11 `new_creator_exposure` as an EXPOSURE: impressions on the members of new
 * contributors over impressions on every attributed member. `null` when the
 * impressions were not read, or when no attributed member was ever shown (a
 * share of nothing is not a measurement).
 */
export function newCreatorExposureShare(
  members: readonly TrailMemberForHealth[], impressionsBySource: Record<string, number> | null, nowMs: number,
): number | null {
  if (!impressionsBySource) return null;
  const firstSeen = new Map<string, number>();
  for (const m of members) {
    if (typeof m.contributor_id !== "string" || m.contributor_id.length === 0) continue;
    const at = Date.parse(m.created_at ?? "");
    if (!Number.isFinite(at)) continue;
    firstSeen.set(m.contributor_id, Math.min(firstSeen.get(m.contributor_id) ?? Number.POSITIVE_INFINITY, at));
  }
  let all = 0, fromNew = 0;
  const counted = new Set<string>();
  for (const m of members) {
    if (typeof m.contributor_id !== "string" || m.contributor_id.length === 0) continue;
    if (counted.has(m.source_id)) continue; // one content counts its impressions once, however many labels it holds
    counted.add(m.source_id);
    const n = Math.max(0, Number(impressionsBySource[m.source_id] ?? 0) || 0);
    all += n;
    if (nowMs - (firstSeen.get(m.contributor_id) ?? Number.NEGATIVE_INFINITY) < TRAIL_NEW_CREATOR_WINDOW_MS) fromNew += n;
  }
  return all > 0 ? round3(fromNew / all) : null;
}

/**
 * DC-05 (D-W10T-7): §11's geographic cell. The Map's degree grid
 * (`lib/mapAggregation.cellFor`: edge 360 / 2^zoom degrees, anchored at
 * -180/-90) continued to zoom 14, an edge of 0.02197° (about 2.4 km at the
 * equator). A Trail is usually scoped to one destination, so a city-sized cell
 * (the Map's coarsest aggregating zoom, 11, ~19.5 km) would put every member in
 * one cell and measure nothing; neighbourhood scale is what "geographic
 * diversity" can distinguish inside a Trail. Server-side only: no cell is ever
 * serialised, and a member's cell is derived from its PLACE's public
 * coordinates, never a post author's GPS.
 */
export const TRAIL_GEO_CELL_ZOOM = 14;

export function trailGeoCell(lat: unknown, lng: unknown): string | null {
  const la = Number(lat), lo = Number(lng);
  if (lat === null || lng === null || lat === undefined || lng === undefined) return null;
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90) return null;
  const size = 360 / 2 ** TRAIL_GEO_CELL_ZOOM;
  const nl = ((((lo + 180) % 360) + 360) % 360) - 180;
  const x = Math.floor((nl + 180) / size);
  const y = Math.floor((Math.min(la, 90 - 1e-9) + 90) / size);
  return `${TRAIL_GEO_CELL_ZOOM}/${x}/${y}`;
}

// ── DV-13 (D-W10T-2): one creator across the whole Trail page ────────────────

/**
 * A single creator may hold at most this share of the DISTINCT items on one
 * Trail page (the union of every module's served items), and never fewer than
 * MAX_PER_CONTRIBUTOR_PER_PAGE — so a small Trail is not emptied. One third: at
 * the bound, two thirds of the page is somebody else's, which is what "never
 * let one creator … dominate" (`02` §10, DV-13) needs at minimum. The
 * per-module cap of MAX_PER_CONTRIBUTOR_PER_PAGE stays, per spotlight.
 */
export const TRAIL_PAGE_CREATOR_SHARE = 1 / 3;

export interface PageBoundModule { key: string; items: ReadonlyArray<{ id: string; sourceType: string; sourceId: string }> }

/**
 * Trim, from the tail, the items that put a creator over the page-wide bound.
 * The page is processed in the modules' own order, so a creator keeps the items
 * the earliest modules chose. Removal is iterated to a fixed point because
 * every removal shrinks the page, and with it the bound. Returns the membership
 * row ids removed; an item whose content is already on the page from an earlier
 * module is the same item and costs nothing. A creator-less item is never
 * trimmed (an unknown is not a cap hit, the rule `diversifyTrailPage` keeps).
 */
export function creatorPageBoundRemovals(
  modules: readonly PageBoundModule[], creatorOfRow: (rowId: string) => string | null,
): Set<string> {
  const removed = new Set<string>();
  for (;;) {
    const seenContent = new Set<string>();
    const byCreator = new Map<string, Array<{ rowId: string; content: string }>>();
    for (const mod of modules) {
      for (const it of mod.items) {
        if (removed.has(it.id)) continue;
        const content = `${it.sourceType}:${it.sourceId}`;
        if (seenContent.has(content)) continue;
        seenContent.add(content);
        const c = creatorOfRow(it.id);
        if (!c) continue;
        const list = byCreator.get(c);
        if (list) list.push({ rowId: it.id, content }); else byCreator.set(c, [{ rowId: it.id, content }]);
      }
    }
    const bound = Math.max(MAX_PER_CONTRIBUTOR_PER_PAGE, Math.floor(seenContent.size * TRAIL_PAGE_CREATOR_SHARE));
    let worst: string | undefined, worstCount = 0; // `undefined`, not null: the creator-less exemption above is the ONE guard (a null key must not also read as "no creator")
    for (const [c, list] of byCreator) {
      if (list.length <= bound) continue;
      if (list.length > worstCount || (list.length === worstCount && worst !== undefined && c < worst)) { worst = c; worstCount = list.length; }
    }
    if (worst === undefined) return removed;
    const tail = byCreator.get(worst)!.at(-1)!;
    // Remove EVERY row of that content from the page (it may sit in several modules).
    for (const mod of modules) for (const it of mod.items) if (`${it.sourceType}:${it.sourceId}` === tail.content) removed.add(it.id);
  }
}

// ── DV-23 (D-W10T-4, E-11): §10's five clauses on one module ─────────────────

export interface ModuleSaturationItem extends SaturationItem {
  /** A post's text, for §10's "content similarity"; null for other members. */
  text?: string | null;
}

/**
 * Posts whose text is at least this similar (token-set, `titleSimilarity`, the
 * same measure and threshold as `02` §5 CHECK 1's duplicate title) are one
 * content on a page. Short texts are too thin to call duplicates.
 */
export const TRAIL_NEAR_DUPLICATE_MIN_TOKENS = 3;

/** E-11 (D-W10T-5): one media type may hold at most this share of a module page while another type is waiting. */
export const TRAIL_MEDIA_SHARE_PER_PAGE = 1 / 2;

/**
 * `02` §10 on one module, in the module's own order:
 *
 *   cluster by place/content similarity  places via `placeId` (a post's venue is
 *                                        linked to the place member of the same
 *                                        venue by the caller); posts whose text is
 *                                        a near-duplicate of a post already on the
 *                                        page are held back (`near_duplicate`)
 *   diversify creators                   MAX_PER_CONTRIBUTOR_PER_PAGE, as before
 *   diversify media                      at most ceil(page × TRAIL_MEDIA_SHARE_PER_PAGE)
 *                                        of one media type while items of another
 *                                        type remain; WORK-CONSERVING: a page that
 *                                        would otherwise stay short is refilled
 *                                        from the media-held items, in order
 *   reduce repeated viewpoints           one item per (creator, place): the same
 *                                        person's second take on the same place
 *                                        is held back (`viewpoint_cap`)
 *   preserve "more from this place"      EVERY item the page holds back, for ANY
 *                                        reason (place cap, viewpoint, near-duplicate,
 *                                        creator cap, media) is counted AND listed
 *                                        under its place when it has one, and listed
 *                                        in `heldBackUnplaced` when it has none
 *                                        (D-W10T-15), so nothing held is unreachable;
 *                                        that includes every candidate the page
 *                                        had no room for (`beyond_page`, D-W10T-16)
 *
 * Nothing is deleted: every held item is returned with its reason.
 */
export function diversifyTrailModule<T extends ModuleSaturationItem>(
  items: readonly T[], opts: { pageSize: number },
): SaturationResult<T> & { heldBackByPlace: Record<string, string[]>; heldBackUnplaced: string[] } {
  const pageSize = Math.max(0, opts?.pageSize ?? 0);
  const mediaTypes = new Set(items.map((i) => i?.mediaType).filter((m): m is string => typeof m === "string" && m.length > 0));
  const maxMedia = mediaTypes.size >= 2 ? Math.max(1, Math.ceil(pageSize * TRAIL_MEDIA_SHARE_PER_PAGE)) : null;

  const page: T[] = [];
  const suppressed: Array<{ id: string; reason: SuppressionReason }> = [];
  const moreFromThisPlace: Record<string, number> = {};
  const heldBackByPlace: Record<string, string[]> = {};
  const heldBackUnplaced: string[] = [];
  const byContributor = new Map<string, number>();
  const byPlace = new Map<string, number>();
  const byMedia = new Map<string, number>();
  const viewpoints = new Set<string>();
  const texts: string[] = [];
  const mediaHeld: T[] = [];

  const holdForPlace = (item: T, reason: SuppressionReason) => {
    suppressed.push({ id: item.id, reason });
    const p = item.placeId;
    if (typeof p === "string" && p) {
      moreFromThisPlace[p] = (moreFromThisPlace[p] ?? 0) + 1;
      (heldBackByPlace[p] ??= []).push(item.id);
    } else {
      heldBackUnplaced.push(item.id);
    }
  };
  const nearDuplicate = (item: T): boolean => {
    const t = typeof item.text === "string" ? item.text : "";
    if (t.split(/\s+/).filter(Boolean).length < TRAIL_NEAR_DUPLICATE_MIN_TOKENS) return false;
    return texts.some((o) => titleSimilarity(o, t) >= DUPLICATE_TITLE_SIMILARITY);
  };
  const admit = (item: T) => {
    const c = item.contributorId, p = item.placeId, md = item.mediaType;
    if (typeof c === "string" && c) byContributor.set(c, (byContributor.get(c) ?? 0) + 1);
    if (typeof p === "string" && p) byPlace.set(p, (byPlace.get(p) ?? 0) + 1);
    if (typeof md === "string" && md) byMedia.set(md, (byMedia.get(md) ?? 0) + 1);
    if (typeof c === "string" && c && typeof p === "string" && p) viewpoints.add(`${c}|${p}`);
    if (typeof item.text === "string" && item.text) texts.push(item.text);
    page.push(item);
  };
  /** The caps that hold regardless of media; `null` = admissible. */
  const blocked = (item: T): SuppressionReason | null => {
    const c = item.contributorId, p = item.placeId;
    if (typeof c === "string" && c && (byContributor.get(c) ?? 0) >= MAX_PER_CONTRIBUTOR_PER_PAGE) return "contributor_cap";
    if (typeof c === "string" && c && typeof p === "string" && p && viewpoints.has(`${c}|${p}`)) return "viewpoint_cap";
    if (typeof p === "string" && p && (byPlace.get(p) ?? 0) >= MAX_PER_PLACE_PER_PAGE) return "place_cap";
    if (nearDuplicate(item)) return "near_duplicate";
    return null;
  };

  for (const item of items ?? []) {
    if (!item || typeof item.id !== "string") continue;
    if (page.length >= pageSize) { holdForPlace(item, "beyond_page"); continue; } // §86.14 (D-W10T-16): no route pages a module, so past the page is HELD — counted and listed, never dropped
    const why = blocked(item);
    if (why) { holdForPlace(item, why); continue; }
    const md = item.mediaType;
    if (maxMedia !== null && typeof md === "string" && md && (byMedia.get(md) ?? 0) >= maxMedia) { mediaHeld.push(item); continue; }
    admit(item);
  }
  // Work-conserving: media diversity reorders what fills the page, it never leaves it short.
  for (const item of mediaHeld) {
    if (page.length >= pageSize) { holdForPlace(item, "media_cap"); continue; }
    const why = blocked(item);
    if (why) { holdForPlace(item, why); continue; }
    admit(item);
  }
  return { page, suppressed, moreFromThisPlace, heldBackByPlace, heldBackUnplaced };
}

// ── DC-05 (D-W10T-7): health orders the Trail's own modules ──────────────────

/** contributor_concentration above this marks the Trail's dominant contributor for the health order. */
export const TRAIL_HEALTH_ORDER_CONCENTRATION = 1 / 3;

/**
 * The member rows §11's own predicates count AGAINST this Trail: a stale object
 * (`isTrailStaleObject`, the `stale_object_ratio` predicate) and, while
 * `contributor_concentration` exceeds TRAIL_HEALTH_ORDER_CONCENTRATION, the
 * members of the contributor(s) that concentration measures. Behind
 * discovery_trail_health_order_enabled (3485, FALSE) the modules serve these
 * AFTER the others, each partition in the module's own order. Never removed.
 */
export function healthDemotedRowIds(
  members: ReadonlyArray<{ id: string; contributor_id: string | null; content_state: string; created_at: string }>,
  health: TrailHealth, nowMs: number,
): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  for (const m of members) if (typeof m.contributor_id === "string" && m.contributor_id) counts.set(m.contributor_id, (counts.get(m.contributor_id) ?? 0) + 1);
  const max = Math.max(0, ...counts.values());
  const concentrated = (health.metrics.contributor_concentration ?? 0) > TRAIL_HEALTH_ORDER_CONCENTRATION;
  for (const m of members) {
    if (isTrailStaleObject(m, nowMs)) out.add(m.id);
    else if (concentrated && typeof m.contributor_id === "string" && counts.get(m.contributor_id) === max) out.add(m.id);
  }
  return out;
}

/** Stable partition: the ids not in `demoted` first, then the demoted ones, each in their given order. */
export function healthOrdered<T extends { id: string }>(items: readonly T[], demoted: ReadonlySet<string>): T[] {
  return [...items.filter((i) => !demoted.has(i.id)), ...items.filter((i) => demoted.has(i.id))];
}

