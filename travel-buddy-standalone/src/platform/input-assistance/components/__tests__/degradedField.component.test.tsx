/**
 * §32 end to end — a real `SmartInput`, a real policy, an unreachable
 * authority (census G13, G350, and the `display_name` decision of §28.1).
 *
 * `degradedSurface.component.test.tsx` drives the container directly, which
 * proves the container. It cannot prove the one thing this file is for: that
 * the AUTHORITY's `offlinePolicy` is what selects the sentence. `SmartInput`
 * derives that from the resolved policy through
 * `contexts/policyFallback.ts#offlineSurfaceAllowed` — the same predicate the
 * hook's retention gate uses — so a field declared `server_required` gets the
 * online-only sentence and a field declared `cached_local` does not, with
 * nothing hard-coded in between.
 *
 * TWO MOUNTS, ON PURPOSE. React 19 + RNTL 14 in this repo return a null tree
 * after several mounts in one file (see the harness note in
 * `inputTelemetryFunnel.component.test.tsx`), and a SmartInput mount is the
 * expensive kind. Each test below mounts once.
 *
 * MUTATION LOG: see the bottom of this file.
 *
 * Run: npx jest --testPathPattern='degradedField'
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stubs — both modules import the Supabase-backed
// token helper (apiToken.ts) at module load, which has no native module under
// jest. Each factory lists that module's complete export surface, so a new
// export is a deliberate contract change rather than silent drift.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — `recordSuggestionSelection` is this
// module's only export, and it reaches Supabase through apiToken.ts at load.
jest.mock('../../services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { SmartInput } from '../SmartInput.tsx';
import { requestSuggestions } from '../../services/inputAssistance.ts';
import { registerField, resolveFieldPolicy, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { clearLocalZeroState } from '../../services/localZeroState.ts';

// ── SEEDED (G340) ───────────────────────────────────────────────────────────
// Since G340 every context resolves from the fetched authority, and with
// nothing fetched every context is CONSERVATIVE — `no_assistance`, an
// unreachable `minChars`, `offlinePolicy: 'unavailable'` — under which every
// assertion here would pass vacuously. The seed states the premise with the
// REAL registry's values: `place_picker` is `server_required` and
// `display_name` is `unavailable` with no allowed types at all
// (`lib/inputAssistance/policyRegistry.ts`).
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, {
  place_picker: {
    offlinePolicy: 'server_required',
    entityTypes: ['place', 'city'],
    allowedSuggestionTypes: ['entity', 'recent'],
    minChars: 1,
  },
  display_name: {
    // `mode` IS PART OF THE PREMISE, and it is stated because leaving it out
    // silently made this field `search` — `_seedPolicyForTests` spreads a
    // permissive default under every override. A display_name seeded `search`
    // still renders nothing (its `minChars: 99` refuses first), so the omission
    // is invisible in a behavioural assertion and the test would have been
    // agreeing with itself. The authority says `no_assistance`
    // (`lib/inputAssistance/policyRegistry.ts:287`), and so does this.
    mode: 'no_assistance',
    offlinePolicy: 'unavailable',
    entityTypes: [],
    allowedSuggestionTypes: [],
    minChars: 99,
    maxSuggestions: 0,
    zeroStateAssistance: false,
  },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

const PLACE_FIELD = 'test.degraded.place';
const NAME_FIELD = 'test.degraded.displayname';

const OFFLINE = { ok: false as const, aborted: false, unavailable: true, error: 'endpoint unavailable' };

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  registerField(PLACE_FIELD, 'place_picker', { debounceMs: 0 });
  registerField(NAME_FIELD, 'display_name', { debounceMs: 0 });
});

afterEach(async () => {
  await cleanup();
  unregisterField(PLACE_FIELD);
  unregisterField(NAME_FIELD);
});

test('§32: an offline SERVER_REQUIRED field says the field is online-only — and still shows no row', async () => {
  mockRequest.mockResolvedValue(OFFLINE);
  const r = await render(
    <SmartInput fieldId={PLACE_FIELD} value="bangk" onChangeText={() => {}} label="Place" testID="deg-place" />,
  );
  fireEvent(r.getByTestId('deg-place'), 'focus');

  // The sentence arrives …
  await waitFor(() => expect(r.getByTestId('ia-degraded-unassisted')).toBeTruthy());
  // … and it is the AUTHORITY's answer, not the container's default: this field
  // is `server_required`, so `offlineSurfaceAllowed` is false for it.
  expect(r.getAllByText(/only assisted online/).length).toBeGreaterThan(0);

  // THE GATE IS UNTOUCHED. "Bangkok" is in the shipped city index and
  // `place_picker` declares `city` among its entity types, so a dictionary
  // COULD have answered here — the authority says it may not, and the note
  // explains the absence rather than filling it.
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(0);
  expect(r.queryByText('No matches yet.')).toBeNull();
});

test('§28.1: display_name stays MANUAL — no panel, no note, no request, offline or on', async () => {
  mockRequest.mockResolvedValue(OFFLINE);
  const r = await render(
    <SmartInput fieldId={NAME_FIELD} value="Vanessa" onChangeText={() => {}} label="Name" testID="deg-name" />,
  );
  fireEvent(r.getByTestId('deg-name'), 'focus');

  // A `no_assistance` field opens NO overlay, so there is no absence to
  // explain and the degraded note must not appear either. The new surface must
  // not be the thing that finally gives a manual field a suggestion panel.
  await waitFor(() => expect(r.getByTestId('deg-name')).toBeTruthy());
  expect(r.queryByTestId('ia-suggestion-overlay')).toBeNull();
  expect(r.queryByTestId('ia-degraded-unassisted')).toBeNull();
  expect(r.queryByTestId('ia-degraded-empty')).toBeNull();
  expect(r.queryAllByTestId(/^ia-entity-row-/).length).toBe(0);
  expect(mockRequest).not.toHaveBeenCalled();

  // ASSERTED ON THE AUTHORITY, NOT ON WHICH GATE FIRED. The owner's decision
  // (§28.1) is that this field is manual; the client's job is to obey it. Two
  // of the authority's values refuse independently — `no_assistance` and an
  // unreachable `minChars` — so no single-line mutation can redden the
  // behavioural assertions above. The mutation log at the bottom records that
  // rather than leaving it to look like a covered gate.
  const namePolicy = resolveFieldPolicy(NAME_FIELD);
  // `resolveFieldPolicy` returns null for an unregistered field; this one IS
  // registered, and asserting that first keeps the three assertions below from
  // passing on a null that never reached them.
  expect(namePolicy).not.toBeNull();
  expect(namePolicy!.mode).toBe('no_assistance');
  expect(namePolicy!.allowedSuggestionTypes).toEqual([]);
  // `entityTypes` is optional on `InputFieldPolicy` and is omitted rather than
  // emptied when the authority declares none, so the assertion is on the
  // meaning ("no entity type is offered") and not on the encoding.
  expect(namePolicy!.entityTypes ?? []).toEqual([]);
});

/*
 * MUTATION LOG — applied to the shipped modules, run, watched, reverted.
 * Baseline for this file: 2/2 (8/8 across the two degraded jest files).
 *
 *   - SmartInput: `offlineSurface={offlineSurfaceAllowed(policy?.offlinePolicy)}`
 *     → hard-coded `offlineSurface={true}` → 7/8. "An offline SERVER_REQUIRED
 *     field says the field is online-only" goes RED: the field is handed the
 *     `empty` sentence ("nothing is saved on this device"), which is false for
 *     a field that has no offline surface at all. This is the mutation that
 *     proves the sentence is read from the AUTHORITY, and it is the one
 *     `degradedSurface.component.test.tsx` cannot land.
 *   - SuggestionOverlay: delete the degraded block and restore the old
 *     `emptyState ?? (unavailable ? … : 'No matches yet.')` → 3/8. The first
 *     case here goes RED along with four in the surface file.
 *   - SuggestionOverlay: drop `&& !degraded` from the empty branch → 5/8.
 *
 * ONE MUTATION THAT DID **NOT** LAND, AND WHY IT IS NOT DEAD CODE.
 *
 *   - SmartInput: drop the `policy.mode !== 'no_assistance'` half of
 *     `assistEnabled` → 8/8, GREEN. The reachable space was checked before
 *     concluding anything: `display_name`'s policy comes from the authority
 *     (`lib/inputAssistance/policyRegistry.ts:287`) and carries TWO
 *     independent refusals — `mode: 'no_assistance'` AND `minChars: 99` — and
 *     the registry says in as many words why both are there ("`no_assistance`
 *     rather than merely an empty type list, because the gateway short-circuits
 *     on the MODE … one missed check and the field is assisted again"). With
 *     the mode gate removed the `minChars` gate still returns before any
 *     request, so no input this field can be given distinguishes them. There is
 *     no context in the authority with `no_assistance` AND a reachable
 *     `minChars`, so the discriminating input does not exist to be written; it
 *     would have to be invented, and a test that invents a policy the authority
 *     never serves is asserting against itself (§30.6). The mode gate is kept,
 *     and what IS pinned is the authority's own values, asserted directly above
 *     — which is the requirement, and which a policy edit would redden.
 */
