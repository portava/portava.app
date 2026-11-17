import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {requireDerivativeErasure} from '../lib/media/derivativeErasure.js';

const source={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',version:3,storage_bucket:'post-media',storage_path:'owner/source.jpg'};
const authorized={data:{ok:true,bucket:'post-media',generation:null,paths:['owner/source.jpg']},error:null};

describe('permanent derivative erasure deployment proof',()=>{
  for(const [name,reply] of Object.entries({missing:{data:null,error:{code:'42883'}},disabled:{data:false,error:null},
    unreadable:{data:null,error:{code:'42501'}},malformed:{data:'true',error:null},absentError:{data:true},undefinedError:{data:true,error:undefined}})) {
    it(`${name} refuses before requesting a purge manifest`,async()=>{
      const calls:string[]=[];
      const sc={rpc:async(fn:string)=>{calls.push(fn);return reply;}} as unknown as SupabaseClient;
      await assert.rejects(requireDerivativeErasure(sc,source),/authority unavailable/);
      assert.deepEqual(calls,['postcard_canonical_lifecycle_ready']);
    });
  }
  it('readiness does not replace the exact permanent-erasure authorization',async()=>{
    for(const receipt of [{data:{ok:false},error:null},{...authorized,error:undefined},{data:{...authorized.data,paths:['different/path.jpg']},error:null}]){
      const calls:string[]=[];
      const sc={rpc:async(fn:string)=>{calls.push(fn);return fn==='postcard_canonical_lifecycle_ready'?{data:true,error:null}:receipt;}} as unknown as SupabaseClient;
      await assert.rejects(requireDerivativeErasure(sc,source),/authority unavailable/);
      assert.deepEqual(calls,['postcard_canonical_lifecycle_ready','advance_media_object_purge']);
    }
  });
  it('a ready schema and exact authorization yield the existing manifest without a second command',async()=>{
    const calls:Array<{fn:string;args:unknown}>=[];
    const sc={rpc:async(fn:string,args?:unknown)=>{calls.push({fn,args});return fn==='postcard_canonical_lifecycle_ready'?{data:true,error:null}:authorized;}} as unknown as SupabaseClient;
    assert.deepEqual(await requireDerivativeErasure(sc,source),[source.storage_path]);
    assert.deepEqual(calls,[{fn:'postcard_canonical_lifecycle_ready',args:undefined},{fn:'advance_media_object_purge',args:{p_asset:source.id,p_version:source.version,p_phase:'manifest'}}]);
  });
});
