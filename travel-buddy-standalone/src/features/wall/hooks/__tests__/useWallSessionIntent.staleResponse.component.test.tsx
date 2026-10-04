/**
 * census-wall §19 — useWallSessionIntent applies only the answer to what the
 * viewer asked LAST.
 *
 * `setIntent` steers by text at once and then awaits the server's structured
 * interpretation. The await was unguarded, so:
 *   - type "tokyo", then "bangkok" before tokyo's answer lands: whichever answer
 *     arrived LAST won, and the chip — labelled from the structured filters —
 *     could say Tokyo over a feed steered by "bangkok";
 *   - clear the steer while an answer is in flight: the answer re-set a
 *     structured intent and an outage error onto a Wall with no steer;
 *   - the first request to FINISH cleared `pending` while a later one was
 *     still running.
 */
import { act, renderHook } from '@testing-library/react-native';
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

function intentFor(label: string): StructuredIntent {
  return {
    filters: [{ kind: 'city', label, entityId: `city-${label}` }],
    keywords: [],
    sessionScoped: true,
    createdAt: '2026-10-03T00:00:00.000Z',
  } as unknown as StructuredIntent;
}

type Answer = { ok: true; sessionIntent: StructuredIntent; resolution: string } | { ok: false; error: string };

/** Each call returns a promise the test resolves by hand, in any order. */
function deferredAnswers() {
  const resolvers: Record<string, (a: Answer) => void> = {};
  setSessionIntentMock.mockImplementation(
    (text: string) => new Promise<Answer>((r) => { resolvers[text] = r; }),
  );
  return resolvers;
}

beforeEach(() => {
  jest.clearAllMocks();
  (clearSessionIntent as jest.Mock).mockResolvedValue({ ok: true });
});

test('an OLDER answer that lands last does not overwrite the newer steer', async () => {
  const answer = deferredAnswers();
  const { result } = await renderHook(() => useWallSessionIntent());

  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => {
    first = result.current.setIntent('tokyo');
  });
  await act(async () => {
    second = result.current.setIntent('bangkok');
  });
  await act(async () => {
    answer.bangkok({ ok: true, sessionIntent: intentFor('Bangkok'), resolution: 'resolved' });
    await second;
  });
  expect(result.current.intent?.filters[0]?.label).toBe('Bangkok');
  expect(result.current.pending).toBe(false);

  await act(async () => {
    answer.tokyo({ ok: true, sessionIntent: intentFor('Tokyo'), resolution: 'resolved' });
    await first;
  });
  expect(result.current.intentText).toBe('bangkok');
  expect(result.current.intent?.filters[0]?.label).toBe('Bangkok');
});

test('the first request to finish does not clear `pending` while a newer one is still running', async () => {
  const answer = deferredAnswers();
  const { result } = await renderHook(() => useWallSessionIntent());
  let first!: Promise<void>;
  await act(async () => {
    first = result.current.setIntent('tokyo');
  });
  await act(async () => {
    void result.current.setIntent('bangkok');
  });
  await act(async () => {
    answer.tokyo({ ok: true, sessionIntent: intentFor('Tokyo'), resolution: 'resolved' });
    await first;
  });
  expect(result.current.pending).toBe(true);
});

test('an answer that lands after the steer was CLEARED leaves the Wall unsteered', async () => {
  const answer = deferredAnswers();
  const { result } = await renderHook(() => useWallSessionIntent());
  let first!: Promise<void>;
  await act(async () => {
    first = result.current.setIntent('tokyo');
  });
  await act(async () => {
    result.current.clearIntent();
  });
  await act(async () => {
    answer.tokyo({ ok: true, sessionIntent: intentFor('Tokyo'), resolution: 'engine_unavailable' });
    await first;
  });
  expect(result.current.intentText).toBeNull();
  expect(result.current.intent).toBeNull();
  expect(result.current.error).toBeNull();
  expect(result.current.pending).toBe(false);
});
