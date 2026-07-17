/**
 * Focus-TTL guard for the Events tab (app/(tabs)/events.tsx).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/events.focusTtl.test.ts
 *
 * ## Why this test exists
 *
 * The Events tab uses a TTL-gated useFocusEffect so the list is only reloaded
 * when data is stale OR filters have changed since the last load.  Without a
 * test, a future change to the load callback or filter-dep list could silently
 * re-introduce the unconditional reload that causes scroll jumps.
 *
 * ## Logic under test (extracted from events.tsx)
 *
 * ```ts
 * // Refs set by the component:
 * lastLoadedAt.current     // Date.now() after every successful load
 * lastFiltersKey.current   // filter key string stamped after every load
 * currentFiltersKeyRef.current  // always-current filter key (updated each render)
 *
 * // Focus callback (called by useFocusEffect):
 * const filtersChanged = currentFiltersKeyRef.current !== lastFiltersKey.current;
 * if (filtersChanged || Date.now() - lastLoadedAt.current >= FEED_FOCUS_TTL_MS) {
 *   load();
 * }
 * ```
 *
 * ## Three cases covered
 * 1. load() is NOT called when data is within TTL and filters haven't changed.
 * 2. load() IS called when the TTL has expired (even if filters are unchanged).
 * 3. load() IS called when filters change, even if TTL has not expired.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── TTL constant (mirrors src/hooks/usePosts.ts) ───────────────────────────────

const FEED_FOCUS_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Extracted focus-guard logic ───────────────────────────────────────────────

/**
 * Encapsulates the three mutable refs and the focus-callback decision.
 * Mirrors the behaviour of the refs + useFocusEffect in events.tsx exactly.
 */
function createFocusGuard(now: () => number = Date.now) {
  let lastLoadedAt = 0;
  let lastFiltersKey = '';
  let currentFiltersKey = '';

  /** Called after a successful load — stamps the time and the filter key. */
  function onLoadComplete(): void {
    lastLoadedAt = now();
    lastFiltersKey = currentFiltersKey;
  }

  /** Called whenever the filter state changes (mirrors currentFiltersKeyRef assignment in render). */
  function setCurrentFilters(key: string): void {
    currentFiltersKey = key;
  }

  /**
   * The body of the focus callback. Returns true when load() should fire,
   * false when it is intentionally skipped (data still fresh, filters stable).
   */
  function shouldLoad(): boolean {
    const filtersChanged = currentFiltersKey !== lastFiltersKey;
    return filtersChanged || now() - lastLoadedAt >= FEED_FOCUS_TTL_MS;
  }

  return { onLoadComplete, setCurrentFilters, shouldLoad };
}

// ── Test helper ───────────────────────────────────────────────────────────────

/** Creates a fake clock that returns a controllable timestamp. */
function createClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

// ── Suite 1: load() is skipped while data is fresh and filters are stable ─────

describe('events focus TTL — skip load when data is fresh and filters unchanged', () => {
  it('does not call load() immediately after a successful load (TTL not expired)', () => {
    const clock = createClock(1_000_000);
    const guard = createFocusGuard(clock.now);
    const filtersKey = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(filtersKey);
    guard.onLoadComplete(); // simulate a successful load

    // Focus fires 1 second later — well within the 5-minute TTL
    clock.advance(1_000);
    assert.equal(guard.shouldLoad(), false, 'load() must NOT fire within TTL with unchanged filters');
  });

  it('does not call load() at exactly TTL - 1 ms', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    guard.onLoadComplete();

    clock.advance(FEED_FOCUS_TTL_MS - 1);
    assert.equal(guard.shouldLoad(), false, 'load() must NOT fire one ms before TTL expires');
  });

  it('skips load() across multiple rapid tab-switch events while still fresh', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    guard.onLoadComplete();

    // Simulate three rapid tab re-entries within the TTL
    const results: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(30_000); // 30 s each — still within 5 min
      results.push(guard.shouldLoad());
    }

    assert.deepEqual(results, [false, false, false], 'all three re-entries must be suppressed');
  });
});

// ── Suite 2: load() fires when TTL has expired ────────────────────────────────

describe('events focus TTL — load() fires when TTL has expired', () => {
  it('calls load() at exactly FEED_FOCUS_TTL_MS after the last load', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    guard.onLoadComplete();

    clock.advance(FEED_FOCUS_TTL_MS);
    assert.equal(guard.shouldLoad(), true, 'load() must fire at exactly TTL boundary');
  });

  it('calls load() when the focus fires well after TTL has expired', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    guard.onLoadComplete();

    // Simulate coming back to the app after 10 minutes
    clock.advance(10 * 60 * 1000);
    assert.equal(guard.shouldLoad(), true, 'load() must fire after 10 min (well past TTL)');
  });

  it('fires on the very first focus (lastLoadedAt = 0, TTL instantly exceeded)', () => {
    const clock = createClock(Date.now());
    const guard = createFocusGuard(clock.now);

    guard.setCurrentFilters('true|true|All|all||false|false|false');
    // No onLoadComplete() — simulates a freshly mounted screen before any load

    assert.equal(guard.shouldLoad(), true, 'initial focus must always trigger load()');
  });

  it('resets TTL after a second successful load — subsequent fresh focus is suppressed', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    guard.onLoadComplete(); // first load

    // TTL expires → focus fires → load() runs → stamps a new timestamp
    clock.advance(FEED_FOCUS_TTL_MS);
    assert.equal(guard.shouldLoad(), true, 'stale focus should trigger load');

    guard.onLoadComplete(); // second load complete

    // Tab switched away and back immediately — TTL not expired again
    clock.advance(1_000);
    assert.equal(guard.shouldLoad(), false, 'should not reload right after the second load');
  });
});

// ── Suite 3: failed load does NOT stamp TTL — next focus can retry ────────────

describe('events focus TTL — failed load leaves TTL unstamped so the next focus retries', () => {
  it('shouldLoad() returns true on the next focus after a failed load (timestamp never advanced)', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    // Simulate a failed load: onLoadComplete() is NOT called because
    // mainRes.ok was false — the component skips the stamp.

    clock.advance(1_000); // well within TTL if the stamp had happened
    assert.equal(guard.shouldLoad(), true, 'failed load must leave the next focus retryable');
  });

  it('repeated failed loads never silence future retries regardless of elapsed time', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    // Three focus events, each with a failed load (onLoadComplete skipped)
    for (let i = 0; i < 3; i++) {
      clock.advance(30_000);
      assert.equal(guard.shouldLoad(), true, `focus #${i + 1} after failed load must still trigger load()`);
      // No onLoadComplete() — simulates the failed-load branch in events.tsx
    }
  });

  it('primary-fail + secondary-ok (mixed result) does NOT stamp TTL — next focus must still retry', () => {
    // Mirrors the production scenario: mainRes.ok=false, weekendRes.ok=true.
    // The guard stamps only when the primary (mainRes) succeeds, so this mixed
    // result must leave the TTL unstamped and the next focus retryable.
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    // Mixed result: primary failed, secondary succeeded — onLoadComplete() NOT called
    // (production code: `if (mainRes.ok) { onLoadComplete(); }`)

    clock.advance(1_000); // within TTL if stamp had happened
    assert.equal(guard.shouldLoad(), true, 'mixed-result load must leave next focus retryable');
  });

  it('a success after a failure resets the TTL — the subsequent focus is suppressed', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);
    const key = 'true|true|All|all||false|false|false';

    guard.setCurrentFilters(key);
    // First attempt: fails → no stamp
    clock.advance(1_000);
    assert.equal(guard.shouldLoad(), true, 'failed attempt must trigger load');

    // Second attempt: succeeds → stamp
    guard.onLoadComplete();

    // Immediate re-focus: suppressed
    clock.advance(500);
    assert.equal(guard.shouldLoad(), false, 'successful load must suppress the next fresh focus');
  });
});

// ── Suite 4: load() fires when filters change, regardless of TTL ──────────────

describe('events focus TTL — load() fires on filter change even within TTL', () => {
  it('calls load() when the category filter changes while data is still fresh', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);

    const keyBefore = 'true|true|All|all||false|false|false';
    guard.setCurrentFilters(keyBefore);
    guard.onLoadComplete();

    // User changes category to 'Hiking' — filter key changes before next focus
    clock.advance(1_000); // well within TTL
    const keyAfter = 'true|true|Hiking|all||false|false|false';
    guard.setCurrentFilters(keyAfter);

    assert.equal(guard.shouldLoad(), true, 'filter change must bypass TTL and trigger load()');
  });

  it('calls load() when datePreset changes while data is still fresh', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);

    const keyBefore = 'true|true|All|all||false|false|false';
    guard.setCurrentFilters(keyBefore);
    guard.onLoadComplete();

    clock.advance(30_000); // 30 s — within TTL
    const keyAfter = 'true|true|All|today||false|false|false';
    guard.setCurrentFilters(keyAfter);

    assert.equal(guard.shouldLoad(), true, 'datePreset change must bypass TTL');
  });

  it('calls load() when cityFilter changes while data is still fresh', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);

    const keyBefore = 'true|true|All|all||false|false|false';
    guard.setCurrentFilters(keyBefore);
    guard.onLoadComplete();

    clock.advance(10_000); // 10 s — within TTL
    const keyAfter = 'true|true|All|all|Paris|false|false|false';
    guard.setCurrentFilters(keyAfter);

    assert.equal(guard.shouldLoad(), true, 'cityFilter change must bypass TTL');
  });

  it('calls load() when freeOnly toggle changes while data is still fresh', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);

    const keyBefore = 'true|true|All|all||false|false|false';
    guard.setCurrentFilters(keyBefore);
    guard.onLoadComplete();

    clock.advance(5_000);
    const keyAfter = 'true|true|All|all||true|false|false';
    guard.setCurrentFilters(keyAfter);

    assert.equal(guard.shouldLoad(), true, 'freeOnly toggle must bypass TTL');
  });

  it('stamps lastFiltersKey after load — subsequent same-filter focus is suppressed', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);

    const keyBefore = 'true|true|All|all||false|false|false';
    guard.setCurrentFilters(keyBefore);
    guard.onLoadComplete();

    // Filter changes → load fires → stamps new filter key
    clock.advance(1_000);
    const keyAfter = 'true|true|Hiking|all||false|false|false';
    guard.setCurrentFilters(keyAfter);
    assert.equal(guard.shouldLoad(), true);

    guard.onLoadComplete(); // load completes — stamps keyAfter

    // Tab-switch with same filters — still within TTL
    clock.advance(1_000);
    assert.equal(guard.shouldLoad(), false, 'same filters after load must be suppressed within TTL');
  });

  it('calls load() when multiple filters change simultaneously', () => {
    const clock = createClock(0);
    const guard = createFocusGuard(clock.now);

    const keyBefore = 'true|true|All|all||false|false|false';
    guard.setCurrentFilters(keyBefore);
    guard.onLoadComplete();

    clock.advance(2_000);
    // Category + datePreset + freeOnly all changed
    const keyAfter = 'true|true|Music|today||true|true|false';
    guard.setCurrentFilters(keyAfter);

    assert.equal(guard.shouldLoad(), true, 'multi-filter change must trigger load()');
  });
});
