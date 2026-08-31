/**
 * livePlaceModel tests — Map spec §8 / §9.
 *
 * The contract under test is "absence is a value":
 *   - each §8 section is null when the inputs do not support it;
 *   - nothing is ever filled in with a plausible default (a place with no live
 *     claim must NOT read "Quiet");
 *   - WHY SHOWN never claims a reason whose input is missing;
 *   - SOCIAL respects privacyClass — aggregate_only can never yield identified
 *     friends, however many the detail payload supplies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  point,
  RENDERING_PRIORITY,
  type MapObject,
  type PrivacyClass,
} from '../../../../types/mapObjects.ts';
import {
  buildLivePlaceView,
  formatDistanceLabel,
  formatPriceLabel,
  formatQueueLabel,
  formatUpdatedLabel,
  hasStrongLiveActivity,
  isSectionMissing,
  liveStateHeadline,
  missingReason,
  orderedActions,
  placeMetaLine,
  whyShownLines,
  type LivePlaceContext,
  type LivePlaceDetail,
} from '../livePlaceModel.ts';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');
const ago = (mins: number) => new Date(NOW - mins * 60_000).toISOString();

/** The barest legal object: renderable, and claiming nothing else. */
function bareObject(over: Partial<MapObject> = {}): MapObject {
  return {
    id: 'p1',
    kind: 'place',
    geometry: point(16.06, 108.22),
    title: 'Bến Cafe',
    privacyClass: 'place_level',
    renderingPriority: RENDERING_PRIORITY.relevant_place,
    ...over,
  };
}

function ctx(over: Partial<LivePlaceContext> = {}): LivePlaceContext {
  return { now: NOW, ...over };
}

// ── Renderability gate ────────────────────────────────────────────────────────

describe('renderability', () => {
  it('returns null for an object that must never render', () => {
    assert.equal(buildLivePlaceView(bareObject({ privacyClass: 'none' }), null, ctx()), null);
    assert.equal(buildLivePlaceView(bareObject({ title: '   ' }), null, ctx()), null);
  });

  it('builds a model for a bare but renderable object', () => {
    const vm = buildLivePlaceView(bareObject(), null, ctx());
    assert.ok(vm);
    assert.equal(vm.title, 'Bến Cafe');
  });
});

// ── Every section independently optional ──────────────────────────────────────

describe('sections are independently optional', () => {
  it('yields nothing but identity when the inputs support nothing', () => {
    const vm = buildLivePlaceView(bareObject(), null, ctx())!;
    assert.equal(vm.liveState, null);
    assert.equal(vm.crowd, null);
    assert.equal(vm.social, null);
    assert.equal(vm.access, null);
    assert.equal(vm.provenance, null);
    assert.deepEqual(vm.whyShown, []);
    assert.deepEqual(vm.actions, []);
    assert.equal(vm.heroPhotoUrl, null);
    assert.equal(vm.placeType, null);
    assert.equal(vm.distanceLabel, null);
  });

  it('states what is missing, with a reason, instead of staying silent', () => {
    const vm = buildLivePlaceView(bareObject(), null, ctx())!;
    const sections = vm.missing.map((m) => m.section).sort();
    assert.deepEqual(sections, [
      'access',
      'actions',
      'crowd',
      'hero',
      'live_state',
      'provenance',
      'social',
      'why_shown',
    ]);
    for (const m of vm.missing) {
      assert.ok(m.reason.length > 0, `${m.section} is missing without a reason`);
    }
    assert.ok(isSectionMissing(vm, 'live_state'));
    assert.match(missingReason(vm, 'live_state') ?? '', /No live activity/);
  });

  it('builds ONLY the sections its inputs support — access without live state', () => {
    const detail: LivePlaceDetail = { queueMinutes: 20, openUntil: '1:30 AM', priceLevel: 3 };
    const vm = buildLivePlaceView(bareObject(), detail, ctx())!;
    assert.deepEqual(vm.access, {
      queueLabel: 'Queue ~20 min',
      openUntilLabel: 'Open until 1:30 AM',
      priceLabel: '$$$',
    });
    assert.equal(vm.liveState, null, 'access data must not conjure a live state');
    assert.equal(vm.social, null);
  });

  it('builds a partial access section from one field', () => {
    const vm = buildLivePlaceView(bareObject(), { priceLevel: 2 }, ctx())!;
    assert.deepEqual(vm.access, { queueLabel: null, openUntilLabel: null, priceLabel: '$$' });
    assert.equal(isSectionMissing(vm, 'access'), false);
  });

  it('builds the full §8 example when everything is supplied', () => {
    const obj = bareObject({
      activity: 'very_busy',
      trend: 'getting_busier',
      freshness: 'live',
      confidence: 'strong',
      observedAt: ago(4),
      distanceKm: 0.4,
      interaction: { actions: ['share', 'navigate', 'save', 'ask_compass', 'add_to_trip', 'meet_here'] },
      provenance: {
        lines: [{ text: 'Several recent traveler reports' }],
        confidence: 'strong',
        updatedAt: ago(6),
      },
    });
    const detail: LivePlaceDetail = {
      heroPhotoUrl: 'https://example.test/hero.jpg',
      placeType: 'Bar',
      vibe: 'High energy',
      friendsHereCount: 3,
      travelersInterestedCount: 12,
      queueMinutes: 20,
      openUntil: '1:30 AM',
      priceLevel: 3,
    };
    const vm = buildLivePlaceView(obj, detail, ctx({
      intent: { label: 'Nightlife', matched: true },
      crewNearbyCount: 2,
    }))!;

    assert.equal(liveStateHeadline(vm.liveState), 'Very Busy · Getting busier');
    assert.equal(vm.liveState?.updatedLabel, 'Updated 4 min ago');
    assert.equal(vm.liveState?.confidenceLabel, 'Confirmed');
    assert.equal(vm.liveState?.isLive, true);
    assert.equal(placeMetaLine(vm), 'Bar · 400 m away');
    assert.equal(vm.crowd?.vibeLabel, 'High energy');
    assert.equal(vm.social?.friendsHereLabel, '3 friends here');
    assert.equal(vm.social?.travelersInterestedLabel, '12 travelers interested');
    assert.equal(vm.access?.queueLabel, 'Queue ~20 min');
    // §8's ACTIONS row order: Go · Save · Ask Compass · Add to Trip · Meet Here · Share
    assert.deepEqual(vm.actions, ['navigate', 'save', 'ask_compass', 'add_to_trip', 'meet_here', 'share']);
    assert.deepEqual(vm.whyShown.map((l) => l.code), ['matches_intent', 'crew_nearby', 'strong_live_activity']);
    assert.deepEqual(vm.missing, []);
  });
});

// ── No fabricated defaults ────────────────────────────────────────────────────

describe('no fabricated defaults', () => {
  it('does NOT read "Quiet" when there is no live claim', () => {
    const vm = buildLivePlaceView(bareObject(), null, ctx())!;
    const blob = JSON.stringify(vm);
    for (const invented of ['Quiet', 'Moderate', 'Stable', 'Unconfirmed']) {
      assert.equal(blob.includes(invented), false, `fabricated "${invented}" out of nothing`);
    }
    assert.equal(vm.liveState, null);
    assert.equal(vm.crowd, null);
  });

  it('does not invent a trend when only a level was observed', () => {
    const vm = buildLivePlaceView(
      bareObject({ activity: 'busy', freshness: 'live', observedAt: ago(2) }),
      null,
      ctx(),
    )!;
    assert.equal(vm.liveState?.trend, null);
    assert.equal(vm.liveState?.trendLabel, null);
    assert.equal(liveStateHeadline(vm.liveState), 'Busy');
  });

  it('does not invent a confidence band when none was supplied', () => {
    const vm = buildLivePlaceView(
      bareObject({ activity: 'busy', freshness: 'recent', observedAt: ago(9) }),
      null,
      ctx(),
    )!;
    assert.equal(vm.liveState?.confidence, null);
    assert.equal(vm.liveState?.confidenceLabel, null);
  });

  it('refuses to present a stale or untimestamped reading as a live state (§37)', () => {
    for (const freshness of ['stale', 'unknown'] as const) {
      const vm = buildLivePlaceView(
        bareObject({ activity: 'peak', trend: 'stable', freshness, observedAt: ago(400) }),
        null,
        ctx(),
      )!;
      assert.equal(vm.liveState, null, `${freshness} rendered as a live state`);
      assert.ok(isSectionMissing(vm, 'live_state'));
      // The last-known reading is still reachable, plainly labelled, in CROWD.
      assert.equal(vm.crowd?.crowdLabel, 'Peak');
    }
  });

  it('never pulses an aging reading', () => {
    const vm = buildLivePlaceView(
      bareObject({ activity: 'busy', freshness: 'aging', observedAt: ago(45) }),
      null,
      ctx(),
    )!;
    assert.equal(vm.liveState?.isLive, false);
    assert.equal(vm.liveState?.updatedLabel, 'Last confirmed 45 min ago');
  });

  it('offers no actions when the object declares none, rather than a default set', () => {
    assert.deepEqual(orderedActions(bareObject()), []);
    assert.deepEqual(orderedActions(bareObject({ interaction: { actions: [] } })), []);
    assert.deepEqual(orderedActions(bareObject({ interaction: { actions: ['save', 'save', 'navigate'] } })), [
      'navigate',
      'save',
    ]);
  });

  it('drops an empty provenance envelope rather than showing an empty Why?', () => {
    const vm = buildLivePlaceView(
      bareObject({ provenance: { lines: [], confidence: 'strong' } }),
      null,
      ctx(),
    )!;
    assert.equal(vm.provenance, null);
    assert.ok(isSectionMissing(vm, 'provenance'));
  });

  it('treats blank strings as absent, not as content', () => {
    const vm = buildLivePlaceView(
      bareObject({ subtitle: '  ' }),
      { heroPhotoUrl: '  ', placeType: '', vibe: '   ', openUntil: '' },
      ctx(),
    )!;
    assert.equal(vm.heroPhotoUrl, null);
    assert.equal(vm.placeType, null);
    assert.equal(vm.subtitle, null);
    assert.equal(vm.crowd, null);
    assert.equal(vm.access, null);
  });
});

// ── WHY SHOWN never claims an unsupported reason ──────────────────────────────

describe('§8 WHY SHOWN', () => {
  it('emits nothing when the context supports nothing', () => {
    assert.deepEqual(whyShownLines(bareObject(), ctx()), []);
  });

  it('never claims "Matches current intent" without a matched intent', () => {
    assert.deepEqual(whyShownLines(bareObject(), ctx({ intent: null })), []);
    assert.deepEqual(whyShownLines(bareObject(), ctx({ intent: { label: 'Nightlife', matched: false } })), []);
    assert.deepEqual(whyShownLines(bareObject(), ctx({ intent: { label: '  ', matched: true } })), []);

    const matched = whyShownLines(bareObject(), ctx({ intent: { label: 'Nightlife', matched: true } }));
    assert.deepEqual(matched, [{ code: 'matches_intent', text: 'Matches current intent · Nightlife' }]);
  });

  it('never claims "Crew nearby" without crew nearby', () => {
    assert.deepEqual(whyShownLines(bareObject(), ctx({ crewNearbyCount: 0 })), []);
    assert.deepEqual(whyShownLines(bareObject(), ctx({ crewNearbyCount: null })), []);
    assert.deepEqual(whyShownLines(bareObject(), ctx({ crewNearbyCount: 1 })), [
      { code: 'crew_nearby', text: 'Crew nearby' },
    ]);
    assert.equal(whyShownLines(bareObject(), ctx({ crewNearbyCount: 3 }))[0].text, 'Crew nearby · 3 members');
  });

  it('requires activity AND confidence AND freshness for "Strong live activity"', () => {
    const strong = { activity: 'very_busy', confidence: 'strong', freshness: 'live' } as const;
    assert.equal(hasStrongLiveActivity(bareObject(strong)), true);

    // Busy enough, confident enough — but the reading is old.
    assert.equal(hasStrongLiveActivity(bareObject({ ...strong, freshness: 'aging' })), false);
    // Fresh and busy — but the system is not confident.
    assert.equal(hasStrongLiveActivity(bareObject({ ...strong, confidence: 'provisional' })), false);
    // Fresh and confident — but the place is not busy.
    assert.equal(hasStrongLiveActivity(bareObject({ ...strong, activity: 'quiet' })), false);
    // No axes at all.
    assert.equal(hasStrongLiveActivity(bareObject()), false);

    assert.deepEqual(whyShownLines(bareObject({ ...strong, freshness: 'aging' }), ctx()), []);
    assert.deepEqual(whyShownLines(bareObject(strong), ctx()), [
      { code: 'strong_live_activity', text: 'Strong live activity' },
    ]);
  });

  it('emits reasons in §8 order and only the supported ones', () => {
    const lines = whyShownLines(
      bareObject({ activity: 'peak', confidence: 'live', freshness: 'recent' }),
      ctx({ intent: { label: 'Food', matched: false }, crewNearbyCount: 2 }),
    );
    assert.deepEqual(lines.map((l) => l.code), ['crew_nearby', 'strong_live_activity']);
  });
});

// ── SOCIAL respects privacyClass (§23) ────────────────────────────────────────

describe('§23 social privacy', () => {
  const detail: LivePlaceDetail = { friendsHereCount: 3, travelersInterestedCount: 12 };

  it('yields NO identified friends at aggregate_only, however many are supplied', () => {
    for (const cls of ['aggregate_only'] as PrivacyClass[]) {
      const vm = buildLivePlaceView(bareObject({ privacyClass: cls }), detail, ctx())!;
      assert.equal(vm.social?.friendsHere, null, `${cls} leaked an identified friend count`);
      assert.equal(vm.social?.friendsHereLabel, null);
      assert.equal(vm.social?.suppressed, true);
      // The aggregate half is still permitted.
      assert.equal(vm.social?.travelersInterested, 12);
      assert.equal(JSON.stringify(vm).includes('3 friends'), false);
    }
  });

  it('omits SOCIAL entirely when the only signal was privacy-suppressed', () => {
    const vm = buildLivePlaceView(
      bareObject({ privacyClass: 'aggregate_only' }),
      { friendsHereCount: 3 },
      ctx(),
    )!;
    assert.equal(vm.social, null);
    assert.match(missingReason(vm, 'social') ?? '', /aggregate only/i);
  });

  it('permits identified friends at approximate and above', () => {
    for (const cls of ['approximate', 'place_level', 'precise_temporary'] as PrivacyClass[]) {
      const vm = buildLivePlaceView(bareObject({ privacyClass: cls }), detail, ctx())!;
      assert.equal(vm.social?.friendsHere, 3, `${cls} should permit identity`);
      assert.equal(vm.social?.friendsHereLabel, '3 friends here');
      assert.equal(vm.social?.suppressed, false);
    }
  });

  it('singularises counts and drops zero/negative/garbage counts', () => {
    const one = buildLivePlaceView(
      bareObject(),
      { friendsHereCount: 1, travelersInterestedCount: 1 },
      ctx(),
    )!;
    assert.equal(one.social?.friendsHereLabel, '1 friend here');
    assert.equal(one.social?.travelersInterestedLabel, '1 traveler interested');

    const none = buildLivePlaceView(
      bareObject(),
      { friendsHereCount: 0, travelersInterestedCount: -4 },
      ctx(),
    )!;
    assert.equal(none.social, null);

    const junk = buildLivePlaceView(
      bareObject(),
      { friendsHereCount: Number.NaN, travelersInterestedCount: Number.POSITIVE_INFINITY },
      ctx(),
    )!;
    assert.equal(junk.social, null);
  });
});

// ── Formatters ────────────────────────────────────────────────────────────────

describe('formatters', () => {
  it('formats §7 freshness differently for live and non-live readings', () => {
    assert.equal(formatUpdatedLabel(ago(4), NOW, 'live'), 'Updated 4 min ago');
    assert.equal(formatUpdatedLabel(ago(0), NOW, 'recent'), 'Updated just now');
    assert.equal(formatUpdatedLabel(ago(90), NOW, 'aging'), 'Last confirmed 1h ago');
    assert.equal(formatUpdatedLabel(ago(60 * 30), NOW, 'stale'), 'Last confirmed 1d ago');
    assert.equal(formatUpdatedLabel(ago(120), NOW, 'historical'), 'Observed 2h ago');
    assert.equal(formatUpdatedLabel(null, NOW, 'live'), null);
    assert.equal(formatUpdatedLabel('not a date', NOW, 'live'), null);
  });

  it('does not read a future timestamp as a fresher observation', () => {
    const future = new Date(NOW + 10 * 60_000).toISOString();
    assert.equal(formatUpdatedLabel(future, NOW, 'live'), 'Updated just now');
  });

  it('formats distance without faking precision', () => {
    assert.equal(formatDistanceLabel(0.4), '400 m away');
    assert.equal(formatDistanceLabel(0.004), 'Right here');
    assert.equal(formatDistanceLabel(1.25), '1.3 km away');
    assert.equal(formatDistanceLabel(42.4), '42 km away');
    assert.equal(formatDistanceLabel(null), null);
    assert.equal(formatDistanceLabel(-1), null);
    assert.equal(formatDistanceLabel(Number.NaN), null);
  });

  it('formats price only for a real 1-4 level', () => {
    assert.equal(formatPriceLabel(1), '$');
    assert.equal(formatPriceLabel(4), '$$$$');
    assert.equal(formatPriceLabel(0), null);
    assert.equal(formatPriceLabel(5), null);
    assert.equal(formatPriceLabel(2.5), null);
    assert.equal(formatPriceLabel(null), null);
  });

  it('formats queue, distinguishing "no queue" from "unknown"', () => {
    assert.equal(formatQueueLabel(20), 'Queue ~20 min');
    assert.equal(formatQueueLabel(0), 'No queue');
    assert.equal(formatQueueLabel(null), null);
    assert.equal(formatQueueLabel(-3), null);
  });

  it('builds the meta line from whichever halves exist', () => {
    const withType = buildLivePlaceView(bareObject({ distanceKm: null }), { placeType: 'Bar' }, ctx())!;
    assert.equal(placeMetaLine(withType), 'Bar');
    const withDistance = buildLivePlaceView(bareObject({ distanceKm: 2 }), null, ctx())!;
    assert.equal(placeMetaLine(withDistance), '2.0 km away');
    assert.equal(placeMetaLine(buildLivePlaceView(bareObject(), null, ctx())!), null);
  });
});
