import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readCanonicalPlaceVisibility,readCanonicalPlaceGroup} from '../lib/places/placeGovernance.js';
import {makeFakeClient} from './telegraphCertificationHarness.js';
const row=(id:string,parent:string|null=null,status='visible')=>({id,name:id,moderation_status:status,merged_into_place_id:parent});
function client(places:any[],refs:any[]=[],options:any={}){return makeFakeClient({places,external_place_references:refs},options);}
test('visibility distinguishes missing and withheld IDs from curated-only IDs',async()=>{
 const result=await readCanonicalPlaceVisibility(client([row('visible'),row('held',null,'withheld')]),['visible','held','absent']);
 assert.ok(result.ok);assert.deepEqual([...result.visibleIds],['visible']);assert.deepEqual([...result.existingIds],['visible','held']);
});
test('a withheld ancestor cannot be bypassed with any old alias',async()=>{
 const result=await readCanonicalPlaceVisibility(client([row('a','b'),row('b','c'),row('c',null,'withheld')]),['a','b','c']);
 assert.ok(result.ok);assert.equal(result.visibleIds.size,0);
});
test('cycles, missing ancestors and malformed current state never become visible',async()=>{
 assert.deepEqual(await readCanonicalPlaceVisibility(client([row('a','b'),row('b','a')]),['a']),{ok:false,reason:'invalid_merge_graph'});
 const absent=await readCanonicalPlaceVisibility(client([row('a','absent')]),['a']);assert.ok(absent.ok);assert.equal(absent.visibleIds.size,0);
 assert.deepEqual(await readCanonicalPlaceVisibility(client([{...row('a'),moderation_status:undefined}]),['a']),{ok:false,reason:'unreadable'});
});
test('database errors and truncated successful reads refuse the whole result',async()=>{
 assert.deepEqual(await readCanonicalPlaceVisibility(client([row('a')],[],{errors:{places:{message:'offline'}}}),['a']),{ok:false,reason:'unreadable'});
 assert.deepEqual(await readCanonicalPlaceVisibility(client([row('a'),row('b')],[],{maxRows:1}),['a','b']),{ok:false,reason:'unreadable'});
});
test('canonical group follows multiple merge hops and includes only visible descendant references',async()=>{
 const places=[row('a','b'),row('b','c'),row('c'),row('held','c','withheld'),row('hidden-child','held')];
 const refs=places.map(p=>({id:'ref-'+p.id,place_id:p.id,provider:'synthetic'}));
 const result=await readCanonicalPlaceGroup(client(places,refs),'a');assert.ok(result.ok);assert.equal(result.place.id,'c');
 assert.deepEqual(result.refs.map(x=>x.place_id).sort(),['a','b','c']);
});
test('provider reference failures and row caps never return a partial group',async()=>{
 const places=[row('a')], refs=[{id:'r1',place_id:'a'},{id:'r2',place_id:'a'}];
 assert.deepEqual(await readCanonicalPlaceGroup(client(places,refs,{errors:{external_place_references:{message:'offline'}}}),'a'),{ok:false,reason:'unreadable'});
 assert.deepEqual(await readCanonicalPlaceGroup(client(places,refs,{maxRows:1}),'a'),{ok:false,reason:'unreadable'});
});
test('a complete large provider group walks real pages',async()=>{
 const refs=Array.from({length:1100},(_,i)=>({id:String(i).padStart(5,'0'),place_id:'a'}));
 const result=await readCanonicalPlaceGroup(client([row('a')],refs),'a');assert.ok(result.ok);assert.equal(result.refs.length,1100);
});
test('withholding during a group read is rechecked before the result leaves',async()=>{
 const result=await readCanonicalPlaceGroup(client([row('a')],[{id:'r',place_id:'a'}],{onRead(table:string,store:any){if(table==='external_place_references')store.places[0].moderation_status='withheld';}}),'a');
 assert.deepEqual(result,{ok:false,reason:'not_found'});
});
