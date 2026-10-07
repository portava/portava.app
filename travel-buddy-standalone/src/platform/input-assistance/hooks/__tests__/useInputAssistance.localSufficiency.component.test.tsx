/**
 * Component test: §34 local SUFFICIENCY through the real hook (census G224,
 * G212).
 *
 * G224 asked for "a stated sufficiency rule the server can sanction … plus a test
 * that such a field issues zero requests on a local hit and that a viewer-scoped
 * field still issues one". G212's own red-criterion is the same build: "a
 * server-sanctioned statement that a named field may answer from a static
 * dictionary WITHOUT a round trip". These assertions are that test, over the
 * real `useInputAssistance`, a seeded authority table (passed through the real
 * `sanitizeServedPolicy`), and the real shipped language dictionary.
 *
 * MUTATION LOG (each applied, watched go red, reverted, `git diff` clean):
 *   - useInputAssistance.ts: drop the sufficiency branch → test 1 goes red (a
 *     request is made, the answer is the server's).
 *   - localDictionary.ts: `localAnswerSuffices` without the `privacyClass ===
 *     'public'` check, and `sufficientLocalRows` without the entity-hit check:
 *     BOTH SURVIVE HERE, measured — the dictionary itself refuses a non-public
 *     field, and these fields allow no `completion`, so the whole path is
 *     defended twice. Each is killed in services/__tests__/localSufficiency.test.ts.
 *   - policyFallback.ts: `localSufficient: true` for every served policy instead
 *     of `boolOrFalse(r.localSufficient)` → test 4 goes red (country_picker,
 *     which the authority does not sanction, stops asking).
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

// A context the authority WOULD sanction (`policyRegistry.ts#sanctionLocalSufficiency`):
// static_dictionary, public, nothing viewer-scoped, `localSufficient: true`.
// HYPOTHETICAL ON PURPOSE: the real registry sanctions NO context today
// (`language`/`interest` are raised to viewer_scoped; `country_picker`'s answer
// is viewer-dependent and id-bearing), so `language` is seeded public here to
// prove the client honours a grant. `interest` is seeded CLAIMING sufficiency
// while viewer-scoped — a misbehaving or newer server — which the client must
// refuse. `country_picker` is static_dictionary and NOT sanctioned.
const SANCTIONED = {
  offlinePolicy: 'static_dictionary',
  privacyClass: 'public',
  allowPersonalization: false,
  allowLiveContext: false,
  allowMemoryContext: false,
  allowAI: false,
  minChars: 1,
};
_seedPolicy(_SEED_CONTEXTS, {
  language: { ...SANCTIONED, entityTypes: ['language'], allowedSuggestionTypes: ['entity'], localSufficient: true },
  interest: {
    ...SANCTIONED,
    privacyClass: 'viewer_scoped',
    entityTypes: ['interest'],
    allowedSuggestionTypes: ['entity'],
    localSufficient: true,
  },
  country_picker: { ...SANCTIONED, entityTypes: ['country'], allowedSuggestionTypes: ['entity', 'recent'] },
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

test('G224: a VIEWER-SCOPED field still issues its request, even when the server claims sufficiency', async () => {
  render(<Probe fieldId={INTEREST_FIELD} text="hik" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
});

test('G212: a static_dictionary field the authority did NOT sanction keeps asking (the dictionary stays a fallback)', async () => {
  render(<Probe fieldId={COUNTRY_FIELD} text="thai" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
});
