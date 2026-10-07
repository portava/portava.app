/**
 * census G200 — the server's SAVED-place zero-state rows, offered with no
 * network, through the real SmartInput on the field the app mounts it on
 * (`features/wall/components/WallHeader.tsx`: `wall.session_intent`,
 * `global_search`, declaring `WALL_STEER_CAPABILITIES`). Lead ruling 2026-10-07:
 * "keep saved-place and trip-destination zero-state rows in the existing
 * account-tagged device store, erased on account change, used only by
 * offline-allowed fields, with no position stored."
 *
 *   1. an empty field opened ONLINE is served a saved place; the same empty field
 *      opened OFFLINE later still shows it — never having been typed into;
 *   2. a server_required field served the same row shows nothing offline;
 *   3. an answer the server marked as an outage (`refusal`) does not replace the
 *      kept copy;
 *   4. after an account change the offline field shows nothing.
 *
 * Each offline half is a COLD START (`coldStartOffline`): nothing survives but
 * the device blob, so the row can only have come from the store this build writes.
 *
 * MUTATION LOG (applied, watched go red, restored byte-identically):
 *   - useInputAssistance.ts: drop the `retainZeroStateRows` call → test 1 red.
 *   - useInputAssistance.ts: drop `...offlineZeroStateRows(policy)` from the
 *     zero-state tier → test 1 red.
 *   - useInputAssistance.ts: drop the `!res.refusal` condition → test 3 red.
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts reaches the
// Supabase-backed token helper at load. `requestSuggestions` is its only export.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — `recordSuggestionSelection` is this module's
// only export, and the module reaches Supabase through apiToken.ts at load.
jest.mock('../../services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
}));

import { SmartInput } from '../SmartInput.tsx';
import { requestSuggestions } from '../../services/inputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { WALL_STEER_CAPABILITIES } from '../../contexts/clientCapabilities.ts';
import {
  attachLocalRecents,
  bindLocalRecentsAccount,
  clearLocalZeroState,
  detachLocalRecents,
  flushLocalRecents,
  _resetLocalRecentsAccountForTests,
} from '../../services/localZeroState.ts';
import type { LocalRecentsStorage } from '../../services/localRecentsStore.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';
import type { InputContext } from '../../types/inputContext.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy, _TEST_ACCOUNT } from '../../services/policyStore.ts';

// The registry's own offline vocabulary for the two fields (policyRegistry.ts).
_seedPolicy(_SEED_CONTEXTS, {
  global_search: { offlinePolicy: 'cached_local', privacyClass: 'public', debounceMs: 0 },
  place_picker: { offlinePolicy: 'server_required', privacyClass: 'public', debounceMs: 0 },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const WALL_FIELD = 'test.offlineZeroState.wall';
const PLACE_FIELD = 'test.offlineZeroState.place';
const OFFLINE = { ok: false as const, aborted: false, unavailable: true, error: 'endpoint unavailable' };

/** `savedEntities.ts#projectSavedPlace`, field for field. */
function savedRow(context: InputContext, id: string, label: string): InputSuggestion {
  return {
    id: `${context}:saved:place:${id}`, type: 'recent', context, label, entityType: 'place', entityId: id,
    action: { type: 'open_entity', entityType: 'place', entityId: id }, confidence: 0.8, source: 'memory',
    reason: 'Saved', destination: { route: `/place/${id}`, entityType: 'place', entityId: id },
    canonicalUri: `portava:/place/${id}`, policyVersion: 'input-2026-08',
  };
}

function served(rows: InputSuggestion[], extra: Record<string, unknown> = {}) {
  return { ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: rows, ...extra };
}

async function openEmpty(fieldId: string) {
  const r = await render(
    <SmartInput fieldId={fieldId} value="" onChangeText={() => {}} capabilities={WALL_STEER_CAPABILITIES} testID="zs-input" />,
  );
  fireEvent(r.getByTestId('zs-input'), 'focus');
  return r;
}

/** The device: what survives a cold start. */
function fakeStorage(): LocalRecentsStorage {
  const map = new Map<string, string>();
  return {
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { map.set(k, v); },
    async removeItem(k: string) { map.delete(k); },
  };
}

/**
 * A COLD START with the network gone: the process forgets everything it held —
 * the suggestion cache, the in-memory rows, who is signed in — and reads the
 * device back, the way `app/_layout.tsx` mounts it.
 */
async function coldStartOffline(device: LocalRecentsStorage, account: string) {
  await cleanup();
  await flushLocalRecents();
  detachLocalRecents();
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
  await attachLocalRecents(device);
  bindLocalRecentsAccount(account);
  mockRequest.mockReset();
  mockRequest.mockResolvedValue(OFFLINE);
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
  bindLocalRecentsAccount(_TEST_ACCOUNT);
  registerField(WALL_FIELD, 'global_search', { debounceMs: 0 });
  registerField(PLACE_FIELD, 'place_picker', { debounceMs: 0 });
});

afterEach(async () => {
  await cleanup();
  unregisterField(WALL_FIELD);
  unregisterField(PLACE_FIELD);
});

test('G200: a saved place served to the empty Wall field online is offered there offline, never having been typed into', async () => {
  const device = fakeStorage();
  await attachLocalRecents(device);
  mockRequest.mockResolvedValue(served([savedRow('global_search', 'p-1', 'Roast Lab')]));
  const online = await openEmpty(WALL_FIELD);
  await waitFor(() => expect(online.getByText('Roast Lab')).toBeTruthy(), { timeout: 8000 });

  await coldStartOffline(device, _TEST_ACCOUNT);
  const offline = await openEmpty(WALL_FIELD);
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  await waitFor(() => expect(offline.getByText('Roast Lab')).toBeTruthy(), { timeout: 8000 });
});

test('G200: a server_required field served the same row shows nothing offline', async () => {
  const device = fakeStorage();
  await attachLocalRecents(device);
  mockRequest.mockResolvedValue(served([savedRow('place_picker', 'p-1', 'Roast Lab')]));
  const online = await openEmpty(PLACE_FIELD);
  await waitFor(() => expect(online.getByText('Roast Lab')).toBeTruthy(), { timeout: 8000 });

  await coldStartOffline(device, _TEST_ACCOUNT);
  const offline = await openEmpty(PLACE_FIELD);
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  // Let the degraded answer land before asserting its absence.
  await new Promise((r) => setTimeout(r, 50));
  expect(offline.queryByText('Roast Lab')).toBeNull();
});

test('G200: an answer the server marked as an outage does not replace the kept copy', async () => {
  const device = fakeStorage();
  await attachLocalRecents(device);
  mockRequest.mockResolvedValue(served([savedRow('global_search', 'p-1', 'Roast Lab')]));
  const first = await openEmpty(WALL_FIELD);
  await waitFor(() => expect(first.getByText('Roast Lab')).toBeTruthy(), { timeout: 8000 });
  await cleanup();
  sharedSuggestionCache.clear();

  // The saved-places read failed server-side: an empty answer flagged partial.
  mockRequest.mockReset();
  mockRequest.mockResolvedValue(served([], { refusal: { class: 'dependency', code: 'saved_read_failed', route: 'input-assistance', coverage: 'partial', failedSources: ['saved'] } }));
  await openEmpty(WALL_FIELD);
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 50));

  await coldStartOffline(device, _TEST_ACCOUNT);
  const offline = await openEmpty(WALL_FIELD);
  await waitFor(() => expect(offline.getByText('Roast Lab')).toBeTruthy(), { timeout: 8000 });
});

test('G200: after an account change the offline field shows nothing', async () => {
  const device = fakeStorage();
  await attachLocalRecents(device);
  mockRequest.mockResolvedValue(served([savedRow('global_search', 'p-1', 'Roast Lab')]));
  const online = await openEmpty(WALL_FIELD);
  await waitFor(() => expect(online.getByText('Roast Lab')).toBeTruthy(), { timeout: 8000 });

  await coldStartOffline(device, 'someone-else');
  const offline = await openEmpty(WALL_FIELD);
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 50));
  expect(offline.queryByText('Roast Lab')).toBeNull();
});
