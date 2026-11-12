import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { _setTestClient } from '../lib/http.js';
import messagingRouter from '../routes/messaging.js';
import kindsRouter from '../routes/telegraphKinds.js';
import searchRouter from '../server/telegraph/searchRoute.js';
import groupRouter from '../routes/groupChat.js';
import { replyQuoteForSender } from '../services/telegraph/replyQuote.js';
import { makeFakeClient, startRouter } from './telegraphCertificationHarness.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const T = 'dddddddd-0000-4000-8000-000000000001';
const TRIP = 'eeeeeeee-0000-4000-8000-000000000001';
const M = 'ffffffff-0000-4000-8000-000000000001';
const SECRET = 'private-future-payload';
const BODY = JSON.stringify({ kind: 'MEDIA_ALBUM', envelopeVersion: '1', schema: 'media_album.v2', payload: { assets: [{ url: `post-media/${SECRET}.jpg`, mediaType: 'image' }] } });
function seed(on = true) {
  return {
    feature_flags: [{ flag: 'telegraph_structured_schemas_enabled', enabled: on }],
    profiles: [A,B].map(id => ({ id, handle: id === A ? 'alice' : 'bob', show_name: true, name: 'Traveler' })),
    message_threads: [{ id:T, thread_type:'trip', trip_id:TRIP, status:'active', is_e2ee:false, title:'Crew', last_message_at:'2026-11-01T12:00:00Z' }],
    message_thread_members: [A,B].map(user_id => ({ thread_id:T, user_id, role:'member', left_at:null, joined_at:'2026-10-01T00:00:00Z', last_read_at:null, archived_at:null, muted_at:null })),
    trips: [{ id:TRIP, creator_id:A, title:'Trip' }],
    trip_members: [A,B].map(user_id => ({ trip_id:TRIP, user_id, status:'accepted', role:'member' })),
    messages: [{ id:M, thread_id:T, sender_id:B, body:BODY, msg_type:'media_album', subtype:null, deleted_at:null, created_at:'2026-11-01T12:00:00Z', media_url:`post-media/${SECRET}.jpg`, media_type:'image', media_thumbnail_url:`post-media/${SECRET}-thumb.jpg`, profile:{ name:'Bob', handle:'bob' } }],
    saved_messages: [{ user_id:A, message_id:M, saved_at:'2026-11-01T13:00:00Z' }],
    message_translations: [{ message_id:M, recipient_id:A, translated_body:SECRET, status:'translated', source_language:'es', target_language:'en' }],
    blocks: [],
  };
}
async function request(router: Router, path: string, schemas = 'none', on = true) {
  _setTestClient(makeFakeClient(seed(on)), true);
  const h = await startRouter(router);
  try {
    const res = await fetch(`${h.base}${path}`, { headers: { authorization:`Bearer ${A}`, 'x-telegraph-client-schemas':schemas, 'x-telegraph-client-actions':'none' } });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return body as any;
  } finally { await h.close(); }
}
afterEach(() => _setTestClient(null, false));

describe('Structured messages cannot bypass negotiation through sibling readers', () => {
  it('inbox fallback cannot be replaced by a translated snapshot or media URL', async () => {
    const body = await request(messagingRouter, '/me/threads');
    assert.equal(body.threads[0].lastMessagePreview.msgType, 'text');
    assert.match(body.threads[0].lastMessagePreview.body, /this version/);
    assert.equal(body.threads[0].lastMessagePreview.translated, false);
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });
  it('saved messages return the fallback without media or card projections', async () => {
    const body = await request(messagingRouter, '/me/saved-messages');
    assert.equal(body.saved.length, 1);
    assert.equal(body.saved[0].msgType, 'text');
    assert.match(body.saved[0].body, /this version/);
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });
  it('drawer does not index unsupported media as a playable attachment', async () => {
    const body = await request(kindsRouter, `/threads/${T}/drawer`);
    assert.ok(!JSON.stringify(body).includes(SECRET));
    assert.ok(!JSON.stringify(body).includes(M));
  });
  for (const [name,router,path] of [
    ['drawer search', kindsRouter, `/threads/${T}/search?q=${SECRET}`],
    ['global search', searchRouter, `/telegraph/search?q=${SECRET}`],
    ['Ask conversation', searchRouter, `/threads/${T}/ask?q=${SECRET}`],
  ] as const) it(`${name} cannot match unsupported payload content`, async () => {
    const body = await request(router, path);
    assert.ok(!JSON.stringify(body).includes(M));
  });
  it('secondary trip reader decorates the outgoing message too', async () => {
    const body = await request(groupRouter, `/trips/${TRIP}/chat`);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].structured.fallback, true);
    assert.ok(!JSON.stringify(body).includes(SECRET));
  });
  it('send response reply quotes cannot return an unsupported raw envelope', async () => {
    const result = await replyQuoteForSender(makeFakeClient(seed()), {threadId:T,viewerId:A,replyToId:M,clientHeaders:{'x-telegraph-client-schemas':'none'}});
    assert.ok('replyToBody' in result);
    assert.match(result.replyToBody ?? '', /this version/);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  });
  it('flag off preserves the stored payload for legacy behavior', async () => {
    const body = await request(messagingRouter, '/me/saved-messages', 'none', false);
    assert.equal(body.saved[0].body, BODY);
  });
});
