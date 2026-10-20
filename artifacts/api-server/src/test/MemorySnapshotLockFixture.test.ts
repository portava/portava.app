import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { captureMemorySnapshot } from "../services/memory/MemorySnapshotStore.js";
import { memorySnapshotLockIds, memorySnapshotLockSchema, memorySnapshotLockSeed } from "./MemorySnapshotLockFixture.js";

const runtime = process.env.MEMORY_SNAPSHOT_PGLITE_MODULE;
const { owner, memory, episode } = memorySnapshotLockIds;
interface FixtureDatabase {
  exec(sql: string): Promise<unknown>;
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Array<{ result: unknown }> }>;
  close(): Promise<void>;
}

describe("MemorySnapshot native fixture compatibility (PGlite, NOT concurrency proof)", { skip: !runtime }, () => {
  let database: FixtureDatabase;
  const client = { async rpc(name: string, parameters: Record<string, unknown>) {
    assert.ok(["memory_snapshot_prepare_v1", "memory_snapshot_append_v1", "memory_snapshot_read_v1"].includes(name));
    const args = Object.values(parameters);
    const result = await database.query(`SELECT public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) AS result`, args);
    return { data: result.rows[0]!.result, error: null };
  } };

  before(async () => {
    const { PGlite } = await import(pathToFileURL(runtime!).href);
    database = new PGlite() as FixtureDatabase;
    await database.exec(await memorySnapshotLockSchema());
  });
  beforeEach(async () => { await database.exec(memorySnapshotLockSeed()); });
  after(async () => { await database?.close(); });

  for (const [name, destroy] of [
    ["actual 2320 episode FK cascade", `DELETE FROM memory_episodes WHERE id = '${episode}'`],
    ["actual 2320 evidence-first account eraser", `SELECT * FROM erase_memory_for_user('${owner}')`],
    ["profile cascade", `DELETE FROM profiles WHERE id = '${owner}'`],
    ["auth cascade with retained tombstone profile", `DELETE FROM auth.users WHERE id = '${owner}'`],
  ]) {
    it(`captures then physically erases through ${name}`, async () => {
      const captured = await captureMemorySnapshot(client, { ownerId: owner, memoryId: memory });
      assert.ok(captured.ok, JSON.stringify(captured));
      await database.exec(destroy);
      assert.equal((await database.query("SELECT count(*)::int AS result FROM memory_snapshots")).rows[0]!.result, 0);
      assert.deepEqual((await client.rpc("memory_snapshot_read_v1", {
        p_owner_id: owner, p_memory_id: memory, p_snapshot_id: captured.value.id,
      })).data, { ok: false, reason: "not_found" });
      if (name.includes("tombstone")) {
        assert.equal((await database.query("SELECT count(*)::int AS result FROM profiles")).rows[0]!.result, 1);
      }
    });
  }
});
