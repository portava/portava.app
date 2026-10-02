/**
 * useInputAssistance — `answeredText` names the text whose SERVED answer is on
 * screen, and nothing else. census-discovery §80.15 (lane W10-S1, round 4),
 * register D-W10-S1-4 ("The handoff").
 *
 * The global search screen holds its legacy rows until the gateway has
 * answered the query currently typed, so it never swaps a live legacy list
 * for an empty or provisional gateway one. That rule is only as good as this
 * signal. A local-tier list (the longest cached prefix, narrowed on-device) is
 * shown WHILE the real answer is fetched: it is not an answer, and reporting it
 * as one would end the handoff early and swap sources on a guess.
 *
 * Reachable from: `hooks/useGlobalSearchSuggestions.ts`, the search screen.
 *
 * Run with: pnpm test:component
 */

import { renderHook, waitFor, act } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts imports the
// Supabase-backed token helper at module load. `requestSuggestions` is its only
// export.
jest.mock('../../services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
}));

import { requestSuggestions } from '../../services/inputAssistance.ts';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { _seedPolicyForTests } from '../../services/policyStore.ts';
import type { InputSuggestion } from '../../types/inputSuggestion.ts';

_seedPolicyForTests(['trip_destination']);

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const FIELD = 'test.answered.text';

function row(label: string, entityId: string): InputSuggestion {
  return {
    id: `s:${entityId}`,
    type: 'entity',
    context: 'trip_destination',
    label,
    entityType: 'city',
    entityId,
    source: 'canonical',
    policyVersion: 'test-policy-v1',
  };
}

beforeEach(() => {
  mockRequest.mockReset();
  sharedSuggestionCache.clear();
  registerField(FIELD, 'trip_destination', { debounceMs: 0 });
});
afterEach(() => unregisterField(FIELD));

it('a served answer names its text; a LOCAL-TIER list while the next answer is fetched does not', async () => {
  mockRequest.mockResolvedValueOnce({ ok: true, requestId: 'r1', policyVersion: 'test-policy-v1', suggestions: [row('Bangkok', 'c1'), row('Ban Phe', 'c2')] });
  const { result, rerender } = await renderHook(({ text }: { text: string }) => useInputAssistance({ fieldId: FIELD, text }), {
    initialProps: { text: 'ban' },
  });
  await waitFor(() => expect(result.current.answeredText).toBe('ban'));

  // "bang": the cached "ban" answer narrows on-device to Bangkok and is shown
  // at once, while the network answer for "bang" is still pending.
  let land!: (v: Awaited<ReturnType<typeof requestSuggestions>>) => void;
  mockRequest.mockReturnValueOnce(new Promise((r) => { land = r; }));
  await rerender({ text: 'bang' });
  await waitFor(() => expect(result.current.suggestions.map((s) => s.label)).toEqual(['Bangkok']));
  expect(result.current.answeredText).toBeNull();

  await act(async () => {
    land({ ok: true, requestId: 'r2', policyVersion: 'test-policy-v1', suggestions: [row('Bangkok', 'c1')] } as never);
  });
  await waitFor(() => expect(result.current.answeredText).toBe('bang'));
});

it('an exact CACHE hit is a served answer, and a field below minChars has none', async () => {
  mockRequest.mockResolvedValue({ ok: true, requestId: 'r1', policyVersion: 'test-policy-v1', suggestions: [row('Bangkok', 'c1')] });
  const { result, rerender } = await renderHook(({ text }: { text: string }) => useInputAssistance({ fieldId: FIELD, text }), {
    initialProps: { text: 'bang' },
  });
  await waitFor(() => expect(result.current.answeredText).toBe('bang'));

  await rerender({ text: 'b' });
  await waitFor(() => expect(result.current.answeredText).toBeNull());

  mockRequest.mockClear();
  await rerender({ text: 'bang' });
  await waitFor(() => expect(result.current.answeredText).toBe('bang'));
  expect(mockRequest).not.toHaveBeenCalled();
});
