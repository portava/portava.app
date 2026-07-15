/**
 * Unit tests for the compassIntent parser.
 * Uses Node.js built-in test runner (no external deps needed).
 */
import { parseSearchIntent, intentSummary } from '../compassIntent';

// ── Minimal test harness (node:test-compatible assert style) ──────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type TestFn = () => void;
const tests: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assertDeepEqual(actual: unknown, expected: unknown, msg?: string) {
  if (!deepEqual(actual, expected)) {
    throw new Error(
      `${msg ?? 'deepEqual failed'}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'assertEqual failed'}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

function assertTruthy(value: unknown, msg?: string) {
  if (!value) throw new Error(msg ?? `Expected truthy but got: ${JSON.stringify(value)}`);
}

function assertFalsy(value: unknown, msg?: string) {
  if (value) throw new Error(msg ?? `Expected falsy but got: ${JSON.stringify(value)}`);
}

// ── Time signal tests ─────────────────────────────────────────────────────────

test('detects "tonight"', () => {
  assertDeepEqual(parseSearchIntent('beach clubs tonight').timeSignal, 'tonight');
});

test('detects "tomorrow"', () => {
  assertDeepEqual(parseSearchIntent('restaurants open tomorrow').timeSignal, 'tomorrow');
});

test('detects "this weekend"', () => {
  assertDeepEqual(parseSearchIntent('things to do this weekend').timeSignal, 'this_weekend');
});

test('detects "weekend" without "this"', () => {
  assertDeepEqual(parseSearchIntent('hiking spots weekend').timeSignal, 'this_weekend');
});

test('no false positive: "tomorrowland" does not match tomorrow', () => {
  assertEqual(parseSearchIntent('tomorrowland festival').timeSignal, undefined);
});

// ── Category tests ────────────────────────────────────────────────────────────

test('detects nightlife', () => {
  assertEqual(parseSearchIntent('bars and clubs in cebu').category, 'nightlife');
});

test('detects food', () => {
  assertEqual(parseSearchIntent('best restaurant for dinner').category, 'food');
});

test('detects beach', () => {
  assertEqual(parseSearchIntent('snorkel spots near island').category, 'beach');
});

test('detects adventure', () => {
  assertEqual(parseSearchIntent('hiking trails near bali').category, 'adventure');
});

test('detects culture', () => {
  assertEqual(parseSearchIntent('visit museum or temple').category, 'culture');
});

test('no false positive: "bar" in "Barcelona" does not trigger nightlife', () => {
  // "bar" as a standalone word would trigger; city name should not
  assertEqual(parseSearchIntent('events in Barcelona').category, undefined);
});

test('nightlife wins over food for "bar"', () => {
  assertEqual(parseSearchIntent('bar hopping tonight').category, 'nightlife');
});

// ── Social signal tests ───────────────────────────────────────────────────────

test('detects solo', () => {
  assertEqual(parseSearchIntent('solo travel tips').social, 'solo');
});

test('detects group', () => {
  assertEqual(parseSearchIntent('group activities with friends').social, 'group');
});

test('detects crew', () => {
  assertEqual(parseSearchIntent('crew trip spots').social, 'crew');
});

// ── Safety boost tests ────────────────────────────────────────────────────────

test('detects safetyBoost from "safe"', () => {
  assertTruthy(parseSearchIntent('safe areas to stay').safetyBoost);
});

test('detects safetyBoost from "verified"', () => {
  assertTruthy(parseSearchIntent('verified hostels').safetyBoost);
});

test('no safetyBoost for unrelated query', () => {
  assertFalsy(parseSearchIntent('beach restaurants in cebu').safetyBoost);
});

// ── Location hint tests ───────────────────────────────────────────────────────

test('extracts city name with correct casing', () => {
  assertEqual(parseSearchIntent('things to do in cebu').locationHint, 'Cebu');
});

test('extracts multi-word city', () => {
  assertEqual(parseSearchIntent('restaurants chiang mai').locationHint, 'Chiang Mai');
});

test('returns undefined locationHint for unknown city', () => {
  assertEqual(parseSearchIntent('beaches in xyz unknowncity').locationHint, undefined);
});

test('prefers longer city match over shorter', () => {
  // "Hong Kong" should win over hypothetical single-word match
  assertEqual(parseSearchIntent('bars in hong kong tonight').locationHint, 'Hong Kong');
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test('empty string returns empty object', () => {
  assertDeepEqual(parseSearchIntent(''), {});
});

test('single char returns empty object', () => {
  assertDeepEqual(parseSearchIntent('a'), {});
});

test('combined intent: category + time + location', () => {
  const intent = parseSearchIntent('nightlife tonight in cebu');
  assertEqual(intent.category, 'nightlife');
  assertEqual(intent.timeSignal, 'tonight');
  assertEqual(intent.locationHint, 'Cebu');
});

test('combined intent: beach + solo + safety', () => {
  const intent = parseSearchIntent('safe solo beach trips');
  assertEqual(intent.category, 'beach');
  assertEqual(intent.social, 'solo');
  assertTruthy(intent.safetyBoost);
});

// ── intentSummary tests ───────────────────────────────────────────────────────

test('intentSummary returns null for empty intent', () => {
  assertEqual(intentSummary({}), null);
});

test('intentSummary formats single signal', () => {
  assertEqual(intentSummary({ timeSignal: 'tonight' }), 'tonight');
});

test('intentSummary formats multiple signals', () => {
  assertEqual(
    intentSummary({ category: 'nightlife', timeSignal: 'tonight', locationHint: 'Cebu' }),
    'nightlife tonight in Cebu',
  );
});

test('intentSummary includes safety suffix', () => {
  const s = intentSummary({ category: 'food', safetyBoost: true });
  assertTruthy(s?.includes('· verified'));
});

test('intentSummary replaces underscores in timeSignal', () => {
  const s = intentSummary({ timeSignal: 'this_weekend' });
  assertEqual(s, 'this weekend');
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
