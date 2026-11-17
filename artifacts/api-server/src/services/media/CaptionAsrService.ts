import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { CaptionError, EMPTY_CAPTION_REVISION, captionLanguage, readCaptionAsset, readCaptionManifest, recheckCaptionAsset, requirePrivateCaptionStorage } from "./AuthoredCaptionsService.js";

export interface CaptionProcessingConsent {
  disclosureVersion?: string;
  consentId: string;
  jobId: string;
  jobRevisionKey: string;
  assetId: string;
  ownerId: string;
  sourceVersion: number;
  revisionKey: string;
  configVersion: string;
  allowedLanguages: readonly string[];
  transcription: true;
  recordedAt: string;
}

export interface CaptionProcessingReceipt { provider: "local" | "deepgram"; modelVersion: string; configVersion: string; disclosureVersion: string }

interface AsrConfig {
  processing_provider?: "local" | "deepgram";
  enabled: boolean;
  model_version: string;
  config_version: string;
  allowed_languages: string[];
  runtime_verified_at: string | null;
}

export async function readCaptionAsrConfig(sc: SupabaseClient): Promise<AsrConfig | null> {
  const { data, error } = await sc.from("media_caption_asr_config").select("enabled, model_version, config_version, allowed_languages, runtime_verified_at, processing_provider").eq("singleton", true).maybeSingle();
  if (error) throw new CaptionError("degraded_unavailable", "Transcription configuration unavailable.");
  if (!data || data.enabled !== true || !Number.isFinite(Date.parse(data.runtime_verified_at)) || !Array.isArray(data.allowed_languages) || !data.allowed_languages.length) return null;
  if (!/^[A-Za-z0-9._:/@+\-]{1,200}$/.test(data.model_version) || typeof data.config_version !== "string" || !data.config_version || data.config_version.length > 200) return null;
  for (const language of data.allowed_languages) captionLanguage(language);
  if (data.processing_provider != null && !["local", "deepgram"].includes(data.processing_provider)) return null;
  if (data.processing_provider === "deepgram" && !/^deepgram:nova-3:[A-Za-z0-9._-]{1,100}$/.test(data.model_version)) return null;
  return data as AsrConfig;
}

function processingReceipt(config: AsrConfig): CaptionProcessingReceipt {
  const provider = config.processing_provider ?? "local";
  return { provider, modelVersion: config.model_version, configVersion: config.config_version, disclosureVersion: provider === "deepgram" ? "deepgram-audio-opt-out-v1" : "local-audio-v1" };
}

export async function readActiveCaptionAsrGrant(sc: SupabaseClient, assetId: string) {
  const { data, error } = await sc.from("media_caption_asr_consents").select("id, asset_id, owner_user_id, source_version, caption_revision_key, job_revision_key, model_version, config_version, target_language, job_id, granted_at, revoked_at, processing_disclosure_version").eq("asset_id", assetId).is("revoked_at", null).maybeSingle();
  if (error) throw new CaptionError("degraded_unavailable", "Transcription consent unavailable.");
  if (!data) return null;
  const { data: job, error: jobError } = await sc.from("media_derivative_jobs").select("id, asset_id, owner_user_id, source_version, source_bucket, source_path, kind, model_version, target_language, revision_key, state, lease_token, lease_until, result").eq("id", data.job_id).maybeSingle();
  if (jobError) throw new CaptionError("degraded_unavailable", "Transcription job unavailable.");
  if (!job || job.kind !== "captions" || job.asset_id !== data.asset_id || job.owner_user_id !== data.owner_user_id || job.source_version !== data.source_version || job.model_version !== data.model_version || job.target_language !== data.target_language || job.revision_key !== data.job_revision_key || job.state === "cancelled") return null;
  return { consent: data, job };
}

async function asrEnabled(sc: SupabaseClient): Promise<boolean> {
  return await isFlagEnabled(sc, "media_captions_enabled") && await isFlagEnabled(sc, "media_caption_asr_enabled") && await isFlagEnabled(sc, "media_derivative_jobs_enabled");
}

export async function readCaptionProcessingConsent(sc: SupabaseClient, request: Readonly<{ id: string; token: string; assetId: string; ownerUserId: string; sourceVersion: number; kind: string; bucket: string; path: string; modelVersion: string; targetLanguage?: string; revisionKey?: string }>): Promise<CaptionProcessingConsent | null> {
  if (!(await asrEnabled(sc))) return null;
  const config = await readCaptionAsrConfig(sc);
  const active = await readActiveCaptionAsrGrant(sc, request.assetId);
  if (!active || !config) return null;
  const { consent, job } = active;
  if (config.processing_provider === "deepgram" && consent.processing_disclosure_version !== processingReceipt(config).disclosureVersion) return null;
  if (request.kind !== "captions" || job.id !== request.id || job.state !== "processing" || job.lease_token !== request.token || !(Date.parse(job.lease_until) > Date.now())
    || job.owner_user_id !== request.ownerUserId || job.source_version !== request.sourceVersion || job.source_bucket !== request.bucket || job.source_path !== request.path
    || job.model_version !== request.modelVersion || job.revision_key !== request.revisionKey || job.target_language !== (request.targetLanguage ?? "")
    || consent.model_version !== config.model_version || consent.config_version !== config.config_version
    || (consent.target_language && !config.allowed_languages.includes(consent.target_language))) return null;
  const source = await readCaptionAsset(sc, request.assetId);
  const manifest = await readCaptionManifest(sc, request.assetId);
  if (source.owner_user_id !== request.ownerUserId || source.version !== request.sourceVersion || source.storage_bucket !== request.bucket || source.storage_path !== request.path || (manifest?.revision_key ?? EMPTY_CAPTION_REVISION) !== consent.caption_revision_key) return null;
  await recheckCaptionAsset(sc, request.ownerUserId, source);
  return { disclosureVersion: consent.processing_disclosure_version ?? undefined, consentId: consent.id, jobId: job.id, jobRevisionKey: consent.job_revision_key, assetId: consent.asset_id, ownerId: consent.owner_user_id, sourceVersion: consent.source_version, revisionKey: consent.caption_revision_key, configVersion: consent.config_version, allowedLanguages: config.allowed_languages, transcription: true, recordedAt: consent.granted_at };
}

export async function getCaptionAsrStatus(sc: SupabaseClient, ownerId: string, assetId: string) {
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) throw new CaptionError("forbidden", "Only the creator can manage transcription.");
  const { data: consentEpoch, error: epochError } = await sc.rpc("media_caption_asr_epoch", { p_asset_id: assetId, p_owner_id: ownerId });
  if (epochError || typeof consentEpoch !== "string" || !/^[a-f0-9]{64}$/.test(consentEpoch)) throw new CaptionError("degraded_unavailable", "Transcription consent status unavailable.");
  const config = await readCaptionAsrConfig(sc);
  const active = await readActiveCaptionAsrGrant(sc, assetId);
  const manifest = await readCaptionManifest(sc, assetId);
  const revisionKey = manifest?.revision_key ?? EMPTY_CAPTION_REVISION;
  return { processing: config ? processingReceipt(config) : null, enabled: Boolean(config && await asrEnabled(sc)), languages: config?.allowed_languages ?? [], sourceVersion: source.version, revisionKey, consentEpoch,
    state: active?.job.state ?? "not_requested", canRevoke: Boolean(active), current: !active || active.consent.source_version === source.version && active.consent.caption_revision_key === revisionKey };
}

export async function enqueueCaptionAsr(sc: SupabaseClient, ownerId: string, assetId: string, version: number, revisionKey: string, language: string, consent: boolean, expectedConsentEpoch: string, processing?: CaptionProcessingReceipt) {
  if (consent !== true) throw new CaptionError("invalid_payload", "Explicit transcription consent is required.");
  if (typeof expectedConsentEpoch !== "string" || !/^[a-f0-9]{64}$/.test(expectedConsentEpoch)) throw new CaptionError("invalid_payload", "Refresh transcription consent status before requesting a draft.");
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) throw new CaptionError("forbidden", "Only the creator can request transcription.");
  const manifest = await readCaptionManifest(sc, assetId);
  if (source.version !== version || (manifest?.revision_key ?? EMPTY_CAPTION_REVISION) !== revisionKey) throw new CaptionError("conflict", "The video or captions changed.");
  await recheckCaptionAsset(sc, ownerId, source);
  await requirePrivateCaptionStorage(sc);
  if (language) captionLanguage(language);
  const config = await readCaptionAsrConfig(sc);
  if (!config || !(await asrEnabled(sc))) throw new CaptionError("feature_disabled", "Transcription is not enabled.");
  if (language && !config.allowed_languages.includes(language)) throw new CaptionError("invalid_payload", "This language is not validated for transcription.");
  const expected = processingReceipt(config);
  if (processing && Object.keys(expected).some((key) => processing[key as keyof CaptionProcessingReceipt] !== expected[key as keyof CaptionProcessingReceipt])
    || !processing && expected.provider !== "local") throw new CaptionError("conflict", "The transcription provider changed. Reopen and review its processing disclosure.");
  const parameters = { p_asset_id: assetId, p_owner_id: ownerId, p_source: source, p_caption_revision: revisionKey, p_target_language: language, p_consent: consent, p_expected_consent_epoch: expectedConsentEpoch };
  const { data, error } = processing
    ? await sc.rpc("media_caption_asr_enqueue_v2", { ...parameters, p_expected_provider: processing.provider, p_expected_model: processing.modelVersion, p_expected_config: processing.configVersion, p_disclosure_version: processing.disclosureVersion })
    : await sc.rpc("media_caption_asr_enqueue", parameters);
  if (error) throw new CaptionError("degraded_unavailable", "Transcription could not be queued. No audio was exported.");
  if (typeof data !== "string" || !/^[a-f0-9-]{36}$/i.test(data)) throw new CaptionError("conflict", "Transcription was not queued. Reopen to refresh consent, video and captions.");
  await recheckCaptionAsset(sc, ownerId, source);
  let cleanupPending = false;
  try { await purgeRevokedCaptionDrafts(sc, source.id); } catch { cleanupPending = true; }
  return { jobId: data, cleanupPending, ...await getCaptionAsrStatus(sc, ownerId, assetId) };
}

export async function findPreviouslyConsentedCaptionJob(sc: SupabaseClient, assetId: string, sourceVersion: number, captionRevisionKey: string): Promise<string | null> {
  if (!(await asrEnabled(sc))) return null;
  const active = await readActiveCaptionAsrGrant(sc, assetId);
  const config = await readCaptionAsrConfig(sc);
  if (!active || !config || active.consent.source_version !== sourceVersion || active.consent.caption_revision_key !== captionRevisionKey
    || active.consent.model_version !== config.model_version || active.consent.config_version !== config.config_version
    || !["pending", "processing", "retrying"].includes(active.job.state)) return null;
  const source = await readCaptionAsset(sc, assetId);
  const manifest = await readCaptionManifest(sc, assetId);
  if (source.version !== sourceVersion || source.owner_user_id !== active.consent.owner_user_id || (manifest?.revision_key ?? EMPTY_CAPTION_REVISION) !== captionRevisionKey) return null;
  await recheckCaptionAsset(sc, source.owner_user_id, source);
  return active.job.id;
}

export async function purgeRevokedCaptionDrafts(sc: SupabaseClient, assetId: string): Promise<void> {
  let offset = 0;
  const prefix = `manual-captions/${assetId}`;
  for (let page = 0; page < 32; page++) {
    const listed = await sc.storage.from("post-media").list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (listed.error || !listed.data) throw new CaptionError("degraded_unavailable", "Draft erasure needs retry.");
    const candidates = listed.data.flatMap((entry) => {
      const matched = /^asr-v[1-9]\d*-([a-f0-9-]{36})-[a-f0-9]{64}\.json$/.exec(entry.name);
      return matched ? [{ name: entry.name, grantId: matched[1]! }] : [];
    });
    let removedCount = 0;
    if (candidates.length) {
      const grants = await sc.from("media_caption_asr_consents").select("id, revoked_at").eq("asset_id", assetId).in("id", candidates.map((entry) => entry.grantId));
      if (grants.error || !grants.data) throw new CaptionError("degraded_unavailable", "Draft erasure consent check failed.");
      const revoked = new Set(grants.data.filter((grant) => grant.revoked_at !== null).map((grant) => grant.id));
      const paths = candidates.filter((entry) => revoked.has(entry.grantId)).map((entry) => `${prefix}/${entry.name}`);
      if (paths.length) {
        const removed = await sc.storage.from("post-media").remove(paths);
        if (removed.error) throw new CaptionError("degraded_unavailable", "Draft erasure needs retry.");
        removedCount = paths.length;
      }
    }
    if (listed.data.length < 100) return;
    offset += listed.data.length - removedCount;
  }
  throw new CaptionError("degraded_unavailable", "Draft erasure requires another bounded pass.");
}

export async function revokeCaptionAsr(sc: SupabaseClient, ownerId: string, assetId: string) {
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) throw new CaptionError("forbidden", "Only the creator can revoke transcription.");
  const { data, error } = await sc.rpc("media_caption_asr_revoke", { p_asset_id: assetId, p_owner_id: ownerId });
  if (error || data !== true) throw new CaptionError("degraded_unavailable", "Transcription revocation could not be confirmed.");
  let cleanupPending = false;
  try { await purgeRevokedCaptionDrafts(sc, source.id); } catch { cleanupPending = true; }
  return { revoked: true, cleanupPending };
}
