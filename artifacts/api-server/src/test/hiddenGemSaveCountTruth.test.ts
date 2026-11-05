/** Migration 4012 now commits exact counts and collection membership with the
 * bookmark. The real database contract is in gemCollections.pglite.test.ts;
 * these tests pin the service boundary and prevent a second count increment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFailClosedClient } from './helpers/failClosedSupabase.js';
import { saveGem, unsaveGem } from '../services/hiddenGems/HiddenGemService.js';
const USER='10000000-0000-4000-a000-000000000001';
const GEM='20000000-0000-4000-a000-000000000003';
test('new save commits once and never increments an already transactional counter again', async () => {
  const inserted: Record<string,any[]> = {}; const updated: Record<string,any[]> = {};
  const db = makeFailClosedClient({ rows:{ hidden_gem_saves:[] }, inserted, updated });
  assert.deepEqual(await saveGem(db,GEM,USER),{alreadySaved:false,saveCountIncremented:true});
  assert.equal(inserted.hidden_gem_saves?.length,1);
  assert.equal(updated.hidden_gems?.length ?? 0,0);
});
test('repeat saves do not write or count again', async () => {
  const inserted: Record<string,any[]> = {};
  const db = makeFailClosedClient({ rows:{hidden_gem_saves:[{user_id:USER,gem_id:GEM}]},inserted });
  assert.deepEqual(await saveGem(db,GEM,USER),{alreadySaved:true,saveCountIncremented:false});
  assert.equal(inserted.hidden_gem_saves?.length ?? 0,0);
});
test('unknown prior state is a failure, and a failed bridge never claims a durable save', async () => {
  const unread=makeFailClosedClient({failOn:c=>c.table==='hidden_gem_saves'?{message:'unreadable'}:null});
  await assert.rejects(saveGem(unread,GEM,USER));
  const failed=makeFailClosedClient({rows:{hidden_gem_saves:[]},failWritesOn:t=>t==='hidden_gem_saves'?{message:'bridge rollback'}:null});
  await assert.rejects(saveGem(failed,GEM,USER));
});
test('unsave propagates failure from the atomic all-collections bridge', async () => {
  const db=makeFailClosedClient({rows:{hidden_gem_saves:[{user_id:USER,gem_id:GEM}]},failWritesOn:t=>t==='hidden_gem_saves'?{message:'bridge rollback'}:null});
  await assert.rejects(unsaveGem(db,GEM,USER));
});
