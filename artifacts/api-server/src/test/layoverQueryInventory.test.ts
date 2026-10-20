import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { generateLayoverQueryInventory,generateLayoverRouteInventory } from './helpers/layoverQueryInventory.js';
it('generated Layover query and authorization inventory is current, explicit, and has no unresolved sites',()=>{
 const generated=generateLayoverQueryInventory();
 assert.deepEqual(generated.unresolved,[]);
 assert.deepEqual(generated.routes.filter(r=>r.authorization.length===0),[],'every route needs an initial authorization guard; machine producer has its explicit credential guard');
 assert.deepEqual(JSON.parse(readFileSync(new URL('../../../../docs/ops/layover-query-inventory.json',import.meta.url),'utf8')),generated,'Run node --import tsx/esm src/scripts/generateLayoverQueryInventory.ts after reviewing changed query/authorization sites.');
});
it('authorization extraction rejects an absent refusal branch and a write before authentication',()=>{
 const root=mkdtempSync(join(tmpdir(),'layover-auth-inventory-'));try{
  mkdirSync(join(root,'routes'));writeFileSync(join(root,'routes/airport.ts'),`
  async function owned(req,res){const auth=await requireUser(req,res);if(!auth)return null;return auth;}
  router.post('/good',async(req,res)=>{const ctx=await owned(req,res);if(!ctx)return;await write(ctx);});
  router.post('/missing-refusal',async(req,res)=>{const auth=await requireUser(req,res);await write(auth);});
  router.post('/too-late',async(req,res)=>{await write(req.body);const auth=await requireUser(req,res);if(!auth)return;});
  function guardedFactory(kind){return asyncHandler(async(req,res)=>{const auth=await requireUser(req,res);if(!auth)return;await write(kind);});}
  function unsafeFactory(kind){return asyncHandler(async(req,res)=>{await write(kind);const auth=await requireUser(req,res);if(!auth)return;});}
  function sideEffectFactory(kind){write(kind);return asyncHandler(async(req,res)=>{const auth=await requireUser(req,res);if(!auth)return;});}
  router.post('/guarded-factory',guardedFactory('select'));
  router.post('/unsafe-factory',unsafeFactory('start'));
  router.post('/side-effect-factory',sideEffectFactory('start'));
  `);
  const routes=generateLayoverRouteInventory(root);assert.equal(routes.length,6);
  assert.deepEqual(routes.find(r=>r.path==='/good')?.authorization,['owned','requireUser']);
  assert.deepEqual(routes.find(r=>r.path==='/guarded-factory')?.authorization,['requireUser']);
  assert.deepEqual(routes.filter(r=>r.authorization.length===0).map(r=>r.path).sort(),['/missing-refusal','/side-effect-factory','/too-late','/unsafe-factory']);
 }finally{rmSync(root,{recursive:true,force:true});}
});
