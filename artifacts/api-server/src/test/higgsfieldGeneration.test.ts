import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyGenerationWebhook } from "../routes/mediaGenerationWebhook.js";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { boundedResponse, configuration, generationInput, GENERATION_POLICY, GenerationError, HiggsfieldProvider, modelInput, models } from "../lib/media/generation/higgsfield.js";
import { normalizeGeneratedOutput, processGenerationJob, previewGeneration } from "../lib/media/generation/service.js";

const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const env = { HIGGSFIELD_CREDENTIALS: "test-id:test-secret", HIGGSFIELD_OUTPUT_HOSTS: "media.example.com", HIGGSFIELD_DATA_POLICY_REVIEWED: "true",
  HIGGSFIELD_WEBHOOK_BASE_URL: "https://app.example.com", HIGGSFIELD_WEBHOOK_SECRET: "whsec_" + Buffer.alloc(32, 7).toString("base64"), REDIS_URL: "redis://127.0.0.1:6379" };
const receipt = { requestId: id, statusUrl: `https://api.higgsfield.ai/requests/${id}/status` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("strict generation consent and model-specific schemas exclude extra user fields", () => {
  const input = { requestId: id, kind: "image", prompt: "A beach illustration", aspectRatio: "16:9", consentVersion: GENERATION_POLICY };
  assert.equal(generationInput.safeParse(input).success, true);
  for (const bad of [{ ...input, owner: id }, { ...input, consentVersion: "old" }, { ...input, kind: "audio" }, { ...input, prompt: "x" }]) assert.equal(generationInput.safeParse(bad).success, false);
  assert.equal(configuration(env).ready, true);
  for (const bad of [{ ...env, HIGGSFIELD_CREDENTIALS: "test\n:secret" }, { ...env, HIGGSFIELD_DATA_POLICY_REVIEWED: "false" }, { ...env, HIGGSFIELD_OUTPUT_HOSTS: "127.0.0.1" }]) assert.equal(configuration(bad).ready, false);
  assert.deepEqual(modelInput(generationInput.parse(input)), { prompt: input.prompt, batch_size: 1, resolution: "1080p", aspect_ratio: "16:9", enhance_prompt: false });
  assert.equal(modelInput({ ...generationInput.parse(input), kind: "video" }).duration, 5);
});

test("one stable submission key; status auth is never sent to output storage", async () => {
  const calls: any[] = [];
  const provider = new HiggsfieldProvider(env, async (url, init) => {
    calls.push({ url, ...init });
    if (init?.method === "POST") return json({ request_id: id, status_url: receipt.statusUrl, status: "queued" });
    if (String(url) === receipt.statusUrl) return json({ request_id: id, status: "completed", video: { url: "https://media.example.com/clip.mp4" } });
    return new Response("binary", { headers: { "content-type": "video/mp4" } });
  });
  for (let i = 0; i < 2; i++) assert.deepEqual(await provider.submit(id, "video", { prompt: "test" }), receipt);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[0].headers["Hf-Expires-After"], "10800");
  assert.equal(calls[0].headers.Authorization, "Key test-id:test-secret");
  const status = await provider.status(receipt, "video"); await provider.download(status.outputUrl!, "video");
  assert.equal(calls.at(-1).headers.Authorization, undefined);
  assert.equal(calls.at(-1).redirect, "error");
});

test("rejects hostile polling URLs, output hosts, wrong receipts and moderation results", async () => {
  let response: any = { request_id: id, status: "completed", images: [{ url: "http://127.0.0.1/a" }] };
  let calls = 0;
  const provider = new HiggsfieldProvider(env, async () => { calls++; return json(response); });
  await assert.rejects(provider.status({ ...receipt, statusUrl: "https://evil.example/status" }, "image")); assert.equal(calls, 0);
  for (const url of ["http://127.0.0.1/a", "https://media.example.com.evil.test/a", "https://user@media.example.com/a", "https://media.example.com/a#x"]) {
    response.images[0].url = url; await assert.rejects(provider.status(receipt, "image"));
  }
  response = { request_id: owner, status: "queued" }; await assert.rejects(provider.status(receipt, "image"));
  response = { request_id: id, status: "nsfw" }; assert.deepEqual(await provider.status(receipt, "image"), { state: "nsfw" });
});

test("body size and stalled-body deadlines are enforced without leaking provider errors", async () => {
  await assert.rejects(boundedResponse("https://media.example.com", {}, 4, 100, async () => new Response("too large")), /provider_response_limit/);
  await assert.rejects(boundedResponse("https://media.example.com", {}, 10, 20, async () => new Response(new ReadableStream({ start() {} }))), /provider_timeout/);
  const provider = new HiggsfieldProvider(env, async () => json({ detail: "test-secret private prompt" }, 401));
  await assert.rejects(provider.submit(id, "image", {}), error => error instanceof Error && error.message === "provider_http_401");
});

test("images are decoded and metadata stripped; text/SVG and invalid video rejected", async () => {
  const input = await sharp({ create: { width: 30, height: 20, channels: 3, background: "red" } }).withMetadata().png().toBuffer();
  const result = await normalizeGeneratedOutput(input, "image/png", "image", env);
  const info = await sharp(result.bytes).metadata(); assert.equal(info.format, "webp"); assert.equal(info.exif, undefined);
  await assert.rejects(normalizeGeneratedOutput(Buffer.from("<svg/>"), "image/svg+xml", "image", env));
  await assert.rejects(normalizeGeneratedOutput(Buffer.from("not a video"), "video/mp4", "video", env));
});

function fixture(overrides: Record<string, unknown> = {}) {
  const job: any = { id, owner_user_id: owner, client_request_id: id, kind: "image", model: models.image.id, provider_input: { prompt: "private" }, provider_receipt: null,
    state: "queued", estimated_cost_usd: 0.0057, created_at: new Date().toISOString(), lease_token: "lease", attempts: 0, submission_started_at: null,
    storage_path: null, mime_type: null, completion: null, delete_requested: false, provider_cleaned: false, ...overrides };
  const seen: string[] = [];
  const sc: any = { from(table: string) {
    let values: any; const filters: any[] = [];
    const b: any = { update(v: any) { values = v; return b; }, select() { return b; }, eq(k: string, v: any) { filters.push([k, v]); return b; },
      maybeSingle() { return Promise.resolve(table === "feature_flags" ? { data: { enabled: true } } : table === "profiles" ? { data: { account_status: job.account_status ?? "active", user_account_states: [] } } : { data: filters.every(([k, v]) => job[k] === v) ? { ...job } : null }); },
      then(resolve: any) { const matches = filters.every(([k, v]) => job[k] === v); if (matches) { if (values?.provider_receipt) seen.push("receipt_saved"); Object.assign(job, values); } return Promise.resolve({ data: matches ? [{ id }] : [] }).then(resolve); } }; return b;
  }, storage: { getBucket: async () => ({ data: { public: false } }), from: () => ({ upload: async () => { seen.push("upload"); return {}; }, remove: async () => { seen.push("remove_storage"); return {}; }, createSignedUrl: async () => ({ data: { signedUrl: "https://private.example/preview" } }) }) } };
  const provider: any = { submit: async () => { seen.push("submit"); return receipt; }, status: async () => { seen.push("status"); return { state: "completed", outputUrl: "https://media.example.com/a" }; }, download: async () => ({ bytes: Buffer.from("test"), mime: "image/png" }), remove: async () => { seen.push("remove_provider"); } };
  return { job, sc, provider, seen };
}
test("receipt is saved before completion and ready draft is never regenerated during cleanup", async () => {
  const f = fixture({ completion: { state: "completed", outputUrl: "https://media.example.com/a" } });
  const normalize = async () => ({ bytes: Buffer.from("test"), mime: "image/webp" });
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider, normalize);
  assert.deepEqual(f.seen, ["submit", "receipt_saved", "upload", "remove_provider"]); assert.equal(f.job.state, "ready");
  f.job.lease_token = "next"; await processGenerationJob(f.sc, { ...f.job }, env, f.provider, normalize);
  assert.equal(f.seen.filter(x => x === "submit").length, 1); assert.equal(f.job.provider_cleaned, true);
  assert.equal(f.seen.filter(x => x === "remove_provider").length, 1);
});
test("duplicate events release deleted leases and do not revive rejected drafts", async () => {
  for (const state of ["deleted", "failed", "blocked"]) {
    const f = fixture({ state, provider_cleaned: true });
    await processGenerationJob(f.sc, { ...f.job }, env, f.provider);
    assert.deepEqual(f.seen, []); assert.equal(f.job.state, state); assert.equal(f.job.lease_token, null);
  }
});
test("deletion before submission sends nothing; completed cleanup works after remote output is removed", async () => {
  const first = fixture({ delete_requested: true }); await processGenerationJob(first.sc, { ...first.job }, env, first.provider);
  assert.equal(first.job.state, "deleted"); assert.deepEqual(first.seen, []);
  const f = fixture({ delete_requested: true, state: "ready", provider_receipt: receipt, provider_cleaned: true, storage_path: `${owner}/${id}/output.webp` });
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider);
  assert.deepEqual(f.seen, ["remove_storage"]); assert.equal(f.job.state, "deleted");
});
test("deleting a running draft waits for its event and never regenerates or polls", async () => {
  const f = fixture({ delete_requested: true, state: "running", provider_receipt: receipt });
  f.provider.remove = async () => { f.seen.push("remove_provider"); throw new GenerationError("provider_http_409"); };
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider);
  assert.deepEqual(f.seen, ["remove_provider"]); assert.equal(f.job.delete_requested, true);
  f.job.completion = { state: "completed", outputUrl: "https://media.example.com/a" }; f.job.lease_token = "next";
  f.provider.remove = async () => { f.seen.push("remove_provider"); };
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider);
  assert.deepEqual(f.seen, ["remove_provider", "remove_provider"]); assert.equal(f.job.state, "deleted");
});
test("invalid completed output is rejected and its provider copy is cleaned immediately", async () => {
  const f = fixture({ state: "running", provider_receipt: receipt, completion: { state: "completed", outputUrl: "https://media.example.com/a" } });
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider, async () => { throw new GenerationError("provider_invalid_output"); });
  assert.deepEqual(f.seen, ["remove_provider"]); assert.equal(f.job.state, "failed"); assert.equal(f.job.provider_cleaned, true);
});
test("preview rejects another owner and deletion before signing", async () => {
  const f = fixture({ state: "ready", storage_path: `${owner}/${id}/output.webp` });
  await assert.rejects(previewGeneration(f.sc, id, id), /not_found/);
  f.job.delete_requested = true; await assert.rejects(previewGeneration(f.sc, owner, id), /not_found/);
});

test("signed webhooks reject modified bytes, stale timestamps and forged signatures", () => {
  const raw = Buffer.from('{"status":"completed"}'); const now = Date.now();
  const timestamp = String(Math.floor(now / 1000)); const eventId = 'msg_123';
  const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(`${eventId}.${timestamp}.`).update(raw).digest('base64');
  const headers = { 'webhook-id': eventId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  assert.equal(verifyGenerationWebhook(raw, headers, env.HIGGSFIELD_WEBHOOK_SECRET, now), eventId);
  assert.throws(() => verifyGenerationWebhook(Buffer.from('{}'), headers, env.HIGGSFIELD_WEBHOOK_SECRET, now));
  assert.throws(() => verifyGenerationWebhook(raw, headers, env.HIGGSFIELD_WEBHOOK_SECRET, now + 301000));
  assert.throws(() => verifyGenerationWebhook(raw, { ...headers, 'webhook-signature': 'v1,' + Buffer.alloc(32).toString('base64') }, env.HIGGSFIELD_WEBHOOK_SECRET, now));
});

test("accepted generation waits for a webhook without status polling", async () => {
  const f = fixture();
  f.provider.status = () => { throw new Error('status polling forbidden'); };
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider);
  assert.deepEqual(f.seen, ['submit', 'receipt_saved']); assert.equal(f.job.state, 'running');
});

test("a newly restricted owner cannot dispatch a paid generation", async () => {
  const f = fixture({ account_status: 'pending_deletion' });
  await processGenerationJob(f.sc, { ...f.job }, env, f.provider);
  assert.deepEqual(f.seen, []); assert.equal(f.job.state, 'failed');
});

test("real Postgres reservation deduplicates, enforces budgets and denies client roles", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA realtime; CREATE TABLE realtime.messages(topic text,extension text);
      CREATE FUNCTION realtime.send(jsonb,text,text,boolean) RETURNS void LANGUAGE sql AS 'SELECT';
      CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql AS 'SELECT current_setting(''test.topic'',true)';
      CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT nullif(current_setting(''test.uid'',true),'''')::uuid';`);
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE public.feature_flags(flag text PRIMARY KEY,enabled boolean); CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); GRANT SELECT ON public.feature_flags TO service_role;");
    await db.exec(await readFile(new URL("../migrations/4025_higgsfield_generation_jobs.sql", import.meta.url), "utf8"));
    await db.exec("UPDATE public.feature_flags SET enabled=true; SET ROLE service_role");
    const reserve = (request = id, hash = "a".repeat(64)) => db.query("SELECT public.media_generation_reserve($1,$2,$3,'image','soul','{}'::jsonb,'v1',0.5,0.75,1) AS job", [owner, request, hash]);
    const a: any = (await reserve()).rows[0]; const b: any = (await reserve()).rows[0]; assert.equal(a.job.id, b.job.id);
    await assert.rejects(reserve(id, "b".repeat(64)), /conflict/);
    await assert.rejects(reserve(owner), /budget/);
    const claimed = await db.query("SELECT * FROM public.media_generation_claim($1)", [a.job.id]); assert.equal(claimed.rows.length, 1);
    assert.equal((await db.query("SELECT * FROM public.media_generation_claim($1)", [a.job.id])).rows.length, 0);
    const completion = async (request: string, value = { state: 'nsfw' }) => (await db.query<{ saved: boolean }>("SELECT public.media_generation_complete($1,'event-id',$2,$3::jsonb) AS saved", [a.job.id, request, JSON.stringify(value)])).rows[0].saved;
    assert.equal(await completion(id), false); // Receipt must exist before accepting a callback.
    await db.query("UPDATE public.media_generation_jobs SET provider_receipt=$1::jsonb WHERE id=$2", [JSON.stringify(receipt), a.job.id]);
    assert.equal(await completion(owner), false); assert.equal(await completion(id), true); assert.equal(await completion(id), true);
    assert.equal(await completion(id, { state: 'completed' }), false);
    for (const role of ["anon", "authenticated"]) { await db.exec(`RESET ROLE; SET ROLE ${role}`); await assert.rejects(reserve(), /permission denied/); await assert.rejects(db.query("SELECT * FROM public.media_generation_jobs"), /permission denied/); }
    await db.exec(`RESET ROLE; ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA realtime,auth TO authenticated,anon; GRANT SELECT,INSERT ON realtime.messages TO authenticated,anon;
      CREATE POLICY existing_broad_policy ON realtime.messages FOR ALL TO authenticated,anon USING(true) WITH CHECK(true);`);
    await db.query("INSERT INTO realtime.messages VALUES($1,'broadcast'),($2,'broadcast')", [`media-generation:${owner}`, `media-generation:${id}`]);
    await db.query("SELECT set_config('test.uid',$1,false),set_config('test.topic',$2,false)", [owner, `media-generation:${owner}`]);
    await db.exec("SET ROLE authenticated");
    assert.deepEqual((await db.query("SELECT topic FROM realtime.messages")).rows, [{ topic: `media-generation:${owner}` }]);
    await assert.rejects(db.query("INSERT INTO realtime.messages VALUES($1,'broadcast')", [`media-generation:${owner}`]), /row-level security/);
    await db.exec("RESET ROLE; SELECT set_config('test.uid','',false); SET ROLE anon");
    assert.equal((await db.query("SELECT topic FROM realtime.messages")).rows.length, 0);
  } finally { await db.close(); }
});
