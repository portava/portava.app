import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { _setTestClient } from '../lib/http.js';
import { _setTestServiceClient } from '../lib/supabase.js';
import router, { composerOutcomeRowId } from '../routes/composerOutcomes.js';
let server: Server, base: string, enabled = true, fail = false, actor = '10000000-0000-4000-8000-000000000001';
const rows = new Map<string, any>();
function client() { return { auth: { getUser: async (token: string) => ({ data: { user: token === 'token' ? { id: actor } : null }, error: null }) }, from(table: string) { const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: table === 'feature_flags' ? { enabled } : null, error: null }), upsert: async (values: any[], options: any) => { assert.equal(options.ignoreDuplicates, true); if (fail)
            return { error: { code: 'outage' } }; for (const r of values)
            if (!rows.has(r.id))
                rows.set(r.id, r); return { error: null }; }, then: (ok: any, bad: any) => Promise.resolve({ data: [], error: null }).then(ok, bad) }; return b; } } as any; }
before(async () => { const app = express(); app.use(express.json()); app.use('/api', router); await new Promise<void>((resolve, reject) => { server = app.listen(0, '127.0.0.1', resolve); server.on('error', reject); }); base = `http://127.0.0.1:${(server.address() as any).port}`; });
after(async () => { await new Promise<void>(done => server.close(() => done())); });
beforeEach(() => { rows.clear(); enabled = true; fail = false; actor = '10000000-0000-4000-8000-000000000001'; const c = client(); _setTestClient(c, true); _setTestServiceClient(c); });
const event = { event_id: '20000000-0000-4000-8000-000000000001', version: 1, surface: 'postcard', outcome: 'upload_failed', failure_code: 'network' };
async function send(value: unknown, token = 'token') { return fetch(`${base}/api/media/analytics/composer-outcomes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(value) }); }
test('strict outcomes reject text/media/filenames and unapproved failure codes without echoing input', async () => {
    for (const patch of [{ text: 'private words' }, { media: 'file:///private.mov' }, { filename: 'holiday.mov' }, { failure_code: 'raw exception' }, { outcome: 'published', failure_code: 'network' }]) {
        const r = await send({ events: [{ ...event, ...patch }] });
        assert.equal(r.status, 400);
        assert.deepEqual(await r.json(), { error: 'invalid_payload' });
    }
    assert.equal(rows.size, 0);
});
test('retry is idempotent and actor-scoped, and storage contains only closed enum metadata', async () => {
    for (let i = 0; i < 2; i++) {
        const r = await send({ events: [event, event] });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { accepted: 2 });
    }
    assert.equal(rows.size, 1);
    const saved = [...rows.values()][0];
    assert.deepEqual(saved.payload, { version: 1, surface: 'postcard', outcome: 'upload_failed', failure_code: 'network' });
    assert.equal(saved.event_type, 'composer_outcome');
    assert.equal(saved.id, composerOutcomeRowId(actor, event.event_id));
    actor = '10000000-0000-4000-8000-000000000002';
    await send({ events: [event] });
    assert.equal(rows.size, 2);
});
test('auth, collection gate and durable acknowledgement fail closed', async () => {
    assert.equal((await send({ events: [event] }, 'wrong')).status, 401);
    enabled = false;
    const disabled = await send({ events: [event] });
    assert.equal(disabled.status, 200);
    assert.equal(rows.size, 0);
    enabled = true;
    fail = true;
    assert.equal((await send({ events: [event] })).status, 503);
    assert.equal(rows.size, 0);
});
