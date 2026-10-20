import {
  listMemoryVideoSegments, createMemoryVideoSegment, deleteMemoryVideoSegment,
  resolveMemoryVideoOriginal, newVideoSegmentOperationId,
} from '../memoryVideoSegments.ts';

const mockToken = jest.fn();
const mockSession = jest.fn();
const mockListeners = new Set<(event: string, session: unknown) => void>();
jest.mock('../apiToken', () => { return { ...jest.requireActual('../apiToken'), freshToken: (...args: unknown[]) => mockToken(...args) }; });
jest.mock('../../lib/supabase', () => { return { supabase: { auth: {
  getSession: (...args: unknown[]) => mockSession(...args),
  onAuthStateChange: (listener: (event: string, session: unknown) => void) => {
    mockListeners.add(listener);
    return { data: { subscription: { unsubscribe: () => mockListeners.delete(listener) } } };
  },
} } }; });

const scope = {
  ownerId: '11111111-1111-4111-8111-111111111111',
  memoryId: '22222222-2222-4222-8222-222222222222',
  itemId: '33333333-3333-4333-8333-333333333333',
};
const asset = { assetId: '44444444-4444-4444-8444-444444444444', assetVersion: 3, durationMs: 10000 };
const source = { ...asset, mediaRef: `post-media/${scope.ownerId}/original.mp4` };
const segment = {
  ...scope, ...asset, id: '55555555-5555-4555-8555-555555555555',
  startMs: 1000, endMs: 4000, label: 'Arrival', source: 'owner_asserted', createdAt: '2026-10-16T10:00:00Z',
};
const create = {
  operationId: segment.id, assetId: source.assetId,
  assetVersion: 3, startMs: 1000, endMs: 4000, label: 'Arrival',
};
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn();
function respond(status: number, body?: unknown) {
  mockFetch.mockResolvedValue({ status, ok: status >= 200 && status < 300, json: async () => body });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockListeners.clear();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://127.0.0.1:9';
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://storage.test';
  mockToken.mockResolvedValue('dummy');
  mockSession.mockResolvedValue({ data: { session: { user: { id: scope.ownerId }, access_token: 'dummy' } } });
  globalThis.fetch = mockFetch;
});
afterEach(() => { globalThis.fetch = originalFetch; jest.useRealTimers(); });

it('lists only validated same-owner/item/version references with a current bearer and no cache', async () => {
  respond(200, { source, segments: [segment] });
  expect(await listMemoryVideoSegments(scope)).toEqual({ ok: true, source, segments: [segment] });
  expect(mockFetch).toHaveBeenCalledWith(
    `http://127.0.0.1:9/api/memories/${scope.memoryId}/items/${scope.itemId}/video-segments`,
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer dummy' }), cache: 'no-store' }),
  );
  expect(mockListeners.size).toBe(0);
});

it.each([
  { source: { ...source, durationMs: 0 }, segments: [] },
  { source: { ...source, mediaRef: 'https://elsewhere.test/video' }, segments: [] },
  { source: asset, segments: [] },
  { source, segments: [{ ...segment, ownerId: source.assetId }] },
  { source, segments: [{ ...segment, itemId: source.assetId }] },
  { source, segments: [{ ...segment, assetVersion: 2 }] },
  { source, segments: [{ ...segment, endMs: 10001 }] },
  { source, segments: [{ ...segment, source: 'automatic' }] },
  { source, segments: [{ ...segment, url: 'https://elsewhere.test/video' }] },
  { source, segments: [segment, segment] },
])('refuses malformed, foreign or stale segment payloads %#', async body => {
  respond(200, body);
  expect(await listMemoryVideoSegments(scope)).toMatchObject({ ok: false, kind: 'degraded_unavailable' });
});

it('sends only bounded canonical references and preserves an explicit operation ID across retries', async () => {
  respond(201, { segment, created: true });
  expect(await createMemoryVideoSegment(scope, source, create)).toMatchObject({ ok: true, segment });
  respond(200, { segment, created: false });
  expect(await createMemoryVideoSegment(scope, source, create)).toMatchObject({ ok: true, created: false });
  expect(mockFetch.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([create, create]);
  expect(await createMemoryVideoSegment(scope, source, { ...create, endMs: 10001 })).toMatchObject({ kind: 'invalid_payload' });
  expect(await createMemoryVideoSegment(scope, source, { ...create, mediaUrl: 'https://bad.test' } as typeof create)).toMatchObject({ kind: 'invalid_payload' });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(newVideoSegmentOperationId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
});

it('deletes by segment ID with no original-media mutation', async () => {
  respond(204);
  expect(await deleteMemoryVideoSegment(scope, segment.id)).toEqual({ ok: true });
  expect(mockFetch.mock.calls[0][0]).toMatch(new RegExp(`/video-segments/${segment.id}$`));
  expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
});

it.each([[404, 'feature_disabled'], [503, 'degraded_unavailable'], [409, 'conflict'], [404, 'not_found']])(
  'preserves disabled, schema, conflict and withdrawal failures: %s %s', async (status, kind) => {
    respond(status as number, { error: kind });
    expect(await listMemoryVideoSegments(scope)).toMatchObject({ ok: false, kind });
  },
);

it('does not send a token belonging to another account', async () => {
  mockSession.mockResolvedValue({ data: { session: { user: { id: source.assetId }, access_token: 'dummy' } } });
  expect(await listMemoryVideoSegments(scope)).toMatchObject({ kind: 'unauthenticated' });
  expect(mockFetch).not.toHaveBeenCalled();
});

it('discards a response after logout/relogin even when fetch ignores cancellation', async () => {
  let finish!: (value: unknown) => void;
  mockFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = listMemoryVideoSegments(scope);
  while (!finish) await Promise.resolve();
  for (const listener of mockListeners) listener('SIGNED_OUT', null);
  for (const listener of mockListeners) listener('SIGNED_IN', { user: { id: scope.ownerId } });
  finish({ ok: true, status: 200, json: async () => ({ source, segments: [segment] }) });
  expect(await pending).toMatchObject({ kind: 'cancelled' });
  expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
  expect(mockListeners.size).toBe(0);
});

it('honors cancellation before token acquisition and after response decoding', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await listMemoryVideoSegments(scope, controller.signal)).toMatchObject({ kind: 'cancelled' });
  expect(mockToken).not.toHaveBeenCalled();
  const later = new AbortController();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => {
    later.abort();
    return { source, segments: [segment] };
  } });
  expect(await listMemoryVideoSegments(scope, later.signal)).toMatchObject({ kind: 'cancelled' });
});

it('freshly authorizes only canonical post-media originals, never raw URLs or cached copies', async () => {
  const uri = `post-media/${scope.ownerId}/original.mp4`;
  const signed = `https://storage.test/storage/v1/object/sign/${uri}?token=private`;
  respond(200, { signed: { [uri]: signed } });
  expect(await resolveMemoryVideoOriginal(scope, uri)).toEqual({ ok: true, uri: signed });
  expect(await resolveMemoryVideoOriginal(scope, uri)).toEqual({ ok: true, uri: signed });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(mockFetch.mock.calls[0][0]).toMatch(/\/api\/media\/sign$/);
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ urls: [uri] });
  for (const invalid of ['https://elsewhere.test/movie.mp4', 'profile-media/x', 'post-media/../x', signed]) {
    expect(await resolveMemoryVideoOriginal(scope, invalid)).toMatchObject({ ok: false, kind: 'not_found' });
  }
  expect(mockFetch).toHaveBeenCalledTimes(2);
  respond(200, { signed: { [uri]: 'https://elsewhere.test/movie.mp4' } });
  expect(await resolveMemoryVideoOriginal(scope, uri)).toMatchObject({ kind: 'not_found' });
  respond(200, { signed: { [uri]: null } });
  expect(await resolveMemoryVideoOriginal(scope, uri)).toMatchObject({ kind: 'not_found' });
});

it('bounds stalled network work and releases its auth subscription', async () => {
  jest.useFakeTimers();
  mockFetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = listMemoryVideoSegments(scope);
  while (!mockFetch.mock.calls.length) await Promise.resolve();
  jest.advanceTimersByTime(15000);
  expect(await pending).toMatchObject({ kind: 'network_unreachable' });
  expect(mockListeners.size).toBe(0);
});

it.each(['token', 'initial session', 'final session', 'response body'])('settles the deadline while %s is stalled, fencing late completion', async stage => {
  jest.useFakeTimers();
  let finish!: (value: any) => void;
  const stalled = new Promise(resolve => { finish = resolve; });
  const session = { data: { session: { user: { id: scope.ownerId }, access_token: 'dummy' } } };
  respond(200, { source, segments: [segment] });
  if (stage === 'token') mockToken.mockReturnValueOnce(stalled);
  if (stage === 'initial session') mockSession.mockReturnValueOnce(stalled);
  if (stage === 'final session') mockSession.mockResolvedValueOnce(session).mockReturnValueOnce(stalled);
  if (stage === 'response body') mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => stalled });
  let result: unknown;
  const pending = listMemoryVideoSegments(scope).then(value => { result = value; });
  await jest.advanceTimersByTimeAsync(15000);
  expect(result).toEqual({ ok: false, kind: 'network_unreachable' });
  expect(mockListeners.size).toBe(0);
  const sessionCalls = mockSession.mock.calls.length;
  const fetchCalls = mockFetch.mock.calls.length;
  finish(stage === 'token' ? 'dummy' : stage === 'response body' ? { source, segments: [segment] } : session);
  await jest.advanceTimersByTimeAsync(0);
  await pending;
  expect(mockSession).toHaveBeenCalledTimes(sessionCalls);
  expect(mockFetch).toHaveBeenCalledTimes(fetchCalls);
  expect(result).toEqual({ ok: false, kind: 'network_unreachable' });
});

it.each([
  ['signal', 'token'], ['account', 'token'],
  ['signal', 'initial session'], ['account', 'initial session'],
  ['signal', 'final session'], ['account', 'final session'],
])('settles %s cancellation without waiting for stalled %s', async (cause, stage) => {
  jest.useFakeTimers();
  let finish!: (value: unknown) => void;
  const stalled = new Promise(resolve => { finish = resolve; });
  const session = { data: { session: { user: { id: scope.ownerId }, access_token: 'dummy' } } };
  respond(200, { source, segments: [segment] });
  if (stage === 'token') mockToken.mockReturnValueOnce(stalled);
  if (stage === 'initial session') mockSession.mockReturnValueOnce(stalled);
  if (stage === 'final session') mockSession.mockResolvedValueOnce(session).mockReturnValueOnce(stalled);
  const controller = new AbortController();
  let result: unknown;
  const pending = listMemoryVideoSegments(scope, controller.signal).then(value => { result = value; });
  await jest.advanceTimersByTimeAsync(0);
  const sessionCalls = mockSession.mock.calls.length;
  const fetchCalls = mockFetch.mock.calls.length;
  if (cause === 'signal') controller.abort();
  else for (const listener of mockListeners) listener('SIGNED_OUT', null);
  await jest.advanceTimersByTimeAsync(0);
  expect(result).toEqual({ ok: false, kind: 'cancelled' });
  expect(mockListeners.size).toBe(0);
  finish(stage === 'token' ? 'dummy' : session);
  await jest.advanceTimersByTimeAsync(0);
  await pending;
  expect(mockSession).toHaveBeenCalledTimes(sessionCalls);
  expect(mockFetch).toHaveBeenCalledTimes(fetchCalls);
});
