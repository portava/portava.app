import { act, renderHook } from '@testing-library/react-native';
import { useInputAssistance } from '../useInputAssistance.ts';
import { registerField, unregisterField } from '../../contexts/fieldRegistry.ts';
import { _seedPolicyForTests } from '../../services/policyStore.ts';
import { sharedSuggestionCache } from '../../services/suggestionCache.ts';
import { resetTelemetrySink, setTelemetrySink } from '../../services/inputTelemetry.ts';
import { setDiscoveryViewerFromSession } from '../../../../services/discoveryViewerScope.ts';
import type { InputSessionContext, SuggestResult } from '../../types/inputSuggestion.ts';

const mockRequest = jest.fn();
const mockTelemetry = jest.fn();
jest.mock('../../services/inputAssistance.ts', () => {
  return { requestSuggestions: (...args: unknown[]) => mockRequest(...args) };
});

const FIELD = 'test.input.account-privacy';
let pending: Array<{ signal: AbortSignal; resolve: (result: SuggestResult) => void }>;

function answer(label: string): SuggestResult {
  return {
    ok: true, requestId: label, policyVersion: 'test-policy-v1',
    suggestions: [{ id: label, label, type: 'entity', context: 'city_picker', source: 'canonical', policyVersion: 'test-policy-v1' }],
  };
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
  mockRequest.mockReset().mockImplementation((_options: unknown, signal: AbortSignal) =>
    new Promise<SuggestResult>((resolve) => pending.push({ signal, resolve })),
  );
  mockTelemetry.mockReset();
  setTelemetrySink(mockTelemetry);
});

afterEach(() => {
  unregisterField(FIELD);
  sharedSuggestionCache.clear();
  resetTelemetrySink();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it.each(['account-b', 'account-a'])('a late reply cannot refill the cleared cache after sign-out and sign-in as %s', async (nextAccount) => {
  const hook = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'city' }));
  await tick();
  mockTelemetry.mockClear();
  await act(async () => {
    setDiscoveryViewerFromSession(null);
    sharedSuggestionCache.clear();
    setDiscoveryViewerFromSession(nextAccount);
    pending[0].resolve(answer('Old account city'));
  });
  expect(sharedSuggestionCache.size).toBe(0);
  expect(hook.result.current.suggestions).toEqual([]);
  expect(mockTelemetry.mock.calls.filter(([event]) => event.name === 'suggestion_request_completed')).toEqual([]);
  await tick();
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await act(async () => { pending[1].resolve(answer('Current account city')); });
  expect(hook.result.current.suggestions.map((row) => row.label)).toEqual(['Current account city']);
  expect(sharedSuggestionCache.size).toBe(1);
});

it('an account change clears already served rows and their provenance without a parent rerender', async () => {
  const hook = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'city' }));
  await tick();
  await act(async () => { pending[0].resolve(answer('Old account city')); });
  expect(sharedSuggestionCache.size).toBe(1);
  await act(async () => { setDiscoveryViewerFromSession('account-b'); });
  expect(sharedSuggestionCache.size).toBe(0);
  expect(hook.result.current.suggestions).toEqual([]);
  expect(hook.result.current.requestId).toBeNull();
  expect(hook.result.current.answeredText).toBeNull();
});

it.each(['tripId', 'eventId', 'cityId', 'countryId', 'tz', 'startDate', 'endDate', 'surface'] as const)(
  'public exact and prefix cache entries are separated by session %s', async (dimension) => {
    const hook = await renderHook(({ sessionContext, text }: { sessionContext: InputSessionContext; text: string }) => useInputAssistance({ fieldId: FIELD, text, sessionContext }), {
      initialProps: { sessionContext: { [dimension]: 'private-scope-a' } as InputSessionContext, text: 'city' },
    });
    await tick();
    await act(async () => { pending[0].resolve(answer('city A')); });
    await hook.rerender({ sessionContext: { [dimension]: 'private-scope-b' }, text: 'city' });
    await tick();
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(hook.result.current.suggestions).toEqual([]);
    await act(async () => { pending[1].resolve(answer('city B')); });
    await hook.rerender({ sessionContext: { [dimension]: 'private-scope-c' }, text: 'city B' });
    expect(hook.result.current.suggestions).toEqual([]);
    await tick();
    await act(async () => { pending[2].resolve(answer('city C')); });
    expect(hook.result.current.suggestions.map((row) => row.label)).toEqual(['city C']);
  },
);

it('equivalent session property order preserves the active request and cache keys contain no raw scope values', async () => {
  const write = jest.spyOn(sharedSuggestionCache, 'set');
  const hook = await renderHook(({ sessionContext }: { sessionContext: InputSessionContext }) => useInputAssistance({ fieldId: FIELD, text: 'city', sessionContext }), {
    initialProps: { sessionContext: { tripId: 'private-trip', eventId: 'private-event', lat: 1.301, lng: 103.801 } },
  });
  await tick();
  await hook.rerender({ sessionContext: { eventId: 'private-event', tripId: 'private-trip', lng: 103.802, lat: 1.302 } });
  expect(pending[0].signal.aborted).toBe(false);
  await act(async () => { pending[0].resolve(answer('city')); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0][0]).not.toMatch(/private-trip|private-event/);
  await hook.rerender({ sessionContext: { tripId: 'private-trip', eventId: 'private-event', lat: 1.301, lng: 103.801 } });
  await tick();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(hook.result.current.suggestions).toHaveLength(1);
  await hook.unmount();
  const reopened = await renderHook(() => useInputAssistance({
    fieldId: FIELD, text: 'city', sessionContext: { eventId: 'private-event', tripId: 'private-trip', lng: 103.802, lat: 1.302 },
  }));
  await tick();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(reopened.result.current.suggestions.map((row) => row.label)).toEqual(['city']);
});

it('a scope change followed by 403 never retains the prior scope rows or provenance', async () => {
  const hook = await renderHook(({ sessionContext, text }: { sessionContext: InputSessionContext; text: string }) => useInputAssistance({ fieldId: FIELD, text, sessionContext }), {
    initialProps: { sessionContext: { tripId: 'trip-a' }, text: 'city' },
  });
  await tick();
  await act(async () => { pending[0].resolve(answer('city A')); });
  await hook.rerender({ sessionContext: { tripId: 'trip-b' }, text: 'other' });
  await tick();
  await act(async () => { pending[1].resolve({ ok: false, aborted: false, unavailable: false, error: 'HTTP 403' }); });
  expect(hook.result.current.suggestions).toEqual([]);
  expect(hook.result.current.requestId).toBeNull();
  expect(hook.result.current.answeredText).toBeNull();
  expect(hook.result.current.refusal).toBeNull();
});

it.each(['HTTP 401', 'HTTP 403'])('a same-scope %s also clears previously authorized rows', async (error) => {
  const hook = await renderHook(({ text }: { text: string }) => useInputAssistance({ fieldId: FIELD, text }), { initialProps: { text: 'city' } });
  await tick();
  await act(async () => { pending[0].resolve(answer('city')); });
  await hook.rerender({ text: 'city new' });
  await tick();
  await act(async () => { pending[1].resolve({ ok: false, aborted: false, unavailable: false, error }); });
  expect(hook.result.current.suggestions).toEqual([]);
  expect(hook.result.current.requestId).toBeNull();
  expect(hook.result.current.answeredText).toBeNull();
});

it('healthy same-scope typing retains rows on a transient failure and token refresh does not invalidate them', async () => {
  const hook = await renderHook(({ text }: { text: string }) => useInputAssistance({ fieldId: FIELD, text }), { initialProps: { text: 'city' } });
  await tick();
  await act(async () => { pending[0].resolve(answer('city')); });
  await act(async () => { setDiscoveryViewerFromSession('account-a'); });
  await hook.rerender({ text: 'city new' });
  await tick();
  await act(async () => { pending[1].resolve({ ok: false, aborted: false, unavailable: false, error: 'HTTP 500' }); });
  expect(hook.result.current.suggestions.map((row) => row.label)).toEqual(['city']);
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

it('non-public policy still cannot write the process-wide cache', async () => {
  _seedPolicyForTests(['city_picker'], { city_picker: { privacyClass: 'viewer_scoped' } });
  const hook = await renderHook(() => useInputAssistance({ fieldId: FIELD, text: 'city', sessionContext: { tripId: 'private-trip' } }));
  await tick();
  await act(async () => { pending[0].resolve(answer('Private result')); });
  expect(hook.result.current.suggestions).toHaveLength(1);
  expect(sharedSuggestionCache.size).toBe(0);
});
