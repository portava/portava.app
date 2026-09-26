/**
 * mediaIntelligence — the client reads the server's §18 Visual Consensus and
 * only ever LOWERS confidence with it (census-media MD323, §22).
 *
 * Run: node --import tsx --test src/services/media/__tests__/mediaIntelligence.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIXED_REPORTS_LABEL,
  currentPictureFromConsensus,
  mapVisualConsensus,
  uncertaintyBanner,
} from '../mediaIntelligence.ts';
import { mapPlaceCurrentView } from '../../../features/media/services/mediaProjection.ts';

/** The server's shape (MediaConsensusService.VisualConsensus). */
function consensus(over: Record<string, unknown> = {}) {
  return {
    state: 'corroborated',
    corroboration: { level: 'corroborated', freshPerspectiveCount: 4, independentSourceCount: 2 },
    contradiction: null,
    uncertaintyLabel: null,
    requestAnotherObservation: false,
    ...over,
  };
}

describe('mapVisualConsensus', () => {
  it('reads the server object', () => {
    const c = mapVisualConsensus(consensus());
    assert.deepEqual(c, {
      state: 'corroborated',
      corroboration: { level: 'corroborated', freshPerspectiveCount: 4, independentSourceCount: 2 },
      contradiction: null,
      uncertaintyLabel: null,
      requestAnotherObservation: false,
    });
  });
  it('an absent or unreadable consensus is ABSENT, never guessed', () => {
    assert.equal(mapVisualConsensus(undefined), null);
    assert.equal(mapVisualConsensus({ state: 'confident' }), null);
    assert.equal(mapVisualConsensus([consensus()]), null);
  });
  it('an unrecognised contradiction state reads as material (the server\'s direction)', () => {
    assert.equal(mapVisualConsensus(consensus({ contradiction: { state: 'severe', claimTypes: [] } }))!.contradiction, 'material');
    assert.equal(mapVisualConsensus(consensus({ contradiction: { state: 'minor', claimTypes: [] } }))!.contradiction, 'minor');
  });
});

describe('currentPictureFromConsensus — strength from FRESH witnesses, only ever lowered', () => {
  const legacyStrong = { strength: 'strong' as const, sourceCount: 5 };
  it('three sources last month are not a strong CURRENT picture', () => {
    const none = mapVisualConsensus(consensus({ state: 'insufficient', corroboration: { level: 'none', freshPerspectiveCount: 0, independentSourceCount: 0 } }));
    assert.deepEqual(currentPictureFromConsensus(none, legacyStrong), { strength: 'low', sourceCount: 0 });
  });
  it('two fresh independent sources are moderate; three are strong', () => {
    assert.deepEqual(currentPictureFromConsensus(mapVisualConsensus(consensus()), legacyStrong), { strength: 'moderate', sourceCount: 2 });
    const well = mapVisualConsensus(consensus({ corroboration: { level: 'well_corroborated', freshPerspectiveCount: 9, independentSourceCount: 3 } }));
    assert.deepEqual(currentPictureFromConsensus(well, legacyStrong), { strength: 'strong', sourceCount: 3 });
  });
  it('a material dispute caps the picture at low, however many photographs agree', () => {
    const mixed = mapVisualConsensus(consensus({
      state: 'mixed',
      corroboration: { level: 'well_corroborated', freshPerspectiveCount: 9, independentSourceCount: 4 },
      contradiction: { state: 'material', claimTypes: ['crowd'] },
      uncertaintyLabel: MIXED_REPORTS_LABEL,
    }));
    assert.equal(currentPictureFromConsensus(mixed, legacyStrong).strength, 'low');
  });
  it('never RAISES what the legacy count said', () => {
    const well = mapVisualConsensus(consensus({ corroboration: { level: 'well_corroborated', freshPerspectiveCount: 9, independentSourceCount: 3 } }));
    assert.equal(currentPictureFromConsensus(well, { strength: 'moderate', sourceCount: 2 }).strength, 'moderate');
  });
  it('no consensus (an older server) leaves the legacy values exactly as they were', () => {
    assert.deepEqual(currentPictureFromConsensus(null, legacyStrong), legacyStrong);
  });
});

describe('uncertaintyBanner — exactly when the server says the reports disagree', () => {
  it('the server\'s label; the §18 copy for a mixed consensus without one; nothing otherwise', () => {
    assert.equal(uncertaintyBanner(mapVisualConsensus(consensus({ state: 'mixed', uncertaintyLabel: MIXED_REPORTS_LABEL }))), MIXED_REPORTS_LABEL);
    assert.equal(uncertaintyBanner(mapVisualConsensus(consensus({ state: 'mixed' }))), MIXED_REPORTS_LABEL);
    assert.equal(uncertaintyBanner(mapVisualConsensus(consensus({ contradiction: { state: 'minor', claimTypes: ['crowd'] } }))), null, 'a minor disagreement gets no banner');
    assert.equal(uncertaintyBanner(null), null);
  });
});

describe('mapPlaceCurrentView carries the consensus and draws its current picture from it', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const body = (c: unknown) => ({
    place: { id: '11111111-1111-4111-8111-111111111111', name: 'An Thuong 2', city: 'Da Nang' },
    currentState: { crowdLabel: null },
    perspectives: { totalPerspectives: 12, contributorCount: 6, independentSourceCount: 5, groups: [] },
    consensus: c,
  });
  it('fresh witnesses, not all-ages sources, decide the badge', () => {
    const v = mapPlaceCurrentView(body(consensus({ state: 'insufficient', corroboration: { level: 'single_source', freshPerspectiveCount: 1, independentSourceCount: 1 } })), now)!;
    assert.equal(v.currentPicture.strength, 'low', 'five sources of any age, one fresh — not a strong current picture');
    assert.equal(v.currentPicture.sourceCount, 1);
    assert.equal(v.consensus?.state, 'insufficient');
  });
  it('a server without the consensus field keeps the previous behaviour', () => {
    const v = mapPlaceCurrentView(body(undefined), now)!;
    assert.equal(v.currentPicture.strength, 'strong');
    assert.equal(v.currentPicture.sourceCount, 5);
    assert.equal(v.consensus, null);
  });
});
