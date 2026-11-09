import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { POST_REFERENCE_MEDIA_TYPE, readPostReference, readReferenceSource } from '../services/postDestinations.js';
const viewer='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',author='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const post='cccccccc-cccc-4ccc-8ccc-cccccccccccc',ref='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
let rows:Record<string,any[]>;let failures:Set<string>;let reads:string[];
function client(){return {from(table:string){const filters:Array<(row:any)=>boolean>=[];let max=Infinity;
 const result=()=>{reads.push(table);const matched=(rows[table]??[]).filter(row=>filters.every(f=>f(row)));return {data:matched.slice(0,max),count:matched.length,error:failures.has(table)?{message:'unreadable'}:null};};
 const query:any={select:()=>query,order:()=>query,
 overlaps:(field:string,values:string[])=>{filters.push(row=>Array.isArray(row[field]) && row[field].some((v:string)=>values.includes(v)));return query;},
 eq:(key:string,value:unknown)=>{filters.push(row=>row[key]===value);return query;},in:(key:string,values:unknown[])=>{filters.push(row=>values.includes(row[key]));return query;},limit:(value:number)=>{max=value;return query;},
 or:(expression:string)=>{assert.ok(expression.includes(viewer)||expression.includes(author));return query;},
 maybeSingle:async()=>{const r=result();return {...r,data:r.data[0]??null};},then:(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject)};return query;
 }};}
beforeEach(()=>{failures=new Set();reads=[];rows={
 posts:[{id:post,author_id:author,content:'A shared memory',status:'active',post_status:'published',visibility:'public',deleted_at:null,sharing_disabled:false,reposting_disabled:false}],
 profiles:[{id:author,handle:'traveler',account_status:'active'}],blocks:[],
 post_destination_references:[{id:ref,owner_id:viewer,post_id:post,memory_item_id:'item',highlight_id:null}],
 memory_items:[{id:'item',memory_id:'memory',media_type:POST_REFERENCE_MEDIA_TYPE,media_url:`portava-post-reference:${ref}`,position:0,visibility:null}],
 memories:[{id:'memory',owner_id:viewer,state:'published',visibility:'only_me'}],
};});
describe('Post reference current authorization',()=>{
 it('returns live text for a post without attachments',async()=>{
  assert.deepEqual(await readPostReference(client(),ref,viewer),{available:true,postId:post,author:'@traveler',text:'A shared memory',media:[]});
  rows.posts[0].content='Edited';assert.equal((await readPostReference(client(),ref,viewer) as any).text,'Edited');
 });
 it('checks destination audience before touching the source',async()=>{
  rows.memories[0].owner_id=author;rows.post_destination_references[0].owner_id=author;
  assert.equal(await readPostReference(client(),ref,viewer),null);assert.equal(reads.includes('posts'),false);
 });
 it('denies deleted or moderated destinations even to the owner',async()=>{
  for(const state of ['deleted','removed']){rows.memories[0].state=state;assert.equal(await readPostReference(client(),ref,viewer),null);}
 });
 it('does not allow forged or reparented reference rows',async()=>{
  rows.memory_items[0].media_url='https://example.test/photo.jpg';assert.equal(await readPostReference(client(),ref,viewer),null);
  rows.memory_items[0].media_url=`portava-post-reference:${ref}`;rows.memories[0].owner_id=author;assert.equal(await readPostReference(client(),ref,viewer),null);
 });
 it('withholds the source after deletion, visibility change, or author sharing withdrawal',async()=>{
  for(const [key,value] of [['deleted_at','now'],['status','removed'],['visibility','private'],['post_status','draft'],['sharing_disabled',true],['reposting_disabled',true]] as const){
   const prior=rows.posts[0][key];rows.posts[0][key]=value;assert.deepEqual(await readPostReference(client(),ref,viewer),{available:false});rows.posts[0][key]=prior;
  }
 });
 it('withholds suspended authors and either-way block edges',async()=>{
  rows.profiles[0].account_status='suspended';assert.deepEqual(await readReferenceSource(client(),post,viewer),{available:false});rows.profiles[0].account_status='active';
  for(const [blocker_id,blocked_id] of [[author,viewer],[viewer,author]]){rows.blocks=[{blocker_id,blocked_id}];assert.deepEqual(await readReferenceSource(client(),post,viewer),{available:false});}
 });
 it('treats unreadable gates as failures or withholding, never permission',async()=>{
  failures.add('posts');await assert.rejects(readPostReference(client(),ref,viewer),/source_read_failed/);failures.clear();
  failures.add('blocks');assert.equal(await readPostReference(client(),ref,viewer),null);failures.clear();
  failures.add('profiles');await assert.rejects(readPostReference(client(),ref,viewer),/author_read_failed/);
 });
 it('keeps a hard-deleted source as an unavailable reference rather than a broken image',async()=>{
  rows.post_destination_references[0].post_id=null;assert.deepEqual(await readPostReference(client(),ref,viewer),{available:false});assert.equal(reads.includes('posts'),false);
 });
 it('the author can read their own private source, but another audience cannot',async()=>{
  rows.posts[0].visibility='private';assert.equal((await readReferenceSource(client(),post,author)).available,true);assert.equal((await readReferenceSource(client(),post,viewer)).available,false);
 });
 it('uses canonical current restrictions and respects their expiry',async()=>{
  rows.profiles[0].user_account_states=[{state:'banned',expires_at:null}];assert.equal((await readReferenceSource(client(),post,viewer)).available,false);
  rows.profiles[0].user_account_states=[{state:'suspended',expires_at:'2020-01-01T00:00:00Z'}];assert.equal((await readReferenceSource(client(),post,viewer)).available,true);
 });
 it('never substitutes a raw real name for a public handle',async()=>{
  rows.profiles[0].handle=null;rows.profiles[0].display_name='Private real name';assert.equal((await readReferenceSource(client(),post,viewer) as any).author,'Traveler');
 });
 it('archived Memory references remain owner-readable and unavailable to other audiences',async()=>{
  rows.memories[0].state='archived';assert.equal((await readPostReference(client(),ref,viewer))?.available,true);
  assert.equal(await readPostReference(client(),ref,author),null);
 });
 it('respects a reference item’s private override inside a public Memory',async()=>{
  rows.memories[0].visibility='public';rows.memory_items[0].visibility='only_me';
  assert.equal(await readPostReference(client(),ref,author),null);assert.equal((await readPostReference(client(),ref,viewer))?.available,true);
 });
 it('uses the Highlight lifecycle gate for active, private, expired and archived destinations',async()=>{
  rows.post_destination_references[0].memory_item_id=null;rows.post_destination_references[0].highlight_id='highlight';
  rows.highlights=[{id:'highlight',owner_id:viewer,visibility:'private',expires_at:'2100-01-01T00:00:00Z',deleted_at:null,archived_at:null,media_type:POST_REFERENCE_MEDIA_TYPE,media_url:`portava-post-reference:${ref}`}];
  assert.equal((await readPostReference(client(),ref,viewer))?.available,true);
  assert.equal(await readPostReference(client(),ref,author),null);
  rows.highlights[0].expires_at='2020-01-01T00:00:00Z';assert.equal(await readPostReference(client(),ref,viewer),null);
  rows.highlights[0].expires_at='2100-01-01T00:00:00Z';rows.highlights[0].archived_at='now';assert.equal(await readPostReference(client(),ref,viewer),null);
 });
});


it('post references honor a private account and recheck revoked approved follows',async()=>{
  rows.profiles[0].is_private=true;
  assert.equal((await readReferenceSource(client(),post,viewer)).available,false);
  rows.user_follows=[{follower_id:viewer,following_id:author}];
  assert.equal((await readReferenceSource(client(),post,viewer)).available,true);
  rows.user_follows=[];
  assert.equal((await readReferenceSource(client(),post,viewer)).available,false);
  assert.equal((await readReferenceSource(client(),post,author)).available,true);
});
it('unknown private-account follow state never grants a saved reference audience',async()=>{
  rows.profiles[0].is_private=true;rows.user_follows=[{follower_id:viewer,following_id:author}];failures.add('user_follows');
  assert.equal((await readReferenceSource(client(),post,viewer)).available,false);
});

it('projects ordered first-party media and revokes it after moderation, without resurrecting legacy copies',async(t)=>{
 const originalOrigin = process.env.SUPABASE_URL;
 process.env.SUPABASE_URL = 'https://storage.example.test';
 t.after(() => {
   if (originalOrigin === undefined) delete process.env.SUPABASE_URL;
   else process.env.SUPABASE_URL = originalOrigin;
 });
 const video='post-media/'+author+'/clip.mp4',photo='post-media/'+author+'/photo.jpg';
 rows.posts[0].media_urls=[photo];
 rows.post_media=[{post_id:post,media_type:'video',public_url:video,storage_path:author+'/clip.mp4',sort_order:1,processing_status:'ready',moderation_status:'approved'},
  {post_id:post,media_type:'image',public_url:photo,storage_path:author+'/photo.jpg',sort_order:0,processing_status:'ready',moderation_status:'pending'}];
 let view=await readReferenceSource(client(),post,viewer);assert.ok(view.available);assert.deepEqual(view.media.map(m=>[m.type,m.uri]),[['image',photo],['video',video]]);
 rows.post_media[1].moderation_status='rejected'; rows.post_media_moderation_ledger=[{storage_path:author+'/clip.mp4'}];
 view=await readReferenceSource(client(),post,viewer);assert.ok(view.available);assert.deepEqual(view.media,[]);
 rows.post_media=[]; view=await readReferenceSource(client(),post,viewer);assert.ok(view.available);assert.deepEqual(view.media.map(m=>m.uri),[photo]);
 failures.add('post_media');await assert.rejects(readReferenceSource(client(),post,viewer),/source_media_unavailable/);
});
