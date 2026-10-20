import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import http from "node:http";
import express from "express";
import memorySnapshotRouter from "../routes/MemorySnapshot.js";
import { _setTestClient } from "../lib/http.js";
import { captureMemorySnapshot, readMemorySnapshot, replayStoredMemorySnapshot, eraseMemorySnapshots } from "../services/memory/MemorySnapshotStore.js";
import { buildMemorySnapshot } from "../services/memory/MemorySnapshot.js";
import { stableStringify } from "../services/memoryProjections/evidence.js";

const modulePath = process.env.MEMORY_SNAPSHOT_PGLITE_MODULE;
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const MEMORY = "22222222-2222-4222-8222-222222222222";
const EPISODE = "33333333-3333-4333-8333-333333333333";
const MEDIA = "44444444-4444-4444-8444-444444444444";
const EVIDENCE = "55555555-5555-4555-8555-555555555555";
const scope = { ownerId: OWNER, memoryId: MEMORY };

function rehash(snapshot: Record<string, unknown>) {
  const { content_hash: ignoredHash, ...content } = snapshot;
  snapshot.content_hash = createHash("sha256").update(stableStringify(content)).digest("hex");
}

interface Database {
  exec(sql: string): Promise<unknown>;
  query<Row = Record<string, any>>(sql: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
  close(): Promise<void>;
}

describe("MemorySnapshot persisted HTTP/provider/SQL path (isolated single-connection PGlite)", { skip: !modulePath }, () => {
  let database: Database;
  let server: http.Server;
  let base: string;
  const calls: string[] = [];
  const functions = new Set(["memory_snapshot_prepare_v1", "memory_snapshot_append_v1", "memory_snapshot_read_v1", "memory_snapshot_purge_v1"]);
  const client = {
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    from(table: string) {
      assert.ok(["memories", "profiles"].includes(table));
      const filters: string[] = [];
      const values: unknown[] = [];
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { assert.ok(["id", "owner_id"].includes(column)); values.push(value); filters.push(`${column} = $${values.length}`); return query; },
        neq(column: string, value: unknown) { assert.equal(column, "state"); values.push(value); filters.push(`${column} <> $${values.length}`); return query; },
        async maybeSingle() {
          if (table === "profiles") return { data: { account_status: "active" }, error: null };
          const result = await database.query(`SELECT * FROM public.memories WHERE ${filters.join(" AND ")}`, values);
          return { data: result.rows[0] ?? null, error: null };
        },
      };
      return query;
    },
    async rpc(name: string, parameters: Record<string, unknown>) {
      assert.ok(functions.has(name));
      calls.push(name);
      const args = Object.values(parameters);
      try {
        const result = await database.query(`SELECT public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) AS result`, args);
        return { data: result.rows[0].result, error: null };
      } catch (error) {
        return { data: null, error: { code: (error as { code: string }).code } };
      }
    },
  };

  async function reset() {
    await database.exec(`TRUNCATE public.memory_snapshots, public.memory_domain_events, public.memory_evidence,
      public.memory_episodes, public.media_assets, public.memories, auth.users CASCADE;
      UPDATE public.memory_policy SET ttl = NULL, deletion_behavior = 'erase_with_account';
      INSERT INTO public.feature_flags(flag, enabled) VALUES ('memory_snapshots_enabled', true), ('memory_kernel_enabled', true)
        ON CONFLICT (flag) DO UPDATE SET enabled = true;
      INSERT INTO auth.users VALUES ('${OWNER}'), ('${OTHER}');
      INSERT INTO public.memories(id, owner_id, title, caption, starts_at, state, updated_at, location_city)
        VALUES ('${MEMORY}', '${OWNER}', '  Đà Nẵng 🌊  ', E'Nguyên bản\nnot translated', '2020-01-01T01:00:00Z', 'published', '2020-01-02T00:00:00.123456Z', 'Đà Nẵng');
      INSERT INTO public.memory_episodes VALUES ('${EPISODE}', '${OWNER}', 'confirmed', 'trip_context');
      INSERT INTO public.media_assets VALUES ('${MEDIA}', '${OWNER}', 'image', '2020-01-01T01:00:00Z',
        '{"captureProvenance":"camera","private_unrelated":"must not be copied"}', NULL, 'ready', 'active', 'user');
      INSERT INTO public.memory_evidence VALUES
        ('${EVIDENCE}', '${EPISODE}', '${OWNER}', 'media_assets', '${MEDIA}'),
        ('66666666-6666-4666-8666-666666666666', '${EPISODE}', '${OWNER}', 'memories', '${MEMORY}');
      INSERT INTO public.memory_domain_events VALUES ('${MEMORY}', 9007199254740993);`);
    calls.length = 0;
  }

  async function call(method: string, path: string, actor = OWNER, body?: unknown) {
    const response = await fetch(base + path, { method,
      headers: { ...(actor ? { Authorization: `Bearer ${actor}` } : {}), "Content-Type": "application/json", connection: "close" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() as any };
  }

  async function captured() {
    const result = await captureMemorySnapshot(client, scope);
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  }

  before(async () => {
    const { PGlite } = await import(pathToFileURL(modulePath!).href);
    database = new PGlite();
    await database.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
      INSERT INTO public.feature_flags(flag, enabled) VALUES ('memory_kernel_enabled', false);
      CREATE TABLE public.memories(id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
        title text, caption text, starts_at timestamptz, ends_at timestamptz, state text NOT NULL,
        updated_at timestamptz NOT NULL, place_id text, trip_id uuid, location_city text, location_country text);
      CREATE TABLE public.memory_policy(retention_class text PRIMARY KEY, ttl interval, deletion_behavior text NOT NULL);
      INSERT INTO public.memory_policy VALUES ('trip_context', NULL, 'erase_with_account');
      CREATE TABLE public.memory_episodes(id uuid PRIMARY KEY, user_id uuid NOT NULL, state text NOT NULL,
        retention_class text NOT NULL REFERENCES public.memory_policy);
      CREATE TABLE public.memory_evidence(id uuid PRIMARY KEY, episode_id uuid REFERENCES public.memory_episodes ON DELETE CASCADE,
        user_id uuid NOT NULL, source_table text NOT NULL, source_id text NOT NULL);
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, media_type text NOT NULL,
        captured_at timestamptz, provenance jsonb, deleted_at timestamptz, processing_status text, moderation_status text, source_type text);
      CREATE TABLE public.memory_domain_events(memory_id uuid REFERENCES public.memories ON DELETE CASCADE, sequence bigint);`);
    const absent = await client.rpc("memory_snapshot_prepare_v1", { p_owner_id: OWNER, p_memory_id: MEMORY });
    assert.equal(absent.error?.code, "42883", "before proof: no durable snapshot RPC exists in the baseline");
    const migration = await readFile(new URL("../migrations/3990_memory_snapshots.sql", import.meta.url), "utf8");
    await database.exec(migration);
    await database.exec(migration);
    assert.deepEqual((await database.query("SELECT flag, enabled FROM public.feature_flags ORDER BY flag")).rows,
      [{ flag: "memory_kernel_enabled", enabled: false }, { flag: "memory_snapshots_enabled", enabled: false }]);
    _setTestClient(client, true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {} }; next(); });
    app.use(memorySnapshotRouter);
    server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  beforeEach(reset);
  after(async () => {
    _setTestClient(null, false);
    if (server) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    await database?.close();
  });

  it("captures and replays over HTTP through real SQL, preserving originals and existing §17 history", async () => {
    const beforeRows = await database.query("SELECT * FROM public.memories");
    const created = await call("POST", `/memories/${MEMORY}/snapshots`);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const replay = await call("GET", `/memories/${MEMORY}/snapshots/${created.body.snapshot.id}/replay`);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.cache, "private, no-store");
    assert.equal(replay.body.replay.facts.title, "  Đà Nẵng 🌊  ");
    assert.equal(replay.body.replay.facts.caption, "Nguyên bản\nnot translated");
    assert.equal(replay.body.replay.command_cursor, "9007199254740993");
    assert.equal(replay.body.replay.evidence.length, 1);
    assert.equal(replay.body.replay.detection.episodes.length, 1);
    assert.equal(replay.body.replay.eligibility.eligible, true);
    assert.ok(!JSON.stringify(replay.body).includes("must not be copied"));
    assert.deepEqual((await database.query("SELECT * FROM public.memories")).rows, beforeRows.rows);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_domain_events")).rows[0].count, 1);
  });

  it("retries reuse a persisted snapshot; subsequent versions preserve and replay the original", async () => {
    const first = await captured();
    assert.equal((await captured()).id, first.id);
    await database.exec(`UPDATE public.memories SET title = 'Owner correction', updated_at = now() WHERE id = '${MEMORY}'`);
    const second = await captured();
    assert.notEqual(second.id, first.id);
    assert.ok(BigInt(second.revision) > BigInt(first.revision));
    const replay = await replayStoredMemorySnapshot(client, scope, first.id);
    assert.ok(replay.ok);
    assert.equal(replay.value.facts.title, "  Đà Nẵng 🌊  ");
    assert.equal(second.snapshot.source.facts.title, "Owner correction");
    await assert.rejects(database.exec(`UPDATE public.memory_snapshots SET content_hash = repeat('a',64)`), /immutable/);
  });

  it("requires both flags on every capture/replay and permits purge while disabled", async () => {
    const created = await captured();
    for (const flag of ["memory_snapshots_enabled", "memory_kernel_enabled"]) {
      await database.query("UPDATE public.feature_flags SET enabled = false WHERE flag = $1", [flag]);
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "feature_disabled" });
      assert.deepEqual(await readMemorySnapshot(client, scope, created.id), { ok: false, reason: "feature_disabled" });
      const response = await call("GET", `/memories/${MEMORY}/snapshots/${created.id}/replay`);
      assert.equal(response.body.error, "feature_disabled");
      assert.ok(!JSON.stringify(response.body).includes("Đà Nẵng"));
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 1);
      await database.query("DELETE FROM public.feature_flags WHERE flag = $1", [flag]);
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "feature_disabled" });
      assert.deepEqual(await readMemorySnapshot(client, scope, created.id), { ok: false, reason: "feature_disabled" });
      await database.query("INSERT INTO public.feature_flags(flag, enabled) VALUES ($1, true)", [flag]);
    }
    await database.exec(`UPDATE public.feature_flags SET enabled = false; UPDATE public.memories SET state = 'deleted' WHERE id = '${MEMORY}'`);
    assert.deepEqual(await eraseMemorySnapshots(client, scope), { ok: true, value: { purged: 0 } });
  });

  it("does not write or return content when snapshot RPCs or the flag relation are absent", async () => {
    const created = await captured();
    await database.exec("BEGIN; DROP FUNCTION public.memory_snapshot_prepare_v1(uuid,uuid); DROP FUNCTION public.memory_snapshot_read_v1(uuid,uuid,uuid); SAVEPOINT attempt;");
    try {
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "not_deployed" });
      await database.exec("ROLLBACK TO attempt");
      assert.deepEqual(await readMemorySnapshot(client, scope, created.id), { ok: false, reason: "not_deployed" });
      await database.exec("ROLLBACK TO attempt");
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 1);
    } finally { await database.exec("ROLLBACK"); }
    await database.exec("BEGIN; ALTER TABLE public.feature_flags RENAME TO flags_unavailable; SAVEPOINT attempt;");
    try {
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "unavailable" });
      await database.exec("ROLLBACK TO attempt");
      assert.deepEqual(await readMemorySnapshot(client, scope, created.id), { ok: false, reason: "unavailable" });
    } finally { await database.exec("ROLLBACK"); }
  });

  it("owner checks exclude anonymous, public viewers and client-provided facts", async () => {
    const created = await captured();
    calls.length = 0;
    assert.equal((await call("POST", `/memories/${MEMORY}/snapshots`, "")).status, 401);
    assert.equal((await call("GET", `/memories/${MEMORY}/snapshots/${created.id}/replay`, OTHER)).status, 404);
    assert.equal((await call("POST", `/memories/${MEMORY}/snapshots`, OWNER, { ownerId: OTHER, facts: { title: "injected" } })).status, 400);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readMemorySnapshot(client, { ...scope, ownerId: OTHER }, created.id), { ok: false, reason: "not_found" });
  });

  it("fails a stale append and a capture racing deletion without resurrecting evidence", async () => {
    let appendMutation = `UPDATE public.memories SET caption = 'changed concurrently' WHERE id = '${MEMORY}'`;
    const racingClient = { async rpc(name: string, parameters: Record<string, unknown>) {
      if (name === "memory_snapshot_append_v1") await database.exec(appendMutation);
      return client.rpc(name, parameters);
    } };
    assert.deepEqual(await captureMemorySnapshot(racingClient, scope), { ok: false, reason: "conflict" });
    appendMutation = `UPDATE public.memories SET state = 'deleted' WHERE id = '${MEMORY}'`;
    assert.deepEqual(await captureMemorySnapshot(racingClient, scope), { ok: false, reason: "not_found" });
    assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
  });

  it("rejects rehashed evidence whose observation or assertion no longer matches the canonical source", async () => {
    for (const mutate of [
      (signal: any) => { signal.observed_at = "2019-01-01T00:00:00Z"; },
      (signal: any) => { signal.assertion_json.private_message = "not owner capture evidence"; },
      (signal: any) => { signal.confidence = 1; },
    ]) {
      const forgedClient = { async rpc(name: string, parameters: Record<string, unknown>) {
        if (name !== "memory_snapshot_append_v1") return client.rpc(name, parameters);
        const snapshot = structuredClone(parameters.p_snapshot) as any;
        mutate(snapshot.source.signals[0]);
        const forged = buildMemorySnapshot(snapshot.source);
        assert.ok(forged.ok);
        return client.rpc(name, { ...parameters, p_snapshot: forged.value });
      } };
      assert.deepEqual(await captureMemorySnapshot(forgedClient, scope), { ok: false, reason: "conflict" });
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
    }
  });

  for (const [name, mutate] of [
    ["extra envelope fields even with a matching digest", (snapshot: any) => { snapshot.private_fact = "must never persist"; rehash(snapshot); }],
    ["unverified digest", (snapshot: any) => { snapshot.content_hash = "0".repeat(64); }],
    ["numeric digest", (snapshot: any) => { snapshot.content_hash = 1e63; }],
    ["missing capture timestamp", (snapshot: any) => { delete snapshot.source.captured_at; }],
    ["non-ISO capture timestamp even with a matching digest", (snapshot: any) => { snapshot.source.captured_at = "now"; rehash(snapshot); }],
  ] as const) {
    it(`rejects ${name} before insert and leaves a clean retry`, async () => {
      let reply: unknown;
      const forgedClient = { async rpc(name: string, parameters: Record<string, unknown>) {
        if (name !== "memory_snapshot_append_v1") return client.rpc(name, parameters);
        const snapshot = structuredClone(parameters.p_snapshot);
        mutate(snapshot);
        const response = await client.rpc(name, { ...parameters, p_snapshot: snapshot });
        reply = response;
        return response;
      } };
      const result = await captureMemorySnapshot(forgedClient, scope);
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
      assert.deepEqual(reply, { data: { ok: false, reason: "conflict" }, error: null });
      assert.deepEqual(result, { ok: false, reason: "conflict" });
      const clean = await captured();
      assert.ok((await replayStoredMemorySnapshot(client, scope, clean.id)).ok);
      assert.equal((await captured()).id, clean.id);
    });
  }

  it("refuses rehashed noncanonical signal ordering before insert and permits clean retry", async () => {
    await database.exec(`INSERT INTO public.media_assets SELECT '77777777-7777-4777-8777-777777777777',
      owner_user_id, 'video', captured_at, provenance, deleted_at, processing_status, moderation_status, source_type
      FROM public.media_assets WHERE id = '${MEDIA}';
      INSERT INTO public.memory_evidence VALUES ('88888888-8888-4888-8888-888888888888', '${EPISODE}', '${OWNER}',
        'media_assets', '77777777-7777-4777-8777-777777777777');`);
    const forgedClient = { async rpc(name: string, parameters: Record<string, unknown>) {
      if (name !== "memory_snapshot_append_v1") return client.rpc(name, parameters);
      const snapshot = structuredClone(parameters.p_snapshot) as { source: { signals: unknown[] }; content_hash: string };
      snapshot.source.signals.reverse();
      rehash(snapshot);
      return client.rpc(name, { ...parameters, p_snapshot: snapshot });
    } };
    assert.deepEqual(await captureMemorySnapshot(forgedClient, scope), { ok: false, reason: "conflict" });
    assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
    const clean = await captured();
    assert.equal(clean.snapshot.source.signals.length, 2);
    assert.ok((await replayStoredMemorySnapshot(client, scope, clean.id)).ok);
  });

  for (const [name, mutation] of [
    ["capture time cleared", "captured_at = NULL"],
    ["screenshot provenance", `provenance = '{"captureProvenance":"screenshot"}'`],
    ["downloaded provenance", `provenance = '{"captureProvenance":null,"capture_provenance":"downloaded"}'`],
    ["imported provenance", `provenance = '{"origin":"imported_without_capture"}'`],
  ]) {
    it(`physically erases ${name} while disabled and refuses stale append`, async () => {
      const created = await captured();
      await database.exec(`UPDATE public.feature_flags SET enabled = false;
        UPDATE public.media_assets SET ${mutation} WHERE id = '${MEDIA}'`);
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
      await database.exec("UPDATE public.feature_flags SET enabled = true");
      assert.deepEqual(await replayStoredMemorySnapshot(client, scope, created.id), { ok: false, reason: "not_found" });
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "unavailable" });
      const stale = await client.rpc("memory_snapshot_append_v1", {
        p_owner_id: OWNER, p_memory_id: MEMORY, p_snapshot: created.snapshot,
      });
      assert.deepEqual(stale, { data: { ok: false, reason: "unavailable" }, error: null });
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
    });

    it(`read validation erases ${name} even when the revocation trigger missed it`, async () => {
      const created = await captured();
      await database.exec("ALTER TABLE public.media_assets DISABLE TRIGGER memory_snapshots_media_revoked");
      try { await database.exec(`UPDATE public.media_assets SET ${mutation} WHERE id = '${MEDIA}'`); }
      finally { await database.exec("ALTER TABLE public.media_assets ENABLE TRIGGER memory_snapshots_media_revoked"); }
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 1);
      assert.deepEqual(await replayStoredMemorySnapshot(client, scope, created.id), { ok: false, reason: "not_found" });
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
    });

    it(`refuses ${name} between preparation and first append without storing stale evidence`, async () => {
      const racingClient = { async rpc(name: string, parameters: Record<string, unknown>) {
        if (name === "memory_snapshot_append_v1") await database.exec(`UPDATE public.media_assets SET ${mutation} WHERE id = '${MEDIA}'`);
        return client.rpc(name, parameters);
      } };
      assert.deepEqual(await captureMemorySnapshot(racingClient, scope), { ok: false, reason: "unavailable" });
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
    });
  }

  it("never waits on a source row after taking another source lock", async () => {
    const enabled = (await database.query<{ definition: string }>("SELECT pg_get_functiondef('memory_snapshot_private.enabled()'::regprocedure) AS definition")).rows[0].definition;
    assert.match(enabled, /FOR SHARE NOWAIT/);
    for (const signature of ["memory_snapshot_private.prepare(uuid,uuid)", "public.memory_snapshot_read_v1(uuid,uuid,uuid)"]) {
      const definition = (await database.query<{ definition: string }>("SELECT pg_get_functiondef($1::regprocedure) AS definition", [signature])).rows[0].definition;
      const locks = [...definition.matchAll(/FOR (?:KEY SHARE|SHARE|UPDATE)\b[^;]*;/g)];
      assert.equal(locks.length, signature.includes("prepare") ? 6 : 7);
      assert.ok(locks.every(([statement]) => /NOWAIT\s*;/.test(statement)), signature);
      assert.match(definition, /FROM auth\.users WHERE id = p_owner_id FOR KEY SHARE NOWAIT/);
      assert.match(definition, /EXCEPTION WHEN lock_not_available THEN\s+RETURN jsonb_build_object\('ok', false, 'reason', 'unavailable'\)/);
    }
  });

  it("rolls back partial preparation and refuses all content when source locking fails", async () => {
    const created = await captured();
    await database.exec(`BEGIN;
      CREATE OR REPLACE FUNCTION memory_snapshot_private.enabled() RETURNS boolean LANGUAGE plpgsql AS $fn$
      BEGIN
        INSERT INTO public.memory_domain_events VALUES ('${MEMORY}', 1);
        RAISE EXCEPTION 'fixture source contention' USING ERRCODE = '55P03';
      END;
      $fn$;`);
    try {
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "unavailable" });
      assert.deepEqual(await client.rpc("memory_snapshot_append_v1", {
        p_owner_id: OWNER, p_memory_id: MEMORY, p_snapshot: created.snapshot,
      }), { data: { ok: false, reason: "unavailable" }, error: null });
      assert.deepEqual(await readMemorySnapshot(client, scope, created.id), { ok: false, reason: "unavailable" });
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_domain_events")).rows[0].count, 1);
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 1);
    } finally { await database.exec("ROLLBACK"); }
    assert.ok((await readMemorySnapshot(client, scope, created.id)).ok);
  });

  for (const [name, mutation] of [
    ["Memory soft delete", `UPDATE public.memories SET state = 'deleted' WHERE id = '${MEMORY}'`],
    ["moderation removal", `UPDATE public.memories SET state = 'removed' WHERE id = '${MEMORY}'`],
    ["raw evidence erasure", `DELETE FROM public.memory_evidence WHERE id = '${EVIDENCE}'`],
    ["episode hard-delete cascade", `DELETE FROM public.memory_episodes WHERE id = '${EPISODE}'`],
    ["episode retirement", `UPDATE public.memory_episodes SET state = 'rejected' WHERE id = '${EPISODE}'`],
    ["media deletion", `UPDATE public.media_assets SET deleted_at = now() WHERE id = '${MEDIA}'`],
    ["media moderation revocation", `UPDATE public.media_assets SET moderation_status = 'removed' WHERE id = '${MEDIA}'`],
    ["media ownership change", `UPDATE public.media_assets SET owner_user_id = '${OTHER}' WHERE id = '${MEDIA}'`],
    ["retention policy change", "UPDATE public.memory_policy SET ttl = interval '1 day'"],
    ["Memory hard delete", `DELETE FROM public.memories WHERE id = '${MEMORY}'`],
    ["account deletion", `DELETE FROM auth.users WHERE id = '${OWNER}'`],
  ]) {
    it(`physically erases snapshot content on ${name}`, async () => {
      const created = await captured();
      await database.exec(mutation);
      assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
      assert.deepEqual(await readMemorySnapshot(client, scope, created.id), { ok: false, reason: "not_found" });
    });
  }

  it("fails closed rather than persisting foreign or time-limited evidence", async () => {
    await database.exec(`UPDATE public.media_assets SET owner_user_id = '${OTHER}' WHERE id = '${MEDIA}'`);
    assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "unavailable" });
    await reset();
    await database.exec("UPDATE public.memory_policy SET ttl = interval '1 day'");
    assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "unavailable" });
    await reset();
    await database.exec(`UPDATE public.memory_evidence SET source_table = 'telegraph_messages' WHERE id = '${EVIDENCE}'`);
    assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason: "unavailable" });
    assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
  });

  it("keeps table writes private, denies client RPCs and retains owner-only RLS as defense in depth", async () => {
    await captured();
    const grants = await database.query(`SELECT
      has_table_privilege('authenticated','public.memory_snapshots','SELECT') AS client_read,
      has_table_privilege('service_role','public.memory_snapshots','INSERT') AS direct_write,
      has_function_privilege('anon','public.memory_snapshot_read_v1(uuid,uuid,uuid)','EXECUTE') AS anon_read,
      has_function_privilege('authenticated','public.memory_snapshot_append_v1(uuid,uuid,jsonb)','EXECUTE') AS client_write,
      has_function_privilege('service_role','public.memory_snapshot_append_v1(uuid,uuid,jsonb)','EXECUTE') AS server_write`);
    assert.deepEqual(grants.rows[0], { client_read: false, direct_write: false, anon_read: false, client_write: false, server_write: true });
    await database.exec(`BEGIN; GRANT SELECT ON public.memory_snapshots TO authenticated; SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.sub = '${OTHER}';`);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 0);
    await database.exec(`SET LOCAL request.jwt.claim.sub = '${OWNER}'`);
    assert.equal((await database.query("SELECT count(*)::int AS count FROM public.memory_snapshots")).rows[0].count, 1);
    await database.exec("ROLLBACK");
  });

  it("does not erase a live or foreign Memory through the deletion adapter; deleted retry is idempotent", async () => {
    await captured();
    assert.deepEqual(await eraseMemorySnapshots(client, scope), { ok: false, reason: "not_found" });
    assert.deepEqual(await eraseMemorySnapshots(client, { ...scope, ownerId: OTHER }), { ok: false, reason: "not_found" });
    await database.exec(`UPDATE public.memories SET state = 'deleted' WHERE id = '${MEMORY}'`);
    assert.deepEqual(await eraseMemorySnapshots(client, scope), { ok: true, value: { purged: 0 } });
    assert.deepEqual(await eraseMemorySnapshots(client, scope), { ok: true, value: { purged: 0 } });
  });
});

describe("MemorySnapshot storage failure contract", () => {
  it("never treats missing, malformed, denied or thrown storage as an empty successful snapshot/purge", async () => {
    for (const code of ["42883", "PGRST202", "42P01", "42703", "42501"]) {
      const client = { rpc: async () => ({ data: null, error: { code } }) };
      const reason = ["42883", "PGRST202"].includes(code) ? "not_deployed" : "unavailable";
      assert.deepEqual(await captureMemorySnapshot(client, scope), { ok: false, reason });
      assert.deepEqual(await eraseMemorySnapshots(client, scope), { ok: false, reason });
    }
    for (const data of [null, [], {}, { ok: true }, { ok: false, reason: "made_up" }]) {
      assert.deepEqual(await captureMemorySnapshot({ rpc: async () => ({ data, error: null }) }, scope), { ok: false, reason: "unavailable" });
    }
    assert.deepEqual(await captureMemorySnapshot({ rpc: async () => { throw new Error("private content must not leak"); } }, scope), { ok: false, reason: "unavailable" });
  });
});
