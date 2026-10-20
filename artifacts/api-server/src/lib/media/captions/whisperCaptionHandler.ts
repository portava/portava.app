import { spawn } from "node:child_process";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../featureFlags.js";
import { MAX_CUES, MAX_VTT_BYTES, parseWebVtt } from "../vendors/mediaCaptionSource.js";
import { CaptionError, readCaptionAsset, readCaptionManifest, EMPTY_CAPTION_REVISION, recheckCaptionAsset, requirePrivateCaptionStorage, captionLanguage } from "../../../services/media/AuthoredCaptionsService.js";
import { captionDraftId, captionDraftPath, type CaptionJob, type CaptionDraft } from "../../../services/media/CaptionDraftService.js";
import { readCaptionProcessingConsent, type CaptionProcessingConsent } from "../../../services/media/CaptionAsrService.js";
export type { CaptionProcessingConsent } from "../../../services/media/CaptionAsrService.js";

export interface WhisperCaptionConfig {
  enabled: boolean;
  pythonPath: string;
  ffmpegPath: string;
  modelPath: string;
  modelVersion: string;
  configVersion: string;
  allowedLanguages: readonly string[];
  timeoutMs?: number;
  maxDurationMs?: number;
}

export class CaptionJobError extends Error {
  constructor(public code: string, public retryable: boolean) { super(code); }
}

export async function runCaptionTool(executable: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1", OMP_NUM_THREADS: "2" } });
    const output: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const stop = (error: Error) => { failure = error; child.kill("SIGKILL"); };
    const abort = () => stop(new CaptionJobError("cancelled", false));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new CaptionJobError("tool_timeout", true)), timeoutMs);
    child.stdout.on("data", (part: Buffer) => {
      bytes += part.length;
      if (bytes > MAX_VTT_BYTES * 6) stop(new CaptionJobError("tool_output_limit", false));
      else output.push(part);
    });
    child.stderr.resume();
    child.once("error", () => { failure = new CaptionJobError("tool_unavailable", false); });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(failure ?? new CaptionJobError("tool_failed", false));
      else resolve(Buffer.concat(output).toString("utf8"));
    });
    if (signal.aborted) abort();
  });
}

function timestamp(ms: number): string {
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function whisperSegmentsToVtt(answer: unknown, durationMs: number, allowedLanguages: readonly string[]) {
  const result = answer as { language?: unknown; languageProbability?: unknown; segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }> } | null;
  if (!result || typeof result.language !== "string" || !allowedLanguages.includes(result.language) || typeof result.languageProbability !== "number" || !Number.isFinite(result.languageProbability) || result.languageProbability < 0.5 || result.languageProbability > 1 || !Array.isArray(result.segments) || result.segments.length === 0 || result.segments.length > MAX_CUES) throw new CaptionJobError("unvalidated_language_or_segments", false);
  captionLanguage(result.language);
  const blocks = result.segments.map((segment) => {
    if (typeof segment.start !== "number" || typeof segment.end !== "number" || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || typeof segment.text !== "string") throw new CaptionJobError("invalid_segments", false);
    const start = Math.round(segment.start * 1000);
    const end = Math.round(segment.end * 1000);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new CaptionJobError("invalid_segments", false);
    const text = segment.text.replace(/\r\n?/g, "\n").trim().replace(/\n\s*\n/g, "\n").replace(/-->/g, "→");
    return `${timestamp(start)} --> ${timestamp(end)}\n${text}`;
  });
  const vtt = `WEBVTT\n\n${blocks.join("\n\n")}\n`;
  if (!parseWebVtt(vtt, durationMs).ok) throw new CaptionJobError("invalid_timed_track", false);
  return { vtt, language: result.language };
}

export function createWhisperCaptionHandler(config: WhisperCaptionConfig, runTool: typeof runCaptionTool = runCaptionTool) {
  return async (sc: SupabaseClient, job: CaptionJob, signal: AbortSignal, isCurrent: () => Promise<boolean> = async () => true) => {
    const started = Date.now();
    signal.throwIfAborted();
    if (!config.enabled || !(await isFlagEnabled(sc, "media_captions_enabled"))) throw new CaptionJobError("disabled", false);
    if (job.kind !== "captions" || job.modelVersion !== config.modelVersion || job.configVersion !== config.configVersion || !config.allowedLanguages.length || (job.targetLanguage !== null && !config.allowedLanguages.includes(job.targetLanguage))) throw new CaptionJobError("unvalidated_configuration", false);
    if (job.consent?.transcription !== true || job.consent.ownerId !== job.requestedBy || !Number.isFinite(Date.parse(job.consent.recordedAt))) throw new CaptionJobError("consent_required", false);
    const asset = await readCaptionAsset(sc, job.assetId);
    if (asset.owner_user_id !== job.requestedBy || asset.version !== job.sourceVersion) throw new CaptionJobError("stale_or_forbidden", false);
    if (job.expectedSource && (asset.storage_bucket !== job.expectedSource.bucket || asset.storage_path !== job.expectedSource.path)) throw new CaptionJobError("source_changed", false);
    const ensureCurrent = async () => {
      signal.throwIfAborted();
      if (!/^[a-f0-9]{64}$/.test(job.revisionKey)) throw new CaptionJobError("caption_revision_changed", false);
      const manifest = await readCaptionManifest(sc, job.assetId);
      if ((manifest?.revision_key ?? EMPTY_CAPTION_REVISION) !== job.revisionKey || !(await isCurrent())) throw new CaptionJobError("lease_or_consent_lost", false);
      await recheckCaptionAsset(sc, job.requestedBy, asset);
      await requirePrivateCaptionStorage(sc);
    };
    await ensureCurrent();
    if (asset.duration_ms > Math.min(config.maxDurationMs ?? 900000, 900000)) throw new CaptionJobError("duration_budget", false);
    const draftId = captionDraftId(job);
    const path = captionDraftPath(job.assetId, job.sourceVersion, draftId, job.consentId);
    const filename = path.slice(path.lastIndexOf("/") + 1);
    const existing = await sc.storage.from("post-media").list(`manual-captions/${job.assetId}`, { search: filename, limit: 2 });
    if (existing.error) throw new CaptionJobError("draft_lookup_failed", true);
    if (existing.data?.some((entry) => entry.name === filename)) {
      const stored = await sc.storage.from("post-media").download(path);
      if (stored.error || !stored.data || stored.data.size > MAX_VTT_BYTES * 6 + 4096) throw new CaptionJobError("invalid_cached_draft", false);
      const cached = JSON.parse(await stored.data.text()) as CaptionDraft;
      if (cached.draftId !== draftId || cached.consentId !== job.consentId || cached.jobId !== job.jobId || cached.revisionKey !== job.revisionKey || !cached.source || Object.keys(asset).some((key) => cached.source[key as keyof typeof asset] !== asset[key as keyof typeof asset]) || typeof cached.vtt !== "string" || !parseWebVtt(cached.vtt, asset.duration_ms).ok) throw new CaptionJobError("invalid_cached_draft", false);
      await ensureCurrent();
      return { state: "draft_ready" as const, draftId, artifactKey: path, cached: true, sourceVersion: job.sourceVersion, inputBytes: 0, outputBytes: 0, metrics: { elapsedMs: Date.now() - started, mediaSeconds: 0, estimatedProviderCostUsd: 0 } };
    }
    try {
      if (![config.pythonPath, config.ffmpegPath, config.modelPath].every(isAbsolute)) throw new Error();
      await access(config.pythonPath, constants.X_OK);
      await access(config.ffmpegPath, constants.X_OK);
      await access(join(config.modelPath, "model.bin"), constants.R_OK);
    } catch { throw new CaptionJobError("local_model_or_tools_unavailable", false); }
    const timeout = Math.min(Math.max(config.timeoutMs ?? 600000, 1000), 600000);
    const temporary = await mkdtemp(join(tmpdir(), "portava-captions-"));
    let wroteDraft = false;
    try {
      const media = await sc.storage.from(asset.storage_bucket).download(asset.storage_path);
      if (media.error || !media.data) throw new CaptionJobError("source_download_failed", true);
      if (!media.data.size || media.data.size > 100 * 1024 * 1024) throw new CaptionJobError("source_byte_budget", false);
      signal.throwIfAborted();
      await ensureCurrent();
      const input = join(temporary, "source.video");
      const audio = join(temporary, "audio.wav");
      await writeFile(input, Buffer.from(await media.data.arrayBuffer()), { mode: 0o600 });
      await runTool(config.ffmpegPath, ["-nostdin", "-v", "error", "-threads", "2", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm,avi,mpegts,ogg", "-i", input, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-t", String((asset.duration_ms + 1000) / 1000), audio], signal, timeout);
      await ensureCurrent();
      const output = await runTool(config.pythonPath, [fileURLToPath(new URL("./transcribe.py", import.meta.url)), "--model", config.modelPath, "--audio", audio, "--language", job.targetLanguage ?? "auto"], signal, timeout);
      let answer: unknown;
      try { answer = JSON.parse(output); } catch { throw new CaptionJobError("invalid_asr_output", false); }
      const track = whisperSegmentsToVtt(answer, asset.duration_ms, config.allowedLanguages);
      if (job.targetLanguage !== null && track.language !== job.targetLanguage) throw new CaptionJobError("language_mismatch", false);
      const draft: CaptionDraft = { source: asset, draftId, ...track, sourceKind: "asr", aiLabel: "AI transcription · needs creator review", modelVersion: job.modelVersion, configVersion: job.configVersion, revisionKey: job.revisionKey, consentId: job.consentId, jobId: job.jobId };
      await ensureCurrent();
      signal.throwIfAborted();
      const encoded = Buffer.from(JSON.stringify(draft));
      const stored = await sc.storage.from("post-media").upload(path, encoded, { contentType: "application/json", upsert: false, cacheControl: "0" });
      if (stored.error) throw new CaptionJobError("draft_write_conflict_or_failure", true);
      wroteDraft = true;
      await ensureCurrent();
      signal.throwIfAborted();
      return { state: "draft_ready" as const, draftId, artifactKey: path, cached: false, sourceVersion: job.sourceVersion, inputBytes: media.data.size, outputBytes: encoded.length, metrics: { elapsedMs: Date.now() - started, mediaSeconds: asset.duration_ms / 1000, estimatedProviderCostUsd: 0 } };
    } catch (error) {
      if (wroteDraft) {
        const removed = await sc.storage.from("post-media").remove([path]);
        if (removed.error) throw new CaptionJobError("draft_cleanup_required", true);
      }
      throw error;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  };
}

export interface CaptionQueueContext {
  job: Readonly<{ id: string; token: string; assetId: string; ownerUserId: string; sourceVersion: number; kind: string; bucket: string; path: string; sizeBytes: number; modelVersion: string; targetLanguage?: string; revisionKey?: string }>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}

export function createWhisperMediaJobHandler(sc: SupabaseClient, config: WhisperCaptionConfig, dependencies: {
  readConsent?(job: CaptionQueueContext["job"]): Promise<CaptionProcessingConsent | null>;
  jobError(code: string, retryable: boolean): Error;
}, runTool: typeof runCaptionTool = runCaptionTool) {
  const handler = createWhisperCaptionHandler(config, runTool);
  const readConsent = dependencies.readConsent ?? ((job: CaptionQueueContext["job"]) => readCaptionProcessingConsent(sc, job));
  const request = (context: CaptionQueueContext, consent: CaptionProcessingConsent): CaptionJob => ({
    assetId: context.job.assetId, sourceVersion: context.job.sourceVersion, kind: "captions", modelVersion: context.job.modelVersion,
    targetLanguage: context.job.targetLanguage || null, configVersion: config.configVersion, revisionKey: consent.revisionKey, consentId: consent.consentId, jobId: context.job.id,
    leaseToken: `${context.job.id}:${context.job.token}`, expectedSource: { bucket: context.job.bucket, path: context.job.path }, requestedBy: context.job.ownerUserId, consent,
  });
  const validConsent = (context: CaptionQueueContext, consent: CaptionProcessingConsent | null): consent is CaptionProcessingConsent => Boolean(consent && consent.transcription === true && consent.assetId === context.job.assetId && consent.jobId === context.job.id && consent.ownerId === context.job.ownerUserId && consent.sourceVersion === context.job.sourceVersion && consent.jobRevisionKey === context.job.revisionKey && consent.configVersion === config.configVersion && config.allowedLanguages.every((language) => consent.allowedLanguages.includes(language)) && Number.isFinite(Date.parse(consent.recordedAt)));
  return {
    kind: "captions" as const,
    modelVersion: config.modelVersion,
    timeoutMs: Math.min(Math.max(config.timeoutMs ?? 600000, 1000), 600000),
    async handle(context: CaptionQueueContext) {
      try {
        if (context.job.kind !== "captions" || !context.job.token || !context.job.id || context.job.bucket !== "post-media" || !Number.isSafeInteger(context.job.sizeBytes) || context.job.sizeBytes <= 0 || context.job.sizeBytes > 100 * 1024 * 1024) throw new CaptionJobError("invalid_caption_job", false);
        const consent = await readConsent(context.job);
        if (!validConsent(context, consent)) throw new CaptionJobError("consent_required", false);
        const source = await readCaptionAsset(sc, context.job.assetId);
        if (source.storage_bucket !== context.job.bucket || source.storage_path !== context.job.path) throw new CaptionJobError("source_changed", false);
        const result = await handler(sc, request(context, consent), context.signal, async () => {
          if (!(await context.isCurrent())) return false;
          const latest = await readConsent(context.job);
          return validConsent(context, latest) && latest.consentId === consent.consentId && latest.revisionKey === consent.revisionKey;
        });
        const { inputBytes, outputBytes, ...metadata } = result;
        return { result: { ...metadata, revisionKey: context.job.revisionKey, captionRevisionKey: consent.revisionKey, consentId: consent.consentId, modelVersion: config.modelVersion }, inputBytes, outputBytes };
      } catch (error) {
        if (error instanceof CaptionJobError) throw dependencies.jobError(error.code, error.retryable);
        if (error instanceof CaptionError) throw dependencies.jobError("caption_source_unavailable", error.code === "degraded_unavailable");
        throw dependencies.jobError(context.signal.aborted ? "cancelled" : "caption_processing_failed", !context.signal.aborted);
      }
    },
    async discard(context: CaptionQueueContext, output: { result: Record<string, unknown> }) {
      const lookup = await sc.from("media_caption_asr_consents").select("id, asset_id, owner_user_id, source_version, caption_revision_key, job_revision_key, config_version").eq("job_id", context.job.id).maybeSingle();
      const grant = lookup.data;
      if (lookup.error || !grant || grant.asset_id !== context.job.assetId || grant.owner_user_id !== context.job.ownerUserId || grant.source_version !== context.job.sourceVersion || grant.job_revision_key !== context.job.revisionKey || grant.config_version !== config.configVersion) throw dependencies.jobError("foreign_caption_artifact", false);
      const draftId = captionDraftId({ assetId: context.job.assetId, sourceVersion: context.job.sourceVersion, kind: "captions", modelVersion: context.job.modelVersion, targetLanguage: context.job.targetLanguage || null, configVersion: config.configVersion, revisionKey: grant.caption_revision_key, consentId: grant.id, jobId: context.job.id, leaseToken: `${context.job.id}:${context.job.token}` });
      const path = captionDraftPath(context.job.assetId, context.job.sourceVersion, draftId, grant.id);
      if (output.result.artifactKey !== path || output.result.draftId !== draftId) throw dependencies.jobError("foreign_caption_artifact", false);
      const removed = await sc.storage.from("post-media").remove([path]);
      if (removed.error) throw dependencies.jobError("draft_cleanup_required", true);
    },
  };
}
