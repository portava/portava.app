// Run with playwright-cli run-code --filename=<this file> after serving bundled
// webStorage.ts + engine.ts as window.OutboxStorage/window.OutboxEngine.
async (page) => {
  const checks = [];
  const check = (value, name) => { if (!value) throw new Error(name); checks.push(name); };
  await page.evaluate(async () => {
    window.scope = { ownerId: 'synthetic-owner', sessionId: 'synthetic-session' };
    window.entry = (clientId = 'first') => ({ ...scope, clientId, threadId: 'synthetic-thread', createdAt: new Date().toISOString(), payload: { ciphertext: 'exact-synthetic-ciphertext', clientId }, display: { body: 'SYNTHETIC_PRIVATE_BODY', msgType: 'text', subtype: null, replyToId: null, isE2ee: true }, state: 'queued', attempts: 0, nextAttemptAt: 0 });
    window.db = await new Promise((resolve, reject) => { const req=indexedDB.open('portava-telegraph-outbox-v1',1); req.onupgradeneeded=()=>{req.result.createObjectStore('keys');req.result.createObjectStore('messages',{keyPath:'id'}).createIndex('ownerId','ownerId');};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error); });
    window.req = (request) => new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await OutboxStorage.webStorage.clearOwner(scope.ownerId);
    await OutboxStorage.webStorage.put(entry());
  });
  const atRest = await page.evaluate(async()=>{
    const rows=await req(db.transaction('messages').objectStore('messages').getAll());
    const key=await req(db.transaction('keys').objectStore('keys').get(scope.ownerId));
    let exportRefused=false;try{await crypto.subtle.exportKey('raw',key.key);}catch{exportRefused=true;}
    return {nonextractable:!key.key.extractable,exportRefused,plaintextAbsent:!JSON.stringify(rows).includes('SYNTHETIC_PRIVATE_BODY'),ciphertext:rows[0].ciphertext.byteLength>16};
  });
  check(Object.values(atRest).every(Boolean),'AES-GCM ciphertext at rest and nonextractable persisted key');
  await page.reload();
  check(await page.evaluate(async()=>{const rows=await OutboxStorage.webStorage.read({ownerId:'synthetic-owner',sessionId:'synthetic-session'});return rows.length===1&&rows[0].display.body==='SYNTHETIC_PRIVATE_BODY'&&rows[0].payload.ciphertext==='exact-synthetic-ciphertext';}),'exact encrypted payload and local display survive real page reload');
  const other=await page.context().newPage();await other.goto(page.url());
  const scope={ownerId:'synthetic-owner',sessionId:'synthetic-session'};
  check(await other.evaluate(async(scope)=>(await OutboxStorage.webStorage.read({...scope,sessionId:'replacement'})).length===0,scope),'replacement auth session cannot restore prior session drafts');
  await page.evaluate(async(scope)=>{window.scope=scope;window.entry=(clientId)=>({...scope,clientId,threadId:'thread',createdAt:new Date().toISOString(),payload:{body:'synthetic body'},display:{body:'synthetic body',msgType:'text',subtype:null,replyToId:null,isE2ee:false},state:'queued',attempts:0,nextAttemptAt:0});},scope);
  // Suspend actual WebCrypto result delivery to force cross-tab cancellation.
  const suspend=async(clientId,update)=>{
    await page.evaluate(async({clientId,update})=>{
      window.releaseEncryption=undefined;window.originalEncrypt=crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt=async(...args)=>{const result=await originalEncrypt(...args);await new Promise(resolve=>{window.releaseEncryption=resolve;});return result;};
      window.pending=OutboxStorage.webStorage.put(entry(clientId),update).then(()=>false,()=>true);
    },{clientId,update});
    await page.waitForFunction(()=>typeof window.releaseEncryption==='function');
  };
  await suspend('first',true);await other.evaluate(async(scope)=>OutboxStorage.webStorage.remove(scope,'first'),scope);
  await page.evaluate(()=>{crypto.subtle.encrypt=originalEncrypt;releaseEncryption();});
  check(await page.evaluate(()=>pending),'late cross-tab update cannot recreate a cancelled record');
  await suspend('after-clear',false);await other.evaluate(async(scope)=>OutboxStorage.webStorage.clearOwner(scope.ownerId),scope);
  await page.evaluate(()=>{crypto.subtle.encrypt=originalEncrypt;releaseEncryption();});
  check(await page.evaluate(()=>pending),'account clearing invalidates encryption already running in another tab');
  check(await other.evaluate(async(scope)=>(await OutboxStorage.webStorage.read(scope)).length===0,scope),'cleared pending content stays empty after stale work finishes');
  const raceOwner='key-race-owner';
  await Promise.all([page,other].map((tab,index)=>tab.evaluate(async({owner,index})=>{
    const entry={ownerId:owner,sessionId:'s',clientId:`c${index}`,threadId:'t',createdAt:new Date().toISOString(),payload:{body:'synthetic'},display:{body:'synthetic',msgType:'text',subtype:null,replyToId:null,isE2ee:false},state:'queued',attempts:0,nextAttemptAt:0};
    await OutboxStorage.webStorage.put(entry);
  },{owner:raceOwner,index})));
  check(await page.evaluate(async(owner)=>(await OutboxStorage.webStorage.read({ownerId:owner,sessionId:'s'})).length===2,raceOwner),'concurrent browser tabs choose one recoverable owner key');
  check(await page.evaluate(async()=>{
    const owner={...scope,isCurrent:()=>true};const engine=new OutboxEngine.MessageOutbox(OutboxStorage.webStorage);let abortObserved=false,release;
    const work=engine.submit(owner,{clientId:'cancel-in-flight',threadId:'thread',display:entry('x').display},async()=>({body:'synthetic'}),(_entry,signal)=>{signal.addEventListener('abort',()=>{abortObserved=true;});return new Promise(resolve=>{release=resolve;});});
    for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,5));
    await engine.cancel(owner,'cancel-in-flight');release({ok:false,data:null,errorKind:'network_unreachable',retryable:true});await work;
    return abortObserved&&(await new OutboxEngine.MessageOutbox(OutboxStorage.webStorage).pending(owner)).length===0;
  }),'cancellation aborts transport and remains absent after engine restart');
  check(await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const request=indexedDB.open('portava-telegraph-outbox-v1');request.onsuccess=()=>resolve(request.result);});
    const transaction=db.transaction('messages','readwrite'),store=transaction.objectStore('messages');
    const row=await new Promise(resolve=>{const request=store.index('ownerId').get('key-race-owner');request.onsuccess=()=>resolve(request.result);});
    new Uint8Array(row.ciphertext)[0]^=1;store.put(row);await new Promise((resolve,reject)=>{transaction.oncomplete=resolve;transaction.onerror=reject;});db.close();
    try{await OutboxStorage.webStorage.read({ownerId:'key-race-owner',sessionId:'s'});return false;}catch{return true;}
  }),'AES-GCM authentication refuses tampered stored ciphertext');
  check(await page.evaluate(async()=>{
    const owner={ownerId:'durable-replay-owner',sessionId:'durable-session',isCurrent:()=>true};
    const engine=new OutboxEngine.MessageOutbox(OutboxStorage.webStorage);
    const display={body:'synthetic durable body',msgType:'text',subtype:null,replyToId:'reply-id',isE2ee:true};
    await OutboxStorage.webStorage.clearOwner(owner.ownerId);
    await engine.submit(owner,{clientId:'stable-id',threadId:'thread',display},async()=>({ciphertext:'stable-ciphertext',clientId:'stable-id',idempotencyKey:'stable-id',replyToId:'reply-id'}),async()=>({ok:false,data:null,errorKind:'network_unreachable',retryable:true}));
    const rows=await engine.pending(owner);return rows.length===1&&rows[0].state==='retryable'&&rows[0].nextAttemptAt>Date.now();
  }),'offline transport records a durable retry deadline');
  await page.reload();
  check(await page.evaluate(async()=>{
    const owner={ownerId:'durable-replay-owner',sessionId:'durable-session',isCurrent:()=>true};
    const engine=new OutboxEngine.MessageOutbox(OutboxStorage.webStorage,()=>Date.now()+600000);let payload;
    await engine.replay(owner,async(entry)=>{payload=entry.payload;return{ok:true,data:{id:'server-id'}};});
    return payload?.ciphertext==='stable-ciphertext'&&payload?.idempotencyKey==='stable-id'&&payload?.replyToId==='reply-id'&&(await engine.pending(owner)).length===0;
  }),'after reload replay sends the exact ciphertext/reply/idempotency and removes acknowledged draft');
  await other.close();
  return {checks,passed:checks.length,browser:await page.evaluate(()=>navigator.userAgent),scope:'synthetic localhost browser verification, no production reads or writes'};
}
