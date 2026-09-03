/**
 * gemStateDisplay.test.ts — pure-logic tests for the Hidden Gem Intelligence
 * client presentation layer (Media v2 Phase 8, §16 / §16.2 / §16.3 / §46.1).
 *
 * Run with:
 *   node --import tsx/esm --test src/lib/gems/gemStateDisplay.test.ts
 *
 * Covers:
 *   1. All 10 states → a calm label + treatment (exhaustive, in sync with the
 *      backend enum).
 *   2. NO forbidden hype vocabulary in any user-facing string (§16.2 / §46.1).
 *   3. Confidence band → calm indicator (never a vanity metric).
 *   4. The 9 structured contribution types map to 9 actions (§16.3).
 *   5. Degrade: absent / unknown gemState + gemConfidence ⇒ null, never throws.
 *   6. Overcrowding is treated protectively (§16.2).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEM_STATES,
  GEM_CONTRIBUTION_TYPES,
  GEM_CONFIDENCE_BANDS,
  GEM_CONTRIBUTION_ACTIONS,
  FORBIDDEN_HYPE_WORDS,
  gemStateTreatment,
  gemStateLabel,
  gemConfidenceIndicator,
  gemContributionAction,
  findHypeLanguage,
  assertNoHypeLanguage,
  allGemDisplayStrings,
  isGemState,
  isGemContributionType,
  type GemState,
} from './gemStateDisplay.ts';

// The backend contract, restated here so a drift on either side fails loudly.
const BACKEND_STATES = [
  'recently_confirmed',
  'still_hidden',
  'quiet_now',
  'getting_discovered',
  'seasonal',
  'hard_to_find',
  'access_changed',
  'temporarily_unavailable',
  'overcrowding_risk',
  'no_longer_hidden',
] as const;

const BACKEND_CONTRIBUTIONS = [
  'still_here',
  'still_worth_it',
  'access_changed',
  'closed',
  'too_crowded',
  'seasonal',
  'harder_to_reach',
  'better_entrance',
  'no_longer_hidden',
] as const;

describe('gemStateDisplay — the 10-state mapping', () => {
  it('mirrors the backend HIDDEN_GEM_STATES enum exactly (all 10, no extras)', () => {
    assert.deepEqual([...GEM_STATES].sort(), [...BACKEND_STATES].sort());
    assert.equal(GEM_STATES.length, 10);
  });

  it('maps every one of the 10 states to a calm label + treatment', () => {
    for (const state of GEM_STATES) {
      const t = gemStateTreatment(state);
      assert.ok(t, `state ${state} must have a treatment`);
      assert.equal(t!.state, state);
      assert.ok(t!.label.length > 0, `state ${state} must have a non-empty label`);
      assert.ok(t!.icon.length > 0, `state ${state} must have an icon`);
      assert.ok(
        ['confirmed', 'hidden', 'calm', 'aware', 'caution', 'protective'].includes(t!.tone),
        `state ${state} has a valid tone`,
      );
      // gemStateLabel is the label-only convenience.
      assert.equal(gemStateLabel(state), t!.label);
    }
  });

  it('produces 10 distinct labels (no two states collapse to the same label)', () => {
    const labels = GEM_STATES.map((s) => gemStateLabel(s));
    assert.equal(new Set(labels).size, 10);
  });

  it('uses the exact §16 / §46.1 labels for the first-class states', () => {
    assert.equal(gemStateLabel('recently_confirmed'), 'Recently confirmed');
    assert.equal(gemStateLabel('still_hidden'), 'Still hidden');
    assert.equal(gemStateLabel('quiet_now'), 'Quiet right now');
    assert.equal(gemStateLabel('seasonal'), 'Seasonal');
  });
});

describe('gemStateDisplay — NO hype / popularity language (§16.2 / §46.1)', () => {
  it('no state label or note contains a forbidden hype word', () => {
    for (const state of GEM_STATES) {
      const t = gemStateTreatment(state)!;
      assert.doesNotThrow(() => assertNoHypeLanguage(t.label), `label for ${state}`);
      if (t.note) {
        assert.doesNotThrow(() => assertNoHypeLanguage(t.note!), `note for ${state}`);
      }
    }
  });

  it('EVERY user-facing gem string (labels + notes + confidence + contributions) is hype-free', () => {
    for (const s of allGemDisplayStrings()) {
      const hits = findHypeLanguage(s);
      assert.equal(hits.length, 0, `"${s}" contains forbidden language: ${hits.join(', ')}`);
    }
  });

  it('the forbidden set actually catches viral / trending / hot / popularity phrasing', () => {
    assert.deepEqual(findHypeLanguage('This spot is going viral'), ['viral']);
    assert.ok(findHypeLanguage('the hottest trending place').length >= 2);
    assert.ok(findHypeLanguage('super popular right now').includes('popular'));
    assert.ok(findHypeLanguage('this is blowing up, go now').length >= 2);
    // A calm, protective phrase is clean.
    assert.deepEqual(findHypeLanguage('This small spot is getting busy — consider another time.'), []);
  });

  it('word-boundary matching does not false-positive on innocent substrings', () => {
    // "shot" must not trip "hot"; "shopping" must not trip anything.
    assert.deepEqual(findHypeLanguage('a great shot from the shopping street'), []);
    assert.ok(FORBIDDEN_HYPE_WORDS.includes('hot'));
  });
});

describe('gemStateDisplay — confidence as a calm indicator (not a vanity metric)', () => {
  it('maps every confidence band to a calm indicator', () => {
    for (const band of GEM_CONFIDENCE_BANDS) {
      const ind = gemConfidenceIndicator({ score: 0.5, band });
      assert.ok(ind, `band ${band} must map`);
      assert.ok(ind!.label.length > 0);
      assert.equal(ind!.band, band);
      assert.doesNotThrow(() => assertNoHypeLanguage(ind!.label));
    }
  });

  it('uses calm evidence phrasing, not counts', () => {
    assert.equal(gemConfidenceIndicator({ score: 0.95, band: 'strong' })!.label, 'Strong signal');
    assert.equal(gemConfidenceIndicator({ score: 0.4, band: 'provisional' })!.label, 'Emerging');
  });

  it('falls back to score-derived band when band is missing/unknown', () => {
    assert.equal(gemConfidenceIndicator({ score: 0.95, band: '' })!.band, 'strong');
    assert.equal(gemConfidenceIndicator({ score: 0.8, band: 'bogus' })!.band, 'live');
    assert.equal(gemConfidenceIndicator({ score: 0.6, band: '' })!.band, 'likely_current');
    assert.equal(gemConfidenceIndicator({ score: 0.4, band: '' })!.band, 'provisional');
    assert.equal(gemConfidenceIndicator({ score: 0.1, band: '' })!.band, 'unverified');
  });

  it('degrades: null / undefined / negative / non-finite ⇒ null, never throws', () => {
    assert.equal(gemConfidenceIndicator(null), null);
    assert.equal(gemConfidenceIndicator(undefined), null);
    assert.equal(gemConfidenceIndicator({ score: -1, band: '' }), null);
    assert.equal(gemConfidenceIndicator({ score: NaN, band: 'nope' }), null);
  });
});

describe('gemStateDisplay — the 9 structured contributions (§16.3)', () => {
  it('mirrors the backend GEM_CONTRIBUTION_TYPES exactly (all 9)', () => {
    assert.deepEqual([...GEM_CONTRIBUTION_TYPES].sort(), [...BACKEND_CONTRIBUTIONS].sort());
    assert.equal(GEM_CONTRIBUTION_TYPES.length, 9);
  });

  it('exposes exactly 9 contribution actions, one per type, in order', () => {
    assert.equal(GEM_CONTRIBUTION_ACTIONS.length, 9);
    assert.deepEqual(
      GEM_CONTRIBUTION_ACTIONS.map((a) => a.type),
      [...GEM_CONTRIBUTION_TYPES],
    );
    for (const a of GEM_CONTRIBUTION_ACTIONS) {
      assert.ok(a.label.length > 0);
      assert.ok(a.description.length > 0);
      assert.ok(a.icon.length > 0);
      assert.ok(['positive', 'neutral', 'caution'].includes(a.tone));
    }
  });

  it('resolves a type to its action and rejects junk', () => {
    assert.equal(gemContributionAction('still_here')!.label, 'Still here');
    assert.equal(gemContributionAction('too_crowded')!.type, 'too_crowded');
    assert.equal(gemContributionAction('nope'), null);
    assert.equal(gemContributionAction(null), null);
    assert.equal(gemContributionAction(undefined), null);
  });

  it('every contribution string is hype-free (each is an observation)', () => {
    for (const a of GEM_CONTRIBUTION_ACTIONS) {
      assert.doesNotThrow(() => assertNoHypeLanguage(a.label));
      assert.doesNotThrow(() => assertNoHypeLanguage(a.description));
    }
  });
});

describe('gemStateDisplay — overcrowding is protective, not enticing (§16.2)', () => {
  it('overcrowding_risk is flagged protective with a quieter-time note', () => {
    const t = gemStateTreatment('overcrowding_risk')!;
    assert.equal(t.protective, true);
    assert.equal(t.tone, 'protective');
    assert.ok(t.note && t.note.length > 0);
    // The note nudges toward a quieter visit, never toward going now.
    assert.match(t.note!, /another time|quieter|consider/i);
    assert.doesNotThrow(() => assertNoHypeLanguage(t.label));
    assert.doesNotThrow(() => assertNoHypeLanguage(t.note!));
  });

  it('the fragile / discovery-pressure states are marked protective', () => {
    for (const s of ['overcrowding_risk', 'getting_discovered', 'no_longer_hidden'] as GemState[]) {
      assert.equal(gemStateTreatment(s)!.protective, true, `${s} should be protective`);
    }
  });
});

describe('gemStateDisplay — degrade + guards', () => {
  it('gemStateTreatment / gemStateLabel degrade to null for absent/unknown states', () => {
    assert.equal(gemStateTreatment(null), null);
    assert.equal(gemStateTreatment(undefined), null);
    assert.equal(gemStateTreatment(''), null);
    assert.equal(gemStateTreatment('brand_new_unknown_state'), null);
    assert.equal(gemStateLabel(null), null);
    assert.equal(gemStateLabel('nope'), null);
  });

  it('type guards behave', () => {
    assert.ok(isGemState('still_hidden'));
    assert.ok(!isGemState('nope'));
    assert.ok(!isGemState(42));
    assert.ok(isGemContributionType('closed'));
    assert.ok(!isGemContributionType('deleted'));
  });

  it('assertNoHypeLanguage throws on a dirty string (so the guard is real)', () => {
    assert.throws(() => assertNoHypeLanguage('the hottest viral spot'), /hype language/);
  });
});
