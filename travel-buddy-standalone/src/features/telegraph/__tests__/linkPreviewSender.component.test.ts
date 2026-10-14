/**
 * census-telegraph T404 (B58 TM-2) — the SENDER's device asks the server to make
 * a message's link preview, once, right after the send (or edit) the server
 * accepted; only while the flag is ON; never for an end-to-end-encrypted
 * thread; with bounded retries; and the request carries no URL.
 *
 * WHAT IS EXERCISED: the real `services/messaging.ts` transport (`sendMessage`,
 * `editThreadMessage`), the real hand-off (`linkPreview/linkPreviewApi.ts`), the
 * real flag snapshot the FeatureFlagsProvider writes, the real store. Only
 * `fetch` (recorded), the token, the Supabase client and the E2EE port (native)
 * are stubbed.
 *
 * Red on main: main's `sendMessage` makes the send and nothing else, so every
 * "exactly one link-preview POST" case fails there.
 */
// NOTE: intentionally exhaustive — lib/supabase builds a client at import time,
// which fails outside an Expo runtime. The transport reads only these names.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));
// NOTE: intentionally exhaustive — the E2EE modules load native crypto. An encrypted send
// carries ciphertext and no body, exactly as the real builder's contract says.
jest.mock('../../../lib/e2ee/threadCrypto.ts', () => ({
  buildOutgoingPayload: jest.fn(async (_port: unknown, _thread: string, body: string, isE2ee: boolean) =>
    (isE2ee ? { ciphertext: 'CIPHERTEXT' } : { body })),
  establishE2ee: jest.fn(),
  decryptIncoming: jest.fn(),
  joinFromWelcomeIfNeeded: jest.fn(),
  E2EE_WELCOME_SUBTYPE: 'e2ee_welcome',
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {} }));

import { sendMessage, editThreadMessage } from '../../../services/messaging.ts';
import { recordFeatureFlagSnapshot, _resetFeatureFlagSnapshot } from '../../../context/featureFlagSnapshot.ts';
import { linkPreviewStore, _resetSenderRequests, SENDER_RETRY_DELAYS_MS, requestPreviewAfterWrite } from '../linkPreview/linkPreviewApi.ts';

const API = 'https://api.portava.test';
const THREAD = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MSG = '11111111-0000-4000-8000-000000000001';
const SENDER = 'bbbbbbbb-0000-4000-8000-00000000000b';
const TRACKER = 'tracker.example';
const BODY = `meet here https://${TRACKER}/r/recipient-7`;

type Call = { url: string; method: string; body: string | undefined };
let calls: Call[];
let previewAnswer: () => { status: number; body: unknown };
let sendAnswer: (sent: Record<string, unknown>) => { status: number; body: unknown };

const serverMessage = (over: Record<string, unknown> = {}) => ({
  id: MSG, threadId: THREAD, senderId: SENDER, body: BODY, deleted: false, createdAt: '2026-10-14T10:00:00.000Z',
  editedAt: null, msgType: 'text', subtype: null, clientId: 'c-1', ...over,
});

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  calls = [];
  _resetFeatureFlagSnapshot();
  _resetSenderRequests();
  linkPreviewStore.reset();
  previewAnswer = () => ({
    status: 200,
    body: { kind: 'preview', preview: { messageId: MSG, url: `https://${TRACKER}/r/recipient-7`, host: TRACKER, title: 'T', description: 'D', siteName: 'S' } },
  });
  sendAnswer = (sent) => ({ status: 201, body: serverMessage(sent.ciphertext ? { body: null, ciphertext: 'CIPHERTEXT' } : {}) });
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    let answer: { status: number; body: unknown };
    if (u.endsWith('/link-preview')) answer = previewAnswer();
    else if (u.endsWith(`/api/threads/${THREAD}/messages`)) answer = sendAnswer(JSON.parse(String(init?.body ?? '{}')));
    else if (u.endsWith(`/api/threads/${THREAD}/messages/${MSG}`)) {
      const sent = JSON.parse(String(init?.body ?? '{}'));
      answer = { status: 200, body: { id: MSG, threadId: THREAD, body: sent.body, editedAt: '2026-10-14T10:03:00.000Z' } };
    } else answer = { status: 404, body: {} };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => { jest.useRealTimers(); });

const previewPosts = () => calls.filter((c) => c.url.endsWith('/link-preview'));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the send path — flag ON', () => {
  beforeEach(() => recordFeatureFlagSnapshot({ telegraph_link_previews_enabled: true }));

  it('a text message with a link: the send, then exactly ONE preview request for that message — no body, no URL', async () => {
    const r = await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    expect(r.ok).toBe(true);
    await flush();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${API}/api/threads/${THREAD}/messages`,
      `POST ${API}/api/threads/${THREAD}/messages/${MSG}/link-preview`,
    ]);
    const post = previewPosts()[0];
    expect(post.body).toBeUndefined();
    expect(post.url).not.toContain(TRACKER);
  });

  it('the server’s answer is remembered for the sender’s own bubble (no read needed)', async () => {
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await flush(); await flush();
    expect(linkPreviewStore.get(THREAD, MSG, '')?.state).toBe('ready');
  });

  it('an end-to-end-encrypted send: no preview request (the server never holds the body, and the device does not ask)', async () => {
    const r = await sendMessage(THREAD, BODY, { clientId: 'c-1', isE2ee: true });
    expect(r.ok).toBe(true);
    await flush();
    expect(calls.length).toBe(1);
    expect(previewPosts()).toEqual([]);
  });

  it('a server answer that carries ciphertext is treated as encrypted even without the option', async () => {
    sendAnswer = () => ({ status: 201, body: serverMessage({ ciphertext: 'CIPHERTEXT' }) });
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await flush();
    expect(previewPosts()).toEqual([]);
  });

  it('no link, a structured kind, or a refused send: no preview request', async () => {
    sendAnswer = () => ({ status: 201, body: serverMessage({ body: 'no link here' }) });
    await sendMessage(THREAD, 'no link here', { clientId: 'c-1' });
    sendAnswer = () => ({ status: 201, body: serverMessage({ msgType: 'system', subtype: 'compass_card' }) });
    await sendMessage(THREAD, BODY, { msgType: 'system', subtype: 'compass_card' });
    sendAnswer = () => ({ status: 500, body: { error: 'db_error' } });
    await sendMessage(THREAD, BODY, { clientId: 'c-2' });
    await flush();
    expect(previewPosts()).toEqual([]);
  });

  it('once per message version: a resend answered with the same message asks nothing more', async () => {
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await sendMessage(THREAD, BODY, { clientId: 'c-1' }); // the idempotent replay: same id, same version
    await flush();
    expect(previewPosts().length).toBe(1);
  });

  it('an edit is a new version: asked about once more; a refused edit asks nothing', async () => {
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await flush();
    const e = await editThreadMessage(THREAD, MSG, `${BODY} (edited)`);
    expect(e.ok).toBe(true);
    await flush();
    expect(previewPosts().length).toBe(2);
    expect(previewPosts()[1].body).toBeUndefined();

    (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return new Response(JSON.stringify({ error: 'e2ee_thread' }), { status: 409 });
    });
    await editThreadMessage(THREAD, MSG, `${BODY} again`);
    await flush();
    expect(previewPosts().length).toBe(2);
  });
});

describe('the send path — flag OFF or unknown', () => {
  it('the server said OFF: the send and nothing else', async () => {
    recordFeatureFlagSnapshot({ telegraph_link_previews_enabled: false });
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await flush();
    expect(calls.length).toBe(1);
  });

  it('the flags were never read (or did not list it): OFF', async () => {
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    recordFeatureFlagSnapshot({ some_other_flag: true });
    await sendMessage(THREAD, `${BODY} 2`, { clientId: 'c-2' });
    await flush();
    expect(previewPosts()).toEqual([]);
  });
});

describe('bounded retries', () => {
  beforeEach(() => recordFeatureFlagSnapshot({ telegraph_link_previews_enabled: true }));

  it('"try again" answers (429, 503, no network) are retried — at most three attempts in all', async () => {
    jest.useFakeTimers();
    let n = 0;
    previewAnswer = () => {
      n++;
      if (n === 3) throw new TypeError('Network request failed');
      return n === 2 ? { status: 503, body: { error: 'degraded_unavailable' } } : { status: 429, body: { error: 'rate_limited' } };
    };
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await jest.advanceTimersByTimeAsync(0);
    expect(previewPosts().length).toBe(1);
    await jest.advanceTimersByTimeAsync(SENDER_RETRY_DELAYS_MS[0]);
    expect(previewPosts().length).toBe(2);
    await jest.advanceTimersByTimeAsync(SENDER_RETRY_DELAYS_MS[1]);
    expect(previewPosts().length).toBe(3);
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(previewPosts().length).toBe(3);
  });

  it('a final refusal (403, 410, 4xx) is not retried', async () => {
    jest.useFakeTimers();
    previewAnswer = () => ({ status: 403, body: { error: 'forbidden' } });
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(previewPosts().length).toBe(1);
  });

  it('a no_preview answer is final, and remembered as "none"', async () => {
    previewAnswer = () => ({ status: 200, body: { kind: 'no_preview', reason: 'unsupported_link' } });
    await sendMessage(THREAD, BODY, { clientId: 'c-1' });
    await flush(); await flush();
    expect(previewPosts().length).toBe(1);
    expect(linkPreviewStore.get(THREAD, MSG, '')?.state).toBe('none');
  });
});

describe('requestPreviewAfterWrite — its own gates, with injected seams', () => {
  const base = { threadId: THREAD, messageId: MSG, body: BODY, plainText: true, version: '', encrypted: false };
  const deps = (flagOn: boolean) => ({ post: jest.fn(async () => ({ kind: 'no_preview' as const, reason: 'none' })), flagOn: () => flagOn, schedule: jest.fn(), store: { seed: jest.fn() } });

  it('each gate alone refuses', () => {
    const cases: Array<[string, Partial<typeof base>, boolean]> = [
      ['flag off', {}, false],
      ['encrypted', { encrypted: true }, true],
      ['a structured kind', { plainText: false }, true],
      ['no link', { body: 'nothing' }, true],
      ['a client id', { messageId: 'c-1' }, true],
      ['a bad thread id', { threadId: 'x' }, true],
    ];
    for (const [label, over, flagOn] of cases) {
      _resetSenderRequests();
      const d = deps(flagOn);
      expect([label, requestPreviewAfterWrite({ ...base, ...over }, d)]).toEqual([label, false]);
      expect(d.post).not.toHaveBeenCalled();
    }
    _resetSenderRequests();
    const ok = deps(true);
    expect(requestPreviewAfterWrite(base, ok)).toBe(true);
    expect(ok.post).toHaveBeenCalledWith(THREAD, MSG);
  });
});
