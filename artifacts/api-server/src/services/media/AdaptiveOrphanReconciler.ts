import type { SupabaseClient } from "@supabase/supabase-js";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, rmdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { AdaptiveArtifacts } from "../../lib/media/adaptive/artifacts.js";
import { ADAPTIVE_LIMITS, validAssetId, validFile, validVersion } from "../../lib/media/adaptive/types.js";
import { derivativeSchemaStatus } from "./DerivedMediaLifecycleService.js";
import { withMediaCleanup } from "./MediaCleanupTransport.js";

const OBSERVATION = ".portava-orphan-observation";
const GRACE_MS = 1800000;
interface Candidate { parent: "outputs" | "staging"; name: string; assetId: string }
interface FileState { name: string; stamp: string }
interface Snapshot { stamp: string; files: FileState[]; out: boolean; directoryIdentity: string; outIdentity: string | null }
interface Observation { fingerprint: string; firstSeen: number }

function stamp(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function candidate(parent: Candidate["parent"], name: string): Candidate | null {
  const match = /^(.{36})-([1-9]\d{0,15})-(.+)$/.exec(name);
  if (!match || !validAssetId(match[1]) || !validVersion(Number(match[2]))) return null;
  if (parent === "outputs" ? !validAssetId(match[3]) : !/^[A-Za-z0-9]{6}$/.test(match[3])) return null;
  return { parent, name, assetId: match[1] };
}

export class AdaptiveOrphanReconciler {
  private readonly artifacts: AdaptiveArtifacts;
  private iterator: AsyncGenerator<{ parent: Candidate["parent"]; name: string }> | null = null;
  private busy = false;
  constructor(private readonly client: SupabaseClient, root: string, private readonly options: { now?: () => number } = {}) {
    this.artifacts = new AdaptiveArtifacts(root);
  }

  private async *inventory() {
    for (const parent of ["outputs", "staging"] as const) {
      await this.artifacts.assertCleanupRoot();
      const directory = await opendir(join(this.artifacts.root, parent));
      for await (const entry of directory) yield { parent, name: entry.name };
    }
  }

  async close(): Promise<void> {
    await this.iterator?.return(undefined);
    this.iterator = null;
  }

  private async snapshot(item: Candidate, signal: AbortSignal): Promise<Snapshot> {
    await this.artifacts.assertCleanupRoot();
    const path = join(this.artifacts.root, item.parent, item.name);
    const stat = await lstat(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe adaptive orphan directory");
    const files: FileState[] = [];
    let bytes = 0;
    let out = false;
    let outIdentity: string | null = null;
    async function scan(prefix: string) {
      const directory = await opendir(join(path, prefix));
      for await (const entry of directory) {
        signal.throwIfAborted();
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!prefix && name === OBSERVATION) continue;
        const child = await lstat(join(path, name));
        if (!prefix && name === "out" && item.parent === "staging" && child.isDirectory()) {
          out = true; outIdentity = `${child.dev}:${child.ino}`; await scan("out"); continue;
        }
        const original = item.parent === "staging" && !prefix && name === "original";
        if ((!original && (!validFile(entry.name) || (item.parent === "staging" && prefix !== "out")))
          || !child.isFile() || child.nlink !== 1 || child.size > (original ? ADAPTIVE_LIMITS.inputBytes : ADAPTIVE_LIMITS.fileBytes)) throw new Error("Unexpected adaptive orphan file");
        bytes += child.size;
        files.push({ name, stamp: stamp(child) });
        if (files.length > ADAPTIVE_LIMITS.files + 1 || bytes > ADAPTIVE_LIMITS.inputBytes + ADAPTIVE_LIMITS.outputBytes) throw new Error("Adaptive orphan exceeds bounded inventory");
      }
    }
    await scan("");
    files.sort((left, right) => left.name.localeCompare(right.name));
    return { stamp: createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, outIdentity, files])).digest("hex"), files, out,
      directoryIdentity: `${stat.dev}:${stat.ino}`, outIdentity };
  }

  private async resetObservation(item: Candidate): Promise<void> {
    await this.artifacts.assertCleanupRoot();
    const directory = join(this.artifacts.root, item.parent, item.name);
    if (!(await lstat(directory)).isDirectory()) return;
    if (await this.observation(item)) await unlink(join(directory, OBSERVATION));
  }

  private async observation(item: Candidate): Promise<Observation | null> {
    let handle;
    try { handle = await open(join(this.artifacts.root, item.parent, item.name, OBSERVATION), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 || stat.size < 1) throw new Error("Unsafe orphan observation");
      const buffer = Buffer.alloc(stat.size);
      const read = await handle.read(buffer, 0, buffer.length, 0);
      if (read.bytesRead !== buffer.length) throw new Error("Incomplete orphan observation");
      const value = JSON.parse(buffer.toString()) as Observation;
      if (!value || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || !Number.isSafeInteger(value.firstSeen) || value.firstSeen < 0) throw new Error("Invalid orphan observation");
      return value;
    } finally { await handle.close(); }
  }

  private async observe(item: Candidate, value: Observation): Promise<void> {
    await this.artifacts.assertCleanupRoot();
    const directory = join(this.artifacts.root, item.parent, item.name);
    const handle = await open(join(directory, OBSERVATION), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512) throw new Error("Unsafe orphan observation");
      await handle.truncate(0);
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally { await handle.close(); }
    const parent = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
  }

  private async absent(sc: SupabaseClient, assetId: string): Promise<boolean> {
    const { data: source, error } = await sc.from("media_assets").select("id").eq("id", assetId).maybeSingle();
    if (error) throw new Error("Orphan canonical source unavailable");
    if (source !== null) {
      if (!source || source.id !== assetId) throw new Error("Invalid orphan canonical source response");
      return false;
    }
    const { data: jobs, error: jobsError } = await sc.from("media_derivative_jobs").select("id").eq("asset_id", assetId).limit(1);
    if (jobsError || !Array.isArray(jobs)) throw new Error("Orphan lease state unavailable");
    return jobs.length === 0;
  }

  async runPass(options: { signal?: AbortSignal; limit?: number; operationTimeoutMs?: number } = {}) {
    if (this.busy) throw new Error("Adaptive cleanup already running");
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid adaptive cleanup bound");
    this.busy = true;
    try {
      return await withMediaCleanup(this.client, async (sc, signal) => {
        await this.artifacts.assertCleanupRoot();
        const schema = await derivativeSchemaStatus(sc);
        if (!schema?.media_derivative_jobs) throw new Error("Orphan cleanup requires installed derivative schema");
        const result = { scanned: 0, observed: 0, preserved: 0, removed: 0, failed: 0 };
        this.iterator ??= this.inventory();
        while (result.scanned < limit) {
          signal.throwIfAborted();
          const next = await this.iterator.next();
          if (next.done) { this.iterator = null; break; }
          result.scanned++;
          const item = candidate(next.value.parent, next.value.name);
          if (!item) { result.preserved++; continue; }
          if (!await this.absent(sc, item.assetId)) { await this.resetObservation(item); result.preserved++; continue; }
          let snapshot: Snapshot;
          let previous: Observation | null;
          try { snapshot = await this.snapshot(item, signal); previous = await this.observation(item); }
          catch { signal.throwIfAborted(); result.failed++; continue; }
          const now = (this.options.now ?? Date.now)();
          if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid cleanup clock");
          if (!previous || previous.fingerprint !== snapshot.stamp || previous.firstSeen > now) {
            await this.observe(item, { fingerprint: snapshot.stamp, firstSeen: now });
            result.observed++; continue;
          }
          if (now - previous.firstSeen < GRACE_MS) { result.preserved++; continue; }
          const { data: cancelled, error: cancelError } = await sc.rpc("media_derivative_cancel_asset", { p_asset_id: item.assetId });
          if (cancelError || cancelled !== true) throw new Error("Orphan cancellation unconfirmed");
          if (!await this.absent(sc, item.assetId)) { await this.resetObservation(item); result.preserved++; continue; }
          try {
            if ((await this.snapshot(item, signal)).stamp !== snapshot.stamp) { result.preserved++; continue; }
            const directory = join(this.artifacts.root, item.parent, item.name);
            for (const file of snapshot.files) {
              signal.throwIfAborted();
              await this.artifacts.assertCleanupRoot();
              const parent = await lstat(directory);
              if (!parent.isDirectory() || `${parent.dev}:${parent.ino}` !== snapshot.directoryIdentity) throw new Error("Orphan directory changed during erasure");
              if (file.name.startsWith("out/")) {
                const out = await lstat(join(directory, "out"));
                if (!out.isDirectory() || `${out.dev}:${out.ino}` !== snapshot.outIdentity) throw new Error("Orphan staging directory changed during erasure");
              }
              if (stamp(await lstat(join(directory, file.name))) !== file.stamp) throw new Error("Orphan file changed during erasure");
              await unlink(join(directory, file.name));
            }
            signal.throwIfAborted();
            if (snapshot.out) await rmdir(join(directory, "out"));
            await unlink(join(directory, OBSERVATION));
            await rmdir(directory);
            result.removed++;
          } catch { signal.throwIfAborted(); result.failed++; }
        }
        return result;
      }, { ...options, timeoutMs: 60000 });
    } catch (error) {
      await this.close();
      throw error;
    } finally { this.busy = false; }
  }
}
