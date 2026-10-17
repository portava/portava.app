import type { SupabaseClient } from "@supabase/supabase-js";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MediaTranscoder, TranscodeSubject } from "../vendors/mediaTranscoder.js";
import { refused } from "../vendors/vendorCommon.js";
import { AdaptiveArtifacts } from "./artifacts.js";
import { adaptiveEnabled, authorizeAdaptive, canonicalSource, sameSource } from "./canonical.js";
import { encodeLadder } from "./encoder.js";
import type { AdaptiveJobs, AdaptiveLease } from "./jobs.js";
import { ADAPTIVE_LIMITS, validAssetId, validVersion, type AdaptiveConfig, type AdaptiveSource } from "./types.js";

export async function downloadAdaptiveSource(sc: SupabaseClient, config: AdaptiveConfig, source: AdaptiveSource, destination: string, signal: AbortSignal): Promise<void> {
  const { data, error } = await sc.storage.from(source.bucket).createSignedUrl(source.path, 60);
  if (error || !data?.signedUrl) throw new Error("original media unavailable");
  const url = new URL(data.signedUrl);
  if (url.origin !== new URL(config.storageOrigin).origin || url.protocol !== "https:" || url.username || url.password) throw new Error("unexpected source origin");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok || !response.body) throw new Error("original download refused");
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== source.sizeBytes) {
    await response.body.cancel();
    throw new Error("source size changed");
  }
  const handle = await open(destination, "wx", 0o600);
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > source.sizeBytes || received > ADAPTIVE_LIMITS.inputBytes) throw new Error("source download exceeded limit");
      let offset = 0;
      while (offset < chunk.value.length) {
        const result = await handle.write(chunk.value, offset, chunk.value.length - offset);
        if (!result.bytesWritten) throw new Error("source staging stalled");
        offset += result.bytesWritten;
      }
    }
    if (received !== source.sizeBytes) throw new Error("truncated source");
    await handle.sync();
  } finally {
    await reader.cancel().catch(() => {});
    await handle.close();
  }
}

export function createSelfHostedAdaptive(sc: SupabaseClient, config: AdaptiveConfig, jobs: AdaptiveJobs, options: {
  download?: typeof downloadAdaptiveSource;
  encode?: typeof encodeLadder;
  metric?: (event: { name: string; elapsedMs: number; inputBytes: number; outputBytes: number }) => void;
} = {}) {
  const base = new URL(config.apiBaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("trusted HTTPS API base required");
  const artifacts = new AdaptiveArtifacts(config.root);
  const manifestUrl = (source: AdaptiveSource) => `${config.apiBaseUrl.replace(/\/$/, "")}/media/adaptive/${source.assetId}/${source.sourceVersion}/master.m3u8`;
  const enabled = () => adaptiveEnabled(sc, config.enabled);
  let working = false;

  const adapter: MediaTranscoder = {
    name: "self-hosted-ffmpeg-hls",
    capabilities: { hls: true, dash: false, signedPlayback: true },
    async submit(subject: TranscodeSubject & { sourceVersion?: number | null }) {
      if (!validVersion(subject.sourceVersion)) return refused("invalid_answer", "original source generation required");
      try {
        if (!(await enabled())) return refused("not_configured", "adaptive processing is disabled");
        const source = await canonicalSource(sc, subject.assetId);
        if (!source || source.sourceVersion !== subject.sourceVersion || source.bucket !== subject.bucket || source.path !== subject.path) return refused("invalid_answer", "source generation unavailable");
        return { ok: true, value: { jobId: (await jobs.enqueue(source)).id } };
      } catch { return refused("error", "adaptive enqueue unavailable"); }
    },
    async ladder({ assetId }) {
      try {
        if (!(await enabled())) return refused("not_configured", "adaptive playback is disabled");
        const source = await canonicalSource(sc, assetId);
        const output = source && await jobs.ready(assetId, source.sourceVersion);
        if (!source || !output || !output.directory.startsWith(`${source.assetId}-${source.sourceVersion}-`)) return refused("unsupported", "progressive playback remains available");
        return { ok: true, value: { protocol: "hls", manifestUrl: manifestUrl(source), renditions: output.renditions.map(({ height, bitrateKbps }) => ({ height, bitrateKbps })) } };
      } catch { return refused("error", "adaptive playback unavailable"); }
    },
  };

  async function processJob(input: AdaptiveLease) {
    const job: AdaptiveLease = { ...input, source: Object.freeze({ ...input.source }) };
    if (working) throw new Error("adaptive worker concurrency limit");
    if (!validAssetId(job.source.assetId) || !validVersion(job.source.sourceVersion) || !/^[a-zA-Z0-9-]{1,80}$/.test(job.token)) throw new Error("invalid adaptive job");
    working = true;
    const started = Date.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, job.signal, AbortSignal.timeout(ADAPTIVE_LIMITS.leaseMs - 30_000)]);
    let workspace: string | null = null;
    let outputDirectory: string | null = null;
    let returned = false;
    let checking: Promise<void> | null = null;
    let guard: ReturnType<typeof setInterval> | undefined;
    const current = (): Promise<boolean> => {
      if (signal.aborted) return Promise.resolve(false);
      return new Promise((resolve, reject) => {
        const complete = (value: boolean) => { signal.removeEventListener("abort", aborted); resolve(value); };
        const aborted = () => complete(false);
        signal.addEventListener("abort", aborted, { once: true });
        void (async () => {
          if (!(await job.isCurrent()) || signal.aborted || !(await enabled()) || signal.aborted) return false;
          return sameSource(await canonicalSource(sc, job.source.assetId), job.source) && !signal.aborted;
        })().then(complete, error => { signal.removeEventListener("abort", aborted); reject(error); });
      });
    };
    try {
      if (!(await current())) throw new Error("adaptive generation or lease unavailable");
      workspace = await artifacts.workspace(job.source);
      guard = setInterval(() => {
        if (checking) return;
        checking = (async () => {
          if (!(await current()) || !(await artifacts.withinBudget(workspace!))) controller.abort();
        })().catch(() => controller.abort()).finally(() => { checking = null; });
      }, 500);
      const original = join(workspace, "original");
      await (options.download ?? downloadAdaptiveSource)(sc, config, job.source, original, signal);
      const stat = await lstat(original);
      if (!stat.isFile() || stat.size !== job.source.sizeBytes || stat.size > ADAPTIVE_LIMITS.inputBytes) throw new Error("original staging mismatch");
      if (!(await current())) throw new Error("source revoked before encoding");
      const encoded = await (options.encode ?? encodeLadder)(config, original, join(workspace, "out"), signal);
      if (Buffer.byteLength(JSON.stringify(encoded)) > 58_000) throw new Error("adaptive metadata budget exceeded");
      if (!(await current())) throw new Error("source revoked before publication");
      outputDirectory = await artifacts.commit(workspace, job.source, job.token);
      if (!(await current())) throw new Error("source revoked during publication");
      try {
        options.metric?.({ name: "adaptive_encoded", elapsedMs: Date.now() - started, inputBytes: stat.size,
          outputBytes: Object.values(encoded.files).reduce((total, file) => total + file.bytes, 0) });
      } catch {}
      returned = true;
      return { ...encoded, directory: outputDirectory };
    } finally {
      if (guard) clearInterval(guard);
      controller.abort();
      try {
        if (checking) await checking;
        if (!returned && outputDirectory) await artifacts.removeOutput(outputDirectory);
        if (workspace) await rm(workspace, { recursive: true, force: true });
      } finally { working = false; }
    }
  }

  async function playback(viewerId: string, assetId: string) {
    if (!(await enabled())) return null;
    const source = await canonicalSource(sc, assetId);
    if (!source || !(await authorizeAdaptive(sc, viewerId, source))) return null;
    const output = await jobs.ready(assetId, source.sourceVersion);
    if (!output || !output.directory.startsWith(`${source.assetId}-${source.sourceVersion}-`) || !(await enabled()) ||
        !(await authorizeAdaptive(sc, viewerId, source))) return null;
    return { manifestUrl: manifestUrl(source), previewUrl: manifestUrl(source).replace("master.m3u8", "preview.jpg"),
      sourceVersion: source.sourceVersion, protocol: "hls" as const, renditions: output.renditions };
  }

  async function readFile(viewerId: string, assetId: string, generation: number, filename: string): Promise<Buffer | null> {
    if (!validVersion(generation) || !(await enabled())) return null;
    const source = await canonicalSource(sc, assetId);
    if (!source || source.sourceVersion !== generation || !(await authorizeAdaptive(sc, viewerId, source))) return null;
    const output = await jobs.ready(assetId, generation);
    if (!output || !output.directory.startsWith(`${source.assetId}-${source.sourceVersion}-`)) return null;
    const bytes = await artifacts.read(output, filename);
    if (!bytes || !(await enabled()) || !(await authorizeAdaptive(sc, viewerId, source))) return null;
    return bytes;
  }

  async function eraseAsset(assetId: string): Promise<void> {
    if (!validAssetId(assetId)) throw new Error("invalid asset id");
    await jobs.cancelAsset(assetId);
    await artifacts.erase(assetId);
  }

  async function discard(job: Pick<AdaptiveLease, "source" | "token">, output: { directory: string }): Promise<void> {
    if (!validAssetId(job.source.assetId) || !validVersion(job.source.sourceVersion) || !/^[a-zA-Z0-9-]{1,80}$/.test(job.token) ||
        output.directory !== `${job.source.assetId}-${job.source.sourceVersion}-${job.token}`) throw new Error("refusing to erase another lease artifact");
    await artifacts.removeOutput(output.directory);
  }

  return { adapter, processJob, discard, eraseAsset, playback, readFile };
}

export type SelfHostedAdaptive = ReturnType<typeof createSelfHostedAdaptive>;
