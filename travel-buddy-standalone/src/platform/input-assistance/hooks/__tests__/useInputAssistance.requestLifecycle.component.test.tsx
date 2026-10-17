import { act, renderHook } from '@testing-library/react-native';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { _seedPolicyForTests } from '../../services/policyStore.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { setTelemetrySink, resetTelemetrySink } from '../../services/inputTelemetry.ts';
import type { SuggestResult } from '../../types/inputSuggestion.ts';

const mockRequest = jest.fn();
const mockTelemetry = jest.fn();

jest.mock('../../services/inputAssistance.ts', () => {
  return { requestSuggestions: (...args: unknown[]) => mockRequest(...args) };
});

const FIELD = 'test.input.request-lifecycle';
let pending: Array<{ signal: AbortSignal; resolve: (answer: SuggestResult) => void }>;

function answer(label: string): SuggestResult {
  return {
    ok: true,
    requestId: label,
    policyVersion: 'test-policy-v1',
    suggestions: [{
      id: label, label, entityId: label, entityType: 'city', type: 'entity',
      context: 'city_picker', source: 'canonical', policyVersion: 'test-policy-v1',
    }],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  pending = [];
  _seedPolicyForTests(['city_picker'], { city_picker: { privacyClass: 'public' } });
  registerField(FIELD, 'city_picker', { debounceMs: 100 });
  sharedSuggestionCache.clear();
  mockTelemetry.mockReset();
  setTelemetrySink(mockTelemetry);
  mockRequest.mockReset().mockImplementation((_options: unknown, signal: AbortSignal) =>
    new Promise<SuggestResult>((resolve) => pending.push({ signal, resolve })),
  );
});

afterEach(() => {
  unregisterField(FIELD);
  sharedSuggestionCache.clear();
  resetTelemetrySink();
  jest.useRealTimers();
});

async function tick() {
  await act(async () => { jest.advanceTimersByTime(100); });
}

it('invalidates in-flight suggestions before the replacement debounce runs', async () => {
  const hook = await renderHook(({ text }: { text: string }) => useInputAssistance({ fieldId: FIELD, text }), {
    initialProps: { text: 'old' },
  });
  await tick();
  await hook.rerender({ text: 'new' });
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => { pending[0].resolve(answer('Old city')); });
  expect(hook.result.current.suggestions).toEqual([]);
  expect(hook.result.current.loading).toBe(true);
  await tick();
  await act(async () => { pending[1].resolve(answer('New city')); });
  expect(hook.result.current.suggestions.map((row) => row.label)).toEqual(['New city']);
});

it('a cache hit aborts the superseded request and cannot be replaced by its late answer', async () => {
  const hook = await renderHook(({ text }: { text: string }) => useInputAssistance({ fieldId: FIELD, text }), {
    initialProps: { text: 'rome' },
  });
  await tick();
  await act(async () => { pending[0].resolve(answer('Rome')); });
  await hook.rerender({ text: 'paris' });
  await tick();
  await hook.rerender({ text: 'rome' });
  expect(pending[1].signal.aborted).toBe(true);
  expect(hook.result.current.answeredText).toBe('rome');
  await act(async () => { pending[1].resolve(answer('Paris')); });
  expect(hook.result.current.suggestions.map((row) => row.label)).toEqual(['Rome']);
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

it('disabling cancels pending work and active work without a late answer', async () => {
  const hook = await renderHook(({ enabled }: { enabled: boolean }) => useInputAssistance({ fieldId: FIELD, text: 'rome', enabled }), {
    initialProps: { enabled: true },
  });
  await hook.rerender({ enabled: false });
  await tick();
  expect(mockRequest).not.toHaveBeenCalled();
  await hook.rerender({ enabled: true });
  await tick();
  await hook.rerender({ enabled: false });
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => { pending[0].resolve(answer('Rome')); });
  expect(hook.result.current.suggestions).toEqual([]);
  expect(hook.result.current.loading).toBe(false);
});

it('unmount prevents late cache writes and completion telemetry even if transport ignores abort', async () => {
  const hook = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'rome' }));
  await tick();
  await hook.unmount();
  mockTelemetry.mockClear();
  await act(async () => { pending[0].resolve(answer('Rome')); });
  expect(pending[0].signal.aborted).toBe(true);
  expect(mockTelemetry).not.toHaveBeenCalled();
  const next = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'rome' }));
  await tick();
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(next.result.current.suggestions).toEqual([]);
});
