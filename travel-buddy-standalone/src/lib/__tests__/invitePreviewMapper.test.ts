/**
 * Unit tests for mapInvitePreviewToScreenState — isFull branch.
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
    isTerminal:         false,
    terminalReason:     null,
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
test('returns { kind: "full" } when isFull=true, isTerminal=false, alreadyMember=false', () => {
  const preview = makePreview({ isFull: true });
  const result = mapInvitePreviewToScreenState(makeResult(preview));
  assertEqual(result.kind, 'full', 'kind should be "full"');
  // Verify the preview is forwarded unchanged.
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
// Precedence: isTerminal takes priority over isFull
// ---------------------------------------------------------------------------
test('returns { kind: "terminal" } when isTerminal=true even if isFull=true', () => {
  const preview = makePreview({
    isFull:         true,
    isTerminal:     true,
    terminalReason: 'This trip is no longer active.',
  });
  const result = mapInvitePreviewToScreenState(makeResult(preview));
  assertEqual(result.kind, 'terminal', 'terminal check must come before isFull check');
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
