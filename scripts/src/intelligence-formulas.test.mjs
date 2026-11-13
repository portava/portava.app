import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OBJECTIVES, evaluateObjective, compareObjectives, evidenceFreshness, aggregateClaimEvidence, selectMediaSlate } from './intelligence-formulas.mjs';

const gates = { permission: true, privacy: true, safety: true, hardConstraints: true, evidenceUse: true };
// Synthetic coefficients exercise the algebra; they are not production policy.
function input(domain, benefit = 0.5) {
  const shape = OBJECTIVES[domain];
  return {
    gates,
    benefits: Object.fromEntries(shape.benefits.map(key => [key, benefit])),
    costs: Object.fromEntries(shape.costs.map(key => [key, 0])),
    weights: { benefits: Object.fromEntries(shape.benefits.map(key => [key, 1 / shape.benefits.length])),
      costs: Object.fromEntries(shape.costs.map(key => [key, 0.25])) },
  };
}
const result = (domain, benefit) => evaluateObjective(domain, input(domain, benefit));
const report = (overrides = {}) => ({ independenceGroup: 'group-a', stance: 'supports', sourceReliability: 1, directness: 1, entityMatch: 1, freshness: 1, ...overrides });

describe('Principles outrank utility across every domain', () => {
  for (const domain of Object.keys(OBJECTIVES)) {
    it(`${domain}: no numerical reward overrides a hard gate or missing permission`, () => {
      for (const key of Object.keys(gates)) {
        const blocked = evaluateObjective(domain, { ...input(domain, 1), gates: { ...gates, [key]: false } });
        assert.equal(blocked.status, 'blocked');
        assert.equal(blocked.lower, null);
        const unreadable = evaluateObjective(domain, { ...input(domain, 1), gates: { ...gates, [key]: null } });
        assert.equal(unreadable.status, 'needs_verification');
        assert.equal(unreadable.upper, null);
      }
    });
  }
  it('unknown benefit and travel cost widen the interval instead of favoring incomplete candidates', () => {
    const candidate = input('compass', 0.6);
    candidate.benefits.intentFit = null;
    candidate.costs.travelFriction = null;
    const evaluated = evaluateObjective('compass', candidate);
    assert.deepEqual(evaluated.unknownTerms, ['intentFit', 'travelFriction']);
    assert.ok(evaluated.lower < result('compass', 0.6).lower);
    assert.ok(evaluated.upper > result('compass', 0.6).upper);
    assert.equal(compareObjectives([{ id: 'unknown', result: evaluated }, { id: 'known', result: result('compass', 0.6) }]).status, 'unresolved');
  });
  it('a small possible improvement does not justify the known cost of switching', () => {
    const stay = input('compass', 0.6), move = input('compass', 0.7);
    move.costs.switchingCost = 0.8;
    assert.equal(compareObjectives([{ id: 'stay', result: evaluateObjective('compass', stay) }, { id: 'move', result: evaluateObjective('compass', move) }]).winner, 'stay');
  });
  it('permission refusal excludes even the highest scoring sensing interruption', () => {
    const push = evaluateObjective('sensing', { ...input('sensing', 1), gates: { ...gates, permission: false } });
    assert.equal(compareObjectives([{ id: 'push', result: push }, { id: 'silent', result: result('sensing', 0.2) }]).winner, 'silent');
  });
  it('refuses unbounded values and uncalibrated weight totals', () => {
    const candidate = input('media');
    candidate.benefits.intentFit = NaN;
    assert.throws(() => evaluateObjective('media', candidate), /finite/);
    candidate.benefits.intentFit = 0.4;
    delete candidate.weights.benefits.intentFit;
    assert.throws(() => evaluateObjective('media', candidate), /weight/);
    candidate.weights.benefits.intentFit = 0.8;
    assert.throws(() => evaluateObjective('media', candidate), /sum to 1/);
  });
});

describe('Evidence is independent, time bounded and qualified', () => {
  it('uses claim-specific decay, hard expiry and unknown observation time', () => {
    const clock = { nowMs: 2000, observedAtMs: 1000, halfLifeMs: 1000, validUntilMs: 3000 };
    assert.equal(evidenceFreshness(clock), 0.5);
    assert.equal(evidenceFreshness({ ...clock, nowMs: 3000 }), 0);
    assert.equal(evidenceFreshness({ ...clock, observedAtMs: 2500 }), null);
    assert.equal(evidenceFreshness({ ...clock, validUntilMs: null }), null);
    assert.throws(() => evidenceFreshness({ ...clock, halfLifeMs: 0 }));
  });
  it('100 copies cannot outweigh an independent contradictory report', () => {
    const one = aggregateClaimEvidence([report(), report({ independenceGroup: 'group-b', stance: 'opposes' })]);
    const copied = aggregateClaimEvidence([...Array.from({ length: 100 }, () => report()), report({ independenceGroup: 'group-b', stance: 'opposes' })]);
    assert.deepEqual(copied, one);
    assert.equal(copied.supportShare, 0.5);
    assert.equal(copied.conflictShare, 0.5);
    assert.equal(copied.knownIndependentGroups, 2);
  });
  it('caps mixed reports from the same group and treats unproven independence conservatively', () => {
    const mixed = aggregateClaimEvidence([report(), report({ stance: 'opposes' })]);
    assert.equal(mixed.supportWeight + mixed.oppositionWeight, 1);
    const unknown = aggregateClaimEvidence(Array.from({ length: 20 }, () => report({ independenceGroup: null })));
    assert.equal(unknown.supportWeight, 1);
    assert.equal(unknown.independenceUnknown, true);
    assert.equal(unknown.knownIndependentGroups, 0);
  });
  it('no qualified evidence is unknown; adding an independent report increases support without promoting truth', () => {
    const empty = aggregateClaimEvidence([report({ freshness: 0 }), report({ entityMatch: null })]);
    assert.equal(empty.supportShare, null);
    assert.equal(empty.unknownReports, 1);
    const multiple = aggregateClaimEvidence([report(), report({ independenceGroup: 'group-b' })]);
    assert.equal(multiple.supportWeight, 2);
    assert.equal(multiple.truthClass, undefined);
    assert.equal(multiple.confidence, undefined);
  });
});

describe('Media is useful to this viewer without rewarding domination', () => {
  it('current intent changes the ordering, while watch time has no weight', () => {
    const preferred = input('media', 0.5), other = input('media', 0.5);
    preferred.benefits.intentFit = 1;
    preferred.benefits.tripFit = 1;
    other.benefits.watchTime = 1;
    assert.ok(evaluateObjective('media', preferred).lower > evaluateObjective('media', other).lower);
    assert.deepEqual(evaluateObjective('media', other), result('media', 0.5));
  });
  it('real imagery precedes generated fallback and one author or place cannot fill the slate', () => {
    const candidate = (id, score, authorId, placeId, provenance = 'authentic') => ({ id, result: result('media', score), authorId, placeId, provenance });
    const slate = selectMediaSlate([
      candidate('generated', 1, 'ai', 'ai-place', 'synthetic'),
      candidate('a', 0.9, 'alice', 'market'), candidate('a-copy', 0.89, 'alice', 'market'),
      candidate('b', 0.8, 'bob', 'market'), candidate('c', 0.7, 'carol', 'park'),
    ], { limit: 3, maxPerAuthor: 1, maxPerPlace: 1 });
    assert.deepEqual(slate, ['a', 'c', 'generated']);
  });
});
