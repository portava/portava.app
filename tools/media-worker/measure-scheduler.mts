import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { runMediaWorkerPass, type MediaJobHandler } from '../../artifacts/api-server/src/lib/media/jobs/worker.js';
import type { MediaJob, MediaJobQueue, MediaJobRequest } from '../../artifacts/api-server/src/lib/media/jobs/queue.js';

const ownerUserId = '11111111-1111-4111-8111-111111111111';
const modelVersion = 'synthetic-no-inference-v1';

async function measure(count: number) {
  const jobs: MediaJob[] = [];
  const identities = new Map<string, string>();
  const active = new Map<string, string>();
  const completions = new Set<string>();
  let cursor = 0;
  let running = 0;
  let peakRunning = 0;
  const latencies: number[] = [];
  const queue: MediaJobQueue = {
    async enqueue(request: MediaJobRequest) {
      const identity = JSON.stringify(request);
      if (identities.has(identity)) return identities.get(identity)!;
      const id = `22222222-2222-4222-8222-${String(jobs.length + 1).padStart(12, '0')}`;
      identities.set(identity, id);
      jobs.push({ ...request, id, token: id, bucket: 'post-media', path: `${ownerUserId}/synthetic`, sizeBytes: 1,
        attempt: 1, leaseUntil: new Date(Date.now() + 120000).toISOString() });
      return id;
    },
    async claim(kind, model, limit) {
      assert.equal(kind, 'image_variants');
      assert.equal(model, modelVersion);
      const batch = jobs.slice(cursor, cursor + limit);
      cursor += batch.length;
      for (const job of batch) { assert.equal(active.has(job.id), false); active.set(job.id, job.token); }
      return batch;
    },
    async renew(job) { return active.get(job.id) === job.token; },
    async finish(job, completion) {
      if (active.get(job.id) !== job.token) return false;
      assert.equal(completion.success, true);
      assert.equal(completions.has(job.id), false);
      assert.equal(completion.output?.result.digest, createHash('sha256').update(job.assetId).digest('hex'));
      completions.add(job.id);
      active.delete(job.id);
      return true;
    },
    async recover() { return 0; },
  };
  const handler: MediaJobHandler = {
    kind: 'image_variants', modelVersion, timeoutMs: 1000,
    async handle(context) {
      const started = performance.now();
      running++;
      peakRunning = Math.max(peakRunning, running);
      try {
        assert.equal(await context.isCurrent(), true);
        await setImmediate();
        context.signal.throwIfAborted();
        return { result: { digest: createHash('sha256').update(context.job.assetId).digest('hex') } };
      } finally { running--; latencies.push(performance.now() - started); }
    },
    async discard() { throw new Error('Synthetic successful outputs must not be discarded'); },
  };
  for (let index = 1; index <= count; index++) {
    const request: MediaJobRequest = { assetId: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
      ownerUserId, sourceVersion: 1, kind: 'image_variants', modelVersion };
    const first = await queue.enqueue(request);
    assert.equal(await queue.enqueue(request), first);
  }
  assert.equal(jobs.length, count);
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const signal = AbortSignal.timeout(60000);
  let passes = 0;
  while (completions.size < count) {
    signal.throwIfAborted();
    const pass = await runMediaWorkerPass(queue, handler, { enabled: true, concurrency: 8, leaseSeconds: 120, signal });
    assert.equal(pass.failed + pass.lost + pass.cleanupFailed, 0);
    assert.ok(pass.completed > 0);
    passes++;
  }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  latencies.sort((left, right) => left - right);
  assert.ok(peakRunning <= 8);
  assert.equal(active.size, 0);
  return { jobs: count, completed: completions.size, duplicateSubmissions: count, peakHandlerConcurrency: peakRunning, passes,
    elapsedMs: Math.round(elapsedMs), handlerP50Ms: Number(latencies[Math.floor(count * 0.5)].toFixed(3)),
    handlerP95Ms: Number(latencies[Math.floor(count * 0.95)].toFixed(3)),
    processCpuMs: Math.round((cpu.user + cpu.system) / 1000), rssBytes: process.memoryUsage().rss };
}

for (const count of [100, 1000, 10000]) {
  process.stdout.write(JSON.stringify({ scenario: 'synthetic in-process scheduler; NOT concurrent users, PostgreSQL, network, storage or inference capacity',
    ...(await measure(count)) }) + '\n');
}
