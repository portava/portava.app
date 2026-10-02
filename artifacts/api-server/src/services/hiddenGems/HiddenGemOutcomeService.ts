/**
 * HiddenGemOutcomeService — the §16.1 OUTCOME stage (census-media §21, MD120).
 *
 * §16.1's pipeline runs … → VISIT → OUTCOME → MEMORY / PASSPORT. The VISIT
 * stage is recorded (`hidden_gem_visits`, written by the GPS check-in), and so
 * are the visitor's §16.3 observations (`hidden_gem_contributions`). Nothing
 * linked the two: a contribution did not say whether its author had just been
 * there, and a visit said nothing about how it went. This module is that link,
 * as a DERIVED read model over the two tables that already exist — no new
 * table, no stored copy that could drift.
 *
 * The link. A VERIFIED visit (not `is_suspicious`) is joined to what the SAME
 * visitor reported about the SAME gem within OUTCOME_WINDOW_MS after it. The
 * report's class follows lib/hiddenGemState's own polarity sets, so the
 * outcome and the gem state can never disagree about what "still worth it"
 * means:
 *   confirmed — POSITIVE_CONTRIBUTIONS (still here / still worth it)
 *   degraded  — NEGATIVE_CONTRIBUTIONS (closed / no longer hidden / access changed)
 *   noted     — every other observation (crowded, seasonal, harder to reach, …)
 *
 * Privacy (§16.2, §29). Visiting a hidden gem is a location fact about a
 * person. The summary is counts only, of DISTINCT visitors, and it is withheld
 * entirely — not even the visitor count — until OUTCOME_MIN_REPORTERS distinct
 * visitors have reported back, so no number on the page is one person's visit.
 * Day precision only for the last outcome. No user id, no coordinate, no
 * per-visit row ever leaves this module.
 *
 * Honest absence. An unreadable table is `{ determined: false, reason:
 * "unreadable" }`, never a zero: "nobody reported back" and "we could not
 * read the reports" are different answers.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  POSITIVE_CONTRIBUTIONS,
  NEGATIVE_CONTRIBUTIONS,
  isGemContributionType,
  type GemContributionType,
} from "../../lib/hiddenGemState.js";

/** A report counts as the outcome of a visit when it lands within this long after it. */
export const OUTCOME_WINDOW_MS = 72 * 60 * 60 * 1000;
/** Distinct reporting visitors before ANY outcome number is shown (k-anonymity floor). */
export const OUTCOME_MIN_REPORTERS = 3;
/** Visits older than this are not read — the outcome describes the gem as it is now. */
export const OUTCOME_LOOKBACK_DAYS = 365;
/** Bounded reads: a gem with more rows than this is summarised over the most recent. */
export const OUTCOME_MAX_ROWS = 2000;

export type GemVisitOutcomeClass = "confirmed" | "degraded" | "noted";

export function outcomeClassOf(type: GemContributionType): GemVisitOutcomeClass {
  if (POSITIVE_CONTRIBUTIONS.has(type)) return "confirmed";
  if (NEGATIVE_CONTRIBUTIONS.has(type)) return "degraded";
  return "noted";
}

export interface GemVisitRow {
  user_id: string;
  visited_at: string;
  is_suspicious: boolean | null;
}

export interface GemContributionRow {
  user_id: string;
  contribution_type: string;
  updated_at: string;
}

/** One visitor's outcome: the classes they reported after a verified visit. */
export interface VisitorOutcome {
  classes: Set<GemVisitOutcomeClass>;
  /** ms of the latest linked report. */
  lastReportMs: number;
}

/**
 * Pure: link each VERIFIED visit to the same visitor's reports within the
 * window after it. Returns one entry per distinct visitor who reported back,
 * plus the distinct count of verified visitors. A suspicious visit links
 * nothing; a report before the visit, after the window, or by someone else
 * links nothing.
 */
export function linkVisitOutcomes(
  visits: readonly GemVisitRow[],
  contributions: readonly GemContributionRow[],
  windowMs: number = OUTCOME_WINDOW_MS,
): { verifiedVisitors: number; outcomes: Map<string, VisitorOutcome> } {
  const visitsByUser = new Map<string, number[]>();
  for (const v of visits) {
    if (v.is_suspicious !== false) continue; // null / true → not a verified visit
    const t = Date.parse(v.visited_at);
    if (!v.user_id || !Number.isFinite(t)) continue;
    const arr = visitsByUser.get(v.user_id) ?? [];
    arr.push(t);
    visitsByUser.set(v.user_id, arr);
  }

  const outcomes = new Map<string, VisitorOutcome>();
  for (const c of contributions) {
    if (!isGemContributionType(c.contribution_type)) continue;
    const visitTimes = visitsByUser.get(c.user_id);
    if (!visitTimes) continue;
    const t = Date.parse(c.updated_at);
    if (!Number.isFinite(t)) continue;
    const linked = visitTimes.some((vt) => t >= vt && t - vt <= windowMs);
    if (!linked) continue;
    const cur = outcomes.get(c.user_id) ?? { classes: new Set<GemVisitOutcomeClass>(), lastReportMs: 0 };
    cur.classes.add(outcomeClassOf(c.contribution_type));
    cur.lastReportMs = Math.max(cur.lastReportMs, t);
    outcomes.set(c.user_id, cur);
  }
  return { verifiedVisitors: visitsByUser.size, outcomes };
}

export type GemOutcomeSummary =
  | {
      determined: true;
      /** Distinct visitors with a verified visit in the lookback. */
      verifiedVisitors: number;
      /** Of those, distinct visitors who reported back within the window. */
      reportingVisitors: number;
      /** Distinct reporting visitors per class (a visitor may report more than one class). */
      confirmed: number;
      degraded: number;
      noted: number;
      /** YYYY-MM-DD of the most recent linked report — day precision only. */
      lastOutcomeDay: string | null;
      windowHours: number;
    }
  | { determined: false; reason: "below_threshold" | "unreadable" };

/** Pure: the privacy-floored summary of linked outcomes. */
export function summarizeGemOutcomes(
  linked: { verifiedVisitors: number; outcomes: Map<string, VisitorOutcome> },
  minReporters: number = OUTCOME_MIN_REPORTERS,
): GemOutcomeSummary {
  const reporting = [...linked.outcomes.values()];
  if (reporting.length < minReporters) return { determined: false, reason: "below_threshold" };
  const count = (k: GemVisitOutcomeClass) => reporting.filter((o) => o.classes.has(k)).length;
  const last = Math.max(...reporting.map((o) => o.lastReportMs));
  return {
    determined: true,
    verifiedVisitors: linked.verifiedVisitors,
    reportingVisitors: reporting.length,
    confirmed: count("confirmed"),
    degraded: count("degraded"),
    noted: count("noted"),
    lastOutcomeDay: Number.isFinite(last) && last > 0 ? new Date(last).toISOString().slice(0, 10) : null,
    windowHours: Math.round(OUTCOME_WINDOW_MS / 3_600_000),
  };
}

/**
 * Read + link + summarise the outcomes of verified visits to one gem. The
 * caller has already decided the viewer may see the gem (the gem detail
 * route's own gate); this adds nothing a viewer could not already see except
 * floored counts. Never throws.
 */
export async function readGemOutcomeSummary(
  sc: SupabaseClient,
  gemId: string,
  nowMs: number = Date.now(),
): Promise<GemOutcomeSummary> {
  try {
    const since = new Date(nowMs - OUTCOME_LOOKBACK_DAYS * 86_400_000).toISOString();
    const [visRes, conRes] = await Promise.all([
      (sc as any)
        .from("hidden_gem_visits")
        .select("user_id, visited_at, is_suspicious")
        .eq("gem_id", gemId)
        .eq("is_suspicious", false)
        .gte("visited_at", since)
        .order("visited_at", { ascending: false })
        .limit(OUTCOME_MAX_ROWS),
      (sc as any)
        .from("hidden_gem_contributions")
        .select("user_id, contribution_type, updated_at")
        .eq("gem_id", gemId)
        .gte("updated_at", since)
        .order("updated_at", { ascending: false })
        .limit(OUTCOME_MAX_ROWS),
    ]);
    if (visRes.error || conRes.error) return { determined: false, reason: "unreadable" };
    return summarizeGemOutcomes(
      linkVisitOutcomes((visRes.data ?? []) as GemVisitRow[], (conRes.data ?? []) as GemContributionRow[]),
    );
  } catch {
    return { determined: false, reason: "unreadable" };
  }
}
