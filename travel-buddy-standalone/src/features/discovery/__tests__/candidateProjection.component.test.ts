/**
 * candidateProjection — the reader's own invariants.
 * census-discovery DSV2-04 / DC-22.
 *
 * `PlaceCard.candidateProjection.component.test.tsx` pins what a user SEES.
 * This file pins the two properties that make that rendering trustworthy and
 * which no single card render can show:
 *
 *   1. No two §5.1 truth classes share a label. "Observed and predicted render
 *      distinctly" is a statement about the whole vocabulary, not about one
 *      pair, and a collision anywhere in the table is an indistinct rendering
 *      waiting for a producer.
 *   2. The parser REFUSES rather than defaults. A projection this client cannot
 *      fully name yields null, so nothing downstream can assert a truth class
 *      nobody computed.
 *
 * Run with: pnpm test:component (jest — uses jest's `expect`).
 */

import {
  TRUTH_CLASSES,
  TRUTH_CLASS_PRESENTATION,
  parseDiscoveryCandidate,
  whyNowPresentation,
} from '../candidateProjection.ts';

/** A well-formed served projection. */
function raw(over: Record<string, unknown> = {}) {
  return {
    id: 'node/1',
    whyNow: null,
    whyForUser: [],
    rankedBy: 'none',
    confidence: 0.6,
    freshness: { state: 'fresh', ageMs: 10, servedFrom: 'L1' },
    truthClass: 'observed',
    provenance: null,
    reasons: [],
    ...over,
  };
}

describe('truth-class presentation table', () => {
  it('covers all seven Sensing §5.1 classes', () => {
    expect(TRUTH_CLASSES).toHaveLength(7);
    for (const c of TRUTH_CLASSES) {
      expect(TRUTH_CLASS_PRESENTATION[c]).toBeDefined();
      expect(TRUTH_CLASS_PRESENTATION[c].label.trim().length).toBeGreaterThan(0);
      expect(TRUTH_CLASS_PRESENTATION[c].accessibilityLabel.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every class a label no other class shares', () => {
    const labels = TRUTH_CLASSES.map((c) => TRUTH_CLASS_PRESENTATION[c].label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('separates the observation family from the prediction family', () => {
    expect(TRUTH_CLASS_PRESENTATION.observed.kind).toBe('observation');
    expect(TRUTH_CLASS_PRESENTATION.corroborated.kind).toBe('observation');
    expect(TRUTH_CLASS_PRESENTATION.predicted.kind).toBe('prediction');
    expect(TRUTH_CLASS_PRESENTATION.inferred.kind).toBe('prediction');
    // `conflicting` is neither — asserting it as one or the other would claim
    // something no source did.
    expect(TRUTH_CLASS_PRESENTATION.conflicting.kind).toBe('conflict');
  });
});

describe('parseDiscoveryCandidate — refuses rather than defaults', () => {
  it('parses a well-formed projection', () => {
    const c = parseDiscoveryCandidate(raw());
    expect(c).not.toBeNull();
    expect(c!.truthClass).toBe('observed');
    expect(c!.freshness.state).toBe('fresh');
  });

  it.each([
    ['absent (flag off)', undefined],
    ['null', null],
    ['not an object', 'observed'],
  ])('returns null for a projection that is %s', (_label, value) => {
    expect(parseDiscoveryCandidate(value)).toBeNull();
  });

  it('returns null for a truth class this client cannot name', () => {
    expect(parseDiscoveryCandidate(raw({ truthClass: 'speculative' }))).toBeNull();
    expect(parseDiscoveryCandidate(raw({ truthClass: 42 }))).toBeNull();
  });

  it('returns null when the freshness block is missing or malformed', () => {
    expect(parseDiscoveryCandidate(raw({ freshness: undefined }))).toBeNull();
    expect(parseDiscoveryCandidate(raw({ freshness: { state: 'warm' } }))).toBeNull();
  });

  it('drops a reason that carries a code but no plain language', () => {
    const c = parseDiscoveryCandidate(raw({
      reasons: [
        { code: 'nearby_now', text: 'Rising near your hotel.' },
        { code: 'trending_local' },
        { code: 'exploration', text: '   ' },
      ],
    }));
    expect(c!.reasons).toEqual([{ code: 'nearby_now', text: 'Rising near your hotel.' }]);
  });
});

describe('whyNowPresentation — absence is never an endorsement', () => {
  it('a null why-now yields no claims and is not marked stale', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw({ whyNow: null })));
    expect(p.claims).toEqual([]);
    expect(p.stale).toBe(false);
  });

  it('an empty why-now array is treated as absent, not as "none apply"', () => {
    const c = parseDiscoveryCandidate(raw({ whyNow: [] }));
    expect(c!.whyNow).toBeNull();
    expect(whyNowPresentation(c).claims).toEqual([]);
  });

  it('a fresh reading yields humanised claims and is not stale', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw({ whyNow: ['crowd_busy', 'trajectory_building'] })));
    expect(p.claims).toEqual(['crowd busy', 'trajectory building']);
    expect(p.stale).toBe(false);
  });

  it('a stale FRESHNESS marks the claims stale', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw({
      whyNow: ['crowd_busy'],
      freshness: { state: 'stale', ageMs: 900000, servedFrom: 'L2_stale' },
    })));
    expect(p.stale).toBe(true);
    expect(p.claims).toEqual(['crowd busy']);
  });

  it('a stale TRUTH CLASS marks the claims stale even when freshness says otherwise', () => {
    const p = whyNowPresentation(parseDiscoveryCandidate(raw({
      whyNow: ['crowd_busy'],
      truthClass: 'stale',
      freshness: { state: 'unknown', ageMs: null, servedFrom: 'compass_candidate_hit' },
    })));
    expect(p.stale).toBe(true);
  });

  it('a null candidate yields nothing rather than throwing', () => {
    expect(whyNowPresentation(null)).toEqual({ claims: [], stale: false });
  });
});
