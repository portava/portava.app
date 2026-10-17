import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Socket } from "node:net";
import express from "express";
import { _clearTestClient, _setTestClient, _setTestServiceClient } from "../lib/http.js";
import { COMMAND_CAPABILITY, COMMAND_EVENT, COMMAND_KERNEL_FN, COMMAND_SUBJECT, MEMORY_COMMAND_TYPES,
  executeMemoryCommand } from "../lib/memoryCommandBus.js";
import router from "../routes/memoryImportBatches.js";
import {
  abortMemoryImportBatch, createMemoryImportBatch, getMemoryImportBatch, stepMemoryImportBatch,
  isMemoryImportCommandRegistered, memoryImportAvailability, memoryImportCreateSchema, memoryImportStepSchema,
} from "../services/memory/memoryImportBatches.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH = "10000000-0000-4000-8000-000000000001";
const MEMORY = "20000000-0000-4000-8000-000000000001";
const KEY = "30000000-0000-4000-8000-000000000001";
const progress = { id: BATCH, source: "existing_legacy_memories", status: "queued", total: 1,
  checkpoint: 0, completed: 0, revoked: 0, attempts: 0, lastErrorCode: null };
let enabled = false;
let rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
let rpcAnswer: (name: string) => { data: unknown; error: unknown };

function client() {
  return {
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
    from(table: string) {
      assert.ok(["feature_flags", "profiles"].includes(table), `No canonical table access: ${table}`);
      const query = {
        select() { return query; }, eq() { return query; },
        async maybeSingle() {
          return { data: table === "feature_flags" ? { enabled }
            : { id: OWNER, account_status: "active", user_account_states: [] }, error: null };
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      rpcCalls.push({ name, args });
      return rpcAnswer(name);
    },
  };
}

beforeEach(() => {
  enabled = false;
  rpcCalls = [];
  rpcAnswer = (name) => ({ data: name === "memory_import_batches_contract" ? 1 : { ok: true, batch: progress }, error: null });
});
afterEach(() => { _clearTestClient(); _setTestServiceClient(null); });

async function request(path: string, options: { token?: string | null; method?: string; body?: unknown; key?: string } = {}) {
  _setTestClient(client(), true);
  const app = express();
  app.use((_req, res, next) => { res.vary("Accept-Encoding"); next(); });
  app.use("/api", router);
  app.use((_req, res) => { res.status(404).json({ error: "not_found" }); });
  const incoming = new http.IncomingMessage(new Socket());
  incoming.method = options.method ?? "GET";
  incoming.url = `/api${path}`;
  if (options.token !== null) incoming.headers.authorization = `Bearer ${options.token ?? OWNER}`;
  if (options.key) incoming.headers["idempotency-key"] = options.key;
  Object.assign(incoming, { body: options.body });
  const outgoing = new http.ServerResponse(incoming);
  return new Promise<{ status: number; body: any; headers: Headers }>((resolve, reject) => {
    outgoing.end = ((chunk: string) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(outgoing.getHeaders())) headers.set(name, String(value));
        resolve({ status: outgoing.statusCode, body: JSON.parse(String(chunk)), headers });
      } catch (error) { reject(error); }
      return outgoing;
    }) as typeof outgoing.end;
    app(incoming, outgoing);
  });
}

describe("H37 import service and router", () => {
  it("has a closed canonical command registration and dispatches through the real bus", async () => {
    const command = MEMORY_COMMAND_TYPES.find((type) => String(type) === "BACKFILL_LEGACY_MEMORY");
    assert.ok(command, "Parent integration required: register BACKFILL_LEGACY_MEMORY in memoryCommandBus.ts");
    assert.equal(isMemoryImportCommandRegistered(), true);
    assert.equal(COMMAND_SUBJECT[command], "memory");
    assert.equal(COMMAND_CAPABILITY[command], "owner");
    assert.equal(COMMAND_EVENT[command], "memory.corrected");
    assert.equal(COMMAND_KERNEL_FN[command], "memory_import_legacy_execute");
    rpcAnswer = () => ({ data: { ok: true, duplicate: false, memory_id: MEMORY, event_id: KEY,
      event_type: "memory.corrected", result: { changed: 0 }, contract_version: 1 }, error: null });
    const result = await executeMemoryCommand(client(), { type: command, memoryId: MEMORY, actorUserId: OWNER,
      commandId: KEY, idempotencyKey: `import:${BATCH}:1`, payload: { batch_id: BATCH, ordinal: 1 } });
    assert.equal(result.ok, true);
    assert.equal(rpcCalls[0]!.name, "memory_import_legacy_execute");
    assert.equal((rpcCalls[0]!.args.p_command as { actor_user_id: string }).actor_user_id, OWNER);
  });

  it("fails closed with flags off without touching new schema", async () => {
    assert.equal(await memoryImportAvailability(client(), true), "feature_disabled");
    assert.deepEqual(rpcCalls, []);
  });

  it("rejects missing, wrong and unreadable schema versions, not just a missing table", async () => {
    for (const answer of [{ data: null, error: null }, { data: 2, error: null }, { data: 1, error: { code: "42P01" } }]) {
      rpcAnswer = () => answer;
      assert.equal(await memoryImportAvailability(client(), false), "schema_unavailable");
    }
    rpcAnswer = () => { throw new Error("private database detail"); };
    assert.equal(await memoryImportAvailability(client(), false), "schema_unavailable");
  });

  it("allows only explicit bounded existing-memory inputs, with no imported claims or raw files", () => {
    const valid = { source: "existing_legacy_memories", memoryIds: [MEMORY] };
    assert.equal(memoryImportCreateSchema.safeParse(valid).success, true);
    for (const body of [{ ...valid, tripId: KEY }, { ...valid, participants: [OWNER] }, { ...valid, visited: true },
      { ...valid, file: "/tmp/upload.csv" }, { ...valid, source: "uploaded_file" },
      { ...valid, memoryIds: [MEMORY, MEMORY.toUpperCase()] }, { ...valid, memoryIds: Array(201).fill(MEMORY) }]) {
      assert.equal(memoryImportCreateSchema.safeParse(body).success, false);
    }
    for (const limit of [0, 26, 1.5]) assert.equal(memoryImportStepSchema.safeParse({ checkpoint: 0, limit }).success, false);
    assert.equal(memoryImportStepSchema.safeParse({ checkpoint: 0, limit: 25 }).success, true);
  });

  it("uses owner-bound RPCs only and returns stripped progress, not source rows", async () => {
    rpcAnswer = () => ({ data: { ok: true, batch: { ...progress, caption: "private", owner_id: OWNER, memoryIds: [MEMORY] } }, error: null });
    const connection = client();
    await createMemoryImportBatch(connection, OWNER, KEY, [MEMORY]);
    await stepMemoryImportBatch(connection, OWNER, BATCH, 0, 25);
    await abortMemoryImportBatch(connection, OWNER, BATCH);
    const result = await getMemoryImportBatch(connection, OWNER, BATCH);
    assert.equal(result.ok, true);
    assert.doesNotMatch(JSON.stringify(result), /private|owner_id|memoryIds/);
    assert.deepEqual(rpcCalls.map((call) => call.name), ["memory_import_batches_create", "memory_import_batches_step",
      "memory_import_batches_abort", "memory_import_batches_get"]);
    for (const call of rpcCalls) assert.equal(call.args.p_owner_id, OWNER);
  });

  it("never reports malformed or failed RPC results as successful progress", async () => {
    for (const data of [null, {}, { ok: true, batch: { ...progress, checkpoint: 2 } },
      { ok: true, batch: { ...progress, completed: 2 } }, { ok: false, reason: "raw SQL message" }]) {
      rpcAnswer = () => ({ data, error: null });
      assert.deepEqual(await getMemoryImportBatch(client(), OWNER, BATCH), { ok: false, reason: "unavailable" });
    }
  });

  it("sets private/no-store and Vary Authorization before unauthenticated and disabled errors", async () => {
    for (const options of [{ token: null }, { method: "POST", body: { source: "existing_legacy_memories", memoryIds: [MEMORY] }, key: KEY }]) {
      const response = await request(options.token === null ? `/memory-import-batches/${BATCH}` : "/memory-import-batches", options);
      assert.ok(response.status >= 400);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("vary") ?? "", /Authorization/);
      assert.match(response.headers.get("vary") ?? "", /Accept-Encoding/);
    }
    assert.deepEqual(rpcCalls, []);
  });

  it("keeps status and abort owner-scoped and uncached even when writes are disabled", async () => {
    for (const [path, method] of [[`/memory-import-batches/${BATCH}`, "GET"], [`/memory-import-batches/${BATCH}/abort`, "POST"]]) {
      const response = await request(path!, { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("vary") ?? "", /Authorization/);
      assert.deepEqual(response.body.batch, progress);
      assert.equal(rpcCalls.at(-1)!.args.p_owner_id, OWNER);
    }
  });

  it("does not leak foreign/absent jobs or database details through errors", async () => {
    rpcAnswer = (name) => ({ data: name === "memory_import_batches_contract" ? 1 : { ok: false, reason: "not_found" }, error: null });
    const hidden = await request(`/memory-import-batches/${BATCH}`);
    assert.equal(hidden.status, 404);
    assert.equal(hidden.headers.get("cache-control"), "private, no-store");
    rpcAnswer = () => { throw new Error("secret payload"); };
    const unavailable = await request(`/memory-import-batches/${BATCH}`);
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(JSON.stringify(unavailable.body), /secret payload/);
  });

  it("routes create and step with bounded payloads and rejects attempts to override owner", async () => {
    enabled = true;
    const response = await request("/memory-import-batches", { method: "POST", key: KEY,
      body: { source: "existing_legacy_memories", memoryIds: [MEMORY] } });
    assert.equal(response.status, 201, "Parent canonical command registration must be present before writes are reachable");
    assert.deepEqual(rpcCalls.at(-1)!.args, { p_owner_id: OWNER, p_key: KEY, p_memory_ids: [MEMORY] });
    const advanced = await request(`/memory-import-batches/${BATCH}/step`, { method: "POST", body: { checkpoint: 0, limit: 1 } });
    assert.equal(advanced.status, 200);
    assert.deepEqual(rpcCalls.at(-1)!.args, { p_owner_id: OWNER, p_batch_id: BATCH, p_checkpoint: 0, p_limit: 1 });
    const rejected = await request("/memory-import-batches", { method: "POST", key: KEY,
      body: { source: "existing_legacy_memories", memoryIds: [MEMORY], ownerId: "forged" } });
    assert.equal(rejected.status, 400);
  });
});
