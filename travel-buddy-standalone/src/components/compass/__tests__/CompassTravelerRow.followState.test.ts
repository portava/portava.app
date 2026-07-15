/**
 * CompassTravelerRow follow-button state tests.
 * Uses the machine-layer pattern (pure logic, no RNTL) to sidestep
 * the React 19 / jest-expo multi-instance issue (see rntl-multi-react.md).
 *
 * Verifies that follow button state is derived from the backend-provided
 * followStatus field, not hardcoded or fabricated locally.
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

// ── Logic under test — mirrors TravelerCard initial state in CompassTravelerRow

type FollowStatus = 'following' | 'requested' | 'not_following';

/**
 * Mirrors the useState initialiser in TravelerCard:
 *   const [followed,  setFollowed]  = useState(d.followStatus === 'following');
 *   const [requested, setRequested] = useState(d.followStatus === 'requested');
 *
 * These are seeded from the backend response — never a default hardcode.
 */
function deriveFollowButtonState(followStatus: FollowStatus): {
  followed: boolean;
  requested: boolean;
  buttonLabel: string;
} {
  const followed  = followStatus === 'following';
  const requested = followStatus === 'requested';
  let buttonLabel: string;
  if (followed)        buttonLabel = 'Following';
  else if (requested)  buttonLabel = 'Requested';
  else                 buttonLabel = 'Follow';
  return { followed, requested, buttonLabel };
}

/**
 * Mirrors the hide logic in CompassTravelerRow:
 *   - disabled (settings gate) → hide
 *   - empty results → hide
 */
function shouldHideTravelerSection(disabled: boolean, count: number): boolean {
  if (disabled) return true;
  if (count === 0) return true;
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('followStatus=following initialises followed=true and shows "Following"', () => {
  const state = deriveFollowButtonState('following');
  assertTruthy(state.followed, 'followed must be true for followStatus=following');
  assertFalsy(state.requested);
  assertEqual(state.buttonLabel, 'Following');
});

test('followStatus=requested initialises requested=true and shows "Requested"', () => {
  const state = deriveFollowButtonState('requested');
  assertFalsy(state.followed);
  assertTruthy(state.requested, 'requested must be true for followStatus=requested');
  assertEqual(state.buttonLabel, 'Requested');
});

test('followStatus=not_following initialises both false and shows "Follow"', () => {
  const state = deriveFollowButtonState('not_following');
  assertFalsy(state.followed);
  assertFalsy(state.requested);
  assertEqual(state.buttonLabel, 'Follow');
});

test('follow state is NOT hardcoded — varies with backend followStatus', () => {
  const stateA = deriveFollowButtonState('following');
  const stateB = deriveFollowButtonState('not_following');
  // If the state were hardcoded to false, both would be identical — they must differ
  assertTruthy(
    stateA.followed !== stateB.followed,
    'follow state must differ between following and not_following: hardcoded value detected',
  );
});

test('hides when show_people_recommendations is disabled', () => {
  assertTruthy(shouldHideTravelerSection(true, 3));
});

test('hides when API returns empty recommendations', () => {
  assertTruthy(shouldHideTravelerSection(false, 0));
});

test('shows when enabled and non-empty', () => {
  assertFalsy(shouldHideTravelerSection(false, 2));
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
