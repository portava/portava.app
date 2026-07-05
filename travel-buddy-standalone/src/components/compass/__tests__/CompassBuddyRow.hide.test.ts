/**
 * CompassBuddyRow hide/disabled logic tests.
 * Uses the machine-layer pattern (pure logic, no RNTL) to sidestep
 * the React 19 / jest-expo multi-instance issue (see rntl-multi-react.md).
 */

type TestFn = () => void;
const tests: { name: string; fn: TestFn }[] = [];
function test(name: string, fn: TestFn) { tests.push({ name, fn }); }
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

// ── Logic under test — mirrors CompassBuddyRow render decision ────────────────

interface BuddyResult { id: string; type: string; }

/**
 * Mirrors the hide decision in CompassBuddyRow:
 *  - disabled (settings gate) → always hide
 *  - not loading AND empty results → hide
 *  - loading → show skeleton (not hidden)
 *  - non-empty results → show
 */
function shouldHideBuddySection(
  loading: boolean,
  disabled: boolean,
  recommendations: BuddyResult[],
): boolean {
  if (disabled) return true;
  if (!loading && recommendations.length === 0) return true;
  return false;
}

function shouldShowSkeleton(loading: boolean, recommendations: BuddyResult[]): boolean {
  return loading && recommendations.length === 0;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('hides when show_buddy_recommendations is disabled', () => {
  assertTruthy(shouldHideBuddySection(false, true, [{ id: '1', type: 'buddy' }]));
});

test('hides when API returns empty and not loading', () => {
  assertTruthy(shouldHideBuddySection(false, false, []));
});

test('does not hide while loading (shows skeleton)', () => {
  assertFalsy(shouldHideBuddySection(true, false, []));
  assertTruthy(shouldShowSkeleton(true, []));
});

test('does not hide when there are recommendations', () => {
  assertFalsy(shouldHideBuddySection(false, false, [{ id: 'b1', type: 'buddy' }]));
});

test('hides when disabled even if recommendations are present', () => {
  const recs: BuddyResult[] = [{ id: 'b1', type: 'buddy' }, { id: 'b2', type: 'buddy' }];
  assertTruthy(shouldHideBuddySection(false, true, recs));
});

test('does not show skeleton when data is available even if loading', () => {
  const recs: BuddyResult[] = [{ id: 'b1', type: 'buddy' }];
  assertFalsy(shouldShowSkeleton(true, recs));
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
