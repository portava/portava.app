/**
 * census-telegraph T446 (B58 TM-2) — no message surface makes the recipient's
 * device load an image, poster or page from a host the SENDER chose.
 *
 *   T446 "External previews cannot cause recipient-side network disclosure to
 *         arbitrary sender-controlled domains."
 *
 * Every component that draws a message is rendered here with a sender-chosen
 * host in every field a sender can fill — the text, a legacy card's
 * `imageUrl` / `thumbnail` / `authorAvatar`, a GIF's `url` / `stillUrl`, an
 * album's asset urls (the kinds route stores any string), a media row's
 * `media_url` / thumbnail, a server projection's `imageUrl` from a server that
 * predates TM-1's rule — and EVERY image source handed to the image loader and
 * every request the device makes is recorded. None may name the sender's host.
 *
 * Red on main: main's cards, media bubble and GIF/album renderers hand those
 * strings straight to the loader (`DisplayMediaImage` → hydration passes a
 * non-storage URL through unchanged → `expo-image`), so every "names no
 * sender host" case below records `tracker.example` there.
 *
 * Positive controls keep the recorder honest: a Portava-storage URL in the
 * same fields IS recorded, so a case that records nothing is not vacuous.
 *
 * NOTE: named `.component.test.tsx` so the jest `test:component` pattern runs it.
 */
import React from 'react';
import { Image as RNImage, Linking } from 'react-native';
import { render, screen, waitFor, act } from '@testing-library/react-native';

const mockSources: unknown[] = [];
const mockPrefetch = jest.fn();
// NOTE: intentional stand-in — records every source the native image loader would be
// handed (the one place a URL turns into a network request), and any prefetch.
jest.mock('expo-image', () => {
  const R = require('react');
  const { View } = require('react-native');
  function RecordingImage(props: any) {
    mockSources.push(props.source ?? null, props.placeholder ?? null);
    return R.createElement(View, { testID: 'recorded-image' });
  }
  RecordingImage.prefetch = (...a: unknown[]) => mockPrefetch(...a);
  return { Image: RecordingImage };
});
// NOTE: intentionally exhaustive — lib/supabase builds a client at import time.
jest.mock('../../../lib/supabase.ts', () => ({ supabase: {}, isSupabaseConfigured: true }));
// NOTE: intentionally exhaustive — the real token helper reaches the Supabase client.
jest.mock('../../../services/apiToken.ts', () => ({ freshToken: async () => 'tok' }));
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ useReducedMotionSetting: () => false }));
const mockGetSaved = jest.fn();
// NOTE: intentionally exhaustive — the Saved screen calls exactly these two; no other component
// rendered here imports this module (the real one reaches native E2EE code).
jest.mock('../../../services/messaging.ts', () => ({
  getSavedMessages: (...a: unknown[]) => mockGetSaved(...a),
  unsaveSavedMessage: jest.fn(),
}));
// NOTE: intentional stub — useFocusEffect needs a navigator; everything else is the real module.
jest.mock('expo-router', () => {
  const R = require('react');
  return { ...jest.requireActual('expo-router'), router: { push: jest.fn(), back: jest.fn() }, useFocusEffect: (cb: () => void) => R.useEffect(() => { cb(); }, [cb]) };
});
// NOTE: intentionally exhaustive — the header needs safe-area and navigation.
jest.mock('../../../components/ui/AppHeader.tsx', () => ({ AppHeader: () => null }));
// NOTE: intentionally exhaustive — the nav-bar collapse hook needs the tab navigator.
jest.mock('../../../hooks/useNavBarCollapse.ts', () => ({ useNavBarScrollHandler: () => undefined, NavBarFiller: () => null }));

import { DiscoveryCardMessage } from '../../../components/DiscoveryCardMessage.tsx';
import { PostCardMessage } from '../../../components/PostCardMessage.tsx';
import { CompassCardMessage } from '../../../components/CompassCardMessage.tsx';
import { MessageMediaBubble } from '../../../components/MessageMediaBubble.tsx';
import { RichText } from '../../../components/RichText.tsx';
import { TelegraphSystemNotice } from '../../../components/TelegraphSystemNotice.tsx';
import { PortavaObjectMessage } from '../sharing/PortavaObjectMessage.tsx';
import { TypedMessageRenderer } from '../kinds/TypedMessageRenderer.tsx';
import { SavedMessagesScreen } from '../savedMessages/SavedMessagesScreen.tsx';
import type { SharedCardTruth } from '../sharing/shareApi.ts';

const API = 'https://api.portava.test';
const STORAGE = 'https://abcd.supabase.co';
const THREAD = 'aaaaaaaa-0000-4000-8000-00000000000a';
const MSG = '11111111-0000-4000-8000-000000000001';
const TRACKER = 'tracker.example';
const T = (path: string) => `https://${TRACKER}/${path}?r=recipient-7`;
const S = (path: string) => `${STORAGE}/storage/v1/object/public/stamp-artwork/${path}`;

type Call = { url: string; method: string };
let calls: Call[];
let projectionImage: string;

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  process.env.EXPO_PUBLIC_SUPABASE_URL = STORAGE;
  mockSources.length = 0;
  mockPrefetch.mockReset();
  calls = [];
  projectionImage = T('projection.jpg');
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (String(url).includes('/share-projections')) {
      const refs = JSON.parse(String(init?.body ?? '{}')).refs ?? [];
      return new Response(JSON.stringify({
        threadId: THREAD,
        projections: refs.map((r: any) => ({
          objectType: r.objectType, objectId: r.objectId, messageId: r.messageId ?? null, available: true, status: 'active',
          projection: { objectType: r.objectType, objectId: r.objectId, title: 'Live', subtitle: null, imageUrl: projectionImage, projectionVersion: 'v1', deepLink: '/x' },
          actions: [], deepLink: '/x',
        })),
        unsupported: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  });
  jest.spyOn(RNImage, 'prefetch').mockResolvedValue(true as never);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
});
afterEach(() => { jest.restoreAllMocks(); });

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const flat = (v: unknown): string[] => {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(flat);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).flatMap(flat);
  return [];
};
const recordedSources = () => mockSources.flatMap(flat);

/** The device handed the loader nothing from the sender's host, asked nothing of it, prefetched and opened nothing. */
function assertNamesNoSenderHost() {
  expect(recordedSources().filter((s) => s.includes(TRACKER))).toEqual([]);
  expect(calls.filter((c) => c.url.includes(TRACKER))).toEqual([]);
  for (const c of calls) expect(c.url.startsWith(`${API}/api/`)).toBe(true);
  expect(mockPrefetch).not.toHaveBeenCalled();
  expect(RNImage.prefetch).not.toHaveBeenCalled();
  expect(Linking.openURL).not.toHaveBeenCalled();
}

const liveCard = (kind: string, objectType: string, objectId: string, imageUrl: string): SharedCardTruth => ({
  kind, state: 'live', objectType: objectType as any, objectId, status: 'active',
  projection: { objectType: objectType as any, objectId, title: 'Live title', subtitle: 'Live area', imageUrl, projectionVersion: 'v1', deepLink: '/x' },
  actions: [], deepLink: '/x',
});

describe('legacy shared cards — the JSON the SENDER serialised', () => {
  it('DiscoveryCardMessage, no thread to resolve in (the pre-§5 card): the snapshot imageUrl names no sender host', async () => {
    const body = JSON.stringify({ sourceId: 'x', sourceType: 'mystery', title: 'Snap', category: 'food', city: 'Hue', imageUrl: T('card.jpg') });
    await render(<DiscoveryCardMessage body={body} mine={false} />);
    await settle();
    expect(screen.getByText('Snap')).toBeTruthy();
    assertNamesNoSenderHost();
  });

  it('PostCardMessage, legacy: neither the thumbnail nor the author avatar the sender wrote is loaded', async () => {
    const body = JSON.stringify({ postId: 'p-1', authorName: 'Bob', authorAvatar: T('avatar.jpg'), thumbnail: T('thumb.jpg'), snippet: 'Snippet' });
    await render(<PostCardMessage body={body} mine={false} />);
    await settle();
    expect(screen.getByText('Snippet')).toBeTruthy();
    assertNamesNoSenderHost();
  });

  it('CompassCardMessage: the snapshot imageUrl is never drawn', async () => {
    const body = JSON.stringify({ type: 'compass_card', id: 'place:1', cardType: 'place', title: 'Snap', city: 'Hue', imageUrl: T('compass.jpg') });
    await render(<CompassCardMessage body={body} mine={false} />);
    await settle();
    assertNamesNoSenderHost();
  });
});

describe('server projections from a server that predates TM-1’s image rule', () => {
  it('DiscoveryCardMessage, live (the server’s card truth): a non-storage projection image is not loaded', async () => {
    const body = JSON.stringify({ sourceId: '55550000-0000-4000-8000-000000000002', sourceType: 'hidden_gem', title: 'Snap', category: 'food', city: 'Hue' });
    await render(<DiscoveryCardMessage body={body} mine={false} threadId={THREAD} messageId={MSG} serverCard={liveCard('discovery_card', 'HIDDEN_GEM', '55550000-0000-4000-8000-000000000002', T('live.jpg'))} />);
    await settle();
    expect(screen.getByText('Live title')).toBeTruthy();
    assertNamesNoSenderHost();
  });

  it('PostCardMessage, live: the same', async () => {
    const body = JSON.stringify({ postId: '11110000-0000-4000-8000-000000000001', snippet: 'Snap' });
    await render(<PostCardMessage body={body} mine={false} threadId={THREAD} messageId={MSG} serverCard={liveCard('post_card', 'POST', '11110000-0000-4000-8000-000000000001', T('live.jpg'))} />);
    await settle();
    expect(screen.getByText('Live title')).toBeTruthy();
    assertNamesNoSenderHost();
  });

  it('PortavaObjectMessage (resolved for this viewer through our API): the same', async () => {
    const body = JSON.stringify({ kind: 'PORTAVA_OBJECT', shareProjectionVersion: '1', objectType: 'TRIP', objectId: 'aaaa0000-0000-4000-8000-000000000001' });
    await render(<PortavaObjectMessage body={body} mine={false} threadId={THREAD} messageId={MSG} />);
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());
    expect(calls.some((c) => c.url === `${API}/api/threads/${THREAD}/share-projections`)).toBe(true);
    assertNamesNoSenderHost();
  });
});

describe('media and typed kinds — strings a sender can store', () => {
  const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: '1', payload });

  it('MessageMediaBubble: a legacy media_url and a video poster on another host are not loaded', async () => {
    await render(<MessageMediaBubble mediaType="image" mediaUrl={T('photo.jpg')} mine={false} createdAt="2026-10-14T10:00:00Z" />);
    await render(<MessageMediaBubble mediaType="video" mediaUrl={T('clip.mp4')} thumbnailUrl={T('poster.jpg')} mine={false} createdAt="2026-10-14T10:00:00Z" />);
    await settle();
    assertNamesNoSenderHost();
  });

  it('GIF: neither the animated url nor the still frame is loaded from the sender’s host', async () => {
    await render(
      <>
        <TypedMessageRenderer msgType="gif" body={env('GIF', { url: T('a.gif'), stillUrl: T('a.jpg'), provider: 'x' })} mine={false} />
        <TypedMessageRenderer msgType="gif" body={env('GIF', { url: T('a.gif'), stillUrl: T('a.jpg') })} mine={false} dataSaver />
      </>,
    );
    await settle();
    expect(screen.getAllByTestId('telegraph-kind-gif').length).toBe(2);
    assertNamesNoSenderHost();
  });

  it('MEDIA_ALBUM: no asset or thumbnail url on the sender’s host is loaded', async () => {
    const assets = [
      { url: T('1.jpg'), mediaType: 'image' },
      { url: T('2.jpg'), thumbnailUrl: T('2t.jpg'), mediaType: 'image' },
    ];
    await render(<TypedMessageRenderer msgType="media_album" body={env('MEDIA_ALBUM', { assets })} mine={false} />);
    await settle();
    expect(screen.getByText('ALBUM · 2')).toBeTruthy();
    assertNamesNoSenderHost();
  });

  it('the text kinds (LOCATION, MEMORY_NOTE, ANNOUNCEMENT) with links in their text: drawn as text, nothing loaded', async () => {
    await render(<TypedMessageRenderer msgType="announcement" body={env('ANNOUNCEMENT', { title: `read ${T('a')}`, body: T('b'), requiresAcknowledgement: false })} mine={false} />);
    await render(<TypedMessageRenderer msgType="memory_note" body={env('MEMORY_NOTE', { text: `remember ${T('m')}` })} mine={false} />);
    await settle();
    assertNamesNoSenderHost();
  });
});

describe('text surfaces', () => {
  it('RichText (the DM bubble’s text) and a system notice with a link: text only', async () => {
    await render(
      <>
        <RichText content={`see ${T('page')} now`} />
        <TelegraphSystemNotice text={`notice ${T('n')}`} />
      </>,
    );
    await settle();
    expect(screen.getByText(`see ${T('page')} now`)).toBeTruthy();
    expect(mockSources).toEqual([]);
    assertNamesNoSenderHost();
  });
});

describe('saved messages', () => {
  it('SavedMessagesScreen: a saved text with a link and a saved media row on another host are drawn as text; nothing loaded', async () => {
    const item = (id: string, body: string | null, extra: Record<string, unknown> = {}) => ({
      messageId: id, threadId: THREAD, senderId: 'u-2', body, createdAt: '2026-10-14T10:00:00Z', savedAt: '2026-10-14T11:00:00Z',
      msgType: 'text', subtype: null, mediaUrl: null, mediaType: null, mediaThumbnailUrl: null, ...extra,
    });
    mockGetSaved.mockResolvedValue({ ok: true, data: { saved: [
      item('m-1', `the hostel ${T('hostel')}`),
      item('m-2', null, { msgType: 'media', mediaUrl: T('photo.jpg'), mediaType: 'image', mediaThumbnailUrl: T('thumb.jpg') }),
    ] } });
    await render(<SavedMessagesScreen />);
    await waitFor(() => expect(screen.getByText(`the hostel ${T('hostel')}`)).toBeTruthy());
    await settle();
    assertNamesNoSenderHost();
  });
});

describe('positive controls — Portava storage in the same fields IS loaded (the recorder works)', () => {
  it('a storage URL as a legacy card image, a media_url, a GIF and a projection image are all handed to the loader', async () => {
    projectionImage = S('projection.png');
    await render(<DiscoveryCardMessage body={JSON.stringify({ sourceId: 'x', sourceType: 'mystery', title: 'Snap', category: 'food', city: 'Hue', imageUrl: S('card.png') })} mine={false} />);
    await render(<MessageMediaBubble mediaType="image" mediaUrl={S('photo.png')} mine={false} createdAt="2026-10-14T10:00:00Z" />);
    await render(<TypedMessageRenderer msgType="gif" body={JSON.stringify({ kind: 'GIF', envelopeVersion: '1', payload: { url: S('a.gif') } })} mine={false} />);
    await render(<PortavaObjectMessage body={JSON.stringify({ kind: 'PORTAVA_OBJECT', shareProjectionVersion: '1', objectType: 'TRIP', objectId: 'aaaa0000-0000-4000-8000-000000000001' })} mine={false} threadId={THREAD} messageId={MSG} />);
    await waitFor(() => expect(screen.getByText('Live')).toBeTruthy());
    await settle();
    const seen = recordedSources();
    for (const p of ['card.png', 'photo.png', 'a.gif', 'projection.png']) expect(seen).toContain(S(p));
  });
});
