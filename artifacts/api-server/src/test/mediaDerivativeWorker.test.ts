import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { setTimeout as delay } from "node:timers/promises";
import { createMediaJobQueue, decodeMediaJob, MediaJobError, type MediaJob, type MediaJobCompletion, type MediaJobQueue } from "../lib/media/jobs/queue.js";
import { runMediaWorkerPass, type MediaJobHandler } from "../lib/media/jobs/worker.js";
import { mediaWorkerConfig, runMediaWorkerRuntime, type MediaWorkerHealth } from "../lib/media/jobs/runtime.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const ownerUserId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const token = "44444444-4444-4444-8444-444444444444";
const job: MediaJob = { id: jobId, token, assetId, ownerUserId, sourceVersion: 3, kind: "adaptive_video", modelVersion: "hls-v1",
  bucket: "post-media", path: `${ownerUserId}/clip.mp4`, sizeBytes: 100, attempt: 1, leaseUntil: new Date(Date.now() + 120000).toISOString() };

function fixture() {
  const completions: MediaJobCompletion[] = [];
  const discarded: string[] = [];
  let claims = 0;
  let recovered = 0;
  const queue: MediaJobQueue = {
    async enqueue() { return jobId; },
    async recover() { recovered += 1; return 0; },
    async claim() { claims += 1; return [{ ...job }]; },
    async renew() { return true; },
    async finish(_job, completion) { completions.push(completion); return true; },
  };
  const handler: MediaJobHandler = { kind: "adaptive_video", modelVersion: "hls-v1", timeoutMs: 1000,
    async handle(context) { return { result: { directory: context.job.id }, inputBytes: 100, outputBytes: 50 }; },
    async discard(_context, output) { discarded.push(String(output.result.directory)); },
  };
  const controller = new AbortController();
  const run = () => runMediaWorkerPass(queue, handler, { enabled: true, concurrency: 1, leaseSeconds: 120, signal: controller.signal });
  return { queue, handler, completions, discarded, controller, run, counts: () => ({ claims, recovered }) };
}

test("disabled and stopped workers perform no queue or model work", async () => {
  const state = fixture();
  await runMediaWorkerPass(state.queue, state.handler, { enabled: false, concurrency: 1, leaseSeconds: 120, signal: state.controller.signal });
  state.controller.abort();
  await state.run();
  assert.deepEqual(state.counts(), { claims: 0, recovered: 0 });
  assert.equal(state.completions.length, 0);
});

test("successful processing publishes the lease-bound result and measured usage", async () => {
  const state = fixture();
  const result = await state.run();
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.equal(state.completions[0].output?.result.directory, jobId);
  assert.equal(state.completions[0].output?.inputBytes, 100);
  assert.deepEqual(state.discarded, []);
});

test("lost lease prevents expensive processing", async () => {
  const state = fixture();
  let handled = false;
  state.queue.renew = async () => false;
  state.queue.finish = async () => false;
  state.handler.handle = async () => { handled = true; return { result: {} }; };
  const result = await state.run();
  assert.equal(handled, false);
  assert.equal(result.lost, 1);
  assert.equal(result.completed, 0);
});

test("late revocation discards only that attempt's generated output", async () => {
  const state = fixture();
  let renewals = 0;
  state.queue.renew = async () => ++renewals === 1;
  state.queue.finish = async () => false;
  const result = await state.run();
  assert.equal(result.completed, 0);
  assert.deepEqual(state.discarded, [jobId]);
});

test("publication CAS refusal discards the unpublished output", async () => {
  const state = fixture();
  state.queue.finish = async () => false;
  const result = await state.run();
  assert.equal(result.lost, 1);
  assert.deepEqual(state.discarded, [jobId]);
});

test("ambiguous publication response does not delete possibly committed artifacts", async () => {
  const state = fixture();
  state.queue.finish = async () => { throw new Error("connection lost after commit"); };
  const result = await state.run();
  assert.equal(result.lost, 1);
  assert.deepEqual(state.discarded, []);
});

test("timeout aborts cooperative work and records bounded retry without leaking provider text", async () => {
  const state = fixture();
  state.handler.timeoutMs = 10;
  state.handler.handle = async context => new Promise((_resolve, reject) => {
    context.signal.addEventListener("abort", () => reject(new Error("signed-secret-source-url")), { once: true });
  });
  const result = await state.run();
  assert.equal(result.failed, 1);
  assert.equal(state.completions[0].success, false);
  assert.equal(state.completions[0].errorCode, "processing_timeout");
  assert.equal(state.completions[0].retryable, true);
});

test("terminal format failures are not retried", async () => {
  const state = fixture();
  state.handler.handle = async () => { throw new MediaJobError("unsupported_format"); };
  await state.run();
  assert.equal(state.completions[0].retryable, false);
  assert.equal(state.completions[0].errorCode, "unsupported_format");
});

test("cleanup failure is observable instead of reported as successful erasure", async () => {
  const state = fixture();
  state.queue.finish = async () => false;
  state.handler.discard = async () => { throw new Error("disk unavailable"); };
  const result = await state.run();
  assert.equal(result.cleanupFailed, 1);
  assert.equal(result.completed, 0);
});

test("concurrency is bounded to the claim batch", async () => {
  const state = fixture();
  let active = 0;
  let peak = 0;
  let processed = 0;
  state.queue.claim = async (_kind, _model, limit) => Array.from({ length: limit }, () => ({ ...job }));
  state.handler.handle = async () => {
    active += 1;
    peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
    processed += 1;
    return { result: {} };
  };
  await runMediaWorkerPass(state.queue, state.handler, { enabled: true, concurrency: 3, leaseSeconds: 120, signal: state.controller.signal });
  assert.equal(peak, 3);
  assert.equal(processed, 3);
  await assert.rejects(runMediaWorkerPass(state.queue, state.handler, { enabled: true, concurrency: 9, leaseSeconds: 120, signal: state.controller.signal }), /invalid_worker_bounds/);
});

test("queue transport errors never become successful writes or leak remote details", async () => {
  const client = { rpc: () => ({ abortSignal: async () => ({ data: jobId, error: { message: "secret-token" } }) }) } as unknown as SupabaseClient;
  const queue = createMediaJobQueue(client);
  await assert.rejects(queue.enqueue(job), error => error instanceof MediaJobError && error.message === "queue_unavailable");
});

test("invalid generation and oversized result never reach persistence", async () => {
  let calls = 0;
  const client = { rpc: async () => { calls += 1; return { data: jobId, error: null }; } } as unknown as SupabaseClient;
  const queue = createMediaJobQueue(client);
  await assert.rejects(queue.enqueue({ ...job, sourceVersion: 0 }), /invalid_job_request/);
  await assert.rejects(queue.finish(job, { success: true, processingMs: 1, output: { result: { text: "x".repeat(65536) } } }), /job_result_too_large/);
  assert.equal(calls, 0);
});

test("decoder rejects malformed claimed rows, unsafe sizes and missing generation", () => {
  const row = { id: jobId, asset_id: assetId, owner_user_id: ownerUserId, source_version: 3, kind: "adaptive_video", model_version: "hls-v1",
    source_bucket: "post-media", source_path: job.path, source_bytes: "100", attempts: 1, lease_token: token, lease_until: job.leaseUntil, state: "processing" };
  assert.equal(decodeMediaJob(row).sizeBytes, 100);
  for (const bad of [{ source_version: 0 }, { source_bytes: "9007199254740993" }, { source_bucket: "profile-media" }, { state: "completed" }, { lease_token: null }]) {
    assert.throws(() => decodeMediaJob({ ...row, ...bad }), MediaJobError);
  }
});

test("runtime configuration is off and one concurrent job by default", () => {
  assert.equal(mediaWorkerConfig({}).enabled, false);
  assert.equal(mediaWorkerConfig({}).concurrency, 1);
  assert.equal(mediaWorkerConfig({}).queueTimeoutMs, 10000);
  for (const value of ["9", "0", "1.5", "NaN"]) assert.throws(() => mediaWorkerConfig({ MEDIA_WORKER_CONCURRENCY: value }), /invalid_worker_configuration/);
  for (const value of ["0", "30001", "1.5"]) assert.throws(() => mediaWorkerConfig({ MEDIA_WORKER_QUEUE_TIMEOUT_MS: value }), /invalid_worker_configuration/);
});

test("worker memory backpressure pauses claims and reports safe health data", async () => {
  const state = fixture();
  const health: MediaWorkerHealth[] = [];
  await runMediaWorkerRuntime(state.queue, state.handler, { ...mediaWorkerConfig({}), enabled: true }, state.controller.signal, update => {
    health.push(update);
    if (update.state === "backpressure") state.controller.abort();
  }, () => 2 * 1024 * 1024 * 1024);
  assert.equal(state.counts().claims, 0);
  assert.equal(health.some(update => update.state === "backpressure"), true);
  assert.equal(health.at(-1)?.state, "stopped");
  assert.equal(JSON.stringify(health).includes(job.path), false);
});

test("runtime never overlaps polling passes and gracefully stops", async () => {
  const state = fixture();
  const health: MediaWorkerHealth[] = [];
  await runMediaWorkerRuntime(state.queue, state.handler, { ...mediaWorkerConfig({}), enabled: true }, state.controller.signal, update => {
    health.push(update);
    if (update.pass) state.controller.abort();
  }, () => 100);
  assert.equal(state.counts().claims, 1);
  assert.equal(health.find(update => update.pass)?.pass?.completed, 1);
  assert.equal(health.at(-1)?.state, "stopped");
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((accept, refuse) => { resolve = accept; reject = refuse; });
  return { promise, resolve, reject };
}

async function within<Value>(promise: Promise<Value>, milliseconds = 250): Promise<Value> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("test_wait_exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const cause of ["shutdown", "deadline"] as const) {
  test(`real PostgREST transport receives an abort signal and ${cause} bounds a non-cooperative fetch`, async () => {
    const response = deferred<Response>();
    const started = deferred<void>();
    let transportSignal: AbortSignal | null | undefined;
    const client = createClient("https://synthetic.invalid", "synthetic-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (_input, init) => { transportSignal = init?.signal; started.resolve(); return response.promise; } },
    });
    const queue = createMediaJobQueue(client, { timeoutMs: cause === "deadline" ? 20 : 1000 });
    const controller = new AbortController();
    const pending = queue.recover(1, controller.signal);
    try {
      await within(started.promise);
      if (cause === "shutdown") controller.abort(new Error("private transport detail"));
      await assert.rejects(within(pending), new RegExp(cause === "shutdown" ? "queue_cancelled" : "queue_timeout"));
      assert.ok(transportSignal instanceof AbortSignal);
      assert.equal(transportSignal.aborted, true);
    } finally {
      response.resolve(new Response("0", { status: 200 }));
      await pending.catch(() => undefined);
    }
  });
}

test("every queue operation attaches transport cancellation and a pre-aborted operation sends nothing", async () => {
  const signals: AbortSignal[] = [];
  const client = { rpc: (name: string) => ({ abortSignal(signal: AbortSignal) {
    signals.push(signal);
    return Promise.resolve({ data: name.endsWith("enqueue") ? jobId : name.endsWith("claim") ? [] : name.endsWith("recover") ? 0 : true, error: null });
  } }) } as unknown as SupabaseClient;
  const queue = createMediaJobQueue(client);
  await queue.enqueue(job);
  await queue.claim(job.kind, job.modelVersion, 1, 120);
  await queue.renew(job, 120);
  await queue.finish(job, { success: true, processingMs: 1, output: { result: {} } });
  await queue.recover(1);
  assert.equal(signals.length, 5);
  assert.equal(signals.every(signal => signal instanceof AbortSignal), true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.enqueue(job, controller.signal), /queue_cancelled/);
  assert.equal(signals.length, 5);
});

test("late transport rejection stays handled after local cancellation", async () => {
  const response = deferred<{ data: number; error: null }>();
  const started = deferred<void>();
  const client = { rpc: () => ({ abortSignal() { started.resolve(); return response.promise; } }) } as unknown as SupabaseClient;
  const controller = new AbortController();
  const pending = createMediaJobQueue(client).recover(1, controller.signal);
  await within(started.promise);
  controller.abort();
  await assert.rejects(within(pending), /queue_cancelled/);
  response.reject(new Error("late private transport failure"));
  await delay(0);
});

test("runtime reaches stopped when shutdown interrupts a stalled recovery transport", async () => {
  const state = fixture();
  const stalled = deferred<number>();
  const started = deferred<void>();
  const health: MediaWorkerHealth[] = [];
  state.queue.recover = async () => { started.resolve(); return stalled.promise; };
  const pending = runMediaWorkerRuntime(state.queue, state.handler, { ...mediaWorkerConfig({}), enabled: true },
    state.controller.signal, update => health.push(update), () => 100);
  try {
    await within(started.promise);
    state.controller.abort();
    await within(pending);
    assert.equal(health.at(-1)?.state, "stopped");
    assert.equal(state.counts().claims, 0);
  } finally { stalled.resolve(0); await pending; }
});

for (const phase of ["recover", "claim"] as const) {
  test(`shutdown bounds stalled ${phase} before inference`, async () => {
    const state = fixture();
    const stalled = deferred<any>();
    const started = deferred<void>();
    let transportSignal: AbortSignal | undefined;
    let handled = false;
    if (phase === "recover") state.queue.recover = async (_limit, signal) => { transportSignal = signal; started.resolve(); return stalled.promise; };
    else state.queue.claim = async (_kind, _model, _limit, _lease, signal) => { transportSignal = signal; started.resolve(); return stalled.promise; };
    state.handler.handle = async () => { handled = true; return { result: {} }; };
    const pending = state.run();
    try {
      await within(started.promise);
      state.controller.abort();
      await assert.rejects(within(pending), /queue_cancelled/);
      assert.equal(transportSignal?.aborted, true);
      assert.equal(handled, false);
    } finally { stalled.resolve(phase === "recover" ? 0 : []); await pending.catch(() => undefined); }
  });
}

for (const phase of ["initial", "final"] as const) {
  test(`deadline bounds stalled ${phase} renewal, including finalizer`, async () => {
    const state = fixture();
    const stalled = deferred<boolean>();
    let renewals = 0;
    let handled = 0;
    let renewalSignal: AbortSignal | undefined;
    state.handler.timeoutMs = 20;
    state.queue.renew = async (_job, _seconds, signal) => {
      renewals += 1;
      if (phase === "final" && renewals === 1) return true;
      renewalSignal = signal;
      return stalled.promise;
    };
    state.handler.handle = async () => { handled += 1; return { result: { directory: jobId } }; };
    const pending = state.run();
    try {
      const result = await within(pending);
      assert.equal(result.completed, 0);
      assert.equal(handled, phase === "initial" ? 0 : 1);
      assert.equal(renewalSignal?.aborted, true);
      assert.equal(state.completions[0].errorCode, "processing_timeout");
      assert.deepEqual(state.discarded, phase === "initial" ? [] : [jobId]);
    } finally { stalled.resolve(true); await pending; }
  });
}

for (const success of [true, false]) {
  test(`stalled ${success ? "success" : "failure"} finish is bounded and late settlement cannot erase uncertain output`, async () => {
    const state = fixture();
    const stalled = deferred<boolean>();
    let finishSignal: AbortSignal | undefined;
    let finishes = 0;
    state.queue.finish = async (_job, _completion, signal) => { finishes += 1; finishSignal = signal; return stalled.promise; };
    if (!success) state.handler.handle = async () => { throw new MediaJobError("unsupported_format"); };
    const pending = runMediaWorkerPass(state.queue, state.handler, { enabled: true, concurrency: 1, leaseSeconds: 120,
      signal: state.controller.signal, queueTimeoutMs: 20 });
    try {
      const result = await within(pending);
      assert.equal(result.lost, 1);
      assert.equal(result.completed, 0);
      assert.equal(finishes, 1);
      assert.equal(finishSignal?.aborted, true);
      assert.deepEqual(state.discarded, []);
    } finally { stalled.resolve(true); await pending; }
    await delay(0);
    assert.deepEqual(state.discarded, []);
    assert.equal(finishes, 1);
  });
}

test("runtime never starts another pass while aborted inference has not actually settled", async () => {
  const state = fixture();
  const inference = deferred<{ result: Record<string, unknown> }>();
  const started = deferred<void>();
  let inferenceSignal: AbortSignal | undefined;
  let stopped = false;
  state.handler.timeoutMs = 10;
  state.handler.handle = async context => { inferenceSignal = context.signal; started.resolve(); return inference.promise; };
  const pending = runMediaWorkerRuntime(state.queue, state.handler, { ...mediaWorkerConfig({}), enabled: true, pollMs: 1 },
    state.controller.signal, health => { if (health.state === "stopped") stopped = true; }, () => 100);
  try {
    await within(started.promise);
    await delay(60);
    assert.equal(inferenceSignal?.aborted, true);
    assert.equal(state.counts().claims, 1);
    assert.equal(stopped, false);
    assert.equal(state.completions.length, 0);
  } finally {
    state.controller.abort();
    inference.resolve({ result: { directory: jobId } });
    await within(pending);
  }
  assert.equal(stopped, true);
  assert.equal(state.completions.some(completion => completion.success), false);
  assert.deepEqual(state.discarded, [jobId]);
});
