/**
 * census-input-intelligence G203 — an AI row is never replayed from the
 * process-global cache.
 *
 * The exact-text cache hit returns before any network attempt, so a cached AI
 * row on a `public` (cacheable) field would come back offline, without the
 * server that produced it, for the cache's lifetime. No AI writer is mounted on
 * a public field today; this pins that mounting one later cannot replay AI
 * output, and that ordinary rows on the same field still cache.
 */
import { act, renderHook } from '@testing-library/react-native';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { _seedPolicyForTests } from '../../services/policyStore.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';
import type { InputSuggestion, SuggestResult } from '../../types/inputSuggestion.ts';

const mockRequest = jest.fn();
jest.mock('../../services/inputAssistance.ts', () => {
  return { requestSuggestions: (...args: unknown[]) => mockRequest(...args) };
});

const FIELD = 'test.input.ai-not-cached';
let pending: Array<{ resolve: (result: SuggestResult) => void }>;

function row(label: string, type: InputSuggestion['type']): InputSuggestion {
  return { id: label, label, type, context: 'city_picker', source: 'canonical', policyVersion: 'test-policy-v1' } as InputSuggestion;
}

function answer(rows: InputSuggestion[]): SuggestResult {
  return { ok: true, requestId: 'r', policyVersion: 'test-policy-v1', suggestions: rows };
}

async function tick() {
  await act(async () => { jest.advanceTimersByTime(100); });
}

beforeEach(() => {
  jest.useFakeTimers();
  setDiscoveryViewerFromSession('account-a');
  _seedPolicyForTests(['city_picker'], { city_picker: { privacyClass: 'public' } });
  registerField(FIELD, 'city_picker', { debounceMs: 100 });
  sharedSuggestionCache.clear();
  pending = [];
  mockRequest.mockReset().mockImplementation(() =>
    new Promise<SuggestResult>((resolve) => pending.push({ resolve })),
  );
});

afterEach(() => {
  unregisterField(FIELD);
  sharedSuggestionCache.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('an answer carrying an AI row is shown but never written to the shared cache', async () => {
  const hook = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'city' }));
  await tick();
  await act(async () => { pending[0].resolve(answer([row('Lisbon', 'entity'), row('Try a quieter neighbourhood', 'ai_suggestion')])); });
  expect(hook.result.current.suggestions.map((s) => s.type)).toContain('ai_suggestion');
  expect(sharedSuggestionCache.size).toBe(0);
});

it('CONTROL: the same public field still caches an answer with no AI row', async () => {
  const hook = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'city' }));
  await tick();
  await act(async () => { pending[0].resolve(answer([row('Lisbon', 'entity')])); });
  expect(hook.result.current.suggestions.map((s) => s.label)).toEqual(['Lisbon']);
  expect(sharedSuggestionCache.size).toBe(1);
});
