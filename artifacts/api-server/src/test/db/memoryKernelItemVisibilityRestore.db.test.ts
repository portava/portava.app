/**
 * memoryKernelItemVisibilityRestore.db.test.ts — the last two canonical Memory
 * writes outside memory_kernel_execute, now inside it (migration 3912), on the
 * full chain scripts/local-db/up.sh replays. census-highlights-memories §CC.
 *
 *   - PUT /memories/:id/items/:itemId/visibility (a photo's own audience, 3672)
 *     wrote `memory_items.visibility` directly, with no event, so a photo hidden
 *     after a public derivative was built was never re-derived. It now dispatches
 *     CHANGE_ITEM_VISIBILITY.
 *   - An upheld appeal (services/appeals/resolveAppeal.ts) set `state='published'`
 *     directly on ANY of the appellant's Memories, including one its owner had
 *     deleted. It now dispatches MODERATION_RESTORE_MEMORY, which reverses a
 *     moderation removal (`removed`) and nothing else, with the moderator as actor.
 *
 * The route runs over HTTP and resolveAppeal is called as the appeals route calls
 * it, both through ./memoryPostgrestBridge.ts as service_role, which logs every
 * statement. Each case asserts the change and its `memory_domain_events` row are
 * ONE transaction (equal `xmin`) and that nothing but the kernel RPC wrote the
 * Memory aggregate. V5/R6 install 3911's kernel from 3912's rollback file and
 * show the compat arms (MEMORY_COMMAND_UNKNOWN_TYPE -> the pre-3912 write); the
 * tree's kernel is then put back byte for byte.
 *
 *   V1 a photo made owner-only: the item and memory.visibility_changed in one transaction; the payload states 'only_me'
 *   V2 shared again: the payload states no narrower audience (a widening)
 *   V3 a photo not on this Memory is 404 and writes nothing; a malformed value is refused before the kernel
 *   V4 the kernel OFF: the direct write, and no event claimed
 *   V5 on 3911's kernel the compat arm writes as before 3912
 *   R1 a moderation-removed Memory is restored by the moderator's command: state, memory.corrected DELETED -> ACTIVE, audit actor
 *   R2 the same appeal again: the receipt answers, one restore, one event
 *   R3 an owner-DELETED Memory is never brought back (matched nothing); a published / archived one is a moderator's decision (deferred)
 *   R4 a non-admin actor is refused by name; a wrong appellant matches nothing
 *   R5 the kernel OFF: the legacy update, no event claimed
 *   R6 on 3911's kernel the compat arm restores as before 3912
 *   H1 the outbox drain tick drains the kernel's events and writes its job_health row and /healthz/schedulers status
 *   H2 a pass that cannot claim is a FAILED pass: job_health gets last_run_at and no last_success_at, and the status counts it
 *
 * Run: bash scripts/local-db/run-tests.sh (after up.sh), or with LOCAL_DB_URL set:
 *   node --import tsx/esm --test src/test/db/memoryKernelItemVisibilityRestore.db.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, rows, scalar, seedUser } from "./localDb.js";
import { memoryBridge } from "./memoryPostgrestBridge.js";
import { _setTestClient } from "../../lib/http.js";
import { payloadMayNarrowAudience } from "../../lib/memoryOutbox.js";
import { resolveAppeal } from "../../services/appeals/resolveAppeal.js";
import { dispatchMemoryCommand } from "../../services/memory/MemoryDomainService.js";
import { runMemoryOutboxDrainTick, getMemoryOutboxDrainStatus, memoryOutboxDrainHealthDetail, _resetMemoryOutboxDrainStatus, MEMORY_OUTBOX_DRAIN_JOB } from "../../services/memoryProjections/outboxDrainRunner.js";
import memoryItemVisibilityRouter from "../../routes/memoryItemVisibility.js";
// The kernel's event log and outbox are named through lib/memoryOutbox.ts, the one module check:memory-table-ownership lets name them.
import { MEMORY_EVENT_TABLE as EVENTS, MEMORY_OUTBOX_TABLE as OUTBOX } from "../../lib/memoryOutbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLLBACK_3912 = resolve(HERE, "../../../../../db/rollback/2026-10-24-3912-memory-kernel-item-visibility-and-moderation-restore-rollback.sql");

/** Production's values for the flags these paths read (feature_flags, 2026-10-23). */
const PROD_FLAGS: Record<string, boolean> = { memory_kernel_enabled: true };

const TAG = `mkv${randomUUID().slice(0, 8)}`;
let owner = "";
let stranger = "";
let moderator = "";
const TOKEN = `tok-${TAG}`;
let flags: Record<string, boolean> = { ...PROD_FLAGS };
let log: string[] = [];
let server: http.Server | null = null;
let base = "";

const install = (): any => {
  log = [];
  const sc = memoryBridge({ flags, log, tokens: { [TOKEN]: owner } });
  _setTestClient(sc, true);
  return sc;
};

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      hostname: url.hostname, port: Number(url.port), path: url.pathname + url.search, method, agent: false,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => { let b: any; try { b = JSON.parse(raw); } catch { b = raw; } resolvePromise({ status: res.statusCode ?? 0, body: b }); });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const writes = (): string[] => log.filter((s) => !s.startsWith("SELECT COALESCE(json_agg(t.*)") && !s.startsWith("SELECT json_build_array(count(*))"));
const CANONICAL_WRITE = /^(WITH w AS \()?(INSERT INTO|UPDATE|DELETE FROM) public\.(memories|memory_tags|memory_items)\b/;
const KERNEL_RPC = /^SELECT json_build_array\(public\.memory_kernel_execute\(/;
function assertOnlyTheKernelWrote(label: string): void {
  const w = writes();
  assert.equal(w.filter((s) => KERNEL_RPC.test(s)).length, 1, `${label}: exactly one kernel call:\n${w.join("\n")}`);
  assert.deepEqual(w.filter((s) => CANONICAL_WRITE.test(s)), [], `${label}: a direct write to the Memory aggregate`);
}
const xminOf = (table: string, where: string): string | null => scalar(`SELECT xmin::text FROM public.${table} WHERE ${where}`);
const kernelDefMd5 = (): string | null => scalar(`SELECT md5(pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure))`);
/** Raw psql output: exec() drops blank lines, which would change the body. */
const kernelDef = (): string => { const r = psql(`SELECT pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure);`); assert.equal(r.status, 0, r.stderr); const c = psql(`SELECT obj_description('public.memory_kernel_execute(jsonb)'::regprocedure, 'pg_proc');`); assert.equal(c.status, 0, c.stderr); return `${r.stdout.replace(/\n$/, "")};\nCOMMENT ON FUNCTION public.memory_kernel_execute(jsonb) IS $kc$${c.stdout.replace(/\n$/, "")}$kc$`; }; // the definition AND its comment, so a restore puts back the whole object
const restoreKernel = (def: string): void => {
  const r = psql(`${def};\nREVOKE ALL ON FUNCTION public.memory_kernel_execute(jsonb) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.memory_kernel_execute(jsonb) TO service_role;`);
  assert.equal(r.status, 0, `the saved kernel did not re-apply:\n${r.stderr}`);
};
function applyFile(path: string): void {
  const r = psql(readFileSync(path, "utf8"));
  assert.equal(r.status, 0, `${path} did not apply:\n${r.stderr}`);
}
/** Runs `body` on 3911's kernel (3912's rollback), then puts the tree's kernel back exactly. */
async function on3911<T>(body: () => Promise<T>): Promise<T> {
  const md5 = kernelDefMd5();
  const saved = kernelDef();
  applyFile(ROLLBACK_3912);
  try {
    assert.notEqual(kernelDefMd5(), md5, "3911's kernel is installed");
    return await body();
  } finally {
    restoreKernel(saved);
    assert.equal(kernelDefMd5(), md5, "the tree's kernel restored exactly");
  }
}

function newMemory(state: string, title: string, visibility = "only_me"): string {
  const id = randomUUID();
  exec(`INSERT INTO public.memories (id, owner_id, title, visibility, state) VALUES ('${id}', '${owner}', '${title.replace(/'/g, "''")}', '${visibility}', '${state}');`);
  return id;
}
function newItem(memoryId: string, position: number): string {
  const id = randomUUID();
  exec(`INSERT INTO public.memory_items (id, memory_id, media_url, media_type, position) VALUES ('${id}', '${memoryId}', 'https://example.test/${TAG}-${position}.jpg', 'image/jpeg', ${position});`);
  return id;
}
const appealFor = (memoryId: string, appellant = owner, mod = moderator) =>
  ({ id: randomUUID(), appellant_id: appellant, target_type: "memory", target_id: memoryId, resolution_note: null, moderator_id: mod });

describe("§17: a photo's own audience and the moderation restore cross the kernel (3912)", { skip: !HAVE_DB }, () => {
  before(async () => {
    owner = seedUser(`${TAG}o`);
    stranger = seedUser(`${TAG}s`);
    moderator = seedUser(`${TAG}m`);
    exec(`UPDATE public.profiles SET role = 'admin' WHERE id = '${moderator}';`);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => { req.log = { error: () => {}, warn: () => {}, info: () => {}, child: () => req.log }; next(); });
    app.use("/api", memoryItemVisibilityRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server!.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
    assert.equal(scalar(`SELECT position('MODERATION_RESTORE_MEMORY' IN pg_get_functiondef('public.memory_kernel_execute(jsonb)'::regprocedure)) > 0`), "t", "the chain carries 3912's kernel");
  });
  after(async () => {
    await new Promise((r) => (server ? server.close(() => r(null)) : r(null)));
    for (const id of [owner, stranger, moderator].filter(Boolean)) {
      exec(`DELETE FROM public.${OUTBOX} WHERE memory_id IN (SELECT id FROM public.memories WHERE owner_id = '${id}');
            DELETE FROM public.${EVENTS} WHERE actor_user_id = '${id}' OR memory_id IN (SELECT id FROM public.memories WHERE owner_id = '${id}');
            DELETE FROM public.memory_command_audit WHERE actor_user_id = '${id}';
            DELETE FROM public.memory_command_receipts WHERE actor_user_id = '${id}';
            DELETE FROM public.memories WHERE owner_id = '${id}';
            DELETE FROM public.profiles WHERE id = '${id}';
            DELETE FROM auth.users WHERE id = '${id}';`);
    }
  });

  let m = "";
  let item = "";

  test("V1 a photo made owner-only: the item's audience and memory.visibility_changed are one transaction, and the payload states 'only_me'", async () => {
    m = newMemory("published", `${TAG} V`, "public");
    item = newItem(m, 0);
    flags = { ...PROD_FLAGS }; install();
    const res = await call("PUT", `/api/memories/${m}/items/${item}/visibility`, { visibility: "only_me" }, { "idempotency-key": randomUUID() });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(scalar(`SELECT visibility FROM public.memory_items WHERE id = '${item}'`), "only_me");
    const ev = rows<{ type: string; command_type: string; item_id: string; payload: any; xmin: string }>(
      `SELECT type, payload_json->>'command_type' AS command_type, payload_json->'refs'->>'item_id' AS item_id, payload_json AS payload, xmin::text AS xmin FROM public.${EVENTS} WHERE memory_id = '${m}'`);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]!.type, ev[0]!.command_type, ev[0]!.item_id], ["memory.visibility_changed", "CHANGE_ITEM_VISIBILITY", item]);
    assert.equal(ev[0]!.payload.visibility, "only_me");
    assert.equal(payloadMayNarrowAudience(ev[0]!.payload), true, "a §18 consumer re-derives what served the photo");
    assert.equal(xminOf("memory_items", `id = '${item}'`), ev[0]!.xmin, "the item and its event are one transaction");
    assert.equal(scalar(`SELECT count(*) FROM public.${OUTBOX} WHERE memory_id = '${m}'`), "1");
    assertOnlyTheKernelWrote("V1");
  });

  test("V2 shared again: the item inherits, and the event states no narrower audience", async () => {
    flags = { ...PROD_FLAGS }; install();
    const res = await call("PUT", `/api/memories/${m}/items/${item}/visibility`, { visibility: null }, { "idempotency-key": randomUUID() });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(scalar(`SELECT coalesce(visibility, 'NULL') FROM public.memory_items WHERE id = '${item}'`), "NULL");
    const ev = rows<{ payload: any; xmin: string }>(`SELECT payload_json AS payload, xmin::text AS xmin FROM public.${EVENTS} WHERE memory_id = '${m}' AND sequence = 2`);
    assert.equal(ev[0]!.payload.visibility ?? null, null);
    assert.equal(payloadMayNarrowAudience(ev[0]!.payload), false, "a widening re-derives nothing");
    assert.equal(xminOf("memory_items", `id = '${item}'`), ev[0]!.xmin);
    assertOnlyTheKernelWrote("V2");
  });

  test("V3 a photo that is not on this Memory is 404 and writes nothing; a value other than only_me/null is refused before the kernel", async () => {
    const other = newMemory("published", `${TAG} V3`);
    const foreignItem = newItem(other, 0);
    flags = { ...PROD_FLAGS }; install();
    const before = scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id IN ('${m}', '${other}')`);
    const res = await call("PUT", `/api/memories/${m}/items/${foreignItem}/visibility`, { visibility: "only_me" }, { "idempotency-key": randomUUID() });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(scalar(`SELECT coalesce(visibility, 'NULL') FROM public.memory_items WHERE id = '${foreignItem}'`), "NULL");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id IN ('${m}', '${other}')`), before);
    assert.equal(scalar(`SELECT count(*) FROM public.memory_command_audit WHERE memory_id = '${m}' AND command_type = 'CHANGE_ITEM_VISIBILITY' AND outcome = 'rejected' AND reason = 'MEMORY_ITEM_NOT_FOUND'`), "1");
    install();
    const bad = await call("PUT", `/api/memories/${m}/items/${item}/visibility`, { visibility: "friends_only" });
    assert.equal(bad.status, 400);
    assert.equal(writes().filter((s) => KERNEL_RPC.test(s)).length, 0, "refused before the kernel");
    // The kernel refuses the same value by name, for any caller that is not this route.
    const direct = await dispatchMemoryCommand<any>({
      sc: memoryBridge({ flags }), commandType: "CHANGE_ITEM_VISIBILITY", memoryId: m, actorUserId: owner, idempotencyKey: randomUUID(),
      payload: { item_id: item, item_visibility: "friends_only" }, legacy: async () => { throw new Error("legacy must not run"); },
    });
    assert.equal(direct.ok, false);
    if (!direct.ok && "rejection" in direct) assert.equal(direct.rejection.reason, "MEMORY_COMMAND_MALFORMED"); else assert.fail(JSON.stringify(direct));
    assert.equal(scalar(`SELECT coalesce(visibility, 'NULL') FROM public.memory_items WHERE id = '${item}'`), "NULL");
  });

  test("V4 the kernel OFF: the pre-3912 direct write, and no event claimed", async () => {
    flags = { ...PROD_FLAGS, memory_kernel_enabled: false }; install();
    const before = scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${m}'`);
    const res = await call("PUT", `/api/memories/${m}/items/${item}/visibility`, { visibility: "only_me" });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(scalar(`SELECT visibility FROM public.memory_items WHERE id = '${item}'`), "only_me");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${m}'`), before);
    assert.equal(writes().filter((s) => /^WITH w AS \(UPDATE public\.memory_items SET visibility = /.test(s)).length, 1);
    assert.equal(writes().filter((s) => KERNEL_RPC.test(s)).length, 0);
  });

  test("V5 on 3911's kernel (no CHANGE_ITEM_VISIBILITY): MEMORY_COMMAND_UNKNOWN_TYPE, and the compat arm writes as before 3912", async () => {
    await on3911(async () => {
      flags = { ...PROD_FLAGS }; install();
      const res = await call("PUT", `/api/memories/${m}/items/${item}/visibility`, { visibility: null }, { "idempotency-key": randomUUID() });
      assert.equal(res.status, 204, JSON.stringify(res.body));
      assert.equal(scalar(`SELECT coalesce(visibility, 'NULL') FROM public.memory_items WHERE id = '${item}'`), "NULL");
      assert.equal(writes().filter((s) => /^WITH w AS \(UPDATE public\.memory_items SET visibility = /.test(s)).length, 1, "the pre-3912 write ran");
      assert.equal(scalar(`SELECT count(*) FROM public.memory_command_audit WHERE memory_id = '${m}' AND command_type = 'CHANGE_ITEM_VISIBILITY' AND reason = 'MEMORY_COMMAND_UNKNOWN_TYPE'`), "1");
    });
  });

  let removed = "";
  let r1Appeal: ReturnType<typeof appealFor> | null = null;

  test("R1 a moderation-removed Memory is restored by the moderator's command: the state change and memory.corrected (DELETED -> ACTIVE) are one transaction, and the moderator is the actor", async () => {
    removed = newMemory("removed", `${TAG} R1`);
    flags = { ...PROD_FLAGS };
    const sc = install();
    r1Appeal = appealFor(removed);
    const out = await resolveAppeal(sc, r1Appeal);
    assert.deepEqual(out, { ok: true, action: "memory_restored" });
    assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${removed}'`), "published");
    const ev = rows<{ type: string; command_type: string; from_state: string; to_state: string; actor: string; xmin: string }>(
      `SELECT type, payload_json->>'command_type' AS command_type, payload_json->>'from_state' AS from_state, payload_json->>'to_state' AS to_state, actor_user_id::text AS actor, xmin::text AS xmin FROM public.${EVENTS} WHERE memory_id = '${removed}'`);
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0]!.type, ev[0]!.command_type, ev[0]!.from_state, ev[0]!.to_state, ev[0]!.actor],
      ["memory.corrected", "MODERATION_RESTORE_MEMORY", "DELETED", "ACTIVE", moderator]);
    assert.equal(xminOf("memories", `id = '${removed}'`), ev[0]!.xmin);
    assert.equal(scalar(`SELECT actor_user_id::text FROM public.memory_command_audit WHERE memory_id = '${removed}' AND outcome = 'accepted'`), moderator, "the audit names the moderator, not the owner");
    assertOnlyTheKernelWrote("R1");
  });

  test("R2 the same appeal resolved again: the receipt answers, nothing is written twice", async () => {
    flags = { ...PROD_FLAGS };
    const sc = install();
    const out = await resolveAppeal(sc, r1Appeal!);
    assert.deepEqual(out, { ok: true, action: "memory_restored", restored: true, replayed: true });
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${removed}'`), "1");
  });

  test("R3 an owner-DELETED Memory is never brought back; a published or archived one is left for a moderator to decide", async () => {
    flags = { ...PROD_FLAGS };
    const deleted = newMemory("deleted", `${TAG} R3 deleted`);
    let sc = install();
    const gone = await resolveAppeal(sc, appealFor(deleted));
    assert.equal(gone.ok, false, JSON.stringify(gone));
    assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${deleted}'`), "deleted", "the owner's deletion stands");
    for (const state of ["published", "archived"]) {
      const id = newMemory(state, `${TAG} R3 ${state}`);
      sc = install();
      const out = await resolveAppeal(sc, appealFor(id));
      assert.equal(out.ok, true);
      assert.equal((out as any).action, "restore_requires_policy", `${state}: ${JSON.stringify(out)}`);
      assert.equal((out as any).restored, false);
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${id}'`), state, `${state}: unchanged`);
      assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${id}'`), "0");
      assert.equal(writes().filter((s) => CANONICAL_WRITE.test(s)).length, 0);
    }
  });

  test("R4 a non-admin actor is refused by name, and a wrong appellant matches nothing; neither writes", async () => {
    flags = { ...PROD_FLAGS };
    const target = newMemory("removed", `${TAG} R4`);
    let sc = install();
    const notMod = await resolveAppeal(sc, appealFor(target, owner, stranger));
    assert.equal(notMod.ok, false);
    assert.match((notMod as any).reason, /MEMORY_AUTH_NOT_MODERATOR/);
    sc = install();
    const wrongOwner = await resolveAppeal(sc, appealFor(target, stranger, moderator));
    assert.equal(wrongOwner.ok, false);
    assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${target}'`), "removed");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${target}'`), "0");
    assert.equal(scalar(`SELECT string_agg(reason, ',' ORDER BY reason) FROM public.memory_command_audit WHERE memory_id = '${target}' AND outcome = 'rejected'`), "MEMORY_AUTH_NOT_MODERATOR,MEMORY_NOT_FOUND");
  });

  test("R5 the kernel OFF: the legacy update runs, and no event is claimed", async () => {
    flags = { ...PROD_FLAGS, memory_kernel_enabled: false };
    const target = newMemory("removed", `${TAG} R5`);
    const sc = install();
    const out = await resolveAppeal(sc, appealFor(target));
    assert.deepEqual(out, { ok: true, action: "memory_restored" });
    assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${target}'`), "published");
    assert.equal(scalar(`SELECT count(*) FROM public.${EVENTS} WHERE memory_id = '${target}'`), "0");
    assert.equal(writes().filter((s) => /^WITH w AS \(UPDATE public\.memories SET state = /.test(s)).length, 1);
  });

  test("R6 on 3911's kernel (no MODERATION_RESTORE_MEMORY): MEMORY_COMMAND_UNKNOWN_TYPE, and the compat arm restores as before 3912", async () => {
    await on3911(async () => {
      flags = { ...PROD_FLAGS };
      const target = newMemory("removed", `${TAG} R6`);
      const sc = install();
      const out = await resolveAppeal(sc, appealFor(target));
      assert.deepEqual(out, { ok: true, action: "memory_restored" });
      assert.equal(scalar(`SELECT state FROM public.memories WHERE id = '${target}'`), "published");
      assert.equal(writes().filter((s) => /^WITH w AS \(UPDATE public\.memories SET state = /.test(s)).length, 1, "the pre-3912 update ran");
    });
  });
  test("H1 the outbox drain tick drains the kernel's events and writes its job_health row and its /healthz/schedulers status", async () => {
    flags = { ...PROD_FLAGS };
    exec(`DELETE FROM public.job_health WHERE job = '${MEMORY_OUTBOX_DRAIN_JOB}';`);
    _resetMemoryOutboxDrainStatus();
    const pending = Number(scalar(`SELECT count(*) FROM public.${OUTBOX} WHERE published_at IS NULL`));
    assert.ok(pending >= 1, "the V and R cases left outbox rows pending");
    const now = new Date();
    const r = await runMemoryOutboxDrainTick({ client: memoryBridge({ flags }), now });
    assert.deepEqual([r.reason, r.claimed, r.acked, r.failed], [null, pending, pending, 0]);
    const row = rows<{ last_run_at: string; last_success_at: string }>(`SELECT last_run_at::text, last_success_at::text FROM public.job_health WHERE job = '${MEMORY_OUTBOX_DRAIN_JOB}'`);
    assert.equal(row.length, 1, "production can now show the drain ran");
    assert.ok(row[0]!.last_run_at && row[0]!.last_success_at);
    const st = getMemoryOutboxDrainStatus();
    assert.equal(st.lastSuccessAt, now.toISOString());
    assert.equal(st.consecutiveFailures, 0);
    assert.equal(memoryOutboxDrainHealthDetail(st), `last pass: claimed ${pending}, acked ${pending}, failed 0`);
  });

  test("H2 a pass that cannot claim is a FAILED pass: job_health gets last_run_at and no new last_success_at, and the status counts it", async () => {
    flags = { ...PROD_FLAGS };
    exec(`DELETE FROM public.job_health WHERE job = '${MEMORY_OUTBOX_DRAIN_JOB}';`);
    _resetMemoryOutboxDrainStatus();
    const t0 = new Date("2026-10-24T10:00:00.000Z");
    const t1 = new Date(t0.getTime() + 1_000); // inside the one-minute throttle a SUCCESS would honour
    await runMemoryOutboxDrainTick({ client: memoryBridge({ flags }), now: t0 });
    const r = await runMemoryOutboxDrainTick({ client: memoryBridge({ flags, failOn: (table, op) => op === "rpc" && table === "memory_outbox_claim" }), now: t1 });
    assert.equal(r.reason, "error");
    const row = rows<{ run: string; success: string }>(`SELECT to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS run, to_char(last_success_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS success FROM public.job_health WHERE job = '${MEMORY_OUTBOX_DRAIN_JOB}'`);
    assert.equal(row.length, 1);
    assert.deepEqual([row[0]!.run, row[0]!.success], ["2026-10-24T10:00:01", "2026-10-24T10:00:00"],
      "the failed pass is persisted at once (not throttled), and it does not claim a success");
    const st = getMemoryOutboxDrainStatus();
    assert.equal(st.consecutiveFailures, 1);
    assert.equal(st.lastSuccessAt, t0.toISOString());
    assert.match(memoryOutboxDrainHealthDetail(st) ?? "", /^last pass FAILED \(error\)/);
    exec(`DELETE FROM public.job_health WHERE job = '${MEMORY_OUTBOX_DRAIN_JOB}';`);
  });
});
