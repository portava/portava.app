/**
 * census-telegraph T404 — the client half of §30A.8 link previews, behind the
 * server's own flag (`telegraph_link_previews_enabled`, seeded FALSE).
 *
 *   A1–A4  the doors: wire parsing, the GET keeps only what was asked, the
 *          POST never carries a URL and refuses an answer for another message;
 *   F1–F6  the hook: OFF makes no request and draws nothing; ON reads the GET
 *          for plain-text messages with a link (each body once), the sender's
 *          device asks the POST once for a message it just sent, turning it off
 *          forgets everything, a failed read is asked again;
 *   C1     the card is text only and opens the link on the viewer's tap;
 *   W1–W2  both conversation screens are wired through the hook, with the flag,
 *          safety mode and data saver in the condition, and the flag name is the
 *          one the server reads.
 *
 * Stays census-W: 3825 is applied nowhere and the flag is seeded FALSE, so no
 * deployment shows a preview today.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { Linking, Text } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

// NOTE: intentional stubs — lib/supabase builds a client at import time and the
// token service reaches it; the doors only need "configured" and a token.
jest.mock('../../../lib/supabase.ts', () => ({ isSupabaseConfigured: true, supabase: null }));
// NOTE: intentional stub — see above.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'test-token' }));

import { fetchLinkPreviews, parseLinkPreview, requestLinkPreview, LINK_PREVIEWS_FLAG, type LinkPreview } from '../linkPreview/linkPreviewApi.ts';
import { useLinkPreviews, isPreviewCandidate, type PreviewableMessage } from '../linkPreview/useLinkPreviews.ts';
import { LinkPreviewCard } from '../linkPreview/LinkPreviewCard.tsx';

const THREAD = 'dddddddd-0000-4000-8000-00000000000d';
const M1 = '10000000-0000-4000-8000-000000000001';
const M2 = '10000000-0000-4000-8000-000000000002';
const M3 = '10000000-0000-4000-8000-000000000003';

const wire = (messageId: string): LinkPreview => ({
  messageId, url: 'https://example.com/a', host: 'example.com', title: 'Example', description: 'A page', siteName: 'Example Site',
});

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let respond: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: { previews: [] } });

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
  calls = [];
  respond = () => ({ status: 200, body: { previews: [] } });
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
    const c = { method: init?.method ?? 'GET', url, body: init?.body };
    calls.push(c);
    const r = respond(c);
    return { ok: r.status < 400, status: r.status, json: async () => r.body } as unknown as Response;
  });
});

describe('T404 — the doors', () => {
  it('A1 a wire preview is parsed only when it is exactly the shape, https, with a host', () => {
    expect(parseLinkPreview(wire(M1))).toEqual(wire(M1));
    expect(parseLinkPreview({ ...wire(M1), url: 'http://example.com' })).toBeNull();
    expect(parseLinkPreview({ ...wire(M1), host: '' })).toBeNull();
    expect(parseLinkPreview({ ...wire(M1), title: 3 })).toBeNull();
    expect(parseLinkPreview(null)).toBeNull();
  });

  it('A2 the GET asks for at most the door\'s cap, by id, and keeps only previews for what it asked', async () => {
    respond = () => ({ status: 200, body: { previews: [wire(M1), wire(M3), { junk: true }] } });
    const r = await fetchLinkPreviews(THREAD, [M1, M2, M1]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe(`https://api.test/api/threads/${THREAD}/link-previews?ids=${M1},${M2}`);
    expect(r).toEqual({ ok: true, data: [wire(M1)] });
  });

  it('A3 the POST names the message and carries NO body and no URL', async () => {
    respond = () => ({ status: 200, body: { kind: 'preview', preview: wire(M1) } });
    const r = await requestLinkPreview(THREAD, M1);
    expect(calls).toEqual([{ method: 'POST', url: `https://api.test/api/threads/${THREAD}/messages/${M1}/link-preview`, body: undefined }]);
    expect(r).toEqual({ ok: true, data: { kind: 'preview', preview: wire(M1) } });
  });

  it('A4 a POST answer for another message, or an unknown shape, is not a preview', async () => {
    respond = () => ({ status: 200, body: { kind: 'preview', preview: wire(M2) } });
    expect(await requestLinkPreview(THREAD, M1)).toEqual({ ok: false, error: 'malformed' });
    respond = () => ({ status: 200, body: { kind: 'no_preview', reason: 'disabled' } });
    expect(await requestLinkPreview(THREAD, M1)).toEqual({ ok: true, data: { kind: 'no_preview', reason: 'disabled' } });
    respond = () => ({ status: 503, body: {} });
    expect(await requestLinkPreview(THREAD, M1)).toEqual({ ok: false, error: '503' });
  });
});

// ── The hook ─────────────────────────────────────────────────────────────────

const text = (id: string, body: string, extra: Partial<PreviewableMessage> = {}): PreviewableMessage => ({ id, body, msgType: 'text', subtype: null, ...extra });

function Harness({ messages, enabled }: { messages: PreviewableMessage[]; enabled: boolean }) {
  const { previewFor } = useLinkPreviews(THREAD, messages, enabled);
  return (
    <>
      {messages.map((m) => {
        const p = previewFor(m.id);
        return p ? <LinkPreviewCard key={m.id} preview={p} mine={false} /> : <Text key={m.id}>{`none:${m.id}`}</Text>;
      })}
    </>
  );
}

async function settle() {
  await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
}

describe('T404 — the hook', () => {
  const withLink = [text(M1, 'look https://example.com/a'), text(M2, 'no link here'), text(M3, 'https://x.example', { deleted: true })];

  it('F0 a candidate is plain text, live, not end-to-end encrypted, on the server, and has a link', () => {
    expect(isPreviewCandidate(text(M1, 'https://a.example'))).toBe(true);
    expect(isPreviewCandidate(text(M1, 'http://a.example'))).toBe(false);
    expect(isPreviewCandidate(text(M1, 'https://a.example', { subtype: 'meetup' }))).toBe(false);
    expect(isPreviewCandidate(text(M1, 'https://a.example', { msgType: 'post_card' }))).toBe(false);
    expect(isPreviewCandidate(text(M1, 'https://a.example', { ciphertext: 'abc' }))).toBe(false);
    expect(isPreviewCandidate(text(M1, 'https://a.example', { deliveryStatus: 'sending' }))).toBe(false);
  });

  it('F1 OFF (the seed): no request of either door, and nothing is drawn', async () => {
    respond = () => ({ status: 200, body: { previews: [wire(M1)] } });
    await render(<Harness messages={[...withLink, text('s1', 'mine https://a.example', { deliveryStatus: 'sent' })]} enabled={false} />);
    await settle();
    expect(calls).toEqual([]);
    expect(screen.queryAllByTestId('telegraph-link-preview')).toHaveLength(0);
  });

  it('F2 ON: one GET for the plain-text messages with a link, and the preview is drawn under its message', async () => {
    respond = () => ({ status: 200, body: { previews: [wire(M1)] } });
    await render(<Harness messages={withLink} enabled />);
    await settle();
    expect(calls.map((c) => c.url)).toEqual([`https://api.test/api/threads/${THREAD}/link-previews?ids=${M1}`]);
    expect(screen.getAllByTestId('telegraph-link-preview')).toHaveLength(1);
    expect(screen.getByText('none:' + M2)).toBeTruthy();
  });

  it('F3 each body is asked once; an EDIT is asked again', async () => {
    respond = () => ({ status: 200, body: { previews: [] } });
    const v = await render(<Harness messages={[text(M1, 'https://a.example')]} enabled />);
    await settle();
    await v.rerender(<Harness messages={[text(M1, 'https://a.example')]} enabled />);
    await settle();
    expect(calls).toHaveLength(1);
    await v.rerender(<Harness messages={[text(M1, 'https://b.example', { editedAt: '2026-10-17T10:00:00Z' })]} enabled />);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('F4 the sender\'s device asks the POST door ONCE for a message the server just confirmed, and draws its answer', async () => {
    respond = (c) => (c.method === 'POST' ? { status: 200, body: { kind: 'preview', preview: wire(M1) } } : { status: 200, body: { previews: [] } });
    const sent = [text(M1, 'mine https://example.com/a', { deliveryStatus: 'sent' })];
    const v = await render(<Harness messages={sent} enabled />);
    await settle();
    await v.rerender(<Harness messages={[...sent]} enabled />);
    await settle();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([`https://api.test/api/threads/${THREAD}/messages/${M1}/link-preview`]);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(0); // not also read from the GET
    expect(screen.getAllByTestId('telegraph-link-preview')).toHaveLength(1);
  });

  it('F5 turning it OFF forgets every preview at once', async () => {
    respond = () => ({ status: 200, body: { previews: [wire(M1)] } });
    const v = await render(<Harness messages={withLink} enabled />);
    await settle();
    expect(screen.getAllByTestId('telegraph-link-preview')).toHaveLength(1);
    await v.rerender(<Harness messages={withLink} enabled={false} />);
    await settle();
    expect(screen.queryAllByTestId('telegraph-link-preview')).toHaveLength(0);
  });

  it('F5b not even for one frame: a render with the flag OFF never sees a preview it held while ON', async () => {
    respond = () => ({ status: 200, body: { previews: [wire(M1)] } });
    const seen: Array<{ enabled: boolean; preview: boolean }> = [];
    function Probe({ enabled }: { enabled: boolean }) {
      const { previewFor } = useLinkPreviews(THREAD, withLink, enabled);
      seen.push({ enabled, preview: previewFor(M1) !== null });
      return null;
    }
    const v = await render(<Probe enabled />);
    await settle();
    expect(seen.some((s) => s.enabled && s.preview)).toBe(true);
    await v.rerender(<Probe enabled={false} />);
    await settle();
    expect(seen.filter((s) => !s.enabled && s.preview)).toEqual([]);
  });

  it('F6 a failed read is not "no preview": the next change of the list asks again', async () => {
    respond = () => ({ status: 503, body: {} });
    const v = await render(<Harness messages={[text(M1, 'https://a.example')]} enabled />);
    await settle();
    respond = () => ({ status: 200, body: { previews: [wire(M1)] } });
    await v.rerender(<Harness messages={[text(M1, 'https://a.example'), text(M2, 'hello')]} enabled />);
    await settle();
    expect(calls).toHaveLength(2);
    expect(screen.getAllByTestId('telegraph-link-preview')).toHaveLength(1);
  });
});

describe('T404 — the card', () => {
  it('C1 text only — site, title, description and the ORIGINAL host — and the link opens on the viewer\'s tap', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await render(<LinkPreviewCard preview={wire(M1)} mine={false} />);
    expect(screen.getByText('Example Site')).toBeTruthy();
    expect(screen.getByText('Example')).toBeTruthy();
    expect(screen.getByText('A page')).toBeTruthy();
    expect(screen.getByTestId('telegraph-link-preview-host').props.children).toBe('example.com');
    const types: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      const node = n as { type?: string; children?: unknown };
      if (node.type) types.push(node.type);
      walk(node.children);
    };
    walk(screen.toJSON());
    expect(types.length).toBeGreaterThan(3);
    expect(types.filter((x) => /image/i.test(x))).toEqual([]); // nothing on the card can fetch
    expect(open).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('telegraph-link-preview'));
    expect(open).toHaveBeenCalledWith('https://example.com/a');
    open.mockRestore();
  });
});

describe('T404 — both conversation screens are wired, behind the server\'s flag', () => {
  const ROOT = path.resolve(__dirname, '../../../..');
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('W1 the flag is the one the server reads', () => {
    const route = read('../artifacts/api-server/src/routes/telegraphLinkPreview.ts');
    expect(LINK_PREVIEWS_FLAG).toBe('telegraph_link_previews_enabled');
    expect((route.match(/isFlagEnabled\(client, "telegraph_link_previews_enabled"\)/g) ?? []).length).toBe(2); // both doors
  });

  it('W2 the thread screen and the group screen read previews only through the hook, gated on the flag, safety mode and data saver, and draw them under the message', () => {
    for (const file of ['app/messages/[id].tsx', 'src/components/GroupChatScreen.tsx']) {
      const src = read(file);
      expect(src).toMatch(/useLinkPreviews\([^;]*flagEnabled\(LINK_PREVIEWS_FLAG\) && !safetyQuiet && dataSaver\.mayLoad\('mediaPreview'\)\)/);
      expect(src).toMatch(/linkPreview=\{linkPreviews\.previewFor\(m\.id\)\}/);
      expect(src).toMatch(/\{linkPreview \? <LinkPreviewCard preview=\{linkPreview\} mine=\{mine\} \/> : null\}/);
      expect(src).not.toMatch(/requestLinkPreview|fetchLinkPreviews/); // no screen calls a door around the hook
    }
  });
});
