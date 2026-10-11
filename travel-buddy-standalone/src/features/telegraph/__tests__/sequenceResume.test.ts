/**
 * Telegraph §17.2 on the client — reconnect resumes from the last acknowledged
 * sequence (census-telegraph T233) and resend reuses its id (T231).
 *
 * A node:test file on purpose (the pattern of `sendFailure.test.ts`): the loop is
 * a pure function, and the chat screens cannot be mounted under jest-expo, so the
 * hook's wiring is held by source assertions. WHAT THIS DOES NOT SHOW: a resume
 * on a device.
 *
 * Run: node --import tsx/esm --test src/features/telegraph/__tests__/sequenceResume.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cursorOf, mergeResumed, resumeFromCursor, RESUME_MAX_PAGES, type ResumePage } from '../connection/sequenceResume.ts';

type M = { id: string; sequence?: number | null; body?: string };
const m = (id: string, sequence?: number | null, body = id): M => ({ id, sequence, body });

/** A server holding messages 1..total, paging `page` at a time. */
function server(total: number, page: number) {
  const calls: number[] = [];
  const fetchPage = async (after: number): Promise<ResumePage<M>> => {
    calls.push(after);
    const rows = Array.from({ length: total }, (_, i) => m(`s${i + 1}`, i + 1)).filter((r) => r.sequence! > after);
    const out = rows.slice(0, page);
    return { ok: true, messages: out, resume: { nextSequence: out.length ? out[out.length - 1]!.sequence! : after, hasMore: rows.length > page } };
  };
  return { calls, fetchPage };
}

describe('the cursor', () => {
  it('is the highest sequence held, and null when nothing carries one (capability off)', () => {
    assert.equal(cursorOf([m('a', 3), m('b', 7), m('c', null), m('d')]), 7);
    assert.equal(cursorOf([m('a'), m('b', null)]), null);
    assert.equal(cursorOf([]), null);
  });
});

describe('resumeFromCursor', () => {
  it('RECONNECT GAP: pages from the cursor until hasMore is false — nothing lost, nothing repeated', async () => {
    const s = server(57, 20);
    const r = await resumeFromCursor<M>(5, s.fetchPage);
    assert.equal(r.kind, 'resumed');
    assert.deepEqual(r.messages.map((x) => x.sequence), Array.from({ length: 52 }, (_, i) => i + 6));
    assert.deepEqual(s.calls, [5, 25, 45]);
    assert.equal(r.cursor, 57);
  });

  it('no cursor ⇒ no request at all (the pre-3654 world)', async () => {
    const s = server(5, 20);
    const r = await resumeFromCursor<M>(null, s.fetchPage);
    assert.deepEqual([r.kind, (r as any).reason], ['fallback', 'no_cursor']);
    assert.deepEqual(s.calls, []);
  });

  it('a server that ignores the cursor (no resume block) is reported unsupported, never resumed', async () => {
    const r = await resumeFromCursor<M>(3, async () => ({ ok: true, messages: [m('x', null)], resume: null }));
    assert.deepEqual([r.kind, (r as any).reason], ['fallback', 'unsupported']);
  });

  it('429 is backpressure with the server\'s Retry-After, not a failure', async () => {
    const r = await resumeFromCursor<M>(3, async () => ({ ok: false, status: 429, retryAfterSeconds: 7 }));
    assert.equal(r.kind, 'fallback');
    assert.equal((r as any).reason, 'backpressure');
    assert.equal((r as any).retryAfterSeconds, 7);
  });

  it('a spent page budget is NOT a completed resume', async () => {
    const s = server(1000, 10);
    const r = await resumeFromCursor<M>(0, s.fetchPage);
    assert.deepEqual([r.kind, (r as any).reason], ['fallback', 'budget_spent']);
    assert.equal(s.calls.length, RESUME_MAX_PAGES);
  });

  it('a cursor that does not advance while claiming more stops instead of looping', async () => {
    let n = 0;
    const r = await resumeFromCursor<M>(4, async () => { n++; return { ok: true, messages: [], resume: { nextSequence: 4, hasMore: true } }; });
    assert.equal((r as any).reason, 'failed');
    assert.equal(n, 1);
  });

  it('a failed page keeps what was collected and says failed', async () => {
    let n = 0;
    const r = await resumeFromCursor<M>(0, async () => (n++ === 0
      ? { ok: true, messages: [m('a', 1)], resume: { nextSequence: 1, hasMore: true } }
      : { ok: false, status: 503 }));
    assert.equal((r as any).reason, 'failed');
    assert.deepEqual(r.messages.map((x) => x.id), ['a']);
  });
});

describe('mergeResumed', () => {
  it('appends new ids in sequence order and replaces an id already held — never duplicates', () => {
    const held = [m('a', 1), m('b', 2, 'old')];
    const out = mergeResumed(held, [m('d', 4), m('b', 2, 'new'), m('c', 3)]);
    assert.deepEqual(out.map((x) => `${x.id}:${x.body}`), ['a:a', 'b:new', 'c:c', 'd:d']);
  });
});

describe('wiring (source assertions)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const svc = readFileSync(join(root, 'src/services/messaging.ts'), 'utf8');
  const hook = readFileSync(join(root, 'src/hooks/useMessaging.ts'), 'utf8');
  it('T231: sendMessage sends the clientId as the idempotency key', () => {
    assert.match(svc, /\.\.\.\(rest\.clientId \? \{ idempotencyKey: rest\.clientId \} : \{\}\)/);
  });
  it('T231: retrySend reuses the failed message\'s clientId', () => {
    assert.match(hook, /const res = await sendMessage\(threadId, failed\.body, \{[\s\S]{0,120}clientId,\s*\}\);/);
  });
  it('T233: every ordinary page asks for sequences, and the resume call names afterSequence', () => {
    assert.match(svc, /'\?withSequence=1'/);
    assert.match(svc, /messages\?afterSequence=\$\{encodeURIComponent\(String\(afterSequence\)\)\}/);
  });
  it('T233: the thread hook resumes on stream.resumed and on return to the foreground', () => {
    assert.match(hook, /case 'stream\.resumed':[^\n]*\n\s*void resumeThenPoll\(\);/);
    assert.match(hook, /next === 'active'\) void resumeThenPoll\(\);/);
    assert.match(hook, /resumeFromCursor\(cursorOf\(messagesRef\.current\)/);
  });
});
