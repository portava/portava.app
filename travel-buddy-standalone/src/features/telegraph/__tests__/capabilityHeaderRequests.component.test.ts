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
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the services read one function from it.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok-1', isCurrentSessionToken: async () => true }));
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

import { getThreadMessages, resumeThreadMessages, getMyThreads } from '../../../services/messaging.ts';
import { resolveShareProjections } from '../sharing/shareApi.ts';
import { postQuickState, postVote, postCoordinationKind, acknowledgeAnnouncement } from '../coordination/coordinationApi.ts';
import { telegraphReadHeaders, shareProjectionHeaders } from '../negotiation/clientCapabilities.ts';

const T = '11111111-1111-4111-8111-111111111111';
const realFetch = global.fetch;
const fetchMock = jest.fn();
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});
afterAll(() => { (global as any).fetch = realFetch; });

const headersOf = (call: number) => (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call]?.[1]?.body ?? 'null');

describe('T431 — the negotiated reads carry the declaration', () => {
  it('the conversation page read sends the conversation headers (and still authenticates)', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, messages: [] }));
    await getThreadMessages(T);
    const h = headersOf(0);
    expect(h.Authorization).toBe('Bearer tok-1');
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
    await getMyThreads();
    expect(Object.keys(headersOf(0)).filter((k) => k.startsWith('x-telegraph-client-'))).toEqual([]);
  });

  it('share projections send the card\'s schemas and the actions it can offer', async () => {
    fetchMock.mockResolvedValue(answer(200, { threadId: T, projections: [], unsupported: [] }));
    await resolveShareProjections(T, [{ objectType: 'PLACE', objectId: 'p1' }]);
    const h = headersOf(0);
    expect(h).toEqual(expect.objectContaining(shareProjectionHeaders()));
    expect(h['x-telegraph-client-actions']).toBe('ADD_TO_TRIP.v1,MEET_HERE.v1');
    expect(h['Content-Type']).toBe('application/json');
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
