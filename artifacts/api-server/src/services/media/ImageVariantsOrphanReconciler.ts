import type { SupabaseClient } from "@supabase/supabase-js";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ImageVariantArtifacts, type ImageVariantArtifactCandidate, type ImageVariantArtifactSnapshot } from "../../lib/media/imageVariants/artifacts.js";
import { UUID } from "../../lib/media/imageVariants/contracts.js";
import { derivativeSchemaStatus } from "./DerivedMediaLifecycleService.js";
import { withMediaCleanup } from "./MediaCleanupTransport.js";

const GRACE_MS = 30 * 60 * 1000;
interface Observation { version: 1; fingerprint: string; firstSeen: number }
interface ObservationReceipt { value: Observation; stamp: string }
const stamp = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":");

async function missingSourceAndJobs(sc: SupabaseClient, assetId: string): Promise<boolean> {
  const source = await sc.from("media_assets").select("id").eq("id", assetId).maybeSingle();
  if (source.error || source.data === undefined) throw new Error("Image canonical state unavailable");
  if (source.data !== null) return false;
  const jobs = await sc.from("media_derivative_jobs").select("id").eq("asset_id", assetId).limit(1);
  if (jobs.error || !Array.isArray(jobs.data)) throw new Error("Image publication state unavailable");
  return jobs.data.length === 0;
}

export class ImageVariantsOrphanReconciler {
  private readonly artifacts: ImageVariantArtifacts;
  private iterator: AsyncGenerator<ImageVariantArtifactCandidate> | null = null;
  private inventoryController = new AbortController();
  private busy = false;
  constructor(private readonly client: SupabaseClient, root: string, private readonly options: { now?: () => number } = {}) {
    this.artifacts = new ImageVariantArtifacts(root);
  }

  private observationPath(candidate: ImageVariantArtifactCandidate): string {
    if (!UUID.test(candidate.assetId) || !UUID.test(candidate.token) || !Number.isSafeInteger(candidate.sourceVersion)
      || candidate.sourceVersion < 1 || candidate.sourceVersion > 2147483647) throw new Error("Invalid image observation identity");
    return join(this.artifacts.root, `.image-orphan-${candidate.assetId}-${candidate.sourceVersion}-${candidate.token}.json`);
  }

  private async observation(candidate: ImageVariantArtifactCandidate): Promise<ObservationReceipt | null> {
    await this.artifacts.assertCleanupRoot();
    const path = this.observationPath(candidate);
    let handle;
    try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size < 1 || stat.size > 512
        || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe image observation");
      const buffer = Buffer.alloc(stat.size);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== buffer.length || stamp(await handle.stat()) !== stamp(stat)
        || stamp(await lstat(path)) !== stamp(stat)) throw new Error("Image observation changed");
      const value = JSON.parse(buffer.toString()) as Observation;
      if (!value || value.version !== 1 || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || !Number.isSafeInteger(value.firstSeen) || value.firstSeen < 0
        || Object.keys(value).sort().join(",") !== "fingerprint,firstSeen,version") throw new Error("Invalid image observation");
      return { value, stamp: stamp(stat) };
    } finally { await handle.close(); }
  }

  private async syncRoot(): Promise<void> {
    await this.artifacts.assertCleanupRoot();
    const handle = await open(this.artifacts.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async observe(snapshot: ImageVariantArtifactSnapshot, firstSeen: number, previous: ObservationReceipt | null): Promise<void> {
    await this.artifacts.assertCleanupRoot();
    const path = this.observationPath(snapshot);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify({ version: 1, fingerprint: snapshot.fingerprint, firstSeen } satisfies Observation));
        await handle.sync();
      } finally { await handle.close(); }
      const current = await this.observation(snapshot);
      if (current?.stamp !== previous?.stamp) throw new Error("Image observation replaced");
      await rename(temporary, path);
      await this.syncRoot();
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }

  private async clearObservation(candidate: ImageVariantArtifactCandidate): Promise<void> {
    const receipt = await this.observation(candidate);
    if (!receipt) return;
    const path = this.observationPath(candidate);
    if (stamp(await lstat(path)) !== receipt.stamp) throw new Error("Image observation replaced");
    await unlink(path);
    await this.syncRoot();
  }

  private now(): number {
    const now = this.options.now?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid image observation clock");
    return now;
  }

  async close(): Promise<void> {
    this.inventoryController.abort();
    try { await this.iterator?.return(undefined); }
    finally { this.iterator = null; this.inventoryController = new AbortController(); }
  }

  async runPass(options: { signal?: AbortSignal; limit?: number; operationTimeoutMs?: number } = {}) {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid image cleanup bound");
    if (this.busy) throw new Error("Image cleanup already running");
    this.busy = true;
    try {
      return await withMediaCleanup(this.client, async (sc, signal) => {
        const result = { schemaInstalled: false, scanned: 0, observed: 0, removed: 0, preserved: 0, failed: 0, pageExhausted: false };
        if (!await derivativeSchemaStatus(sc)) return result;
        result.schemaInstalled = true;
        await this.artifacts.assertCleanupRoot();
        this.iterator ??= this.artifacts.inventory(this.inventoryController.signal);
        const stopInventory = () => this.inventoryController.abort();
        signal.addEventListener("abort", stopInventory, { once: true });
        try {
          for (let index = 0; index < limit; index++) {
            signal.throwIfAborted();
            const next = await this.iterator.next();
            signal.throwIfAborted();
            if (next.done) { result.pageExhausted = true; await this.close(); break; }
            result.scanned++;
            try {
              const candidate = next.value;
              const snapshot = await this.artifacts.inspect(candidate, signal);
              if (!snapshot) { result.preserved++; continue; }
              const erased = await this.artifacts.eraseOrphan(snapshot, async current => {
                if (!await missingSourceAndJobs(sc, current.assetId)) { await this.clearObservation(current); return false; }
                const receipt = await this.observation(current);
                const now = this.now();
                if (!receipt || receipt.value.fingerprint !== snapshot.fingerprint || now < receipt.value.firstSeen) {
                  await this.observe(snapshot, now, receipt);
                  result.observed++;
                  return false;
                }
                if (now - receipt.value.firstSeen < GRACE_MS) return false;
                const cancelled = await sc.rpc("media_derivative_cancel_asset", { p_asset_id: current.assetId });
                if (cancelled.error || cancelled.data !== true) throw new Error("Image orphan cancellation unconfirmed");
                if (!await missingSourceAndJobs(sc, current.assetId)) { await this.clearObservation(current); return false; }
                const confirmed = await this.observation(current);
                return confirmed?.stamp === receipt.stamp && confirmed.value.fingerprint === snapshot.fingerprint
                  && this.now() - confirmed.value.firstSeen >= GRACE_MS;
              }, signal);
              if (erased) { await this.clearObservation(candidate); result.removed++; } else result.preserved++;
            } catch {
              await this.clearObservation(next.value).catch(() => {});
              signal.throwIfAborted(); result.failed++;
            }
          }
          return result;
        } finally { signal.removeEventListener("abort", stopInventory); }
      }, { ...options, timeoutMs: 60000 });
    } catch (error) { await this.close(); throw error; }
    finally { this.busy = false; }
  }
}
