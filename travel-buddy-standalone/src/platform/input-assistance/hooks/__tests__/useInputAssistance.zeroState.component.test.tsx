/**
 * Component test: §34 "prefer local: IMMEDIATE zero-state" through the real
 * hook (census G216).
 *
 * WHY A COMPONENT TEST AND NOT ONLY A PURE ONE. The rules are proven directly
 * in services/__tests__/localZeroState.test.ts. What those cannot prove is that
 * the HOOK consults them on an EMPTY field — and "the logic is right and
 * nothing reaches it" is exactly the state this tier was built to end:
 * `suggestionHistory` was exported from index.ts, read by nothing, and written
 * by nothing, for the whole of Phase 1.
 *
 * The three assertions are about wiring:
 *   1. an empty field renders the session's accepts BEFORE the server answers
 *      (the local zero-state exists at all),
 *   2. an unavailable endpoint KEEPS them — a cold/offline open is the case
 *      §34 names, and it used to show an empty panel,
 *   3. a `personal` field renders nothing local, ever, because a viewer-scoped
 *      list may not be re-published without a round trip that re-checks
 *      eligibility (§29).
 *
 * MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
 *   - useInputAssistance.ts: drop `&& !zeroStateTier` from the minChars gate →
 *     5 of this file's 5 tests go red (the empty field is refused again).
 *   - useInputAssistance.ts: replace the zero-state arm of `local` with `false`
 *     → (1) and (2) go red.
 *   - useInputAssistance.ts: `setSuggestions(local ?? [])` → `setSuggestions([])`
 *     in the `unavailable` branch → (2) goes red here AND the prefix-tier's own
 *     retention test goes red in useInputAssistance.localTier.component.test.tsx.
 *   - localZeroState.ts: `mayRetainLocally` → `return true` → (3) goes red.
 */

import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper (apiToken.ts) at module load, which has no
// native module under jest. `requestSuggestions` is its only export, so this
// factory is complete; a new export would be a deliberate contract change.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField, resolveFieldPolicy } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { recordLocalSelection, clearLocalZeroState } from '../../services/localZeroState.ts';
import { clearRecentSelections } from '../../services/suggestionHistory.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

const FIELD = 'test.zerostate.destination';
const PRIVATE_FIELD = 'test.zerostate.recipient';

function city(label: string, id: string): InputSuggestion {
  return {
    id: `s:${id}`,
    type: 'entity',
    context: 'trip_destination',
    label,
    entityType: 'city',
    entityId: id,
    action: { type: 'open_entity', entityType: 'city', entityId: id },
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
}

function Probe({ fieldId }: { fieldId: string }) {
  // The EMPTY field — the zero-character case §34 names by itself.
  const { suggestions, unavailable } = useInputAssistance({ fieldId, text: '' });
  return (
    <>
      <Text testID="labels">{suggestions.map((s) => s.label).join('|')}</Text>
      <Text testID="types">{suggestions.map((s) => s.type).join('|')}</Text>
      <Text testID="unavailable">{String(unavailable)}</Text>
    </>
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  clearRecentSelections();
  // minChars is left at the context DEFAULT on purpose — 1 for
  // `trip_destination`, 2 for `telegraph_recipient`. That is the shipped value,
  // and under the old gate it is exactly what stopped an empty field being
  // assisted at all. debounceMs 0 keeps the test on real timers without a sleep.
  registerField(FIELD, 'trip_destination', { debounceMs: 0 });
  registerField(PRIVATE_FIELD, 'telegraph_recipient', { debounceMs: 0 });
});

afterEach(() => {
  unregisterField(FIELD);
  unregisterField(PRIVATE_FIELD);
});

test('§14/§34: an empty field with zeroStateAssistance IS assisted, despite minChars > 0', async () => {
  // The gate itself. `trip_destination` ships `minChars: 1`, so before this the
  // hook returned without rendering anything AND without asking the server —
  // which is why the gateway's own zero-character answer was unreachable.
  expect(resolveFieldPolicy(FIELD)!.minChars).toBeGreaterThan(0);
  mockRequest.mockResolvedValueOnce({
    ok: true, requestId: 'req-zero', policyVersion: 'input-2026-08',
    suggestions: [city('Bangkok', 'c1')],
  });
  render(<Probe fieldId={FIELD} />);
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Bangkok'));
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest.mock.calls[0]![0]).toMatchObject({ text: '', context: 'trip_destination' });
});

test('§34: an EMPTY field renders this session’s accepts before the server answers', async () => {
  recordLocalSelection(resolveFieldPolicy(FIELD), city('Bangkok', 'c1'));
  recordLocalSelection(resolveFieldPolicy(FIELD), city('Da Nang', 'c2'));

  // The zero-state request never settles — anything rendered can only be local.
  mockRequest.mockReturnValueOnce(new Promise(() => {}));
  render(<Probe fieldId={FIELD} />);

  await waitFor(() =>
    expect(screen.getByTestId('labels').props.children).toBe('Da Nang|Bangkok'),
  );
  // Served out of selection memory ⇒ `recent`, the same type the server's own
  // recents branch projects, so grouping and §9 type order treat both alike.
  expect(screen.getByTestId('types').props.children).toBe('recent|recent');
  expect(screen.getByTestId('unavailable').props.children).toBe('false');
});

test('§34: a cold/offline open KEEPS the local zero-state and still reports degraded', async () => {
  recordLocalSelection(resolveFieldPolicy(FIELD), city('Bangkok', 'c1'));

  mockRequest.mockResolvedValueOnce({
    ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable',
  });
  render(<Probe fieldId={FIELD} />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  // This is the case the row describes: "a cold or offline open of a city
  // picker shows nothing". It now shows what the user already chose.
  expect(screen.getByTestId('labels').props.children).toBe('Bangkok');
});

test('§34: with nothing accepted, an empty field is still empty — nothing is invented', async () => {
  mockRequest.mockResolvedValueOnce({
    ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable',
  });
  render(<Probe fieldId={FIELD} />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('');
});

test('§29: a PERSONAL field never renders a local zero-state, degraded or not', async () => {
  // telegraph_recipient is privacyClass `personal` — its rows are PEOPLE the
  // viewer was eligible to message at the time. Record through the real entry
  // point so the write gate and the read gate are both exercised as shipped.
  recordLocalSelection(resolveFieldPolicy(PRIVATE_FIELD), {
    ...city('Alice', 'u1'),
    context: 'telegraph_recipient',
    entityType: 'user',
  });

  mockRequest.mockResolvedValueOnce({
    ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable',
  });
  render(<Probe fieldId={PRIVATE_FIELD} />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('');
});
