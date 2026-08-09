/**
 * feedAttribution tests — node:test + node:assert only.
 * Run: node --import tsx/esm --test src/lib/feedAttribution.test.ts
 *
 * The absence cases matter as much as the presence ones. A session that is
 * serialised when it should not be — "undefined", "", or one inherited from an
 * unrelated feed — produces an outcome row that looks correctly attributed and
 * is not. That is worse than no attribution at all, and nothing in the UI would
 * ever reveal it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eventHref, readFeedSession, FEED_SESSION_PARAM } from './feedAttribution.ts';

describe('feedAttribution', () => {
  describe('eventHref', () => {
    it('attaches the session when there is one', () => {
      assert.equal(
        eventHref('evt-1', 'sess-abc'),
        '/event/evt-1?sessionId=sess-abc',
      );
    });

    it('omits the param entirely when the session is undefined', () => {
      // Not "?sessionId=undefined" — that reads back as a truthy string and
      // would be reported as a real session.
      assert.equal(eventHref('evt-1', undefined), '/event/evt-1');
    });

    it('omits the param when the session is null', () => {
      assert.equal(eventHref('evt-1', null), '/event/evt-1');
    });

    it('omits the param when the session is an empty string', () => {
      assert.equal(eventHref('evt-1', ''), '/event/evt-1');
    });

    it('omits the param when the session is absent altogether', () => {
      assert.equal(eventHref('evt-1'), '/event/evt-1');
    });

    it('percent-encodes the session so it cannot break the query string', () => {
      assert.equal(
        eventHref('evt-1', 'a b&c=d'),
        '/event/evt-1?sessionId=a%20b%26c%3Dd',
      );
    });

    it('uses the shared param name rather than a hardcoded literal', () => {
      assert.ok(eventHref('e', 's').includes(`${FEED_SESSION_PARAM}=`));
    });
  });

  describe('readFeedSession', () => {
    it('returns the value for a plain string', () => {
      assert.equal(readFeedSession('sess-abc'), 'sess-abc');
    });

    it('takes the first entry when the router hands back an array', () => {
      // A repeated query key arrives as string[] from expo-router.
      assert.equal(readFeedSession(['sess-abc', 'sess-def']), 'sess-abc');
    });

    it('returns null for undefined — the deep-link / notification case', () => {
      assert.equal(readFeedSession(undefined), null);
    });

    it('returns null for an empty string rather than reporting an empty session', () => {
      assert.equal(readFeedSession(''), null);
    });

    it('returns null for an empty array', () => {
      assert.equal(readFeedSession([]), null);
    });

    it('round-trips a session through eventHref and back', () => {
      const href = eventHref('evt-1', 'sess-abc');
      const query = href.split('?')[1] ?? '';
      const raw = new URLSearchParams(query).get(FEED_SESSION_PARAM) ?? undefined;
      assert.equal(readFeedSession(raw), 'sess-abc');
    });
  });
});
