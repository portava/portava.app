import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  presenceIsCurrent, presenceFreshnessState, presenceAgeLabel, presenceLine, presenceAccessibleLabel, crewPresenceBuckets,
} from '../presence.ts';

const NOW = Date.parse('2026-09-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test('only LIVE and RECENT are current; a missing class is not (fail closed)', () => {
  assert.equal(presenceIsCurrent({ freshnessClass: 'LIVE' }), true);
  assert.equal(presenceIsCurrent({ freshnessClass: 'RECENT' }), true);
  assert.equal(presenceIsCurrent({ freshnessClass: 'LAST_KNOWN' }), false);
  assert.equal(presenceIsCurrent({ freshnessClass: 'OFFLINE' }), false);
  assert.equal(presenceIsCurrent({}), false);
});

test('the Map vocabulary follows the class, and an absent class is unknown, not stale', () => {
  assert.equal(presenceFreshnessState({ freshnessClass: 'LIVE' }), 'live');
  assert.equal(presenceFreshnessState({ freshnessClass: 'RECENT' }), 'recent');
  assert.equal(presenceFreshnessState({ freshnessClass: 'LAST_KNOWN' }), 'stale');
  assert.equal(presenceFreshnessState({ freshnessClass: 'OFFLINE' }), 'stale');
  assert.equal(presenceFreshnessState({}), 'unknown');
});

test('the age label is minutes, hours, then days, and null without an instant', () => {
  assert.equal(presenceAgeLabel(ago(20_000), NOW), '1m ago');
  assert.equal(presenceAgeLabel(ago(7 * 60_000), NOW), '7m ago');
  assert.equal(presenceAgeLabel(ago(3 * 3600_000 + 5), NOW), '3h ago');
  assert.equal(presenceAgeLabel(ago(2 * 86_400_000), NOW), '2d ago');
  assert.equal(presenceAgeLabel(null, NOW), null);
  assert.equal(presenceAgeLabel('not a date', NOW), null);
});

test('the presence line is the SERVER\'s class in words with its age; a grant over a stale fix reads "Last known", never "Live"', () => {
  const grantOverStale = { freshnessClass: 'LAST_KNOWN' as const, observedAt: ago(3 * 3600_000), liveShareActive: true, exactCoords: null };
  assert.equal(presenceLine(grantOverStale, NOW), 'Last known · 3h ago');
  assert.equal(presenceLine({ freshnessClass: 'LIVE', observedAt: ago(2 * 60_000), liveShareActive: true, exactCoords: { lat: 1, lng: 2 } }, NOW), 'Live · 2m ago');
  assert.equal(presenceLine({ freshnessClass: 'RECENT', observedAt: ago(20 * 60_000), liveShareActive: false, exactCoords: null }, NOW), 'Recent · 20m ago');
  assert.equal(presenceLine({ freshnessClass: 'OFFLINE', observedAt: ago(60_000), liveShareActive: false, exactCoords: null }, NOW), 'Offline');
  // No class from the server: nothing is said. This is the fail-closed half.
  assert.equal(presenceLine({ observedAt: ago(60_000), liveShareActive: true, exactCoords: null }, NOW), null);
});

test('the accessible label carries the name and the line, and admits an unknown age under a grant', () => {
  assert.equal(
    presenceAccessibleLabel('Mai', { freshnessClass: 'LIVE', observedAt: ago(60_000), liveShareActive: true, exactCoords: { lat: 1, lng: 2 } }, NOW),
    'Mai, Live · 1m ago',
  );
  assert.equal(
    presenceAccessibleLabel('Mai', { freshnessClass: 'LAST_KNOWN', observedAt: ago(5 * 3600_000), liveShareActive: true, exactCoords: null }, NOW),
    'Mai, Last known · 5h ago',
  );
  assert.equal(presenceAccessibleLabel('Mai', { liveShareActive: true, exactCoords: null }, NOW), 'Mai, sharing location, position age unknown');
  assert.equal(presenceAccessibleLabel('Mai', { liveShareActive: false, exactCoords: null }, NOW), 'Mai');
});

test('the density buckets put a share over a stale fix under "last known", never "live"', () => {
  const b = crewPresenceBuckets([
    { statusLabel: 'live_sharing_active' as const, liveShareActive: true, freshnessClass: 'LIVE' as const },
    { statusLabel: 'live_sharing_active' as const, liveShareActive: true, freshnessClass: 'LAST_KNOWN' as const },
    { statusLabel: 'live_sharing_active' as const, liveShareActive: true },
    { statusLabel: 'arrived' as const, liveShareActive: false, freshnessClass: 'RECENT' as const },
    { statusLabel: 'not_shared' as const, liveShareActive: false },
  ]);
  assert.equal(b.live.length, 1);
  assert.equal(b.lastKnown.length, 2);
  assert.equal(b.arrived.length, 1);
  assert.equal(b.active.length, 4);
});
