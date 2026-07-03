/**
 * PostCard caption → RichText integration verification.
 *
 * Imports the real `buildSegments`, `mentionNavigationRoute`, and
 * `hashtagNavigationRoute` from richTextSegments.ts (the canonical source
 * shared with RichText.tsx) — no replica logic, no drift risk.
 *
 * Confirms that @mentions and #hashtags in feed post captions are rendered as
 * interactive segments when position metadata is present, matching the contract
 * established by StandardCard (numberOfLines={5}) and QuestionCard
 * (numberOfLines={4}) which pass post.tags + post.hashtagUsages to RichText.
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PostCard.caption.richtext.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSegments,
  mentionNavigationRoute,
  hashtagNavigationRoute,
  type RichTextTag,
  type RichTextHashtag,
  type MentionSegment,
  type HashtagSegment,
  type PlainSegment,
} from '../richTextSegments.ts';

// ── Segment interactivity ─────────────────────────────────────────────────────

describe('PostCard caption → RichText: segment interactivity', () => {
  const caption = 'Great spot with @alice and @bob! See #travel tips.';
  // positions:  @alice = [16,22), @bob = [27,31), #travel = [37,44)

  const tags: RichTextTag[] = [
    { type: 'user', id: 'uid-alice', matchToken: 'alice', startChar: 16, endChar: 22 },
    { type: 'user', id: 'uid-bob',   matchToken: 'bob',   startChar: 27, endChar: 31 },
  ];
  const hashtagUsages: RichTextHashtag[] = [
    { slug: 'travel', startChar: 37, endChar: 44 },
  ];

  const segs = buildSegments(caption, tags, hashtagUsages);

  it('produces the correct number of segments (plain | @alice | plain | @bob | plain | #travel | plain)', () => {
    assert.strictEqual(segs.length, 7);
  });

  it('@mention segments are interactive', () => {
    const mentions = segs.filter((s): s is MentionSegment => s.kind === 'mention');
    assert.strictEqual(mentions.length, 2);
    assert.ok(mentions.every(m => m.interactive), 'all mentions should be interactive');
  });

  it('#hashtag segment is interactive', () => {
    const hashtags = segs.filter((s): s is HashtagSegment => s.kind === 'hashtag');
    assert.strictEqual(hashtags.length, 1);
    assert.ok(hashtags[0].interactive);
  });

  it('mention display text matches source text', () => {
    const mentions = segs.filter((s): s is MentionSegment => s.kind === 'mention');
    assert.strictEqual(mentions[0].displayText, '@alice');
    assert.strictEqual(mentions[1].displayText, '@bob');
  });

  it('hashtag display text matches source text', () => {
    const ht = segs.find((s): s is HashtagSegment => s.kind === 'hashtag');
    assert.strictEqual(ht?.displayText, '#travel');
  });
});

// ── Mention navigation routes ─────────────────────────────────────────────────

describe('PostCard caption → RichText: mention navigation routes', () => {
  const cases: Array<{ type: RichTextTag['type']; id: string; matchToken: string; expectedRoute: string | null }> = [
    { type: 'user',   id: 'uid-1',  matchToken: 'alice',  expectedRoute: '/u/alice'      },
    { type: 'trip',   id: 'trip-1', matchToken: 'trip1',  expectedRoute: '/trip/trip-1'  },
    { type: 'place',  id: 'pl-1',   matchToken: 'coffee', expectedRoute: '/gems/pl-1'    },
    { type: 'event',  id: 'ev-1',   matchToken: 'meet1',  expectedRoute: '/meetup/ev-1'  },
    { type: 'circle', id: 'ci-1',   matchToken: 'crew',   expectedRoute: null            },
  ];

  for (const { type, id, matchToken, expectedRoute } of cases) {
    it(`${type} → ${expectedRoute ?? '(no short-press route)'}`, () => {
      const tag: RichTextTag = { type, id, matchToken, startChar: 0, endChar: 1 };
      assert.strictEqual(mentionNavigationRoute(tag), expectedRoute);
    });
  }
});

// ── Blocked / deleted / private spans → plain ─────────────────────────────────

describe('PostCard caption → RichText: blocked/deleted/private spans render as non-interactive', () => {
  const caption = 'Meet @blocked and #banned here.';
  // @blocked = [5,13), #banned = [18,25)

  const tags: RichTextTag[] = [
    { type: 'user', id: 'uid-x', matchToken: 'blocked', startChar: 5, endChar: 13, isBlocked: true },
  ];
  const hashtagUsages: RichTextHashtag[] = [
    { slug: 'banned', startChar: 18, endChar: 25, isBlocked: true },
  ];

  const segs = buildSegments(caption, tags, hashtagUsages);

  it('blocked @mention is NOT interactive', () => {
    const mention = segs.find((s): s is MentionSegment => s.kind === 'mention');
    assert.ok(mention, 'mention segment should exist');
    assert.strictEqual(mention.interactive, false);
  });

  it('blocked #hashtag is NOT interactive', () => {
    const ht = segs.find((s): s is HashtagSegment => s.kind === 'hashtag');
    assert.ok(ht, 'hashtag segment should exist');
    assert.strictEqual(ht.interactive, false);
  });

  it('deleted @mention is NOT interactive', () => {
    const segsDeleted = buildSegments(
      'Hey @gone!',
      [{ type: 'user', id: 'uid-d', matchToken: 'gone', startChar: 4, endChar: 9, isDeleted: true }],
      [],
    );
    const mention = segsDeleted.find((s): s is MentionSegment => s.kind === 'mention');
    assert.ok(mention);
    assert.strictEqual(mention.interactive, false);
  });

  it('private @mention is NOT interactive', () => {
    const segsPrivate = buildSegments(
      'Follow @priv.',
      [{ type: 'user', id: 'uid-p', matchToken: 'priv', startChar: 7, endChar: 12, isPrivate: true }],
      [],
    );
    const mention = segsPrivate.find((s): s is MentionSegment => s.kind === 'mention');
    assert.ok(mention);
    assert.strictEqual(mention.interactive, false);
  });
});

// ── Plain fallback (no metadata) ──────────────────────────────────────────────

describe('PostCard caption → RichText: plain fallback (no metadata)', () => {
  it('empty tags + hashtagUsages → single plain segment', () => {
    const segs = buildSegments('Hello world!', [], []);
    assert.strictEqual(segs.length, 1);
    assert.strictEqual(segs[0].kind, 'plain');
    assert.strictEqual((segs[0] as PlainSegment).text, 'Hello world!');
  });
});

// ── Hashtag navigation ────────────────────────────────────────────────────────

describe('PostCard caption → RichText: hashtag navigation', () => {
  it('produces /hashtag/:slug route', () => {
    assert.strictEqual(hashtagNavigationRoute('bali'), '/hashtag/bali');
    assert.strictEqual(hashtagNavigationRoute('solo-travel'), '/hashtag/solo-travel');
  });
});

// ── Out-of-bounds / overlapping spans are skipped ─────────────────────────────

describe('PostCard caption → RichText: span edge cases', () => {
  it('overlapping spans are skipped', () => {
    const caption = '@alice hello';
    const tags: RichTextTag[] = [
      { type: 'user', id: 'uid-1', matchToken: 'alice', startChar: 0,  endChar: 6 },
      { type: 'user', id: 'uid-2', matchToken: 'alice', startChar: 3,  endChar: 8 }, // overlaps
    ];
    const segs = buildSegments(caption, tags, []);
    const mentions = segs.filter(s => s.kind === 'mention');
    assert.strictEqual(mentions.length, 1, 'only the first non-overlapping span should produce a segment');
  });

  it('out-of-bounds spans are skipped', () => {
    const caption = 'Hi';
    const tags: RichTextTag[] = [
      { type: 'user', id: 'uid-1', matchToken: 'x', startChar: 0, endChar: 99 },
    ];
    const segs = buildSegments(caption, tags, []);
    const mentions = segs.filter(s => s.kind === 'mention');
    assert.strictEqual(mentions.length, 0);
  });
});
