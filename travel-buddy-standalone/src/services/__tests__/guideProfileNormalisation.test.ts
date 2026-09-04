/**
 * normalizeGuideProfile — the gem detail screen's crash.
 *
 * `app/gems/[id].tsx` renders `guideProfile.cityExpertise.join(', ')`. The
 * server's LocalGuideService.getGuideProfile does `select("*")` on
 * `local_guide_profiles`, so the route returns the RAW row — `city_expertise`,
 * `guide_level`, `contribution_count`. `getGuideProfile` in the app normalised
 * that; `getGem` did NOT, it passed the row straight through as a `GuideProfile`.
 *
 * So `cityExpertise` was undefined and `.join` threw, taking down the whole gem
 * detail screen — but ONLY for a gem with `guide_verified_by` set, which is why
 * it survived: the common case has no guide and never reaches the read.
 *
 * The mapping is now one exported function used by both readers, and these tests
 * pin it against the column names the table really has.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGuideProfile } from '../hiddenGemsMappers.ts';

/** A `local_guide_profiles` row exactly as `select("*")` returns it. */
const RAW_ROW = {
  user_id: 'u-1',
  guide_level: 3,
  city_expertise: ['Da Nang', 'Hoi An'],
  contribution_count: 42,
  helpful_votes: 17,
  accuracy_score: 0.91,
  status: 'active',
  bio: 'Ten years here.',
  verified_at: '2026-01-01T00:00:00.000Z',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('normalizeGuideProfile', () => {
  test('cityExpertise is an array — the read that threw', () => {
    const g = normalizeGuideProfile(RAW_ROW)!;
    assert.ok(Array.isArray(g.cityExpertise), 'cityExpertise must be an array');
    assert.deepEqual(g.cityExpertise, RAW_ROW.city_expertise);
    // The exact call the screen makes.
    assert.equal(g.cityExpertise.join(', '), 'Da Nang, Hoi An');
  });

  test('a row with no city_expertise still yields an array, never undefined', () => {
    // `local_guide_profiles.city_expertise` is nullable, so this is the case the
    // screen would have crashed on even after a partial fix.
    const { city_expertise: _omitted, ...noExpertise } = RAW_ROW;
    assert.deepEqual(normalizeGuideProfile(noExpertise)!.cityExpertise, []);
    assert.deepEqual(normalizeGuideProfile({ ...RAW_ROW, city_expertise: null })!.cityExpertise, []);
  });

  test('the other snake_case columns are mapped too', () => {
    const g = normalizeGuideProfile(RAW_ROW)!;
    assert.equal(g.userId, RAW_ROW.user_id);
    assert.equal(g.guideLevel, RAW_ROW.guide_level);
    assert.equal(g.contributionCount, RAW_ROW.contribution_count);
    assert.equal(g.helpfulVotes, RAW_ROW.helpful_votes);
    assert.equal(g.accuracyScore, RAW_ROW.accuracy_score);
    assert.equal(g.status, RAW_ROW.status);
    assert.equal(g.bio, RAW_ROW.bio);
    assert.equal(g.verifiedAt, RAW_ROW.verified_at);
  });

  test('numeric fields fall back to a number, never undefined', () => {
    // The screen renders `{guideProfile.contributionCount} contributions`, so an
    // undefined here is a visible "undefined contributions", not a crash — the
    // quieter half of the same bug.
    const g = normalizeGuideProfile({ user_id: 'u-2', status: 'active' })!;
    assert.equal(g.guideLevel, 1);
    assert.equal(g.contributionCount, 0);
    assert.equal(g.helpfulVotes, 0);
    assert.equal(g.accuracyScore, 0);
  });

  test('null in, null out', () => {
    assert.equal(normalizeGuideProfile(null), null);
    assert.equal(normalizeGuideProfile(undefined), null);
  });

  test('an ALREADY-camelCase row passes through unchanged', () => {
    // Both routes send snake_case today, but getGuideProfile has always accepted
    // either. Keeping that means normalising twice is harmless.
    const g = normalizeGuideProfile({
      userId: 'u-3', guideLevel: 5, cityExpertise: ['Tokyo'],
      contributionCount: 9, helpfulVotes: 1, accuracyScore: 0.5,
      status: 'active', bio: null, verifiedAt: null,
    })!;
    assert.equal(g.userId, 'u-3');
    assert.equal(g.guideLevel, 5);
    assert.deepEqual(g.cityExpertise, ['Tokyo']);
    assert.equal(g.contributionCount, 9);
  });
});
