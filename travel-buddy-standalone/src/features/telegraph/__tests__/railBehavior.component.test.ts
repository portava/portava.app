/**
 * Telegraph §11.2 — the rail's five behaviours, and §11.1's "See all" rule.
 *
 * Exercises the real `railBehavior.ts`. No component, no network, no mock of
 * the module under test.
 *
 * SHOWN RED before commit, each reverted after:
 *   • return `input.railMode` unconditionally from `resolveRailPresentation`
 *     (drop the scroll branch) → "collapses to MINIMIZED once scrolled" RED.
 *   • drop the `!acknowledged.has(...)` filter → "stops promoting once
 *     acknowledged" RED.
 *   • `return []` from `detectCriticalChanges` when `previous` is present →
 *     both change-detection tests RED.
 *   • RAIL_MAX_CARDS = 99 → "caps the rail and offers See all" RED.
 */
import {
  CRITICAL_STATUSES,
  RAIL_COLLAPSE_SCROLL_PX,
  RAIL_MAX_CARDS,
  detectCriticalChanges,
  resolveRailPresentation,
  shouldCollapseOnScroll,
} from '../sharedContext/railBehavior.ts';
import type {
  SharedContextItem,
  TelegraphSharedContextProjection,
} from '../sharedContext/types.ts';

function item(
  id: string,
  band: SharedContextItem['orderBand'],
  extra: Partial<SharedContextItem> = {},
): SharedContextItem {
  return {
    objectType: 'MEETUP',
    objectId: id,
    title: `Plan ${id}`,
    relationship: 'BOTH_PARTICIPANTS',
    status: 'active',
    availableActions: ['JOIN_PLAN'],
    orderBand: band,
    ...extra,
  };
}

function projection(over: Partial<TelegraphSharedContextProjection> = {}): TelegraphSharedContextProjection {
  return {
    conversationId: 'thread-1',
    generatedAt: '2026-05-10T06:00:00.000Z',
    now: [],
    upcoming: [],
    unresolved: [],
    past: [],
    ...over,
  };
}

describe('§11.2 row 4 — scroll', () => {
  it('collapses only past the threshold, and survives a garbage offset', () => {
    expect(shouldCollapseOnScroll(0)).toBe(false);
    expect(shouldCollapseOnScroll(RAIL_COLLAPSE_SCROLL_PX)).toBe(false);
    expect(shouldCollapseOnScroll(RAIL_COLLAPSE_SCROLL_PX + 1)).toBe(true);
    expect(shouldCollapseOnScroll(Number.NaN)).toBe(false);
  });

  it('collapses to MINIMIZED once scrolled, and messages get the room', () => {
    const p = projection({ now: [item('a', 'HAPPENING_NOW')], upcoming: [item('b', 'UPCOMING')] });
    const r = resolveRailPresentation({
      projection: p,
      railMode: 'EXPANDED_NOW',
      collapsedSummary: '2 shared plans',
      scrolled: true,
    });
    expect(r.mode).toBe('MINIMIZED');
    expect(r.cards).toHaveLength(0);
  });
});

describe('§11.2 rows 1-3 — the condition table', () => {
  it('an active plan renders the expanded NOW card first', () => {
    const p = projection({ now: [item('n', 'HAPPENING_NOW')], upcoming: [item('u', 'UPCOMING')] });
    const r = resolveRailPresentation({ projection: p, railMode: 'EXPANDED_NOW', collapsedSummary: '' });
    expect(r.mode).toBe('EXPANDED_NOW');
    expect(r.cards[0].objectId).toBe('n');
  });

  it('upcoming only renders compact cards', () => {
    const p = projection({ upcoming: [item('u', 'UPCOMING')] });
    const r = resolveRailPresentation({ projection: p, railMode: 'COMPACT_UPCOMING', collapsedSummary: '' });
    expect(r.mode).toBe('COMPACT_UPCOMING');
    expect(r.cards.map((c) => c.objectId)).toEqual(['u']);
  });

  it('neither active nor upcoming renders the summary and no cards', () => {
    const p = projection({ past: [item('p', 'PAST', { objectType: 'TRIP' })] });
    const r = resolveRailPresentation({
      projection: p,
      railMode: 'COLLAPSED_SUMMARY',
      collapsedSummary: '1 past trip',
    });
    expect(r.mode).toBe('COLLAPSED_SUMMARY');
    expect(r.cards).toHaveLength(0);
    expect(r.summary).toBe('1 past trip');
  });
});

describe('§11.1 — horizontal rails are SHORT, with See all', () => {
  it('caps the rail and offers See all for the rest', () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`u${i}`, 'UPCOMING'));
    const r = resolveRailPresentation({
      projection: projection({ upcoming: many }),
      railMode: 'COMPACT_UPCOMING',
      collapsedSummary: '',
    });
    expect(RAIL_MAX_CARDS).toBeLessThanOrEqual(5);
    expect(r.cards).toHaveLength(RAIL_MAX_CARDS);
    expect(r.seeAllCount).toBe(9 - RAIL_MAX_CARDS);
  });

  it('hides See all when everything already fits', () => {
    const r = resolveRailPresentation({
      projection: projection({ upcoming: [item('u', 'UPCOMING')] }),
      railMode: 'COMPACT_UPCOMING',
      collapsedSummary: '',
    });
    expect(r.seeAllCount).toBe(0);
  });
});

describe('§11.2 row 5 — critical change, promoted until acknowledged', () => {
  const before = projection({ upcoming: [item('m', 'UPCOMING', { status: 'active', startsAt: '2026-05-11T18:00:00.000Z' })] });

  it('the FIRST load promotes nothing — there is no change yet', () => {
    const changes = detectCriticalChanges(null, before);
    expect(changes).toEqual([]);
  });

  it('detects a cancellation', () => {
    const after = projection({ upcoming: [item('m', 'UPCOMING', { status: 'cancelled', startsAt: '2026-05-11T18:00:00.000Z' })] });
    const changes = detectCriticalChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].reason).toBe('CANCELLED');
    expect(CRITICAL_STATUSES).toContain('cancelled');
  });

  it('detects a moved start time', () => {
    const after = projection({ upcoming: [item('m', 'UPCOMING', { status: 'active', startsAt: '2026-05-11T21:30:00.000Z' })] });
    const changes = detectCriticalChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].reason).toBe('TIME_CHANGED');
  });

  it('ignores a routine edit that is neither', () => {
    const after = projection({ upcoming: [item('m', 'UPCOMING', { status: 'active', startsAt: '2026-05-11T18:00:00.000Z', title: 'Renamed' })] });
    expect(detectCriticalChanges(before, after)).toEqual([]);
  });

  it('promotes the change even while scrolled — a scroll must not silence it', () => {
    const after = projection({ upcoming: [item('m', 'UPCOMING', { status: 'cancelled' })] });
    const changes = detectCriticalChanges(before, after);
    const r = resolveRailPresentation({
      projection: after,
      railMode: 'COMPACT_UPCOMING',
      collapsedSummary: '',
      scrolled: true,
      criticalChanges: changes,
    });
    expect(r.promotedChange?.objectId).toBe('m');
    expect(r.mode).not.toBe('MINIMIZED');
  });

  it('stops promoting once acknowledged, and only that change', () => {
    const after = projection({
      upcoming: [
        item('m', 'UPCOMING', { status: 'cancelled' }),
        item('n', 'UPCOMING', { status: 'cancelled' }),
      ],
    });
    const beforeTwo = projection({
      upcoming: [item('m', 'UPCOMING'), item('n', 'UPCOMING')],
    });
    const changes = detectCriticalChanges(beforeTwo, after);
    expect(changes).toHaveLength(2);

    const first = resolveRailPresentation({
      projection: after, railMode: 'COMPACT_UPCOMING', collapsedSummary: '', criticalChanges: changes,
    });
    expect(first.promotedChange?.objectId).toBe('m');

    const second = resolveRailPresentation({
      projection: after, railMode: 'COMPACT_UPCOMING', collapsedSummary: '', criticalChanges: changes,
      acknowledgedChangeKeys: [first.promotedChange!.changeKey],
    });
    expect(second.promotedChange?.objectId).toBe('n');

    const third = resolveRailPresentation({
      projection: after, railMode: 'COMPACT_UPCOMING', collapsedSummary: '', criticalChanges: changes,
      acknowledgedChangeKeys: changes.map((c) => c.changeKey),
    });
    expect(third.promotedChange).toBeNull();
  });
});

describe('an incomplete rail says so', () => {
  it('carries the server flag through, so the surface can distinguish unknown from empty', () => {
    const r = resolveRailPresentation({
      projection: projection({ upcoming: [item('u', 'UPCOMING')] }),
      railMode: 'COMPACT_UPCOMING',
      collapsedSummary: '',
      incomplete: true,
    });
    expect(r.incomplete).toBe(true);
  });
});
