import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { applySequenceWindow, withinSequenceWindow, acknowledgeMessage } from '../services/telegraph/sequenceState.js';
import { receiptFor } from '../services/telegraph/unsend.js';

describe('Telegraph canonical sequence reader',()=>{
 it('bounds another sender while preserving the own-message rejoin exception',()=>{
  const member={visible_from_sequence:4,visible_until_sequence:9};
  assert.equal(withinSequenceWindow({sequence:3,sender_id:'other'},member,'me'),false);
  assert.equal(withinSequenceWindow({sequence:10,sender_id:'other'},member,'me'),false);
  assert.equal(withinSequenceWindow({sequence:4,sender_id:'other'},member,'me'),true);
  assert.equal(withinSequenceWindow({sequence:3,sender_id:'me'},member,'me'),true);
  assert.equal(withinSequenceWindow({sequence:null,sender_id:'me'},member,'me'),false);
  const clauses:string[]=[]; const query={or:(clause:string)=>{clauses.push(clause);return query;}};
  applySequenceWindow(query,member,'me');
  assert.deepEqual(clauses,['sequence.gte.4,sender_id.eq.me','sequence.lte.9,sender_id.eq.me']);
 });
 it('same-timestamp receipts prefer sequence and report device ACKs',()=>{
  const message={id:'m',thread_id:'t',sender_id:'a',sequence:2,created_at:'2026-11-05T01:00:00Z'};
  const recipient={user_id:'b',last_read_at:message.created_at,seen_sequence:1,delivered_sequence:2};
  const delivered=receiptFor(message,[recipient]);
  assert.equal(delivered.status,'DELIVERED'); assert.equal(delivered.delivered,true); assert.equal(delivered.seenBy,0);
  assert.equal(receiptFor(message,[{...recipient,seen_sequence:2}]).status,'SEEN');
  assert.equal(receiptFor({...message,sequence:null},[recipient]).delivered,null);
 });
 it('uses the authenticated actor for the atomic write and refuses malformed success',async()=>{
  let args:unknown;
  const valid={outcome:'acknowledged',advanced:true,sequence:'2',lastReadAt:null,seenMessageIds:[],receiptRowsWritten:0};
  const client={rpc:async(name:string,input:unknown)=>{assert.equal(name,'telegraph_ack_message');args=input;return {data:valid,error:null};}};
  assert.equal((await acknowledgeMessage(client,'thread','actor','message','delivered')).ok,true);
  assert.deepEqual(args,{p_thread_id:'thread',p_actor_id:'actor',p_message_id:'message',p_kind:'delivered'});
  assert.deepEqual(await acknowledgeMessage({rpc:async()=>({data:{...valid,sequence:null},error:null})},'t','a','m','seen'),{ok:false,code:'degraded_unavailable'});
  assert.deepEqual(await acknowledgeMessage({rpc:async()=>({data:valid,error:{message:'failed'}})},'t','a','m','seen'),{ok:false,code:'degraded_unavailable'});
 });
});
