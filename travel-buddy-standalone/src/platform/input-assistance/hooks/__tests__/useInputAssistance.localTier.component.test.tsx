/**
 * Component test: the §33 local prefix tier and the §33 "network loss retains
 * local/cached suggestions" rule, both exercised through the real hook.
 *
 * WHY A COMPONENT TEST AND NOT A PURE ONE. `longestPrefix` and `narrowToQuery`
 * are pure and are proven directly in services/__tests__/raceAndCache.test.ts.
 * What those cannot prove is that the HOOK consults them — and "the logic is
 * right and nothing reaches it" is the exact failure this tier was built to
 * close. The two assertions below are therefore about wiring:
 *
 *   1. a keystroke past a cached prefix renders local rows BEFORE the server
 *      answers (the tier exists at all), and
 *   2. an unavailable endpoint KEEPS them instead of clearing the list.
 *
 * (2) is the defect this replaces: the branch used to call `setSuggestions([])`,
 * discarding the last good rows at the one moment the user cannot get new ones.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `cmp` byte-identical):
 *   - useInputAssistance.ts: restore `setSuggestions([])` in the `unavailable`
 *     branch → "network loss RETAINS the narrowed local rows" goes red.
 *   - useInputAssistance.ts: delete the `if (localTier) setSuggestions(localTier)`
 *     block → "the local tier renders before the server answers" goes red.
 *   - useInputAssistance.ts: drop the `cacheable` guard on `localTier` → the
 *     "an uncacheable field never serves a local list" assertion goes red.
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
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache, SuggestionCache } from '../../services/suggestionCache.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

const FIELD = 'test.trip.destination';
const PRIVATE_FIELD = 'test.telegraph.recipient';

function row(label: string, entityId: string): InputSuggestion {
  return {
    id: `s:${entityId}`,
    type: 'entity',
    context: 'trip_destination',
    label,
    entityType: 'city',
    entityId,
    source: 'canonical',
    policyVersion: 'input-2026-08',
  };
}

const BAN_ANSWER = [row('Bangkok', 'c1'), row('Ban Phe', 'c2'), row('Battambang', 'c3')];

function Probe({ fieldId, text }: { fieldId: string; text: string }) {
  const { suggestions, unavailable } = useInputAssistance({ fieldId, text });
  return (
    <>
      <Text testID="labels">{suggestions.map((s) => s.label).join('|')}</Text>
      <Text testID="unavailable">{String(unavailable)}</Text>
    </>
  );
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  // debounceMs 0 keeps the test on real timers without a sleep.
  registerField(FIELD, 'trip_destination', { debounceMs: 0 });
  registerField(PRIVATE_FIELD, 'telegraph_recipient', { debounceMs: 0 });
});

afterEach(() => {
  unregisterField(FIELD);
  unregisterField(PRIVATE_FIELD);
});

/** Type "ban", let the server answer, and leave the answer in the cache. */
async function primeCacheForBan() {
  mockRequest.mockResolvedValueOnce({ ok: true, requestId: 'req-test', policyVersion: 'input-2026-08', suggestions: BAN_ANSWER });
  const view = render(<Probe fieldId={FIELD} text="ban" />);
  await waitFor(() =>
    expect(screen.getByTestId('labels').props.children).toBe('Bangkok|Ban Phe|Battambang'),
  );
  return view;
}

test('§33 tier 1: a keystroke past a cached prefix renders local rows before the server answers', async () => {
  const { rerender } = await primeCacheForBan();

  // The next keystroke's request never settles — anything rendered now can only
  // have come from the local tier.
  mockRequest.mockReturnValueOnce(new Promise(() => {}));
  rerender(<Probe fieldId={FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Bangkok'));
  expect(screen.getByTestId('unavailable').props.children).toBe('false');
});

test('§33: network loss RETAINS the narrowed local rows and still reports degraded', async () => {
  const { rerender } = await primeCacheForBan();

  mockRequest.mockResolvedValueOnce({ ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable' });
  rerender(<Probe fieldId={FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  // The degraded STATE is set (the overlay shows its quiet note) AND the rows
  // that still match the typed text survive. Clearing them here was the defect.
  expect(screen.getByTestId('labels').props.children).toBe('Bangkok');
});

test('§33: with nothing cached, an unavailable endpoint still yields an empty list', async () => {
  mockRequest.mockResolvedValueOnce({ ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable' });
  render(<Probe fieldId={FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('');
});

test('§29: an uncacheable (personal) field never READS a local list, even one already cached', async () => {
  // telegraph_recipient is privacyClass `personal`. It never writes to the
  // shared cache — so seed the cache DIRECTLY, which isolates the read guard
  // from the write guard and makes the assertion about this branch only. A list
  // of PEOPLE must never be re-shown without a round trip that can re-check
  // eligibility, degraded network included.
  sharedSuggestionCache.set(SuggestionCache.key(PRIVATE_FIELD, 'ban'), BAN_ANSWER);

  mockRequest.mockResolvedValueOnce({ ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable' });
  render(<Probe fieldId={PRIVATE_FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('');
});
