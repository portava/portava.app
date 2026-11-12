import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import removalRouter from "../routes/reportedContentRemoval.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const subjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const reportId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const auditId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const token = "a".repeat(64);
const context = { contractVersion: 1, subjectId, reportId, reportStatus: "open", contentToken: token, reportToken: token,
  preview: "Current comment", effect: "remove_content", subjectType: "comment" };
const receipt = { ok: true, contractVersion: 1, subjectId, reportId, operationId, auditId, effect: "remove_content", subjectType: "comment", ownerId: adminId,
  committedAt: "2026-10-16T12:00:00+00:00", replayed: false,  };
const payload = { reason: " Reviewed conduct ", expected_content_token: token, expected_report_token: token };
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

function invoke(method = "post", body: unknown = payload, headers: Record<string, unknown> = { "idempotency-key": operationId }, query = { report_id: reportId }, rawHeaders?: string[], type = 'comment') {
  const path = "/admin/moderation/reports/:reportId/content/:type/:id/removal";
  const route = (removalRouter as any).stack.find((layer: any) => layer.route?.path === path && layer.route.methods[method])?.route;
  assert.ok(route, `Missing connected ${method} ${path}`);
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Route exceeded its test budget")), 8000);
    const response = { code: 200, setHeader() {}, set() { return this; }, status(value: number) { this.code = value; return this; },
      json(value: unknown) { clearTimeout(timer); resolve({ status: this.code, body: value }); return this; } };
    const request = { params: { id: subjectId, type, reportId }, query, body, rawHeaders, headers: { authorization: "Bearer synthetic", ...headers },
      log: { error() {}, warn() {}, info() {}, debug() {} } };
    Promise.resolve(route.stack[0].handle(request, response, (error: unknown) => { clearTimeout(timer); reject(error); })).catch(reject);
  });
}

test('event removal consults the lifecycle authority before the atomic command',async()=>{
  rpcReplies.get_reported_content_removal_context={data:{...context,subjectType:'event',eventState:'open'},error:null};
  reply.data={...receipt,subjectType:'event'};
  const result=await invoke('post',payload,{'idempotency-key':operationId},{report_id:reportId},undefined,'event');
  assert.equal(result.status,200);
  assert.deepEqual(calls.map(call=>call.name),['get_reported_content_removal_context','remove_reported_content']);
});
test('an unknown event state never reaches the command',async()=>{
  rpcReplies.get_reported_content_removal_context={data:{...context,subjectType:'event',eventState:'invented'},error:null};
  assert.equal((await invoke('post',payload,{'idempotency-key':operationId},{report_id:reportId},undefined,'event')).status,409);
  assert.equal(calls.length,1);
});
test('an event already removed still recovers its exact committed receipt',async()=>{
  rpcReplies.get_reported_content_removal_context={data:null,error:{code:'PT409'}};
  reply.data={...receipt,subjectType:'event',replayed:true};
  const result=await invoke('post',payload,{'idempotency-key':operationId},{report_id:reportId},undefined,'event');
  assert.equal(result.status,200); assert.equal(result.body.replayed,true);
});
test('media with no legacy aliases reconciles cleanly; missing post-commit asset information remains retryable',async()=>{
  reply.data={...receipt,subjectType:'media'};
  rpcReplies.read_reported_content_target={data:{storage_bucket:'post-media',storage_path:'owner/file.jpg'},error:null};
  assert.equal((await invoke('post',payload,{'idempotency-key':operationId},{report_id:reportId},undefined,'media')).status,200);
  rpcReplies.read_reported_content_target={data:null,error:{code:'PGRST202'}};
  assert.equal((await invoke('post',payload,{'idempotency-key':operationId},{report_id:reportId},undefined,'media')).status,503);
});

test('reads a private, validated preview via the service-only RPC', async () => {
  reply.data=context;
  const result=await invoke('get');
  assert.equal(result.status,200);
  assert.deepEqual(result.body,context);
  assert.deepEqual(calls[0].args,{p_admin_id:adminId,p_type:'comment',p_id:subjectId,p_report_id:reportId});
  assert.equal(calls[0].name,'get_reported_content_removal_context');
});
test('binds actor, target, report, reason, version hashes and operation in one command', async () => {
  const result=await invoke();
  assert.equal(result.status,200);
  assert.equal(result.body.ownerId,undefined);
  assert.equal(calls[0].name,'remove_reported_content');
  assert.deepEqual(calls[0].args,{p_admin_id:adminId,p_type:'comment',p_id:subjectId,p_report_id:reportId,p_operation_id:operationId,
    p_reason:'Reviewed conduct',p_expected_content_token:token,p_expected_report_token:token});
});
for(const reason of ['', ' '.repeat(10), 'x'.repeat(1001), null]) test(`invalid reason ${String(reason).length}`,async()=>{
  assert.equal((await invoke('post',{...payload,reason})).status,400); assert.equal(calls.length,0);
});
test('refuses actor spoofing and duplicate idempotency headers',async()=>{
  assert.equal((await invoke('post',{...payload,admin_id:adminId})).status,400);
  assert.equal((await invoke('post',payload,{'idempotency-key':operationId},{report_id:reportId},['Idempotency-Key',operationId,'Idempotency-Key',operationId])).status,400);
  assert.equal(calls.length,0);
});
test('fresh admin role is required',async()=>{ role='user'; assert.equal((await invoke()).status,403); assert.equal(calls.length,0); });
for(const [code,status] of [['PT400',400],['PT403',403],['PT404',404],['PT409',409],['PGRST202',503],['55P03',503]]) {
  test(`RPC ${code} is an honest refusal`,async()=>{
    reply={data:null,error:{code,message:'private diagnostic'}};
    const result=await invoke(); assert.equal(result.status,status); assert.ok(!JSON.stringify(result.body).includes('private diagnostic'));
  });
}
for(const patch of [{subjectType:'post'},{operationId:subjectId},{auditId:null},{effect:'suspend_listing'},{committedAt:'invalid'}]) {
  test(`malformed receipt ${Object.keys(patch)[0]} never becomes success`,async()=>{
    reply.data={...receipt,...patch}; assert.equal((await invoke()).status,503);
  });
}
