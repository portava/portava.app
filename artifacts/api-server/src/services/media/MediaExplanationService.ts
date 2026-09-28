/**
 * MediaExplanationService — §47 "Why This?" for the World items
 * `GET /media/world` serves, built from the §24 ranker terms that actually
 * ranked them (census-media §25, MD428).
 *
 * §47 names five reasons: "Nightlife matches your current intent", "7 minutes
 * away", "Fresh perspectives from the last 10 minutes", "Area activity is
 * increasing", "You've saved nearby places". Each is bound below to the ONE
 * ranker term that implements it (`SECTION_47_REASONS`). Nothing else may
 * appear in an explanation: not follow graph, trip context, quality,
 * provenance, utility or any other §24 term, however much it contributed,
 * because §47 does not name it.
 *
 * ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────────────
 * From the ranker, never recomputed here. `rankCandidatesForViewer(..., scoresOut)`
 * hands back the `MediaRankingScore` each row was ORDERED by, and this module
 * reads only that object. An explanation therefore cannot say something the
 * ranking did not use: a reason whose term the ranker never scored has no
 * number to read.
 *
 * ── "MATERIALLY CONTRIBUTED", DEFINED ────────────────────────────────────────
 * A reason's LIFT is what its term added to the item's score over what the
 * ranker gives an item it knows nothing about (`neutralRankingScore`: no
 * signals, no place, no parseable time — rule 1 of lib/mediaRankingSignals,
 * "absence is neutral"):
 *
 *     lift = w_term × (t_term − t_neutral)   [ − w_penalty × (p − p_neutral) ]
 *
 * The bracket applies to area activity only: the live term and the "−
 * Low-confidence Live Claims" penalty read the SAME claims, so a live claim
 * the ranker penalised as conflicted is not a reason to show it.
 *
 * A reason is MATERIAL when its lift is at least MATERIAL_LIFT — a quarter of
 * the largest single weight in MEDIA_RANKING_WEIGHTS (0.12 / 4 = 0.03, i.e.
 * three per cent of the best possible score). What that admits, term by term,
 * with today's weights:
 *   intent     wanted item (0.12), wanted place (0.096), wanted category (0.06) — all
 *   location   a trip active today in the media's city (0.04) — yes;
 *              the viewer's home country (0.012) — NO
 *   freshness  0.07 × (e^(−age/7d) − 0.5) ≥ 0.03 ⇔ posted within ~12.4 hours;
 *              a day-old post (0.026) — NO
 *   live       a live-qualified claim (0.06) — yes; the same claim materially
 *              conflicted (0.06 − 0.08 < 0) — NO
 *   discovery  a place the viewer saved (0.04) — yes
 * Reasons are listed strongest lift first; exact ties keep §47's order.
 *
 * ── WHAT IS SAID, AND WHAT §47'S EXAMPLE SAYS THAT THIS DOES NOT ─────────────
 * Each sentence states what the term measured, at the granularity it measured:
 *   distance   "In Da Nang, where you're travelling now". The ranker never
 *              reads the viewer's GPS (locationTerm), so it has no minutes to
 *              report; "7 minutes away" would be a distance nothing computed.
 *   activity   "Live reports of what's happening here right now". The live
 *              term reads the PRESENCE of a live-qualified claim, not a trend,
 *              so "is increasing" would be a direction nothing ranked on.
 *   saves      "You saved this place". discoveryTerm fires for media AT a
 *              saved place, not near one.
 *   freshness  "A fresh perspective, posted in the last 10 minutes". The term
 *              reads the POST's age (created_at), so the sentence says posted.
 *
 * ── PRIVACY: NOTHING THE VIEWER COULD NOT OTHERWISE SEE ──────────────────────
 * An explanation is built only from (a) the viewer's OWN signals — their
 * wants, their trips, their saves — and (b) properties of perspectives already
 * disclosed to this viewer AT this place:
 *   • Only a zone keyed by a canonical place is explained, and only from items
 *     whose served projection names that same place. A perspective whose owner
 *     or a hosting Hidden Gem withheld the place is not in a place zone, and
 *     contributes nothing.
 *   • Every item first passes the directional circle-override filter the
 *     route applies to the payload (lib/mediaVisibility). That filter cannot
 *     see inside a zone, so it is applied here, to the items, before any of
 *     them can speak; if it cannot decide, NO zone is explained.
 *   • A reason whose basis the projection withholds is dropped: the city
 *     sentence needs the served city, the category sentence the served
 *     category, the activity sentence the zone's own served live claims.
 *   • No sentence names, counts or implies another person. Other people's
 *     follows, saves, visits or crews are not §47 reasons and are never read
 *     here, and no number of perspectives or people is emitted — so the
 *     OUTCOME_MIN_REPORTERS k-floor lane C applies to gem outcomes has no
 *     aggregate to floor. A later reason that emits one must apply it.
 *
 * ── NO REASON, NO EXPLANATION ────────────────────────────────────────────────
 * A zone with no material, disclosable reason carries no `whyThis` at all,
 * and the client offers no "Why this?" for it (MediaWorldShell). There is no
 * fallback sentence: a generic reason is an invented one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaCandidateRow, MediaProjection } from "../../lib/media/mediaProjection.js";
import { filterMediaProjectionVisibility } from "../../lib/mediaVisibility.js";
import { logger } from "../../lib/logger.js";
import {
  MEDIA_RANKING_WEIGHTS,
  scoreMediaCandidate,
  type MediaRankingScore,
  type MediaRankingWeightKey,
} from "./MediaRankingService.js";

export type Section47Reason =
  | "intent_match"
  | "distance"
  | "fresh_perspective"
  | "area_activity"
  | "prior_saves";

export interface Section47ReasonTerm {
  reason: Section47Reason;
  /** §47's own example bullet, verbatim from the spec. */
  spec: string;
  /** The §24 input this reason is, spelled as SPEC_24_COVERAGE spells it. */
  input24: string;
  /** The ranker term whose weighted value is this reason. */
  plus: MediaRankingWeightKey;
  /** A ranker penalty read from the same evidence, subtracted from the lift. */
  minus?: MediaRankingWeightKey;
}

/** §47's five reasons, in §47's order, each bound to the ranker term that implements it. */
export const SECTION_47_REASONS: readonly Section47ReasonTerm[] = [
  { reason: "intent_match", spec: "Nightlife matches your current intent", input24: "Viewer intent", plus: "intent" },
  { reason: "distance", spec: "7 minutes away", input24: "Current location", plus: "location" },
  { reason: "fresh_perspective", spec: "Fresh perspectives from the last 10 minutes", input24: "Freshness", plus: "freshness" },
  { reason: "area_activity", spec: "Area activity is increasing", input24: "Live state", plus: "live", minus: "lowConfidenceLive" },
  { reason: "prior_saves", spec: "You've saved nearby places", input24: "Discovery behavior", plus: "discovery" },
];

/** A quarter of the largest single positive weight: 0.12 / 4 = 0.03 today. */
export const MATERIAL_LIFT =
  Math.max(
    ...(Object.entries(MEDIA_RANKING_WEIGHTS) as Array<[MediaRankingWeightKey, number]>)
      .filter(([k]) => k !== "lowConfidenceLive")
      .map(([, w]) => w),
  ) / 4;

let neutral: MediaRankingScore | null = null;

/** What the ranker scores an item it knows nothing about: no signals, no place, no parseable time. */
export function neutralRankingScore(): MediaRankingScore {
  neutral ??= scoreMediaCandidate({ id: "" }, { nowMs: 0 });
  return neutral;
}

/** How much this reason's term(s) lifted the score above the neutral item. */
export function reasonLift(score: MediaRankingScore, r: Section47ReasonTerm): number {
  const n = neutralRankingScore();
  let lift = MEDIA_RANKING_WEIGHTS[r.plus] * (score[r.plus] - n[r.plus]);
  if (r.minus) lift -= MEDIA_RANKING_WEIGHTS[r.minus] * (score[r.minus] - n[r.minus]);
  return lift;
}

export interface MaterialReason {
  reason: Section47Reason;
  lift: number;
}

/** The §47 reasons whose ranker terms MATERIALLY lifted this score, strongest first. */
export function materialReasons(score: MediaRankingScore): MaterialReason[] {
  const out: MaterialReason[] = [];
  for (const r of SECTION_47_REASONS) {
    const lift = reasonLift(score, r);
    if (lift >= MATERIAL_LIFT) out.push({ reason: r.reason, lift });
  }
  // Array.prototype.sort is stable: exact ties keep §47's order.
  return out.sort((a, b) => b.lift - a.lift);
}

/** One ranked item: the row the ranker scored, its score, and what the viewer is served for it. */
export interface ExplainableItem {
  row: MediaCandidateRow;
  score: MediaRankingScore;
  projection: MediaProjection;
}

/** The zone fields an explanation may read — all of them already served on the zone. */
export interface ExplainableZone {
  placeId: string | null;
  label: string;
  liveClaims: readonly unknown[];
}

export interface ZoneExplanation {
  whyThis: string;
  whyThisReasons: Section47Reason[];
}

function norm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function capitalise(s: string): string {
  const t = s.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const MINUTE_MS = 60_000;

/** The window a post's age falls in, in words: 10 / 30 minutes, an hour, then whole hours. */
export function postedWindow(ageMs: number): string {
  const minutes = Math.max(0, ageMs) / MINUTE_MS;
  if (minutes <= 10) return "the last 10 minutes";
  if (minutes <= 30) return "the last 30 minutes";
  if (minutes <= 60) return "the last hour";
  return `the last ${Math.ceil(minutes / 60)} hours`;
}

/**
 * The sentence for one material reason on one item, or null when the basis of
 * that reason is not disclosed to this viewer on this item — in which case the
 * reason is dropped, never softened into a vaguer sentence.
 */
function reasonSentence(reason: Section47Reason, item: ExplainableItem, zone: ExplainableZone, nowMs: number): string | null {
  const { row, score, projection } = item;
  switch (reason) {
    case "intent_match": {
      // intentTerm: the wanted item 1.0, a wanted place 0.8, a wanted category 0.5.
      if (score.intent >= 1) return "You marked a perspective here as one you want";
      if (score.intent >= 0.8) return `You want to go to ${zone.label}`;
      const cat = norm(projection.category);
      if (!cat || cat !== norm(row.category)) return null;
      return `${capitalise(projection.category as string)} matches what you want`;
    }
    case "distance": {
      const city = typeof projection.city === "string" ? projection.city.trim() : "";
      if (!city || norm(city) !== norm(row.location_city)) return null;
      return `In ${city}, where you're travelling now`;
    }
    case "fresh_perspective": {
      const t = Date.parse(String(row.created_at ?? ""));
      if (!Number.isFinite(t)) return null;
      return `A fresh perspective, posted in ${postedWindow(nowMs - t)}`;
    }
    case "area_activity":
      return zone.liveClaims.length > 0 ? "Live reports of what's happening here right now" : null;
    case "prior_saves":
      return "You saved this place";
  }
}

/**
 * §47 for one World zone: the material reasons of the perspectives disclosed
 * at its canonical place, each said once (from the item it lifted most),
 * strongest first. Null when nothing qualifies — the zone then carries no
 * explanation at all.
 */
export function explainWorldZone(zone: ExplainableZone, items: readonly ExplainableItem[], nowMs: number): ZoneExplanation | null {
  if (!zone.placeId) return null;
  const best = new Map<Section47Reason, { lift: number; text: string }>();
  for (const item of items) {
    if (item.projection.placeId !== zone.placeId || item.row.canonical_place_id !== zone.placeId) continue;
    for (const m of materialReasons(item.score)) {
      const text = reasonSentence(m.reason, item, zone, nowMs);
      if (text === null) continue;
      const prev = best.get(m.reason);
      if (!prev || m.lift > prev.lift) best.set(m.reason, { lift: m.lift, text });
    }
  }
  if (best.size === 0) return null;
  const ordered = SECTION_47_REASONS.map((r) => r.reason)
    .filter((r) => best.has(r))
    .sort((a, b) => best.get(b)!.lift - best.get(a)!.lift);
  return {
    whyThis: ordered.map((r) => `• ${best.get(r)!.text}`).join("\n"),
    whyThisReasons: ordered,
  };
}

/**
 * Attach §47 explanations to the World zones in place. `zoneItems[i]` are the
 * projected perspectives grouped into `zones[i]`; `rankedRows` and `scores`
 * are the rows the ranker scored and the scores it ordered them by.
 */
export async function explainWorldZones(
  sc: SupabaseClient,
  viewerId: string,
  zones: Array<ExplainableZone & Partial<ZoneExplanation>>,
  zoneItems: ReadonlyArray<readonly MediaProjection[]>,
  rankedRows: readonly MediaCandidateRow[],
  scores: ReadonlyMap<string, MediaRankingScore>,
  nowMs: number,
): Promise<void> {
  const all = zoneItems.flat();
  if (all.length === 0) return;
  let visible: MediaProjection[] | null = null;
  try {
    visible = (await filterMediaProjectionVisibility(sc, viewerId, all)) as MediaProjection[] | null;
  } catch {
    visible = null;
  }
  if (!Array.isArray(visible)) {
    logger.warn({ zones: zones.length }, "media world: visibility undecidable — no §47 explanation served");
    return;
  }
  const visibleIds = new Set(visible.map((m) => m.id));
  const rowsById = new Map(rankedRows.map((r) => [String(r.id), r] as const));
  zones.forEach((zone, i) => {
    const items: ExplainableItem[] = [];
    for (const projection of zoneItems[i] ?? []) {
      if (!visibleIds.has(projection.id)) continue;
      const row = rowsById.get(projection.id);
      const score = scores.get(projection.id);
      if (row && score) items.push({ row, score, projection });
    }
    const e = explainWorldZone(zone, items, nowMs);
    if (e) {
      zone.whyThis = e.whyThis;
      zone.whyThisReasons = e.whyThisReasons;
    }
  });
}
