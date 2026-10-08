/**
 * Component test: §34 local SUFFICIENCY through the real hook (census G224,
 * G212).
 *
 * G224 asked for "a stated sufficiency rule the server can sanction … plus a test
 * that such a field issues zero requests on a local hit and that a viewer-scoped
 * field still issues one". Lead ruling PR-D2-5 admits exactly two viewer-scoped
 * fields (language, interest) whose ANSWER is a fixed list; every other field —
 * viewer-scoped or not — still issues its request (test 4, and the pure suite).
 * G212's own red-criterion is the same build: "a
 * server-sanctioned statement that a named field may answer from a static
 * dictionary WITHOUT a round trip". These assertions are that test, over the
 * real `useInputAssistance`, a seeded authority table (passed through the real
 * `sanitizeServedPolicy`), and the real shipped language dictionary.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - useInputAssistance.ts: drop the sufficiency branch → test 1 goes red (a
 *     request is made, the answer is the server's).
 *   - localDictionary.ts: drop the context allowlist → SURVIVES HERE, measured:
 *     the answerer has a source only for the two contexts, so country_picker
 *     still asks. The allowlist is the gate's own guarantee and is killed in
 *     services/__tests__/localSufficiency.test.ts; test 4 is the whole-path
 *     statement that nothing else skips the request.
 *   - policyFallback.ts: `localSufficient: false` for every served policy instead
 *     of `boolOrFalse(r.localSufficient)` → tests 1 and 3 go red (the grant never
 *     reaches the hook).
 */

import React from 'react';
import { Text } from 'react-native';
import { render, screen, waitFor } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper (apiToken.ts) at module load, which has no
// native module under jest. `requestSuggestions` is its only export.
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

// The REAL registry's shape for the two sanctioned contexts after lead ruling
// PR-D2-5 (`lib/inputAssistance/policyRegistry.ts`): static_dictionary,
// viewer_scoped (the parity raise), nothing personalised, `localSufficient: true`.
// `country_picker` is seeded CLAIMING sufficiency, as a misbehaving or newer
// server might: it is not one of the two, so the client must still ask.
const SANCTIONED = {
  offlinePolicy: 'static_dictionary',
  privacyClass: 'viewer_scoped',
  allowPersonalization: false,
  allowLiveContext: false,
  allowMemoryContext: false,
  allowAI: false,
  minChars: 1,
  maxSuggestions: 8,
  localSufficient: true,
};
_seedPolicy(_SEED_CONTEXTS, {
  language: { ...SANCTIONED, entityTypes: ['language'], allowedSuggestionTypes: ['entity'] },
  interest: { ...SANCTIONED, entityTypes: ['interest'], allowedSuggestionTypes: ['entity'] },
  country_picker: { ...SANCTIONED, privacyClass: 'public', entityTypes: ['country'], allowedSuggestionTypes: ['entity', 'recent'] },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const LANGUAGE_FIELD = 'test.sufficiency.language';
const INTEREST_FIELD = 'test.sufficiency.interest';
const COUNTRY_FIELD = 'test.sufficiency.country';

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

const SERVED = {
  ok: true as const,
  requestId: 'req-x',
  policyVersion: 'input-2026-08',
  suggestions: [{
    id: 'srv:1', type: 'entity' as const, context: 'language' as const, label: 'From the server',
    source: 'canonical' as const, policyVersion: 'input-2026-08',
  }],
};

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue(SERVED);
  sharedSuggestionCache.clear();
  clearLocalZeroState();
  registerField(LANGUAGE_FIELD, 'language', { debounceMs: 0 });
  registerField(INTEREST_FIELD, 'interest', { debounceMs: 0 });
  registerField(COUNTRY_FIELD, 'country_picker', { debounceMs: 0 });
});

afterEach(() => {
  for (const f of [LANGUAGE_FIELD, INTEREST_FIELD, COUNTRY_FIELD]) unregisterField(f);
});

test('G224: a SANCTIONED field answers a dictionary hit from the shipped list with ZERO requests', async () => {
  render(<Probe fieldId={LANGUAGE_FIELD} text="span" />);
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Spanish'));
  expect(screen.getByTestId('sources').props.children).toBe('local');
  expect(screen.getByTestId('loading').props.children).toBe('false');
  // Let any debounce timer that should NOT exist fire before counting.
  await new Promise((r) => setTimeout(r, 30));
  expect(mockRequest).toHaveBeenCalledTimes(0);
});

test('G224: the same field with NO dictionary hit still asks the server', async () => {
  render(<Probe fieldId={LANGUAGE_FIELD} text="klingonese" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('From the server'));
});

test('G224: interest, the other sanctioned field, answers its hit locally too', async () => {
  // PR-D2-10: the interest list is the profile's own keys ("Hiking" is not one).
  render(<Probe fieldId={INTEREST_FIELD} text="nightl" />);
  await waitFor(() => expect(screen.getByTestId('labels').props.children).toBe('Nightlife'));
  await new Promise((r) => setTimeout(r, 30));
  expect(mockRequest).toHaveBeenCalledTimes(0);
});

test('G212: any OTHER field claiming sufficiency still asks (the client admits exactly the two)', async () => {
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
});
