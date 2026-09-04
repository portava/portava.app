/**
 * liveTruth tests — the live-truth surface (Map spec §7, §9, §22).
 *
 * These tests are written against the SPEC RULES rather than the current
 * implementation shape, because the rules are the thing that must not regress:
 *
 *   §7   the four axes stay four axes;
 *   §37  a stale claim never renders live, and neither does an unverified one;
 *   §9   the Why? panel never states evidence the object does not carry;
 *   §22  a prompt that cannot describe an object is never offered for it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_LEVELS,
  CONFIDENCE_LABELS,
  type MapObject,
  type MapObjectKind,
  type MapGeometry,
} from '../../../../types/mapObjects.ts';
import {
  ageMsOf,
  activityLabel,
  buildWhyLines,
  buildWhyPanel,
  confidenceLabel,
  contributionPromptsFor,
  createContribution,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_OPTIONS,
  CONTRIBUTION_FRAMING,
  CONTRIBUTION_REWARD_NOTICE,
  freshnessLabel,
  isContributionAllowed,
  isVenueBound,
  NO_EVIDENCE_LINE,
  relativeObservedLabel,
  shouldPulse,
  trendArrow,
  trendLabel,
  updatedAtLabel,
  WHY_PANEL_TITLE,
  type MapContributionKind,
} from '../liveTruth.ts';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-31T22:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO string for "n ms before NOW". */
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

const POINT: MapGeometry = { type: 'Point', coordinates: [108.22, 16.06] };
const POLYGON: MapGeometry = {
  type: 'Polygon',
  coordinates: [[[108.2, 16.0], [108.3, 16.0], [108.3, 16.1], [108.2, 16.1], [108.2, 16.0]]],
};

function obj(over: Partial<MapObject> = {}): MapObject {
  return {
    id: 'obj-1',
    kind: 'place',
    geometry: POINT,
    title: 'Bamboo 2',
    privacyClass: 'place_level',
    renderingPriority: 40,
    ...over,
  };
}

// ── §7 · Freshness ─────────────────────────────────────────────────────────────

describe('freshnessLabel — spec §7 freshness column', () => {
  test('the live band is a state, not an age', () => {
    assert.equal(freshnessLabel('live', ago(3 * MIN), NOW), 'Live');
    // Still "Live" with no timestamp at all — the band is what was asserted.
    assert.equal(freshnessLabel('live', undefined, NOW), 'Live');
  });

  test('recent renders the §7 relative minutes', () => {
    assert.equal(freshnessLabel('recent', ago(2 * MIN), NOW), '2m ago');
    assert.equal(freshnessLabel('aging', ago(8 * MIN), NOW), '8m ago');
  });

  test('falls back to the coarse word when there is no timestamp', () => {
    assert.equal(freshnessLabel('recent', undefined, NOW), 'Recently');
    assert.equal(freshnessLabel('aging', null, NOW), 'Recently');
    assert.equal(freshnessLabel('stale', undefined, NOW), 'Historical');
    assert.equal(freshnessLabel('recent', '   ', NOW), 'Recently');
    assert.equal(freshnessLabel('recent', 'not-a-date', NOW), 'Recently');
  });

  test('historical and unknown are their own words', () => {
    assert.equal(freshnessLabel('historical', ago(2 * MIN), NOW), 'Historical');
    // unknown must NOT borrow "Historical": that would assert an observation
    // happened, which the projection never claimed.
    assert.equal(freshnessLabel('unknown', ago(2 * MIN), NOW), 'Unknown');
    assert.equal(freshnessLabel(undefined, ago(2 * MIN), NOW), 'Unknown');
    assert.equal(freshnessLabel(null, undefined, NOW), 'Unknown');
  });

  test('a stale claim is never phrased as a bare "Nm ago"', () => {
    // 12 minutes old but banded stale (short TTL): "12m ago" would read current.
    assert.equal(freshnessLabel('stale', ago(12 * MIN), NOW), 'Last confirmed 12m ago');
    assert.equal(freshnessLabel('stale', ago(3 * HOUR), NOW), 'Last confirmed 3h ago');
    assert.equal(freshnessLabel('stale', ago(2 * DAY), NOW), 'Historical');
  });

  test('§7 example strings round-trip exactly', () => {
    assert.equal(freshnessLabel('aging', ago(HOUR), NOW), 'Last confirmed 1h ago');
    assert.equal(freshnessLabel('recent', ago(2 * MIN), NOW), '2m ago');
  });
});

describe('relativeObservedLabel — boundaries', () => {
  test('sub-minute rounds UP to 1m — never down toward fresher', () => {
    assert.equal(relativeObservedLabel(ago(0), NOW), '1m ago');
    assert.equal(relativeObservedLabel(ago(1), NOW), '1m ago');
    assert.equal(relativeObservedLabel(ago(MIN - 1), NOW), '1m ago');
  });

  test('minute boundary', () => {
    assert.equal(relativeObservedLabel(ago(MIN), NOW), '1m ago');
    assert.equal(relativeObservedLabel(ago(2 * MIN - 1), NOW), '1m ago');
    assert.equal(relativeObservedLabel(ago(2 * MIN), NOW), '2m ago');
    assert.equal(relativeObservedLabel(ago(59 * MIN), NOW), '59m ago');
    assert.equal(relativeObservedLabel(ago(HOUR - 1), NOW), '59m ago');
  });

  test('hour boundary switches to the "last confirmed" phrasing', () => {
    assert.equal(relativeObservedLabel(ago(HOUR), NOW), 'Last confirmed 1h ago');
    assert.equal(relativeObservedLabel(ago(HOUR + 59 * MIN), NOW), 'Last confirmed 1h ago');
    assert.equal(relativeObservedLabel(ago(2 * HOUR), NOW), 'Last confirmed 2h ago');
    assert.equal(relativeObservedLabel(ago(DAY - 1), NOW), 'Last confirmed 23h ago');
  });

  test('a day or older is Historical', () => {
    assert.equal(relativeObservedLabel(ago(DAY), NOW), 'Historical');
    assert.equal(relativeObservedLabel(ago(9 * DAY), NOW), 'Historical');
  });

  test('clock skew (future timestamp) clamps to the present, not a negative age', () => {
    assert.equal(ageMsOf(new Date(NOW + 5 * MIN).toISOString(), NOW), 0);
    assert.equal(relativeObservedLabel(new Date(NOW + 5 * MIN).toISOString(), NOW), '1m ago');
  });

  test('missing or unparseable timestamps yield null, not a guess', () => {
    assert.equal(relativeObservedLabel(undefined, NOW), null);
    assert.equal(relativeObservedLabel(null, NOW), null);
    assert.equal(relativeObservedLabel('', NOW), null);
    assert.equal(relativeObservedLabel('yesterday-ish', NOW), null);
    assert.equal(ageMsOf(undefined, NOW), null);
  });
});

// ── §7 · Certainty, activity, trend ────────────────────────────────────────────

describe('confidenceLabel — spec §7 certainty column', () => {
  test('mirrors the contract labels, never a second vocabulary', () => {
    assert.equal(confidenceLabel('strong'), CONFIDENCE_LABELS.strong);
    assert.equal(confidenceLabel('live'), CONFIDENCE_LABELS.live);
    assert.equal(confidenceLabel('likely_current'), CONFIDENCE_LABELS.likely_current);
    assert.equal(confidenceLabel('provisional'), CONFIDENCE_LABELS.provisional);
    assert.equal(confidenceLabel('unverified'), CONFIDENCE_LABELS.unverified);
  });

  test('an absent band reads as the weakest one, never as blank', () => {
    assert.equal(confidenceLabel(undefined), 'Unconfirmed');
    assert.equal(confidenceLabel(null), 'Unconfirmed');
  });
});

describe('activity and trend stay separate axes (§7)', () => {
  test('activity label', () => {
    assert.equal(activityLabel('very_busy'), 'Very Busy');
    assert.equal(activityLabel('peak'), 'Peak');
    assert.equal(activityLabel(undefined), null);
  });

  test('trend label', () => {
    assert.equal(trendLabel('getting_busier'), 'Getting busier');
    assert.equal(trendLabel('rapidly_dispersing'), 'Rapidly dispersing');
    assert.equal(trendLabel(null), null);
  });

  test('trend arrows collapse six trends onto three directions', () => {
    assert.equal(trendArrow('increasing_quickly'), '↑');
    assert.equal(trendArrow('getting_busier'), '↑');
    assert.equal(trendArrow('stable'), '→');
    assert.equal(trendArrow('cooling'), '↓');
    assert.equal(trendArrow('getting_quieter'), '↓');
    assert.equal(trendArrow('rapidly_dispersing'), '↓');
  });

  test('no trend is null, not "stable" — absence is not an observation', () => {
    assert.equal(trendArrow(undefined), null);
    assert.equal(trendArrow(null), null);
  });
});

// ── §37 · Pulse eligibility ────────────────────────────────────────────────────

describe('shouldPulse — §37 "do not let stale claims remain visually live"', () => {
  test('fresh AND confident pulses', () => {
    assert.equal(shouldPulse(obj({ freshness: 'live', confidence: 'strong' }), NOW), true);
    assert.equal(shouldPulse(obj({ freshness: 'live', confidence: 'live' }), NOW), true);
    assert.equal(shouldPulse(obj({ freshness: 'recent', confidence: 'strong' }), NOW), true);
  });

  test('stale-but-confident does NOT pulse', () => {
    for (const freshness of ['aging', 'stale', 'historical', 'unknown'] as const) {
      assert.equal(
        shouldPulse(obj({ freshness, confidence: 'strong' }), NOW),
        false,
        `${freshness} + strong must not pulse`,
      );
    }
  });

  test('fresh-but-unverified does NOT pulse', () => {
    for (const confidence of ['unverified', 'provisional', 'likely_current'] as const) {
      assert.equal(
        shouldPulse(obj({ freshness: 'live', confidence }), NOW),
        false,
        `live + ${confidence} must not pulse`,
      );
    }
  });

  test('both axes are independently necessary', () => {
    assert.equal(shouldPulse(obj({ freshness: 'live' }), NOW), false);
    assert.equal(shouldPulse(obj({ confidence: 'strong' }), NOW), false);
    assert.equal(shouldPulse(obj(), NOW), false);
    assert.equal(shouldPulse(null, NOW), false);
    assert.equal(shouldPulse(undefined, NOW), false);
  });

  test('an expired object stops pulsing even while its band still says live', () => {
    const expired = obj({
      freshness: 'live',
      confidence: 'strong',
      expiresAt: new Date(NOW - 1).toISOString(),
    });
    assert.equal(shouldPulse(expired, NOW), false);

    const notYet = obj({
      freshness: 'live',
      confidence: 'strong',
      expiresAt: new Date(NOW + 5 * MIN).toISOString(),
    });
    assert.equal(shouldPulse(notYet, NOW), true);

    // An unparseable expiry must not silently kill a live object either way —
    // it is ignored, and the freshness band remains the authority.
    const junkExpiry = obj({ freshness: 'live', confidence: 'strong', expiresAt: 'soon' });
    assert.equal(shouldPulse(junkExpiry, NOW), true);
  });

  test('a prediction never pulses — §37 forecasts must not look observed', () => {
    assert.equal(
      shouldPulse(obj({ kind: 'prediction', freshness: 'live', confidence: 'strong' }), NOW),
      false,
    );
  });
});

// ── §9 · Why? panel ────────────────────────────────────────────────────────────

describe('buildWhyLines — §9 provenance', () => {
  test('server-supplied lines are used verbatim', () => {
    const lines = buildWhyLines(
      obj({
        provenance: {
          confidence: 'strong',
          lines: [
            { text: 'Several recent traveler reports', ref: 'snap-1' },
            { text: 'Active event nearby' },
          ],
        },
      }),
      NOW,
    );
    assert.deepEqual(lines, [
      { text: 'Several recent traveler reports', ref: 'snap-1' },
      { text: 'Active event nearby' },
    ]);
  });

  test('blank server lines are dropped rather than rendered as empty bullets', () => {
    const lines = buildWhyLines(
      obj({
        provenance: {
          confidence: 'live',
          lines: [{ text: '  ' }, { text: 'Arrival activity increasing' }],
        },
      }),
      NOW,
    );
    assert.deepEqual(lines, [{ text: 'Arrival activity increasing' }]);
  });

  test('an object with no evidence says so — it does not invent any', () => {
    assert.deepEqual(buildWhyLines(obj(), NOW), [{ text: NO_EVIDENCE_LINE }]);
    assert.deepEqual(buildWhyLines(null, NOW), [{ text: NO_EVIDENCE_LINE }]);
    // Empty server line array falls through to synthesis, which finds nothing.
    assert.deepEqual(
      buildWhyLines(obj({ provenance: { confidence: 'unverified', lines: [] } }), NOW),
      [{ text: NO_EVIDENCE_LINE }],
    );
  });

  test('never claims more sources than the object carries', () => {
    const one = buildWhyLines(
      obj({ sourceRefs: ['s1'], freshness: 'live', confidence: 'strong' }),
      NOW,
    );
    assert.deepEqual(one[0], { text: 'One recent traveler report', ref: 's1' });

    const three = buildWhyLines(
      obj({ sourceRefs: ['s1', 's2', 's3'], freshness: 'live', confidence: 'strong' }),
      NOW,
    );
    assert.equal(three[0].text, 'Several recent traveler reports');
    // No single snapshot can stand for three, so no ref is attached.
    assert.equal(three[0].ref, undefined);

    const many = buildWhyLines(
      obj({ sourceRefs: ['a', 'b', 'c', 'd', 'e'], freshness: 'live', confidence: 'strong' }),
      NOW,
    );
    assert.equal(many[0].text, 'Multiple independent recent traveler reports');
  });

  test('sources on a stale object are "earlier", not "recent"', () => {
    const lines = buildWhyLines(obj({ sourceRefs: ['s1'], freshness: 'stale' }), NOW);
    assert.equal(lines[0].text, 'One earlier traveler report');
  });

  test('the evidence verb is capped by the confidence band', () => {
    const strong = buildWhyLines(obj({ activity: 'busy', confidence: 'strong' }), NOW);
    assert.ok(strong.some((l) => l.text === 'Observed activity: Busy'));

    const weak = buildWhyLines(obj({ activity: 'busy', confidence: 'unverified' }), NOW);
    assert.ok(weak.some((l) => l.text === 'Reported activity: Busy'));
    assert.ok(!weak.some((l) => l.text.includes('Observed')));

    const provisional = buildWhyLines(obj({ trend: 'getting_busier', confidence: 'provisional' }), NOW);
    assert.ok(provisional.some((l) => l.text === 'Reported trend: Getting busier'));

    const likely = buildWhyLines(obj({ trend: 'getting_busier', confidence: 'likely_current' }), NOW);
    assert.ok(likely.some((l) => l.text === 'Observed trend: Getting busier'));
  });

  test('synthesized lines never mention an axis the object lacks', () => {
    const lines = buildWhyLines(
      obj({ activity: 'busy', confidence: 'strong', freshness: 'live' }),
      NOW,
    );
    const joined = lines.map((l) => l.text).join(' | ');
    assert.ok(!joined.includes('trend'), joined);
    assert.ok(!joined.includes('traveler report'), joined);
    assert.ok(!joined.includes('Aggregated'), joined);
  });

  test('aggregation and privacy are stated only when true', () => {
    const agg = buildWhyLines(obj({ count: 14, privacyClass: 'aggregate_only' }), NOW);
    const texts = agg.map((l) => l.text);
    assert.ok(texts.includes('Aggregated from 14 nearby objects'));
    assert.ok(texts.includes('Aggregated so no individual is identifiable'));

    const single = buildWhyLines(obj({ count: 1 }), NOW);
    assert.ok(!single.some((l) => l.text.startsWith('Aggregated from')));
  });

  test('a forecast leads with the fact that it is a forecast (§37)', () => {
    const lines = buildWhyLines(
      obj({ kind: 'prediction', activity: 'busy', confidence: 'likely_current' }),
      NOW,
    );
    assert.equal(lines[0].text, 'Predicted from past patterns, not observed');
  });

  test('freshness gets its own line', () => {
    const live = buildWhyLines(obj({ freshness: 'live', confidence: 'strong' }), NOW);
    assert.ok(live.some((l) => l.text === 'Currently live'));

    const aged = buildWhyLines(obj({ freshness: 'aging', observedAt: ago(8 * MIN) }), NOW);
    assert.ok(aged.some((l) => l.text === '8m ago'));

    const old = buildWhyLines(obj({ freshness: 'historical', observedAt: ago(3 * DAY) }), NOW);
    assert.ok(old.some((l) => l.text === 'Historical observation'));
  });

  test('the panel is capped so it stays readable', () => {
    const lines = buildWhyLines(
      obj({
        sourceRefs: ['a', 'b'],
        count: 9,
        activity: 'peak',
        trend: 'increasing_quickly',
        freshness: 'live',
        confidence: 'strong',
        privacyClass: 'aggregate_only',
      }),
      NOW,
    );
    assert.ok(lines.length <= 6, `got ${lines.length}`);
  });
});

describe('buildWhyPanel — the §9 sheet model', () => {
  test('title, updated row and confidence text', () => {
    const model = buildWhyPanel(
      obj({
        confidence: 'live',
        activity: 'very_busy',
        observedAt: ago(6 * MIN),
        provenance: {
          confidence: 'live',
          updatedAt: ago(6 * MIN),
          lines: [{ text: 'Several recent traveler reports' }],
        },
      }),
      NOW,
    );
    assert.equal(model.title, WHY_PANEL_TITLE);
    assert.equal(model.title, 'WHY PORTAVA SAYS THIS');
    assert.equal(model.updated, 'Updated 6 minutes ago');
    assert.equal(model.confidence, 'live');
    assert.equal(model.confidenceText, 'Confidence: Strong signal');
  });

  test('provenance confidence wins over the object band when both exist', () => {
    const model = buildWhyPanel(
      obj({
        confidence: 'strong',
        provenance: { confidence: 'provisional', lines: [{ text: 'One report' }] },
      }),
      NOW,
    );
    assert.equal(model.confidence, 'provisional');
    assert.equal(model.confidenceText, 'Confidence: Limited data');
  });

  test('no timestamp anywhere means no Updated row, not a fabricated one', () => {
    const model = buildWhyPanel(obj(), NOW);
    assert.equal(model.updated, null);
    assert.equal(model.confidenceText, 'Confidence: Unconfirmed');
  });
});

describe('updatedAtLabel — §9 "Updated 6 minutes ago"', () => {
  test('minute/hour/day phrasing and singulars', () => {
    const at = (ms: number) => updatedAtLabel(obj({ observedAt: ago(ms) }), NOW);
    assert.equal(at(0), 'Updated just now');
    assert.equal(at(MIN - 1), 'Updated just now');
    assert.equal(at(MIN), 'Updated 1 minute ago');
    assert.equal(at(6 * MIN), 'Updated 6 minutes ago');
    assert.equal(at(HOUR - 1), 'Updated 59 minutes ago');
    assert.equal(at(HOUR), 'Updated 1 hour ago');
    assert.equal(at(5 * HOUR), 'Updated 5 hours ago');
    assert.equal(at(DAY), 'Updated 1 day ago');
    assert.equal(at(3 * DAY), 'Updated 3 days ago');
  });

  test('prefers provenance.updatedAt over observedAt', () => {
    const label = updatedAtLabel(
      obj({
        observedAt: ago(3 * HOUR),
        provenance: { confidence: 'live', updatedAt: ago(2 * MIN), lines: [] },
      }),
      NOW,
    );
    assert.equal(label, 'Updated 2 minutes ago');
  });

  test('null when nothing to report', () => {
    assert.equal(updatedAtLabel(obj(), NOW), null);
    assert.equal(updatedAtLabel(null, NOW), null);
  });
});

// ── §22 · Contributions ────────────────────────────────────────────────────────

describe('contributionPromptsFor — §22 per-kind rules', () => {
  test('a place takes the premises prompts, and no event status', () => {
    const prompts = contributionPromptsFor(obj({ kind: 'place' }));
    assert.deepEqual(prompts, [
      'crowd_level',
      'queue',
      'entry_access',
      'vibe',
      'closure',
      'media',
    ]);
    assert.ok(!prompts.includes('event_status'));
  });

  test('an activity zone cannot be reported closed — it is an area, not premises', () => {
    const prompts = contributionPromptsFor(obj({ kind: 'activity_zone', geometry: POLYGON }));
    assert.ok(!prompts.includes('closure'));
    assert.ok(!prompts.includes('queue'));
    assert.ok(!prompts.includes('entry_access'));
    assert.deepEqual(prompts, ['crowd_level', 'crowd_direction']);
  });

  test('a venue-bound (Point) event takes queue and entry', () => {
    const prompts = contributionPromptsFor(obj({ kind: 'event', geometry: POINT }));
    assert.ok(prompts.includes('queue'));
    assert.ok(prompts.includes('entry_access'));
    assert.ok(prompts.includes('event_status'));
    // Cancelled is expressed through event_status; a second way to say it would
    // let two contributions contradict each other about one fact.
    assert.ok(!prompts.includes('closure'));
  });

  test('a footprint (Polygon/LineString) event has no single queue', () => {
    for (const geometry of [POLYGON, { type: 'LineString', coordinates: [[108.2, 16.0], [108.3, 16.1]] } as MapGeometry]) {
      const prompts = contributionPromptsFor(obj({ kind: 'event', geometry }));
      assert.ok(!prompts.includes('queue'), 'no queue for a footprint event');
      assert.ok(!prompts.includes('entry_access'), 'no single door for a footprint event');
      assert.ok(prompts.includes('event_status'));
      assert.ok(prompts.includes('crowd_level'));
    }
  });

  test('isVenueBound only discriminates events', () => {
    assert.equal(isVenueBound({ kind: 'event', geometry: POINT }), true);
    assert.equal(isVenueBound({ kind: 'event', geometry: POLYGON }), false);
    assert.equal(isVenueBound({ kind: 'place', geometry: POLYGON }), true);
  });

  test('crowd flow takes direction only', () => {
    assert.deepEqual(
      contributionPromptsFor(obj({ kind: 'crowd_flow', geometry: POLYGON })),
      ['crowd_direction'],
    );
  });

  test('kinds that are not observable physical state take nothing', () => {
    const none: MapObjectKind[] = [
      'prediction',
      'safety_notice',
      'crew_member',
      'buddy_zone',
      'memory',
    ];
    for (const kind of none) {
      assert.deepEqual(contributionPromptsFor(obj({ kind })), [], `${kind} must take no prompts`);
    }
  });

  test('an explicit server gate wins; an absent one is not permission', () => {
    assert.deepEqual(
      contributionPromptsFor(obj({ interaction: { actions: [], contributable: false } })),
      [],
    );
    assert.ok(
      contributionPromptsFor(obj({ interaction: { actions: [], contributable: true } })).length > 0,
    );
    // undefined -> falls through to the kind rules, not to "blocked" and not to
    // "allowed regardless of kind".
    assert.ok(contributionPromptsFor(obj({ interaction: { actions: [] } })).length > 0);
    assert.deepEqual(
      contributionPromptsFor(obj({ kind: 'prediction', interaction: { actions: [], contributable: true } })),
      [],
    );
  });

  test('an object the viewer cannot see takes nothing', () => {
    assert.deepEqual(contributionPromptsFor(obj({ privacyClass: 'none' })), []);
    assert.deepEqual(contributionPromptsFor(null), []);
    assert.deepEqual(contributionPromptsFor(undefined), []);
  });

  test('prompts always come back in §22 order', () => {
    for (const kind of ['place', 'event', 'social_zone', 'meeting_point'] as MapObjectKind[]) {
      const prompts = contributionPromptsFor(obj({ kind }));
      const expected = CONTRIBUTION_KINDS.filter((k) => prompts.includes(k));
      assert.deepEqual(prompts, expected, `${kind} prompt order`);
    }
  });

  test('isContributionAllowed agrees with the prompt list', () => {
    assert.equal(isContributionAllowed(obj({ kind: 'place' }), 'closure'), true);
    assert.equal(isContributionAllowed(obj({ kind: 'activity_zone' }), 'closure'), false);
    assert.equal(isContributionAllowed(obj({ kind: 'event', geometry: POLYGON }), 'queue'), false);
  });
});

describe('contribution options — §22 payload vocabulary', () => {
  test('crowd level reuses the contract activity levels', () => {
    assert.deepEqual(
      CONTRIBUTION_OPTIONS.crowd_level.map((o) => o.value),
      [...ACTIVITY_LEVELS],
    );
    assert.equal(CONTRIBUTION_OPTIONS.crowd_level[5].label, 'Peak');
  });

  test('every prompt has at least two enumerated answers with labels', () => {
    for (const kind of CONTRIBUTION_KINDS) {
      const options = CONTRIBUTION_OPTIONS[kind];
      assert.ok(options.length >= 2, `${kind} needs options`);
      for (const o of options) {
        assert.equal(typeof o.value, 'string');
        assert.ok(o.label.length > 0, `${kind}/${o.value} needs a label`);
      }
    }
  });

  test('the framing copy says observation, and the reward copy denies confidence', () => {
    assert.match(CONTRIBUTION_FRAMING, /not a rating/i);
    assert.match(CONTRIBUTION_REWARD_NOTICE, /never/i);
    assert.match(CONTRIBUTION_REWARD_NOTICE, /confiden/i);
  });
});

describe('createContribution — construction enforces the rules', () => {
  test('builds a valid observation payload', () => {
    const c = createContribution(obj({ kind: 'place' }), 'crowd_level', 'very_busy', { now: NOW });
    assert.deepEqual(c, {
      objectId: 'obj-1',
      objectKind: 'place',
      observedAt: new Date(NOW).toISOString(),
      kind: 'crowd_level',
      value: 'very_busy',
    });
  });

  test('refuses a prompt that is illegal for the kind', () => {
    assert.equal(
      createContribution(obj({ kind: 'activity_zone' }), 'closure', 'open', { now: NOW }),
      null,
    );
    assert.equal(
      createContribution(obj({ kind: 'event', geometry: POLYGON }), 'queue', 'none', { now: NOW }),
      null,
    );
    assert.equal(
      createContribution(obj({ kind: 'prediction' }), 'crowd_level', 'busy', { now: NOW }),
      null,
    );
  });

  test('refuses a value outside the enumerated answers', () => {
    assert.equal(
      createContribution(obj(), 'crowd_level', 'absolutely_rammed', { now: NOW }),
      null,
    );
    assert.equal(createContribution(obj(), 'vibe', '', { now: NOW }), null);
  });

  test('a media contribution without an asset is not an observation', () => {
    const OBS = 'a3f7f6f2-0f2a-4a2b-9f4a-6d3f9c1b2e10';
    assert.equal(createContribution(obj(), 'media', 'photo', { now: NOW, observationId: OBS }), null);
    assert.equal(
      createContribution(obj(), 'media', 'photo', { now: NOW, mediaUri: '   ', observationId: OBS }),
      null,
    );
  });

  test('a media contribution without an observation is not a contribution at all', () => {
    // §21 orders Observation -> Evidence and intel_evidence.observation_id is
    // NOT NULL, so a photo that names no observation asserts nothing and has
    // nowhere to be stored. The server refuses it with that ruling; refusing to
    // CONSTRUCT it is the same rule made structural, so a caller that skipped
    // the observation cannot even build the payload.
    assert.equal(
      createContribution(obj(), 'media', 'photo', { now: NOW, mediaUri: 'post-media/u1/a.jpg' }),
      null,
    );
    assert.equal(
      createContribution(obj(), 'media', 'photo', {
        now: NOW,
        mediaUri: 'post-media/u1/a.jpg',
        observationId: '   ',
      }),
      null,
    );
  });

  test('a media contribution carries the reference and the observation it supports', () => {
    const OBS = 'a3f7f6f2-0f2a-4a2b-9f4a-6d3f9c1b2e10';
    const withAsset = createContribution(obj(), 'media', 'photo', {
      now: NOW,
      // The STORAGE REFERENCE an upload produced — not the device URI, which
      // the server refuses because it cannot prove such a path is ours.
      mediaUri: 'post-media/u1/a.jpg',
      observationId: OBS,
    });
    assert.deepEqual(withAsset, {
      objectId: 'obj-1',
      objectKind: 'place',
      observedAt: new Date(NOW).toISOString(),
      kind: 'media',
      value: 'photo',
      mediaUri: 'post-media/u1/a.jpg',
      observationId: OBS,
    });
    // No coordinate, no claim type, no reward — an artifact asserts nothing.
    assert.deepEqual(
      Object.keys(withAsset as object).sort(),
      ['kind', 'mediaUri', 'objectId', 'objectKind', 'observationId', 'observedAt', 'value'],
    );
  });

  test('carries no reward, score or rating field (§22, §37)', () => {
    const c = createContribution(obj(), 'vibe', 'high_energy', { now: NOW });
    assert.ok(c);
    const keys = Object.keys(c as object);
    for (const forbidden of ['reward', 'rating', 'score', 'stars', 'paid', 'sponsored', 'confidence']) {
      assert.ok(!keys.includes(forbidden), `payload must not carry "${forbidden}"`);
    }
    assert.deepEqual(keys.sort(), ['kind', 'objectId', 'objectKind', 'observedAt', 'value']);
  });

  test('refuses when there is no object to attach the observation to', () => {
    const kinds: MapContributionKind[] = ['crowd_level', 'vibe'];
    for (const kind of kinds) {
      assert.equal(createContribution(null, kind, 'busy', { now: NOW }), null);
    }
  });
});
