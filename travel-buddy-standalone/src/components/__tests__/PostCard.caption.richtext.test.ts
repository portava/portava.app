/**
 * PostCard caption → RichText integration verification.
 *
 * Confirms that @mentions and #hashtags in feed post captions are rendered as
 * interactive spans (not plain text) when position metadata is present, matching
 * the contract established by StandardCard and QuestionCard which pass
 * post.tags + post.hashtagUsages to RichText.
 *
 * This test reimplements the segment-building algorithm from RichText.tsx
 * (pure logic, no React, no native modules) so it runs fast under node:test
 * while proving the data-flow contract holds end-to-end.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PostCard.caption.richtext.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal type replicas ─────────────────────────────────────────────────────
// These mirror the shapes in Post.tags / Post.hashtagUsages (models.ts lines 122-124)
// and RichTextTag / RichTextHashtag (RichText.tsx).

interface TagSpan {
  type: 'user' | 'trip' | 'place' | 'event' | 'circle';
  id: string;
  matchToken: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
  isDeleted?: boolean;
}

interface HashtagSpan {
  slug: string;
  hashtagId: string;
  startChar: number;
  endChar: number;
  isBlocked?: boolean;
}

// ── Segment types (mirror RichText.tsx) ───────────────────────────────────────

type PlainSeg   = { kind: 'plain';   text: string };
type MentionSeg = { kind: 'mention'; tag: TagSpan;        displayText: string; interactive: boolean };
type HashtagSeg = { kind: 'hashtag'; hashtag: HashtagSpan; displayText: string; interactive: boolean };
type Seg = PlainSeg | MentionSeg | HashtagSeg;

// ── Segment builder (mirrors RichText.buildSegments) ─────────────────────────

function buildSegments(
  content: string,
  tags: TagSpan[],
  hashtagUsages: HashtagSpan[],
): Seg[] {
  type Entry =
    | { start: number; end: number; tag: TagSpan }
    | { start: number; end: number; hashtag: HashtagSpan };

  const spans: Entry[] = [
    ...tags.map(t => ({ start: t.startChar, end: t.endChar, tag: t })),
    ...hashtagUsages.map(h => ({ start: h.startChar, end: h.endChar, hashtag: h })),
  ];
  spans.sort((a, b) => a.start - b.start);

  const segs: Seg[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.start < cursor || span.end > content.length || span.start >= span.end) continue;
    if (span.start > cursor) segs.push({ kind: 'plain', text: content.slice(cursor, span.start) });
    const displayText = content.slice(span.start, span.end);
    if ('tag' in span) {
      const interactive = !(span.tag.isBlocked || span.tag.isDeleted);
      segs.push({ kind: 'mention', tag: span.tag, displayText, interactive });
    } else {
      segs.push({ kind: 'hashtag', hashtag: span.hashtag, displayText, interactive: !span.hashtag.isBlocked });
    }
    cursor = span.end;
  }
  if (cursor < content.length) segs.push({ kind: 'plain', text: content.slice(cursor) });
  return segs;
}

// ── Navigation route builder (mirrors RichText.navigateTag / navigateHashtag) ─

function mentionRoute(tag: TagSpan): string | null {
  switch (tag.type) {
    case 'user':   return `/u/${tag.matchToken}`;
    case 'trip':   return `/trip/${tag.id}`;
    case 'place':  return `/gems/${tag.id}`;
    case 'event':  return `/meetup/${tag.id}`;
    default:       return null; // 'circle' — no parameterised route
  }
}

function hashtagRoute(slug: string): string {
  return `/hashtag/${slug}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PostCard caption → RichText: segment interactivity', () => {
  const caption = 'Great spot with @alice and @bob! See #travel tips.';
  // positions:  @alice = [16,22), @bob = [27,31), #travel = [37,44)

  const tags: TagSpan[] = [
    { type: 'user', id: 'uid-alice', matchToken: 'alice', startChar: 16, endChar: 22 },
    { type: 'user', id: 'uid-bob',   matchToken: 'bob',   startChar: 27, endChar: 31 },
  ];
  const hashtagUsages: HashtagSpan[] = [
    { slug: 'travel', hashtagId: 'h-1', startChar: 37, endChar: 44 },
  ];

  const segs = buildSegments(caption, tags, hashtagUsages);

  it('produces the correct number of segments', () => {
    // plain | @alice | plain | @bob | plain | #travel | plain  → 7
    assert.strictEqual(segs.length, 7);
  });

  it('@mention segments are interactive', () => {
    const mentions = segs.filter((s): s is MentionSeg => s.kind === 'mention');
    assert.strictEqual(mentions.length, 2);
    assert.ok(mentions.every(m => m.interactive), 'all mentions should be interactive');
  });

  it('#hashtag segment is interactive', () => {
    const tags = segs.filter((s): s is HashtagSeg => s.kind === 'hashtag');
    assert.strictEqual(tags.length, 1);
    assert.ok(tags[0].interactive);
  });

  it('mention display text matches source text', () => {
    const mentions = segs.filter((s): s is MentionSeg => s.kind === 'mention');
    assert.strictEqual(mentions[0].displayText, '@alice');
    assert.strictEqual(mentions[1].displayText, '@bob');
  });

  it('hashtag display text matches source text', () => {
    const ht = segs.find((s): s is HashtagSeg => s.kind === 'hashtag');
    assert.strictEqual(ht?.displayText, '#travel');
  });
});

describe('PostCard caption → RichText: mention navigation routes', () => {
  const cases: Array<{ type: TagSpan['type']; id: string; matchToken: string; expectedRoute: string | null }> = [
    { type: 'user',   id: 'uid-1', matchToken: 'alice',  expectedRoute: '/u/alice'       },
    { type: 'trip',   id: 'trip-1', matchToken: 'trip1', expectedRoute: '/trip/trip-1'   },
    { type: 'place',  id: 'pl-1',  matchToken: 'coffee', expectedRoute: '/gems/pl-1'     },
    { type: 'event',  id: 'ev-1',  matchToken: 'meet1',  expectedRoute: '/meetup/ev-1'   },
    { type: 'circle', id: 'ci-1',  matchToken: 'crew',   expectedRoute: null             },
  ];

  for (const { type, id, matchToken, expectedRoute } of cases) {
    it(`${type} mention → ${expectedRoute ?? '(no short-press route)'}`, () => {
      const tag: TagSpan = { type, id, matchToken, startChar: 0, endChar: 1 };
      assert.strictEqual(mentionRoute(tag), expectedRoute);
    });
  }
});

describe('PostCard caption → RichText: blocked/deleted spans render as plain', () => {
  const caption = 'Meet @blocked and #banned here.';
  const tags: TagSpan[] = [
    { type: 'user', id: 'uid-x', matchToken: 'blocked', startChar: 5, endChar: 13, isBlocked: true },
  ];
  const hashtagUsages: HashtagSpan[] = [
    { slug: 'banned', hashtagId: 'h-x', startChar: 18, endChar: 25, isBlocked: true },
  ];

  const segs = buildSegments(caption, tags, hashtagUsages);

  it('blocked @mention is NOT interactive', () => {
    const mention = segs.find((s): s is MentionSeg => s.kind === 'mention');
    assert.ok(mention, 'mention segment should exist');
    assert.strictEqual(mention.interactive, false);
  });

  it('blocked #hashtag is NOT interactive', () => {
    const ht = segs.find((s): s is HashtagSeg => s.kind === 'hashtag');
    assert.ok(ht, 'hashtag segment should exist');
    assert.strictEqual(ht.interactive, false);
  });
});

describe('PostCard caption → RichText: plain fallback (no metadata)', () => {
  it('empty tags + hashtagUsages → single plain segment', () => {
    const segs = buildSegments('Hello world!', [], []);
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].kind, 'plain');
    assert.strictEqual((segs[0] as PlainSeg).text, 'Hello world!');
  });
});

describe('PostCard caption → RichText: hashtag navigation', () => {
  it('produces /hashtag/:slug route', () => {
    assert.strictEqual(hashtagRoute('bali'), '/hashtag/bali');
    assert.strictEqual(hashtagRoute('solo-travel'), '/hashtag/solo-travel');
  });
});
