import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import express from 'express';
import { createServer, type Server } from 'node:http';
import memoriesRouter from '../../routes/memories.js';
import { _setTestClient } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { openPressedLayoverDb, PRESSED_SKIP_REASON } from './pressedLayoverDb.js';

describe('H178 atomic Memory field edits', { skip: PRESSED_SKIP_REASON }, () => {
  let db: Awaited<ReturnType<typeof openPressedLayoverDb>>, actor: string;
  let token: string, server: Server, baseUrl: string;
  const sessions: Client[] = [];
  before(async () => {
    db = await openPressedLayoverDb(); const user = await db.seedUser('field-edit-owner'); actor = user.id; token = user.token;
    _setTestClient(db.client, true);
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.log = logger; next(); }); app.use(memoriesRouter);
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    _setTestClient(null, false); await Promise.all(sessions.map(s => s.end())); await db?.close();
  });
  const source = async () => {
    const id = randomUUID();
    await db.exec(`INSERT INTO memories(id,owner_id,title,caption,state,visibility) VALUES('${id}','${actor}','old title','old caption','published','only_me')`);
    return id;
  };
  const command = (id: string, patch: Record<string, unknown>, expected: Record<string, unknown> | undefined, key = randomUUID()) => ({
    command_id: randomUUID(), correlation_id: randomUUID(), type: 'UPDATE_MEMORY', memory_id: id,
    actor_user_id: actor, idempotency_key: key, payload: { patch, expected },
  });
  const run = async (cmd: ReturnType<typeof command>) => {
    const result = await db.client.rpc('memory_kernel_execute', { p_command: cmd });
    assert.equal(result.error, null, JSON.stringify(result)); return result.data as Record<string, any>;
  };
  const row = async (id: string) => (await db.query(`SELECT * FROM memories WHERE id='${id}'`))[0];
  const counts = async (id: string) => (await db.query(`SELECT
    (SELECT count(*)::int FROM memory_domain_events WHERE memory_id='${id}') events,
    (SELECT count(*)::int FROM memory_command_receipts WHERE memory_id='${id}') receipts,
    (SELECT count(*)::int FROM memory_corrections WHERE memory_id='${id}') corrections`))[0];
  const connect = async () => {
    assert.ok(db.databaseUrl, "independent sessions require the reusable PostgreSQL fixture");
    const s = new Client({ connectionString: db.databaseUrl }); await s.connect(); sessions.push(s);
    await s.query("SET ROLE service_role; SET statement_timeout='10s'"); return s;
  };
  it('rejects absent and incomplete bases without canonical effects', async () => {
    const id = await source();
    for (const expected of [undefined, {}, { state: 'published' }]) {
      assert.equal((await run(command(id, { caption: 'lost' }, expected))).reason, 'MEMORY_EDIT_BASE_REQUIRED');
    }
    assert.equal((await row(id)).caption, 'old caption');
    assert.deepEqual(await counts(id), { events: 0, receipts: 0, corrections: 0 });
  });
  for (const mode of ['same_field', 'independent', 'same_operation'] as const) it(`independent database sessions: ${mode}`, async () => {
    const independent = mode === 'independent', duplicate = mode === 'same_operation';
    const id = await source(), a = await connect(), b = await connect();
    const first = command(id, { title: 'winner' }, { title: 'old title', state: 'published' });
    const second = duplicate ? first : command(id, independent ? { caption: 'second' } : { title: 'loser' },
      independent ? { caption: 'old caption', state: 'published' } : { title: 'old title', state: 'published' });
    const bPid = Number((await b.query('SELECT pg_backend_pid() pid')).rows[0].pid);
    await a.query('BEGIN');
    try {
      assert.equal((await a.query('SELECT memory_kernel_execute($1::jsonb) result', [first])).rows[0].result.ok, true);
      const pending = b.query('SELECT memory_kernel_execute($1::jsonb) result', [second]);
      // Prove real lock contention, not merely two sequential mock calls.
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        waiting = (await db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${bPid} AND wait_event_type='Lock') waiting`))[0].waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, 'second independent session must wait for the canonical row lock');
      await a.query('COMMIT');
      const result = (await pending).rows[0].result;
      assert.equal(result.ok, independent || duplicate);
      if (duplicate) assert.equal(result.duplicate, true);
      if (!independent && !duplicate) assert.equal(result.reason, 'MEMORY_FIELD_CONFLICT');
      const saved = await row(id);
      assert.equal(saved.title, 'winner'); assert.equal(saved.caption, independent ? 'second' : 'old caption');
      assert.equal((await counts(id)).events, independent ? 2 : 1);
    } finally { await a.query('ROLLBACK'); }
  });
  it('replays the same operation before testing its now-stale base', async () => {
    const id = await source(), cmd = command(id, { caption: 'saved' }, { caption: 'old caption', state: 'published' });
    const first = await run(cmd), replay = await run(cmd);
    assert.equal(first.ok, true); assert.equal(replay.duplicate, true); assert.deepEqual(replay.result, first.result);
    assert.deepEqual(await counts(id), { events: 1, receipts: 1, corrections: 0 });
  });
  it('does not replay an operation onto a different Memory', async () => {
    const id = await source(), other = await source();
    const cmd = command(id, { title: 'saved' }, { title: 'old title', state: 'published' }); await run(cmd);
    assert.equal((await run({ ...cmd, memory_id: other })).reason, 'MEMORY_IDEMPOTENCY_KEY_REUSED');
    assert.equal((await row(other)).title, 'old title');
  });
  it('compares a related time pair using PostgreSQL timestamp precision', async () => {
    const id = await source();
    await db.exec(`UPDATE memories SET starts_at='2026-11-16T12:00:00.123456Z',ends_at='2026-11-16T13:00:00Z' WHERE id='${id}'`);
    const base = { state: 'published', starts_at: '2026-11-16T07:00:00.123456-05:00', ends_at: '2026-11-16T13:00:00Z' };
    assert.equal((await run(command(id, { starts_at: '2026-11-16T12:30:00Z' }, base))).ok, true);
    assert.equal((await run(command(id, { ends_at: '2026-11-16T14:00:00Z' }, base))).reason, 'MEMORY_FIELD_CONFLICT');
  });
  it('rejects stale lifecycle and audience dependencies', async () => {
    const id = await source();
    await db.exec(`UPDATE memories SET state='archived' WHERE id='${id}'`);
    assert.equal((await run(command(id, { caption: 'lost' }, { caption: 'old caption', state: 'published' }))).reason, 'MEMORY_FIELD_CONFLICT');
    assert.equal((await run(command(id, { visibility: 'public' }, { state: 'archived', visibility: 'only_me' }))).reason, 'MEMORY_EDIT_BASE_REQUIRED');
  });
  const placeBase = { state: 'published', place_id: null, canonical_location_id: null, location_city: null, location_country: null, location_lat: null, location_lng: null };
  it('commits place corrections with the winning edit and none for a conflict or replay', async () => {
    const id = await source(), cmd = command(id, { place_id: 'place-one' }, placeBase);
    assert.equal((await run(cmd)).ok, true);
    assert.equal((await run(command(id, { place_id: 'place-two' }, placeBase))).reason, 'MEMORY_FIELD_CONFLICT');
    assert.equal((await run(cmd)).duplicate, true);
    assert.equal((await row(id)).place_id, 'place-one');
    assert.deepEqual(await counts(id), { events: 1, receipts: 1, corrections: 1 });
  });
  it('rolls back correction and canonical writes if event persistence fails', async () => {
    const id = await source();
    await db.exec(`CREATE FUNCTION test_fail_memory_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic event failure'; END$$;
      CREATE TRIGGER test_fail_memory_event BEFORE INSERT ON memory_domain_events FOR EACH ROW EXECUTE FUNCTION test_fail_memory_event();`);
    try {
      const result = await db.client.rpc('memory_kernel_execute', { p_command: command(id, { place_id: 'unsaved' }, placeBase) });
      assert.ok(result.error); assert.equal((await row(id)).place_id, null);
      assert.deepEqual(await counts(id), { events: 0, receipts: 0, corrections: 0 });
    } finally { await db.exec('DROP TRIGGER test_fail_memory_event ON memory_domain_events; DROP FUNCTION test_fail_memory_event()'); }
  });
  it('keeps the writer and readiness check unavailable to client roles', async () => {
    assert.deepEqual((await db.query(`SELECT has_function_privilege('authenticated','memory_kernel_execute(jsonb)','EXECUTE') writer,
      has_function_privilege('anon','memory_field_edits_ready()','EXECUTE') readiness`))[0], { writer: false, readiness: false });
    assert.deepEqual((await db.query('SELECT memory_field_edits_ready() edits, memory_item_source_ready() sources, postcard_canonical_lifecycle_ready() retention'))[0],
      { edits: true, sources: true, retention: true });
  });
  const patchHttp = async (id: string, payload: unknown, key = randomUUID()) => {
    const response = await fetch(`${baseUrl}/memories/${id}`, { method: 'PATCH', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key,
    }, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  for (const enabled of [false, true]) it(`mounted API uses one atomic writer with the broader kernel flag ${enabled}`, async () => {
    await db.setFlag('memory_kernel_enabled', enabled);
    const id = await source();
    const first = await patchHttp(id, { caption: 'first', expected: { caption: 'old caption', state: 'published' } });
    assert.equal(first.status, 200, JSON.stringify(first)); assert.equal(first.body.memory.caption, 'first');
    const loser = await patchHttp(id, { caption: 'lost', expected: { caption: 'old caption', state: 'published' } });
    assert.equal(loser.status, 409, JSON.stringify(loser)); assert.equal(loser.body.reason, 'MEMORY_FIELD_CONFLICT');
    assert.equal((await row(id)).caption, 'first'); assert.equal((await counts(id)).events, 1);
  });
  it('mounted API refuses missing bases and missing schema without a legacy write', async () => {
    const id = await source();
    assert.equal((await patchHttp(id, { caption: 'lost' })).body.reason, 'MEMORY_EDIT_BASE_REQUIRED');
    await db.exec('ALTER FUNCTION memory_field_edits_ready() RENAME TO test_missing_memory_field_edits_ready');
    try {
      assert.equal((await patchHttp(id, { caption: 'lost', expected: { caption: 'old caption', state: 'published' } })).status, 503);
      assert.equal((await row(id)).caption, 'old caption'); assert.equal((await counts(id)).events, 0);
    } finally { await db.exec('ALTER FUNCTION test_missing_memory_field_edits_ready() RENAME TO memory_field_edits_ready'); }
  });
  it('mounted API clears a place and its occurrence name atomically', async () => {
    await db.setFlag('memory_place_occurrence_name_enabled', true);
    const id = await source();
    await db.exec(`UPDATE memories SET place_id='old-place',place_display_name_at_occurrence='Original cafe' WHERE id='${id}'`);
    const result = await patchHttp(id, { placeId: null, expected: { state: 'published', placeId: 'old-place',
      canonicalLocationId: null, locationCity: null, locationCountry: null, locationLat: null, locationLng: null,
      placeDisplayNameAtOccurrence: 'Original cafe' } });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal((await row(id)).place_id, null); assert.equal((await row(id)).place_display_name_at_occurrence, null);
    assert.equal((await counts(id)).corrections, 2);
  });
  it('an unrelated edit preserves a legacy inverted interval', async () => {
    const id = await source();
    await db.exec(`UPDATE memories SET starts_at='2026-11-16T14:00:00Z',ends_at='2026-11-16T13:00:00Z' WHERE id='${id}'`);
    assert.equal((await run(command(id, { title: 'Only title' }, { state: 'published', title: 'old title' }))).ok, true);
    assert.equal((await row(id)).caption, 'old caption');
  });
  it('negative control reproduces lost edits when the field comparison is removed, then restores the function', async () => {
    await db.exec('BEGIN');
    try {
      const id = await source();
      const definition = String((await db.query("SELECT pg_get_functiondef('memory_kernel_execute(jsonb)'::regprocedure) definition"))[0].definition);
      const anchor = 'IF to_jsonb(v_edit_before)->v_field IS DISTINCT FROM to_jsonb(v_edit_base)->v_field THEN';
      assert.ok(definition.includes(anchor));
      await db.exec(definition.replace(anchor, 'IF false THEN'));
      const uncheckedRun = async (cmd: ReturnType<typeof command>) => (await db.query(`SELECT memory_kernel_execute('${JSON.stringify(cmd).replace(/'/g, "''")}'::jsonb) result`))[0].result as Record<string, unknown>;
      const base = { caption: 'old caption', state: 'published' };
      assert.equal((await uncheckedRun(command(id, { caption: 'first' }, base))).ok, true);
      assert.equal((await uncheckedRun(command(id, { caption: 'stale overwrite' }, base))).ok, true);
      assert.equal((await row(id)).caption, 'stale overwrite');
    } finally { await db.exec('ROLLBACK'); }
    assert.match(String((await db.query("SELECT pg_get_functiondef('memory_kernel_execute(jsonb)'::regprocedure) definition"))[0].definition), /IF to_jsonb\(v_edit_before\)->v_field IS DISTINCT FROM/);
  });
});
