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
    contributionCount: g.contribution_count ?? g.contributionCount ?? 0,
    helpfulVotes:      g.helpful_votes ?? g.helpfulVotes ?? 0,
    accuracyScore:     g.accuracy_score ?? g.accuracyScore ?? 0,
    status:            g.status,
    bio:               g.bio ?? null,
    verifiedAt:        g.verified_at ?? g.verifiedAt ?? null,
  };
}
