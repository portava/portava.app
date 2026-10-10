/**
 * census-telegraph T233 (§71) on the client — the per-thread sequence cursors the
 * realtime service sends on reconnect. node:test over the pure store; the wiring
 * (header on connect, noted by the thread hook, cleared at sign-out) is held by
 * source assertions.
 *
 * Run: node --import tsx/esm --test src/features/telegraph/__tests__/sequenceCursorStore.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteThreadCursor, cursorHeaderValue, clearThreadCursors, MAX_CURSORS } from '../connection/sequenceCursorStore.ts';

beforeEach(() => clearThreadCursors());

describe('sequence cursor store', () => {
  it('keeps the highest sequence per thread, never moves backwards, and sends nothing when empty', () => {
    assert.equal(cursorHeaderValue(), null);
    noteThreadCursor('t1', 4); noteThreadCursor('t1', 2); noteThreadCursor('t2', 9); noteThreadCursor('t1', null);
    assert.equal(cursorHeaderValue(), 't1:4,t2:9');
  });
  it('keeps the most recent 50 threads', () => {
    for (let i = 0; i < MAX_CURSORS + 10; i++) noteThreadCursor(`t${i}`, i);
    const v = cursorHeaderValue()!.split(',');
    assert.equal(v.length, MAX_CURSORS);
    assert.equal(v[0], 't10:10');
  });
  it('clears', () => { noteThreadCursor('t', 1); clearThreadCursors(); assert.equal(cursorHeaderValue(), null); });
});

describe('wiring (source assertions)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const rt = readFileSync(join(root, 'src/services/telegraphRealtimeService.ts'), 'utf8');
  const hook = readFileSync(join(root, 'src/hooks/useMessaging.ts'), 'utf8');
  const session = readFileSync(join(root, 'src/context/SessionContext.tsx'), 'utf8');
  it('the stream connect sends the header (never in the URL)', () => {
    assert.match(rt, /const seqCursors = cursorHeaderValue\(\); if \(seqCursors\) xhr\.setRequestHeader\('X-Telegraph-Sequence-Cursors', seqCursors\);/);
    assert.doesNotMatch(rt, /stream\?[^`']*cursors/);
  });
  it('the thread hook notes its cursor; sign-out clears them', () => {
    assert.match(hook, /noteThreadCursor\(threadId, cursorOf\(messages\)\)/);
    assert.match(session, /clearThreadCursors\(\);/);
    assert.match(session, /onAuthChange\(\(uid\) => \{ if \(lastUid !== undefined && uid !== lastUid\) clearThreadCursors\(\);/, 'an external sign-out / account switch clears them too');
  });
});
