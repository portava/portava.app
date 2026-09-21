/**
 * useWallSessionIntent — an OUTAGE of the shared input engine must not reach the
 * user as a statement about what they said (Wall spec §17 / census W71).
 *
 * THE DEFECT THIS FILE IS WRITTEN AGAINST
 * =======================================
 * `POST /wall/session-intent` answers 200 with a StructuredIntent. When the
 * shared Global Input Intelligence engine is down, that intent has `filters: []`
 * — the byte-for-byte same value it has when the engine ran perfectly and the
 * user's words simply matched no canonical entity. The hook used to take the 200
 * at face value and set the structured intent either way, so the screen rendered
 * zero chips in both cases and said nothing. The user reads zero chips as "the
 * app understood me and there was nothing there". One of those two times, that
 * is a lie about them.
 *
 * The server now names which of the four outcomes happened, and the hook
 * distinguishes them. Steering by raw text is unchanged in every case — the Wall
 * still renders (spec §34) — but `engineUnavailable` is now true exactly when
 * the engine failed, so a caller can say "we could not interpret that right now"
 * rather than implying a finding.
 *
 * MUTATIONS — each turns a named test below RED:
 *   C1  in `useWallSessionIntent`, drop the `if (res.resolution ===
 *       'engine_unavailable') setError(...)` branch
 *       → an outage becomes silent again. Kills "an outage is surfaced".
 *   C2  make `engineUnavailable` return `resolution !== 'resolved'`
 *       → a clean no-match is reported as an outage, which is the same defect
 *         pointing the other way. Kills "a clean no-match is not an outage".
 *   C3  in `useWallSessionIntent`, coerce the absent value —
 *       `setResolution(res.resolution ?? 'resolved_no_entities')`
 *       → an older server that says nothing is rendered as a finding.
 *         Kills "an unknown resolution is unknown, not fine".
 *
 * WHAT THESE TESTS DO NOT COVER, SAID OUT LOUD: `setSessionIntent` is mocked
 * here, so the wire-parsing half of the contract in `wallApi.setSessionIntent`
 * (an unrecognised or missing `intentResolution` becoming null rather than a
 * verdict) is NOT exercised by this file. It is asserted by the server-side
 * suite that the field is on the wire, and by reading; it is not proven here.
 */
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useWallSessionIntent } from '../useWallSessionIntent.ts';
import { setSessionIntent, clearSessionIntent } from '../../services/wallApi.ts';
import type { StructuredIntent } from '../../types/wallProjection.ts';

// NOTE: intentional stub — wallApi imports the native supabase client at module
// load. `setSessionIntent` and `clearSessionIntent` are the only members this
// hook touches, so this factory is exhaustive for the unit under test.
jest.mock('../../services/wallApi', () => ({
  setSessionIntent: jest.fn(),
  clearSessionIntent: jest.fn(async () => ({ ok: true })),
}));

const setSessionIntentMock = setSessionIntent as jest.Mock;

/** The intent an outage produces: a 200, and no filters — because nothing ran. */
function emptyIntent(): StructuredIntent {
  return {
    filters: [],
    keywords: ['nightlife'],
    sessionScoped: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as StructuredIntent;
}

beforeEach(() => {
  jest.clearAllMocks();
  (clearSessionIntent as jest.Mock).mockResolvedValue({ ok: true });
});

test('an outage is surfaced as an outage, not as an empty finding (kills C1)', async () => {
  setSessionIntentMock.mockResolvedValue({
    ok: true,
    sessionIntent: emptyIntent(),
    resolution: 'engine_unavailable',
  });

  const { result } = await renderHook(() => useWallSessionIntent());
  await act(async () => {
    await result.current.setIntent('bangkok nightlife');
  });

  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.engineUnavailable).toBe(true);
  expect(result.current.error).toBe('input_engine_unavailable');
  // …and the steer still applies. Fail-soft is not the thing being removed.
  expect(result.current.intentText).toBe('bangkok nightlife');
  expect(result.current.active).toBe(true);
});

test('a clean no-match is NOT an outage (kills C2)', async () => {
  setSessionIntentMock.mockResolvedValue({
    ok: true,
    sessionIntent: emptyIntent(),
    resolution: 'resolved_no_entities',
  });

  const { result } = await renderHook(() => useWallSessionIntent());
  await act(async () => {
    await result.current.setIntent('zzqqx nonsense');
  });

  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.engineUnavailable).toBe(false);
  expect(result.current.error).toBeNull();
  expect(result.current.resolution).toBe('resolved_no_entities');
});

test('an unknown resolution is unknown, not fine (kills C3)', async () => {
  // A server older than this field. The client must not invent a verdict.
  setSessionIntentMock.mockResolvedValue({
    ok: true,
    sessionIntent: emptyIntent(),
    resolution: null,
  });

  const { result } = await renderHook(() => useWallSessionIntent());
  await act(async () => {
    await result.current.setIntent('museums');
  });

  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.resolution).toBeNull();
  expect(result.current.engineUnavailable).toBe(false);
  expect(result.current.error).toBeNull();
});

test('clearing the steer clears the outage state too', async () => {
  setSessionIntentMock.mockResolvedValue({
    ok: true,
    sessionIntent: emptyIntent(),
    resolution: 'engine_unavailable',
  });

  const { result } = await renderHook(() => useWallSessionIntent());
  await act(async () => {
    await result.current.setIntent('bangkok');
  });
  await waitFor(() => expect(result.current.engineUnavailable).toBe(true));

  await act(async () => {
    result.current.clearIntent();
  });
  await waitFor(() => expect(result.current.engineUnavailable).toBe(false));
  expect(result.current.resolution).toBeNull();
  expect(result.current.error).toBeNull();
});
