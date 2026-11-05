import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import router from '../routes/sensingRevocation.js';
import { _setTestServiceClient } from '../lib/supabase.js';
import { deriveEpochSecret, rotationEpochFor, revocationCommitment, deriveContributorToken } from '../lib/sensingAnonStore.js';

let prior: string | undefined;
beforeEach(() => { prior=process.env.SENSING_CONTRIBUTOR_PEPPER; process.env.SENSING_CONTRIBUTOR_PEPPER='p'.repeat(40); });
afterEach(() => { if(prior===undefined) delete process.env.SENSING_CONTRIBUTOR_PEPPER; else process.env.SENSING_CONTRIBUTOR_PEPPER=prior; _setTestServiceClient(null); });
const epoch=()=>rotationEpochFor(Date.now());
const proof=()=>({rotationEpoch:epoch(),epochSecret:deriveEpochSecret('local-device-only',epoch())});
function client(result: unknown=true, failure=false) {
  const calls: any[]=[];
  const value={from:()=>{throw new Error('No identity, policy flag, or contributor rows may be read');},rpc:(name:string,args:any)=>({abortSignal:async()=>{
    calls.push({name,args}); return {data:result,error:failure?{message:'database failed'}:null};
  }})};
  _setTestServiceClient(value as any); return calls;
}
async function post(body: unknown, credential?: string) {
  const app=express(); app.use(express.json()); app.use('/api',router);
  const server=createServer(app); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address==='object');
  try {
    const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/sensing/revoke`,{method:'POST',headers:{'content-type':'application/json',...(credential?{'x-sensing-credential':credential}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.text(),cache:response.headers.get('cache-control')};
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
}
test('preimage deletion works without an account or flag; no secret crosses the SQL boundary',async()=>{
  const calls=client(); const value=proof(); const credential='opaque-current-session-credential';
  const response=await post({epochs:[value]},credential);
  assert.deepEqual(response,{status:204,body:'',cache:'no-store'});
  assert.equal(calls[0].name,'sensing_revoke_recent');
  assert.equal(calls[0].args.p_epochs[0].contributorToken,deriveContributorToken(value.rotationEpoch,revocationCommitment(value.epochSecret)));
  assert.equal(JSON.stringify(calls).includes(value.epochSecret),false); assert.equal(JSON.stringify(calls).includes(credential),false);
});
test('no existing session is needed to delete recent proof-owned contributions',async()=>{
  const calls=client(); assert.equal((await post({epochs:[proof()]})).status,204); assert.equal(calls[0].args.p_credential_hash,null);
});
test('repeated completed erasure returns no count or existence oracle',async()=>{
  const calls=client(); const body={epochs:[proof()]};
  assert.deepEqual(await post(body),await post(body)); assert.equal(calls.length,2);
});
test('unconfirmed or failed deletion is never a successful empty result',async()=>{
  for(const [result,error] of [[null,false],[false,false],[true,true]] as const) {
    client(result,error); assert.equal((await post({epochs:[proof()]})).status,500);
  }
});
test('malformed, identifying, oversized, ancient and future proofs are refused without SQL',async()=>{
  const cases=[{epochs:[{...proof(),actorId:'not-accepted'}]}, {epochs:[{...proof(),epochSecret:'short'}]},
    {epochs:Array.from({length:75},proof)}, {epochs:[{...proof(),rotationEpoch:epoch()-74}]},
    {epochs:[{...proof(),rotationEpoch:epoch()+1}]}, {epochs:[proof()],accountId:'not-accepted'}];
  for(const body of cases) { const calls=client(); assert.equal((await post(body)).status,400); assert.equal(calls.length,0); }
});
test('missing dedicated pepper refuses erasure instead of deriving different tokens',async()=>{
  const calls=client(); delete process.env.SENSING_CONTRIBUTOR_PEPPER;
  assert.equal((await post({epochs:[proof()]})).status,503); assert.equal(calls.length,0);
});
