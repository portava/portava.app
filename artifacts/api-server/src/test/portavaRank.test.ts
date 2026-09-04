/**
 * portavaRank tests — node:test.
 * Run: node --import tsx/esm --test src/test/portavaRank.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankCandidates, scoreCandidate, recencyScore, actionabilityScore,
  availabilityFitScore, socialProofScore, diversify, DEFAULT_WEIGHTS,
  PLACE_ENGAGEMENT_BOOST, PLACE_ENGAGEMENT_BOOST_THRESHOLD, LOCAL_MOMENTUM_MAX_CONTRIBUTION,
  type RankCandidate, type ViewerContext, type RankWeights,
} from '../lib/portavaRank';

const NOW = new Date('2026-07-18T12:00:00Z').getTime();
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();
const HOUR = 3_600_000;

const ctx = (over: Partial<ViewerContext> = {}): ViewerContext => ({
  userId: 'viewer-1', nowMs: NOW, ...over,
});

describe('kernels', () => {
  it('recency halves at ~36h and never exceeds 1', () => {
    assert.equal(recencyScore(iso(0), NOW), 1);
    const half = recencyScore(iso(-36 * HOUR), NOW);
    assert.ok(Math.abs(half - 0.5) < 0.01);
    assert.equal(recencyScore(undefined, NOW), 0);
  });

  it('actionability peaks before start, drops after, zero when long over', () => {
    assert.equal(actionabilityScore(iso(2 * HOUR), NOW), 1);      // starting soon
    assert.equal(actionabilityScore(iso(30 * HOUR), NOW), 0.4);   // tomorrow
    assert.equal(actionabilityScore(iso(-1 * HOUR), NOW), 0.25);  // ongoing
    assert.equal(actionabilityScore(iso(-3 * HOUR), NOW), 0);     // over
    assert.equal(actionabilityScore(null, NOW), 0);
  });

  it('availability fit honors explicit windows and never infers', () => {
    const c: RankCandidate = { id: 'e', kind: 'event', startsAt: iso(3 * HOUR) };
    assert.equal(availabilityFitScore(c, ctx(), NOW), 0);                              // no data → 0
    assert.equal(availabilityFitScore(c, ctx({ availableNow: true }), NOW), 1);        // fits tonight
    assert.equal(availabilityFitScore(c, ctx({ availableMinutes: 60 }), NOW), -0.5);   // outside layover window
    assert.equal(availabilityFitScore(c, ctx({ availableMinutes: 300 }), NOW), 1);     // inside window
  });

  it('social proof is log-scaled and dampened for unknown/low trust', () => {
    const viral = socialProofScore({ id: 'a', kind: 'post', likeCount: 10_000 });
    const modest = socialProofScore({ id: 'b', kind: 'post', likeCount: 10 });
    assert.ok(viral < modest * 5, 'virality must not scale linearly');
    const trusted = socialProofScore({ id: 'c', kind: 'post', likeCount: 100, authorTrustScore: 100 });
    const untrusted = socialProofScore({ id: 'd', kind: 'post', likeCount: 100, authorTrustScore: 0 });
    assert.ok(trusted > untrusted);
  });
});

describe('objective: realized value beats virality', () => {
  it('a joinable event tonight in your city outranks a viral post from elsewhere', () => {
    const event: RankCandidate = {
      id: 'event-tonight', kind: 'event', createdAt: iso(-5 * HOUR),
      startsAt: iso(4 * HOUR), city: 'Cebu City', hasCapacity: true,
      authorTrustScore: 80, verified: true,
    };
    const viralPost: RankCandidate = {
      id: 'viral', kind: 'post', createdAt: iso(-1 * HOUR),
      city: 'Elsewhere', likeCount: 50_000,
    };
    const ranked = rankCandidates([viralPost, event], ctx({ city: 'cebu city', availableNow: true }),
      { exploration: false, diversity: false });
    assert.equal(ranked[0].candidate.id, 'event-tonight');
  });

  it('followed + mutual + engaged authors stack', () => {
    const base: RankCandidate = { id: 'p1', kind: 'post', createdAt: iso(0), authorId: 'friend' };
    const stranger: RankCandidate = { id: 'p2', kind: 'post', createdAt: iso(0), authorId: 'stranger' };
    const c = ctx({
      followedIds: new Set(['friend']),
      mutualIds: new Set(['friend']),
      engagedAuthorIds: new Set(['friend']),
    });
    const s1 = scoreCandidate(base, c).score;
    const s2 = scoreCandidate(stranger, c).score;
    assert.ok(s1 - s2 >= DEFAULT_WEIGHTS.followedAuthor + DEFAULT_WEIGHTS.mutualAuthor + DEFAULT_WEIGHTS.engagedAuthor - 1e-9);
  });

  it('seen items are pushed down', () => {
    const a: RankCandidate = { id: 'seen', kind: 'post', createdAt: iso(0) };
    const b: RankCandidate = { id: 'fresh', kind: 'post', createdAt: iso(-10 * HOUR) };
    const ranked = rankCandidates([a, b], ctx({ seenIds: new Set(['seen']) }),
      { exploration: false, diversity: false });
    assert.equal(ranked[0].candidate.id, 'fresh');
  });
});

describe('diversity + exploration', () => {
  it('one loud author cannot own consecutive slots', () => {
    const cands: RankCandidate[] = [
      { id: 'a1', kind: 'post', createdAt: iso(0), authorId: 'loud' },
      { id: 'a2', kind: 'post', createdAt: iso(-1000), authorId: 'loud' },
      { id: 'a3', kind: 'post', createdAt: iso(-2000), authorId: 'loud' },
      { id: 'b1', kind: 'post', createdAt: iso(-6 * HOUR), authorId: 'quiet' },
    ];
    const out = diversify(cands.map((c) => scoreCandidate(c, ctx())));
    const firstThreeAuthors = out.slice(0, 3).map((s) => s.candidate.authorId);
    assert.ok(firstThreeAuthors.includes('quiet'), 'diversify must break author streaks');
  });

  it('exploration is deterministic within an hour and preserves the full set', () => {
    const cands: RankCandidate[] = Array.from({ length: 30 }, (_, i) => ({
      id: `c${i}`, kind: 'post' as const, createdAt: iso(-i * HOUR),
    }));
    const r1 = rankCandidates(cands, ctx());
    const r2 = rankCandidates(cands, ctx());
    assert.deepEqual(r1.map((s) => s.candidate.id), r2.map((s) => s.candidate.id));
    assert.equal(new Set(r1.map((s) => s.candidate.id)).size, 30);
  });

  it('features vector is exposed for the learning loop', () => {
    const s = scoreCandidate({ id: 'x', kind: 'event', startsAt: iso(HOUR) }, ctx());
    assert.ok('actionability' in s.features);
    assert.ok(Object.values(s.features).every((v) => Number.isFinite(v)));
  });
});

describe('place engagement boost', () => {
  const PLACE_ID = 'place-cebu-01';

  it(`applies ×${PLACE_ENGAGEMENT_BOOST} when viewer has ≥${PLACE_ENGAGEMENT_BOOST_THRESHOLD} place_view events`, () => {
    const postWithPlace: RankCandidate = {
      id: 'p-with-place', kind: 'post', createdAt: iso(0), placeId: PLACE_ID,
    };
    const postNoPlace: RankCandidate = {
      id: 'p-no-place', kind: 'post', createdAt: iso(0),
    };

    const withAffinity = ctx({ placeAffinities: { [PLACE_ID]: PLACE_ENGAGEMENT_BOOST_THRESHOLD } });
    const sBoost  = scoreCandidate(postWithPlace, withAffinity);
    const sBaseline = scoreCandidate(postNoPlace, withAffinity);

    // The boosted post must score above a baseline (no-placeId) equivalent.
    assert.ok(sBoost.score > sBaseline.score,
      'post linked to a place with sufficient affinity must outscore a baseline equal post');

    // The delta recorded in features must equal score * (boost - 1) before boost.
    assert.ok('placeEngagement' in sBoost.features,
      'placeEngagement feature must be recorded in the feature vector');

    // Verify ratio ≈ PLACE_ENGAGEMENT_BOOST (allowing floating-point rounding).
    const expectedDelta = (sBoost.score - sBoost.features.placeEngagement) * (PLACE_ENGAGEMENT_BOOST - 1);
    assert.ok(
      Math.abs(sBoost.features.placeEngagement - expectedDelta) < 1e-9,
      'placeEngagement feature must equal score-before-boost × (BOOST - 1)',
    );
  });

  it('does NOT apply boost when viewer has fewer than the threshold place_view events', () => {
    const postWithPlace: RankCandidate = {
      id: 'p-low', kind: 'post', createdAt: iso(0), placeId: PLACE_ID,
    };
    const lowAffinity = ctx({ placeAffinities: { [PLACE_ID]: PLACE_ENGAGEMENT_BOOST_THRESHOLD - 1 } });
    const s = scoreCandidate(postWithPlace, lowAffinity);
    assert.ok(!('placeEngagement' in s.features),
      'placeEngagement feature must be absent when view count is below threshold');
  });

  it('does NOT apply boost when placeAffinities is absent from ViewerContext', () => {
    const postWithPlace: RankCandidate = {
      id: 'p-no-ctx', kind: 'post', createdAt: iso(0), placeId: PLACE_ID,
    };
    const noAff = ctx(); // placeAffinities omitted
    const s = scoreCandidate(postWithPlace, noAff);
    assert.ok(!('placeEngagement' in s.features),
      'placeEngagement feature must be absent when placeAffinities is not provided');
  });

  it('does NOT apply boost when candidate has no placeId', () => {
    const postNoId: RankCandidate = { id: 'p-no-id', kind: 'post', createdAt: iso(0) };
    const withAff = ctx({ placeAffinities: { [PLACE_ID]: 99 } });
    const s = scoreCandidate(postNoId, withAff);
    assert.ok(!('placeEngagement' in s.features),
      'placeEngagement feature must be absent when candidate has no placeId');
  });
});

describe('expanded candidate pool smoke tests', () => {
  it('a kind:event starting in 3h outranks a kind:post with no startsAt and equal other signals', () => {
    const event: RankCandidate = {
      id: 'event-3h',
      kind: 'event',
      startsAt: iso(3 * HOUR),
      authorTrustScore: 80,
    };
    const post: RankCandidate = {
      id: 'post-no-start',
      kind: 'post',
      createdAt: iso(-1 * HOUR),
      // No startsAt — actionability kernel scores 0
    };
    const ranked = rankCandidates([post, event], ctx(), { exploration: false, diversity: false });
    assert.equal(ranked[0].candidate.id, 'event-3h',
      'event starting soon must outrank post with no startsAt');
  });

  it('missing trust score contributes 0, not a crash', () => {
    const c: RankCandidate = { id: 'no-trust', kind: 'buddy' };
    const s = scoreCandidate(c, ctx());
    assert.equal(s.features.trust, 0);
    assert.ok(Number.isFinite(s.score));
  });

  it('missing startsAt contributes 0 actionability, not a crash', () => {
    const c: RankCandidate = { id: 'no-start', kind: 'plan' };
    const s = scoreCandidate(c, ctx());
    assert.equal(s.features.actionability, 0);
    assert.ok(Number.isFinite(s.score));
  });

  it('plan with hasCapacity:true gets capacityOpen bonus', () => {
    const withCap: RankCandidate = { id: 'open', kind: 'plan', hasCapacity: true };
    const noCap: RankCandidate = { id: 'full', kind: 'plan', hasCapacity: false };
    const s1 = scoreCandidate(withCap, ctx()).score;
    const s2 = scoreCandidate(noCap, ctx()).score;
    assert.ok(s1 > s2, 'open plan must score higher than full plan');
  });
});

describe('local momentum — a CAPPED modifier (ROADMAP step 7)', () => {
  const gem = (id: string, over: Partial<RankCandidate> = {}): RankCandidate => ({ id, kind: 'gem', ...over });

  it("absent map, absent id, or a non-finite / negative value ⇒ feature 0 (today's behaviour)", () => {
    assert.equal(scoreCandidate(gem('a'), ctx()).features.localMomentum, 0);
    assert.equal(scoreCandidate(gem('a'), ctx({ localMomentum: { b: 1 } })).features.localMomentum, 0);
    assert.equal(scoreCandidate(gem('a'), ctx({ localMomentum: { a: Number.NaN } })).features.localMomentum, 0);
    assert.equal(scoreCandidate(gem('a'), ctx({ localMomentum: { a: -3 } })).features.localMomentum, 0);
  });

  it('THE CAP BINDS: no weight table can push the contribution past LOCAL_MOMENTUM_MAX_CONTRIBUTION', () => {
    const hot = ctx({ localMomentum: { a: 1 } });
    const loud: RankWeights = { ...DEFAULT_WEIGHTS, localMomentum: 10 };
    assert.equal(scoreCandidate(gem('a'), hot, loud).features.localMomentum, LOCAL_MOMENTUM_MAX_CONTRIBUTION);
    // an over-range input is clamped to 1 BEFORE the weight, so the cap still holds
    assert.equal(
      scoreCandidate(gem('a'), ctx({ localMomentum: { a: 50 } }), loud).features.localMomentum,
      LOCAL_MOMENTUM_MAX_CONTRIBUTION,
    );
  });

  it('the default weight IS the cap, and partial momentum scales linearly below it', () => {
    assert.equal(DEFAULT_WEIGHTS.localMomentum, LOCAL_MOMENTUM_MAX_CONTRIBUTION);
    const half = scoreCandidate(gem('a'), ctx({ localMomentum: { a: 0.5 } })).features.localMomentum;
    assert.ok(Math.abs(half - LOCAL_MOMENTUM_MAX_CONTRIBUTION / 2) < 1e-9);
  });

  it('the cap is below every taste signal: saturated momentum cannot beat ONE interest tag', () => {
    assert.ok(LOCAL_MOMENTUM_MAX_CONTRIBUTION < DEFAULT_WEIGHTS.interestTag);
    assert.ok(LOCAL_MOMENTUM_MAX_CONTRIBUTION < DEFAULT_WEIGHTS.categoryAffinity);
    assert.ok(LOCAL_MOMENTUM_MAX_CONTRIBUTION < DEFAULT_WEIGHTS.cityMatch);
    const viewer = ctx({ interestTags: new Set(['coffee']), localMomentum: { hot: 1 } });
    const liked = scoreCandidate(gem('liked', { tags: ['coffee'] }), viewer);
    const hot   = scoreCandidate(gem('hot',   { tags: ['other'] }),  viewer);
    assert.ok(hot.features.localMomentum > 0);
    assert.ok(liked.score > hot.score, `taste must beat momentum: liked=${liked.score} hot=${hot.score}`);
  });

  it('is a tie-breaker between two places the viewer rates alike — by exactly the cap', () => {
    const viewer = ctx({ localMomentum: { hot: 1 } });
    const hot  = scoreCandidate(gem('hot'), viewer);
    const cold = scoreCandidate(gem('cold'), viewer);
    assert.ok(hot.score > cold.score);
    assert.ok(Math.abs((hot.score - cold.score) - LOCAL_MOMENTUM_MAX_CONTRIBUTION) < 1e-9);
  });
});
