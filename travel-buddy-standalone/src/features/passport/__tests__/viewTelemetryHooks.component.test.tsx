/**
 * usePassportViewedTelemetry + useMemoryViewedTelemetry — the two §32 "viewed"
 * events fire once, at the right moment, with ids/enums only.
 *
 *   passport_viewed: not before `enabled`; once per subject; re-armed when the
 *   subject changes; carries the server viewerContext (the scrubber's explicit
 *   allow-list keeps that key — a regression here would drop it silently).
 *
 *   memory_viewed: not before the memory has loaded; once per memory id.
 */
import { act, renderHook } from '@testing-library/react-native';
import { usePassportViewedTelemetry } from '../usePassportViewedTelemetry.ts';
import { useMemoryViewedTelemetry } from '../useMemoryViewedTelemetry.ts';
import {
  resetPassportTelemetrySink,
  setPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../passportTelemetry.ts';
import type { PassportViewerContext } from '../../../services/passportProjection.ts';

describe('usePassportViewedTelemetry', () => {
  let events: PassportTelemetryEvent[];
  beforeEach(() => {
    events = [];
    setPassportTelemetrySink((e) => events.push(e));
  });
  afterEach(() => resetPassportTelemetrySink());

  it('emits nothing until enabled, then once with subjectId + viewerContext', async () => {
    const { rerender } = await renderHook(
      ({ enabled, ctx }: { enabled: boolean; ctx: PassportViewerContext | null }) =>
        usePassportViewedTelemetry('them-1', ctx, enabled),
      { initialProps: { enabled: false, ctx: null } },
    );
    expect(events).toEqual([]);

    await act(async () => { rerender({ enabled: true, ctx: 'follower' }); });
    expect(events).toEqual([{ type: 'passport_viewed', payload: { subjectId: 'them-1', viewerContext: 'follower' } }]);

    // Re-renders with the same subject never double-count.
    await act(async () => { rerender({ enabled: true, ctx: 'follower' }); });
    await act(async () => { rerender({ enabled: true, ctx: 'following' }); });
    expect(events).toHaveLength(1);
  });

  it('re-arms when the subject changes', async () => {
    const { rerender } = await renderHook(
      ({ id }: { id: string }) => usePassportViewedTelemetry(id, 'public', true),
      { initialProps: { id: 'a' } },
    );
    await act(async () => { rerender({ id: 'b' }); });
    expect(events.map((e) => (e.payload as { subjectId: string }).subjectId)).toEqual(['a', 'b']);
  });

  it('ignores a blank subject', async () => {
    await renderHook(() => usePassportViewedTelemetry('   ', 'self', true));
    await renderHook(() => usePassportViewedTelemetry(null, 'self', true));
    expect(events).toEqual([]);
  });
});

describe('useMemoryViewedTelemetry', () => {
  let events: PassportTelemetryEvent[];
  beforeEach(() => {
    events = [];
    setPassportTelemetrySink((e) => events.push(e));
  });
  afterEach(() => resetPassportTelemetrySink());

  it('emits once the memory has loaded, once per id', async () => {
    const { rerender } = await renderHook(
      ({ loaded }: { loaded: boolean }) => useMemoryViewedTelemetry('mem-1', loaded),
      { initialProps: { loaded: false } },
    );
    expect(events).toEqual([]);
    await act(async () => { rerender({ loaded: true }); });
    await act(async () => { rerender({ loaded: true }); });
    expect(events).toEqual([{ type: 'memory_viewed', payload: { memoryId: 'mem-1' } }]);
  });

  it('counts a different memory separately', async () => {
    const { rerender } = await renderHook(
      ({ id }: { id: string }) => useMemoryViewedTelemetry(id, true),
      { initialProps: { id: 'mem-1' } },
    );
    await act(async () => { rerender({ id: 'mem-2' }); });
    expect(events.map((e) => (e.payload as { memoryId: string }).memoryId)).toEqual(['mem-1', 'mem-2']);
  });
});
