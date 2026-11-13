import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preserveNativeDraftAsset, restoreNativeDraftAsset, discardNativeDraftAsset, type DraftFileSystem } from './nativeComposerAssets.ts';
function fixture() {
  const files = new Map<string,string>([['file:///picker/private-name.jpg','synthetic bytes']]);
  const fs: DraftFileSystem = {documentDirectory:'file:///documents/',makeDirectoryAsync:async()=>{},copyAsync:async({from,to})=>{files.set(to,files.get(from)!);},deleteAsync:async uri=>{files.delete(uri);},getInfoAsync:async uri=>({exists:files.has(uri)})};
  let current=true;
  const owner={ownerId:'account-a',sessionId:'session-a',isCurrent:()=>current,invalidate:()=>{current=false;}};
  return {fs,owner,files};
}
test('native recovery stores an account-owned durable copy, never the original filename, and isolates other accounts',async()=>{
 const {fs,owner,files}=fixture();const saved=await preserveNativeDraftAsset(fs,'file:///picker/private-name.jpg',owner);
 assert.match(saved,/^file:\/\/\/documents\/composer-drafts\/account-a\/[a-f0-9-]+\.jpg$/);files.delete('file:///picker/private-name.jpg');
 assert.equal(await restoreNativeDraftAsset(fs,saved,'account-a'),saved);assert.equal(files.get(saved),'synthetic bytes');
 await assert.rejects(restoreNativeDraftAsset(fs,saved,'account-b'));await discardNativeDraftAsset(fs,saved,'account-b');assert.equal(files.has(saved),true);
 await discardNativeDraftAsset(fs,saved,'account-a');await discardNativeDraftAsset(fs,saved,'account-a');await assert.rejects(restoreNativeDraftAsset(fs,saved,'account-a'));
});
test('account replacement while a native copy completes removes the late copy',async()=>{
 const {fs,owner,files}=fixture(),copy=fs.copyAsync;fs.copyAsync=async args=>{await copy(args);owner.invalidate();};
 await assert.rejects(preserveNativeDraftAsset(fs,'file:///picker/private-name.jpg',owner),/account changed/);
 assert.deepEqual([...files.keys()],['file:///picker/private-name.jpg']);
});
test('partial native copy failures clean their temporary output and never claim recovery succeeded',async()=>{
 const {fs,owner,files}=fixture();fs.copyAsync=async({to})=>{files.set(to,'partial');throw new Error('Disk full with private filename');};
 await assert.rejects(preserveNativeDraftAsset(fs,'file:///picker/private-name.jpg',owner),/^Error: Draft media could not be saved\.$/);
 assert.deepEqual([...files.keys()],['file:///picker/private-name.jpg']);
});

test('host filesystem contract preserves a 50 MB source without a second copy when the durable file is reused',async t=>{
 const io=await import('node:fs/promises'),urls=await import('node:url'),os=await import('node:os'),path=await import('node:path'),crypto=await import('node:crypto'),streams=await import('node:fs');
 const folder=await io.mkdtemp(path.join(os.tmpdir(),'portava-draft-file-proof-'));
 let copies=0;
 const fs:DraftFileSystem={documentDirectory:urls.pathToFileURL(`${folder}/documents/`).href,makeDirectoryAsync:async uri=>{await io.mkdir(urls.fileURLToPath(uri),{recursive:true});},copyAsync:async({from,to})=>{copies++;await io.copyFile(urls.fileURLToPath(from),urls.fileURLToPath(to));},deleteAsync:async uri=>{await io.rm(urls.fileURLToPath(uri),{force:true});},getInfoAsync:async uri=>({exists:await io.stat(urls.fileURLToPath(uri)).then(()=>true,()=>false)})};
 const hash=async(file:string)=>{const result=crypto.createHash('sha256');for await(const chunk of streams.createReadStream(file))result.update(chunk);return result.digest('hex');};
 try{
  const source=path.join(folder,'synthetic-original.mp4'),handle=await io.open(source,'w'),chunk=Buffer.alloc(1_000_000,42);
  try{for(let i=0;i<50;i++)await handle.write(chunk);}finally{await handle.close();}
  const started=performance.now(),rss=process.memoryUsage().rss,{owner}=fixture();
  const saved=await preserveNativeDraftAsset(fs,urls.pathToFileURL(source).href,owner);
  const elapsed=performance.now()-started,delta=process.memoryUsage().rss-rss;
  assert.equal((await io.stat(urls.fileURLToPath(saved))).size,50_000_000);assert.equal(await hash(source),await hash(urls.fileURLToPath(saved)));
  assert.equal(await preserveNativeDraftAsset(fs,saved,owner),saved);assert.equal(copies,1);
  await io.rm(source);assert.equal(await restoreNativeDraftAsset(fs,saved,owner.ownerId),saved);
  await discardNativeDraftAsset(fs,saved,owner.ownerId);await discardNativeDraftAsset(fs,saved,owner.ownerId);
  t.diagnostic(`Host adapter only: 50000000 bytes; copy ${elapsed.toFixed(1)} ms; RSS delta ${delta} bytes; Expo/native-device performance not measured.`);
 }finally{await io.rm(folder,{recursive:true,force:true});}
});
