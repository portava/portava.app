/**
 * OD-INPUT-7 — "Show local suggestions immediately while slower results load" —
 * and §34 "prefer local: static dictionaries" (census G212: consulted BEFORE the
 * network, not only instead of it after the network failed). Through the REAL
 * hook, with the server's answer held back so "before" is observable.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - useInputAssistance.ts: drop the immediate-dictionary arm from `local` →
 *     test 1 goes red (nothing on screen while the request is in flight).
 *   - localDictionary.ts localDictionaryFor (the gate the immediate tier uses):
 *     drop the privacy-class check → test 4 goes red (a viewer-scoped field
 *     shows a shipped row). Test 3's server_required case is held twice over
 *     (the licence check and the surface map), and SURFACE_ENTITY_CLASSES'
 *     header records why removing one of the two alone cannot redden it.
 *   - useInputAssistance.ts: skip the request when the immediate tier hit →
 *     test 1 goes red (the server must still be asked).
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — inputAssistance.ts imports the Supabase-backed
// token helper at load; `requestSuggestions` is its only export.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { clearLocalZeroState } from '../../services/localZeroState.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';

// The registry's own offline vocabulary (see useInputAssistance.offline…): country_picker
// is static_dictionary, place_picker server_required. `interest` is seeded VIEWER-SCOPED
// here to prove the privacy gate on a field that does have a shipped dictionary.
_seedPolicy(_SEED_CONTEXTS, {
  country_picker: { offlinePolicy: 'static_dictionary', entityTypes: ['country'], allowedSuggestionTypes: ['entity', 'recent'], minChars: 1 },
  place_picker: { offlinePolicy: 'server_required', entityTypes: ['place', 'country'], allowedSuggestionTypes: ['entity', 'recent'], minChars: 1 },
  interest: { offlinePolicy: 'static_dictionary', entityTypes: ['interest'], allowedSuggestionTypes: ['entity'], minChars: 1, privacyClass: 'viewer_scoped' },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const COUNTRY = 'test.immediate.country';
const PLACE = 'test.immediate.place';
const INTEREST = 'test.immediate.interest';

function Probe({ fieldId, text }: { fieldId: string; text: string }) {
  const { suggestions, loading } = useInputAssistance({ fieldId, text });
  return (
    <>
      <Text testID="labels">{suggestions.map((s) => s.label).join('|')}</Text>
      <Text testID="sources">{suggestions.map((s) => s.source).join('|')}</Text>
      <Text testID="loading">{String(loading)}</Text>
    </>
  );
}

/** A request that stays in flight until the test releases it. */
function heldRequest() {
  let release!: (v: Awaited<ReturnType<typeof requestSuggestions>>) => void;
  mockRequest.mockImplementationOnce(() => new Promise((r) => { release = r; }));
  return (v: Awaited<ReturnType<typeof requestSuggestions>>) => release(v);
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  registerField(COUNTRY, 'country_picker', { debounceMs: 0 });
  registerField(PLACE, 'place_picker', { debounceMs: 0 });
  registerField(INTEREST, 'interest', { debounceMs: 0 });
});
afterEach(async () => {
  await cleanup();
  unregisterField(COUNTRY);
  unregisterField(PLACE);
  unregisterField(INTEREST);
});

test('the shipped row is on screen WHILE the request is in flight — and the server is still asked', async () => {
  heldRequest();
  render(<Probe fieldId={COUNTRY} text="thai" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('labels').props.children).toBe('Thailand');
  expect(screen.getByTestId('sources').props.children).toBe('local');
  expect(screen.getByTestId('loading').props.children).toBe('true');
});

test('the server answer REPLACES the local rows when it lands', async () => {
  const release = heldRequest();
  render(<Probe fieldId={COUNTRY} text="thai" />);
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Thailand'));
  await act(async () => {
    release({
      ok: true, requestId: 'r1', policyVersion: 'input-2026-08',
      suggestions: [{ id: 'th', type: 'entity', context: 'country_picker', label: 'Kingdom of Thailand', entityType: 'country', entityId: 'th', source: 'canonical', policyVersion: 'input-2026-08' }],
    } as any);
  });
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Kingdom of Thailand'));
  expect(screen.getByTestId('sources').props.children).toBe('canonical');
});

test('a SERVER_REQUIRED field shows nothing local while it waits', async () => {
  heldRequest();
  render(<Probe fieldId={PLACE} text="thai" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('labels').props.children).toBe('');
});

test('a VIEWER-SCOPED field shows nothing local while it waits, even with a shipped dictionary', async () => {
  heldRequest();
  render(<Probe fieldId={INTEREST} text="hik" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId('labels').props.children).toBe('');
});
