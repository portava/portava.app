// NOTE: exercise request/owner boundaries without initializing native Supabase.
jest.mock('../apiToken.ts', () => ({ freshToken: jest.fn(), isCurrentSessionToken: jest.fn() }));
import { freshToken, isCurrentSessionToken } from '../apiToken.ts';
import { sendTrailOpen } from '../discoveryTrailOpen.ts';

const token = freshToken as jest.Mock;
const current = isCurrentSessionToken as jest.Mock;
const emission = { trail_id: '11111111-1111-4111-8111-111111111111', client_event_id: '22222222-2222-4222-8222-222222222222' };
const realFetch = globalThis.fetch;
const realBase = process.env.EXPO_PUBLIC_API_BASE_URL;
const response = (status: number, body: unknown = { ok: true, recorded: 1 }) => ({ ok: status < 300, status, json: async () => body }) as Response;
const options = () => ({ ownerId: 'owner', isAllowed: () => true, signal: new AbortController().signal });
beforeEach(() => { jest.clearAllMocks(); token.mockResolvedValue('token'); current.mockResolvedValue(true); process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test'; globalThis.fetch = jest.fn().mockResolvedValue(response(200)); });
afterEach(() => { globalThis.fetch = realFetch; if (realBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL; else process.env.EXPO_PUBLIC_API_BASE_URL = realBase; });

it('disabled and invalid visits do not read a token or send anything', async () => {
  expect(await sendTrailOpen(emission, { ...options(), isAllowed: () => false })).toBe('skipped');
  expect(await sendTrailOpen({ ...emission, trail_id: 'invalid' }, options())).toBe('skipped');
  expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('retries a lost acknowledgement with identical identity and body', async () => {
  (fetch as jest.Mock).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response(200, { ok: true, recorded: 0, duplicate: true }));
  expect(await sendTrailOpen(emission, options())).toBe('sent');
  const calls = (fetch as jest.Mock).mock.calls;
  expect(calls).toHaveLength(2); expect(calls[0][1].body).toBe(calls[1][1].body);
});
it('does not retry a server refusal', async () => {
  (fetch as jest.Mock).mockResolvedValue(response(404));
  expect(await sendTrailOpen(emission, options())).toBe('refused'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not send under a replaced account', async () => {
  current.mockResolvedValue(false);
  expect(await sendTrailOpen(emission, options())).toBe('skipped'); expect(fetch).not.toHaveBeenCalled();
});
it('rechecks permission after awaiting the session', async () => {
  let allowed = true; current.mockImplementation(async () => { allowed = false; return true; });
  expect(await sendTrailOpen(emission, { ...options(), isAllowed: () => allowed })).toBe('skipped'); expect(fetch).not.toHaveBeenCalled();
});
it('cancellation prevents a retry after an in-flight failure', async () => {
  const controller = new AbortController();
  (fetch as jest.Mock).mockImplementation(async () => { controller.abort(); throw new Error('cancelled'); });
  expect(await sendTrailOpen(emission, { ...options(), signal: controller.signal })).toBe('skipped'); expect(fetch).toHaveBeenCalledTimes(1);
});
it('an unreadable success is not counted as a recorded visit', async () => {
  (fetch as jest.Mock).mockResolvedValue(response(200, {}));
  expect(await sendTrailOpen(emission, options())).toBe('failed'); expect(fetch).toHaveBeenCalledTimes(2);
});
