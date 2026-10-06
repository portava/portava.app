/**
 * §45 / OD-INPUT-1 — the suggest request carries the outcome-learning hint ONLY
 * while this account's opt-in gate is open (services/outcomeLearning.ts). The
 * server re-checks flag and consent, so the hint grants nothing; its job is to
 * keep every non-consenting serve free of outcome reads (OD-INPUT-7 latency).
 *
 * MUTATION LOG (applied, watched go red, reverted):
 *   - useInputAssistance.ts: send `outcomeLearning: true` unconditionally →
 *     test 1 goes red.
 *   - useInputAssistance.ts: never send it → test 2 goes red.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, waitFor, cleanup } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — inputAssistance.ts imports the Supabase-backed
// token helper at load; `requestSuggestions` is its only export.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { applyOutcomeConsent, beginOutcomeAccount } from '../../services/outcomeLearning.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, {
  city_picker: { offlinePolicy: 'server_required', entityTypes: ['city'], allowedSuggestionTypes: ['entity', 'recent'], minChars: 1 },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.outcomeHint.city';

function Probe({ text }: { text: string }) {
  const { suggestions } = useInputAssistance({ fieldId: FIELD, text });
  return <Text testID="n">{String(suggestions.length)}</Text>;
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] } as any);
  sharedSuggestionCache.clear();
  registerField(FIELD, 'city_picker', { debounceMs: 0 });
});
afterEach(async () => {
  await cleanup();
  unregisterField(FIELD);
  beginOutcomeAccount(null);
});

test('gate CLOSED (never opted in): the request carries no outcome hint', async () => {
  beginOutcomeAccount('u1');
  render(<Probe text="sant" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1), { timeout: 8000 });
  expect(mockRequest.mock.calls[0]![0].outcomeLearning).toBeUndefined();
});

test('gate OPEN for this account: the request carries outcomeLearning: true', async () => {
  beginOutcomeAccount('u1');
  applyOutcomeConsent('u1', true);
  render(<Probe text="sant" />);
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(mockRequest.mock.calls[0]![0].outcomeLearning).toBe(true);
});
