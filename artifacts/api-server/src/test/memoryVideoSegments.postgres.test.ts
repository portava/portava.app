import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { videoSegmentReplySchema } from "../services/memory/memoryVideoSegments.js";
import { VideoSegmentNativeCluster, type VideoSegmentNativeSession, videoSegmentNativeIds, videoSegmentNativeSeed } from "./memoryVideoSegmentsPostgresFixture.js";

const binaryDirectory = process.env.MEMORY_VIDEO_SEGMENTS_POSTGRES_BIN;
const { owner, other, memory, otherMemory, item, otherItem, asset, otherAsset, segment } = videoSegmentNativeIds;
const source = { assetId: asset, assetVersion: 3, durationMs: 4000, storageBucket: "post-media", storagePath: `${owner}/original.mp4`, itemMediaUrl: `post-media/${owner}/original.mp4` };
const context = { contractVersion: 1, ownerId: owner, memoryId: memory, itemId: item, source };
const input = { operationId: segment, assetId: asset, assetVersion: 3, startMs: 1000, endMs: 2500, label: "Owner-selected turn" };
const create = (patch: Record<string, unknown> = {}) => ({ ...context, operation: "create", segment: { ...input, ...patch } });
const remove = (segmentId = segment) => ({ ...context, operation: "delete", segmentId });
const list = { ...context, operation: "list" };
const operationId = (index: number) => `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const literal = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const sql = (command: unknown) => `SELECT public.memory_video_segments_execute(${literal(command)});`;
const invoke = async (session: VideoSegmentNativeSession, command: unknown) => videoSegmentReplySchema.parse(JSON.parse(
  await session.query(`SET ROLE service_role; ${sql(command)} RESET ROLE;`),
));
const failure = (reason: string) => ({ contractVersion: 1, ok: false, reason });
const observed = <Value>(promise: Promise<Value>) => promise.then(
  value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as Error }),
);

describe("3991 native PostgreSQL two-session segment races (fresh socket-only cluster)", {
  skip: binaryDirectory ? false : "MEMORY_VIDEO_SEGMENTS_POSTGRES_BIN unset; native segment concurrency is NOT verified",
  concurrency: false,
}, () => {
  let cluster: VideoSegmentNativeCluster;
  let holder: VideoSegmentNativeSession;
  let contender: VideoSegmentNativeSession;
  let contenderPid: number;

  async function blocked() {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (await holder.query(`SELECT pg_backend_pid() = ANY(pg_blocking_pids(${contenderPid}));`) === "t") return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("the second backend never demonstrably waited on the first transaction");
  }

  async function counts(segments: number, operations: number) {
    assert.equal(await holder.query(`SELECT count(*) FROM public.memory_video_segments WHERE owner_id = '${owner}';`), String(segments));
    assert.equal(await holder.query(`SELECT count(*) FROM public.memory_video_segment_operations WHERE owner_id = '${owner}';`), String(operations));
  }

  before(async () => {
    assert.ok(binaryDirectory);
    cluster = new VideoSegmentNativeCluster(binaryDirectory);
    await cluster.start();
  });

  beforeEach(async () => {
    holder = cluster.session();
    contender = cluster.session();
    for (const session of [holder, contender]) await session.query("SET lock_timeout = '1500ms'; SET statement_timeout = '5s'; SET idle_in_transaction_session_timeout = '10s';");
    const holderPid = Number(await holder.query("SELECT pg_backend_pid();"));
    contenderPid = Number(await contender.query("SELECT pg_backend_pid();"));
    assert.ok(Number.isInteger(holderPid) && Number.isInteger(contenderPid) && holderPid !== contenderPid);
    await holder.query(videoSegmentNativeSeed());
  });

  afterEach(async () => { await Promise.all([holder?.close(), contender?.close()]); });
  after(async () => { await cluster?.close(); });

  it("concurrent same-operation creates commit exactly one segment and replay the same result", async () => {
    await holder.query("BEGIN;");
    const first = await invoke(holder, create());
    assert.ok(first.ok && first.operation === "create" && first.created);
    const second = observed(invoke(contender, create()));
    await blocked();
    await holder.query("COMMIT;");
    const replay = await second;
    assert.ok(replay.ok, replay.ok ? "" : replay.error.message);
    assert.deepEqual(replay.value, { ...first, created: false });
    await counts(1, 1);
    assert.equal(await holder.query("SELECT count(*) FROM media_assets;"), "2");
  });

  it("conflicting concurrent payload cannot rebind the winning operation", async () => {
    await holder.query("BEGIN;");
    const first = await invoke(holder, create());
    const second = observed(invoke(contender, create({ endMs: 3000 })));
    await blocked();
    await holder.query("COMMIT;");
    assert.deepEqual(await second, { ok: true, value: failure("idempotency_conflict") });
    assert.deepEqual(await invoke(holder, create()), { ...first, created: false });
    await counts(1, 1);
  });

  it("acknowledged DELETE-before-CREATE commits a scoped tombstone and rejects the waiting create", async () => {
    await holder.query("BEGIN;");
    assert.deepEqual(await invoke(holder, remove()), { contractVersion: 1, ok: true, operation: "delete", deleted: false });
    const delayed = observed(invoke(contender, create()));
    await blocked();
    await holder.query("COMMIT;");
    assert.deepEqual(await delayed, { ok: true, value: failure("idempotency_conflict") });
    assert.deepEqual(await invoke(contender, create({ label: "Delayed changed intent" })), failure("idempotency_conflict"));
    assert.equal(await holder.query(`SELECT asset_id IS NULL AND owner_id = '${owner}' AND memory_id = '${memory}' AND item_id = '${item}' FROM memory_video_segment_operations WHERE id = '${segment}';`), "t");
    await counts(0, 1);
  });

  it("waiting DELETE erases a committed create and its later replay cannot resurrect it", async () => {
    await holder.query("BEGIN;");
    assert.equal((await invoke(holder, create())).ok, true);
    const deletion = observed(invoke(contender, remove()));
    await blocked();
    await holder.query("COMMIT;");
    assert.deepEqual(await deletion, { ok: true, value: { contractVersion: 1, ok: true, operation: "delete", deleted: true } });
    assert.deepEqual(await invoke(holder, create()), failure("idempotency_conflict"));
    await counts(0, 1);
  });

  for (const intent of ["create", "delete"]) {
    it(`a different owner cannot reuse or cancel the same in-flight operation through its own item (${intent})`, async () => {
      await holder.query("BEGIN;");
      assert.equal((await invoke(holder, create())).ok, true);
      const foreignSource = { ...source, assetId: otherAsset, storagePath: `${other}/original.mp4`, itemMediaUrl: `post-media/${other}/original.mp4` };
      const foreign = { ...(intent === "create" ? create({ assetId: otherAsset }) : remove()), ownerId: other, memoryId: otherMemory, itemId: otherItem, source: foreignSource };
      const pending = observed(invoke(contender, foreign));
      await blocked();
      await holder.query("COMMIT;");
      assert.deepEqual(await pending, { ok: true, value: failure(intent === "create" ? "idempotency_conflict" : "not_found") });
      assert.equal(await holder.query(`SELECT count(*) FROM memory_video_segment_operations WHERE owner_id = '${other}';`), "0");
      assert.deepEqual(await invoke(holder, { ...remove(), ownerId: other }), failure("not_found"));
      await counts(1, 1);
    });
  }

  it("two creators racing for slot 100 cannot exceed the cap; replay and delete still work at capacity", async () => {
    const seeded = JSON.parse(await holder.query(`SET ROLE service_role; SELECT jsonb_agg(public.memory_video_segments_execute(command)) FROM (VALUES
      ${Array.from({ length: 99 }, (_, index) => `(${literal(create({ operationId: operationId(index) }))})`).join(",")}
    ) AS commands(command); RESET ROLE;`)) as unknown[];
    assert.equal(seeded.length, 99);
    for (const value of seeded) {
      const reply = videoSegmentReplySchema.parse(value);
      assert.ok(reply.ok && reply.operation === "create" && reply.created);
    }
    await holder.query("BEGIN;");
    const winner = await invoke(holder, create());
    assert.ok(winner.ok && winner.operation === "create" && winner.created);
    const loserId = operationId(100);
    const pending = observed(invoke(contender, create({ operationId: loserId })));
    await blocked();
    await holder.query("COMMIT;");
    assert.deepEqual(await pending, { ok: true, value: failure("limit_reached") });
    await counts(100, 100);
    assert.deepEqual(await invoke(contender, create()), { ...winner, created: false });
    const listed = await invoke(holder, list);
    assert.ok(listed.ok && listed.operation === "list" && listed.segments.length === 100);
    assert.equal((await invoke(contender, remove(operationId(0)))).ok, true);
    assert.equal((await invoke(contender, create({ operationId: loserId }))).ok, true);
    assert.deepEqual(await invoke(contender, create({ operationId: operationId(0) })), failure("idempotency_conflict"));
    await counts(100, 101);
  });

  for (const bounds of [{ startMs: -1 }, { startMs: 2500 }, { endMs: 4001 }]) {
    it(`rejects out-of-duration or reversed bounds without consuming an operation: ${JSON.stringify(bounds)}`, async () => {
      assert.deepEqual(await invoke(contender, create(bounds)), failure("invalid_bounds"));
      await counts(0, 0);
      assert.equal((await invoke(holder, create({ startMs: 0, endMs: 4000 }))).ok, true);
      await counts(1, 1);
    });
  }

  const mutations = [
    { name: "source version", change: `UPDATE media_assets SET version = version WHERE id = '${asset}';`, reason: "source_changed", receipts: 1 },
    { name: "source soft deletion", change: `UPDATE media_assets SET deleted_at = now() WHERE id = '${asset}';`, reason: "not_found", receipts: 1 },
    { name: "source hard deletion", change: `DELETE FROM media_assets WHERE id = '${asset}';`, reason: "not_found", receipts: 0 },
    { name: "item retarget", change: `UPDATE memory_items SET media_url = 'post-media/replacement.mp4' WHERE id = '${item}';`, reason: "source_changed", receipts: 1 },
    { name: "item deletion", change: `DELETE FROM memory_items WHERE id = '${item}';`, reason: "not_found", receipts: 0 },
    { name: "Memory withdrawal", change: `UPDATE memories SET state = 'removed' WHERE id = '${memory}';`, reason: "not_found", receipts: 0 },
    { name: "account cascade", change: `DELETE FROM auth.users WHERE id = '${owner}';`, reason: "not_found", receipts: 0 },
  ];

  for (const mutation of mutations) {
    for (const operation of ["list", "create"]) {
      it(`${operation} ${mutation.name === "account cascade" ? "refuses contention during" : "waits for"} ${mutation.name} and returns no stale playback reference after commit`, async () => {
        assert.equal((await invoke(holder, create())).ok, true);
        await holder.query(`BEGIN; ${mutation.change}`);
        if (mutation.name === "account cascade") {
          await contender.query("BEGIN; SET LOCAL lock_timeout = '0'; SET LOCAL statement_timeout = '1s';");
          assert.deepEqual(await invoke(contender, operation === "list" ? list : create({ operationId: operationId(1) })), failure("unavailable"));
          await holder.query("COMMIT;");
          assert.deepEqual(await invoke(contender, list), failure("not_found"));
          assert.deepEqual(await invoke(contender, create()), failure("not_found"));
          await contender.query("ROLLBACK;");
          await counts(0, 0);
          return;
        }
        const pending = observed(invoke(contender, operation === "list" ? list : create({ operationId: operationId(1) })));
        await blocked();
        await holder.query("COMMIT;");
        assert.deepEqual(await pending, { ok: true, value: failure(mutation.reason) });
        assert.deepEqual(await invoke(holder, list), failure(mutation.reason));
        assert.deepEqual(await invoke(holder, create()), failure(mutation.reason));
        await counts(0, mutation.receipts);
      });
    }
  }

  for (const mutation of mutations.slice(0, 3)) {
    it(`a successful uncommitted create holds source locks; waiting ${mutation.name} invalidates it after commit`, async () => {
      await holder.query("BEGIN;");
      assert.equal((await invoke(holder, create())).ok, true);
      const pending = observed(contender.query(mutation.change));
      await blocked();
      await holder.query("COMMIT;");
      const changed = await pending;
      assert.ok(changed.ok, changed.ok ? "" : changed.error.message);
      assert.deepEqual(await invoke(holder, list), failure(mutation.reason));
      assert.deepEqual(await invoke(holder, create()), failure(mutation.reason));
      await counts(0, mutation.receipts);
    });
  }

  for (const operation of ["create", "delete"]) {
    it(`a rolled-back ${operation} does not poison the waiting retry's operation ID`, async () => {
      await holder.query("BEGIN;");
      assert.equal((await invoke(holder, operation === "create" ? create() : remove())).ok, true);
      const pending = observed(invoke(contender, create()));
      await blocked();
      await holder.query("ROLLBACK;");
      const retry = await pending;
      assert.ok(retry.ok, retry.ok ? "" : retry.error.message);
      assert.ok(retry.value.ok && retry.value.operation === "create" && retry.value.created);
      await counts(1, 1);
    });
  }

  for (const mutation of mutations.slice(0, 3)) {
    it(`rolled-back ${mutation.name} permits a valid waiting create and retains the canonical original`, async () => {
      await holder.query(`BEGIN; ${mutation.change}`);
      const pending = observed(invoke(contender, create()));
      await blocked();
      await holder.query("ROLLBACK;");
      const retry = await pending;
      assert.ok(retry.ok, retry.ok ? "" : retry.error.message);
      assert.ok(retry.value.ok && retry.value.operation === "create" && retry.value.created);
      assert.equal(await holder.query(`SELECT version = 3 AND deleted_at IS NULL FROM media_assets WHERE id = '${asset}';`), "t");
      await counts(1, 1);
    });
  }

  it("a bounded lock-timeout rollback leaves no partial receipt; a fresh transaction retries successfully", async () => {
    await holder.query(`BEGIN; SELECT id FROM memory_items WHERE id = '${item}' FOR UPDATE;`);
    await contender.query("BEGIN; SET LOCAL lock_timeout = '500ms';");
    const pending = observed(invoke(contender, create()));
    await blocked();
    assert.deepEqual(await pending, { ok: true, value: failure("unavailable") });
    await counts(0, 0);
    await holder.query(`SELECT id FROM auth.users WHERE id = '${owner}' FOR UPDATE NOWAIT;`);
    await contender.query("ROLLBACK;");
    await holder.query("ROLLBACK;");
    assert.equal((await invoke(contender, create())).ok, true);
    await counts(1, 1);
  });

  for (const operation of ["create", "delete"]) {
    it(`${operation} does not deadlock an account-first cascade through its late auth-user foreign key`, async () => {
      await holder.query(`BEGIN; SELECT id FROM auth.users WHERE id = '${owner}' FOR UPDATE;`);
      await contender.query("BEGIN; SET LOCAL lock_timeout = '0'; SET LOCAL statement_timeout = '1s';");
      assert.deepEqual(await invoke(contender, operation === "create" ? create() : remove()), failure("unavailable"));
      await counts(0, 0);
      await holder.query(`UPDATE feature_flags SET enabled = enabled; DELETE FROM auth.users WHERE id = '${owner}'; COMMIT;`);
      assert.deepEqual(await invoke(contender, operation === "create" ? create() : remove()), failure("not_found"));
      await contender.query("ROLLBACK;");
      await counts(0, 0);
      assert.equal(await holder.query("SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();"), "0");
    });

    it(`${operation} explicitly refuses account contention without a receipt and retries after erasure rolls back`, async () => {
      await holder.query(`BEGIN; SELECT id FROM auth.users WHERE id = '${owner}' FOR UPDATE;`);
      await contender.query("BEGIN; SET LOCAL lock_timeout = '0'; SET LOCAL statement_timeout = '1s';");
      const command = operation === "create" ? create() : remove();
      assert.deepEqual(await invoke(contender, command), failure("unavailable"));
      await counts(0, 0);
      await holder.query("ROLLBACK;");
      const retry = await invoke(contender, command);
      if (operation === "create") assert.ok(retry.ok && retry.operation === "create" && retry.created);
      else assert.deepEqual(retry, { contractVersion: 1, ok: true, operation: "delete", deleted: false });
      await contender.query("COMMIT;");
      await counts(operation === "create" ? 1 : 0, 1);
      if (operation === "delete") assert.deepEqual(await invoke(holder, create()), failure("idempotency_conflict"));
      else assert.deepEqual(await invoke(holder, create()), { ...retry, created: false });
    });
  }
});
