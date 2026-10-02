/**
 * discoveryRankDesigns — census-discovery §78 (lane W10-R2): the held scoring
 * designs, assembled for one ranking request, behind six flags seeded FALSE.
 *
 * ONE HOOK, TWO CALLS
 * ===================
 * lib/discoveryPde.ts `rankForViewer` is the one Discovery ranking pipeline
 * (ranker-hold-designs: "Everything plugs into … rankForViewer"). This lane does
 * not own that file, so the pipeline reaches these designs through exactly two
 * calls its owner adds (census-discovery §78.9, hunk H1):
 *
 *   const designs = await loadRankDesigns(sc, { viewerId, city, places, nowMs, intentMode });
 *   const d = applyRankDesigns(candidates, viewerContext, rankOpts, designs);
 *   const scored = rankCandidates(d.candidates, d.ctx, d.opts);
 *
 * With every flag off `loadRankDesigns` performs the six cached flag reads and
 * nothing else, and `applyRankDesigns` returns THE SAME candidate array, context
 * object and options object it was given — so the call is `rankCandidates` with
 * its original arguments, and the output is bit-identical
 * (src/test/discoveryRankDesigns.test.ts H0, over the portavaRank golden).
 *
 * WHAT EACH FLAG ASSEMBLES
 * ========================
 *   objectives  RankOptions.objective = the `discovery` surface objective
 *               (lib/discoveryRankObjectives), owner overrides from metadata.
 *   integrity   per-candidate likeCount / engagementIntegrity / authorTrustScore
 *               / authored (lib/discoveryRankIntegrity).
 *   families    ViewerContext.negativeFeedback (the viewer's own dismissals,
 *               per category of the candidate set) and explorationValue.
 *   intent      ViewerContext.intent (lib/discoveryRankIntent).
 *   tripMatch   ViewerContext.tripMatch (lib/discoveryRankTrip).
 *   diversity   DiversityOptions magnitudes from metadata, candidate.trailIds
 *               and candidate.servedCount (lib/discoveryRankDiversity).
 *
 * Every loader is non-fatal and independent. A loader that fails leaves ITS
 * input absent — today's behaviour for that design — and names itself in
 * `degraded`; it never zeroes or guesses a signal.
 *
 * VIEWER-DEPENDENT, NEVER CACHEABLE ACROSS VIEWERS. Every input here except the
 * integrity decoration is the viewer's own (dismissals, intent, trips, serve
 * history). That is why the hook sits inside `rankForViewer`, after Cache A's
 * user-independent candidates, and never on a candidate key (`06` §4).
 */
import type { RankCandidate, RankOptions, ViewerContext } from "./portavaRank.js";
import {
  loadRankDesignFlags, anyRankDesignEnabled, ALL_RANK_DESIGN_FLAGS_OFF, type RankDesignFlags,
} from "./discoveryRankFlags.js";
import { objectiveForSurface, parseObjectiveOverrides, type RankSurface } from "./discoveryRankObjectives.js";
import { loadEngagementIntegrity, type IntegrityDecoration } from "./discoveryRankIntegrity.js";
import { loadViewerIntent } from "./discoveryRankIntent.js";
import { loadTripMatch } from "./discoveryRankTrip.js";
import {
  parseDiversityMagnitudes, diversityOptionsFrom, loadTrailKeys, loadServeHistory,
} from "./discoveryRankDiversity.js";
import { loadDismissedPlaceIds } from "./discoveryDismissed.js";

export interface RankDesignPlace {
  id: string;
  category?: string | null;
  lat?: number | null;
  lng?: number | null;
  savedCount?: number | null;
}

export interface RankDesignInput {
  viewerId: string;
  city: string | null;
  places: readonly RankDesignPlace[];
  nowMs: number;
  /** The request's `?intentMode=`, raw. Parsed here; unknown ⇒ ignored. */
  intentMode?: unknown;
}

export type RankDesignName = "objectives" | "integrity" | "families" | "intent" | "tripMatch" | "diversity";

export interface RankDesigns {
  /** False ⇒ applyRankDesigns is the identity. */
  active: boolean;
  flags: RankDesignFlags;
  /** Fields merged onto the ViewerContext. */
  viewer: Partial<ViewerContext>;
  /** Per-candidate fields, keyed by candidate id. */
  candidates: Map<string, Partial<RankCandidate>>;
  /** Options merged onto the rankCandidates options (the caller's own keys win). */
  options: Partial<RankOptions>;
  /** Loaders that could not read, by design name. */
  degraded: RankDesignName[];
}

export const INERT_RANK_DESIGNS: RankDesigns = Object.freeze({
  active: false,
  flags: ALL_RANK_DESIGN_FLAGS_OFF,
  viewer: Object.freeze({}),
  candidates: new Map(),
  options: Object.freeze({}),
  degraded: [],
}) as RankDesigns;

/** The viewer's dismissals, counted per category over THIS candidate set. PURE. */
export function categoryDismissals(
  places: readonly RankDesignPlace[], dismissed: ReadonlySet<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of places) {
    if (!p.category || !dismissed.has(p.id)) continue;
    out[p.category] = (out[p.category] ?? 0) + 1;
  }
  return out;
}

function mergeCandidate(m: Map<string, Partial<RankCandidate>>, id: string, patch: Partial<RankCandidate>): void {
  m.set(id, { ...(m.get(id) ?? {}), ...patch });
}

/** Assemble every enabled design for one request. Never throws. */
export async function loadRankDesigns(sc: any, input: RankDesignInput): Promise<RankDesigns> {
  let flags: RankDesignFlags;
  try { flags = await loadRankDesignFlags(sc, input.nowMs); } catch { return INERT_RANK_DESIGNS; }
  if (!anyRankDesignEnabled(flags)) return { ...INERT_RANK_DESIGNS, flags };

  const viewer: Partial<ViewerContext> = {};
  const candidates = new Map<string, Partial<RankCandidate>>();
  const options: Partial<RankOptions> = {};
  const degraded: RankDesignName[] = [];
  const ids = input.places.map((p) => p.id);

  const [integrity, dismissed, intent, trip, trailKeys, history] = await Promise.all([
    flags.integrity.enabled ? loadEngagementIntegrity(sc, input.places) : null,
    flags.families.enabled ? loadDismissedPlaceIds(sc, input.viewerId) : null,
    flags.intent.enabled ? loadViewerIntent(sc, input.viewerId, input.intentMode, input.nowMs) : null,
    flags.tripMatch.enabled ? loadTripMatch(sc, input.viewerId, input.places, input.city, input.nowMs) : null,
    flags.diversity.enabled ? loadTrailKeys(sc, ids) : null,
    flags.diversity.enabled
      ? loadServeHistory(sc, input.viewerId, parseDiversityMagnitudes(flags.diversity.metadata).historyWindowDays, input.nowMs)
      : null,
  ]);

  if (flags.objectives.enabled) {
    const overrides = parseObjectiveOverrides(flags.objectives.metadata);
    options.objective = objectiveForSurface("discovery", overrides.discovery ?? null);
  }

  if (integrity) {
    if (integrity.degraded || !integrity.decorations) { if (integrity.degraded) degraded.push("integrity"); }
    else for (const [id, d] of integrity.decorations) mergeCandidate(candidates, id, d as IntegrityDecoration);
  }

  if (dismissed) {
    // A degraded dismissal read under-counts; the term then under-penalises,
    // which is the safe direction for a penalty. It is still reported.
    if (dismissed.degraded) degraded.push("families");
    viewer.negativeFeedback = { categoryDismissals: categoryDismissals(input.places, dismissed.ids) };
    viewer.explorationValue = true;
  }

  if (intent?.intent) viewer.intent = intent.intent;

  if (trip) {
    if (trip.degraded) degraded.push("tripMatch");
    if (trip.tripMatch) viewer.tripMatch = trip.tripMatch;
  }

  if (flags.diversity.enabled) {
    options.diversity = diversityOptionsFrom(parseDiversityMagnitudes(flags.diversity.metadata));
    if (trailKeys?.degraded || history?.degraded) degraded.push("diversity");
    for (const [id, t] of trailKeys?.trailIds ?? []) mergeCandidate(candidates, id, { trailIds: t });
    for (const [id, n] of history?.servedCount ?? []) if (ids.includes(id)) mergeCandidate(candidates, id, { servedCount: n });
  }

  return { active: true, flags, viewer, candidates, options, degraded };
}

/**
 * Put the designs onto one ranking call. Inactive ⇒ the SAME three objects.
 *
 * Candidates are copied (never mutated), so a candidate set a caller shares —
 * Cache A's — is never decorated in place. The caller's own `diversity` keys
 * and `exploration` choice win over the designs'.
 */
export function applyRankDesigns<T extends RankCandidate>(
  candidates: T[], ctx: ViewerContext, opts: RankOptions, d: RankDesigns,
): { candidates: T[]; ctx: ViewerContext; opts: RankOptions } {
  if (!d.active) return { candidates, ctx, opts };
  const decorated = d.candidates.size === 0 ? candidates
    : candidates.map((c) => { const p = d.candidates.get(c.id); return p ? { ...c, ...p } : c; });
  const mergedCtx: ViewerContext = Object.keys(d.viewer).length === 0 ? ctx : { ...ctx, ...d.viewer };
  const mergedOpts: RankOptions = { ...d.options, ...opts };
  if (d.options.diversity && opts.diversity !== false) {
    mergedOpts.diversity = { ...d.options.diversity, ...(opts.diversity || {}) };
  }
  return { candidates: decorated, ctx: mergedCtx, opts: mergedOpts };
}

/**
 * DV-09 for the OTHER four surfaces: the options a surface's own
 * `rankCandidates` call spreads in. Flag off / unreadable ⇒ `{}`, so
 * `{ ...existing, ...(await surfaceObjectiveOptions(sc, "pulse")) }` is the
 * caller's own options, key for key. Pulse's call site is routes/pulse.ts
 * (census-discovery §78.9 hunk H3); Trail, Trip Planning and Trending have no
 * portavaRank call to spread into yet (§78.4).
 */
export async function surfaceObjectiveOptions(sc: any, surface: RankSurface): Promise<Pick<RankOptions, "objective">> {
  try {
    const flags = await loadRankDesignFlags(sc);
    if (!flags.objectives.enabled) return {};
    const overrides = parseObjectiveOverrides(flags.objectives.metadata);
    return { objective: objectiveForSurface(surface, overrides[surface] ?? null) };
  } catch {
    return {};
  }
}
