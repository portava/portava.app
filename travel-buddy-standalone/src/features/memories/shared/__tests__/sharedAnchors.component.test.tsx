/**
 * "Remember this together" — the app's half of census-highlights-memories H53
 * (§5; B58 cluster MEM-ANCHOR-2). Server: PR #735 + this cluster's invitable
 * read, artifacts/api-server/src/routes/memorySharedAnchors.ts.
 *
 * Pins:
 *   F  flag OFF — in the app's flags, or the server answering 404 as if its
 *      routes were not there — renders nothing and makes zero requests (one,
 *      the list, when the server is the one that says absent);
 *   I  the invite list is exactly the server's list — the app adds and infers
 *      nobody — and a non-owner of the Memory sees no invite control and causes
 *      no invitable read;
 *   A  Accept, with an optional link, sends ONLY an id from my own Memories list
 *      (never the Memory on screen, never someone else's), or nothing;
 *   D  Decline and Leave are one tap — no confirmation — and the anchor is gone
 *      from the screen as soon as the server accepts, before the re-read returns;
 *   Z  an anchor where I am the only person I can see renders EXACTLY like one
 *      nobody has accepted yet, with no "left"/"blocked" wording, even right
 *      after the same screen showed it shared;
 *   L  another member's Memory is a LINK to /memory/:id and never its content,
 *      whatever else the payload carries;
 *   R  every refusal (403, 404, 409, 503, offline) is one neutral sentence, never
 *      the server's reason or message;
 *   H  the invitations list (/memory/together): flag OFF says only "not
 *      available" and asks nothing; it answers what has no Memory on screen.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';

// NOTE: intentionally exhaustive — apiToken reaches the Supabase auth session,
// which this suite does not exercise.
jest.mock('../../../../services/apiToken.ts', () => ({
  freshToken: () => Promise.resolve('tok'),
}));

let mockFlags: Record<string, boolean> = {};
jest.mock('../../../../context/FeatureFlagsContext.tsx', () => ({
  ...jest.requireActual('../../../../context/FeatureFlagsContext.tsx'),
  useFeatureFlags: () => ({ isEnabled: (k: string) => mockFlags[k] === true, isLivePlacesEnabled: () => false, loading: false }),
}));

let mockSessionUserId: string | null = '11111111-1111-4111-8111-000000000001';
// NOTE: intentionally exhaustive — the real SessionContext starts auth work.
jest.mock('../../../../context/SessionContext.tsx', () => ({
  useSession: () => ({ userId: mockSessionUserId, isAuthed: mockSessionUserId !== null }),
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { SharedAnchorPanel } from '../SharedAnchorPanel.tsx';
import { SharedAnchorsScreen } from '../SharedAnchorsScreen.tsx';
import { SHARED_ANCHORS_FLAG, SHARED_ANCHORS_PATH } from '../sharedAnchorsApi.ts';
import { NEUTRAL_REFUSAL, NOT_SHARED_YET, HUB_UNAVAILABLE, LINK_LIST_UNAVAILABLE } from '../sharedAnchorCopy.ts';

const BASE = 'https://api.test';
const ME = '11111111-1111-4111-8111-000000000001';
const HOST = '11111111-1111-4111-8111-000000000002';
const B = '11111111-1111-4111-8111-000000000003';
const C = '11111111-1111-4111-8111-000000000004';
const OTHER = '11111111-1111-4111-8111-000000000009';
const M = '22222222-2222-4222-8222-000000000001'; // mine, on screen in the owner cases
const MH = '22222222-2222-4222-8222-000000000002'; // the host's, on screen in the invitee cases
const MB = '22222222-2222-4222-8222-000000000003'; // mine, offered for the link
const MZ = '22222222-2222-4222-8222-000000000004'; // NOT mine, though the list answer carries it
const MC = '22222222-2222-4222-8222-000000000005'; // C's, readable to me
const A1 = '33333333-3333-4333-8333-000000000001';
const A2 = '33333333-3333-4333-8333-000000000002';

const LIST = '/api/me/memory-shared-anchors';
const invitablePath = (m: string) => `/api/memories/${m}/shared-anchor/invitable`;
const OWN = `/api/users/${ME}/memories?limit=30`;

// ── A recording server ────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | Error | 'hang';
interface Call { method: string; path: string; body: unknown }
let calls: Call[] = [];
let routes: Map<string, Reply[]> = new Map();
const realFetch = globalThis.fetch;
function on(method: string, path: string, ...replies: Reply[]) { routes.set(`${method} ${path}`, replies); }
function install() {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(url).startsWith(BASE) ? String(url).slice(BASE.length) : String(url);
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = routes.get(`${method} ${path}`);
    const r: Reply = queue ? (queue.length > 1 ? queue.shift()! : queue[0]!) : { status: 418, body: { error: 'unrouted' } };
    if (r === 'hang') return new Promise<Response>(() => {});
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
}
const posts = () => calls.filter((c) => c.method === 'POST');
const anchorCalls = () => calls.filter((c) => c.path.includes('shared-anchor') || c.path === LIST);

// ── Payloads, in the server's shapes (memorySharedAnchors.ts AnchorView) ─────

const me = (memoryId: string | null = M) => ({ userId: ME, handle: 'me', isYou: true, memoryId });
const lone = (id = A1, memoryId: string | null = M) => ({ id, yourStatus: 'accepted', shared: false, members: [me(memoryId)] });
const sharedWith = (id = A1, others: unknown[] = [{ userId: B, handle: 'bea', isYou: false, memoryId: null }]) =>
  ({ id, yourStatus: 'accepted', shared: true, members: [me(), ...others] });
const invitation = (id = A1, memoryId: string | null = MH) => ({ id, yourStatus: 'invited', invitedBy: { userId: HOST, handle: 'hana' }, memoryId });
const anchorsBody = (...anchors: unknown[]) => ({ status: 200, body: { anchors } });
const peopleBody = (...people: unknown[]) => ({ status: 200, body: { people } });

let alertSpy: jest.SpyInstance;
let pushSpy: jest.SpyInstance;
beforeEach(() => {
  calls = []; routes = new Map(); mockFlags = { [SHARED_ANCHORS_FLAG]: true }; mockSessionUserId = ME;
  process.env.EXPO_PUBLIC_API_BASE_URL = BASE;
  install();
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  pushSpy = jest.spyOn(router, 'push').mockImplementation(() => {});
});
afterEach(() => { globalThis.fetch = realFetch; alertSpy.mockRestore(); pushSpy.mockRestore(); });

const settle = () => new Promise((r) => setTimeout(r, 0));
async function ownerPanel(memoryId = M) { return render(<SharedAnchorPanel memoryId={memoryId} isOwner viewerId={ME} />); }
async function viewerPanel(memoryId = MH) { return render(<SharedAnchorPanel memoryId={memoryId} isOwner={false} viewerId={ME} />); }
const allText = () => JSON.stringify(screen.toJSON());

// ── F ─────────────────────────────────────────────────────────────────────────

describe('F: flag OFF ⇒ no UI and zero requests', () => {
  it("the app's flag is off: nothing is rendered and not one request is made — owner or not, panel or list", async () => {
    mockFlags = {};
    on('GET', LIST, anchorsBody(invitation(A1, M)));
    on('GET', invitablePath(M), peopleBody({ userId: B, handle: 'bea' }));
    await ownerPanel();
    await settle(); await settle();
    expect(screen.toJSON()).toBeNull();
    await viewerPanel(M);
    await settle();
    expect(screen.toJSON()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('the server answers 404 as if its routes were not there: nothing is rendered, and the list was the only request', async () => {
    on('GET', LIST, { status: 404, body: { error: 'not_found', message: 'Route not found' } });
    on('GET', invitablePath(M), peopleBody({ userId: B, handle: 'bea' }));
    await ownerPanel();
    await waitFor(() => expect(calls.length).toBe(1));
    await settle(); await settle();
    expect(screen.toJSON()).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${LIST}`]);
  });

  it('no signed-in viewer: nothing, and no request', async () => {
    on('GET', LIST, anchorsBody());
    await render(<SharedAnchorPanel memoryId={M} isOwner viewerId={null} />);
    await settle();
    expect(screen.toJSON()).toBeNull();
    expect(calls).toEqual([]);
  });
});

// ── I ─────────────────────────────────────────────────────────────────────────

describe('I: the invite list is the server\'s list; a non-owner sees no invite control', () => {
  it('the owner sees exactly the people the server returned, in its order, and Invite sends that person\'s id', async () => {
    on('GET', LIST, anchorsBody(), anchorsBody(lone()));
    on('GET', invitablePath(M), peopleBody({ userId: C, handle: 'cy' }, { userId: B, handle: 'bea' }), peopleBody({ userId: B, handle: 'bea' }));
    on('POST', `/api/memories/${M}/shared-anchor/invites`, { status: 201, body: { anchorId: A1, invitee: { userId: C, status: 'invited' } } });
    await ownerPanel();
    await screen.findByTestId(`shared-anchor-invite-${C}`);
    const rows = screen.getAllByTestId(/^shared-anchor-invitable-/).map((n) => n.props.testID);
    expect(rows).toEqual([`shared-anchor-invitable-${C}`, `shared-anchor-invitable-${B}`]);
    await fireEvent.press(screen.getByTestId(`shared-anchor-invite-${C}`));
    await waitFor(() => expect(screen.queryByTestId(`shared-anchor-invite-${C}`)).toBeNull());
    expect(posts()).toEqual([{ method: 'POST', path: `/api/memories/${M}/shared-anchor/invites`, body: { userId: C } }]);
    expect(screen.getByTestId(`shared-anchor-invite-${B}`)).toBeTruthy();
    expect(await screen.findByText(NOT_SHARED_YET)).toBeTruthy();
  });

  it('an empty server list shows no invite control and no one — nothing is inferred from anywhere else', async () => {
    on('GET', LIST, anchorsBody());
    on('GET', invitablePath(M), peopleBody());
    await ownerPanel();
    await waitFor(() => expect(calls.length).toBe(2));
    await settle();
    expect(screen.queryByTestId('shared-anchor-invite-list')).toBeNull();
    expect(screen.toJSON()).toBeNull();
  });

  it('a person the server sends in a shape the app does not know (no user id) is not shown, and nobody is added', async () => {
    on('GET', LIST, anchorsBody());
    on('GET', invitablePath(M), peopleBody({ handle: 'ghost' }, { userId: B, handle: 'bea' }, { userId: 'not-a-uuid', handle: 'x' }));
    await ownerPanel();
    await screen.findByTestId(`shared-anchor-invite-${B}`);
    expect(screen.getAllByTestId(/^shared-anchor-invitable-/)).toHaveLength(1);
    expect(allText()).not.toContain('ghost');
  });

  it('a non-owner of the Memory sees no invite control, and the invitable list is never asked for', async () => {
    on('GET', LIST, anchorsBody(sharedWith(A1, [{ userId: B, handle: 'bea', isYou: false, memoryId: MH }])));
    on('GET', invitablePath(MH), peopleBody({ userId: C, handle: 'cy' }));
    await viewerPanel(MH);
    await screen.findByTestId('shared-anchor-card');
    expect(screen.queryByTestId('shared-anchor-invite-list')).toBeNull();
    expect(screen.queryByTestId(`shared-anchor-invite-${C}`)).toBeNull();
    expect(calls.some((c) => c.path.endsWith('/shared-anchor/invitable'))).toBe(false);
  });
});

// ── A ─────────────────────────────────────────────────────────────────────────

describe('A: Accept links only an id from my own Memories list, or nothing', () => {
  const ownList = { status: 200, body: { memories: [
    { id: MB, ownerId: ME, title: 'My night market', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: MZ, ownerId: OTHER, title: 'Not mine', createdAt: '2026-09-02T00:00:00.000Z' },
  ], nextCursor: null } };

  it('the picker offers only my own Memories; choosing one sends exactly { memoryId } of that one', async () => {
    on('GET', LIST, anchorsBody(invitation()), anchorsBody(sharedWith(A1, [{ userId: HOST, handle: 'hana', isYou: false, memoryId: MH }])));
    on('GET', OWN, ownList);
    on('POST', `/api/memory-shared-anchors/${A1}/accept`, { status: 200, body: { anchorId: A1, status: 'accepted', memoryId: MB } });
    await viewerPanel(MH);
    await fireEvent.press(await screen.findByTestId('shared-anchor-accept'));
    await screen.findByTestId(`shared-anchor-link-${MB}`);
    expect(screen.queryByTestId(`shared-anchor-link-${MZ}`)).toBeNull();
    expect(screen.queryByTestId(`shared-anchor-link-${MH}`)).toBeNull();
    await fireEvent.press(screen.getByTestId(`shared-anchor-link-${MB}`));
    await fireEvent.press(screen.getByTestId('shared-anchor-accept-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ method: 'POST', path: `/api/memory-shared-anchors/${A1}/accept`, body: { memoryId: MB } });
    expect(JSON.stringify(posts())).not.toContain(MH);
    expect(JSON.stringify(posts())).not.toContain(MZ);
  });

  it('"do not link" (the default) accepts with an empty body — no id at all', async () => {
    on('GET', LIST, anchorsBody(invitation()), anchorsBody());
    on('GET', OWN, ownList);
    on('POST', `/api/memory-shared-anchors/${A1}/accept`, { status: 200, body: { anchorId: A1, status: 'accepted' } });
    await viewerPanel(MH);
    await fireEvent.press(await screen.findByTestId('shared-anchor-accept'));
    await screen.findByTestId(`shared-anchor-link-${MB}`);
    await fireEvent.press(screen.getByTestId('shared-anchor-accept-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({});
  });

  it('when my own list cannot be loaded, Accept still works and sends no id', async () => {
    on('GET', LIST, anchorsBody(invitation()), anchorsBody());
    on('GET', OWN, { status: 503, body: { error: 'degraded_unavailable' } });
    on('POST', `/api/memory-shared-anchors/${A1}/accept`, { status: 200, body: { anchorId: A1, status: 'accepted' } });
    await viewerPanel(MH);
    await fireEvent.press(await screen.findByTestId('shared-anchor-accept'));
    await screen.findByText(LINK_LIST_UNAVAILABLE);
    await fireEvent.press(screen.getByTestId('shared-anchor-accept-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({});
  });
});

// ── D ─────────────────────────────────────────────────────────────────────────

describe('D: Decline and Leave are one tap, and the anchor disappears', () => {
  it('Decline: one tap, one request, no confirmation, and the invitation is gone before the list is re-read', async () => {
    on('GET', LIST, anchorsBody(invitation()), 'hang');
    on('POST', `/api/memory-shared-anchors/${A1}/decline`, { status: 200, body: { anchorId: A1, status: 'declined' } });
    await viewerPanel(MH);
    await fireEvent.press(await screen.findByTestId('shared-anchor-decline'));
    await waitFor(() => expect(screen.queryByTestId('shared-anchor-invitation')).toBeNull());
    expect(posts()).toEqual([{ method: 'POST', path: `/api/memory-shared-anchors/${A1}/decline`, body: {} }]);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('Leave: one tap, one request, no confirmation, and the anchor is gone before the list is re-read', async () => {
    on('GET', LIST, anchorsBody(sharedWith()), 'hang');
    on('GET', invitablePath(M), peopleBody());
    on('POST', `/api/memory-shared-anchors/${A1}/leave`, { status: 200, body: { anchorId: A1, status: 'left' } });
    await ownerPanel();
    await fireEvent.press(await screen.findByTestId('shared-anchor-leave'));
    await waitFor(() => expect(screen.queryByTestId('shared-anchor-card')).toBeNull());
    expect(posts()).toEqual([{ method: 'POST', path: `/api/memory-shared-anchors/${A1}/leave`, body: {} }]);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('Leave is offered on a "not shared yet" anchor too, and on another member\'s Memory screen', async () => {
    on('GET', LIST, anchorsBody(lone()));
    on('GET', invitablePath(M), peopleBody());
    await ownerPanel();
    expect(await screen.findByTestId('shared-anchor-leave')).toBeTruthy();
    on('GET', LIST, anchorsBody(sharedWith(A2, [{ userId: B, handle: 'bea', isYou: false, memoryId: MH }])));
    await viewerPanel(MH);
    expect(await screen.findByTestId('shared-anchor-leave')).toBeTruthy();
  });
});

// ── Z ─────────────────────────────────────────────────────────────────────────

describe('Z: a lone-member anchor renders exactly like "not shared yet"', () => {
  async function freshLone(memberMemory: string | null = M) {
    on('GET', LIST, anchorsBody(lone(A2, memberMemory)));
    on('GET', invitablePath(M), peopleBody());
    const r = await ownerPanel();
    await screen.findByText(NOT_SHARED_YET);
    const json = JSON.stringify(screen.toJSON());
    await r.unmount();
    return json;
  }

  it('the host who has only invited, and a member who is the only one they can see, get the same rendering, with no "left"/"blocked" wording', async () => {
    const justInvited = await freshLone();
    calls = [];
    const afterShared = await freshLone();
    expect(afterShared).toBe(justInvited);
    expect(justInvited).not.toMatch(/left|block|declin|remov|no longer|anymore|bea/i);
  });

  it('the same screen, re-read after it showed the anchor SHARED, renders the lone answer exactly as a fresh "not shared yet" — nothing is remembered', async () => {
    const expected = await freshLone();
    calls = []; routes = new Map();
    on('GET', LIST, anchorsBody(sharedWith(A2)), anchorsBody(lone(A2)));
    on('GET', invitablePath(M), peopleBody({ userId: C, handle: 'cy' }), peopleBody());
    on('POST', `/api/memories/${M}/shared-anchor/invites`, { status: 201, body: { anchorId: A2, invitee: { userId: C, status: 'invited' } } });
    await ownerPanel();
    await screen.findByTestId(`shared-anchor-member-${B}`);
    expect(screen.queryByText(NOT_SHARED_YET)).toBeNull();
    await fireEvent.press(screen.getByTestId(`shared-anchor-invite-${C}`)); // any write re-reads the list
    await screen.findByText(NOT_SHARED_YET);
    await waitFor(() => expect(JSON.stringify(screen.toJSON())).toBe(expected));
    expect(allText()).not.toMatch(/left|block|declin|remov|no longer|anymore|bea/i);
  });

  it('shared:true with nobody else listed is still "not shared yet" — the app never shows an empty "together with"', async () => {
    const expected = await freshLone();
    on('GET', LIST, anchorsBody({ ...lone(A2), shared: true }));
    await ownerPanel();
    await screen.findByText(NOT_SHARED_YET);
    expect(JSON.stringify(screen.toJSON())).toBe(expected);
  });
});

// ── L ─────────────────────────────────────────────────────────────────────────

describe("L: another member's Memory is a link to /memory/:id, never its content", () => {
  it('whatever the payload carries, only the link is rendered; the link opens the normal Memory screen and nothing is fetched', async () => {
    on('GET', LIST, anchorsBody(sharedWith(A1, [
      { userId: C, handle: 'cy', isYou: false, memoryId: MC, title: 'SECRET TITLE', caption: 'SECRET CAPTION', items: [{ mediaUrl: 'https://cdn.test/SECRET.jpg' }], memory: { title: 'SECRET NESTED' } },
      { userId: B, handle: 'bea', isYou: false, memoryId: null },
    ])));
    on('GET', invitablePath(M), peopleBody());
    await ownerPanel();
    await screen.findByTestId(`shared-anchor-open-${MC}`);
    expect(allText()).not.toContain('SECRET');
    expect(screen.queryByTestId(`shared-anchor-open-${M}`)).toBeNull();
    expect(screen.getByTestId(`shared-anchor-member-${B}`)).toBeTruthy();
    expect(screen.queryAllByTestId(/^shared-anchor-open-/)).toHaveLength(1);
    await fireEvent.press(screen.getByTestId(`shared-anchor-open-${MC}`));
    expect(pushSpy).toHaveBeenCalledWith(`/memory/${MC}`);
    expect(calls.some((c) => c.path.includes(MC))).toBe(false);
  });

  it('a Memory id that is not an id is not linked at all', async () => {
    on('GET', LIST, anchorsBody(sharedWith(A1, [{ userId: C, handle: 'cy', isYou: false, memoryId: '../../admin' }])));
    on('GET', invitablePath(M), peopleBody());
    await ownerPanel();
    await screen.findByTestId(`shared-anchor-member-${C}`);
    expect(screen.queryAllByTestId(/^shared-anchor-open-/)).toHaveLength(0);
  });
});

// ── R ─────────────────────────────────────────────────────────────────────────

describe('R: every refusal is one neutral sentence', () => {
  const replies: Reply[] = [
    { status: 403, body: { error: 'forbidden', reason: 'not_invitable', message: 'Only someone who approved a tag on this Memory can be invited to remember it together.' } },
    { status: 409, body: { error: 'conflict', reason: 'already_invited', message: 'This person has already been asked.' } },
    { status: 409, body: { error: 'conflict', reason: 'not_host', message: 'This Memory is linked to a shared Memory someone else started; only they can invite.' } },
    { status: 404, body: { error: 'not_found', message: 'Memory not found' } },
    { status: 503, body: { error: 'degraded_unavailable', message: 'This could not be loaded right now. Please try again.' } },
    new TypeError('Network request failed'),
  ];
  it('an invite refused for any reason shows the same sentence and never the server\'s words', async () => {
    const seen = new Set<string>();
    for (const reply of replies) {
      calls = []; routes = new Map();
      on('GET', LIST, anchorsBody());
      on('GET', invitablePath(M), peopleBody({ userId: B, handle: 'bea' }));
      on('POST', `/api/memories/${M}/shared-anchor/invites`, reply);
      const r = await ownerPanel();
      await fireEvent.press(await screen.findByTestId(`shared-anchor-invite-${B}`));
      const said = await screen.findByTestId('shared-anchor-refused');
      seen.add(String(said.props.children));
      expect(allText()).not.toMatch(/approved a tag|already been asked|someone else started|Memory not found|Please try again/);
      await r.unmount();
    }
    expect([...seen]).toEqual([NEUTRAL_REFUSAL]);
  });

  it('a refused Decline or Leave says the same sentence and keeps showing what the server still lists', async () => {
    on('GET', LIST, anchorsBody(invitation()));
    on('POST', `/api/memory-shared-anchors/${A1}/decline`, { status: 404, body: { error: 'not_found', message: 'Not found' } });
    await viewerPanel(MH);
    await fireEvent.press(await screen.findByTestId('shared-anchor-decline'));
    expect((await screen.findByTestId('shared-anchor-refused')).props.children).toBe(NEUTRAL_REFUSAL);
    expect(screen.getByTestId('shared-anchor-invitation')).toBeTruthy();
  });

  it('a failed list read is never "nothing here" for the owner: it says it could not load, with a retry', async () => {
    on('GET', LIST, { status: 503, body: { error: 'degraded_unavailable' } }, anchorsBody(lone()));
    on('GET', invitablePath(M), peopleBody());
    await ownerPanel();
    await screen.findByTestId('shared-anchor-load-error');
    expect(screen.queryByTestId('shared-anchor-invite-list')).toBeNull();
    await fireEvent.press(screen.getByTestId('shared-anchor-retry'));
    expect(await screen.findByText(NOT_SHARED_YET)).toBeTruthy();
  });
});

// ── H ─────────────────────────────────────────────────────────────────────────

describe('H: the invitations list (/memory/together)', () => {
  it('flag OFF: "not available", and not one request', async () => {
    mockFlags = {};
    await render(<SharedAnchorsScreen />);
    await settle();
    expect(screen.getByText(HUB_UNAVAILABLE)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('the server says its routes are not there: "not available"', async () => {
    on('GET', LIST, { status: 404, body: { error: 'not_found' } });
    await render(<SharedAnchorsScreen />);
    expect(await screen.findByText(HUB_UNAVAILABLE)).toBeTruthy();
    expect(anchorCalls()).toHaveLength(1);
  });

  it('answers an invitation whose host Memory I may not read, and leaves an anchor I joined without a link — each one tap', async () => {
    on('GET', LIST, anchorsBody(invitation(A1, null), { id: A2, yourStatus: 'accepted', shared: true, members: [me(null), { userId: B, handle: 'bea', isYou: false, memoryId: null }] }), 'hang');
    on('POST', `/api/memory-shared-anchors/${A1}/decline`, { status: 200, body: { anchorId: A1, status: 'declined' } });
    on('POST', `/api/memory-shared-anchors/${A2}/leave`, { status: 200, body: { anchorId: A2, status: 'left' } });
    await render(<SharedAnchorsScreen />);
    await fireEvent.press(await screen.findByTestId('shared-anchor-decline'));
    await waitFor(() => expect(screen.queryByTestId('shared-anchor-invitation')).toBeNull());
    expect(screen.getByTestId(`shared-anchor-member-${B}`)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('shared-anchor-leave'));
    await waitFor(() => expect(screen.queryByTestId('shared-anchor-card')).toBeNull());
    expect(posts().map((p) => p.path)).toEqual([`/api/memory-shared-anchors/${A1}/decline`, `/api/memory-shared-anchors/${A2}/leave`]);
    expect(alertSpy).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.includes('invitable'))).toBe(false);
  });

  it("the owner's Memory screen links to it for what has no Memory on screen; the notice's path is the same constant", async () => {
    on('GET', LIST, anchorsBody(invitation(A1, null)));
    on('GET', invitablePath(M), peopleBody());
    await ownerPanel();
    await fireEvent.press(await screen.findByTestId('shared-anchor-hub-link'));
    expect(pushSpy).toHaveBeenCalledWith(SHARED_ANCHORS_PATH);
    expect(SHARED_ANCHORS_PATH).toBe('/memory/together');
    expect(screen.queryByTestId('shared-anchor-invitation')).toBeNull();
  });
});
