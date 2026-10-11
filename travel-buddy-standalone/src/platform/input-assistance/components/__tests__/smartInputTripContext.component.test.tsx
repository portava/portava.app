/**
 * census G201 and G179 through the real SmartInput, on the field the app mounts
 * it on (`features/wall/components/WallHeader.tsx`: `wall.session_intent`,
 * `global_search`, declaring `WALL_STEER_CAPABILITIES`).
 *
 *   G201 — a place ON the viewer's Trip, served to the empty field online
 *          (gateway.ts non-geo zero state, `…:trip:place:…`, 'On your Trip'), is
 *          offered there OFFLINE after a cold start, never having been typed
 *          into; a nearby place served beside it is not kept (only Trip, saved and
 *          Trip-destination rows are); after an account change nothing shows.
 *   G179 — a typed place row the server marked `relationship: 'in_trip'` shows an
 *          "In your Trip" badge, `'saved'` shows "Saved", a value this build cannot
 *          name shows nothing, and a row without one shows no badge.
 *
 * MUTATION LOG (applied, watched go red, restored byte-identically):
 *   - localRecentsStore.ts: drop the `:trip:place:` arm of isRetainableZeroStateRow → G201 offline red.
 *   - suggestionBadges.ts: drop the `relationshipBadge` push → both G179 positives red.
 *   - suggestionBadges.ts: relationshipBadge renders any string → the unknown-value control red.
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
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy, _TEST_ACCOUNT } from '../../services/policyStore.ts';

// The registry's own offline vocabulary for the Wall's field (policyRegistry.ts).
_seedPolicy(_SEED_CONTEXTS, {
  global_search: { offlinePolicy: 'cached_local', privacyClass: 'public', debounceMs: 0 },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const WALL_FIELD = 'test.tripContext.wall';
const OFFLINE = { ok: false as const, aborted: false, unavailable: true, error: 'endpoint unavailable' };

/** `zeroStatePlaces.ts#projectPlace`, field for field, for kind 'trip' / 'nearby'. */
function placeRow(kind: 'trip' | 'nearby', id: string, label: string): InputSuggestion {
  return {
    id: `global_search:${kind}:place:${id}`, type: 'entity', context: 'global_search', label, entityType: 'place', entityId: id,
    action: { type: 'open_entity', entityType: 'place', entityId: id }, confidence: kind === 'trip' ? 0.68 : 0.66,
    source: kind === 'trip' ? 'memory' : 'canonical', reason: kind === 'trip' ? 'On your Trip' : 'Nearby',
    destination: { route: `/place/${id}`, entityType: 'place', entityId: id }, canonicalUri: `portava:/place/${id}`,
    subtitle: 'Da Nang · landmark', policyVersion: 'input-2026-08',
  };
}

/** `projection.ts#projectSearchResult` for a typed place, plus the G179 label. */
function typedPlace(id: string, label: string, relationship?: string): InputSuggestion {
  const s: InputSuggestion = {
    id: `global_search:place:${id}`, type: 'entity', context: 'global_search', label, entityType: 'place', entityId: id,
    action: { type: 'open_entity', entityType: 'place', entityId: id }, confidence: 0.9, source: 'canonical',
    destination: { route: `/place/${id}`, entityType: 'place', entityId: id }, policyVersion: 'input-2026-08',
  };
  if (relationship !== undefined) s.relationship = relationship;
  return s;
}

function served(rows: InputSuggestion[]) {
  return { ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: rows };
}

async function open(text = '') {
  const r = await render(
    <SmartInput fieldId={WALL_FIELD} value={text} onChangeText={() => {}} capabilities={WALL_STEER_CAPABILITIES} testID="tc-input" />,
  );
  fireEvent(r.getByTestId('tc-input'), 'focus');
  return r;
}

function fakeStorage(): LocalRecentsStorage {
  const map = new Map<string, string>();
  return {
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { map.set(k, v); },
    async removeItem(k: string) { map.delete(k); },
  };
}

/** A COLD START with the network gone (see smartInputOfflineZeroState.component.test.tsx). */
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
});

afterEach(async () => {
  await cleanup();
  unregisterField(WALL_FIELD);
});

test('G201: a place on the viewer\'s Trip, served to the empty Wall field online, is offered there OFFLINE never having been typed into', async () => {
  const device = fakeStorage();
  await attachLocalRecents(device);
  mockRequest.mockResolvedValue(served([placeRow('trip', 'p-trip', 'Marble Mountains'), placeRow('nearby', 'p-near', 'Beach Coffee')]));
  const online = await open();
  await waitFor(() => expect(online.getByText('Marble Mountains')).toBeTruthy(), { timeout: 8000 });
  expect(online.getByText('Beach Coffee')).toBeTruthy();

  await coldStartOffline(device, _TEST_ACCOUNT);
  const offline = await open();
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  await waitFor(() => expect(offline.getByText('Marble Mountains')).toBeTruthy(), { timeout: 8000 });
  // Only Trip, saved and Trip-destination rows are kept: the nearby place is re-asked, never stored.
  expect(offline.queryByText('Beach Coffee')).toBeNull();
});

test('G201: after an account change the offline field shows no Trip place', async () => {
  const device = fakeStorage();
  await attachLocalRecents(device);
  mockRequest.mockResolvedValue(served([placeRow('trip', 'p-trip', 'Marble Mountains')]));
  const online = await open();
  await waitFor(() => expect(online.getByText('Marble Mountains')).toBeTruthy(), { timeout: 8000 });

  await coldStartOffline(device, 'someone-else');
  const offline = await open();
  await waitFor(() => expect(mockRequest).toHaveBeenCalled(), { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 50));
  expect(offline.queryByText('Marble Mountains')).toBeNull();
});

test('G179: a typed place on the viewer\'s Trip shows "In your Trip"; a saved one shows "Saved"', async () => {
  mockRequest.mockResolvedValue(served([typedPlace('p-1', 'Marble Mountains', 'in_trip'), typedPlace('p-2', 'Roast Lab', 'saved')]));
  const r = await open('mar');
  await waitFor(() => expect(r.getByText('Marble Mountains')).toBeTruthy(), { timeout: 8000 });
  expect(r.getByText('In your Trip')).toBeTruthy();
  expect(r.getByText('Saved')).toBeTruthy();
  expect(r.getAllByTestId('ia-badge-in_trip')).toHaveLength(1);
  expect(r.getAllByTestId('ia-badge-saved')).toHaveLength(1);
});

test('G179 CONTROL: a row with no relationship, or one this build cannot name, shows no relationship badge', async () => {
  mockRequest.mockResolvedValue(served([typedPlace('p-3', 'Hoi An Bakery'), typedPlace('p-4', 'Night Market', 'followed_by_crew')]));
  const r = await open('ba');
  await waitFor(() => expect(r.getByText('Hoi An Bakery')).toBeTruthy(), { timeout: 8000 });
  expect(r.getByText('Night Market')).toBeTruthy();
  expect(r.queryByText('In your Trip')).toBeNull();
  expect(r.queryByText('Saved')).toBeNull();
  expect(r.queryByText('followed_by_crew')).toBeNull();
  expect(r.queryAllByTestId(/^ia-badge-/)).toHaveLength(0);
});
