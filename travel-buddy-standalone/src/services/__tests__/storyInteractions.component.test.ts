/**
 * PLAT-F33 — react to a story, reply (it reaches the author's chat), save your
 * own story to a highlight.
 *
 * WHAT WAS WRONG.
 *   - `saveToHighlight(storyId, highlightId)` sent a highlightId the route
 *     ignores (`POST /stories/:id/save-to-highlight` CREATES a Highlight from
 *     the story) and answered `{ok}` only, so the 409 that explains WHY a
 *     close-friends story cannot become a Highlight was thrown away.
 *   - `POST /stories/:id/reply` writes `story_replies`, which nothing reads:
 *     the author never saw a reply. The flow says a reply goes to the DM.
 *
 * WHAT IS PINNED.
 *   - saveToHighlight answers the new highlight id, or the server's sentence.
 *   - sendStoryReply runs the story gate first (the route re-checks that the
 *     story is still active and visible to the replier), then delivers the text
 *     into the direct thread through the ordinary send path. On an E2EE thread
 *     the server refuses plaintext (and stores none), and the reply is resent
 *     ENCRYPTED — never the other way round.
 *   - a failure at any step is reported, never a "Sent".
 *
 * Run with: pnpm test:component
 */

const mockOpen = jest.fn();
const mockSend = jest.fn();

// NOTE: exhaustive-by-design — lib/supabase's real module starts an auth
// refresh timer and the native SecureStore chain; nothing here reads it.
jest.mock('../../lib/supabase.ts', () => ({
  isSupabaseConfigured: true,
  supabase: {},
  authedClient: () => ({}),
}));
// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session.
jest.mock('../apiToken.ts', () => ({
  freshToken: async () => 'test-token',
}));
jest.mock('../messaging.ts', () => ({
  ...jest.requireActual('../messaging.ts'),
  openDirectThread: (...a: unknown[]) => mockOpen(...a),
  sendMessage: (...a: unknown[]) => mockSend(...a),
}));

import { saveToHighlight, reactToStory } from '../stories.ts';
import { sendStoryReply } from '../storyReply.ts';

const STORY = '77777777-7777-4777-8777-777777777777';
const OWNER = '88888888-8888-4888-8888-888888888888';

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = [];
let responses: Array<{ status: number; json: unknown } | 'throw'> = [];

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  (globalThis as { fetch: unknown }).fetch = jest.fn((url: string, opts: RequestInit = {}) => {
    calls.push({ url: String(url), method: String(opts.method ?? 'GET'), body: opts.body ? JSON.parse(String(opts.body)) : null });
    const next = responses.shift();
    if (next === 'throw' || next === undefined) return Promise.reject(new TypeError('Network request failed'));
    return Promise.resolve({ ok: next.status < 300, status: next.status, json: async () => next.json } as Response);
  });
});
beforeEach(() => { calls = []; responses = []; mockOpen.mockReset(); mockSend.mockReset(); });

describe('saveToHighlight', () => {
  it('answers the Highlight the server created', async () => {
    responses.push({ status: 201, json: { highlightId: 'h1', linked: true } });
    const r = await saveToHighlight(STORY);
    expect(calls[0]).toMatchObject({ url: `http://api.test/api/stories/${STORY}/save-to-highlight`, method: 'POST' });
    expect(r).toEqual({ ok: true, highlightId: 'h1' });
  });

  it('keeps the server sentence on a 409', async () => {
    responses.push({ status: 409, json: { error: 'conflict', message: 'Close-friends stories cannot become a public Highlight.' } });
    const r = await saveToHighlight(STORY);
    expect(r).toEqual({ ok: false, message: 'Close-friends stories cannot become a public Highlight.' });
  });

  it('a 200 without a highlight id is not a save', async () => {
    responses.push({ status: 200, json: {} });
    const r = await saveToHighlight(STORY);
    expect(r.ok).toBe(false);
  });
});

describe('reactToStory', () => {
  it('POSTs the emoji', async () => {
    responses.push({ status: 200, json: { ok: true } });
    const r = await reactToStory(STORY, '🔥');
    expect(calls[0]).toEqual({ url: `http://api.test/api/stories/${STORY}/react`, method: 'POST', body: { emoji: '🔥' } });
    expect(r.ok).toBe(true);
  });
});

describe('sendStoryReply', () => {
  it('gates on the story, then delivers into the direct thread', async () => {
    responses.push({ status: 201, json: { id: 'rep1' } });
    mockOpen.mockResolvedValue({ ok: true, data: { threadId: 't1', created: false } });
    mockSend.mockResolvedValue({ ok: true, data: { id: 'm1' } });
    const r = await sendStoryReply({ storyId: STORY, ownerId: OWNER, text: 'Looks amazing' });
    expect(calls[0]).toEqual({ url: `http://api.test/api/stories/${STORY}/reply`, method: 'POST', body: { message: 'Looks amazing' } });
    expect(mockOpen).toHaveBeenCalledWith(OWNER);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBe('t1');
    expect(String(mockSend.mock.calls[0][1])).toContain('Looks amazing');
    expect(mockSend.mock.calls[0][2]?.isE2ee).toBeUndefined();
    expect(r).toEqual({ ok: true, threadId: 't1' });
  });

  it('a story the replier may no longer see stops before any message is sent', async () => {
    responses.push({ status: 404, json: { error: 'not_found', message: 'Story not found' } });
    const r = await sendStoryReply({ storyId: STORY, ownerId: OWNER, text: 'hi' });
    expect(r.ok).toBe(false);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an E2EE thread refuses plaintext; the reply is resent encrypted', async () => {
    responses.push({ status: 201, json: { id: 'rep1' } });
    mockOpen.mockResolvedValue({ ok: true, data: { threadId: 't1', created: false } });
    mockSend
      .mockResolvedValueOnce({ ok: false, data: null, errorKind: 'invalid_payload', message: 'E2EE thread requires ciphertext; plaintext body not accepted' })
      .mockResolvedValueOnce({ ok: true, data: { id: 'm1' } });
    const r = await sendStoryReply({ storyId: STORY, ownerId: OWNER, text: 'hi' });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1][2]).toEqual({ isE2ee: true });
    expect(r).toEqual({ ok: true, threadId: 't1' });
  });

  it('an encryption that cannot happen is reported, never downgraded', async () => {
    responses.push({ status: 201, json: { id: 'rep1' } });
    mockOpen.mockResolvedValue({ ok: true, data: { threadId: 't1', created: false } });
    mockSend
      .mockResolvedValueOnce({ ok: false, data: null, errorKind: 'invalid_payload', message: 'E2EE thread requires ciphertext; plaintext body not accepted' })
      .mockRejectedValueOnce(new Error('no device keys'));
    const r = await sendStoryReply({ storyId: STORY, ownerId: OWNER, text: 'hi' });
    expect(r.ok).toBe(false);
  });

  it('a chat that cannot be opened is reported, not "sent"', async () => {
    responses.push({ status: 201, json: { id: 'rep1' } });
    mockOpen.mockResolvedValue({ ok: false, data: null, errorKind: 'forbidden', message: 'This person is not accepting messages' });
    const r = await sendStoryReply({ storyId: STORY, ownerId: OWNER, text: 'hi' });
    expect(r).toEqual({ ok: false, message: 'This person is not accepting messages' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('an empty reply is refused locally', async () => {
    const r = await sendStoryReply({ storyId: STORY, ownerId: OWNER, text: '   ' });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
