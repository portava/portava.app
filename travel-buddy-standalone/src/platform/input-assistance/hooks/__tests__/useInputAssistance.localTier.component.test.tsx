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

// ── SEEDED 2026-09-21 (G340) ────────────────────────────────────────────────
// `useInputAssistance` derives its policy from the context descriptor, which
// since G340 comes from `GET /input-assistance/policies` rather than a local
// table. With nothing fetched every context resolves CONSERVATIVE — mode
// `no_assistance`, an unreachable `minChars` — so the hook correctly makes no
// request and renders no rows, and every assertion below about suggestions
// would be vacuous. Seeding states the premise these tests always relied on.
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';
// `telegraph_recipient` is seeded VIEWER-SCOPED on purpose: the §29 cases below
// exist to prove an uncacheable field never reads or writes the process-global
// cache, and that is only a real assertion if the authority actually classifies
// it as one. The blanket template is `public`, which is the one class the cache
// admits — seeding it unchanged would have made those cases pass for the wrong
// reason.
_seedPolicy(_SEED_CONTEXTS, { telegraph_recipient: { privacyClass: 'viewer_scoped' } });


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
  // telegraph_recipient is privacyClass `viewer_scoped`. It never writes to the
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

// ═══════════════════════════════════════════════════════════════════════════════
// §32 / G340 — `server_required` is ENFORCED HERE, not merely declared
// ═══════════════════════════════════════════════════════════════════════════════
//
// §29 aligned the two `OfflineInputPolicy` unions so the authority's value could
// ARRIVE on the client intact, and said plainly that alignment alone changes
// nothing a user sees. These two cases are the difference. They run the real
// hook through the real consumer path with the real cache, and the ONLY thing
// that differs between them is what the authority says about the field.
//
// The case above — "network loss RETAINS the narrowed local rows" — is §33's
// general rule and stays true for a field with an offline surface. This is the
// per-field narrowing: for the nine contexts the authority marks
// `server_required`, retaining rows is assistance it declined to license, shown
// at the one moment nothing can re-check it.

test('§32: on network loss a `server_required` field shows NOTHING, however warm the cache', async () => {
  _seedPolicy(_SEED_CONTEXTS, { trip_destination: { offlinePolicy: 'server_required' } });
  const { rerender } = await primeCacheForBan();

  // A cached prefix EXISTS and would be retained for a field with an offline
  // surface — the case two above proves exactly that. This one has none.
  mockRequest.mockResolvedValueOnce({ ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable' });
  rerender(<Probe fieldId={FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('');
});

test('NOT VACUOUS: the same field and the same cache, with `cached_local`, DO retain', async () => {
  // Without this the case above would also pass against a hook that simply
  // stopped retaining anything — the other way to be wrong, and one that would
  // silently delete §33's stale-while-revalidate behaviour for every field.
  _seedPolicy(_SEED_CONTEXTS, { trip_destination: { offlinePolicy: 'cached_local' } });
  const { rerender } = await primeCacheForBan();

  mockRequest.mockResolvedValueOnce({ ok: false, aborted: false, unavailable: true, error: 'endpoint unavailable' });
  rerender(<Probe fieldId={FIELD} text="bangk" />);

  await waitFor(() => expect(screen.getByTestId('unavailable').props.children).toBe('true'));
  expect(screen.getByTestId('labels').props.children).toBe('Bangkok');

  // Restore the blanket seed so ordering between files cannot matter.
  _seedPolicy(_SEED_CONTEXTS, { telegraph_recipient: { privacyClass: 'viewer_scoped' } });
});
