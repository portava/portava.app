import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInputDeadline } from '../lib/inputAssistance/requestDeadline.js';
test('bounds stalled input reads and signals model cancellation', async () => {
  let signal!: AbortSignal;
  await assert.rejects(withInputDeadline((s) => { signal=s; return new Promise(() => {}); }, 15), { name: 'TimeoutError' });
  assert.equal(signal.aborted, true);
});
test('a disconnected request never starts new work', async () => {
  const controller = new AbortController(); controller.abort(); let called=false;
  await assert.rejects(withInputDeadline(async () => { called=true; }, 100, controller.signal), { name: 'AbortError' });
  assert.equal(called, false);
});
test('late answers cannot revive a timed out request', async () => {
  let resolve!: (value: string) => void;
  const result=withInputDeadline(() => new Promise<string>((r) => { resolve=r; }), 15);
  await assert.rejects(result, { name: 'TimeoutError' }); resolve('late');
  await assert.rejects(result, { name: 'TimeoutError' });
});
test('returns successful answers and isolates consecutive calls', async () => {
  assert.equal(await withInputDeadline(async () => 'first'), 'first');
  assert.equal(await withInputDeadline(async () => 'second'), 'second');
});
