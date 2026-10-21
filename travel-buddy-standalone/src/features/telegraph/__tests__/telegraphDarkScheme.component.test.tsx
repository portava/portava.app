/**
 * census-telegraph T123 — the migrated Telegraph modules, RENDERED in each
 * scheme. The ratchet (telegraphPaletteRatchet.component.test.ts) proves the
 * source reads the palette; this proves what reaches the screen.
 *
 *   D*  with the device in DARK mode, no rendered colour on any of these
 *       modules is a light-only surface or text colour (the light palette's
 *       surfaces, the app's ink, mute, faint and haze), and each draws the dark
 *       palette's own surface or text — so a module that silently stayed light
 *       is red, and so is one that went dark only half way.
 *   L*  with the device in LIGHT mode the same modules draw the colours they
 *       always drew (the light palette is the old TG/tokens values), so the
 *       migration re-themed nothing by accident.
 *
 * The device scheme is the ONE thing stubbed: RN's own useColorScheme module.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { color } from '../../../theme/tokens.ts';
import { TELEGRAPH_PALETTES } from '../theme/telegraphTheme.ts';
import type { SharedCardTruth, TelegraphShareProjection } from '../sharing/shareApi.ts';
import type { TelegraphActivityRecommendation } from '../../../types/models.ts';
import type { TelegraphSuggestion } from '../../../services/telegraphChat.ts';
import type { MessageSafetySignals } from '../types/index.ts';

let mockScheme: 'light' | 'dark' = 'dark';
// NOTE: intentionally exhaustive — the device's appearance is the variable under test.
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({ __esModule: true, default: () => mockScheme }));
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset.
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({ useReducedMotionSetting: jest.fn(() => false) }));
// The SHARED image component (src/components/ui/DisplayMediaImage.tsx) is not a Telegraph
// module and has no dark scheme: its loading skeleton and no-image state draw `haze` and
// `paper`. Stubbed here so this suite measures the Telegraph module around it; that gap is
// recorded as a shared-component remainder (census T123), not hidden.
jest.mock('../../../components/ui/DisplayMediaImage.tsx', () => {
  const RN = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  return { ...jest.requireActual('../../../components/ui/DisplayMediaImage.tsx'), DisplayMediaImage: () => R.createElement(RN.View, { testID: 'shared-image' }) };
});
jest.mock('../sharing/shareApi.ts', () => {
  const actual = jest.requireActual('../sharing/shareApi.ts');
  return { ...actual, resolveShareProjections: jest.fn(async () => ({ ok: false, error: 'offline' })) };
});

import { TelegraphSystemNotice } from '../../../components/TelegraphSystemNotice.tsx';
import { BookingMilestoneMessage } from '../../../components/rentabuddy/BookingMilestoneMessage.tsx';
import { TelegraphAvatar, TelegraphRow, TelegraphBubble } from '../../../components/telegraph/TelegraphPrimitives.tsx';
import { CompassCardMessage } from '../../../components/CompassCardMessage.tsx';
import { DiscoveryCardMessage } from '../../../components/DiscoveryCardMessage.tsx';
import { CircleStatusCardMessage } from '../../../components/CircleStatusCardMessage.tsx';
import { PostCardMessage } from '../../../components/PostCardMessage.tsx';
import { TelegraphRecommendationCard } from '../../../components/TelegraphRecommendationCard.tsx';
import { MessageMediaBubble } from '../../../components/MessageMediaBubble.tsx';
import { TelegraphChatCard } from '../../../components/TelegraphChatCard.tsx';
import { OriginalAlongside } from '../translation/OriginalAlongside.tsx';
import { OwnMessageStatusRow } from '../lifecycle/OwnMessageStatusRow.tsx';
import { LinkPreviewCard } from '../linkPreview/LinkPreviewCard.tsx';
import { MessageSafetyBanner } from '../components/MessageSafetyBanner.tsx';
import { StrangerMediaShield } from '../components/StrangerMediaShield.tsx';

const D = TELEGRAPH_PALETTES.dark;
const L = TELEGRAPH_PALETTES.light;
const norm = (c: unknown) => (typeof c === 'string' ? c.toUpperCase().replace(/\s+/g, '') : '');

/** Colours that may never reach a DARK screen: light surfaces as fills, light inks as text. */
const LIGHT_FILLS = new Set([L.surface, L.surfaceRaised, L.recvBubble, color.paper, color.paperRaised, color.haze].map(norm));
const LIGHT_INKS = new Set([color.ink, color.mute, color.faint, color.deep].map(norm));
const DARK_OWN = new Set([D.surface, D.surfaceRaised, D.recvBubble, D.recvText, D.mute, D.haze, D.faint, D.sentBubble, D.sentText, D.operational].map(norm));

interface Drawn { fills: string[]; inks: string[]; borders: string[] }

function flatten(style: unknown, out: Record<string, unknown>): void {
  if (!style) return;
  if (Array.isArray(style)) { for (const s of style) flatten(s, out); return; }
  if (typeof style === 'object') Object.assign(out, style);
}

function drawn(): Drawn {
  const d: Drawn = { fills: [], inks: [], borders: [] };
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    const node = n as { props?: Record<string, unknown>; children?: unknown };
    const st: Record<string, unknown> = {};
    flatten(node.props?.style, st);
    if (st.backgroundColor) d.fills.push(norm(st.backgroundColor));
    if (st.color) d.inks.push(norm(st.color));
    for (const k of ['borderColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor']) if (st[k]) d.borders.push(norm(st[k]));
    // icons (lucide mock) and spinners carry their colour as a prop
    if (typeof node.props?.color === 'string') d.inks.push(norm(node.props.color));
    visit(node.children);
  };
  visit(screen.toJSON());
  return d;
}

const projectionLive: TelegraphShareProjection = {
  objectType: 'POST', objectId: '11110000-0000-4000-8000-000000000001', title: 'Live post', subtitle: '@ana',
  imageUrl: null, projectionVersion: 'v1', deepLink: '/post/p',
};
const GEM = '55550000-0000-4000-8000-000000000002';
const gemLive: SharedCardTruth = { kind: 'compass_card', state: 'live', objectType: 'HIDDEN_GEM', objectId: GEM, status: 'active', projection: { ...projectionLive, objectType: 'HIDDEN_GEM', objectId: GEM }, actions: [], deepLink: '/x' };
const postLive: SharedCardTruth = { kind: 'post_card', state: 'live', objectType: 'POST', objectId: projectionLive.objectId, status: 'active', projection: projectionLive, actions: [], deepLink: '/post/p' };
const rec: TelegraphActivityRecommendation = { id: 'r', title: 'Night market', category: 'question', reason: 'Close by', locationContext: 'Hai Chau', estimatedTime: '1h', priceLevel: '$' };
const suggestion: TelegraphSuggestion = { id: 's', intent_type: 'meet', title: 'Meet up', reason: 'You are both free', category: 'meetup', action_type: 'create_meetup', location_context: 'Hai Chau', time_context: 'Tonight', created_at: '2026-10-17T10:00:00Z', expires_at: '2026-10-18T10:00:00Z' };
const notice: MessageSafetySignals = { severity: 'notice', scam: [], links: [{ raw: 'https://bit.ly/x', host: 'bit.ly', findings: ['SHORTENER'], suspicious: true }] };

const CASES: Array<[string, () => React.ReactElement]> = [
  ['TelegraphSystemNotice', () => <TelegraphSystemNotice text="Trip plan updated" />],
  ['BookingMilestoneMessage (fallback pill)', () => <BookingMilestoneMessage subtype="rent_buddy_unknown" body="Something happened" />],
  ['BookingMilestoneMessage (route approved)', () => <BookingMilestoneMessage subtype="rent_buddy_route_approved" />],
  ['TelegraphAvatar + TelegraphRow', () => <TelegraphRow avatar={<TelegraphAvatar name="Ana" />}><TelegraphAvatar kind="trip" /></TelegraphRow>],
  ['TelegraphBubble (received)', () => <TelegraphBubble mine={false}><></></TelegraphBubble>],
  ['CompassCardMessage (reference)', () => <CompassCardMessage body={JSON.stringify({ id: 'place:x', cardType: 'place' })} mine={false} />],
  ['CompassCardMessage (live, received)', () => <CompassCardMessage body={JSON.stringify({ id: 'gem:55550000-0000-4000-8000-000000000002', cardType: 'hidden_gem' })} mine={false} threadId="t" serverCard={gemLive} />],
  ['DiscoveryCardMessage (legacy)', () => <DiscoveryCardMessage body={JSON.stringify({ sourceId: 's', sourceType: 'unmapped', title: 'Cafe', category: 'food', city: 'Da Nang', blurb: 'Good', caption: 'try it' })} mine={false} />],
  ['CircleStatusCardMessage (meeting point)', () => <CircleStatusCardMessage subtype="meeting_point" venueLabel="Cafe" isCircleMember mine={false} onPress={() => {}} />],
  ['PostCardMessage (live)', () => <PostCardMessage body={JSON.stringify({ postId: projectionLive.objectId, caption: 'look' })} mine={false} threadId="t" messageId="m" serverCard={postLive} />],
  ['TelegraphRecommendationCard', () => <TelegraphRecommendationCard rec={rec} onAddToTrip={() => {}} onDismiss={() => {}} onSave={() => {}} onShare={() => {}} onNotInterested={() => {}} />],
  ['MessageMediaBubble (received image)', () => <MessageMediaBubble mediaType="image" mediaUrl="post-media/u/a.jpg" mine={false} senderName="Ana" createdAt="2026-10-17T10:00:00Z" />],
  ['MessageMediaBubble (uploading)', () => <MessageMediaBubble mediaType="video" mediaUrl={null} mine={false} createdAt="2026-10-17T10:00:00Z" uploadState="uploading" onCancel={() => {}} />],
  ['TelegraphChatCard', () => <TelegraphChatCard suggestion={suggestion} onDismiss={() => {}} onAction={async () => {}} />],
  ['OriginalAlongside', () => <OriginalAlongside item={{ originalBody: 'Xin chào', displayBody: 'Hello', translated: true, showOriginalAlongside: true }} view={{ mine: false, autoTranslate: true, showingOriginal: false }} />],
  ['OwnMessageStatusRow', () => <OwnMessageStatusRow status={{ kind: 'sent' }} isGroup={false} />],
  ['LinkPreviewCard', () => <LinkPreviewCard preview={{ messageId: 'm', url: 'https://e.example/a', host: 'e.example', title: 'E', description: 'D', siteName: 'S' }} mine={false} />],
  ['MessageSafetyBanner (notice)', () => <MessageSafetyBanner messageId="m" signals={notice} />],
  ['StrangerMediaShield', () => <StrangerMediaShield senderConnected={false} mediaKind="image" messageId="m"><></></StrangerMediaShield>],
];

describe('T123 — DARK: the modules draw the dark palette and nothing light', () => {
  beforeAll(() => { mockScheme = 'dark'; });
  it.each(CASES)('D %s', async (_name, make) => {
    await render(make());
    const d = drawn();
    expect(d.fills.length + d.inks.length).toBeGreaterThan(0); // the walk saw colours (not vacuous)
    expect(d.fills.filter((c) => LIGHT_FILLS.has(c))).toEqual([]);
    expect(d.inks.filter((c) => LIGHT_INKS.has(c))).toEqual([]);
    expect([...d.fills, ...d.inks, ...d.borders].some((c) => DARK_OWN.has(c))).toBe(true);
  });
});

describe('T123 — LIGHT: the same modules draw what they always drew', () => {
  beforeAll(() => { mockScheme = 'light'; });
  it('L1 the system notice pill: white fill, the old received border, mute text', async () => {
    await render(<TelegraphSystemNotice text="Trip plan updated" />);
    const d = drawn();
    expect(d.fills).toContain(norm('#FFFFFF'));
    expect(d.borders).toContain(norm('rgba(0,0,0,0.07)'));
    expect(d.inks).toContain(norm(color.mute));
  });
  it('L2 a received media bubble: white bubble, faint time', async () => {
    await render(<MessageMediaBubble mediaType="image" mediaUrl="post-media/u/a.jpg" mine={false} createdAt="2026-10-17T10:00:00Z" />);
    const d = drawn();
    expect(d.fills).toContain(norm('#FFFFFF'));
    expect(d.inks).toContain(norm(color.faint));
  });
  it('L3 a sent media bubble: the dark-green sent fill', async () => {
    await render(<MessageMediaBubble mediaType="image" mediaUrl="post-media/u/a.jpg" mine createdAt="2026-10-17T10:00:00Z" />);
    expect(drawn().fills).toContain(norm('#1A3A2A'));
  });
});
