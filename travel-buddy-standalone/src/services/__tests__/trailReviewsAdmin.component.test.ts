let mockCurrent = true;
const mockToken = jest.fn();
// NOTE: Session identity and refresh timing are controlled without constructing native auth.
jest.mock('../messagingOwnerRequest.ts', () => ({
  captureMessagingOwnerRequest: () => { let valid = true; return { ownerId: 'admin', sessionId: 'session', isCurrent: () => mockCurrent && valid, invalidate: () => { valid = false; } }; },
  messagingOwnerToken: (...args: unknown[]) => mockToken(...args),
}));
import { decidePendingTrailReview, getPendingTrailReviews } from '../trailReviewsAdmin.ts';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const signal = () => new AbortController().signal;
const realFetch = globalThis.fetch;
const base = process.env.EXPO_PUBLIC_API_BASE_URL;
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;
const row = { id, title: 'Gardens', description: null, destination: 'Lisbon', createdBy: other,
  createdAt: '2026-11-05T09:00:00Z', lifecycle: 'proposed', slug: null };
beforeEach(() => {
  mockCurrent = true; mockToken.mockReset().mockResolvedValue('token');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example.test';
  globalThis.fetch = jest.fn(async () => response({ trails: [row], next: null }));
});
afterEach(() => { globalThis.fetch = realFetch; process.env.EXPO_PUBLIC_API_BASE_URL = base; jest.useRealTimers(); });

it('validates the queue and carries the complete cursor', async () => {
  await expect(getPendingTrailReviews(signal(), { id, createdAt: row.createdAt })).resolves.toEqual({ trails: [row], next: null });
  const url = new URL(jest.mocked(fetch).mock.calls[0][0] as string);
  expect(url.searchParams.get('afterId')).toBe(id); expect(url.searchParams.get('afterCreatedAt')).toBe(row.createdAt);
});
it.each([{ body: {} }, { body: { trails: null, next: null } }, { body: { trails: [], next: { id, createdAt: 'not a date' } } }])('does not reinterpret a malformed queue as empty', async ({ body }) => {
  globalThis.fetch = jest.fn(async () => response(body));
  await expect(getPendingTrailReviews(signal())).rejects.toMatchObject({ status: 503 });
});
it('does not dispatch under an account changed during token refresh', async () => {
  mockToken.mockImplementationOnce(async () => { mockCurrent = false; return 'new-token'; });
  await expect(decidePendingTrailReview(id, 'approve', '', signal())).rejects.toMatchObject({ status: 401 });
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects an account change while decoding the response', async () => {
  globalThis.fetch = jest.fn(async () => ({ ...response({}), json: async () => { mockCurrent = false; return { trails: [row], next: null }; } }));
  await expect(getPendingTrailReviews(signal())).rejects.toMatchObject({ status: 401 });
});
it('refuses a blank rejection before a write', async () => {
  await expect(decidePendingTrailReview(id, 'reject', ' ', signal())).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});
it('accepts only the matching decision receipt', async () => {
  globalThis.fetch = jest.fn(async () => response({ trail: { id: other, reviewState: 'approved', reviewReason: null, lifecycle: 'active' } }));
  await expect(decidePendingTrailReview(id, 'approve', '', signal())).rejects.toMatchObject({ status: 503 });
  globalThis.fetch = jest.fn(async () => response({ trail: { id, reviewState: 'rejected', reviewReason: 'Clarify route', lifecycle: 'proposed' } }));
  await expect(decidePendingTrailReview(id, 'reject', 'Clarify route', signal())).resolves.toMatchObject({ id, reviewState: 'rejected' });
});
it('reports a concurrent review as a conflict', async () => {
  globalThis.fetch = jest.fn(async () => response({}, 409));
  await expect(decidePendingTrailReview(id, 'approve', '', signal())).rejects.toMatchObject({ status: 409 });
});
it('bounds even a fetch that ignores cancellation', async () => {
  jest.useFakeTimers(); globalThis.fetch = jest.fn(() => new Promise<Response>(() => {}));
  const pending = getPendingTrailReviews(signal());
  const result = expect(pending).rejects.toMatchObject({ status: 503 });
  await jest.advanceTimersByTimeAsync(8001); await result;
});
