import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { memoryImportPostgresIds, memoryImportPostgresSchema, memoryImportPostgresSeed } from "./memoryImportBatchesPostgresFixture.js";

const binaryDirectory = process.env.MEMORY_IMPORT_POSTGRES_BIN;
const run = promisify(execFile);
const nativeEnvironment = { PATH: "/usr/bin:/bin", HOME: tmpdir(), LC_ALL: "C" };
const { owner, other, first, second, foreign, key } = memoryImportPostgresIds;
const literal = (value: unknown) => `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
const settled = (promise: Promise<string>) => promise.then(
  (value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

class ImportNativeSession {
  private process: ChildProcessWithoutNullStreams;
  private output = "";
  private errors = "";
  private closed: Promise<void>;
  private pending?: { marker: string; resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

  constructor(binary: string, socket: string) {
    this.process = spawn(binary, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", "55432", "-U", "postgres", "-d", "postgres"],
      { env: nativeEnvironment, stdio: "pipe" });
    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.output += chunk;
      const pending = this.pending;
      if (!pending) return;
      const position = this.output.indexOf(`${pending.marker}\n`);
      if (position < 0) return;
      clearTimeout(pending.timer);
      const result = this.output.slice(0, position).trim();
      this.output = this.output.slice(position + pending.marker.length + 1);
      this.pending = undefined;
      pending.resolve(result);
    });
    this.process.stderr.on("data", (chunk: string) => { this.errors = (this.errors + chunk).slice(-65536); });
    this.process.on("error", (error) => this.fail(error));
    this.closed = new Promise((resolve) => this.process.once("close", (code) => {
      this.fail(new Error(`native psql exited ${code}: ${this.errors}`));
      resolve();
    }));
  }

  private fail(error: Error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = undefined;
  }

  query(sql: string): Promise<string> {
    assert.equal(this.pending, undefined, "one command per native session at a time");
    assert.equal(this.process.exitCode, null, this.errors);
    assert.equal(this.process.signalCode, null, this.errors);
    return new Promise((resolve, reject) => {
      const marker = `import_${randomUUID().replaceAll("-", "")}`;
      const timer = setTimeout(() => {
        this.fail(new Error(`native import command exceeded 8 seconds: ${this.errors}`));
        this.process.kill("SIGKILL");
      }, 8000);
      this.pending = { marker, resolve, reject, timer };
      this.process.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return this.closed;
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 1000);
    this.process.stdin.end("ROLLBACK;\n\\q\n");
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

describe("H37 native import/correction locks (fresh socket-only disposable cluster)", {
  skip: binaryDirectory ? false : "MEMORY_IMPORT_POSTGRES_BIN unset; native PostgreSQL concurrency is NOT verified",
  concurrency: false,
  timeout: 120000,
}, () => {
  let root: string;
  let socket: string;
  let holder: ImportNativeSession;
  let reader: ImportNativeSession;
  let readerPid: number;
  let foreignBefore: string;
  const json = async (session: ImportNativeSession, sql: string): Promise<any> => JSON.parse(await session.query(sql));
  const newSession = async () => {
    const session = new ImportNativeSession(join(binaryDirectory!, "psql"), socket);
    await session.query("SET lock_timeout = '3s'; SET statement_timeout = '5s'; SET idle_in_transaction_session_timeout = '10s'; SET deadlock_timeout = '100ms';");
    return session;
  };
  const create = (ids = [first]) => json(holder,
    `SELECT public.memory_import_batches_create('${owner}', '${key}', ARRAY[${ids.map(literal).join(",")}]::uuid[]);`);
  const stepSql = (batchId: string, checkpoint = 0) =>
    `SELECT public.memory_import_batches_step('${owner}', '${batchId}', ${checkpoint}, 25);`;
  const progress = (batchId: string) => json(holder, `SELECT public.memory_import_batches_get('${owner}', '${batchId}');`);
  const command = (batchId: string) => json(holder, `SELECT jsonb_build_object('command_id', command_id,
    'memory_id', memory_id, 'actor_user_id', '${owner}', 'type', 'BACKFILL_LEGACY_MEMORY',
    'idempotency_key', 'import:' || batch_id::text || ':' || ordinal::text,
    'payload', jsonb_build_object('batch_id', batch_id, 'ordinal', ordinal))
    FROM memory_import_batch_items WHERE batch_id = '${batchId}' AND ordinal = 1;`);
  const executeSql = (envelope: unknown) => `SELECT public.memory_import_legacy_execute(${literal(envelope)}::jsonb);`;
  const correctionSql = `INSERT INTO public.memory_corrections(memory_id, owner_id, field, kind, place_id, source)
    VALUES ('${first}', '${owner}', 'place', 'reject', 'fixture-provider', 'correction_route');`;
  const mirrorSql = `SELECT public.memory_graph_mirror_memory('${first}');`;
  const placeCount = () => holder.query(`SELECT count(*) FROM memory_relations WHERE source_id = '${first}' AND target_type = 'PLACE';`);
  const foreignState = () => holder.query(`SELECT jsonb_build_object('memory', (SELECT to_jsonb(memory_row) FROM memories memory_row WHERE id = '${foreign}'),
    'edges', (SELECT jsonb_agg(relation ORDER BY id) FROM memory_relations relation WHERE source_id = '${foreign}'),
    'profile', (SELECT account_status FROM profiles WHERE id = '${other}'), 'auth', (SELECT count(*) FROM auth.users WHERE id = '${other}'));`);
  const journalCounts = () => json(holder, `SELECT jsonb_build_object(
    'events', (SELECT count(*) FROM memory_domain_events), 'outbox', (SELECT count(*) FROM memory_event_outbox),
    'receipts', (SELECT count(*) FROM memory_command_receipts), 'audit', (SELECT count(*) FROM memory_command_audit));`);
  const blocked = async (observer: ImportNativeSession, waiterPid: number) => {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      if (await observer.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${waiterPid}));`) === "t") return;
      await pause();
    }
    assert.fail("the second backend never waited on the intended first transaction");
  };
  const accepted = async (pending: ReturnType<typeof settled>) => {
    const result = await pending;
    assert.ok(result.ok, result.ok ? "" : String(result.error));
    return result.value;
  };

  before(async (context) => {
    assert.ok(binaryDirectory && isAbsolute(binaryDirectory) && !binaryDirectory.includes("://"), "Only an absolute local binary directory is accepted, never a database URL");
    for (const binary of ["initdb", "pg_ctl", "psql", "postgres"]) await access(join(binaryDirectory, binary), constants.X_OK);
    root = await mkdtemp(join(tmpdir(), "MemoryImport-pg-"));
    socket = join(root, "socket");
    await mkdir(socket, { mode: 0o700 });
    await run(join(binaryDirectory, "initdb"), ["-D", join(root, "data"), "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"],
      { env: nativeEnvironment, timeout: 15000 });
    await run(join(binaryDirectory, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-t", "10",
      "-o", `-F -h '' -k '${socket}' -p 55432`, "start"], { env: nativeEnvironment, timeout: 15000 });
    holder = await newSession();
    assert.equal(await holder.query("SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses') = '';"), "t");
    if ("diagnostic" in context) context.diagnostic(`Native PostgreSQL ${await holder.query("SHOW server_version;")}; disposable cluster ${root}; no TCP listener`);
    await holder.query(await memoryImportPostgresSchema());
    assert.equal(await holder.query("SELECT enabled FROM feature_flags WHERE flag = 'memory_import_batches_enabled';"), "f");
    await holder.close();
  });

  beforeEach(async () => {
    holder = await newSession();
    reader = await newSession();
    readerPid = Number(await reader.query("SELECT pg_backend_pid();"));
    assert.notEqual(Number(await holder.query("SELECT pg_backend_pid();")), readerPid);
    await holder.query(memoryImportPostgresSeed());
    foreignBefore = await foreignState();
  });

  afterEach(async () => {
    try { assert.equal(await foreignState(), foreignBefore, "another owner's memory, graph and account remain unchanged"); }
    finally { await holder?.close(); await reader?.close(); }
  });

  after(async (context) => {
    await holder?.close();
    await reader?.close();
    if (root && await access(join(root, "data", "postmaster.pid")).then(() => true, () => false)) {
      await run(join(binaryDirectory!, "pg_ctl"), ["-D", join(root, "data"), "-m", "immediate", "-w", "-t", "10", "stop"],
        { env: nativeEnvironment, timeout: 15000 });
    }
    if (root) {
      await rm(root, { recursive: true, force: true });
      assert.equal(await access(root).then(() => true, () => false), false);
      if ("diagnostic" in context) context.diagnostic(`Cleanup verified: stopped server and removed ${root}`);
    }
  });

  it("avoids the exact Memory-first import / tag-first approved-update lock inversion", async () => {
    const batch = (await create()).batch;
    await holder.query(`BEGIN; SELECT id FROM memories WHERE id = '${first}' FOR UPDATE;`);
    let tagFinished = false;
    const tag = settled(reader.query(`BEGIN; UPDATE memory_tags SET status = 'approved' WHERE memory_id = '${first}'; COMMIT;`))
      .then((result) => { tagFinished = true; return result; });
    const deadline = Date.now() + 1500;
    let tagWaitingOnMemory = false;
    while (!tagFinished && Date.now() < deadline) {
      tagWaitingOnMemory = await holder.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${readerPid}));`) === "t";
      if (tagWaitingOnMemory) break;
      await pause();
    }
    assert.ok(tagFinished || tagWaitingOnMemory, "the update must reach its actual AFTER trigger");
    const imported = await json(holder, stepSql(batch.id));
    await holder.query("COMMIT;");
    await accepted(tag);
    assert.doesNotMatch(await readFile(join(root, "postgres.log"), "utf8"), /deadlock detected|40P01/i);
    assert.equal(imported.ok, true);
    assert.equal(await placeCount(), "1");
    assert.equal(await holder.query(`SELECT count(*) FROM memory_relations WHERE source_id = '${first}' AND target_type = 'PERSON';`), "1");
    assert.deepEqual(await journalCounts(), { events: 1, outbox: 1, receipts: 1, audit: 1 });
  });

  it("import-first then rejection waits, purges the committed place, and refuses receipt replay", async () => {
    const batch = (await create()).batch;
    const envelope = await command(batch.id);
    await holder.query("BEGIN;");
    assert.equal((await json(holder, stepSql(batch.id))).ok, true);
    const correction = settled(reader.query(correctionSql));
    await blocked(holder, readerPid);
    await holder.query("COMMIT;");
    await accepted(correction);
    assert.equal(await placeCount(), "0");
    assert.deepEqual(await json(holder, executeSql(envelope)), { ok: false, reason: "MEMORY_KERNEL_UNAVAILABLE", contract_version: 1 });
    assert.equal(await holder.query(mirrorSql), "0");
    await holder.query(`UPDATE memories SET place_id = place_id WHERE id = '${first}'; UPDATE memory_tags SET status = status WHERE memory_id = '${first}';`);
    assert.equal(await placeCount(), "0");
    assert.equal((await json(holder, stepSql(batch.id))).duplicate, true);
    assert.deepEqual(await journalCounts(), { events: 1, outbox: 1, receipts: 1, audit: 2 });
  });

  it("a contended approved-tag mirror never bypasses a correction or restores its rejected place", async () => {
    assert.equal((await json(holder, stepSql((await create()).batch.id))).ok, true);
    await holder.query(`BEGIN; ${correctionSql}`);
    await reader.query(`UPDATE memory_tags SET status = 'approved' WHERE memory_id = '${first}';`);
    await holder.query("COMMIT;");
    assert.equal(await placeCount(), "0");
    assert.equal(await holder.query(mirrorSql), "0");
    assert.equal(await holder.query(`SELECT count(*) FROM memory_relations WHERE source_id = '${first}' AND target_type = 'PERSON';`), "1");
    assert.match(await readFile(join(root, "postgres.log"), "utf8"), /SQLSTATE 55P03/);
  });

  it("consent removal still deletes PERSON immediately while the Memory is locked", async () => {
    assert.equal((await json(holder, stepSql((await create()).batch.id))).ok, true);
    await holder.query(`BEGIN; SELECT id FROM memories WHERE id = '${first}' FOR UPDATE;`);
    await reader.query(`UPDATE memory_tags SET status = 'pending' WHERE memory_id = '${first}';`);
    assert.equal(await holder.query(`SELECT count(*) FROM memory_relations WHERE source_id = '${first}' AND target_type = 'PERSON';`), "0");
    await holder.query("COMMIT;");
    assert.equal(await holder.query(mirrorSql), "0");
    assert.equal(await placeCount(), "1");
    assert.equal(await holder.query(`SELECT count(*) FROM memory_relations WHERE source_id = '${first}' AND target_type = 'PERSON';`), "0");
  });

  for (const finish of ["COMMIT", "ROLLBACK"]) {
    it(`correction-first then import waits and rechecks after ${finish}`, async () => {
      const batch = (await create()).batch;
      await holder.query(`BEGIN; ${correctionSql}`);
      const importing = settled(reader.query(stepSql(batch.id)));
      await blocked(holder, readerPid);
      await holder.query(`${finish};`);
      const result = JSON.parse(await accepted(importing));
      if (finish === "COMMIT") {
        assert.deepEqual(result, { ok: false, reason: "step_failed" });
        assert.equal((await progress(batch.id)).batch.checkpoint, 0);
        assert.equal(await placeCount(), "0");
        assert.deepEqual(await journalCounts(), { events: 0, outbox: 0, receipts: 0, audit: 0 });
      } else {
        assert.equal(result.ok, true);
        assert.equal(await placeCount(), "1");
        assert.deepEqual(await journalCounts(), { events: 1, outbox: 1, receipts: 1, audit: 1 });
      }
    });
  }

  it("mirror-first then correction serializes without retaining a rejected PLACE", async () => {
    await holder.query("BEGIN;");
    assert.ok(Number(await holder.query(mirrorSql)) > 0);
    const correction = settled(reader.query(correctionSql));
    await blocked(holder, readerPid);
    await holder.query("COMMIT;");
    await accepted(correction);
    assert.equal(await placeCount(), "0");
    assert.equal(await holder.query(mirrorSql), "0");
  });

  it("correction-first makes a contended direct remirror fail, never report success or restore PLACE", async () => {
    await holder.query(mirrorSql);
    await holder.query(`BEGIN; ${correctionSql}`);
    const mirrored = await settled(reader.query(mirrorSql));
    assert.equal(mirrored.ok, false);
    assert.match(String(mirrored.ok ? "" : mirrored.error), /could not obtain lock on row/i);
    await holder.query("COMMIT;");
    assert.equal(await placeCount(), "0");
    reader = await newSession();
    assert.equal(await reader.query(mirrorSql), "0");
  });

  it("concurrent canonical command replay waits for the receipt and emits no duplicate event", async () => {
    const batch = (await create()).batch;
    const envelope = await command(batch.id);
    await holder.query("BEGIN;");
    const original = await json(holder, executeSql(envelope));
    assert.equal(original.ok, true);
    const replaying = settled(reader.query(executeSql(envelope)));
    await blocked(holder, readerPid);
    await holder.query("COMMIT;");
    const replay = JSON.parse(await accepted(replaying));
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event_id, original.event_id);
    assert.deepEqual(await journalCounts(), { events: 1, outbox: 1, receipts: 1, audit: 2 });
  });

  it("a receipt replay waiting on a correction rechecks authority rather than returning old success", async () => {
    const batch = (await create()).batch;
    const envelope = await command(batch.id);
    assert.equal((await json(holder, stepSql(batch.id))).ok, true);
    await holder.query(`BEGIN; ${correctionSql}`);
    const replaying = settled(reader.query(executeSql(envelope)));
    await blocked(holder, readerPid);
    await holder.query("COMMIT;");
    assert.deepEqual(JSON.parse(await accepted(replaying)), { ok: false, reason: "MEMORY_KERNEL_UNAVAILABLE", contract_version: 1 });
    assert.equal(await placeCount(), "0");
    assert.deepEqual(await journalCounts(), { events: 1, outbox: 1, receipts: 1, audit: 2 });
  });

  for (const [name, deletion] of [
    ["soft deletion", `UPDATE memories SET state = 'deleted' WHERE id = '${first}';`],
    ["hard deletion", `DELETE FROM memories WHERE id = '${first}';`],
  ]) {
    it(`${name} first makes a waiting import revoke the source without fabricating events`, async () => {
      const batch = (await create()).batch;
      const envelope = await command(batch.id);
      await holder.query(`BEGIN; ${deletion}`);
      const importing = settled(reader.query(stepSql(batch.id)));
      await blocked(holder, readerPid);
      await holder.query("COMMIT;");
      const result = JSON.parse(await accepted(importing));
      assert.equal(result.ok, true);
      assert.equal(result.batch.revoked, 1);
      assert.equal(result.batch.completed, 0);
      assert.deepEqual(await journalCounts(), { events: 0, outbox: 0, receipts: 0, audit: 0 });
      assert.equal((await json(holder, executeSql(envelope))).reason, "MEMORY_NOT_FOUND");
      assert.equal(await holder.query(mirrorSql), "0");
    });

    it(`import-first ${name} waits then scrubs source references and blocks replay`, async () => {
      const batch = (await create()).batch;
      const envelope = await command(batch.id);
      await holder.query("BEGIN;");
      assert.equal((await json(holder, stepSql(batch.id))).ok, true);
      const deleting = settled(reader.query(deletion));
      await blocked(holder, readerPid);
      await holder.query("COMMIT;");
      await accepted(deleting);
      assert.equal((await progress(batch.id)).batch.revoked, 1);
      assert.equal(await holder.query(`SELECT count(*) FROM memory_relations WHERE source_id = '${first}';`), "0");
      assert.equal((await json(holder, executeSql(envelope))).reason, "MEMORY_NOT_FOUND");
      assert.equal(await holder.query(mirrorSql), "0");
    });
  }

  it("waiting account deletion keeps the profile tombstone but cascades import metadata through auth", async () => {
    const batch = (await create()).batch;
    await holder.query("BEGIN;");
    assert.equal((await json(holder, stepSql(batch.id))).ok, true);
    const deleting = settled(reader.query(`BEGIN;
      UPDATE profiles SET account_status = 'deleted' WHERE id = '${owner}';
      DELETE FROM memories WHERE owner_id = '${owner}'; DELETE FROM auth.users WHERE id = '${owner}'; COMMIT;`));
    await blocked(holder, readerPid);
    await holder.query("COMMIT;");
    await accepted(deleting);
    assert.equal(await holder.query(`SELECT account_status FROM profiles WHERE id = '${owner}';`), "deleted");
    assert.equal(await holder.query(`SELECT count(*) FROM auth.users WHERE id = '${owner}';`), "0");
    assert.equal(await holder.query("SELECT count(*) FROM memory_import_batches;"), "0");
    assert.equal(await holder.query("SELECT count(*) FROM memory_import_batch_items;"), "0");
    assert.equal(await holder.query(`SELECT count(*) FROM memory_relations WHERE owner_id = '${owner}';`), "0");
    assert.deepEqual(await json(holder, stepSql(batch.id)), { ok: false, reason: "not_found" });
  });

  it("abort-first serializes a waiting step and never resumes the aborted job", async () => {
    const batch = (await create()).batch;
    const envelope = await command(batch.id);
    await holder.query("BEGIN;");
    assert.equal((await json(holder, `SELECT public.memory_import_batches_abort('${owner}', '${batch.id}');`)).batch.status, "aborted");
    const importing = settled(reader.query(stepSql(batch.id)));
    await blocked(holder, readerPid);
    await holder.query("COMMIT;");
    const result = JSON.parse(await accepted(importing));
    assert.equal(result.batch.status, "aborted");
    assert.equal(result.batch.checkpoint, 0);
    assert.equal(result.duplicate, true);
    assert.deepEqual(await journalCounts(), { events: 0, outbox: 0, receipts: 0, audit: 0 });
    assert.equal((await json(holder, executeSql(envelope))).reason, "MEMORY_NOT_FOUND");
  });

  it("a lock timeout rolls back partial source locks and permits a clean bounded retry", async () => {
    const batch = (await create([first, second])).batch;
    await holder.query(`BEGIN; SELECT id FROM memories WHERE id = '${second}' FOR UPDATE;`);
    await reader.query("BEGIN; SET LOCAL lock_timeout = '250ms';");
    assert.deepEqual(await json(reader, stepSql(batch.id)), { ok: false, reason: "step_failed" });
    await holder.query(`SELECT id FROM memories WHERE id = '${first}' FOR UPDATE NOWAIT;`);
    assert.deepEqual(await journalCounts(), { events: 0, outbox: 0, receipts: 0, audit: 0 });
    await holder.query("ROLLBACK;");
    await reader.query("ROLLBACK;");
    const original = (await progress(batch.id)).batch;
    assert.equal(original.checkpoint, 0);
    assert.equal(original.attempts, 0);
    assert.equal((await json(holder, stepSql(batch.id))).batch.completed, 2);
  });

  it("cancelling a multi-item step after its first receipt rolls back every mutation and releases locks", async () => {
    const batch = (await create([first, second])).batch;
    await holder.query(`CREATE OR REPLACE FUNCTION fixture_import_outbox_pause() RETURNS trigger LANGUAGE plpgsql AS $fixture$
      BEGIN
        IF NEW.memory_id = '${second}' THEN
          IF NOT EXISTS (SELECT 1 FROM public.memory_command_receipts WHERE memory_id = '${first}') THEN
            RAISE EXCEPTION 'first item must already have written its receipt before cancellation';
          END IF;
          PERFORM pg_advisory_xact_lock(3992, 99);
        END IF;
        RETURN NEW;
      END $fixture$;
      CREATE TRIGGER fixture_import_outbox_pause BEFORE INSERT ON memory_event_outbox
        FOR EACH ROW EXECUTE FUNCTION fixture_import_outbox_pause();
      BEGIN; SELECT pg_advisory_xact_lock(3992, 99);`);
    await reader.query("BEGIN;");
    const importing = settled(reader.query(stepSql(batch.id)));
    await blocked(holder, readerPid);
    assert.equal(await holder.query(`SELECT pg_cancel_backend(${readerPid});`), "t");
    const cancelled = await importing;
    assert.equal(cancelled.ok, false);
    assert.match(String(cancelled.ok ? "" : cancelled.error), /canceling statement due to user request/i);
    await reader.close();
    await holder.query("ROLLBACK;");
    reader = await newSession();
    await holder.query(`BEGIN; SELECT id FROM memories WHERE id IN ('${first}', '${second}') FOR UPDATE NOWAIT; ROLLBACK;`);
    assert.deepEqual(await journalCounts(), { events: 0, outbox: 0, receipts: 0, audit: 0 });
    assert.equal((await progress(batch.id)).batch.checkpoint, 0);
    assert.equal((await progress(batch.id)).batch.attempts, 0);
    assert.equal(await placeCount(), "0");
    await holder.query("DROP TRIGGER fixture_import_outbox_pause ON memory_event_outbox;");
    assert.equal((await json(holder, stepSql(batch.id))).batch.completed, 2);
    assert.deepEqual(await journalCounts(), { events: 2, outbox: 2, receipts: 2, audit: 2 });
  });
});
