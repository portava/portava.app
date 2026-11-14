import assert from 'node:assert/strict';
import { test } from 'node:test';
import { persistMediaEventBatch } from '../lib/mediaAnalytics.js';

const events = [{ type: 'place_open' as const, payload: { viewer_id: 'viewer-1', media_id: 'post-1' } },
  { type: 'trip_open' as const, payload: { viewer_id: 'viewer-1', trip_id: 'trip-1' } }];
function client(options: { flag?: unknown; flagError?: boolean; receipt?: unknown; error?: boolean; deferred?: Promise<unknown> } = {}) {
  const writes: unknown[] = [];
  return { writes, from(table: string) {
    const b = { select() { return b; }, eq() { return b; },
      maybeSingle: async () => ({ data: { enabled: options.flag ?? true }, error: options.flagError ? {} : null }),
      insert(rows: unknown) { assert.equal(table,'media_events'); writes.push(rows); return b; },
      then(resolve: any, reject: any) {
        return (options.deferred ?? Promise.resolve({ data: 'receipt' in options ? options.receipt : [{id:'a'},{id:'b'}], error: options.error ? {} : null })).then(resolve,reject);
      },
    }; return b;
  } };
}
test('receipt waits for persistence and counts only returned rows after trigger suppression', async () => {
  let done!: (value: unknown) => void;
  const sc=client({deferred:new Promise(resolve=>{done=resolve;})});
  let settled=false;
  const response=persistMediaEventBatch(events,sc).then(value=>{settled=true;return value;});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(settled,false);
  done({data:[{id:'surviving-row'}],error:null});
  assert.deepEqual(await response,{accepted:1,discarded:1,failed:0,disabled:false});
});
test('all suppressed rows are explicitly discarded, disabled policy is not persistence', async () => {
  assert.deepEqual(await persistMediaEventBatch(events,client({receipt:[]})),{accepted:0,discarded:2,failed:0,disabled:false});
  const sc=client({flag:false});
  assert.deepEqual(await persistMediaEventBatch(events,sc),{accepted:0,discarded:2,failed:0,disabled:true});
  assert.equal(sc.writes.length,0);
});
test('flag failures, write failures, missing or malformed receipts never claim acceptance', async () => {
  for(const options of [{flagError:true},{error:true},{receipt:null},{receipt:{}},{receipt:[{}]},
    {receipt:[{id:'a'},{id:'a'}]},{receipt:[{id:'a'},{id:'b'},{id:'c'}]}]) {
    assert.deepEqual(await persistMediaEventBatch(events,client(options)),{accepted:0,discarded:0,failed:2,disabled:false});
  }
});
