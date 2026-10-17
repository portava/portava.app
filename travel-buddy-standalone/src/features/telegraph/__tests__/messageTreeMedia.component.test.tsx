/**
 * census-telegraph T446 (§30A.20), the CLIENT half:
 *
 *   "External previews cannot cause recipient-side network disclosure to
 *    arbitrary sender-controlled domains." (TG:653)
 *
 * The server half (§91) withholds a non-storage share-card image and refuses a
 * non-storage media URL at the door. What it could not stop is the device: the
 * message tree drew a legacy card's sender-serialised JSON, a typed GIF or album
 * payload, a voice note's url and pre-door media rows, and the hydration layer
 * passes a non-storage URL through unchanged. `messageTreeMediaOrNull` is the
 * client's rule; this suite holds the tree to it.
 *
 *   P1–P3  the predicate, on the server suite's own vectors (I1–I3) — the
 *          cross-tree mirror is `artifacts/api-server/src/test/
 *          telegraphMessageTreeMediaMirror.test.ts`;
 *   S1–S3  STRUCTURAL: every image / poster / video / audio / open-in-browser
 *          sink in the message tree passes through the rule, or is named in
 *          EXEMPT with the reason its URL is not taken from a message — and no
 *          exemption outlives its sink;
 *   B1–B5  behaviour through the real components and the real playback store.
 */
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { configuredStorageOrigin, messageTreeMediaOrNull } from '../media/messageTreeMedia.ts';

const ORIGIN = 'https://proj.supabase.co';

describe('T446 — the rule (the server suite\'s vectors)', () => {
  it('P1 storage on the configured origin is kept, any bucket, public or signed; so is a bare reference', () => {
    for (const ok of [
      'https://proj.supabase.co/storage/v1/object/public/stamp-artwork/s.png',
      'https://proj.supabase.co/storage/v1/object/public/post-media/a/b.jpg',
      'https://proj.supabase.co/storage/v1/object/sign/post-media/a.jpg?token=t',
      'https://proj.supabase.co/storage/v1/render/image/public/post-media/a.jpg?width=200',
      'post-media/generated-visuals/a.webp',
      'profile-media/u/avatar.jpg',
    ]) expect(messageTreeMediaOrNull(ok, ORIGIN)).toBe(ok);
  });

  it('P2 every other host or shape is withheld', () => {
    for (const bad of [
      'https://tracker.example/pixel.png?r=bob',
      'http://proj.supabase.co/storage/v1/object/public/post-media/a.jpg',
      'https://proj.supabase.co.evil.example/storage/v1/object/public/post-media/a.jpg',
      'https://proj.supabase.co/rest/v1/profiles',
      'https://user@proj.supabase.co/storage/v1/object/public/post-media/a.jpg',
      '//tracker.example/a.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'file:///var/mobile/a.jpg',
      'tracker.example/a.png',
      'post-media/../profile-media/x.jpg',
      'post-media/a b.jpg',
      'lh3.googleusercontent.com/a/photo',
      '', '   ', null, undefined, 42,
    ]) expect(messageTreeMediaOrNull(bad, ORIGIN)).toBeNull();
  });

  it('P3 no configured origin: every absolute URL is withheld, a bare reference is kept; the origin is read from the build', () => {
    expect(messageTreeMediaOrNull('https://proj.supabase.co/storage/v1/object/public/post-media/a.jpg', null)).toBeNull();
    expect(messageTreeMediaOrNull('post-media/a.jpg', null)).toBe('post-media/a.jpg');
    expect(configuredStorageOrigin('https://proj.supabase.co/')).toBe(ORIGIN);
    expect(configuredStorageOrigin('')).toBeNull();
    expect(configuredStorageOrigin(undefined)).toBeNull();
    expect(configuredStorageOrigin('not a url')).toBeNull();
  });
});

// ── STRUCTURAL ────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function telegraphFeatureFiles(dir = 'src/features/telegraph'): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== '__tests__') out.push(...telegraphFeatureFiles(rel));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

/** The message tree: what draws a conversation's messages, and everything under the Telegraph feature. */
const MESSAGE_TREE = [
  'app/messages/[id].tsx',
  'src/components/GroupChatScreen.tsx',
  'src/components/MessageMediaBubble.tsx',
  'src/components/PostCardMessage.tsx',
  'src/components/DiscoveryCardMessage.tsx',
  'src/components/CompassCardMessage.tsx',
  'src/components/CircleStatusCardMessage.tsx',
  'src/components/TelegraphSystemNotice.tsx',
  'src/components/TelegraphRecommendationCard.tsx',
  'src/components/rentabuddy/BookingMilestoneMessage.tsx',
  ...telegraphFeatureFiles(),
];

/** Every sink that fetches or opens a URL, and the expression it is handed. */
const SINKS: ReadonlyArray<[string, RegExp]> = [
  ['uri prop', /\buri=\{([^}]*)\}/g],
  ['Image source', /source=\{\{\s*uri(?::\s*([^}]*?))?\s*\}\}/g], // `{{ uri }}` shorthand names `uri`
  ['video poster', /\bposterUri=\{([^}]*)\}/g],
  ['open in browser', /Linking\.openURL\(([^)]*)\)/g],
  ['video session', /openMessageVideo\(\{\s*mediaRef:\s*([^,}]*)/g],
  ['voice note', /<VoiceMessagePlayer[\s\S]*?\burl=\{([^}]*)\}/g],
];

/**
 * Sinks whose URL is NOT taken from a message, with the reason. A profile
 * avatar is the person's profile row (served by the server's own projection),
 * not anything a sender put in a message.
 */
const EXEMPT: ReadonlyArray<{ file: string; expr: string; why: string }> = [
  { file: 'src/components/GroupChatScreen.tsx', expr: 'm.avatarUrl', why: "a member's profile avatar in the header stack (GET members)" },
  { file: 'src/components/GroupChatScreen.tsx', expr: 'm.senderAvatarUrl', why: "the sender's profile avatar the server joins to the row" },
  { file: 'src/components/GroupChatScreen.tsx', expr: 'uri', why: "read receipts: readers' profile avatars (useReaderAvatars)" },
  { file: 'app/messages/[id].tsx', expr: 'creator?.avatarUrl', why: "a meetup creator's profile avatar (GET /meetups/:id)" },
  { file: 'app/messages/[id].tsx', expr: 'attendee.avatarUrl', why: "a meetup attendee's profile avatar" },
  { file: 'app/messages/[id].tsx', expr: 'uri', why: "read receipts: readers' profile avatars (useReaderAvatars)" },
  { file: 'app/messages/[id].tsx', expr: 'dmProfile?.avatarUrl', why: "the other person's profile avatar in the header" },
  { file: 'src/features/telegraph/media/CompactPlaybackHost.tsx', expr: 'session.mediaRef', why: 'admitted only by openMessageVideo, which applies the rule (B4)' },
  { file: 'src/features/telegraph/linkPreview/LinkPreviewCard.tsx', expr: 'preview.url', why: "the viewer's own tap on a stored preview's link — the URL the message text shows; drawing the card fetches nothing (text only, T404)" },
];

const RULE = 'messageTreeMediaOrNull(';

function guarded(src: string, expr: string): boolean {
  if (expr.includes(RULE)) return true;
  const id = /^[A-Za-z_$][\w$]*/.exec(expr.trim())?.[0];
  if (!id) return false;
  return new RegExp(`const\\s+${id.replace('$', '\\$')}\\s*=\\s*messageTreeMediaOrNull\\(`).test(src);
}

function sinksOf(file: string): Array<{ kind: string; expr: string }> {
  const src = read(file);
  const found: Array<{ kind: string; expr: string }> = [];
  for (const [kind, re] of SINKS) {
    for (const m of src.matchAll(re)) found.push({ kind, expr: (m[1] ?? 'uri').trim() });
  }
  return found;
}

describe('T446 — STRUCTURAL: the message tree fetches nothing a message named, except through the rule', () => {
  it('S1 the tree is the files it claims to be, and they hold sinks to check (not vacuous)', () => {
    for (const f of MESSAGE_TREE) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
    expect(MESSAGE_TREE.length).toBeGreaterThan(40);
    const all = MESSAGE_TREE.flatMap((f) => sinksOf(f));
    expect(all.length).toBeGreaterThanOrEqual(15);
    // The detector sees each kind it claims to see.
    for (const kind of ['uri prop', 'Image source', 'video poster', 'open in browser', 'video session', 'voice note']) {
      expect(all.some((s) => s.kind === kind)).toBe(true);
    }
  });

  it('S2 every sink is guarded, or exempt with a reason', () => {
    const offenders: string[] = [];
    for (const file of MESSAGE_TREE) {
      const src = read(file);
      for (const { kind, expr } of sinksOf(file)) {
        if (guarded(src, expr)) continue;
        if (EXEMPT.some((e) => e.file === file && e.expr === expr)) continue;
        offenders.push(`${file}: ${kind} ← ${expr}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('S3 no exemption outlives its sink', () => {
    const stale = EXEMPT.filter((e) => !sinksOf(e.file).some((s) => s.expr === e.expr));
    expect(stale).toEqual([]);
  });
});

// ── BEHAVIOUR ─────────────────────────────────────────────────────────────────

jest.mock('../../../components/ui/DisplayMediaImage.tsx', () => {
  const RN = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  const stub = (props: { uri?: string | null }) =>
    R.createElement(RN.View, { testID: 'display-media-image', accessibilityHint: props.uri ?? 'NO-URI' });
  return { ...jest.requireActual('../../../components/ui/DisplayMediaImage.tsx'), DisplayMediaImage: stub };
});
jest.mock('../../../components/ui/Avatar.tsx', () => {
  const RN = jest.requireActual('react-native');
  const R = jest.requireActual('react');
  const stub = (props: { uri?: string | null }) =>
    R.createElement(RN.View, { testID: 'avatar', accessibilityHint: props.uri ?? 'NO-URI' });
  return { ...jest.requireActual('../../../components/ui/Avatar.tsx'), Avatar: stub };
});
// NOTE: intentional stub — AccessibilityInfo is not backed by the jest preset
// (the same stub kinds.component.test.tsx uses).
jest.mock('../../wall/hooks/useReducedMotionSetting.ts', () => ({
  useReducedMotionSetting: jest.fn(() => false),
}));

const TRACKER = 'https://tracker.example/pixel.png?who=recipient';
const STORED = 'post-media/u1/photo.jpg';
const env = (kind: string, payload: unknown) => JSON.stringify({ kind, envelopeVersion: '1', payload });

function drawn(testID: string): string[] {
  return screen.queryAllByTestId(testID).map((n) => String(n.props.accessibilityHint));
}

describe('T446 — behaviour through the real components', () => {
  it('B1 MessageMediaBubble: a sender URL draws no image; storage draws', async () => {
    const { MessageMediaBubble } = require('../../../components/MessageMediaBubble.tsx');
    await render(<MessageMediaBubble mediaType="image" mediaUrl={TRACKER} mine={false} createdAt="2026-10-17T10:00:00.000Z" />);
    expect(drawn('display-media-image')).toEqual(['NO-URI']);
    await render(<MessageMediaBubble mediaType="image" mediaUrl={STORED} mine={false} createdAt="2026-10-17T10:00:00.000Z" />);
    expect(drawn('display-media-image')).toEqual([STORED]);
  });

  it('B2 PostCardMessage (legacy, no thread): the sender-serialised avatar and thumbnail are withheld; storage is kept', async () => {
    const { PostCardMessage } = require('../../../components/PostCardMessage.tsx');
    const body = (avatar: string, thumb: string) => JSON.stringify({ postId: 'p1', authorName: 'Bob', authorAvatar: avatar, thumbnail: thumb, snippet: 'hi' });
    await render(<PostCardMessage body={body(TRACKER, TRACKER)} mine={false} />);
    expect(drawn('avatar')).toEqual(['NO-URI']);
    expect(drawn('display-media-image')).toEqual([]);
    await render(<PostCardMessage body={body('profile-media/b/a.jpg', STORED)} mine={false} />);
    expect(drawn('avatar')).toEqual(['profile-media/b/a.jpg']);
    expect(drawn('display-media-image')).toEqual([STORED]);
  });

  it('B3 DiscoveryCardMessage (legacy, no thread): the payload image from another host is not drawn', async () => {
    const { DiscoveryCardMessage } = require('../../../components/DiscoveryCardMessage.tsx');
    const body = (img: string) => JSON.stringify({ sourceId: 's1', sourceType: 'unmapped', title: 'Cafe', category: 'food', city: 'Da Nang', imageUrl: img });
    await render(<DiscoveryCardMessage body={body(TRACKER)} mine={false} />);
    expect(drawn('display-media-image')).toEqual([]);
    await render(<DiscoveryCardMessage body={body(STORED)} mine={false} />);
    expect(drawn('display-media-image')).toEqual([STORED]);
  });

  it('B4 the playback store refuses a non-storage video even when a live message carries it; storage still opens', () => {
    const store = require('../media/compactPlaybackStore.ts');
    store._resetCompactPlaybackForTests();
    const source = store.registerMessageSource();
    const video = (id: string, mediaUrl: string) => ({ id, senderId: 'u2', msgType: 'media', mediaType: 'video', mediaUrl, deleted: false });
    store.reportMessageSource(source, { threadId: 't1', live: true, messages: [video('m1', TRACKER), video('m2', 'post-media/u2/v.mp4')] });
    expect(store.openMessageVideo({ mediaRef: TRACKER, posterRef: null })).toBe(false);
    expect(store.getCompactPlayback()).toBeNull();
    expect(store.openMessageVideo({ mediaRef: 'post-media/u2/v.mp4', posterRef: TRACKER })).toBe(true);
    expect(store.getCompactPlayback()?.posterRef).toBeNull();
    store._resetCompactPlaybackForTests();
  });

  it('B5 TypedMessageRenderer: a GIF from another host draws no image; an album keeps only storage', async () => {
    const { TypedMessageRenderer } = require('../kinds/TypedMessageRenderer.tsx');
    await render(<TypedMessageRenderer msgType="gif" body={env('GIF', { url: TRACKER, stillUrl: TRACKER })} mine={false} />);
    expect(drawn('display-media-image')).toEqual(['NO-URI']);
    await render(<TypedMessageRenderer msgType="media_album" body={env('MEDIA_ALBUM', { assets: [{ url: TRACKER }, { url: STORED }] })} mine={false} />);
    expect(drawn('display-media-image')).toEqual(['NO-URI', STORED]);
  });
});
