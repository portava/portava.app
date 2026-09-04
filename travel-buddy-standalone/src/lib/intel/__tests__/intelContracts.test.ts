/**
 * Pure-logic tests for the Intelligence Gathering client contract + display +
 * prompt-pause. These are the load-bearing invariants the capture UI depends on:
 * the specialist-only safety exclusion, honest Live/Typical/Unknown degradation,
 * the option→value mapping used by corrections, and the three pause scopes.
 *
 * node:test (run via scripts/run-node-tests.mjs) — pure logic, no rendering.
 * Component rendering is covered by IntelCapture.component.test.tsx (jest).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_SIGNAL_PROMPTS,
  VENUE_QUESTION_SETS,
  SPECIALIST_ONLY_CROWD_LEVELS,
  isSpecialistOnlyCrowd,
  optionToClaimValue,
  correctionOptionsFor,
  DEFAULT_VISIBILITY,
  TRAIL_VISIBILITY_ORDER,
  VISIBILITIES,
  PARTY_SIZE_BUCKETS,
  PARTY_SIZE_OPTIONS,
  PARTY_SIZE_LABELS,
  MUSIC_GENRES,
  MUSIC_GENRE_LABELS,
  COMMERCIAL_DISCLOSURES,
  COMMERCIAL_DISCLOSURE_OPTIONS,
  COMMERCIAL_DISCLOSURE_LABELS,
} from '../contracts.ts';
import {
  confidenceBand,
  liveState,
  liveStateLabel,
  liveStateColor,
  formatClaimValue,
  whyExplanation,
  relativeTime,
  type LiveIntelClaim,
  type SourceCountBucket,
} from '../display.ts';
import {
  isPromptPaused,
  setCategoryPaused,
  setSessionPaused,
  isSessionPaused,
  type PersistedPromptPause,
} from '../promptPauseStorage.ts';

describe('specialist-only safety exclusion', () => {
  it('never lists unsafe_density as a Quick Signal option', () => {
    for (const ctx of Object.values(QUICK_SIGNAL_PROMPTS)) {
      assert.ok(!ctx.options.includes('unsafe_density'));
    }
  });
  it('never lets a correction produce unsafe_density', () => {
    // 'unsafe_density' is not an arrival option, so it can never be selected;
    // and even a raw attempt maps to null (fail-closed).
    assert.equal(optionToClaimValue('crowd.level', 'unsafe_density'), null);
    assert.equal(isSpecialistOnlyCrowd('unsafe_density'), true);
    assert.ok(SPECIALIST_ONLY_CROWD_LEVELS.includes('unsafe_density'));
  });
});

describe('option → canonical value (corrections)', () => {
  it('maps the friendly "good energy" arrival option to canonical moderate', () => {
    assert.deepEqual(optionToClaimValue('crowd.level', 'good energy'), { level: 'moderate' });
  });
  it('maps queue options to minute ranges, open-ended for 40+', () => {
    assert.deepEqual(optionToClaimValue('queue.wait', 'none'), { minMinutes: 0, maxMinutes: 0 });
    assert.deepEqual(optionToClaimValue('queue.wait', '10-20'), { minMinutes: 10, maxMinutes: 20 });
    assert.deepEqual(optionToClaimValue('queue.wait', '40+'), { minMinutes: 40, maxMinutes: null });
  });
  it('maps walk-in options to booleans', () => {
    assert.deepEqual(optionToClaimValue('access.walk_in', 'accepted'), { accepted: true });
    assert.deepEqual(optionToClaimValue('access.walk_in', 'turned away'), { accepted: false });
  });
  it('maps music.current genre options to the canonical value (no free text)', () => {
    assert.deepEqual(optionToClaimValue('music.current', 'house'), { genre: 'house' });
    assert.deepEqual(optionToClaimValue('music.current', 'live_band'), { genre: 'live_band' });
    assert.equal(optionToClaimValue('music.current', 'dubstep'), null, 'off-vocabulary genre refused');
  });
  it('offers correction options for the wired Phase-1 claim types, null otherwise', () => {
    assert.ok(correctionOptionsFor('crowd.level'));
    assert.deepEqual(correctionOptionsFor('music.current'), MUSIC_GENRES);
    assert.equal(correctionOptionsFor('access.reservation'), null, 'not yet a wired correction family');
  });
});

describe('commercial disclosure vocabulary (§22 Table 30)', () => {
  it('mirrors the seven canonical values with none first', () => {
    assert.deepEqual([...COMMERCIAL_DISCLOSURES], ['none', 'employee', 'owner', 'hosted', 'complimentary', 'affiliate', 'paid']);
  });
  it('the control offers every value EXCEPT the none default', () => {
    assert.equal(COMMERCIAL_DISCLOSURE_OPTIONS.includes('none' as never), false, "'none' is the default, never an offered pill");
    for (const d of COMMERCIAL_DISCLOSURES) {
      if (d === 'none') continue;
      assert.ok(COMMERCIAL_DISCLOSURE_OPTIONS.includes(d), `${d} should be offered`);
    }
  });
  it('has a label for every value', () => {
    for (const d of COMMERCIAL_DISCLOSURES) {
      assert.equal(typeof COMMERCIAL_DISCLOSURE_LABELS[d], 'string');
      assert.ok(COMMERCIAL_DISCLOSURE_LABELS[d].length > 0);
    }
  });
});

describe('music.current family (§29 Included)', () => {
  it('is wired to submit in the nightlife arrival set with a controlled genre picker', () => {
    const music = VENUE_QUESTION_SETS.nightlife.arrival.find((q) => q.id === 'music');
    assert.ok(music, 'nightlife arrival set includes the music question');
    assert.equal(music!.kind, 'music');
    assert.equal(music!.phase1, true, 'music.current is a Phase-1-backed write');
    assert.deepEqual([...music!.options], [...MUSIC_GENRES]);
  });
  it('offers a friendly label for every canonical genre, and no free-text field', () => {
    const music = VENUE_QUESTION_SETS.nightlife.arrival.find((q) => q.id === 'music')!;
    for (const g of MUSIC_GENRES) {
      assert.equal(typeof MUSIC_GENRE_LABELS[g], 'string');
      assert.ok(music.labelFor && music.labelFor(g).length > 0);
    }
  });
});

describe('confidence band + Live/Emerging/Typical/Unknown degradation', () => {
  const base: LiveIntelClaim = {
    claimType: 'crowd.level',
    value: { level: 'busy' },
    band: 'live',
    confidence: 0.8,
    sourceClass: 'firsthand_unverified',
    sourceCountBucket: 'several',
    observedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  };

  it('maps scores to bands fail-closed', () => {
    assert.equal(confidenceBand(0.95), 'strong');
    assert.equal(confidenceBand(0.8), 'live');
    assert.equal(confidenceBand(-1), 'unverified');
    assert.equal(confidenceBand(NaN), 'unverified');
    assert.equal(confidenceBand(null), 'unverified');
  });

  it('shows a fresh above-floor firsthand claim as Live', () => {
    assert.equal(liveState(base), 'live');
  });
  it('degrades an expired claim to Unknown, never a stale value', () => {
    assert.equal(liveState({ ...base, validUntil: new Date(Date.now() - 1000).toISOString() }), 'unknown');
  });
  it('degrades a below-floor claim to Typical', () => {
    assert.equal(liveState({ ...base, band: 'provisional' }), 'typical');
  });
  it('shows a serve-floor-but-not-live-band claim as Emerging, not Live (#156)', () => {
    // likely_current cleared the serve floor but is below the live band — the
    // server calls this 'emerging' and the client must not overstate it as Live.
    assert.equal(liveState({ ...base, band: 'likely_current' }), 'emerging');
  });
  it('trusts the server-authoritative emerging state over the band', () => {
    assert.equal(liveState({ ...base, serverState: 'emerging' }), 'emerging');
    // …but expiry and non-observation sources still win over any server state.
    assert.equal(liveState({ ...base, serverState: 'live', sourceClass: 'historical_pattern' }), 'typical');
    assert.equal(
      liveState({ ...base, serverState: 'live', validUntil: new Date(Date.now() - 1000).toISOString() }),
      'unknown',
    );
  });
  it('never renders a historical pattern or prediction as Live', () => {
    assert.equal(liveState({ ...base, sourceClass: 'historical_pattern' }), 'typical');
    assert.equal(liveState({ ...base, sourceClass: 'portava_prediction' }), 'typical');
  });
  it('is Unknown when there is no claim', () => {
    assert.equal(liveState(null), 'unknown');
  });
  it('labels and colours emerging distinctly from live/typical/unknown', () => {
    assert.equal(liveStateLabel('emerging'), 'Observed');
    assert.equal(liveStateLabel('live'), 'Live');
    // Vermilion is reserved for Live — emerging must borrow neither Live's nor
    // Typical's colour, and must not read as Unknown.
    assert.notEqual(liveStateColor('emerging'), liveStateColor('live'));
    assert.notEqual(liveStateColor('emerging'), liveStateColor('typical'));
    assert.notEqual(liveStateColor('emerging'), liveStateColor('unknown'));
  });
});

describe('value formatting', () => {
  it('formats crowd from a bare string or an object', () => {
    assert.equal(formatClaimValue('crowd.level', 'busy'), 'Busy');
    assert.equal(formatClaimValue('crowd.level', { level: 'packed' }), 'Packed');
  });
  it('refuses to render a specialist-only crowd value', () => {
    assert.equal(formatClaimValue('crowd.level', { level: 'unsafe_density' }), '—');
  });
  it('formats a queue range and an open-ended wait', () => {
    assert.equal(formatClaimValue('queue.wait', { minMinutes: 10, maxMinutes: 20 }), '10–20 min');
    assert.equal(formatClaimValue('queue.wait', { minMinutes: 40, maxMinutes: null }), '40+ min');
    assert.equal(formatClaimValue('queue.wait', { minMinutes: 0, maxMinutes: 0 }), 'No wait');
  });
  it('formats walk-in', () => {
    assert.equal(formatClaimValue('access.walk_in', { accepted: true }), 'Walk-ins OK');
    assert.equal(formatClaimValue('access.walk_in', { accepted: false }), 'Turned away');
  });
});

describe('why explanation', () => {
  it('renders the cohort bucket honestly, without fabricating a count', () => {
    const c = (bucket: SourceCountBucket | null, sc: LiveIntelClaim['sourceClass']): LiveIntelClaim => ({
      claimType: 'crowd.level', value: { level: 'busy' }, band: 'live', confidence: 0.8,
      sourceClass: sc, sourceCountBucket: bucket, observedAt: null, validUntil: null,
    });
    // Every bucket is ≥ the k=15 floor, so none understates; and no exact number leaks.
    assert.match(whyExplanation(c('few', 'firsthand_unverified')), /more than a dozen travelers/);
    assert.match(whyExplanation(c('several', 'verified_firsthand')), /dozens of travelers/);
    assert.match(whyExplanation(c('many', 'firsthand_unverified')), /over a hundred travelers/);
    for (const bucket of ['few', 'several', 'many', null] as const) {
      assert.doesNotMatch(whyExplanation(c(bucket, 'firsthand_unverified')), /\d/, 'no exact count leaks');
    }
    assert.match(whyExplanation(c(null, 'historical_pattern')), /typical pattern/i);
  });
  it('formats relative time without inventing precision', () => {
    assert.equal(relativeTime(new Date().toISOString()), 'just now');
    assert.equal(relativeTime(new Date(Date.now() - 6 * 60_000).toISOString()), '6 min ago');
    assert.equal(relativeTime(null), '');
  });
});

describe('visibility defaults', () => {
  it('defaults to private and lists private first', () => {
    assert.equal(DEFAULT_VISIBILITY, 'private');
    assert.equal(TRAIL_VISIBILITY_ORDER[0], 'private');
    assert.equal(TRAIL_VISIBILITY_ORDER[TRAIL_VISIBILITY_ORDER.length - 1], 'public');
  });
  it('covers exactly the seven canonical visibilities', () => {
    assert.deepEqual([...TRAIL_VISIBILITY_ORDER].sort(), [...VISIBILITIES].sort());
  });
});

describe('independent-group party-size signal', () => {
  it('mirrors the api-server PARTY_SIZE_BUCKETS exactly, in order', () => {
    // Byte-for-byte the server enum (src/lib/intelContracts.ts). If the server
    // list changes, this must change with it — the server rejects anything else.
    assert.deepEqual([...PARTY_SIZE_BUCKETS], ['just_me', 'one_other', 'two_to_four', 'five_plus']);
  });
  it('offers exactly one labelled option per bucket, in bucket order', () => {
    assert.deepEqual(PARTY_SIZE_OPTIONS.map((o) => o.value), [...PARTY_SIZE_BUCKETS]);
    for (const o of PARTY_SIZE_OPTIONS) {
      assert.equal(o.label, PARTY_SIZE_LABELS[o.value]);
      assert.ok(o.label.length > 0);
    }
  });
  it('carries the ruling copy (solo reads as "Just me")', () => {
    assert.equal(PARTY_SIZE_LABELS.just_me, 'Just me');
    assert.equal(PARTY_SIZE_LABELS.one_other, '1 other person');
    assert.equal(PARTY_SIZE_LABELS.two_to_four, '2–4 others');
    assert.equal(PARTY_SIZE_LABELS.five_plus, '5+ others');
  });
});

describe('venue question sets present only Phase-1-backed arrival questions', () => {
  it('has every nightlife arrival question wired to submit', () => {
    for (const q of VENUE_QUESTION_SETS.nightlife.arrival) {
      assert.equal(q.phase1, true);
    }
  });
});

describe('prompt-pause scopes', () => {
  const empty: PersistedPromptPause = { pausedAll: false, pausedCategories: [] };
  afterEach(() => setSessionPaused(false));

  it('permanent pause silences everything', () => {
    assert.equal(isPromptPaused({ ...empty, pausedAll: true }, 'nightlife'), true);
  });
  it('per-category pause silences only that category', () => {
    const s = setCategoryPaused(empty, 'nightlife', true);
    assert.equal(isPromptPaused(s, 'nightlife'), true);
    assert.equal(isPromptPaused(s, 'restaurant'), false);
  });
  it('session pause (in-memory) silences regardless of category', () => {
    assert.equal(isSessionPaused(), false);
    setSessionPaused(true);
    assert.equal(isPromptPaused(empty), true);
    assert.equal(isPromptPaused(empty, 'hotel'), true);
  });
});
