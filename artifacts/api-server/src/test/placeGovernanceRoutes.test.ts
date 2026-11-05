import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import removalRouter from "../routes/placesCanonical.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const subjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const reportId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const auditId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = "a".repeat(64);
const context={contractVersion:1,placeId:subjectId,reportId,action:'withhold',intoId:null,name:'Place',status:'active',moderationStatus:'visible',mergedIntoId:null,restoreStatus:'unverified',destinationName:null,contextToken:token};
const receipt={ok:true,contractVersion:1,placeId:subjectId,reportId,action:'withhold',intoId:null,operationId,auditId,replayed:false,committedAt:'2026-11-05T07:00:00Z'};
const payload={action:'withhold',reportId,reason:'Reviewed',contextToken:token};
let role = "admin";
let roleError: unknown = null;
let reply: { data: unknown; error: unknown };
let calls: { name: string; args: Record<string, unknown>; signal?: AbortSignal }[];
let forbiddenWrites: string[];
let cacheReads: number;
let transport: (() => Promise<unknown>) | undefined;
let rpcReplies: Record<string, {data: unknown; error: unknown}>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  role = "admin";
  roleError = null;
  calls = [];
  forbiddenWrites = [];
  cacheReads = 0;
  transport = undefined;
  rpcReplies = {};
  reply = { data: receipt, error: null };
  _resetRateLimit();
  globalThis.fetch = async () => { throw new Error("External network forbidden"); };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: adminId } }, error: null }) },
    from(table: string) {
      if (table === "discovery_places") cacheReads += 1;
      assert.ok(["profiles", "discovery_places", "post_media"].includes(table), `Unexpected table access: ${table}`);
      const query = {
        select() { return query; }, eq() { return query; }, limit() { return query; },
        abortSignal() { return query; },
        then(resolve: any, reject: any) { return Promise.resolve({data: [],error:null}).then(resolve,reject); },
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
          return (transport ? transport() : Promise.resolve(rpcReplies[name] ?? reply)).then(resolve, reject);
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

function invoke(method = "post", body: unknown = payload, headers: Record<string, unknown> = { "idempotency-key": operationId }, query:Record<string,string> = { action:"withhold",reportId }, rawHeaders?: string[], type = 'comment') {
  const path = "/admin/places/:id/governance";
  const route = (removalRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `Missing connected ${method} ${path}`);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Route exceeded its test budget")), 8000);
    const response = { code: 200, setHeader() {}, set() { return this; }, status(value: number) { this.code = value; return this; },
      json(value: unknown) { clearTimeout(timer); resolve({ status: this.code, body: value }); return this; } };
    const request = { path:`/admin/places/${subjectId}/governance`, params: { id: subjectId }, query, body, rawHeaders:rawHeaders??["Idempotency-Key",operationId], headers: { authorization: "Bearer synthetic", ...headers },
      log: { error() {}, warn() {}, info() {}, debug() {} } };
    Promise.resolve(route.stack[0].handle(request, response, (error: unknown) => { clearTimeout(timer); reject(error); })).catch(reject);
  });
}

test('confirmed place action reaches only the audited RPC with authenticated actor',async()=>{
 const result=await invoke();assert.equal(result.status,200);assert.equal(calls.length,1);assert.equal(calls[0]!.name,'apply_place_governance_action');
 assert.equal(calls[0]!.args.p_admin_id,adminId);assert.equal(calls[0]!.args.p_expected_context_token,token);assert.ok(calls[0]!.signal);
});
test('fresh context checks every target field before returning it',async()=>{
 reply.data=context;assert.equal((await invoke('get')).status,200);
 reply.data={...context,placeId:reportId};assert.equal((await invoke('get')).status,503);
});
test('nonadmins and failed role reads never enter the command',async()=>{
 role='user';assert.equal((await invoke()).status,403);assert.equal(calls.length,0);
 role='admin';roleError={message:'offline'};assert.equal((await invoke()).status,503);assert.equal(calls.length,0);
});
test('missing/ambiguous idempotency and injected fields are refused',async()=>{
 assert.equal((await invoke('post',payload,{'idempotency-key':operationId},{},[])).status,400);
 assert.equal((await invoke('post',{...payload,performed_by:adminId})).status,400);assert.equal(calls.length,0);
});
test('stale context is conflict and an uncertain outcome never becomes success',async()=>{
 reply={data:null,error:{code:'PT409'}};assert.equal((await invoke()).status,409);
 reply={data:null,error:{code:'08006'}};assert.equal((await invoke()).status,503);
 reply={data:{...receipt,auditId:null},error:null};assert.equal((await invoke()).status,503);
});
