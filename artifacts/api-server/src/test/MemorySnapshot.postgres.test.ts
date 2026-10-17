import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { captureMemorySnapshot, type MemorySnapshotRecord } from "../services/memory/MemorySnapshotStore.js";
import { memorySnapshotLockIds, memorySnapshotLockSchema, memorySnapshotLockSeed } from "./MemorySnapshotLockFixture.js";

const binaryDirectory = process.env.MEMORY_SNAPSHOT_POSTGRES_BIN;
const run = promisify(execFile);
const { owner, memory, episode, media, evidence } = memorySnapshotLockIds;
const literal = (value: unknown) => `'${(typeof value === "string" ? value : JSON.stringify(value)).replaceAll("'", "''")}'`;
const rpcNames = new Set(["memory_snapshot_prepare_v1", "memory_snapshot_append_v1"]);
const nativeEnvironment = { PATH: "/usr/bin:/bin", HOME: tmpdir(), LC_ALL: "C" };

class MemorySnapshotNativeSession {
  private process: ChildProcessWithoutNullStreams;
  private output = "";
  private errors = "";
  private pending?: { marker: string; resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

  constructor(binary: string, socket: string) {
    this.process = spawn(binary, ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-h", socket, "-p", "55432", "-U", "postgres", "-d", "postgres"], {
      env: nativeEnvironment, stdio: "pipe",
    });
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
    this.process.stderr.on("data", (chunk: string) => { this.errors += chunk; });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code) => this.fail(new Error(`psql exited ${code}: ${this.errors}`)));
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
      const marker = `snapshot_${randomUUID().replaceAll("-", "")}`;
      const timer = setTimeout(() => {
        this.fail(new Error(`native snapshot command exceeded 8 seconds: ${this.errors}`));
        this.process.kill("SIGKILL");
      }, 8000);
      this.pending = { marker, resolve, reject, timer };
      this.process.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }

  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.process.kill("SIGKILL"), 1000);
      this.process.once("exit", () => { clearTimeout(timer); resolve(); });
      this.process.stdin.end("\\q\n");
    });
  }
}

describe("MemorySnapshot native two-session locks (fresh socket-only disposable cluster)", {
  skip: binaryDirectory ? false : "MEMORY_SNAPSHOT_POSTGRES_BIN unset; native PostgreSQL concurrency is NOT verified",
  concurrency: false,
}, () => {
  let root: string;
  let holder: MemorySnapshotNativeSession;
  let reader: MemorySnapshotNativeSession;
  let stored: MemorySnapshotRecord;
  const client = { async rpc(name: string, parameters: Record<string, unknown>) {
    assert.ok(rpcNames.has(name));
    return { data: JSON.parse(await reader.query(`SELECT public.${name}(${Object.values(parameters).map(literal).join(",")});`)) as unknown, error: null };
  } };
  const invoke = (operation: string) => operation === "prepare"
    ? `SELECT public.memory_snapshot_prepare_v1('${owner}','${memory}');`
    : operation === "append"
      ? `SELECT public.memory_snapshot_append_v1('${owner}','${memory}',${literal(stored.snapshot)});`
      : `SELECT public.memory_snapshot_read_v1('${owner}','${memory}','${stored.id}');`;

  before(async () => {
    assert.ok(binaryDirectory && isAbsolute(binaryDirectory));
    for (const binary of ["initdb", "pg_ctl", "psql"]) await access(join(binaryDirectory, binary), constants.X_OK);
    root = await mkdtemp("/tmp/MemorySnapshot-pg-");
    const socket = join(root, "socket");
    await mkdir(socket);
    await run(join(binaryDirectory, "initdb"), ["-D", join(root, "data"), "-U", "postgres", "-A", "trust", "--no-locale", "-E", "UTF8"],
      { env: nativeEnvironment, timeout: 15000 });
    await run(join(binaryDirectory, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "postgres.log"), "-w", "-t", "10",
      "-o", `-F -h '' -k '${socket}' -p 55432`, "start"], { env: nativeEnvironment, timeout: 15000 });
    holder = new MemorySnapshotNativeSession(join(binaryDirectory, "psql"), socket);
    reader = new MemorySnapshotNativeSession(join(binaryDirectory, "psql"), socket);
    await holder.query(await memorySnapshotLockSchema());
    for (const session of [holder, reader]) {
      await session.query("SET lock_timeout = '1500ms'; SET statement_timeout = '5s'; SET idle_in_transaction_session_timeout = '10s';");
    }
    assert.notEqual(await holder.query("SELECT pg_backend_pid();"), await reader.query("SELECT pg_backend_pid();"));
  });

  beforeEach(async () => {
    await holder.query("ROLLBACK;");
    await reader.query("ROLLBACK;");
    await holder.query(memorySnapshotLockSeed());
    const captured = await captureMemorySnapshot(client, { ownerId: owner, memoryId: memory });
    assert.ok(captured.ok, JSON.stringify(captured));
    stored = captured.value;
  });

  after(async () => {
    await Promise.all([holder?.close(), reader?.close()]);
    if (root && await access(join(root, "data", "postmaster.pid")).then(() => true, () => false)) {
      await run(join(binaryDirectory!, "pg_ctl"), ["-D", join(root, "data"), "-m", "immediate", "-w", "-t", "10", "stop"],
        { env: nativeEnvironment, timeout: 15000 });
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const operation of ["prepare", "append", "read"]) {
    for (const [name, lock, destroy] of [
      ["episode-first FK cascade", `SELECT id FROM memory_episodes WHERE id = '${episode}' FOR UPDATE;`, `DELETE FROM memory_episodes WHERE id = '${episode}';`],
      ["evidence-first actual 2320 eraser", `SELECT id FROM memory_evidence WHERE id = '${evidence}' FOR UPDATE;`, `SELECT * FROM erase_memory_for_user('${owner}');`],
      ["episode retirement then evidence purge", `SELECT id FROM memory_episodes WHERE id = '${episode}' FOR UPDATE;`, `UPDATE memory_episodes SET state = 'deleted' WHERE id = '${episode}'; DELETE FROM memory_evidence WHERE episode_id = '${episode}';`],
      ["profile cascade", `SELECT id FROM profiles WHERE id = '${owner}' FOR UPDATE; SELECT id FROM memory_episodes WHERE id = '${episode}' FOR UPDATE;`, `DELETE FROM profiles WHERE id = '${owner}';`],
      ["auth account cascade", `SELECT id FROM auth.users WHERE id = '${owner}' FOR UPDATE;`, `DELETE FROM auth.users WHERE id = '${owner}';`],
      ["Memory lifecycle revocation", `SELECT id FROM memories WHERE id = '${memory}' FOR UPDATE;`, `UPDATE memories SET state = 'deleted' WHERE id = '${memory}';`],
      ["media provenance revocation", `SELECT id FROM media_assets WHERE id = '${media}' FOR UPDATE;`, `UPDATE media_assets SET provenance = '{"captureProvenance":"screenshot"}' WHERE id = '${media}';`],
      ["retention revocation", "SELECT retention_class FROM memory_policy FOR UPDATE;", "UPDATE memory_policy SET ttl = interval '1 day';"],
    ]) {
      it(`${operation} yields to ${name} and releases partial locks before its outer transaction ends`, async () => {
        if (operation === "append") await holder.query("DELETE FROM memory_snapshots;");
        await holder.query(`BEGIN; ${lock}`);
        await reader.query("BEGIN; SET LOCAL lock_timeout = '0'; SET LOCAL statement_timeout = '1s';");
        assert.deepEqual(JSON.parse(await reader.query(invoke(operation))), { ok: false, reason: "unavailable" });
        assert.equal(await reader.query("SELECT count(*) FROM memory_snapshots;"), operation === "append" ? "0" : "1");
        await holder.query(`${destroy} COMMIT;`);
        assert.equal(await reader.query("SELECT count(*) FROM memory_snapshots;"), "0");
        await reader.query("ROLLBACK;");
        assert.deepEqual(JSON.parse(await reader.query(invoke("read"))), { ok: false, reason: "not_found" });
        assert.equal(JSON.parse(await reader.query(invoke("append"))).ok, false, "stale append must not resurrect revoked content");
        assert.equal(await reader.query("SELECT count(*) FROM memory_snapshots;"), "0");
        assert.equal(await reader.query("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();"), "0");
      });
    }

    it(`${operation} retries cleanly after contention is rolled back`, async () => {
      if (operation === "append") await holder.query("DELETE FROM memory_snapshots;");
      await holder.query(`BEGIN; SELECT id FROM memory_episodes WHERE id = '${episode}' FOR UPDATE;`);
      await reader.query("BEGIN; SET LOCAL lock_timeout = '0'; SET LOCAL statement_timeout = '1s';");
      assert.deepEqual(JSON.parse(await reader.query(invoke(operation))), { ok: false, reason: "unavailable" });
      await holder.query("ROLLBACK;");
      assert.equal(JSON.parse(await reader.query(invoke(operation))).ok, true);
      await reader.query("COMMIT;");
      assert.equal(await reader.query("SELECT count(*) FROM memory_snapshots;"), "1");
    });
  }

  it("a successful append keeps source locks until commit; a waiting episode cascade then purges it", async () => {
    await holder.query("DELETE FROM memory_snapshots;");
    await reader.query("BEGIN;");
    assert.equal(JSON.parse(await reader.query(invoke("append"))).ok, true);
    const holderPid = await holder.query("SELECT pg_backend_pid();");
    const deleted = holder.query(`DELETE FROM memory_episodes WHERE id = '${episode}';`);
    const pending = deleted.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    const deadline = Date.now() + 1000;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = await reader.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${Number(holderPid)}));`) === "t";
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "the second backend must actually wait on the snapshot transaction");
    await reader.query("COMMIT;");
    assert.deepEqual(await pending, { ok: true });
    assert.equal(await reader.query("SELECT count(*) FROM memory_snapshots;"), "0");
  });
});
