/**
 * Unit tests for mapInvitePreviewToScreenState — isFull and gone_inactive branches.
 *
 * Pure function; no React Native dependencies required.
 * Uses Node.js built-in test runner.
 */
import { mapInvitePreviewToScreenState } from '../invitePreviewMapper.ts';
import type { InvitePreview, InvitePreviewResult } from '../../services/trips.ts';

// ---------------------------------------------------------------------------
// Minimal test harness (matches the pattern used in compassIntent.test.ts)
// ---------------------------------------------------------------------------
type TestFn = () => void;
const tests: { name: string; fn: TestFn }[] = [];

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assertEqual(actual: unknown, expected: unknown, msg?: string) {
  if (actual !== expected) {
    throw new Error(
      `${msg ? msg + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------
function makePreview(overrides: Partial<InvitePreview> = {}): InvitePreview {
  return {
    tripId:             'trip-test-id',
    tripTitle:          'Test Trip',
    destinationCity:    'Paris',
    destinationCountry: 'France',
    startDate:          '2099-08-01',
    endDate:            '2099-08-14',
    coverUrl:           null,
    alreadyMember:      false,
    linkId:             'link-test-id',
    expiresAt:          null,
    tripStatus:         'upcoming',
    isFull:             false,
    ...overrides,
  };
}

function makeResult(preview: InvitePreview): InvitePreviewResult {
  return { data: preview };
}

// ---------------------------------------------------------------------------
// isFull → { kind: 'full' } branch
// ---------------------------------------------------------------------------
test('returns { kind: "full" } when isFull=true, alreadyMember=false', () => {
  const preview = makePreview({ isFull: true });
  const result = mapInvitePreviewToScreenState(makeResult(preview));
  assertEqual(result.kind, 'full', 'kind should be "full"');
  if (result.kind !== 'full') throw new Error('unreachable');
  assertEqual(result.preview.tripId, preview.tripId, 'preview.tripId should be forwarded');
});

test('returns { kind: "full" } and includes the preview object', () => {
  const preview = makePreview({ isFull: true, tripTitle: 'Packed Trip' });
  const result = mapInvitePreviewToScreenState(makeResult(preview));
  assertEqual(result.kind, 'full');
  if (result.kind !== 'full') throw new Error('unreachable');
  assertEqual(result.preview.tripTitle, 'Packed Trip', 'preview.tripTitle should be forwarded');
});

// ---------------------------------------------------------------------------
// Precedence: alreadyMember takes priority over isFull
// ---------------------------------------------------------------------------
test('returns { kind: "already_member" } when alreadyMember=true even if isFull=true', () => {
  const preview = makePreview({ isFull: true, alreadyMember: true });
  const result = mapInvitePreviewToScreenState(makeResult(preview));
  assertEqual(result.kind, 'already_member', 'alreadyMember check must come before isFull check');
});

// ---------------------------------------------------------------------------
// trip_inactive 410 → gone_inactive (dedicated state with optional tombstone)
// ---------------------------------------------------------------------------
test('returns { kind: "gone_inactive" } with no tombstone when goneReason is trip_inactive and no trip data', () => {
  const result = mapInvitePreviewToScreenState({
    data: null,
    gone: true,
    goneReason: 'trip_inactive',
  });
  assertEqual(result.kind, 'gone_inactive', 'trip_inactive must route to gone_inactive');
  if (result.kind !== 'gone_inactive') throw new Error('unreachable');
  assertEqual(result.tombstone, undefined, 'tombstone should be undefined when goneTripInfo is absent');
});

test('returns { kind: "gone_inactive" } with tombstone when goneTripInfo is present', () => {
  const result = mapInvitePreviewToScreenState({
    data: null,
    gone: true,
    goneReason: 'trip_inactive',
    goneTripInfo: {
      title: 'Bali Retreat',
      destinationCity: 'Bali',
      destinationCountry: 'Indonesia',
      startDate: '2025-01-01',
      endDate: '2025-01-14',
      coverUrl: null,
    },
  });
  assertEqual(result.kind, 'gone_inactive', 'trip_inactive with trip info must route to gone_inactive');
  if (result.kind !== 'gone_inactive') throw new Error('unreachable');
  assertEqual(result.tombstone?.title, 'Bali Retreat', 'tombstone.title should be forwarded');
  assertEqual(result.tombstone?.destinationCity, 'Bali', 'tombstone.destinationCity should be forwarded');
});

// ---------------------------------------------------------------------------
// isFull=false → ready branch
// ---------------------------------------------------------------------------
test('returns { kind: "ready" } when isFull=false and trip is active', () => {
  const preview = makePreview({ isFull: false });
  const result = mapInvitePreviewToScreenState(makeResult(preview));
  assertEqual(result.kind, 'ready', 'active non-full trip should be "ready"');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err?.message ?? err}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
