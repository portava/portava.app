import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import sharp from "sharp";
import { isFlagEnabled } from "../../featureFlags.js";
import { approvedProviderModel } from "../../providerVersions.js";
import { resolveAccountRestriction } from "../../accountStateGate.js";
import { runMediaTool } from "../adaptive/encoder.js";
import { configuration, GENERATION_BUCKET, GENERATION_POLICY, GenerationError, HiggsfieldProvider, modelInput, models, type GenerationInput, type GenerationKind, type ProviderReceipt, type ProviderStatus } from "./higgsfield.js";

type Env = Record<string, string | undefined>;
export interface GenerationJob {
  id: string; owner_user_id: string; client_request_id: string; kind: GenerationKind; model: string;
  provider_input: Record<string, unknown>; provider_receipt: ProviderReceipt | null;
  state: string; estimated_cost_usd: number; created_at: string; lease_token: string;
  attempts: number; submission_started_at: string | null; storage_path: string | null;
  completion: ProviderStatus | null;
  mime_type: string | null; delete_requested: boolean; provider_cleaned: boolean;
}
const positive = (value: string | undefined, fallback: number) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : fallback; };
export function videoConfigured(env: Env) { return isAbsolute(env.MEDIA_FFMPEG_BINARY ?? "") && isAbsolute(env.MEDIA_FFPROBE_BINARY ?? ""); }
export async function generationAvailability(sc: any, env: Env = process.env) {
  const enabled = configuration(env).ready && await isFlagEnabled(sc, "higgsfield_generation_enabled");
  return { enabled, image: enabled, video: enabled && videoConfigured(env), policyVersion: GENERATION_POLICY,
    provider: "Higgsfield", models, retentionDays: 7,
    disclosure: "Your prompt is sent to Higgsfield (and ByteDance for video) to create an AI draft. It is private in Portava until you choose to share it. Generated scenes are not evidence of a real place or visit. Drafts expire after 7 days." };
}
export async function reserveGeneration(sc: any, ownerId: string, input: GenerationInput, env: Env = process.env): Promise<GenerationJob> {
  const available = await generationAvailability(sc, env);
  if (!available[input.kind]) throw new GenerationError("generation_disabled");
  const providerInput = modelInput(input);
  const model = models[input.kind];
  // Bind deduplication to the user's intent. A model upgrade between submission
  // and retry must still recover the original job and its stored model/body.
  const hash = createHash("sha256").update(JSON.stringify({ kind: input.kind, prompt: input.prompt, aspectRatio: input.aspectRatio, policy: input.consentVersion })).digest("hex");
  const { data, error } = await sc.rpc("media_generation_reserve", {
    p_owner: ownerId, p_client_request: input.requestId, p_hash: hash, p_kind: input.kind, p_model: model.id,
    p_input: providerInput, p_policy: input.consentVersion, p_cost: model.estimateUsd,
    p_owner_budget: positive(env.HIGGSFIELD_USER_DAILY_BUDGET_USD, 2), p_global_budget: positive(env.HIGGSFIELD_DAILY_BUDGET_USD, 10),
  });
  if (error || !data) {
    const code = ["generation_budget_exceeded", "generation_request_conflict", "generation_disabled"].find(code => error?.message?.includes(code));
    throw new GenerationError(code ?? "generation_unavailable", !code);
  }
  return data;
}

export function publicJob(job: GenerationJob) {
  return { id: job.id, requestId: job.client_request_id, kind: job.kind, model: job.model, state: job.delete_requested ? "deleting" : job.state,
    estimateUsd: Number(job.estimated_cost_usd), createdAt: job.created_at, aiGenerated: true,
    expiresAt: new Date(new Date(job.created_at).getTime() + 7 * 86400000).toISOString() };
}
export async function listGenerationJobs(sc: any, owner: string) {
  const result = await sc.from("media_generation_jobs").select("*").eq("owner_user_id", owner).neq("state", "deleted").order("created_at", { ascending: false }).limit(20);
  if (result.error) throw new GenerationError("generation_unavailable", true);
  return (result.data ?? []).map(publicJob);
}
export async function previewGeneration(sc: any, owner: string, id: string) {
  const { data: job, error } = await sc.from("media_generation_jobs").select("*").eq("id", id).eq("owner_user_id", owner).maybeSingle();
  if (error) throw new GenerationError("generation_unavailable", true);
  if (!job || job.state !== "ready" || job.delete_requested || Date.now() - Date.parse(job.created_at) >= 7 * 86400000 ||
    job.storage_path !== `${owner}/${id}/output.${job.kind === "image" ? "webp" : "mp4"}`) throw new GenerationError("generation_not_found");
  const signed = await sc.storage.from(GENERATION_BUCKET).createSignedUrl(job.storage_path, 60);
  if (signed.error || !signed.data?.signedUrl) throw new GenerationError("generation_unavailable", true);
  // Re-read after signing so a concurrent delete does not return a fresh link.
  const current = await sc.from("media_generation_jobs").select("id").eq("id", id).eq("owner_user_id", owner).eq("state", "ready").eq("delete_requested", false).maybeSingle();
  if (current.error || !current.data) throw new GenerationError("generation_not_found");
  return { ...publicJob(job), url: signed.data.signedUrl, urlExpiresIn: 60 };
}
export async function deleteGeneration(sc: any, owner: string, id: string) {
  const result = await sc.from("media_generation_jobs").update({ delete_requested: true, next_attempt_at: new Date().toISOString() })
    .eq("id", id).eq("owner_user_id", owner).neq("state", "deleted").select("id");
  if (result.error) throw new GenerationError("generation_unavailable", true);
  return result.data?.[0]?.id as string | undefined;
}

/** Decode images and probe/re-mux videos before storage. No remote URLs reach ffmpeg. */
export async function normalizeGeneratedOutput(bytes: Buffer, mime: string, kind: GenerationKind, env: Env) {
  if (kind === "image") {
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new GenerationError("provider_invalid_output");
    const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning", animated: false }).timeout({ seconds: 10 });
    try {
      const info = await image.metadata();
      if (!info.width || !info.height || (info.pages ?? 1) !== 1 || !["jpeg", "png", "webp"].includes(info.format ?? "")) throw new GenerationError("provider_invalid_output");
      return { bytes: await image.rotate().resize(1920, 1920, { fit: "inside", withoutEnlargement: true }).webp({ quality: 90 }).toBuffer(), mime: "image/webp" };
    } finally { image.destroy(); }
  }
  if (mime !== "video/mp4" || bytes.toString("ascii", 4, 8) !== "ftyp" || !videoConfigured(env)) throw new GenerationError("provider_invalid_output");
  const directory = await mkdtemp(join(tmpdir(), "portava-generated-"));
  try {
    await writeFile(join(directory, "input.mp4"), bytes, { mode: 0o600 });
    const signal = AbortSignal.timeout(15000);
    const report = JSON.parse(await runMediaTool(env.MEDIA_FFPROBE_BINARY!, ["-v", "error", "-max_alloc", "67108864", "-protocol_whitelist", "file,pipe",
      "-format_whitelist", "mov", "-probesize", "8388608", "-analyzeduration", "5000000", "-show_format", "-show_streams", "-of", "json", "input.mp4"], directory, signal));
    const streams = report.streams?.filter((s: any) => s.codec_type === "video");
    const duration = Number(report.format?.duration);
    const video = streams?.[0];
    if (streams?.length !== 1 || !Number.isFinite(duration) || duration < 1 || duration > 6 || video?.codec_name !== "h264" ||
      !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 1 || video.height < 1 || video.width * video.height > 2_100_000) throw new GenerationError("provider_invalid_output");
    await runMediaTool(env.MEDIA_FFMPEG_BINARY!, ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", "input.mp4",
      "-map", "0:v:0", "-c:v", "copy", "-an", "-sn", "-dn", "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", "output.mp4"], directory, signal);
    return { bytes: await readFile(join(directory, "output.mp4")), mime: "video/mp4" };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** One leased step; the receipt is durable before processing a completion event. */
export async function processGenerationJob(sc: any, job: GenerationJob, env: Env = process.env, provider = new HiggsfieldProvider(env), normalize = normalizeGeneratedOutput) {
  const update = async (values: Record<string, unknown>) => {
    const result = await sc.from("media_generation_jobs").update({ ...values, updated_at: new Date().toISOString() }).eq("id", job.id).eq("lease_token", job.lease_token).select("id");
    if (result.error || !result.data?.length) throw new GenerationError("generation_lease_lost", true);
  };
  const readCurrent = async (): Promise<GenerationJob> => {
    const r = await sc.from("media_generation_jobs").select("*").eq("id", job.id).eq("lease_token", job.lease_token).maybeSingle();
    if (r.error || !r.data) throw new GenerationError("generation_lease_lost", true);
    return r.data;
  };
  try {
    job = await readCurrent();
    if (job.state === "deleted") return;
    const expired = Date.now() - Date.parse(job.created_at) > 7 * 86400000;
    const removing = job.delete_requested || expired;
    if (removing && !job.provider_receipt && !job.submission_started_at) {
      await update({ state: "deleted", delete_requested: false, provider_cleaned: true, provider_input: {} }); return;
    }
    // Duplicate events must not revive a rejected draft or repeat completed cleanup.
    if (!removing && ["ready", "failed", "blocked"].includes(job.state) && job.provider_cleaned) return;
    if (!job.provider_receipt) {
      if (!approvedProviderModel("higgsfield", models[job.kind].baseline, job.model)) throw new GenerationError("generation_model_changed");
      if (!await isFlagEnabled(sc, "higgsfield_generation_enabled") && !job.submission_started_at) return;
      const account = await resolveAccountRestriction(sc, job.owner_user_id);
      if (account.state !== "ok") throw new GenerationError("generation_owner_unavailable", true);
      if (account.accountStatus !== "active" || account.restriction.kind !== "none") throw new GenerationError("generation_owner_restricted");
      await update({ state: "running", submission_started_at: job.submission_started_at ?? new Date().toISOString() });
      job.provider_receipt = await provider.submit(job.id, job.kind, job.provider_input, job.model);
      await update({ provider_receipt: job.provider_receipt });
    }
    if (removing) {
      if (job.storage_path) {
        const removed = await sc.storage.from(GENERATION_BUCKET).remove([job.storage_path]);
        if (removed.error) throw new GenerationError("generation_storage_failed", true);
      }
      // 409 means generation is still running. Keep the tombstone; its completion
      // event resumes deletion without a status-check loop.
      try { if (!job.provider_cleaned) await provider.remove(job.provider_receipt); }
      catch (error) { if (error instanceof GenerationError && error.code === "provider_http_409") return; throw error; }
      await update({ state: "deleted", delete_requested: false, storage_path: null, provider_cleaned: true, provider_input: {} }); return;
    }
    // Ready/failed drafts only need provider cleanup; do not regenerate on errors.
    if (!removing && ["ready", "failed", "blocked"].includes(job.state)) {
      await provider.remove(job.provider_receipt);
      await update({ provider_cleaned: true, provider_input: {} }); return;
    }
    const status = (await readCurrent()).completion;
    if (!status) return; // Completion arrives through a signed webhook, never a polling loop.
    if (status.state !== "completed") {
      await update({ state: status.state === "nsfw" ? "blocked" : "failed", failure_code: `provider_${status.state}` });
      await provider.remove(job.provider_receipt); await update({ provider_cleaned: true, provider_input: {} }); return;
    }
    const source = await provider.download(status.outputUrl!, job.kind);
    const output = await normalize(source.bytes, source.mime, job.kind, env);
    const current = await readCurrent();
    if (current.delete_requested) return;
    const account = await resolveAccountRestriction(sc, job.owner_user_id);
    if (account.state !== "ok") throw new GenerationError("generation_owner_unavailable", true);
    if (account.accountStatus !== "active" || account.restriction.kind !== "none") throw new GenerationError("generation_owner_restricted");
    const path = `${job.owner_user_id}/${job.id}/output.${job.kind === "image" ? "webp" : "mp4"}`;
    // Bucket privacy is checked on every upload, not assumed from a migration.
    const bucket = await sc.storage.getBucket(GENERATION_BUCKET);
    if (bucket.error || bucket.data?.public !== false) throw new GenerationError("generation_storage_not_private");
    await update({ storage_path: path });
    const uploaded = await sc.storage.from(GENERATION_BUCKET).upload(path, output.bytes, { contentType: output.mime, upsert: true, cacheControl: "60" });
    if (uploaded.error) throw new GenerationError("generation_storage_failed", true);
    await update({ state: "ready", storage_path: path, mime_type: output.mime });
    await provider.remove(job.provider_receipt); await update({ provider_cleaned: true, provider_input: {} });
  } catch (error) {
    const safe = error instanceof GenerationError ? error : new GenerationError("generation_processing_failed", true);
    const current = await readCurrent();
    // Stop terminal validation failures; an accepted receipt remains for cleanup.
    await update({ failure_code: safe.code, attempts: job.attempts + 1,
      ...((!safe.retryable || job.attempts >= 11) && !current.delete_requested && !["ready", "blocked", "deleted"].includes(current.state) ? { state: "failed", provider_cleaned: !current.provider_receipt } : {}) });
    if (!safe.retryable && current.provider_receipt && !current.provider_cleaned) {
      await provider.remove(current.provider_receipt);
      await update({ provider_cleaned: true, provider_input: {} });
    }
    if (safe.retryable) throw safe; // The event consumer retries this delivery with backoff.
  } finally {
    await update({ lease_until: null, lease_token: null, next_attempt_at: new Date(Date.now() + Math.min(60000, 5000 * 2 ** Math.min(job.attempts, 4))).toISOString() });
  }
}
