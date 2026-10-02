/**
 * hiddenGemsMappers — pure row → DTO mappings for the hidden-gems service.
 *
 * Separate from hiddenGems.ts so these can be unit-tested: that module reaches
 * react-native transitively, and the node:test runner cannot transform it. Same
 * arrangement as privacySettingsLogic.ts next door.
 *
 * No network, no storage, no React.
 */
import type { GuideProfile } from './hiddenGems.ts';

/**
 * Normalise a `local_guide_profiles` row into the camelCase `GuideProfile` the
 * app renders.
 *
 * BOTH routes that return a guide send the RAW row — the server's
 * LocalGuideService.getGuideProfile does `select("*")` — so every reader has to
 * do this. It used to be inlined in `getGuideProfile` only, and `getGem` passed
 * the row straight through as a `GuideProfile`. `app/gems/[id].tsx` then called
 * `guideProfile.cityExpertise.join(', ')` on a row whose column is
 * `city_expertise`, and the whole gem detail screen threw — but only for a gem
 * with `guide_verified_by` set, which is why it survived so long.
 *
 * Accepts either casing: the snake_case row as it arrives, or an
 * already-normalised object, so normalising twice is harmless.
 */
export function normalizeGuideProfile(g: any): GuideProfile | null {
  if (!g) return null;
  return {
    userId:            g.user_id      ?? g.userId,
    guideLevel:        g.guide_level  ?? g.guideLevel  ?? 1,
    cityExpertise:     g.city_expertise ?? g.cityExpertise ?? [],
    // No `?? 0` here. A missing figure is unknown, not zero — and the `?? 0`
    // that used to sit here made app/gems/guide.tsx's `typeof … === 'number'`
    // check always true, quietly killing its own em-dash branch.
    contributionCount: g.contribution_count ?? g.contributionCount ?? null,
    helpfulVotes:      g.helpful_votes ?? g.helpfulVotes ?? null,
    accuracyScore:     g.accuracy_score ?? g.accuracyScore ?? null,
    status:            g.status,
    bio:               g.bio ?? null,
    verifiedAt:        g.verified_at ?? g.verifiedAt ?? null,
  };
}

// ── §16.1 OUTCOME (census-media §21) ─────────────────────────────────────────

/**
 * What verified visitors reported about the gem after they went — the server's
 * floored summary (HiddenGemOutcomeService). `determined: false` means there is
 * no number to show: too few reports to show any without pointing at a person,
 * or the reports could not be read. Never a zero standing in for either.
 */
export type GemVisitOutcomes =
  | {
      determined: true;
      verifiedVisitors: number;
      reportingVisitors: number;
      confirmed: number;
      degraded: number;
      noted: number;
      lastOutcomeDay: string | null;
    }
  | { determined: false; reason: 'below_threshold' | 'unreadable' };

export function normalizeGemVisitOutcomes(raw: unknown): GemVisitOutcomes | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.determined === false) {
    return { determined: false, reason: o.reason === 'unreadable' ? 'unreadable' : 'below_threshold' };
  }
  if (o.determined !== true) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const verifiedVisitors = n(o.verifiedVisitors);
  const reportingVisitors = n(o.reportingVisitors);
  const confirmed = n(o.confirmed);
  const degraded = n(o.degraded);
  const noted = n(o.noted);
  if (verifiedVisitors === null || reportingVisitors === null || confirmed === null || degraded === null || noted === null) return null;
  return {
    determined: true,
    verifiedVisitors,
    reportingVisitors,
    confirmed,
    degraded,
    noted,
    lastOutcomeDay: typeof o.lastOutcomeDay === 'string' ? o.lastOutcomeDay : null,
  };
}

/**
 * The one sentence the gem page shows, or null when there is nothing honest to
 * say. Calm, count-based, no popularity language (§46.1): it reports what
 * visitors found, not how many people like it.
 */
export function gemVisitOutcomeSentence(o: GemVisitOutcomes | null | undefined): string | null {
  if (!o || !o.determined || o.reportingVisitors === 0) return null;
  const parts: string[] = [];
  if (o.confirmed > 0) parts.push(`${o.confirmed} found it still worth it`);
  if (o.degraded > 0) parts.push(`${o.degraded} found it changed or gone`);
  if (parts.length === 0) parts.push(`${o.noted} shared an update`);
  return `Of ${o.reportingVisitors} verified visitors who reported back, ${parts.join(' and ')}.`;
}
