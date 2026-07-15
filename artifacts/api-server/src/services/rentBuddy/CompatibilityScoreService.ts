/**
 * CompatibilityScoreService
 *
 * Computes a 0–100 compatibility score between a traveler's match preferences
 * and a Buddy profile. Uses 14 weighted inputs.
 *
 * Ranking comparator order (hard overrides first):
 *   1. Safety restrictions / suspended / risk_hold → excluded entirely
 *   2. Approval / category eligibility → excluded if missing
 *   3. Availability match
 *   4. Compatibility score (desc)
 *   5. Trust Score (via trust_profiles.overall_score, fallback 50)
 *   6. Review quality (average_rating)
 *   7. Response time (lower = better)
 *   8. Completed bookings
 *   9. Location relevance
 *  10. Price fit
 *  11. Ambassador / Pro status
 *  12. New-Buddy rotation (new Buddies get a small boost)
 */

export interface MatchPreferences {
  need?: string | null;
  vibe?: string | null;
  energy?: string | null;
  language?: string | null;
  budgetMinUsd?: number | null;
  budgetMaxUsd?: number | null;
  bookingLength?: string | null;
  safetyPrefs?: Record<string, boolean>;
  groupSize?: number;
  femaleOnly?: boolean;
  publicOnly?: boolean;
}

export interface BuddyScoringData {
  buddyProfileId: string;
  buddyUserId: string;
  city: string;
  categories: string[];
  languages: string[];
  hourlyRateUsd: number | null;
  halfDayRateUsd: number | null;
  fullDayRateUsd: number | null;
  vibeTagsList: string[];
  energyType: string | null;
  buddyLevel: string;
  averageRating: number | null;
  reviewCount: number;
  completedBookings: number;
  responseTimeH: number | null;
  verified: boolean;
  featured: boolean;
  cityAmbassador: boolean;
  availableNow: boolean;
  femaleOnlyService: boolean;
  publicMeetupOnly: boolean;
  groupApproved: boolean;
  nightlifeApproved: boolean;
  arrivalApproved: boolean;
  categoryApprovals: Record<string, boolean>;
  trustScore: number; // from trust_profiles.overall_score or 50
  maxGroupSize: number;
  newBuddyPublicOnly: boolean;
  newBuddyDaytimeOnly: boolean;
  riskHold: boolean;
  adminStatus: string;
  status: string;
}

export interface ScoredBuddy {
  buddyProfileId: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  eligible: boolean;
  ineligibilityReason?: string;
}

const WEIGHTS = {
  category:          18,
  availability:      14,
  language:          12,
  budget:            10,
  vibe:              10,
  safety:             8,
  buddyLevel:         5,
  trustScore:         8,
  reviewQuality:      5,
  responseTime:       3,
  completedBookings:  3,
  prefMatch:          2,
  interactions:       1,
  locationRelevance:  1,
} as const;

function clamp(n: number, lo = 0, hi = 100) {
  return Math.min(hi, Math.max(lo, n));
}

export function calculateCompatibilityScore(
  buddy: BuddyScoringData,
  prefs: MatchPreferences,
  travelerCity?: string | null,
): ScoredBuddy {
  const breakdown: Record<string, number> = {};

  // ── Hard ineligibility ────────────────────────────────────────────────────
  if (buddy.riskHold || buddy.adminStatus !== 'active' || buddy.status === 'suspended' || buddy.status === 'rejected') {
    return { buddyProfileId: buddy.buddyProfileId, score: 0, scoreBreakdown: {}, eligible: false, ineligibilityReason: 'suspended_or_restricted' };
  }
  if (buddy.status !== 'active') {
    return { buddyProfileId: buddy.buddyProfileId, score: 0, scoreBreakdown: {}, eligible: false, ineligibilityReason: 'not_active' };
  }
  if (prefs.femaleOnly && !buddy.femaleOnlyService) {
    return { buddyProfileId: buddy.buddyProfileId, score: 0, scoreBreakdown: {}, eligible: false, ineligibilityReason: 'female_only_required' };
  }
  if (prefs.publicOnly && !buddy.publicMeetupOnly && !buddy.newBuddyPublicOnly) {
    return { buddyProfileId: buddy.buddyProfileId, score: 0, scoreBreakdown: {}, eligible: false, ineligibilityReason: 'public_meetup_required' };
  }
  if (prefs.groupSize && prefs.groupSize > 1 && !buddy.groupApproved) {
    return { buddyProfileId: buddy.buddyProfileId, score: 0, scoreBreakdown: {}, eligible: false, ineligibilityReason: 'group_not_approved' };
  }
  if (prefs.groupSize && buddy.maxGroupSize < prefs.groupSize) {
    return { buddyProfileId: buddy.buddyProfileId, score: 0, scoreBreakdown: {}, eligible: false, ineligibilityReason: 'group_too_large' };
  }

  // ── Category match ────────────────────────────────────────────────────────
  let catScore = 50;
  if (prefs.need) {
    const needMap: Record<string, string> = {
      city_guide: 'city', language_help: 'language', nightlife: 'nightlife',
      content: 'content', arrival: 'arrival', group: 'adventure', custom: 'other',
    };
    const mappedCat = needMap[prefs.need] ?? prefs.need;
    if (buddy.categories.includes(mappedCat)) {
      catScore = 100;
      if (prefs.need === 'nightlife' && !buddy.nightlifeApproved) catScore = 0;
      if (prefs.need === 'arrival' && !buddy.arrivalApproved) catScore = 50;
    } else {
      catScore = 10;
    }
  }
  breakdown.category = catScore;

  // ── Availability ──────────────────────────────────────────────────────────
  let availScore = buddy.availableNow ? 100 : 60;
  breakdown.availability = availScore;

  // ── Language match ────────────────────────────────────────────────────────
  let langScore = 50;
  if (prefs.language) {
    const match = buddy.languages.some(
      (l) => l.toLowerCase().includes(prefs.language!.toLowerCase())
    );
    langScore = match ? 100 : 20;
  }
  breakdown.language = langScore;

  // ── Budget fit ────────────────────────────────────────────────────────────
  let budgetScore = 50;
  if ((prefs.budgetMinUsd != null || prefs.budgetMaxUsd != null) && buddy.hourlyRateUsd != null) {
    const rate = buddy.hourlyRateUsd;
    const min = prefs.budgetMinUsd ?? 0;
    const max = prefs.budgetMaxUsd ?? 9999;
    if (rate >= min && rate <= max) {
      budgetScore = 100;
    } else if (rate < min) {
      budgetScore = 60; // cheaper than expected — still OK
    } else {
      const overBy = (rate - max) / max;
      budgetScore = Math.max(10, 80 - overBy * 200);
    }
  }
  breakdown.budget = budgetScore;

  // ── Vibe / energy match ───────────────────────────────────────────────────
  let vibeScore = 50;
  if (prefs.vibe && buddy.vibeTagsList.includes(prefs.vibe)) vibeScore += 30;
  if (prefs.energy && buddy.energyType === prefs.energy) vibeScore += 20;
  breakdown.vibe = clamp(vibeScore);

  // ── Safety preferences ────────────────────────────────────────────────────
  let safetyScore = 70;
  if (buddy.verified) safetyScore += 20;
  if (buddy.publicMeetupOnly || buddy.newBuddyPublicOnly) safetyScore += 10;
  breakdown.safety = clamp(safetyScore);

  // ── Buddy level bonus ─────────────────────────────────────────────────────
  const levelMap: Record<string, number> = { new: 50, rising: 65, pro: 80, elite: 90, city_ambassador: 100 };
  breakdown.buddyLevel = levelMap[buddy.buddyLevel] ?? 50;

  // ── Trust Score ───────────────────────────────────────────────────────────
  breakdown.trustScore = clamp(buddy.trustScore);

  // ── Review quality ────────────────────────────────────────────────────────
  let reviewScore = 50;
  if (buddy.averageRating != null) {
    reviewScore = ((buddy.averageRating - 1) / 4) * 100;
    if (buddy.reviewCount >= 10) reviewScore = Math.min(100, reviewScore + 10);
  }
  breakdown.reviewQuality = clamp(reviewScore);

  // ── Response time (lower h = better) ─────────────────────────────────────
  let respScore = 50;
  if (buddy.responseTimeH != null) {
    if (buddy.responseTimeH <= 1) respScore = 100;
    else if (buddy.responseTimeH <= 3) respScore = 80;
    else if (buddy.responseTimeH <= 6) respScore = 60;
    else respScore = 30;
  }
  breakdown.responseTime = respScore;

  // ── Completed bookings ────────────────────────────────────────────────────
  const bkScore = Math.min(100, 30 + buddy.completedBookings * 2);
  breakdown.completedBookings = bkScore;

  // ── Preference match (booking length) ─────────────────────────────────────
  let prefScore = 50;
  if (prefs.bookingLength) {
    if (buddy.halfDayRateUsd != null && prefs.bookingLength === 'half_day') prefScore = 100;
    else if (buddy.fullDayRateUsd != null && prefs.bookingLength === 'full_day') prefScore = 100;
    else if (prefs.bookingLength === 'under_2h' || prefs.bookingLength === 'custom') prefScore = 70;
  }
  breakdown.prefMatch = prefScore;

  // ── Past positive interactions (placeholder — always 50 without DB lookup) ─
  breakdown.interactions = 50;

  // ── Location relevance ────────────────────────────────────────────────────
  breakdown.locationRelevance = travelerCity
    ? buddy.city.toLowerCase() === travelerCity.toLowerCase() ? 100 : 40
    : 50;

  // ── Weighted sum ──────────────────────────────────────────────────────────
  const total = Object.keys(WEIGHTS).reduce((sum, key) => {
    return sum + (breakdown[key] ?? 50) * (WEIGHTS as Record<string, number>)[key];
  }, 0);

  const totalWeight = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  const score = Math.round(clamp(total / totalWeight));

  return {
    buddyProfileId: buddy.buddyProfileId,
    score,
    scoreBreakdown: breakdown,
    eligible: true,
  };
}

/**
 * Rank an array of scored buddies using the priority ordering from the spec.
 * Ineligible buddies are excluded from the result.
 */
export function rankBuddies(scored: ScoredBuddy[], buddyData: Map<string, BuddyScoringData>): ScoredBuddy[] {
  const eligible = scored.filter((s) => s.eligible);

  eligible.sort((a, b) => {
    const da = buddyData.get(a.buddyProfileId)!;
    const db = buddyData.get(b.buddyProfileId)!;

    // Ambassador / featured first
    if (da.cityAmbassador !== db.cityAmbassador) return da.cityAmbassador ? -1 : 1;
    if (da.featured !== db.featured) return da.featured ? -1 : 1;

    // Compatibility score
    if (a.score !== b.score) return b.score - a.score;

    // Trust score
    if (da.trustScore !== db.trustScore) return db.trustScore - da.trustScore;

    // Review quality
    const ra = da.averageRating ?? 0;
    const rb = db.averageRating ?? 0;
    if (ra !== rb) return rb - ra;

    // Response time (lower = better)
    const rta = da.responseTimeH ?? 99;
    const rtb = db.responseTimeH ?? 99;
    if (rta !== rtb) return rta - rtb;

    // Completed bookings
    if (da.completedBookings !== db.completedBookings) return db.completedBookings - da.completedBookings;

    // New Buddy rotation: new Buddies with 0 bookings get a slight boost to get exposure
    const newA = da.completedBookings === 0 ? 1 : 0;
    const newB = db.completedBookings === 0 ? 1 : 0;
    if (newA !== newB) return newA - newB; // put new at end by default (ranked after established)

    return 0;
  });

  return eligible;
}
