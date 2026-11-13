import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { getServiceClient } from "../../supabase.js";
import { boundedServiceFetch } from "../../boundedServiceFetch.js";
import { configuration, GenerationError } from "./higgsfield.js";
import { processGenerationJob, type GenerationJob } from "./service.js";

const STREAM = "portava:media-generation:v1";
const GROUP = "generation-workers";
let producer: Promise<Redis> | null = null;
function connection(consumer = false) {
  if (!process.env.REDIS_URL) throw new GenerationError("generation_queue_unavailable", true);
  const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 3000, ...(!consumer ? { commandTimeout: 3000 } : {}) });
  client.on("error", () => {});
  return client;
}
async function publisher() {
  producer ??= (async () => {
    const client = connection();
    // A reconnect is an event: repair SQL commits whose stream handoff failed
    // during the outage. Never run a periodic queue/database scan.
    client.on("ready", () => { void recoverGenerationHandoffs().catch(() => console.error('{"event":"generation_recovery_failed"}')); });
    try { await client.connect(); return client; }
    catch (error) { client.disconnect(); throw error; }
  })().catch(error => { producer = null; throw error; });
  return producer;
}
export async function enqueueGeneration(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GenerationError("generation_invalid_id");
  await (await publisher()).xadd(STREAM, "*", "job", id);
}
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleExpiry(job: GenerationJob) {
  if (expiryTimers.has(job.id) || job.state === "deleted") return;
  const wait = Math.max(1, Date.parse(job.created_at) + 7 * 86400000 - Date.now());
  const timer = setTimeout(() => {
    expiryTimers.delete(job.id);
    void enqueueGeneration(job.id).catch(() => console.warn('{"event":"generation_expiry_delivery_failed"}'));
  }, wait);
  timer.unref(); expiryTimers.set(job.id, timer);
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let recovery: Promise<void> | null = null;
async function recoverGenerationHandoffs() {
  if (recovery) return recovery;
  recovery = (async () => {
    const sc = getServiceClient(boundedServiceFetch(110000, 15000));
    if (!sc) throw new Error("generation_database_unavailable");
    let cursor = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const page = await sc.from("media_generation_jobs").select("*").neq("state", "deleted").gt("id", cursor).order("id").limit(500);
      if (page.error) throw new Error("generation_recovery_failed");
      for (const job of page.data ?? []) {
        scheduleExpiry(job);
        if (job.state === "queued" || job.delete_requested || job.state === "running" && !job.provider_receipt || job.completion && (!job.provider_cleaned || job.state === "running")) await enqueueGeneration(job.id);
      }
      if ((page.data?.length ?? 0) < 500) break;
      cursor = page.data![page.data!.length - 1].id;
    }
  })().finally(() => { recovery = null; });
  return recovery;
}

/** BLOCK 0 sleeps in Redis until an event arrives. No interval scans or provider status polling. */
async function deliver(sc: any, id: string) {
  const result = await sc.rpc("media_generation_claim", { p_job: id });
  if (result.error) throw new GenerationError("generation_queue_unavailable", true);
  const job = result.data?.[0] as GenerationJob | undefined;
  if (!job) throw new GenerationError("generation_lease_busy", true);
  await processGenerationJob(sc, job); // Also releases the lease for deleted tombstones.
  scheduleExpiry(job);
}
let started = false;
let connected = false;
let booted = false;
let stopped = false;
let lastRunAt: string | null = null;
let lastSuccessAt: string | null = null;
let consecutiveFailures = 0;
export function generationWorkerStatus(state: { ready: boolean; started: boolean; connected: boolean; booted: boolean; stopped: boolean; consecutiveFailures: number }) {
  if (!state.ready) return "unknown" as const;
  if (state.stopped || state.consecutiveFailures > 0) return "failing" as const;
  if (!state.started) return "never_ran" as const;
  if (!state.connected) return "failing" as const;
  return state.booted ? "healthy" as const : "never_ran" as const;
}
export function generationWorkerReport() {
  const ready = configuration().ready;
  return {
    status: generationWorkerStatus({ ready, started, connected, booted, stopped, consecutiveFailures }),
    lastRunAt, lastSuccessAt, consecutiveFailures,
    detail: !ready ? "Generation provider/queue configuration is incomplete; worker disabled."
      : stopped ? "Consumer stopped; pending deliveries require restart or replay."
      : consecutiveFailures > 0 ? "Delivery is retrying after a failure; successful processing has not recovered yet."
      : !connected ? "Queue disconnected; delivery health is not established."
      : "Event consumer connected. Idle time is not failure; no provider status polling. In-process state only.",
  };
}
export function startHiggsfieldGenerationWorker() {
  if (started || !configuration().ready) return;
  started = true; stopped = false; booted = false;
  const boot = async () => {
    const client = connection(true);
    client.on("ready", () => { connected = true; });
    client.on("close", () => { connected = false; });
    try {
      await client.connect();
      try { await client.xgroup("CREATE", STREAM, GROUP, "0", "MKSTREAM"); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith("BUSYGROUP"))) throw error; }
      // Startup and connection events repair handoffs and restore expiry deadlines.
      await recoverGenerationHandoffs();
      const consumer = randomUUID();
      // Reclaim abandoned deliveries once on startup, never on a scan timer.
      let claimCursor = "0-0";
      do {
        const claimed = await client.xautoclaim(STREAM, GROUP, consumer, 120000, claimCursor, "COUNT", 100) as [string, Array<[string, string[]]>];
        claimCursor = claimed[0];
        for (const [messageId, fields] of claimed[1]) { await enqueueGeneration(fields[1]); await client.xack(STREAM, GROUP, messageId); await client.xdel(STREAM, messageId); }
      } while (claimCursor !== "0-0");
      booted = true;
      for (;;) {
        const batches = await client.xreadgroup("GROUP", GROUP, consumer, "COUNT", 1, "BLOCK", 0, "STREAMS", STREAM, ">") as Array<[string, Array<[string, string[]]>]> | null;
        for (const [, messages] of batches ?? []) for (const [messageId, fields] of messages) {
          let delivered = false;
          for (let attempt = 0; attempt < 8; attempt++) {
            try {
              lastRunAt = new Date().toISOString();
              const jobClient = getServiceClient(boundedServiceFetch(110000, 15000));
              if (!jobClient) throw new Error("generation_database_unavailable");
              await deliver(jobClient, fields[1]);
              lastSuccessAt = new Date().toISOString(); consecutiveFailures = 0; delivered = true; break;
            }
            catch { consecutiveFailures++; await delay(Math.min(30000, 1000 * 2 ** attempt)); }
          }
          if (!delivered) throw new Error("generation_delivery_exhausted"); // Preserve pending for restart/operator replay.
          await client.xack(STREAM, GROUP, messageId); await client.xdel(STREAM, messageId);
        }
      }
    } finally { client.disconnect(); }
  };
  void boot().catch(() => { started = false; stopped = true; connected = false; consecutiveFailures++; console.error('{"event":"media_generation_consumer_stopped","recovery":"restart_or_replay"}'); });
}
