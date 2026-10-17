import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { Socket } from "node:net";
import express from "express";
import { _clearTestClient, _setTestClient, _setTestServiceClient } from "../lib/http.js";
import correctionsRouter from "../routes/memoryCorrections.js";
import { recordPlaceCorrections } from "../services/memory/memoryCorrections.js";

interface Database {
  exec(sql: string): Promise<unknown>;
  query<Row = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

const runtime = process.env.MEMORY_IMPORT_PGLITE_MODULE;
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FIRST = "10000000-0000-4000-8000-000000000001";
const SECOND = "10000000-0000-4000-8000-000000000002";
const FOREIGN = "10000000-0000-4000-8000-000000000003";
const KEY = "20000000-0000-4000-8000-000000000001";
const TRIP = "30000000-0000-4000-8000-000000000001";

const migration = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
let database: Database;

async function value(sql: string, parameters: unknown[] = []): Promise<any> {
  return (await database.query<{ result: unknown }>(`SELECT ${sql} AS result`, parameters)).rows[0]!.result;
}
async function create(ids = [FIRST, SECOND], owner = OWNER, key = KEY) {
  return value("public.memory_import_batches_create($1::uuid, $2::uuid, $3::uuid[])", [owner, key, ids]);
}
async function step(batchId: string, checkpoint = 0, limit = 25, owner = OWNER) {
  return value("public.memory_import_batches_step($1::uuid, $2::uuid, $3::integer, $4::integer)", [owner, batchId, checkpoint, limit]);
}
async function enable() {
  await database.exec("UPDATE feature_flags SET enabled = true WHERE flag IN ('memory_import_batches_enabled', 'memory_kernel_enabled')");
}

function accountDeletionClient() {
  const persisted = new Set(["profiles", "memories", "memory_tags", "memory_corrections",
    "memory_import_batches", "memory_import_batch_items"]);
  const operations: Array<{ table: string; operation: string }> = [];
  const identifier = (name: string) => {
    assert.match(name, /^[a-z_]+$/);
    return `"${name}"`;
  };
  return {
    operations,
    from(table: string) {
      let operation = "select";
      let patch: Record<string, unknown> = {};
      let inserted: Record<string, unknown>[] = [];
      const filters: Array<{ column: string; operator: string; value: unknown }> = [];
      let single = false;
      let offset = 0;
      let limit: number | undefined;
      const execute = async () => {
        operations.push({ table, operation });
        if (!persisted.has(table)) return { data: single ? null : [], error: null, count: 0 };
        const parameters: unknown[] = [];
        const bind = (input: unknown) => { parameters.push(input); return `$${parameters.length}`; };
        let query = `SELECT * FROM ${identifier(table)}`;
        if (operation === "delete") query = `DELETE FROM ${identifier(table)}`;
        if (operation === "update") query = `UPDATE ${identifier(table)} SET ${Object.entries(patch)
          .map(([column, input]) => `${identifier(column)} = ${bind(input)}`).join(", ")}`;
        if (operation === "insert") {
          const columns = Object.keys(inserted[0]!);
          query = `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")}) VALUES ${inserted
            .map((row) => `(${columns.map((column) => bind(row[column])).join(", ")})`).join(", ")}`;
        }
        if (filters.length) query += ` WHERE ${filters.map((filter) => {
          if (filter.operator === "in") return `${identifier(filter.column)} = ANY(${bind(filter.value)}::uuid[])`;
          return `${identifier(filter.column)} ${filter.operator} ${bind(filter.value)}`;
        }).join(" AND ")}`;
        if (operation !== "select") query += " RETURNING *";
        const result = await database.query(query, parameters);
        const rows = JSON.parse(JSON.stringify(result.rows.slice(offset, limit === undefined ? undefined : offset + limit)));
        return { data: single ? rows[0] ?? null : rows, error: null, count: rows.length };
      };
      const query = {
        select() { return query; },
        delete() { operation = "delete"; return query; },
        update(input: Record<string, unknown>) { operation = "update"; patch = input; return query; },
        insert(input: Record<string, unknown> | Record<string, unknown>[]) {
          if (persisted.has(table)) assert.equal(table, "memory_corrections");
          operation = "insert"; inserted = Array.isArray(input) ? input : [input]; return query;
        },
        upsert() { assert.equal(persisted.has(table), false); return query; },
        eq(column: string, input: unknown) { filters.push({ column, operator: "=", value: input }); return query; },
        neq(column: string, input: unknown) { filters.push({ column, operator: "<>", value: input }); return query; },
        in(column: string, input: unknown[]) { filters.push({ column, operator: "in", value: input }); return query; },
        or() { assert.equal(persisted.has(table), false); return query; },
        not() { assert.equal(persisted.has(table), false); return query; },
        is() { assert.equal(persisted.has(table), false); return query; },
        lt() { assert.equal(persisted.has(table), false); return query; },
        lte() { assert.equal(persisted.has(table), false); return query; },
        gte() { assert.equal(persisted.has(table), false); return query; },
        order() { return query; },
        limit(count: number) { limit = count; return query; },
        range(start: number, end: number) { offset = start; limit = end - start + 1; return query; },
        maybeSingle() { single = true; return execute(); },
        single() { single = true; return execute(); },
        then(resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) { return execute().then(resolve, reject); },
      };
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ remove: async (paths: string[]) => { assert.deepEqual(paths, []); return { data: [], error: null }; } }) },
    auth: { admin: { deleteUser: async (ownerId: string) => {
      assert.equal(await value("(SELECT account_status FROM profiles WHERE id = $1)", [ownerId]), "deleted");
      assert.equal(await value("(SELECT count(*) FROM memory_import_batches WHERE owner_id = $1)", [ownerId]), 1);
      await database.query("DELETE FROM auth.users WHERE id = $1", [ownerId]);
      return { data: {}, error: null };
    } } },
  };
}

async function rejectPlace(memoryId: string, body: unknown, ownerId = OWNER) {
  const client = accountDeletionClient();
  _setTestClient({ ...client, auth: { getUser: async () => ({ data: { user: { id: ownerId } }, error: null }) } }, true);
  const app = express();
  app.use((request: any, _response, next) => { request.log = { error() {}, warn() {}, info() {} }; next(); });
  app.use(correctionsRouter);
  const incoming = new http.IncomingMessage(new Socket());
  incoming.method = "POST";
  incoming.url = `/memories/${memoryId}/corrections`;
  incoming.headers.authorization = "Bearer fixture-only";
  Object.assign(incoming, { body: { field: "place", kind: "reject", ...(body as object) } });
  const outgoing = new http.ServerResponse(incoming);
  try {
    return await new Promise<number>((resolve) => {
      outgoing.end = (() => { resolve(outgoing.statusCode); return outgoing; }) as typeof outgoing.end;
      app(incoming, outgoing);
    });
  } finally { _clearTestClient(); _setTestServiceClient(null); }
}

describe("H37 durable owner-selected existing-memory backfill (isolated PostgreSQL)", { skip: !runtime }, () => {
  before(async () => {
    const { PGlite } = await import(pathToFileURL(runtime!).href);
    database = new PGlite() as Database;
    await database.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
      CREATE TABLE public.profiles(id uuid PRIMARY KEY, handle text NOT NULL UNIQUE, username text, display_name text,
        name text, full_name text, bio text, avatar_url text, cover_photo_url text, home_city text, home_country text,
        current_city text, account_status text NOT NULL DEFAULT 'active');
      CREATE TABLE public.highlights(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES profiles(id),
        deleted_at timestamptz, archived_at timestamptz, pinned_at timestamptz, expires_at timestamptz);
      CREATE TABLE public.memory_episodes(id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean NOT NULL, description text);
      CREATE TABLE public.memories(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        state text NOT NULL DEFAULT 'published', trip_id uuid, event_id uuid, place_id text, canonical_location_id uuid,
        title text DEFAULT 'private legacy title', caption text DEFAULT 'private legacy caption',
        updated_at timestamptz NOT NULL DEFAULT '2020-01-01T00:00:00Z');
      CREATE TABLE public.memory_tags(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        tagged_user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, status text NOT NULL);
    `);
    await database.exec(migration("2710_memory_command_kernel_tables.sql"));
    await database.exec(migration("2993_highlight_command_boundary.sql"));
    const intelligence = migration("2130_intel_storage.sql");
    const appendOnlyStart = intelligence.indexOf("CREATE OR REPLACE FUNCTION public.intel_append_only()");
    const appendOnlyEnd = intelligence.indexOf("CREATE OR REPLACE FUNCTION public.intel_append_only_stmt()");
    assert.ok(appendOnlyStart >= 0 && appendOnlyEnd > appendOnlyStart);
    await database.exec(intelligence.slice(appendOnlyStart, appendOnlyEnd));
    await database.exec(migration("3673_memory_corrections.sql"));
    const relations = migration("2994_memory_relations_and_outbox_consumer.sql");
    const start = relations.indexOf("CREATE TABLE IF NOT EXISTS public.memory_relations");
    const end = relations.indexOf("-- ── 4. The outbox");
    assert.ok(start >= 0 && end > start);
    await database.exec(relations.slice(start, end));
    await database.exec(migration("3674_memory_graph_model.sql"));
    assert.equal(await value("to_regprocedure('public.memory_import_batches_create(uuid,uuid,uuid[])')"), null);
    await database.exec(migration("3992_memory_import_batches.sql"));
  });
  after(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.exec(`
      DROP TRIGGER IF EXISTS fixture_fail_outbox ON memory_event_outbox;
      DROP TRIGGER IF EXISTS fixture_reject_memory_write ON memories;
      DROP TRIGGER IF EXISTS fixture_fail_place_revoke ON memory_relations;
      ALTER TABLE memory_tags ENABLE TRIGGER memory_graph_mirror_tags;
      ALTER TABLE memory_corrections ENABLE TRIGGER memory_corrections_erasure_only;
      DELETE FROM auth.users;
      DELETE FROM profiles;
      DELETE FROM memory_command_audit;
      UPDATE feature_flags SET enabled = false;
      INSERT INTO auth.users VALUES ('${OWNER}'), ('${OTHER}');
      INSERT INTO profiles(id, handle) VALUES ('${OWNER}', 'fixture-owner'), ('${OTHER}', 'fixture-other');
      INSERT INTO memories(id, owner_id, trip_id, source_mode) VALUES
        ('${FIRST}', '${OWNER}', '${TRIP}', 'LEGACY_IMPORTED'),
        ('${SECOND}', '${OWNER}', NULL, 'LEGACY_IMPORTED'),
        ('${FOREIGN}', '${OTHER}', NULL, 'LEGACY_IMPORTED');
      INSERT INTO memory_tags(memory_id, tagged_user_id, status) VALUES ('${FIRST}', '${OTHER}', 'approved');
      DELETE FROM memory_relations;
    `);
  });

  it("guards missing/disabled schema and seeds the new flag off without doing backfill", async () => {
    assert.equal(await value("public.memory_import_batches_contract()"), 1);
    assert.deepEqual(await create(), { ok: false, reason: "feature_disabled" });
    assert.equal(await value("(SELECT count(*) FROM memory_import_batches)"), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_relations)"), 0);
    await enable();
    await database.exec("ALTER TABLE memory_tags DISABLE TRIGGER memory_graph_mirror_tags");
    assert.equal(await value("public.memory_import_batches_contract()"), 0);
    assert.deepEqual(await create(), { ok: false, reason: "schema_unavailable" });
  });

  it("refuses foreign, deleted, non-legacy, duplicate, empty and oversized selections without creating a job", async () => {
    await enable();
    assert.deepEqual(await create([FIRST, FOREIGN]), { ok: false, reason: "not_found" });
    await database.exec(`UPDATE memories SET source_mode = 'USER_CREATED' WHERE id = '${SECOND}'`);
    assert.deepEqual(await create(), { ok: false, reason: "not_found" });
    await database.exec(`UPDATE memories SET state = 'deleted' WHERE id = '${FIRST}'`);
    assert.deepEqual(await create([FIRST]), { ok: false, reason: "not_found" });
    for (const ids of [[], [FIRST, FIRST], Array(201).fill(FIRST)]) {
      assert.deepEqual(await create(ids), { ok: false, reason: "invalid_payload" });
    }
    assert.equal(await value("(SELECT count(*) FROM memory_import_batches)"), 0);
  });

  it("requires readable correction storage and its real serialization guard", async () => {
    await enable();
    await database.exec("ALTER TABLE memory_corrections DISABLE TRIGGER memory_graph_revoke_corrected_place");
    try {
      assert.equal(await value("public.memory_import_batches_contract()"), 0);
      assert.deepEqual(await create(), { ok: false, reason: "schema_unavailable" });
    } finally {
      await database.exec("ALTER TABLE memory_corrections ENABLE TRIGGER memory_graph_revoke_corrected_place");
    }
    await database.exec("ALTER TABLE memory_corrections DISABLE TRIGGER memory_corrections_erasure_only");
    assert.equal(await value("public.memory_import_batches_contract()"), 0);
    assert.deepEqual(await create(), { ok: false, reason: "schema_unavailable" });
    await database.exec("ALTER TABLE memory_corrections ENABLE TRIGGER memory_corrections_erasure_only");
    await database.exec("ALTER TABLE memory_corrections RENAME TO fixture_unavailable_corrections");
    try {
      assert.equal(await value("public.memory_import_batches_contract()"), 0);
      assert.deepEqual(await create(), { ok: false, reason: "schema_unavailable" });
    } finally {
      await database.exec("ALTER TABLE fixture_unavailable_corrections RENAME TO memory_corrections");
    }
    assert.equal(await value("public.memory_import_batches_contract()"), 1);
  });

  it("keeps batch identity, canonical IDs/body/timestamps, receipts and checkpoints stable across retries", async () => {
    await enable();
    const original = (await database.query("SELECT * FROM memories ORDER BY id")).rows;
    const first = await create();
    const replay = await create([SECOND, FIRST]);
    assert.equal(replay.batch.id, first.batch.id);
    assert.equal(replay.duplicate, true);
    assert.deepEqual(await create([FIRST]), { ok: false, reason: "idempotency_conflict" });
    const progress = await step(first.batch.id, 0, 1);
    assert.equal(progress.batch.checkpoint, 1);
    assert.equal(progress.batch.completed, 1);
    assert.equal(progress.batch.status, "running");
    assert.equal((await step(first.batch.id, 0, 1)).duplicate, true);
    assert.equal(await value("(SELECT count(*) FROM memory_event_outbox)"), 1);
    assert.deepEqual(await step(first.batch.id, 2), { ok: false, reason: "checkpoint_conflict" });
    assert.equal((await step(first.batch.id, 1)).batch.status, "completed");
    assert.equal((await step(first.batch.id, 2)).duplicate, true);
    for (const table of ["memory_domain_events", "memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) {
      assert.equal(await value(`(SELECT count(*) FROM ${table})`), 2);
    }
    assert.deepEqual((await database.query("SELECT * FROM memories ORDER BY id")).rows, original);
    const payload = (await database.query("SELECT payload_json FROM memory_domain_events")).rows;
    assert.doesNotMatch(JSON.stringify(payload), /private legacy|caption|place_id|tagged_user_id/);
  });

  it("mirrors only actual associations at conservative confidence and leaves weak metadata unresolved", async () => {
    await enable();
    await database.exec(`UPDATE memory_tags SET status = 'pending'; DELETE FROM memory_relations`);
    const batch = (await create()).batch;
    assert.equal((await step(batch.id)).ok, true);
    const edges = (await database.query("SELECT source_id, target_type, target_id, relation_type, confidence, source_mode FROM memory_relations")).rows;
    assert.equal(edges.length, 1);
    assert.deepEqual(edges[0], { source_id: FIRST, target_type: "TRIP", target_id: TRIP,
      relation_type: "RELATED", confidence: "0.500", source_mode: "LEGACY_IMPORTED" });
    assert.equal(await value(`(SELECT count(*) FROM memory_relations WHERE source_id = '${SECOND}')`), 0);
    assert.doesNotMatch(JSON.stringify(edges), /VISITED|CONFIRMED|PERSON|PLACE/);
  });

  it("keeps real-helper provenance, relation identity and canonical source versions stable across jobs", async () => {
    await enable();
    const eventId = "40000000-0000-4000-8000-000000000001";
    const placeId = "50000000-0000-4000-8000-000000000001";
    await database.exec(`UPDATE memories SET event_id = '${eventId}', canonical_location_id = '${placeId}',
      place_id = 'superseded-provider-place' WHERE id = '${FIRST}';
      UPDATE memories SET place_id = 'provider|fallback' WHERE id = '${SECOND}';
      DELETE FROM memory_relations;
      CREATE OR REPLACE FUNCTION fixture_reject_memory_write() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN RAISE EXCEPTION 'backfill must not mutate canonical memory'; END $body$;
      CREATE TRIGGER fixture_reject_memory_write BEFORE UPDATE ON memories
        FOR EACH ROW EXECUTE FUNCTION fixture_reject_memory_write();`);
    const original = (await database.query("SELECT * FROM memories ORDER BY id")).rows;
    assert.equal((await step((await create()).batch.id)).ok, true);
    const edges = (await database.query("SELECT * FROM memory_relations ORDER BY source_id, target_type, target_id")).rows;
    const provenance = (await database.query(`SELECT source_id, target_type, target_id, reason_code, detector_version,
      source_mode, relation_type, confidence FROM memory_relations ORDER BY source_id, target_type, target_id`)).rows;
    const expected = [
      { source_id: FIRST, target_type: "EVENT", target_id: eventId, reason_code: "LEGACY_EVENT_ID" },
      { source_id: FIRST, target_type: "PERSON", target_id: OTHER, reason_code: "LEGACY_APPROVED_TAG" },
      { source_id: FIRST, target_type: "PLACE", target_id: placeId, reason_code: "LEGACY_PLACE" },
      { source_id: FIRST, target_type: "TRIP", target_id: TRIP, reason_code: "LEGACY_TRIP_ID" },
      { source_id: SECOND, target_type: "PLACE", target_id: "provider|fallback", reason_code: "LEGACY_PLACE" },
    ].map((edge) => ({ ...edge, detector_version: "legacy-mirror@1", source_mode: "LEGACY_IMPORTED",
      relation_type: "RELATED", confidence: "0.500" }));
    assert.deepEqual(provenance, expected);
    for (const memoryId of [FIRST, SECOND]) {
      assert.equal(await value("public.memory_graph_mirror_memory($1)", [memoryId]), 0);
    }
    const later = await create([FIRST, SECOND], OWNER, "20000000-0000-4000-8000-000000000002");
    assert.equal((await step(later.batch.id)).ok, true);
    assert.deepEqual((await database.query("SELECT * FROM memory_relations ORDER BY source_id, target_type, target_id")).rows, edges);
    assert.deepEqual((await database.query("SELECT * FROM memories ORDER BY id")).rows, original);
    const eventProvenance = (await database.query(`SELECT DISTINCT payload_json->>'engine_version' AS engine_version,
      payload_json->>'source_mode' AS source_mode FROM memory_domain_events`)).rows;
    assert.deepEqual(eventProvenance, [{ engine_version: "legacy-mirror@1", source_mode: "LEGACY_IMPORTED" }]);
  });

  it("refuses detector-version drift and never relabels conflicting non-legacy provenance", async () => {
    await enable();
    await value("public.memory_graph_mirror_memory($1)", [FIRST]);
    const original = (await database.query("SELECT * FROM memories ORDER BY id")).rows;
    for (const alteration of ["detector_version = 'legacy-mirror@2'",
      "source_mode = 'USER_CREATED', detector_version = 'owner-command@1'"]) {
      await database.exec(`UPDATE memory_relations SET ${alteration}`);
      const edges = (await database.query("SELECT * FROM memory_relations ORDER BY id")).rows;
      const batch = (await create([FIRST])).batch;
      assert.deepEqual(await step(batch.id), { ok: false, reason: "step_failed" });
      assert.equal((await value("public.memory_import_batches_get($1,$2)", [OWNER, batch.id])).batch.checkpoint, 0);
      assert.deepEqual((await database.query("SELECT * FROM memory_relations ORDER BY id")).rows, edges);
      assert.deepEqual((await database.query("SELECT * FROM memories ORDER BY id")).rows, original);
      for (const table of ["memory_domain_events", "memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) {
        assert.equal(await value(`(SELECT count(*) FROM ${table})`), 0);
      }
    }
  });

  for (const correction of [
    { name: "rejected provider place", kind: "reject", place: "old-provider", canonical: null },
    { name: "rejected canonical place", kind: "reject", place: null, canonical: "50000000-0000-4000-8000-000000000001" },
    { name: "replaced place", kind: "assert", place: "replacement-provider", canonical: "50000000-0000-4000-8000-000000000002" },
    { name: "explicit null place", kind: "assert", place: null, canonical: null },
  ]) {
    it(`refuses ${correction.name} corrections instead of certifying raw place fields`, async () => {
      await enable();
      await database.query("UPDATE memories SET place_id = 'old-provider', canonical_location_id = $2 WHERE id = $1",
        [FIRST, correction.name === "rejected provider place" ? null : "50000000-0000-4000-8000-000000000001"]);
      const batch = (await create([FIRST])).batch;
      await database.query(`INSERT INTO memory_corrections(memory_id, owner_id, field, kind, place_id, canonical_location_id, source)
        VALUES ($1, $2, 'place', $3, $4, $5, 'correction_route')`, [FIRST, OWNER, correction.kind, correction.place, correction.canonical]);
      await database.exec(`DELETE FROM memory_relations WHERE source_id = '${FIRST}' AND target_type = 'PLACE'`);
      const original = (await database.query("SELECT * FROM memories ORDER BY id")).rows;
      const corrections = (await database.query("SELECT * FROM memory_corrections ORDER BY id")).rows;
      const edges = (await database.query("SELECT * FROM memory_relations ORDER BY id")).rows;
      for (const attempt of [1, 2]) {
        assert.deepEqual(await step(batch.id), { ok: false, reason: "step_failed" });
        const progress = await value("public.memory_import_batches_get($1,$2)", [OWNER, batch.id]);
        assert.equal(progress.batch.checkpoint, 0);
        assert.equal(progress.batch.attempts, attempt);
        assert.equal(progress.batch.completed, 0);
      }
      assert.deepEqual((await database.query("SELECT * FROM memories ORDER BY id")).rows, original);
      assert.deepEqual((await database.query("SELECT * FROM memory_corrections ORDER BY id")).rows, corrections);
      assert.deepEqual((await database.query("SELECT * FROM memory_relations ORDER BY id")).rows, edges);
      for (const table of ["memory_domain_events", "memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) {
        assert.equal(await value(`(SELECT count(*) FROM ${table})`), 0);
      }
      assert.equal((await value("public.memory_import_batches_abort($1,$2)", [OWNER, batch.id])).batch.status, "aborted");
    });
  }

  for (const correction of [
    { name: "provider rejection", kind: "reject", place: "old-provider", canonical: null },
    { name: "canonical rejection", kind: "reject", place: null, canonical: "50000000-0000-4000-8000-000000000001" },
    { name: "replacement assertion", kind: "assert", place: "replacement-provider", canonical: null },
    { name: "null assertion", kind: "assert", place: null, canonical: null },
  ] as const) {
    it(`revokes an already imported PLACE on ${correction.name} and prevents every legacy remirror`, async () => {
      await enable();
      await database.exec(`UPDATE memories SET place_id = 'old-provider',
        canonical_location_id = '50000000-0000-4000-8000-000000000001'; DELETE FROM memory_relations`);
      const batch = (await create()).batch;
      assert.equal((await step(batch.id)).ok, true);
      await value("public.memory_graph_mirror_memory($1)", [FOREIGN]);
      const original = (await database.query("SELECT * FROM memories ORDER BY id")).rows;
      const unrelated = (await database.query("SELECT * FROM memory_relations WHERE source_id <> $1 ORDER BY id", [FIRST])).rows;
      const nonPlace = (await database.query("SELECT * FROM memory_relations WHERE source_id = $1 AND target_type <> 'PLACE' ORDER BY id", [FIRST])).rows;
      assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE source_id = $1 AND target_type = 'PLACE')", [FIRST]), 1);
      if (correction.kind === "reject") {
        const body = correction.place ? { placeId: correction.place } : { canonicalLocationId: correction.canonical };
        assert.equal(await rejectPlace(FIRST, body, OTHER), 404);
        assert.equal(await rejectPlace(FIRST, body), 204);
        assert.equal(await rejectPlace(FIRST, body), 204);
      } else {
        assert.deepEqual(await recordPlaceCorrections(accountDeletionClient() as any, {
          memoryId: FIRST, ownerId: OWNER, source: "memory_edit",
          rows: [{ kind: correction.kind, place_id: correction.place, canonical_location_id: correction.canonical }],
        }), { ok: true, recorded: 1 });
      }
      assert.equal(await value("(SELECT count(*) FROM memory_corrections WHERE memory_id = $1)", [FIRST]), 1);
      assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE source_id = $1 AND target_type = 'PLACE')", [FIRST]), 0);
      assert.equal(await value("public.memory_graph_mirror_memory($1)", [FIRST]), 0);
      await database.query("UPDATE memories SET place_id = place_id WHERE id = $1", [FIRST]);
      await database.query("UPDATE memory_tags SET status = status WHERE memory_id = $1", [FIRST]);
      assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE source_id = $1 AND target_type = 'PLACE')", [FIRST]), 0);
      assert.deepEqual((await database.query("SELECT * FROM memory_relations WHERE source_id <> $1 ORDER BY id", [FIRST])).rows, unrelated);
      assert.deepEqual((await database.query("SELECT * FROM memory_relations WHERE source_id = $1 AND target_type <> 'PLACE' ORDER BY id", [FIRST])).rows, nonPlace);
      assert.deepEqual((await database.query("SELECT * FROM memories ORDER BY id")).rows, original);
      const later = (await create([FIRST], OWNER, "20000000-0000-4000-8000-000000000002")).batch;
      assert.deepEqual(await step(later.id), { ok: false, reason: "step_failed" });
      assert.equal((await step(batch.id, batch.total)).duplicate, true);
      assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE source_id = $1 AND target_type = 'PLACE')", [FIRST]), 0);
    });
  }

  it("refuses the correction atomically if imported-place revocation cannot complete", async () => {
    await enable();
    await database.query("UPDATE memories SET place_id = 'old-provider' WHERE id = $1", [FIRST]);
    assert.equal((await step((await create([FIRST])).batch.id)).ok, true);
    await database.exec(`CREATE OR REPLACE FUNCTION fixture_fail_place_revoke() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN RAISE EXCEPTION 'fixture place revoke failed'; END $body$;
      CREATE TRIGGER fixture_fail_place_revoke BEFORE DELETE ON memory_relations
        FOR EACH ROW WHEN (OLD.target_type = 'PLACE') EXECUTE FUNCTION fixture_fail_place_revoke();`);
    assert.equal(await rejectPlace(FIRST, { placeId: "old-provider" }), 503);
    assert.equal(await value("(SELECT count(*) FROM memory_corrections)"), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE target_type = 'PLACE')"), 1);
    await database.exec("DROP TRIGGER fixture_fail_place_revoke ON memory_relations");
    assert.equal(await rejectPlace(FIRST, { placeId: "old-provider" }), 204);
    assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE target_type = 'PLACE')"), 0);
  });

  it("audits direct command replay without duplicate events and rechecks authority before replay", async () => {
    await enable();
    const batch = (await create([FIRST])).batch;
    const stored = (await database.query<{ command_id: string }>("SELECT command_id FROM memory_import_batch_items WHERE batch_id = $1", [batch.id])).rows[0]!;
    const command = { command_id: stored.command_id, memory_id: FIRST, actor_user_id: OWNER,
      idempotency_key: `import:${batch.id}:1`, type: "BACKFILL_LEGACY_MEMORY", payload: { batch_id: batch.id, ordinal: 1 } };
    const accepted = await value("public.memory_import_legacy_execute($1::jsonb)", [JSON.stringify(command)]);
    assert.equal(accepted.ok, true);
    const replayed = await value("public.memory_import_legacy_execute($1::jsonb)", [JSON.stringify(command)]);
    assert.equal(replayed.duplicate, true);
    assert.equal(replayed.event_id, accepted.event_id);
    assert.equal(await value("(SELECT count(*) FROM memory_event_outbox)"), 1);
    const refused = await value("public.memory_import_legacy_execute($1::jsonb)", [JSON.stringify({ ...command, actor_user_id: OTHER })]);
    assert.equal(refused.reason, "MEMORY_NOT_FOUND");
    assert.deepEqual((await database.query("SELECT outcome FROM memory_command_audit ORDER BY id")).rows,
      [{ outcome: "accepted" }, { outcome: "duplicate" }, { outcome: "rejected" }]);
    assert.equal((await value("public.memory_import_batches_get($1,$2)", [OWNER, batch.id])).batch.status, "completed");
  });

  it("rechecks corrections before receipt replay and rolls back earlier items when a later source is corrected", async () => {
    await enable();
    const batch = (await create()).batch;
    await database.query(`INSERT INTO memory_corrections(memory_id, owner_id, field, kind, source)
      VALUES ($1, $2, 'place', 'assert', 'memory_edit')`, [SECOND, OWNER]);
    assert.deepEqual(await step(batch.id), { ok: false, reason: "step_failed" });
    assert.equal((await value("public.memory_import_batches_get($1,$2)", [OWNER, batch.id])).batch.checkpoint, 0);
    for (const table of ["memory_relations", "memory_domain_events", "memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) {
      assert.equal(await value(`(SELECT count(*) FROM ${table})`), 0);
    }
    const cleanBatch = (await create([FIRST], OWNER, "20000000-0000-4000-8000-000000000002")).batch;
    assert.equal((await step(cleanBatch.id)).ok, true);
    const commandId = await value("(SELECT command_id FROM memory_import_batch_items WHERE batch_id = $1)", [cleanBatch.id]);
    await database.query(`INSERT INTO memory_corrections(memory_id, owner_id, field, kind, source)
      VALUES ($1, $2, 'place', 'assert', 'memory_edit')`, [FIRST, OWNER]);
    const replay = await value("public.memory_import_legacy_execute($1::jsonb)", [JSON.stringify({
      command_id: commandId, memory_id: FIRST, actor_user_id: OWNER, type: "BACKFILL_LEGACY_MEMORY",
      idempotency_key: `import:${cleanBatch.id}:1`, payload: { batch_id: cleanBatch.id, ordinal: 1 },
    })]);
    assert.deepEqual(replay, { ok: false, reason: "MEMORY_KERNEL_UNAVAILABLE", contract_version: 1 });
    assert.equal(await value("(SELECT count(*) FROM memory_event_outbox)"), 1);
    assert.equal(await value("(SELECT count(*) FROM memory_command_audit WHERE outcome = 'rejected')"), 1);
  });

  it("atomically rolls back every graph/event/receipt/checkpoint in a failed step, then resumes", async () => {
    await enable();
    const batch = (await create()).batch;
    await database.exec(`CREATE OR REPLACE FUNCTION fixture_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.memory_id = '${SECOND}' THEN RAISE EXCEPTION 'private diagnostic must not escape'; END IF; RETURN NEW; END $body$;
      CREATE TRIGGER fixture_fail_outbox BEFORE INSERT ON memory_event_outbox FOR EACH ROW EXECUTE FUNCTION fixture_fail_outbox();`);
    assert.deepEqual(await step(batch.id), { ok: false, reason: "step_failed" });
    for (const table of ["memory_relations", "memory_domain_events", "memory_event_outbox", "memory_command_receipts", "memory_command_audit"]) {
      assert.equal(await value(`(SELECT count(*) FROM ${table})`), 0);
    }
    const failed = await value("public.memory_import_batches_get($1, $2)", [OWNER, batch.id]);
    assert.equal(failed.batch.checkpoint, 0);
    assert.equal(failed.batch.attempts, 1);
    assert.equal(failed.batch.lastErrorCode, "MEMORY_IMPORT_STEP_FAILED");
    await database.exec("DROP TRIGGER fixture_fail_outbox ON memory_event_outbox");
    const resumed = await step(batch.id);
    assert.equal(resumed.batch.status, "completed");
    assert.equal(resumed.batch.attempts, 2);
    assert.equal(resumed.batch.lastErrorCode, null);
  });

  it("scrubs soft-deleted and hard-deleted source references and never recreates their facts", async () => {
    await enable();
    const batch = (await create()).batch;
    await database.exec(`UPDATE memories SET state = 'deleted' WHERE id = '${FIRST}'; DELETE FROM memories WHERE id = '${SECOND}'`);
    assert.equal(await value("(SELECT count(*) FROM memory_import_batch_items WHERE memory_id IS NOT NULL)"), 0);
    const completed = await step(batch.id);
    assert.equal(completed.batch.status, "completed");
    assert.equal(completed.batch.revoked, 2);
    assert.equal(completed.batch.completed, 0);
    assert.equal(await value("(SELECT count(*) FROM memory_event_outbox)"), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_relations)"), 0);
    const replay = await create();
    assert.equal(replay.batch.id, batch.id);
    assert.doesNotMatch(JSON.stringify(replay), new RegExp(`${FIRST}|${SECOND}`));
  });

  it("respects participant revocation after backfill and does not restore it on a later job", async () => {
    await enable();
    await step((await create()).batch.id);
    assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE target_type = 'PERSON')"), 1);
    await database.exec("UPDATE memory_tags SET status = 'removed'");
    assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE target_type = 'PERSON')"), 0);
    const later = await create([FIRST], OWNER, "20000000-0000-4000-8000-000000000002");
    await step(later.batch.id);
    assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE target_type = 'PERSON')"), 0);
  });

  it("allows owner status and abort while disabled, hides foreign jobs and never resumes an aborted job", async () => {
    await enable();
    const batch = (await create()).batch;
    await step(batch.id, 0, 1);
    await database.exec("UPDATE feature_flags SET enabled = false");
    assert.equal((await value("public.memory_import_batches_get($1,$2)", [OWNER, batch.id])).ok, true);
    for (const action of ["get", "abort"]) {
      assert.deepEqual(await value(`public.memory_import_batches_${action}($1,$2)`, [OTHER, batch.id]), { ok: false, reason: "not_found" });
    }
    assert.equal((await value("public.memory_import_batches_abort($1,$2)", [OWNER, batch.id])).batch.status, "aborted");
    await enable();
    assert.equal((await step(batch.id, 1)).batch.status, "aborted");
    assert.equal(await value("(SELECT count(*) FROM memory_domain_events)"), 1);
  });

  it("erases batch metadata on profile/account deletion and invalidates ownership transfers", async () => {
    await enable();
    const batch = (await create()).batch;
    await step(batch.id, 0, 1);
    await database.exec(`UPDATE memories SET owner_id = '${OTHER}' WHERE id = '${FIRST}'`);
    assert.equal(await value(`(SELECT count(*) FROM memory_relations WHERE source_id = '${FIRST}')`), 0);
    assert.equal(await value(`(SELECT count(*) FROM memory_import_batch_items WHERE memory_id = '${FIRST}')`), 0);
    await database.exec(`DELETE FROM profiles WHERE id = '${OWNER}'`);
    assert.equal(await value("(SELECT count(*) FROM memory_import_batches)"), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_import_batch_items)"), 0);
  });

  it("runs actual account deletion with a surviving tombstone profile and erases import metadata through auth", async () => {
    await enable();
    const batch = (await create()).batch;
    assert.equal((await step(batch.id, 0, 1)).ok, true);
    const foreignBatch = (await create([FOREIGN], OTHER)).batch;
    await database.query(`INSERT INTO memory_corrections(memory_id, owner_id, field, kind, source)
      VALUES ($1, $2, 'place', 'assert', 'memory_edit')`, [SECOND, OWNER]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("off-machine access is forbidden in importer deletion fixture"); };
    try {
      const { executeAccountDeletion } = await import("../services/accountDeletion/AccountDeletionService.js");
      const client = accountDeletionClient();
      const result = await executeAccountDeletion(client as any, OWNER, { actorId: null });
      assert.equal(result.ok, true, JSON.stringify({ steps: result.steps.filter((entry) => !entry.ok), warnings: result.warnings }));
      for (const name of ["delete_memories", "anonymise_profile", "auth_delete_user"]) {
        assert.equal(result.steps.find((entry) => entry.step === name)?.ok, true, name);
      }
      assert.equal(client.operations.some((operation) => operation.table === "profiles" && operation.operation === "delete"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(await value("(SELECT account_status FROM profiles WHERE id = $1)", [OWNER]), "deleted");
    assert.equal(await value("(SELECT count(*) FROM auth.users WHERE id = $1)", [OWNER]), 0);
    assert.equal(await value("(SELECT count(*) FROM memories WHERE owner_id = $1)", [OWNER]), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_corrections WHERE owner_id = $1)", [OWNER]), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_import_batches WHERE id = $1)", [batch.id]), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_import_batch_items WHERE batch_id = $1)", [batch.id]), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_relations WHERE owner_id = $1)", [OWNER]), 0);
    assert.equal(await value("(SELECT count(*) FROM memory_event_outbox)"), 0);
    assert.equal((await value("public.memory_import_batches_get($1,$2)", [OTHER, foreignBatch.id])).ok, true);
    assert.deepEqual(await step(batch.id), { ok: false, reason: "not_found" });
  });

  it("keeps client roles out of both stores/RPCs and rejects false graph success", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(await value("has_table_privilege($1, 'memory_import_batches', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')", [role]), false);
    }
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await value("has_function_privilege($1, 'public.memory_import_batches_create(uuid,uuid,uuid[])', 'EXECUTE')", [role]), false);
      assert.equal(await value("has_function_privilege($1, 'public.memory_graph_mirror_memory(uuid)', 'EXECUTE')", [role]), false);
      assert.equal(await value("has_function_privilege($1, 'public.memory_graph_revoke_corrected_place()', 'EXECUTE')", [role]), false);
    }
    assert.equal(await value("has_function_privilege('service_role', 'public.memory_graph_revoke_corrected_place()', 'EXECUTE')"), false);
    assert.equal(await value("has_function_privilege('service_role', 'public.memory_import_batches_create(uuid,uuid,uuid[])', 'EXECUTE')"), true);
    await enable();
    await value("public.memory_graph_mirror_memory($1)", [FIRST]);
    await database.exec("UPDATE memory_relations SET confidence = 0.900");
    assert.deepEqual(await step((await create()).batch.id), { ok: false, reason: "step_failed" });
    assert.equal(await value("(SELECT count(*) FROM memory_domain_events)"), 0);
  });
});
