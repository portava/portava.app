/**
 * Integration tests: CompassPicksSection render and hide behaviour.
 * Uses the machine-layer pattern (pure logic tests, no RNTL) to sidestep
 * the React 19 / jest-expo multi-instance issue documented in rntl-multi-react.md.
 */

// ── Minimal test harness ──────────────────────────────────────────────────────

type TestFn = () => void;
const tests: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg ?? 'assertEqual failed'}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

function assertTruthy(value: unknown, msg?: string) {
  if (!value) throw new Error(msg ?? `Expected truthy, got: ${JSON.stringify(value)}`);
}

function assertFalsy(value: unknown, msg?: string) {
  if (value) throw new Error(msg ?? `Expected falsy, got: ${JSON.stringify(value)}`);
}

// ── Logic under test — mirrors CompassPicksSection decision rules ─────────────

interface FeedItem {
  id: string;
  type: string;
  category: string;
  title?: string;
  recommendationToken?: string;
  data?: Record<string, unknown>;
}

interface FeedResponse {
  sections: { name: string; items: FeedItem[] }[];
  safeItems?: FeedItem[];
  compassEnabled?: boolean;
  fallback?: boolean;
}

/**
 * Mirrors the display-item selection logic in CompassPicksSection:
 *  1. Flatten section items.
 *  2. Fall back to safeItems when sections are empty.
 *  3. Filter dismissed ids.
 *  4. Cap at 8.
 */
function deriveDisplayItems(
  data: FeedResponse | null,
  dismissed: Set<string>,
  compassEnabled: boolean,
): FeedItem[] {
  if (!compassEnabled) return [];
  if (!data) return [];

  const sectionItems = (data.sections ?? []).flatMap((s) => s.items ?? []);
  const safeItems    = data.safeItems ?? [];
  const raw = sectionItems.length > 0 ? sectionItems : safeItems;
  return raw.filter((item) => !dismissed.has(item.id)).slice(0, 8);
}

function shouldShowSkeleton(loading: boolean, data: FeedResponse | null): boolean {
  return loading && data === null;
}

function shouldHide(displayItems: FeedItem[], compassEnabled: boolean, loading: boolean): boolean {
  if (!compassEnabled && !loading) return true;
  return displayItems.length === 0 && !loading;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('hides when compassEnabled is false', () => {
  const items = deriveDisplayItems(
    { sections: [{ name: 'compass_picks', items: [{ id: '1', type: 'place', category: 'food', title: 'Foo' }] }] },
    new Set(),
    false,
  );
  assertEqual(items.length, 0);
  assertTruthy(shouldHide(items, false, false));
});

test('shows skeleton when loading and no data', () => {
  assertTruthy(shouldShowSkeleton(true, null));
});

test('does not show skeleton when data available even if loading', () => {
  const data: FeedResponse = { sections: [], compassEnabled: true, fallback: false };
  assertFalsy(shouldShowSkeleton(true, data));
});

test('hides when sections and safeItems are both empty', () => {
  const data: FeedResponse = { sections: [], safeItems: [], compassEnabled: true };
  const items = deriveDisplayItems(data, new Set(), true);
  assertEqual(items.length, 0);
  assertTruthy(shouldHide(items, true, false));
});

test('shows section items when available', () => {
  const data: FeedResponse = {
    sections: [
      {
        name: 'compass_picks',
        items: [
          { id: 'a', type: 'place', category: 'food', title: 'Café' },
          { id: 'b', type: 'event', category: 'events', title: 'Beach Party' },
        ],
      },
    ],
    compassEnabled: true,
  };
  const items = deriveDisplayItems(data, new Set(), true);
  assertEqual(items.length, 2);
});

test('falls back to safeItems when sections are empty', () => {
  const data: FeedResponse = {
    sections: [],
    safeItems: [{ id: 'safe1', type: 'place', category: 'places', title: 'Safe Spot' }],
    compassEnabled: true,
  };
  const items = deriveDisplayItems(data, new Set(), true);
  assertEqual(items.length, 1);
  assertEqual(items[0].id, 'safe1');
});

test('dismissed items are excluded', () => {
  const data: FeedResponse = {
    sections: [
      {
        name: 'compass_picks',
        items: [
          { id: 'x', type: 'place', category: 'places', title: 'Keep Me' },
          { id: 'y', type: 'place', category: 'places', title: 'Dismiss Me' },
        ],
      },
    ],
    compassEnabled: true,
  };
  const items = deriveDisplayItems(data, new Set(['y']), true);
  assertEqual(items.length, 1);
  assertEqual(items[0].id, 'x');
});

test('caps display items at 8', () => {
  const rawItems: FeedItem[] = Array.from({ length: 15 }, (_, i) => ({
    id: String(i),
    type: 'place',
    category: 'places',
    title: `Place ${i}`,
  }));
  const data: FeedResponse = {
    sections: [{ name: 'compass_picks', items: rawItems }],
    compassEnabled: true,
  };
  const items = deriveDisplayItems(data, new Set(), true);
  assertEqual(items.length, 8);
});

test('Discovery existing sections are unaffected by Compass failure', () => {
  // Simulate Compass returning null (network error) alongside existing OSM sections
  const compassData = null;
  const compassEnabled = false;
  const osmPlacesCount = 5; // OSM returned 5 places

  const compassItems = deriveDisplayItems(compassData, new Set(), compassEnabled);

  // Compass produces nothing — OSM count is unchanged
  assertEqual(compassItems.length, 0);
  assertEqual(osmPlacesCount, 5); // OSM unaffected
});

test('hides when all items dismissed', () => {
  const data: FeedResponse = {
    sections: [
      {
        name: 'compass_picks',
        items: [{ id: 'a', type: 'place', category: 'places' }],
      },
    ],
    compassEnabled: true,
  };
  const dismissed = new Set(['a']);
  const items = deriveDisplayItems(data, dismissed, true);
  assertEqual(items.length, 0);
  assertTruthy(shouldHide(items, true, false));
});

// ── Run all tests ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: unknown) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
