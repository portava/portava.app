import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { routedEnvelopeOf, routedMapState, routingTermsExist, projectRoutedPoint } from '../layoverRoutedMap.ts';

const SNAP = `snap:${'a'.repeat(32)}`;
const NOW = Date.parse('2026-10-19T09:00:00Z');
test('routed map refuses absent, unversioned, different-version and expired answers', () => {
  assert.equal(routedMapState(null, SNAP, NOW), 'unavailable');
  const data = { snapshotId: SNAP, envelope: null, cards: [] };
  assert.equal(routedMapState({ ...data, snapshotId: null }, SNAP, NOW), 'unavailable');
  assert.equal(routedMapState(data, `snap:${'b'.repeat(32)}`, NOW), 'superseded');
  assert.equal(routedMapState({ ...data, envelope: { expiresAt: new Date(NOW - 1).toISOString() } as any }, SNAP, NOW), 'stale');
});
test('a routing absence never becomes zero or a legacy travel-time label', () => {
  assert.equal(routingTermsExist({ state: 'UNMEASURED', absence: 'PROVIDER_REJECTED', outboundMinutes: 0 } as any), false);
  assert.equal(routingTermsExist({ state: 'FEASIBLE', absence: null, outboundMinutes: 12, conservativeReturnMinutes: 28 } as any), true);
  assert.equal(routingTermsExist({ state: 'UNMEASURED', absence: 'experience_unstated', outboundMinutes: 12, conservativeReturnMinutes: 28 } as any), true);
  assert.equal(routedEnvelopeOf({ basis: 'routed_union', polygonInteriorCertified: true }), null);
});
test('display geometry contracts at an unchanged scale; it does not assign reachability', () => {
  const centre = { lat: 25, lng: 121 };
  const outer = projectRoutedPoint({ lat: 25.1, lng: 121 }, centre, 100, 240);
  const inner = projectRoutedPoint({ lat: 25.05, lng: 121 }, centre, 100, 240);
  assert.ok(Math.abs(inner.y - 120) < Math.abs(outer.y - 120));
});
test('client map uses server bands and never imports or recreates the feasibility formula', () => {
  for (const path of ['../../components/layover/LayoverRoutedMapPanel.tsx', '../layoverRoutedMap.ts']) {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/__tests__', path), 'utf8');
    assert.doesNotMatch(source, /bandCandidate|judgeRoutedCandidate|conservativeReturnMinutes\s*\(|outboundMinutes\s*\+|slackMinutes\s*[<>]/);
  }
});

// ── Which overview snapshot the routed map may be compared with (2026-10-22) ──
// With layover_canonical_snapshot_enabled off (production) both ids are new on every read, so comparing them always
// said "superseded": the map was dropped and the panel read "The plan has changed" with the return route hidden.
import { comparableOverviewSnapshotId } from '../layoverRoutedMap.ts';

test('canonical snapshot off (production): no comparison — an older server that does not say counts as off', () => {
  assert.equal(comparableOverviewSnapshotId({ snapshotId: 'snap:overview-read-2', snapshotComparable: false }), null);
  assert.equal(comparableOverviewSnapshotId({ snapshotId: 'snap:overview-read-2' }), null);
  assert.equal(comparableOverviewSnapshotId(null), null);
});

test('canonical snapshot on: the id is compared as before', () => {
  assert.equal(comparableOverviewSnapshotId({ snapshotId: SNAP, snapshotComparable: true }), SNAP);
});

test('end to end through routedMapState: per-read ids are "superseded" only when comparable', () => {
  const routed = { snapshotId: `snap:${'b'.repeat(32)}`, cards: [], envelope: null };
  assert.notEqual(routedMapState(routed, comparableOverviewSnapshotId({ snapshotId: SNAP, snapshotComparable: false }), NOW), 'superseded');
  assert.equal(routedMapState(routed, comparableOverviewSnapshotId({ snapshotId: SNAP, snapshotComparable: true }), NOW), 'superseded');
});
