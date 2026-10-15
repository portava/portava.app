/**
 * census-telegraph T404 / T446 (B58 TM-2) — the bubble's link-preview slot,
 * with EVERY request the device makes recorded.
 *
 *   T404 "External URL previews are fetched through a controlled server-side
 *         preview service. Recipients must not silently contact arbitrary
 *         sender-provided domains simply to render a preview."
 *   T446 "External previews cannot cause recipient-side network disclosure to
 *         arbitrary sender-controlled domains."
 *
 * WHAT IS EXERCISED: the real `MessageLinkPreview` (the one component both
 * bubbles mount), the real `FeatureFlagsProvider` reading the flag from the
 * server's answer, the real batching store, the real API client and the real
 * text-only `ExternalUrlPreview`. Only `fetch` (recorded), the token helper
 * and `Linking.openURL` (a spy) are stubbed.
 *
 * THE SURFACES. The slot is mounted by `MessageBubble` in `app/messages/[id].tsx`
 * (direct AND group threads) and by `GroupMessageBubble` in
 * `components/GroupChatScreen.tsx` (trip chat — `app/trip/chat.tsx` — and circle
 * chat). Neither screen can be mounted under jest-expo (§41.7), so the last
 * block pins, in their source, that each bubble mounts this slot with the
 * screen's gate, exactly once. Every OTHER message surface (cards, media,
 * typed kinds, saved messages) is measured in messageTreeImageBoundary.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Linking } from 'react-native';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));

import { FeatureFlagsProvider } from '../../../context/FeatureFlagsContext.tsx';
import { MessageLinkPreview } from '../linkPreview/MessageLinkPreview.tsx';
import { linkPreviewStore, _resetSenderRequests } from '../linkPreview/linkPreviewApi.ts';
import { mayLoad } from '../hooks/useDataSaver.ts';
import { featureFlagEnabledNow, _resetFeatureFlagSnapshot } from '../../../context/featureFlagSnapshot.ts';
import type { PreviewableMessage, WirePreview } from '../linkPreview/linkPreviewRules.ts';

const API = 'https://api.portava.test';
const THREAD = 'aaaaaaaa-0000-4000-8000-00000000000a';
const VIEWER = 'cccccccc-0000-4000-8000-00000000000c';
const SENDER = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M1 = '11111111-0000-4000-8000-000000000001';
const M2 = '11111111-0000-4000-8000-000000000002';
const M3 = '11111111-0000-4000-8000-000000000003';
/** The sender's chosen, per-recipient link — the tracking-pixel case T446 names. */
const TRACKER = 'tracker.example';
const LINK = `https://${TRACKER}/r/recipient-7?utm=1`;

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let flags: Record<string, boolean>;
let serve: (url: string) => { status: number; body: unknown };

const okPreview = (messageId: string, over: Partial<WirePreview> = {}): WirePreview => ({
  messageId, url: LINK, host: TRACKER, title: 'A page title', description: 'What the page says about itself', siteName: 'Tracker News', ...over,
});

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  calls = [];
  flags = { telegraph_link_previews_enabled: true };
  serve = () => ({ status: 200, body: { previews: [] } });
  linkPreviewStore.reset();
  _resetSenderRequests();
  _resetFeatureFlagSnapshot();
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body });
    if (String(url).endsWith('/api/feature-flags')) {
      return new Response(JSON.stringify({ flags }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const { status, body } = serve(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const msg = (id: string, over: Partial<PreviewableMessage> = {}): PreviewableMessage => ({
  id, clientId: null, senderId: SENDER, body: `look at this ${LINK}`, originalBody: null, msgType: 'text', subtype: null,
  deleted: false, createdAt: '2026-10-14T09:00:00.000Z', editedAt: null, ...over,
});

const previewCalls = () => calls.filter((c) => c.url.includes('link-preview'));
const flagsRead = () => calls.filter((c) => c.url.endsWith('/api/feature-flags'));
/** Every request went to our API, and none named the linked site. */
function assertNoDisclosure() {
  for (const c of calls) {
    expect(c.url.startsWith(`${API}/api/`)).toBe(true);
    expect(c.url).not.toContain(TRACKER);
    expect(String(c.body ?? '')).not.toContain(TRACKER);
  }
}

async function mount(messages: PreviewableMessage[], opts: { enabled?: boolean; viewerId?: string | null; threadId?: string | null } = {}) {
  const before = flagsRead().length;
  await render(
    <FeatureFlagsProvider>
      {messages.map((m) => (
        <MessageLinkPreview
          key={m.id}
          threadId={opts.threadId === undefined ? THREAD : opts.threadId}
          message={m}
          viewerId={opts.viewerId === undefined ? VIEWER : opts.viewerId}
          enabled={opts.enabled ?? true}
        />
      ))}
    </FeatureFlagsProvider>,
  );
  await waitFor(() => expect(flagsRead().length).toBe(before + 1));
  // Let any registration, batch and answer land.
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
}

describe('flag OFF ⇒ nothing drawn and no preview request, read or write', () => {
  it('the server says OFF: the only request is the app’s flag read; no link-preview call; nothing drawn', async () => {
    flags = { telegraph_link_previews_enabled: false };
    await mount([msg(M1), msg(M2, { senderId: VIEWER })]);
    expect(previewCalls()).toEqual([]);
    expect(calls.length).toBe(1);
    expect(screen.queryByTestId(`telegraph-link-preview-${M1}`)).toBeNull();
    expect(screen.queryByTestId(`telegraph-link-preview-${M2}`)).toBeNull();
    assertNoDisclosure();
  });

  it('the server does not list the flag (3825 unapplied): the same — OFF', async () => {
    flags = {};
    await mount([msg(M1)]);
    expect(previewCalls()).toEqual([]);
    expect(screen.queryByTestId(`telegraph-link-preview-${M1}`)).toBeNull();
  });
});

describe('flag ON — the recipient reads STORED previews from our API, ids only', () => {
  it('one GET of the stored previews, carrying the message id and nothing else; the text is drawn; nothing contacts the linked site', async () => {
    serve = (url) => ({ status: 200, body: { previews: url.includes(M1) ? [okPreview(M1)] : [] } });
    await mount([msg(M1)]);
    expect(previewCalls()).toEqual([{ url: `${API}/api/threads/${THREAD}/link-previews?ids=${M1}`, method: 'GET', body: undefined }]);
    const card = await screen.findByTestId(`telegraph-link-preview-${M1}`);
    expect(screen.getByText(TRACKER)).toBeTruthy();         // the host, first
    expect(screen.getByText('A page title')).toBeTruthy();
    expect(screen.getByText('Tracker News')).toBeTruthy();
    expect(screen.getByText('What the page says about itself')).toBeTruthy();
    expect(Linking.openURL).not.toHaveBeenCalled();         // drawing opens nothing
    assertNoDisclosure();
    await fireEvent.press(card);
    expect(Linking.openURL).toHaveBeenCalledTimes(1);       // a tap is the only way
    expect(Linking.openURL).toHaveBeenCalledWith(LINK);
  });

  it('a thread page is ONE read: three bubbles, one GET with three ids', async () => {
    await mount([msg(M1), msg(M2), msg(M3)]);
    const reads = previewCalls();
    expect(reads.length).toBe(1);
    expect(reads[0].url).toBe(`${API}/api/threads/${THREAD}/link-previews?ids=${M1},${M2},${M3}`);
    assertNoDisclosure();
  });

  it('the recipient never asks the server to MAKE a preview: no POST, ever', async () => {
    await mount([msg(M1), msg(M2, { senderId: VIEWER })]);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a served row that is not the https link to the host it names is not drawn', async () => {
    serve = () => ({ status: 200, body: { previews: [okPreview(M1, { host: 'innocent.example' })] } });
    await mount([msg(M1)]);
    expect(screen.queryByTestId(`telegraph-link-preview-${M1}`)).toBeNull();
  });

  it('a row for another message is never drawn on this one', async () => {
    serve = () => ({ status: 200, body: { previews: [okPreview(M2)] } });
    await mount([msg(M1)]);
    expect(screen.queryByTestId(`telegraph-link-preview-${M1}`)).toBeNull();
  });

  it('an unreadable answer (503) draws nothing and is not retried for an old message', async () => {
    serve = () => ({ status: 503, body: { error: 'degraded_unavailable' } });
    await mount([msg(M1)]);
    expect(previewCalls().length).toBe(1);
    expect(screen.queryByTestId(`telegraph-link-preview-${M1}`)).toBeNull();
  });
});

describe('the send path reads the SAME flag answer the provider stored', () => {
  it('the provider records what the server said, for the sender’s request outside React', async () => {
    flags = { telegraph_link_previews_enabled: false };
    await mount([]);
    expect(featureFlagEnabledNow('telegraph_link_previews_enabled')).toBe(false);
    flags = { telegraph_link_previews_enabled: true };
    await mount([]);
    expect(featureFlagEnabledNow('telegraph_link_previews_enabled')).toBe(true);
  });
});

describe('every other gate is a gate: no request', () => {
  it('the screen’s gate is closed (raised safety mode, data saver, unknown E2EE state): nothing', async () => {
    const safetyQuiet = false;
    const gate = !safetyQuiet && mayLoad('mediaPreview', 'on'); // the real ladder: data saver ON sheds previews
    expect(gate).toBe(false);
    await mount([msg(M1)], { enabled: gate });
    expect(previewCalls()).toEqual([]);
  });

  it('an end-to-end-encrypted message (it carries ciphertext; its body is local plaintext): nothing', async () => {
    await mount([msg(M1, { ciphertext: 'BASE64CIPHERTEXT' }), msg(M2, { e2eeFailed: true, body: null })]);
    expect(previewCalls()).toEqual([]);
  });

  it('no link, a structured kind, an unsent message, an optimistic or failed send: nothing', async () => {
    await mount([
      msg(M1, { body: 'no link at all' }),
      msg(M2, { msgType: 'system', subtype: 'post_card' }),
      msg(M3, { deleted: true }),
      msg('c-local-1', { clientId: 'c-local-1' }),
      msg('44444444-0000-4000-8000-000000000004', { deliveryStatus: 'failed' }),
    ]);
    expect(previewCalls()).toEqual([]);
  });

  it('a mount that forgets the gate is OFF: no `enabled` prop ⇒ nothing drawn, no request (fix round 1, verifier S4)', async () => {
    await render(
      <FeatureFlagsProvider>
        <MessageLinkPreview threadId={THREAD} message={msg(M1)} viewerId={VIEWER} />
      </FeatureFlagsProvider>,
    );
    await waitFor(() => expect(flagsRead().length).toBe(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(previewCalls()).toEqual([]);
    expect(screen.queryByTestId(`telegraph-link-preview-${M1}`)).toBeNull();
  });

  it('another signed-in viewer forgets the previous viewer’s answers: the same message is read afresh (fix round 1, verifier S5)', async () => {
    serve = () => ({ status: 200, body: { previews: [okPreview(M1)] } });
    await mount([msg(M1)], { viewerId: VIEWER });
    expect(previewCalls().length).toBe(1);
    await mount([msg(M1)], { viewerId: 'dddddddd-0000-4000-8000-00000000000d' });
    expect(previewCalls().length).toBe(2);
  });

  it('no thread or no signed-in viewer: nothing', async () => {
    await mount([msg(M1)], { threadId: null });
    await mount([msg(M2)], { viewerId: null });
    expect(previewCalls()).toEqual([]);
  });
});

describe('the two thread screens mount this slot, with their gate (source level: neither mounts under jest-expo)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
  const dm = read('../../../../app/messages/[id].tsx');
  const group = read('../../../components/GroupChatScreen.tsx');
  const trip = read('../../../../app/trip/chat.tsx');
  const count = (src: string, needle: string) => src.split(needle).length - 1;

  it('MessageBubble (direct and group threads): next to the text, with the thread, the message, the viewer and the gate — once', () => {
    expect(count(dm, '<MessageLinkPreview ')).toBe(1);
    expect(dm).toContain('<OriginalAlongside item={item} view={{ mine, autoTranslate, showingOriginal: showOriginal }} /><MessageLinkPreview threadId={threadId} message={item} viewerId={currentUserId} enabled={linkPreviews} />');
    expect(dm).toContain('linkPreviews={linkPreviewsOn}');
    expect(dm).toContain("const linkPreviewsOn = !safetyQuiet && dataSaver.mayLoad('mediaPreview') && !treatAsE2eeForEdit(conversationProjection);");
  });

  it('GroupMessageBubble (trip and circle chat): the same slot, with the viewer and the gate — once', () => {
    expect(count(group, '<MessageLinkPreview ')).toBe(1);
    expect(group).toContain('<OriginalAlongside item={item} view={{ mine, autoTranslate, showingOriginal: showOriginal }} /><MessageLinkPreview threadId={item.threadId} message={item} viewerId={viewerId} enabled={linkPreviews} />');
    expect(group).toContain('viewerId={userId} linkPreviews={linkPreviewsOn}');
    expect(group).toContain("const linkPreviewsOn = !safetyQuiet && dataSaver.mayLoad('mediaPreview');");
    expect(group).toContain('onModeChange={(s) => setSafetyQuiet(s.deprioritizeEntertainment)}');
  });

  it('the trip thread IS the group chat surface', () => {
    expect(trip).toContain('<GroupChatScreen');
    expect(trip).toContain('type="trip"');
  });
});
