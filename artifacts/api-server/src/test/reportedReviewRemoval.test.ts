import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import reviewsRouter from "../routes/reviews.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reviewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const reportId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const auditId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = "a".repeat(64);
const context = { contractVersion: 1, reviewId, reportId, reportStatus: "open", reviewToken: token, reportToken: token,
  review: { rating: 4, body: "Current review", state: "published", entityType: "trip", entityId: reviewId } };
const receipt = { ok: true, contractVersion: 1, reviewId, reportId, operationId, auditId, stateAtCommit: "removed",
  committedAt: "2026-10-16T12:00:00+00:00", replayed: false, reviewedEntityType: "trip", reviewedEntityId: reviewId };
const payload = { report_id: reportId, reason: " Reviewed conduct ", expected_review_token: token, expected_report_token: token };
let role = "admin";
let roleError: unknown = null;
let reply: { data: unknown; error: unknown };
let calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[];
let forbiddenWrites: string[];
let cacheReads: number;
let transport: (() => Promise<unknown>) | undefined;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  role = "admin";
  roleError = null;
  calls = [];
  forbiddenWrites = [];
  cacheReads = 0;
  transport = undefined;
  reply = { data: receipt, error: null };
  _resetRateLimit();
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: adminId } }, error: null }) },
    from(table: string) {
      if (table === "discovery_places") cacheReads += 1;
      assert.ok(["profiles", "discovery_places"].includes(table), `Unexpected table access: ${table}`);
      const query = {
        select() { return query; }, eq() { return query; }, limit() { return query; },
        update() { forbiddenWrites.push(table); return query; }, insert() { forbiddenWrites.push(table); return query; },
        delete() { forbiddenWrites.push(table); return query; },
        async maybeSingle() { return { data: table === "profiles" ? { id: adminId, role, account_status: "active" } : null, error: roleError }; },
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      const call = { name, args, signal: undefined as AbortSignal | undefined };
      calls.push(call);
      const query = {
        abortSignal(signal: AbortSignal) { call.signal = signal; return query; },
        then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
          return (transport ? transport() : Promise.resolve(reply)).then(resolve, reject);
        },
      };
      return query;
    },
  };
  _setTestClient(client, true);
});
afterEach(() => {
  _clearTestClient();
  globalThis.fetch = originalFetch;
  assert.deepEqual(forbiddenWrites, []);
});

function invoke(method = "post", body: unknown = payload, headers: Record<string, unknown> = { "idempotency-key": operationId }, query = { report_id: reportId }, rawHeaders?: string[]) {
  const path = method === "get" ? "/reviews/:id/reported-removal-context" : "/reviews/:id/reported-removal";
  const route = (reviewsRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `Missing connected ${method} ${path}`);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Route exceeded its test budget")), 8000);
    const response = { code: 200, setHeader() {}, set() { return this; }, status(value: number) { this.code = value; return this; },
      json(value: unknown) { clearTimeout(timer); resolve({ status: this.code, body: value }); return this; } };
    const request = { params: { id: reviewId }, query, body, rawHeaders, headers: { authorization: "Bearer synthetic", ...headers },
      log: { error() {}, warn() {}, info() {}, debug() {} } };
    Promise.resolve(route.stack[0].handle(request, response, (error: unknown) => { clearTimeout(timer); reject(error); })).catch(reject);
  });
}

test("context is connected to the read RPC and returns only a validated current preview", async () => {
  reply.data = context;
  const result = await invoke("get");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, context);
  assert.equal(calls[0].name, "get_reported_review_removal_context");
  assert.deepEqual(calls[0].args, { p_admin_id: adminId, p_review_id: reviewId, p_report_id: reportId });
  assert.ok(calls[0].signal instanceof AbortSignal);
});
test("removal binds the authenticated actor and complete normalized intent to one RPC", async () => {
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.equal(result.body.auditId, auditId);
  assert.equal(result.body.reviewedEntityId, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { p_admin_id: adminId, p_review_id: reviewId, p_report_id: reportId, p_operation_id: operationId,
    p_reason: "Reviewed conduct", p_expected_review_token: token, p_expected_report_token: token });
  assert.ok(calls[0].signal instanceof AbortSignal);
});
test("same operation and intent survive replay without a second route-side writer", async () => {
  await invoke();
  reply.data = { ...receipt, replayed: true };
  const result = await invoke();
  assert.equal(result.status, 200);
  assert.equal(result.body.replayed, true);
  assert.deepEqual(calls[0].args, calls[1].args);
});
for (const reason of ["\u00a0😀\uFEFF", "😀".repeat(1000)]) {
  test(`reason normalizes by code point, not UTF-16 length (${reason.length})`, async () => {
    assert.equal((await invoke("post", { ...payload, reason })).status, 200);
    assert.equal(calls[0].args.p_reason, reason.trim());
  });
}
for (const reason of ["\t\u00a0\uFEFF", "😀".repeat(1001), null, 7]) {
  test(`invalid reason refuses before RPC (${String(reason).length})`, async () => {
    assert.equal((await invoke("post", { ...payload, reason })).status, 400);
    assert.equal(calls.length, 0);
  });
}
for (const header of [undefined, "", "not-uuid", [operationId, operationId], `${operationId}, ${operationId}`]) {
  test(`missing/ambiguous operation identity refuses: ${JSON.stringify(header)}`, async () => {
    assert.equal((await invoke("post", payload, { "idempotency-key": header })).status, 400);
    assert.equal(calls.length, 0);
  });
}
for (const patch of [{ admin_id: adminId }, { target_user_id: adminId }, { expected_review_token: null }, { expected_report_token: "A".repeat(64) }, { report_id: reviewId + "/other" }]) {
  test(`strict identity/context validation: ${Object.keys(patch).join()}`, async () => {
    assert.equal((await invoke("post", { ...payload, ...patch })).status, 400);
    assert.equal(calls.length, 0);
  });
}
test("non-admin is refused without invoking RPC", async () => {
  role = "user";
  assert.equal((await invoke()).status, 403);
  assert.equal(calls.length, 0);
});
test("unreadable API role is unavailable rather than permission denial", async () => {
  roleError = { message: "synthetic outage" };
  assert.equal((await invoke()).status, 503);
  assert.equal(calls.length, 0);
});
for (const [code, status] of [["PT403", 403], ["PT404", 404], ["PT409", 409], ["PT400", 400], ["PGRST202", 503], ["42P01", 503], ["55P03", 503], ["40P01", 503], ["42501", 503]] as const) {
  test(`RPC refusal ${code} is ${status}, never falls back to DELETE`, async () => {
    reply = { data: null, error: { code, message: "private database diagnostic" } };
    const result = await invoke();
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result.body).includes("private database diagnostic"));
    assert.equal(calls.length, 1);
  });
}
for (const data of [null, {}, [], { ...receipt, auditId: null }, { ...receipt, reviewId: reportId }, { ...receipt, operationId: reviewId }, { ...receipt, committedAt: "invalid" }, { ...receipt, replayed: null }]) {
  test(`malformed write reply is unavailable/unknown commit (${JSON.stringify(data).slice(0, 60)})`, async () => {
    reply.data = data;
    assert.equal((await invoke()).status, 503);
    assert.equal(calls.length, 1);
  });
}
for (const data of [null, {}, { ...context, reviewId: reportId }, { ...context, reviewToken: "x" }, { ...context, review: { ...context.review, body: 1 } }]) {
  test(`bad context never enables removal (${JSON.stringify(data).slice(0, 60)})`, async () => {
    reply.data = data;
    assert.equal((await invoke("get")).status, 503);
  });
}
test("transport failure remains unavailable and retains the same client operation identity", async () => {
  transport = async () => { throw new Error("Response lost after possible commit"); };
  assert.equal((await invoke()).status, 503);
  transport = undefined;
  reply.data = { ...receipt, replayed: true };
  assert.equal((await invoke()).body.replayed, true);
  assert.deepEqual(calls[0].args, calls[1].args);
});
test("place cache invalidation runs after original commit and replay only", async () => {
  reply.data = { ...receipt, reviewedEntityType: "place" };
  await invoke();
  reply.data = { ...receipt, reviewedEntityType: "place", replayed: true };
  await invoke();
  assert.equal(cacheReads, 2);
});
test("duplicate wire header identities refuse even if middleware preserved only one parsed value", async () => {
  const result = await invoke("post", payload, { "idempotency-key": operationId }, { report_id: reportId },
    ["Idempotency-Key", operationId, "IDEMPOTENCY-KEY", operationId]);
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
});
test("one actor cannot start unbounded removal RPC calls", async () => {
  for (let request = 0; request < 60; request += 1) assert.equal((await invoke()).status, 200);
  assert.equal((await invoke()).status, 429);
  assert.equal(calls.length, 60);
});
test("one actor cannot start unbounded confirmation RPC calls", async () => {
  reply.data = context;
  for (let request = 0; request < 60; request += 1) assert.equal((await invoke("get")).status, 200);
  assert.equal((await invoke("get")).status, 429);
  assert.equal(calls.length, 60);
});
test("an RPC that waits for cancellation returns unavailable within the HTTP budget", async () => {
  transport = () => new Promise((_resolve, reject) => {
    const signal = calls.at(-1)!.signal!;
    signal.addEventListener("abort", () => reject(new Error("Synthetic RPC abort")), { once: true });
  });
  const started = Date.now();
  assert.equal((await invoke()).status, 503);
  assert.ok(Date.now() - started < 7500);
  assert.equal(calls.length, 1);
});
