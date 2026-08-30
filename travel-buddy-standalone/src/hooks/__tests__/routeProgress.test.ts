/**
 * deriveRouteProgress — useRoutePlan derived-state math.
 *
 * Imports the SHIPPED deriveRouteProgress from ../routeProgress.ts (the same
 * module useRoutePlan uses), so these bind to real product logic. The previous
 * test in artifacts/api-server re-implemented `deriveProgress` inline and never
 * loaded the hook, so a change to the derived state would not have been caught.
 *
 * Run: node --import tsx/esm --test src/hooks/__tests__/routeProgress.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveRouteProgress } from '../routeProgress.ts';

type StopStatus = 'pending' | 'arrived' | 'skipped' | 'cancelled';
interface Stop { id: string; orderIndex: number; checkpointStatus: StopStatus; }

const s = (id: string, orderIndex: number, checkpointStatus: StopStatus): Stop =>
  ({ id, orderIndex, checkpointStatus });

test('empty list → all-zero progress, null nextStop', () => {
  const p = deriveRouteProgress<Stop>([]);
  assert.equal(p.completedCount, 0);
  assert.equal(p.totalCount, 0);
  assert.equal(p.progressFraction, 0);
  assert.equal(p.nextStop, null);
});

test('completedCount counts only arrived stops', () => {
  const p = deriveRouteProgress([
    s('a', 0, 'arrived'),
    s('b', 1, 'pending'),
    s('c', 2, 'arrived'),
    s('d', 3, 'skipped'),
  ]);
  assert.equal(p.completedCount, 2);
  assert.equal(p.totalCount, 4);
});

test('skipped and cancelled stops do not count toward completedCount', () => {
  const p = deriveRouteProgress([
    s('a', 0, 'skipped'),
    s('b', 1, 'cancelled'),
    s('c', 2, 'arrived'),
  ]);
  assert.equal(p.completedCount, 1);
});

test('progressFraction is completedCount / totalCount', () => {
  const p = deriveRouteProgress([
    s('a', 0, 'arrived'),
    s('b', 1, 'arrived'),
    s('c', 2, 'pending'),
    s('d', 3, 'pending'),
  ]);
  assert.equal(p.progressFraction, 0.5);
});

test('nextStop is the first pending stop', () => {
  const p = deriveRouteProgress([
    s('a', 0, 'arrived'),
    s('b', 1, 'pending'),
    s('c', 2, 'pending'),
  ]);
  assert.equal(p.nextStop?.id, 'b');
});

test('nextStop is null when no stop is pending', () => {
  const p = deriveRouteProgress([
    s('a', 0, 'arrived'),
    s('b', 1, 'skipped'),
  ]);
  assert.equal(p.nextStop, null);
});
