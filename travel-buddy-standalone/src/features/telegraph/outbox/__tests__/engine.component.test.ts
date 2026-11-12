import { MessageOutbox } from '../engine.ts';
import type { OutboxEntry, OutboxStorage } from '../types.ts';
const owner = { ownerId: 'alice', sessionId: 'session-a', isCurrent: () => true };
const input = { clientId: 'retry-id', threadId: 'thread', display: { body: 'Private message', msgType: 'text', subtype: null, replyToId: 'reply', isE2ee: true } };
function fixture() {
  const rows = new Map<string, OutboxEntry>();
  const key = (e: { ownerId: string; sessionId: string }, id: string) => `${e.ownerId}/${e.sessionId}/${id}`;
  const storage: OutboxStorage = {
    read: async (scope) => [...rows.values()].filter((e) => e.ownerId === scope.ownerId && e.sessionId === scope.sessionId).map((e) => structuredClone(e)),
    put: async (entry, onlyIfPresent) => { if (onlyIfPresent && !rows.has(key(entry, entry.clientId))) throw new Error('removed'); rows.set(key(entry, entry.clientId), structuredClone(entry)); },
    remove: async (scope, id) => { rows.delete(key(scope, id)); },
    clearOwner: async (id) => { for (const [key, value] of rows) if (value.ownerId === id) rows.delete(key); },
  };
  let now = 100_000;
  return { storage, rows, now: () => now, advance: () => { now += 600_000; } };
}
const prepare = () => Promise.resolve({ ciphertext: 'the-exact-ciphertext', clientId: 'retry-id', idempotencyKey: 'retry-id', replyToId: 'reply' });
const offline = { ok: false, data: null, errorKind: 'network_unreachable', retryable: true };
it('persists before network dispatch and replays exact ciphertext/reply/idempotency after restart', async () => {
  const f = fixture(); const encrypt = jest.fn(prepare);
  const first = new MessageOutbox(f.storage, f.now);
  const send = jest.fn(async (entry: OutboxEntry) => { expect(f.rows.size).toBe(1); expect(entry.payload).not.toHaveProperty('body'); return offline; });
  await first.submit(owner, input, encrypt, send);
  const restarted = new MessageOutbox(f.storage, f.now);
  expect((await restarted.pending(owner))[0].display.body).toBe('Private message');
  f.advance();
  const retry = jest.fn(async (_entry: OutboxEntry) => ({ ok: true, data: { id: 'accepted' } }));
  await restarted.submit(owner, input, encrypt, retry);
  expect(encrypt).toHaveBeenCalledTimes(1);
  expect(retry.mock.calls[0][0].payload).toEqual(send.mock.calls[0][0].payload);
  expect(f.rows.size).toBe(0);
});
it('does not transmit if durable secure storage fails', async () => {
  const f = fixture(); f.storage.put = async () => { throw new Error('Keychain locked'); };
  const send = jest.fn();
  const result = await new MessageOutbox(f.storage).submit(owner, input, prepare, send);
  expect(result.ok).toBe(false); expect(result.retryable).toBe(false); expect(send).not.toHaveBeenCalled();
});
it('coalesces double taps into one encryption and one network send', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage); const encrypt = jest.fn(prepare);
  const send = jest.fn(async () => ({ ok: true, data: { id: 'server' } }));
  const a = engine.submit(owner, input, encrypt, send); const b = engine.submit(owner, input, encrypt, send);
  expect(a).toBe(b); await a; expect(send).toHaveBeenCalledTimes(1); expect(encrypt).toHaveBeenCalledTimes(1);
});
it('rejects a changed body, reply, or thread under an existing idempotency key', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  await engine.submit(owner, input, prepare, async () => offline); f.advance();
  const send = jest.fn();
  const result = await engine.submit(owner, { ...input, display: { ...input.display, replyToId: 'other' } }, prepare, send);
  expect(result.errorKind).toBe('invalid_payload'); expect(send).not.toHaveBeenCalled();
});
it('does not replay another account or a replacement session', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  await engine.submit(owner, input, prepare, async () => offline); f.advance();
  const send = jest.fn();
  await engine.replay({ ...owner, ownerId: 'bob' }, send);
  await engine.replay({ ...owner, sessionId: 'replacement' }, send);
  expect(send).not.toHaveBeenCalled();
});
it('honors Retry-After and never automatically retries a permission refusal', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  await engine.submit(owner, input, prepare, async () => ({ ...offline, errorKind: 'rate_limited', retryAfterSeconds: 120 }));
  const send = jest.fn(async () => ({ ok: false, data: null, errorKind: 'forbidden', retryable: false }));
  await engine.replay(owner, send); expect(send).not.toHaveBeenCalled();
  f.advance(); await engine.replay(owner, send); expect(send).toHaveBeenCalledTimes(1);
  f.advance(); await engine.replay(owner, send); expect(send).toHaveBeenCalledTimes(1);
  expect((await engine.pending(owner))[0].state).toBe('blocked');
});
it('a logout during a network request cannot recreate erased pending data', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  let finish!: (r: any) => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const work = engine.submit(owner, input, prepare, () => { started(); return new Promise((resolve) => { finish = resolve; }); });
  await entered; await engine.clearOwner('alice'); finish(offline);
  expect((await work).errorKind).toBe('unauthenticated'); expect(f.rows.size).toBe(0);
});
it('a successful send remains acknowledged when local cleanup fails', async () => {
  const f = fixture(); f.storage.remove = async () => { throw new Error('busy'); };
  const engine = new MessageOutbox(f.storage, f.now); const send = jest.fn(async () => ({ ok: true, data: { id: 'server' } }));
  await engine.submit(owner, input, prepare, send);
  const restarted = new MessageOutbox(f.storage, f.now);
  await restarted.submit(owner, input, prepare, send);
  expect(send).toHaveBeenCalledTimes(1); expect(await restarted.pending(owner)).toEqual([]);
});
it('invalidates in-flight writes synchronously even when logout erase fails', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  let finish!: (r: any) => void; let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const work = engine.submit(owner, input, prepare, () => { started(); return new Promise((resolve) => { finish = resolve; }); });
  await entered;
  f.storage.clearOwner = async () => { throw new Error('device locked'); };
  await expect(engine.clearOwner('alice')).rejects.toThrow('device locked');
  finish({ ok: true, data: { id: 'late' } });
  expect((await work).errorKind).toBe('unauthenticated');
  expect([...f.rows.values()][0].state).toBe('queued');
});

it('cancels transport and never restores the draft after a late response', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  let finish!: (value: typeof offline) => void; let signal!: AbortSignal;
  const work = engine.submit(owner, input, prepare, (_entry, requestSignal) => { signal = requestSignal; return new Promise((resolve) => { finish = resolve; }); });
  for (let i = 0; i < 40 && !finish; i++) await Promise.resolve();
  await engine.cancel(owner, input.clientId); expect(signal.aborted).toBe(true); finish(offline); await work;
  expect(f.rows.size).toBe(0); expect(await new MessageOutbox(f.storage).pending(owner)).toEqual([]);
});
it('does not dispatch an entry cancelled while a prior replay was in flight', async () => {
  const f = fixture(); const engine = new MessageOutbox(f.storage, f.now);
  await engine.submit(owner, input, prepare, async () => offline);
  await engine.submit(owner, { ...input, clientId: 'second' }, prepare, async () => offline); f.advance();
  let release!: (value: { ok: boolean; data: { id: string } }) => void;
  const send = jest.fn(() => new Promise<{ ok: boolean; data: { id: string } }>((resolve) => { release = resolve; }));
  const work = engine.replay(owner, send);
  for (let i = 0; i < 40 && !release; i++) await Promise.resolve();
  await engine.cancel(owner, 'second'); release({ ok: true, data: { id: 'first-server' } });
  await work; expect(send).toHaveBeenCalledTimes(1); expect(f.rows.size).toBe(0);
});
