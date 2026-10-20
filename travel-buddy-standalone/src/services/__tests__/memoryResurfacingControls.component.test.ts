import { freshToken } from '../apiToken.ts';
import { readMemoryDoNotResurface, writeMemoryDoNotResurface, type MemoryResurfacingRequest } from '../memoryResurfacingControls.ts';

jest.mock('../apiToken', () => ({ ...jest.requireActual('../apiToken'), freshToken: jest.fn() }));
jest.mock('../memories', () => ({ ...jest.requireActual('../memories'), newMemoryOperationId: jest.fn(() => `resurfacing-${Math.random()}`) }));

const ownerId = '11111111-1111-4111-8111-111111111111';
let sequence = 0;
let request: MemoryResurfacingRequest;
let fetchMock: jest.Mock;
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
afterAll(async () => { await jest.requireActual('../../lib/supabase').supabase.auth.stopAutoRefresh(); });
const token = (owner = ownerId, session = 'session-one') => `header.${btoa(JSON.stringify({ sub: owner, session_id: session }))}.signature`;
const reply = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: jest.fn(async () => body) });
const body = (on: boolean, memoryId = request.memoryId) => ({ memoryId, controls: [
  { control: 'DO_NOT_RESURFACE', on }, { control: 'DO_NOT_INCLUDE_IN_RECAPS', on: false },
  { control: 'KEEP_PRIVATE_FOREVER', on: false }, { control: 'RETAIN_BUT_DO_NOT_PERSONALIZE', on: false },
] });
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(finish => { resolve = finish; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  sequence += 1;
  const controller = new AbortController();
  request = { memoryId: `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`, ownerId,
    sessionId: 'session-one', signal: controller.signal, isCurrent: () => !controller.signal.aborted,
    acceptsSession: next => next === 'session-one', invalidateSession: () => controller.abort() };
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  (freshToken as jest.Mock).mockReset().mockResolvedValue(token());
  fetchMock = jest.fn().mockResolvedValue(reply(200, body(false)));
  global.fetch = fetchMock;
});
afterEach(() => {
  jest.useRealTimers(); global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

test.each([false, true])('reads only a validated current Memory setting: %s', async on => {
  fetchMock.mockResolvedValue(reply(200, body(on)));
  expect(await readMemoryDoNotResurface(request)).toEqual({ ok: true, on, pending: null });
  expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:9/api/memories/${request.memoryId}/resurfacing-controls`,
    expect.objectContaining({ method: 'GET', cache: 'no-store', headers: { Authorization: `Bearer ${token()}` } }));
});

const malformed: Array<[string, () => unknown]> = [
  ['null', () => null], ['array', () => []], ['wrong Memory', () => body(false, ownerId)],
  ['missing Memory', () => ({ controls: body(false).controls })],
  ['null controls', () => ({ ...body(false), controls: null })],
  ['object controls', () => ({ ...body(false), controls: {} })],
  ['empty controls', () => ({ ...body(false), controls: [] })],
  ['missing DNR', () => ({ ...body(false), controls: body(false).controls.slice(1) })],
  ['duplicate DNR', () => ({ ...body(false), controls: [...body(false).controls, { control: 'DO_NOT_RESURFACE', on: true }] })],
  ['string boolean', () => ({ ...body(false), controls: [{ control: 'DO_NOT_RESURFACE', on: 'false' }] })],
  ['null row mixed', () => ({ ...body(false), controls: [...body(false).controls, null] })],
  ['array row mixed', () => ({ ...body(false), controls: [...body(false).controls, []] })],
  ['malformed unrelated row', () => ({ ...body(false), controls: [...body(false).controls, { control: 'future', on: 0 }] })],
  ['blank control', () => ({ ...body(false), controls: [...body(false).controls, { control: '', on: false }] })],
];
test.each(malformed)('does not turn unread %s into Off', async (_label, makeBody) => {
  fetchMock.mockResolvedValue(reply(200, makeBody()));
  expect(await readMemoryDoNotResurface(request)).toMatchObject({ ok: false, kind: 'unavailable' });
});

test.each([
  [404, 'feature_disabled', 'feature_disabled'], [404, 'not_found', 'not_found'],
  [503, 'degraded_unavailable', 'unavailable'], [401, 'unauthenticated', 'unauthenticated'],
  [409, 'conflict', 'conflict'], [500, 'feature_disabled', 'unavailable'],
] as const)('preserves HTTP %s / %s classification', async (status, error, kind) => {
  fetchMock.mockResolvedValue(reply(status, { error }));
  expect(await readMemoryDoNotResurface(request)).toMatchObject({ ok: false, kind });
});

test('malformed errors and unexpected success status are unreadable', async () => {
  fetchMock.mockResolvedValueOnce(reply(404, {})).mockResolvedValueOnce(reply(204));
  expect(await readMemoryDoNotResurface(request)).toMatchObject({ ok: false, kind: 'unavailable' });
  expect(await readMemoryDoNotResurface(request)).toMatchObject({ ok: false, kind: 'unavailable' });
});

test.each([true, false])('explicit %s writes one control, consumes empty 204, then confirms GET', async on => {
  const empty = reply(204);
  fetchMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(reply(200, body(on)));
  expect(await writeMemoryDoNotResurface(request, on)).toEqual({ ok: true, on, pending: null, intentMatched: true });
  expect(empty.json).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.map(entry => entry[1].method)).toEqual([on ? 'PUT' : 'DELETE', 'GET']);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe(`http://127.0.0.1:9/api/memories/${request.memoryId}/resurfacing-controls/DO_NOT_RESURFACE`);
  expect(init.body).toBeUndefined();
  expect(init.headers).toEqual({ Authorization: `Bearer ${token()}`, 'Idempotency-Key': expect.any(String) });
});

test('does not mistake an old receipt for current cross-device state', async () => {
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(false)));
  expect(await writeMemoryDoNotResurface(request, true)).toEqual({ ok: true, on: false, pending: null, intentMatched: false });
});

test('an uncertain commit keeps its key, blocks the opposite, and is not settled by an unrelated GET', async () => {
  fetchMock.mockRejectedValueOnce(new Error('connection lost'));
  expect(await writeMemoryDoNotResurface(request, true)).toMatchObject({ ok: false, pending: { on: true, acknowledged: false } });
  const key = fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
  expect(await readMemoryDoNotResurface(request)).toMatchObject({ ok: true, on: false, pending: { on: true } });
  expect(await writeMemoryDoNotResurface(request, false)).toMatchObject({ ok: false, kind: 'pending' });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(true)));
  expect((await writeMemoryDoNotResurface(request, true)).ok).toBe(true);
  expect(fetchMock.mock.calls[2][1].headers['Idempotency-Key']).toBe(key);
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(false)));
  await writeMemoryDoNotResurface(request, false);
  expect(fetchMock.mock.calls[4][1].headers['Idempotency-Key']).not.toBe(key);
});

test('acknowledged write with unread readback retries GET only', async () => {
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(503, { error: 'degraded_unavailable' }));
  expect(await writeMemoryDoNotResurface(request, true)).toMatchObject({ ok: false, pending: { on: true, acknowledged: true } });
  fetchMock.mockResolvedValueOnce(reply(200, body(false)));
  expect(await writeMemoryDoNotResurface(request, true)).toMatchObject({ ok: true, on: false, intentMatched: false });
  expect(fetchMock.mock.calls.map(entry => entry[1].method)).toEqual(['PUT', 'GET', 'GET']);
});

test('simultaneous duplicate requests cannot start a second transport', async () => {
  const waiting = deferred<ReturnType<typeof reply>>();
  fetchMock.mockReturnValueOnce(waiting.promise);
  const first = writeMemoryDoNotResurface(request, true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(await writeMemoryDoNotResurface(request, true)).toMatchObject({ ok: false, kind: 'pending' });
  waiting.resolve(reply(204)); fetchMock.mockResolvedValue(reply(200, body(true)));
  expect((await first).ok).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test.each(['target', 'owner', 'session', 'focus'])('a %s change during token wait cannot adopt late context', async change => {
  const waiting = deferred<string>();
  (freshToken as jest.Mock).mockReturnValueOnce(waiting.promise);
  let current = true;
  request.isCurrent = () => current;
  const pending = writeMemoryDoNotResurface(request, true);
  await Promise.resolve(); await Promise.resolve();
  expect(freshToken).toHaveBeenCalledTimes(1);
  if (change === 'session') waiting.resolve(token(ownerId, 'session-two'));
  else if (change === 'owner') waiting.resolve(token('33333333-3333-4333-8333-333333333333'));
  else { current = false; waiting.resolve(token()); }
  expect((await pending).ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('the adapter refuses a lazily adopted session even if the caller accepts it', async () => {
  request.acceptsSession = () => true;
  (freshToken as jest.Mock).mockResolvedValue(token(ownerId, 'session-two'));
  expect((await writeMemoryDoNotResurface(request, true)).ok).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('stale write response is not acknowledged and keeps the retry key', async () => {
  const waiting = deferred<ReturnType<typeof reply>>();
  fetchMock.mockReturnValueOnce(waiting.promise);
  let current = true; request.isCurrent = () => current;
  const pending = writeMemoryDoNotResurface(request, true);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  current = false; waiting.resolve(reply(204));
  expect((await pending).ok).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const key = fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
  current = true;
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(true)));
  expect((await writeMemoryDoNotResurface(request, true)).ok).toBe(true);
  expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe(key);
});

test('explicit same-owner retry after relogin preserves the old intent; other owners do not inherit it', async () => {
  fetchMock.mockRejectedValueOnce(new Error('lost'));
  await writeMemoryDoNotResurface(request, true);
  const key = fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
  const second = { ...request, sessionId: 'session-two', acceptsSession: (next: string | null) => next === 'session-two' };
  (freshToken as jest.Mock).mockResolvedValue(token(ownerId, 'session-two'));
  expect(await writeMemoryDoNotResurface(second, false)).toMatchObject({ ok: false, kind: 'pending' });
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(true)));
  expect((await writeMemoryDoNotResurface(second, true)).ok).toBe(true);
  expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe(key);
  const other = '33333333-3333-4333-8333-333333333333';
  (freshToken as jest.Mock).mockResolvedValue(token(other));
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(false)));
  await writeMemoryDoNotResurface({ ...request, ownerId: other }, false);
  expect(fetchMock.mock.calls[3][1].headers['Idempotency-Key']).not.toBe(key);
});

test.each(['token', 'fetch', 'body'])('bounds a never-settling %s and ignores late completion', async stage => {
  jest.useFakeTimers();
  const waiting = deferred<unknown>();
  if (stage === 'token') (freshToken as jest.Mock).mockReturnValueOnce(waiting.promise);
  if (stage === 'fetch') fetchMock.mockReturnValueOnce(waiting.promise);
  if (stage === 'body') fetchMock.mockResolvedValueOnce({ ...reply(200), json: () => waiting.promise });
  const pending = readMemoryDoNotResurface(request);
  await jest.advanceTimersByTimeAsync(15001);
  expect(await pending).toMatchObject({ ok: false, kind: 'unavailable' });
  const count = fetchMock.mock.calls.length;
  waiting.resolve(stage === 'token' ? token() : stage === 'fetch' ? reply(200, body(false)) : body(false));
  await jest.advanceTimersByTimeAsync(1);
  expect(fetchMock.mock.calls.length).toBe(count);
});

test('timed-out write cannot acknowledge late 204 or start a late readback, and retries with the same key', async () => {
  jest.useFakeTimers();
  const waiting = deferred<ReturnType<typeof reply>>();
  fetchMock.mockReturnValueOnce(waiting.promise);
  const pending = writeMemoryDoNotResurface(request, true);
  await jest.advanceTimersByTimeAsync(15001);
  expect(await pending).toMatchObject({ ok: false, kind: 'unavailable', pending: { on: true, acknowledged: false } });
  const key = fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
  waiting.resolve(reply(204)); await jest.advanceTimersByTimeAsync(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await writeMemoryDoNotResurface(request, false)).toMatchObject({ ok: false, kind: 'pending' });
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(true)));
  expect((await writeMemoryDoNotResurface(request, true)).ok).toBe(true);
  expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe(key);
});

test('abort settles a never-ending token lookup without sending', async () => {
  const controller = new AbortController();
  request = { ...request, signal: controller.signal };
  (freshToken as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
  const pending = writeMemoryDoNotResurface(request, true);
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, kind: 'cancelled', pending: null });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a stale JSON body cannot make a setting known', async () => {
  const waiting = deferred<unknown>();
  let current = true; request.isCurrent = () => current;
  const parse = jest.fn(() => waiting.promise);
  fetchMock.mockResolvedValueOnce({ ...reply(200), json: parse });
  const pending = readMemoryDoNotResurface(request);
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
  expect(parse).toHaveBeenCalledTimes(1);
  current = false; waiting.resolve(body(true));
  expect(await pending).toMatchObject({ ok: false, kind: 'cancelled' });
});

test('the captured target is not changed by mutating the caller object during token wait', async () => {
  const waiting = deferred<string>();
  (freshToken as jest.Mock).mockReturnValueOnce(waiting.promise);
  const target = request.memoryId;
  const pending = readMemoryDoNotResurface(request);
  await Promise.resolve(); await Promise.resolve();
  request.memoryId = ownerId;
  waiting.resolve(token());
  expect(await pending).toEqual({ ok: true, on: false, pending: null });
  expect(fetchMock.mock.calls[0][0]).toContain(`/memories/${target}/`);
});

test('the pending map is capped at 200 without evicting an unresolved key', async () => {
  fetchMock.mockRejectedValue(new Error('unknown commit'));
  const requests = Array.from({ length: 201 }, (_, index) => ({ ...request,
    memoryId: `88888888-8888-4888-8888-${String(index).padStart(12, '0')}` }));
  for (const scoped of requests) await writeMemoryDoNotResurface(scoped, true);
  expect(fetchMock).toHaveBeenCalledTimes(200);
  const firstKey = fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
  fetchMock.mockResolvedValueOnce(reply(204)).mockResolvedValueOnce(reply(200, body(true, requests[0].memoryId)));
  expect((await writeMemoryDoNotResurface(requests[0], true)).ok).toBe(true);
  expect(fetchMock.mock.calls[200][1].headers['Idempotency-Key']).toBe(firstKey);
  await writeMemoryDoNotResurface(requests[200], true);
  expect(fetchMock).toHaveBeenCalledTimes(203);
});
