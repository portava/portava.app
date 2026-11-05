/**
 * census-telegraph T431 (§30A.16) — the request layer SENDS what the client
 * declares, on exactly the requests the server negotiates.
 *
 *   GET  /threads/:id/messages            the surface's read headers
 *   POST /threads/:id/share-projections   the card's headers
 *   POST /threads/:id/coordination        `schema` for a kind the client knows
 *
 * capabilityHeaders.component.test.tsx holds the declaration to the renderers;
 * this file holds the wire to the declaration (and the api-server's
 * telegraphClientNegotiation.test.ts holds the server to what arrives).
 *
 * WHAT TURNS THIS RED: a negotiated read sent without the headers (the server
 * then serves the baseline — everything); the group chat sent the
 * conversation's claim; headers leaking onto requests that do not negotiate; a
 * coordination post naming a schema for an unknown kind, or omitting a known one.
 *
 * NOTE: named `.component.test.ts` so the jest `test:component` pattern runs it.
 */

// NOTE: intentionally exhaustive — the real module builds a Supabase client at import time.
jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => { listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }; } } } };
});
// NOTE: intentionally exhaustive — the services read one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => require('../../../services/__tests__/observedOwnerSessionFixture.ts').observedOwnerAccessToken('owner-a', 'session-a'), isCurrentSessionToken: async () => true }));
// NOTE: intentionally exhaustive — the E2EE modules load native crypto; none of the calls under test touches them.
jest.mock('../../../lib/e2ee/threadCrypto.ts', () => ({
  buildOutgoingPayload: jest.fn(), establishE2ee: jest.fn(), decryptIncoming: jest.fn(),
  joinFromWelcomeIfNeeded: jest.fn(), E2EE_WELCOME_SUBTYPE: 'e2ee_welcome',
}));
// NOTE: intentionally exhaustive — see above.
jest.mock('../../../lib/e2ee/realPort.ts', () => ({ realCryptoPort: {} }));
// NOTE: intentionally exhaustive — the connection monitor reads only the status feed.
jest.mock('../../../services/telegraphRealtimeService.ts', () => ({
  telegraphRealtime: { subscribe: () => () => {}, onStatus: () => () => {}, getStatus: () => 'idle' },
}));

import { seedObservedOwnerSession, disposeObservedOwnerSession, observedOwnerAccessToken } from '../../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { getThreadMessages, resumeThreadMessages, getMyThreads, getUnreadCounts, getTripChat, getCircleChat, getSavedMessages } from '../../../services/messaging.ts';
import { fetchDrawer, searchThread } from '../kinds/kindsApi.ts';
import { searchTelegraph, askConversation } from '../services/telegraphSearch.ts';
import { fetchSharedContext, fetchConversationHeader } from '../sharedContext/api.ts';
import { resolveShareProjections } from '../sharing/shareApi.ts';
import { fetchRecap, fetchRecapChoices, fetchMemoryMessageSource, saveMessageAsMemoryDraft } from '../memory/memoryApi.ts';
import { postQuickState, postVote, postCoordinationKind, acknowledgeAnnouncement } from '../coordination/coordinationApi.ts';
import { telegraphReadHeaders, shareProjectionHeaders, telegraphIndexHeaders } from '../negotiation/clientCapabilities.ts';

const T = '11111111-1111-4111-8111-111111111111';
const realFetch = global.fetch;
const fetchMock = jest.fn();
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

beforeEach(() => {
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); });
afterAll(() => { (global as any).fetch = realFetch; });

const headersOf = (call: number) => (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call]?.[1]?.body ?? 'null');

describe('T431 — the negotiated reads carry the declaration', () => {
  it('the conversation page read sends the conversation headers (and still authenticates)', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, messages: [] }));
    await getThreadMessages(T);
    const h = headersOf(0);
    expect(h.Authorization).toBe(`Bearer ${observedOwnerAccessToken('owner-a', 'session-a')}`);
    expect(h['x-telegraph-client-schemas']).toBe(telegraphReadHeaders('conversation')['x-telegraph-client-schemas']);
    expect(h['x-telegraph-client-actions']).toBe('none');
  });

  it('the group chat sends ITS claim — the shared card only', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, messages: [] }));
    await getThreadMessages(T, undefined, 'group_chat');
    expect(headersOf(0)['x-telegraph-client-schemas']).toBe('place.share.v1,event.share.v1,trip.share.v1,object.share.v1');
  });

  it('the reconnect resume is the conversation screen\'s read, and says so', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, messages: [] }));
    await resumeThreadMessages(T, 41);
    expect(headersOf(0)).toEqual(expect.objectContaining(telegraphReadHeaders('conversation')));
  });

  it('a read that does not negotiate carries no capability header', async () => {
    fetchMock.mockResolvedValue(answer(200, { threads: [] }));
    await getUnreadCounts();
    expect(Object.keys(headersOf(0)).filter((k) => k.startsWith('x-telegraph-client-'))).toEqual([]);
  });

  it('inbox, drawer, search and saved-message reads declare known index schemas; group previews declare their renderer', async () => {
    fetchMock.mockResolvedValue(answer(200, { threads: [], items: [], results: [], saved: [], messages: [] }));
    await getMyThreads(); await fetchDrawer(T); await searchThread(T, 'place'); await getSavedMessages();
    for (let i = 0; i < 4; i++) expect(headersOf(i)).toEqual(expect.objectContaining(telegraphIndexHeaders()));
    await getTripChat(T); await getCircleChat(T);
    for (let i = 4; i < 6; i++) expect(headersOf(i)).toEqual(expect.objectContaining(telegraphReadHeaders('group_chat')));
  });

  it('share projections send the card\'s schemas and the actions it can offer', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, projections: [], unsupported: [] }));
    await resolveShareProjections(T, [{ objectType: 'PLACE', objectId: 'p1' }]);
    const h = headersOf(0);
    expect(h).toEqual(expect.objectContaining(shareProjectionHeaders()));
    expect(h['x-telegraph-client-actions']).toBe('ADD_TO_TRIP.v1,MEET_HERE.v1');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('does not return a shared source after the initiating account changes during body decoding', async () => {
    let decode!: (value: unknown) => void;
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(done => { decode = done; }) });
    const result = resolveShareProjections(T, [{ objectType: 'PLACE', objectId: 'p1' }]);
    for (let i = 0; i < 30 && !decode; i++) await Promise.resolve();
    expect(decode).toBeDefined();
    setDiscoveryViewerFromSession('owner-b'); seedObservedOwnerSession('owner-b', 'session-b');
    decode({ threadId: T, projections: [{ available: true, projection: { title: 'Old account private place' } }] });
    expect(await result).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('bounds a stalled shared-source read and does not extend live information by response latency', async () => {
    jest.useFakeTimers();
    try {
      fetchMock.mockReturnValue(new Promise(() => {}));
      const stalled = resolveShareProjections(T, [{ objectType: 'PLACE', objectId: 'p1' }]);
      await jest.advanceTimersByTimeAsync(10_001);
      expect((await stalled).ok).toBe(false);
      const start = Date.now();
      fetchMock.mockImplementation(async () => { await new Promise(done => setTimeout(done, 3_000)); return answer(200, { threadId: T, projections: [{ available: true, projection: { liveIntelligence: { whyNow: ['quiet_now'], whyNowValidForMs: 5_000 } } }] }); });
      const pending = resolveShareProjections(T, [{ objectType: 'PLACE', objectId: 'p1' }]);
      await jest.advanceTimersByTimeAsync(3_001);
      const result = await pending;
      expect(result.ok && result.data.projections[0].available && result.data.projections[0].projection.liveIntelligence?.expiresAtMs).toBe(start + 5_000);
    } finally { jest.useRealTimers(); }
  });
});

describe('T431 — coordination posts name the schema the client composed, only for kinds it knows', () => {
  beforeEach(() => fetchMock.mockResolvedValue(answer(201, { id: 'm1' })));

  it('a quick state, a vote, a known kind and an acknowledgement each carry their own id', async () => {
    await postQuickState(T, 'ON_MY_WAY' as any);
    await postVote(T, 'd1', 'o1');
    await postCoordinationKind(T, 'DECISION', { title: 'Where?' });
    await acknowledgeAnnouncement(T, 'a1');
    expect(bodyOf(0)).toEqual({ kind: 'COORDINATION', payload: { state: 'ON_MY_WAY' }, schema: 'coordination.status.v1' });
    expect(bodyOf(1).schema).toBe('coordination.vote.v1');
    expect(bodyOf(2).schema).toBe('coordination.decision.v1');
    expect(bodyOf(3)).toEqual({ kind: 'ACKNOWLEDGEMENT', payload: { announcementMessageId: 'a1' }, schema: 'coordination.acknowledgement.v1' });
  });

  it('a kind the client does not know is posted without a schema — never a guess', async () => {
    await postCoordinationKind(T, 'FUTURE_KIND', { x: 1 });
    expect(bodyOf(0)).toEqual({ kind: 'FUTURE_KIND', payload: { x: 1 } });
  });
});

describe('Sibling reads belong to their initiating session and share a bounded deadline', () => {
  const readers = [
    ['drawer', () => fetchDrawer(T)],
    ['thread search', () => searchThread(T,'beach')],
    ['global search', () => searchTelegraph('beach')],
    ['Ask conversation', () => askConversation(T,'beach')],
    ['shared context', () => fetchSharedContext(T)],
    ['header', () => fetchConversationHeader(T)],
    ['saved messages', () => getSavedMessages()],
    ['recap', () => fetchRecap(T)],
    ['recap selection', () => fetchRecapChoices(T, 'memory')],
    ['Memory source', () => fetchMemoryMessageSource(T)],
  ] as const;
  it.each(readers)('%s discards a response decoded after an account switch', async (_label, read) => {
    let decode!: (value:unknown) => void;
    fetchMock.mockResolvedValue({ok:true,status:200,json:()=>new Promise(done=>{decode=done;})});
    const pending = read();
    for(let i=0;i<40 && !decode;i++) await Promise.resolve();
    expect(decode).toBeDefined();
    setDiscoveryViewerFromSession('owner-b'); seedObservedOwnerSession('owner-b','session-b');
    decode({privateValue:'previous-account',saved:[{body:'previous-account'}],hits:[],items:[],structured:[],prose:[]});
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('previous-account');
  });
  it.each(readers)('%s ends a stalled read after ten seconds', async (_label, read) => {
    jest.useFakeTimers();
    try {
      fetchMock.mockReturnValue(new Promise(()=>{}));
      const pending = read();
      await jest.advanceTimersByTimeAsync(10_001);
      expect((await pending).ok).toBe(false);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { jest.useRealTimers(); }
  });
});

it('a message-to-Memory retry carries the same idempotency key and one source id', async () => {
  fetchMock.mockResolvedValue(answer(201,{draft:{id:'d'}}));
  await saveMessageAsMemoryDraft(T); await saveMessageAsMemoryDraft(T);
  for (const [,init] of fetchMock.mock.calls) {
    expect(init.headers['Idempotency-Key']).toBe(`telegraph-memory:${T}`);
    expect(JSON.parse(init.body)).toEqual({messageId:T});
  }
});
