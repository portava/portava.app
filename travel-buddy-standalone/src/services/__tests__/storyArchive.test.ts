/**
 * storyArchive — the distinctions the screen depends on.
 *
 * The archive has exactly two ways to lie to its owner, and both of them are
 * the kind that looks fine in a screenshot:
 *
 *   1. Answering a failed read with an empty list. The screen renders "Nothing
 *      archived yet", which the owner reads as "my stories are gone". The
 *      server returns an error rather than `[]` precisely so this cannot
 *      happen; the client throwing that distinction away would waste it.
 *   2. Answering a closed recovery window like any other error. "Try again"
 *      for something that will never succeed, on a story the purge is already
 *      taking.
 *
 * Everything here is one of those two, or the date labels, which must come from
 * the server's numbers and never from a constant in this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStoryArchive,
  getRecoverableStories,
  recoverStory,
  repostStory,
  archiveRowRetentionLabel,
  recoveryRowLabel,
  _setStoryArchiveDeps,
  type StoryRetentionDates,
} from '../storyArchive.ts';

const DAY = 86_400_000;

function withHttp(impl: (url: string, init?: any) => Promise<any>, token: string | null = 'tok') {
  _setStoryArchiveDeps({ token: async () => token, fetchImpl: impl as any });
}

function json(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function dates(over: Partial<StoryRetentionDates> = {}): StoryRetentionDates {
  return {
    audienceEndedAt: null,
    engagementPurgeAt: null,
    purgeAt: null,
    recoverableUntil: null,
    recoverable: false,
    purgeImminent: false,
    ...over,
  };
}

// ── a failed read is not an empty archive ────────────────────────────────────

test('a 500 is reported as a failure, not as an empty archive', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => json(500, { message: 'statement timeout' }));

  const res = await getStoryArchive();
  assert.equal(res.ok, false);
  assert.ok(!('stories' in res), 'a failed read must not produce a list at all');
});

test('a thrown fetch is reported as a failure, not as an empty archive', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => { throw new TypeError('Network request failed'); });

  const res = await getRecoverableStories();
  assert.equal(res.ok, false);
});

test('a 200 whose body is not a list is a failure, not an empty archive', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  // A proxy, a redirect to a login page, a shape change: all produce a 200 the
  // client cannot read. Rendering that as "Nothing archived yet" is the same
  // lie as rendering a 500 that way.
  withHttp(async () => json(200, { stories: null }));

  const res = await getStoryArchive();
  assert.equal(res.ok, false);
});

test('an empty list IS an empty archive', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => json(200, { stories: [] }));

  const res = await getStoryArchive();
  assert.equal(res.ok, true);
  assert.deepEqual(res.ok ? res.stories : null, []);
});

test('the two tabs read two different endpoints', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  const seen: string[] = [];
  withHttp(async (url: string) => { seen.push(url); return json(200, { stories: [] }); });

  await getStoryArchive();
  await getRecoverableStories();
  assert.ok(seen[0].includes('/api/stories/archive?'), seen[0]);
  assert.ok(seen[1].includes('/api/stories/archive/deleted?'), seen[1]);
});

test('no token means no request and an explicit failure', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  let called = 0;
  withHttp(async () => { called += 1; return json(200, { stories: [] }); }, null);

  const res = await getStoryArchive();
  assert.equal(res.ok, false);
  assert.equal(called, 0);
});

// ── a closed window is not a retryable error ─────────────────────────────────

test('410 is reported as a closed window, distinctly from any other failure', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => json(410, { error: 'recovery_window_closed', message: 'too late' }));

  const res = await recoverStory('s1');
  assert.equal(res.ok, false);
  assert.equal(res.ok === false ? res.windowClosed : null, true);
});

test('a 500 on recovery is NOT reported as a closed window', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  // The difference decides whether the screen offers "try again" or tells the
  // owner the story is gone. Collapsing them would do one of those wrongly.
  withHttp(async () => json(500, { message: 'db error' }));

  const res = await recoverStory('s1');
  assert.equal(res.ok, false);
  assert.equal(res.ok === false ? res.windowClosed : null, false);
});

test('a recovery that restores into the next purge says so', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => json(200, {
    id: 's1', state: 'expired', retention: dates(), purgeImminent: true,
  }));

  const res = await recoverStory('s1');
  assert.equal(res.ok, true);
  assert.equal(res.ok ? res.purgeImminent : null, true);
});

test('a missing purgeImminent is read as false, not as undefined', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => json(200, { id: 's1', state: 'expired', retention: dates() }));

  const res = await recoverStory('s1');
  assert.equal(res.ok ? res.purgeImminent : null, false);
});

test('a failed repost is reported rather than swallowed', async (t) => {
  t.after(() => _setStoryArchiveDeps(null));
  withHttp(async () => json(400, { message: "A story in state 'deleted' cannot be reposted." }));

  const res = await repostStory('s1');
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.message : '', /deleted/);
});

// ── the labels say the server's numbers ──────────────────────────────────────

test('the retention label is derived from the date the server sent', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  assert.equal(
    archiveRowRetentionLabel(dates({ purgeAt: new Date(now + 5 * DAY).toISOString() }), now),
    'Deleted in 5 days',
  );
  assert.equal(
    archiveRowRetentionLabel(dates({ purgeAt: new Date(now + 365 * DAY).toISOString() }), now),
    'Deleted in about a year',
  );
  assert.equal(
    archiveRowRetentionLabel(dates({ purgeAt: new Date(now + 90 * DAY).toISOString() }), now),
    'Deleted in about 3 months',
  );
});

test('a story with no purge date gets no label rather than an invented one', () => {
  // A story whose media belongs to a Highlight is not the retention job's to
  // purge. Printing a date for it would promise something this system does not
  // do.
  assert.equal(archiveRowRetentionLabel(dates({ purgeAt: null })), null);
});

test('a purge date already past reads as happening now, not as a negative countdown', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  assert.equal(
    archiveRowRetentionLabel(dates({ purgeAt: new Date(now - 2 * DAY).toISOString() }), now),
    'Being deleted now',
  );
});

test('the recovery label counts to the date the server sent, capped window included', () => {
  const now = Date.parse('2026-09-22T12:00:00.000Z');
  // 5 days, not 30: the server capped this window at the archive deadline, and
  // the row must show the real date rather than the nominal one.
  assert.equal(
    recoveryRowLabel(dates({ recoverableUntil: new Date(now + 5 * DAY).toISOString() }), now),
    'Restore within 5 days',
  );
  assert.equal(
    recoveryRowLabel(dates({ recoverableUntil: new Date(now - 1 * DAY).toISOString() }), now),
    'Being deleted now',
  );
});
