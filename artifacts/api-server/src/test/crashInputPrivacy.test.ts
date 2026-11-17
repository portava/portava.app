import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactCrashBreadcrumb, redactCrashInput, redactCrashEvent } from '../lib/crashInputPrivacy.js';
test('crash exports remove draft content, media filenames, payloads, URLs and breadcrumb values', () => {
    const secret = 'PRIVATE DRAFT photo.jpg';
    const event = { event_id: 'a'.repeat(32), level: 'error', message: secret, user: { id: secret }, extra: { draft: secret }, request: { url: secret, data: secret, headers: { authorization: secret } }, contexts: { draft: { text: secret } }, tags: { draft: secret }, exception: { values: [{ type: 'TypeError', value: secret, stacktrace: { frames: [{ filename: '/app/index.bundle.js?draft=' + secret, function: 'handleSubmit', lineno: 42, colno: 3, vars: { draft: secret }, context_line: secret }, { filename: '/photos/' + secret }] } }] }, breadcrumbs: [{ category: 'console', message: secret, data: { text: secret } }] };
    const output = redactCrashInput(event);
    assert.equal(JSON.stringify(output).includes(secret), false);
    assert.equal(output.exception.values[0]!.type, 'TypeError');
    assert.equal(output.exception.values[0]!.stacktrace.frames[0]!.filename, 'index.bundle.js');
    assert.equal(output.exception.values[0]!.stacktrace.frames[0]!.lineno, 42);
    assert.equal(JSON.stringify(redactCrashBreadcrumb({ message: secret, data: { media: secret }, category: 'ui.click' })).includes(secret), false);
});
test('performance diagnostics keep timing and trace linkage but exclude dynamic route and span payloads', () => {
    const secret = 'PRIVATE PARTIAL INPUT';
    const output = redactCrashInput({ type: 'transaction', transaction: secret, start_timestamp: 1, timestamp: 2, contexts: { trace: { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), data: secret } }, spans: [{ op: 'http.client', description: secret, data: { body: secret }, start_timestamp: 1, timestamp: 2, span_id: 'c'.repeat(16) }] });
    assert.equal(JSON.stringify(output).includes(secret), false);
    assert.equal(output.transaction, 'app');
    assert.equal(output.spans[0]!.timestamp, 2);
    assert.equal(output.contexts.trace.trace_id, 'a'.repeat(32));
});

test('SDK attachment export is cleared independently of event serialization',()=>{
 const hint={attachments:[{filename:'private-video.mov',data:new Uint8Array([1,2,3])}]};
 const event=redactCrashEvent({message:'private caption'},hint);assert.deepEqual(hint.attachments,[]);assert.equal(JSON.stringify(event).includes('private caption'),false);
});
