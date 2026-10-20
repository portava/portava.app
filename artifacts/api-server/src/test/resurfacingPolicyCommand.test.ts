import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { _setTestClient } from "../lib/http.js";
import { executeMemoryCommand, COMMAND_SUBJECT, COMMAND_CAPABILITY } from "../lib/memoryCommandBus.js";
import { drainMemoryOutbox, eventSubjectOf } from "../services/memoryProjections/outboxConsumer.js";
import controlsRouter from "../routes/memoryResurfacingControls.js";
import highlightsRouter from "../routes/highlights.js";
import { fixtureTables, makeFakeClient, VIEWER, OTHER, H_MINE } from "./highlightsSpecHarness.js";

const target = "40000000-0000-4000-8000-000000000001";
const eventId = "50000000-0000-4000-8000-000000000001";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function mounted(enabled: boolean | undefined, rpcError = false, gateReply?: () => Promise<unknown>) {
  const tables = fixtureTables();
  tables.feature_flags = [{ flag: "memory_kernel_enabled", enabled: true }, ...(enabled === undefined ? [] : [{ flag: "memory_resurfacing_policy_enabled", enabled }])];
  tables.memories = [{ id: target, owner_id: VIEWER, state: "published", visibility: "only_me" }];
  tables.memory_resurfacing_preferences = [];
  const calls: any[] = [];
  const client = Object.assign(makeFakeClient(tables), {
    async rpc(name: string, args: any) {
      calls.push({ name, ...args });
      if (rpcError) return { data: null, error: { message: "synthetic RPC failure" } };
      const intent = args.p_command.payload;
      if (intent.target.kind === "memory") {
        const memory = tables.memories.find((entry) => entry.id === intent.target.id && entry.owner_id === args.p_command.actor_user_id && entry.state !== "deleted");
        const reason = !memory ? "MEMORY_NOT_FOUND" : intent.on && intent.control === "KEEP_PRIVATE_FOREVER" && memory.visibility !== "only_me" ? "RESURFACING_NOT_PRIVATE" : null;
        if (reason) return { data: { ok: false, reason, contract_version: 1 }, error: null };
      }
      return { data: { ok: true, policy_owner_id: VIEWER, event_id: eventId,
        event_type: "resurfacing.policy_changed", contract_version: 1,
        result: { control: intent.control, subjectId: intent.target.id, subjectType: intent.target.kind,
          createdAt: "2026-10-16T00:00:00Z", cleared: true } }, error: null };
    },
  });
  if (gateReply) {
    const from = client.from.bind(client);
    client.from = (table: string) => {
      const query = from(table);
      if (table === "feature_flags") query.maybeSingle = gateReply;
      return query;
    };
  }
  _setTestClient(client as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {} }; next(); });
  app.use(controlsRouter, highlightsRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { tables, calls, async call(method: string, path: string, body?: unknown, actor = VIEWER, key = "policy-key") {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${actor}`,
      "content-type": "application/json", "idempotency-key": key }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.text() };
  } };
}

test("SET_RESURFACING_POLICY routes a real owner subject through the canonical bus", async () => {
  const calls: any[] = [];
  const result = await executeMemoryCommand({ rpc: async (name: string, args: any) => {
    calls.push({ name, ...args });
    return { data: { ok: true, policy_owner_id: VIEWER, event_id: eventId,
      event_type: "resurfacing.policy_changed", result: {}, contract_version: 1 }, error: null };
  } }, { commandId: randomUUID(), memoryId: null, actorUserId: VIEWER, idempotencyKey: "policy",
    type: "SET_RESURFACING_POLICY" as any, payload: { target: { kind: "person", id: OTHER }, control: "HIDE_PERSON_FROM_RESURFACING", on: true } });
  assert.equal((COMMAND_SUBJECT as any).SET_RESURFACING_POLICY, "owner_policy");
  assert.equal((COMMAND_CAPABILITY as any).SET_RESURFACING_POLICY, "owner");
  assert.equal(calls[0].name, "memory_resurfacing_policy_execute");
  assert.equal(calls[0].p_command.policy_owner_id, VIEWER);
  assert.equal(calls[0].p_command.memory_id, undefined);
  assert.equal((result as any).policyOwnerId, VIEWER);
});

for (const method of ["PUT", "DELETE"]) {
  test(`mounted Memory ${method} delegates exactly once and preserves 204`, async () => {
    const app = await mounted(true);
    assert.equal((await app.call(method, `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`)).status, 204);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].p_command.payload.on, method === "PUT");
    assert.deepEqual(app.tables.memory_resurfacing_preferences, []);
  });
  test(`mounted Highlight ${method} delegates and preserves response`, async () => {
    const app = await mounted(true);
    const result = await app.call(method, "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE, ownerId: OTHER });
    assert.equal(result.status, 200, result.body);
    assert.equal(app.calls.length, 1);
    assert.equal(app.calls[0].p_command.actor_user_id, VIEWER);
    assert.equal(app.calls[0].p_command.payload.on, method === "PUT");
    assert.deepEqual(app.tables.highlight_resurfacing_preferences, []);
    assert.deepEqual(JSON.parse(result.body), method === "PUT" ? { control: "DO_NOT_RESURFACE", subjectId: H_MINE,
      subjectType: "highlight", createdAt: "2026-10-16T00:00:00Z", suppresses: ["proactive_resurfacing"] } : { cleared: true });
  });
}

for (const enabled of [false, undefined]) test(`kernel ${String(enabled)} retains explicit legacy behavior`, async () => {
  const app = await mounted(enabled);
  assert.equal((await app.call("PUT", `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`, undefined, VIEWER, "")).status, 204);
  assert.equal(app.tables.memory_resurfacing_preferences.length, 1);
  assert.equal((await app.call("DELETE", `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`, undefined, VIEWER, "")).status, 204);
  assert.equal(app.tables.memory_resurfacing_preferences.length, 0);
  const set = await app.call("PUT", "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE }, VIEWER, "");
  assert.equal(set.status, 200);
  assert.deepEqual(JSON.parse(set.body), { control: "DO_NOT_RESURFACE", subjectId: H_MINE,
    subjectType: "highlight", createdAt: null, suppresses: ["proactive_resurfacing"] });
  const clear = await app.call("DELETE", "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE }, VIEWER, "");
  assert.equal(clear.status, 200);
  assert.deepEqual(JSON.parse(clear.body), { cleared: true });
  assert.equal(app.calls.length, 0);
});

test("enabled RPC failure never falls back to either preference writer", async () => {
  const app = await mounted(true, true);
  assert.equal((await app.call("PUT", `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`)).status, 503);
  assert.equal((await app.call("PUT", "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE })).status, 503);
  assert.deepEqual(app.tables.memory_resurfacing_preferences, []);
  assert.deepEqual(app.tables.highlight_resurfacing_preferences, []);
});

for (const [label, reply] of Object.entries({
  error: async (): Promise<unknown> => ({ data: null, error: { message: "gate unavailable" } }),
  enabledWithError: async () => ({ data: { enabled: true }, error: { message: "gate unavailable" } }),
  disabledWithError: async () => ({ data: { enabled: false }, error: { message: "gate unavailable" } }),
  thrown: async () => { throw new Error("gate unavailable"); },
  missingEnabled: async () => ({ data: {}, error: null }),
  invalidEnabled: async () => ({ data: { enabled: "false" }, error: null }),
  nullEnabled: async () => ({ data: { enabled: null }, error: null }),
  missingData: async () => ({ error: null }),
  missingError: async () => ({ data: null }),
  missingReply: async (): Promise<unknown> => null,
})) test(`unreadable dedicated gate (${label}) refuses all four mounted writers`, async () => {
  const app = await mounted(true, false, reply);
  app.tables.memory_resurfacing_preferences.push({ memory_id: target, owner_id: VIEWER, control: "DO_NOT_RESURFACE" });
  app.tables.highlight_resurfacing_preferences.push({ owner_id: VIEWER, control: "DO_NOT_RESURFACE", subject_type: "highlight", subject_id: H_MINE });
  const originalMemory = structuredClone(app.tables.memory_resurfacing_preferences);
  const originalHighlight = structuredClone(app.tables.highlight_resurfacing_preferences);
  for (const method of ["PUT", "DELETE"]) {
    assert.equal((await app.call(method, `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`)).status, 503);
    assert.equal((await app.call(method, "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE })).status, 503);
  }
  assert.equal(app.calls.length, 0);
  assert.deepEqual(app.tables.memory_resurfacing_preferences, originalMemory);
  assert.deepEqual(app.tables.highlight_resurfacing_preferences, originalHighlight);
});

test("dedicated gate on with kernel off refuses without falling back", async () => {
  const app = await mounted(true);
  app.tables.feature_flags[0].enabled = false;
  assert.equal((await app.call("PUT", `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`)).status, 503);
  assert.equal((await app.call("PUT", "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE })).status, 503);
  assert.equal(app.calls.length, 0);
  assert.deepEqual(app.tables.memory_resurfacing_preferences, []);
  assert.deepEqual(app.tables.highlight_resurfacing_preferences, []);
});

for (const key of ["", " ", "k".repeat(201)]) test(`enabled writes require a reusable client key of valid length (${key.length})`, async () => {
  const app = await mounted(true);
  assert.equal((await app.call("PUT", `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`, undefined, VIEWER, key)).status, 400);
  assert.equal((await app.call("DELETE", "/highlights/resurfacing-controls", { control: "DO_NOT_RESURFACE", subjectId: H_MINE }, VIEWER, key)).status, 400);
  assert.equal(app.calls.length, 0);
});

test("existing ownership, private-only and confirmation refusals remain intact", async () => {
  const app = await mounted(true);
  assert.equal((await app.call("PUT", `/memories/${target}/resurfacing-controls/DO_NOT_RESURFACE`, undefined, OTHER)).status, 404);
  app.tables.memories[0].visibility = "public";
  assert.equal((await app.call("PUT", `/memories/${target}/resurfacing-controls/KEEP_PRIVATE_FOREVER`)).status, 409);
  assert.equal((await app.call("DELETE", "/highlights/resurfacing-controls", { control: "KEEP_PRIVATE_FOREVER", subjectId: H_MINE })).status, 400);
  assert.equal(app.calls.length, 2);
});

for (const fails of [false, true]) test(`owner event is explicitly delivered; invalidation failure=${fails} is not silently acked`, async () => {
  const tables = fixtureTables();
  tables.memory_domain_events = [{ event_id: eventId, policy_owner_id: VIEWER, type: "resurfacing.policy_changed",
    payload_json: { target: { kind: "person", id: OTHER }, control: "HIDE_PERSON_FROM_RESURFACING", on: true } }];
  const calls: any[] = [];
  const client = Object.assign(makeFakeClient(tables, { failTables: fails ? new Set(["compass_feed_cache"]) : undefined }), {
    async rpc(name: string, args: any) {
      calls.push({ name, ...args });
      return { data: name === "memory_outbox_claim" ? [{ id: 1, event_id: eventId, memory_id: null,
        highlight_id: null, policy_owner_id: VIEWER, type: "resurfacing.policy_changed", created_at: "2026-10-16T00:00:00Z", attempts: 1 }]
        : name === "memory_outbox_ack" ? args.p_ids.length : null, error: null };
    },
  });
  assert.equal(eventSubjectOf("resurfacing.policy_changed"), "owner_policy");
  const result = await drainMemoryOutbox(client);
  assert.equal(result.acked, fails ? 0 : 1);
  assert.equal(result.failed, fails ? 1 : 0);
  assert.notEqual(result.outcomes[0].failureClass, "unsubscribed_event_type");
});
