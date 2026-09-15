/**
 * MediaGemStateService — the §16 Hidden Gems LENS of the Media v2 World shell,
 * served by `GET /api/media/gems` (spec §43 · census-media MD360).
 *
 * ── WHY A SECOND GEM SURFACE EXISTS, AND WHY IT IS NOT A SECOND FEED ─────────
 * census-media MD360 recorded that the World shell's HIDDEN GEMS lens had no
 * endpoint and fell back to `GET /media/gems-feed` (`routes/mediaFeed.ts`), "a
 * ranked social feed, not a §16 gem-state projection". That fallback orders by
 * the discovery ranker in `HiddenGemDiscoveryService`, which weights SAVES and
 * VISITS. §16.2 forbids that in its own words — *"No popularity-first ranking"*
 * and *"Suppress aggressive recommendations if a small place is being
 * overloaded"* — so the lens was not merely missing a route, it was showing an
 * ordering the spec prohibits.
 *
 * This module therefore serves gem STATE, not gem popularity:
 *   • the §16 ten-state `HiddenGemState`, DERIVED at read time (never stored, so
 *     it cannot drift) by the pure `lib/hiddenGemState` policy layer;
 *   • a bounded evidence confidence from the same pure layer, in which
 *     `save_count` is accepted and deliberately ignored;
 *   • an ordering from `rankGems`, whose header is explicit that popularity is
 *     not an input and that an overcrowded gem is DEMOTED.
 *
 * ── DISCLOSURE ──────────────────────────────────────────────────────────────
 * A gem is NAMED only when `mayDiscloseGemIdentity` says so — the
 * `hidden_gems_public_read` RLS policy restated in code, plus the submitter's
 * own bypass. This is the identical predicate `MediaSearchService` uses, and for
 * the identical reason: naming a protected gem against a city de-anonymizes it
 * as surely as handing out its coordinates. Undisclosable gems are dropped
 * whole — not coarsened — so no id, name or place of theirs appears anywhere in
 * the payload.
 *
 * NO COORDINATE IS EVER READ. `hidden_gems` carries `latitude`/`longitude` and
 * `approx_latitude`/`approx_longitude`; the SELECT below names neither pair, so
 * the lens cannot disclose a point it never loaded — the same argument
 * `MediaProjectionService.disclosureForRow` makes for the media projection.
 * `sendProjection`'s boundary scrub stays the last line, not the first.
 *
 * ── REFUSAL VS EMPTINESS ────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error, so `const { data }` alone would make
 * an unreadable `hidden_gems` byte-identical to a city with no gems in it. Both
 * reads here bind `error`, and the projection carries `determined` plus a named
 * `undetermined` list so the CALLER can tell "there are no gems here" from "the
 * gem tables did not answer". A `logger.warn` would tell an operator; it would
 * not tell the caller, and the caller is who renders the sentence.
 *
 * The observation aggregates are held to the same rule, and the reason is not
 * symmetry. An unreadable `hidden_gem_verifications` only UNDERSTATES evidence
 * (a confirmed gem reads as `still_hidden` with low confidence), which is the
 * safe direction. An unreadable `hidden_gem_contributions` is NOT safe: the
 * `closed`, `access_changed` and `too_crowded` observations are exactly what
 * moves a gem to `temporarily_unavailable` / `access_changed` /
 * `overcrowding_risk`, so losing that read serves a gem the community has
 * reported CLOSED as though it were fine. That asymmetry is why determinedness
 * is reported rather than ruled harmless.
 *
 * ── THE SIGNALS ARE GATHERED HERE, DELIBERATELY ─────────────────────────────
 * `HiddenGemContributionService.batchDeriveGemProjections` computes the same two
 * values and is NOT used, which is a duplication and is recorded as one rather
 * than hidden: its aggregate reader logs a warning and returns an empty
 * aggregate on failure, so a caller cannot distinguish the two cases above, and
 * teaching it to would move line 186 of `HiddenGemContributionService.ts` — a line four
 * censuses cite by number (census-media MD130–MD138 among them) and which this
 * lane may not repoint in three of those documents. What is NOT duplicated is
 * the POLICY: `deriveHiddenGemState`, `deriveGemConfidence` and `rankGems` are
 * called from `lib/hiddenGemState` verbatim, which is the seam that module's own
 * header prescribes ("the service layer gathers the raw signals from Supabase
 * and hands them here; this module never gathers its own").
 *
 * KNOWN GAP, stated because a duplication nobody wrote down is how two surfaces
 * drift: the signal ASSEMBLY below (which rows count as a confirmation, how
 * `daysSinceLastConfirmation` is computed) is a second copy of
 * `HiddenGemContributionService.projectGem`'s assembly. If either changes, both
 * must. The right end state is one exported gatherer that reports
 * determinedness, and it belongs in the file that already has the reader.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger as rootLogger } from "../../lib/logger.js";
import { mayDiscloseGemIdentity } from "../hiddenGems/HiddenGemPrivacyGuard.js";
import {
  deriveHiddenGemState,
  deriveGemConfidence,
  rankGems,
  GEM_CONTRIBUTION_TYPES,
  POSITIVE_CONTRIBUTIONS,
  NEGATIVE_CONTRIBUTIONS,
  type GemContributionType,
  type HiddenGemState,
} from "../../lib/hiddenGemState.js";
import type { ViewerResolved } from "./MediaProjectionService.js";

const logger = rootLogger.child({ service: "MediaGemStateService" });

const MS_PER_DAY = 86_400_000;

/** Hard cap on gems considered for one lens request. */
export const MAX_GEM_LENS_ROWS = 60;

/**
 * The `hidden_gems` columns this lens reads. NO COORDINATE COLUMN APPEARS HERE
 * and none may be added: the World shell has never emitted coordinates and the
 * cheapest way to keep that true is not to load them.
 */
export const MEDIA_GEM_LENS_COLUMNS =
  "id, name, category, city, country, neighborhood, vibe_tags, " +
  "sensitivity_level, verification_level, status, submitted_by, " +
  "save_count, visit_count, crowd_level, canonical_place_id, image_url, updated_at";

export interface MediaGemStateItem {
  gemId: string;
  name: string | null;
  /** Opaque canonical place id — the client resolves geometry via the Map gateway. */
  placeId: string | null;
  category: string | null;
  /** Coarse labels only. No coordinates. */
  neighborhood: string | null;
  city: string | null;
  country: string | null;
  /** The §16 ten-state semantic state, derived at read time. */
  state: HiddenGemState;
  /** Bounded evidence score. `save_count` is not an input (§16.2). */
  confidence: { score: number; band: string };
  /** Per-type independent §16.3 observation counts. */
  contributionCounts: Partial<Record<GemContributionType, number>>;
  verificationLevel: string | null;
  lastUpdatedAt: string | null;
}

export interface MediaGemStateProjection {
  generatedAt: string;
  city: string | null;
  gems: MediaGemStateItem[];
  total: number;
  /**
   * False when ANY read behind this projection failed. `gems` is then not a
   * factual claim about the world — see `undetermined` for which read.
   */
  determined: boolean;
  /**
   * Named reads that could NOT be performed on this request. `"gems"` means the
   * gem list itself is unknown (and `gems` is empty for that reason, not the
   * factual one); `"gemState"` means the list is real but the per-gem state and
   * confidence were derived over an aggregate that could not be read.
   */
  undetermined: readonly string[];
}

export interface GemLensQuery {
  city?: string | null;
  limit?: number;
}

interface GemAggregate {
  approvedConfirmations: number;
  distinctConfirmers: Set<string>;
  lastConfirmationMs: number | null;
  totalVisits: number;
  suspiciousVisits: number;
  contributionCounts: Partial<Record<GemContributionType, number>>;
  positiveContributions: number;
  negativeContributions: number;
}

function emptyAggregate(): GemAggregate {
  return {
    approvedConfirmations: 0,
    distinctConfirmers: new Set<string>(),
    lastConfirmationMs: null,
    totalVisits: 0,
    suspiciousVisits: 0,
    contributionCounts: {},
    positiveContributions: 0,
    negativeContributions: 0,
  };
}

function emptyProjection(
  nowMs: number,
  city: string | null,
  determined: boolean,
  undetermined: string[],
): MediaGemStateProjection {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    city,
    gems: [],
    total: 0,
    determined,
    undetermined,
  };
}

/**
 * Read the gem rows this viewer may be SHOWN, for a coarse city.
 *
 * `status` is NOT filtered in the query on purpose: the submitter's own pending
 * gem is disclosable to them through `mayDiscloseGemIdentity`'s owner bypass, and
 * filtering in SQL would silently remove it before the predicate ran. The
 * predicate decides membership; the query only bounds the page.
 */
async function loadGemRows(
  sc: SupabaseClient,
  city: string | null,
  limit: number,
): Promise<{ rows: any[]; determined: boolean }> {
  try {
    let q = (sc as any).from("hidden_gems").select(MEDIA_GEM_LENS_COLUMNS);
    if (city) q = q.eq("city", city);
    const { data, error } = await q.limit(limit);
    if (error) {
      logger.warn(
        { code: (error as any)?.code ?? null, message: (error as any)?.message ?? null },
        "mediaGemLens: hidden_gems read failed — the lens reports undetermined rather than 'no gems'",
      );
      return { rows: [], determined: false };
    }
    if (!Array.isArray(data)) return { rows: [], determined: false };
    return { rows: data as any[], determined: true };
  } catch (err) {
    logger.warn({ err }, "mediaGemLens: hidden_gems read threw");
    return { rows: [], determined: false };
  }
}

/**
 * Gather the §16 observation aggregates for a page of gems in three batch reads.
 *
 * Every read binds `error`. `determined` is false when ANY of the three failed,
 * because the derived state is a function of all three and a state derived over
 * a missing read is not a weaker answer, it is a different one.
 */
async function loadGemAggregates(
  sc: SupabaseClient,
  gemIds: string[],
): Promise<{ aggregates: Map<string, GemAggregate>; determined: boolean }> {
  const out = new Map<string, GemAggregate>();
  for (const id of gemIds) out.set(id, emptyAggregate());
  if (gemIds.length === 0) return { aggregates: out, determined: true };

  let determined = true;
  const read = async (
    table: string,
    columns: string,
    tighten?: (q: any) => any,
  ): Promise<any[]> => {
    try {
      const base = (sc as any).from(table).select(columns).in("gem_id", gemIds);
      const { data, error } = await (tighten ? tighten(base) : base);
      if (error || !Array.isArray(data)) {
        determined = false;
        logger.warn(
          { table, code: (error as any)?.code ?? null },
          "mediaGemLens: gem observation read failed — the derived state is reported undetermined",
        );
        return [];
      }
      return data as any[];
    } catch (err) {
      determined = false;
      logger.warn({ table, err }, "mediaGemLens: gem observation read threw");
      return [];
    }
  };

  const [verifications, visits, contributions] = await Promise.all([
    read("hidden_gem_verifications", "gem_id, user_id, result, created_at", (q) =>
      q.eq("result", "approved"),
    ),
    read("hidden_gem_visits", "gem_id, is_suspicious"),
    read("hidden_gem_contributions", "gem_id, user_id, contribution_type, updated_at"),
  ]);

  for (const row of verifications) {
    const a = out.get(String(row?.gem_id));
    if (!a) continue;
    a.approvedConfirmations += 1;
    if (row.user_id) a.distinctConfirmers.add(String(row.user_id));
    const t = row.created_at ? Date.parse(row.created_at) : NaN;
    if (Number.isFinite(t)) a.lastConfirmationMs = Math.max(a.lastConfirmationMs ?? 0, t);
  }

  for (const row of visits) {
    const a = out.get(String(row?.gem_id));
    if (!a) continue;
    a.totalVisits += 1;
    if (row.is_suspicious) a.suspiciousVisits += 1;
  }

  for (const row of contributions) {
    const a = out.get(String(row?.gem_id));
    if (!a) continue;
    const type = row.contribution_type as GemContributionType;
    if (!(GEM_CONTRIBUTION_TYPES as readonly string[]).includes(type)) continue;
    a.contributionCounts[type] = (a.contributionCounts[type] ?? 0) + 1;
    if (POSITIVE_CONTRIBUTIONS.has(type)) {
      a.positiveContributions += 1;
      if (row.user_id) a.distinctConfirmers.add(String(row.user_id));
      const t = row.updated_at ? Date.parse(row.updated_at) : NaN;
      if (Number.isFinite(t)) a.lastConfirmationMs = Math.max(a.lastConfirmationMs ?? 0, t);
    } else if (NEGATIVE_CONTRIBUTIONS.has(type)) {
      a.negativeContributions += 1;
    }
  }

  return { aggregates: out, determined };
}

/**
 * Build the §16 Hidden Gems lens for one viewer.
 *
 * Empty data yields a well-formed EMPTY projection with `determined: true`; an
 * unreadable table yields the same shape with `determined: false` and the read
 * named in `undetermined`. The two are never the same value.
 */
export async function buildGemStateProjection(
  sc: SupabaseClient,
  viewer: ViewerResolved,
  query: GemLensQuery,
  nowMs: number,
): Promise<MediaGemStateProjection> {
  const city = query.city ?? null;
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? MAX_GEM_LENS_ROWS)), MAX_GEM_LENS_ROWS);

  const { rows, determined: gemsDetermined } = await loadGemRows(sc, city, limit);
  if (!gemsDetermined) return emptyProjection(nowMs, city, false, ["gems"]);

  // DISCLOSURE FIRST. Undisclosable gems are dropped before anything else is
  // read about them, so a protected gem does not even appear in the aggregate
  // query's `in(...)` list.
  const disclosable = rows.filter((g) => g?.id && mayDiscloseGemIdentity(g as any, viewer.viewerId));
  if (disclosable.length === 0) return emptyProjection(nowMs, city, true, []);

  const { aggregates, determined: stateDetermined } = await loadGemAggregates(
    sc,
    disclosable.map((g) => String(g.id)),
  );

  // §16.2 ordering: evidence, freshness, relevance, MINUS an overcrowding
  // demotion. `rankGems` reads neither save_count nor visit_count.
  const ranked = rankGems(disclosable as any[], { nowMs });

  const gems: MediaGemStateItem[] = ranked.map(({ gem }) => {
    const agg = aggregates.get(String(gem.id)) ?? emptyAggregate();
    const positiveConfirmations = agg.approvedConfirmations + agg.positiveContributions;
    const daysSinceLastConfirmation =
      agg.lastConfirmationMs != null ? Math.max(0, (nowMs - agg.lastConfirmationMs) / MS_PER_DAY) : null;

    const state = deriveHiddenGemState({
      status: (gem as any).status,
      crowdLevel: (gem as any).crowd_level,
      daysSinceLastConfirmation,
      confirmationCount: positiveConfirmations,
      saveCount: (gem as any).save_count,
      visitCount: (gem as any).visit_count,
      contributionCounts: agg.contributionCounts,
    });

    const confidence = deriveGemConfidence({
      verificationLevel: (gem as any).verification_level,
      approvedConfirmations: positiveConfirmations,
      distinctConfirmers: agg.distinctConfirmers.size,
      daysSinceLastConfirmation,
      suspiciousVisitRatio: agg.totalVisits > 0 ? agg.suspiciousVisits / agg.totalVisits : 0,
      positiveContributions: agg.positiveContributions,
      negativeContributions: agg.negativeContributions,
      hasCanonicalPlace: !!(gem as any).canonical_place_id,
      // The lens does not load coordinates, so it cannot claim the gem has any.
      // Understating evidence is the safe direction; inventing it is not.
      hasCoords: false,
      hasMedia: !!(gem as any).image_url,
      paidPromoted: false,
      saveCount: (gem as any).save_count,
    });

    return {
      gemId: String(gem.id),
      name: typeof (gem as any).name === "string" ? (gem as any).name : null,
      placeId:
        typeof (gem as any).canonical_place_id === "string" ? (gem as any).canonical_place_id : null,
      category: typeof (gem as any).category === "string" ? (gem as any).category : null,
      neighborhood: typeof (gem as any).neighborhood === "string" ? (gem as any).neighborhood : null,
      city: typeof (gem as any).city === "string" ? (gem as any).city : null,
      country: typeof (gem as any).country === "string" ? (gem as any).country : null,
      state,
      confidence: { score: confidence.confidence, band: confidence.band },
      contributionCounts: agg.contributionCounts,
      verificationLevel:
        typeof (gem as any).verification_level === "string" ? (gem as any).verification_level : null,
      lastUpdatedAt: typeof (gem as any).updated_at === "string" ? (gem as any).updated_at : null,
    };
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    city,
    gems,
    total: gems.length,
    determined: stateDetermined,
    undetermined: stateDetermined ? [] : ["gemState"],
  };
}
