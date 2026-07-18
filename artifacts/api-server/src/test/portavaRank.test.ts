/**
 * portavaRank tests — node:test.
 * Run: node --import tsx/esm --test src/test/portavaRank.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rankCandidates, scoreCandidate, recencyScore, actionabilityScore,
  availabilityFitScore, socialProofScore, diversify, DEFAULT_WEIGHTS,
  type RankCandidate, type ViewerContext,
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
