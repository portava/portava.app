import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CaptionError, captionLanguage, readCaptionAsset, readCaptionManifest, EMPTY_CAPTION_REVISION, recheckCaptionAsset, requirePrivateCaptionStorage, writeAuthoredCaptions, type CaptionAsset } from "./AuthoredCaptionsService.js";
import { MAX_VTT_BYTES, parseWebVtt } from "../../lib/media/vendors/mediaCaptionSource.js";
import { readActiveCaptionAsrGrant } from "./CaptionAsrService.js";

export interface CaptionJob {
  assetId: string;
  sourceVersion: number;
  kind: "captions";
  modelVersion: string;
  targetLanguage: string | null;
  configVersion: string;
  revisionKey: string;
  consentId: string;
  jobId: string;
  leaseToken?: string;
  expectedSource?: { bucket: string; path: string };
  requestedBy: string;
  consent: { transcription: true; ownerId: string; recordedAt: string };
}

export interface CaptionDraft {
  source: CaptionAsset;
  draftId: string;
  vtt: string;
  language: string;
  sourceKind: "asr";
  aiLabel: "AI transcription · needs creator review";
  modelVersion: string;
  configVersion: string;
  revisionKey: string;
  consentId: string;
  jobId: string;
}

export function captionDraftId(job: Omit<CaptionJob, "consent" | "requestedBy">): string {
  return createHash("sha256").update(JSON.stringify([job.assetId, job.sourceVersion, job.kind, job.modelVersion, job.targetLanguage, job.configVersion, job.revisionKey, job.consentId, job.jobId, job.leaseToken ?? ""])).digest("hex");
}

export function captionDraftPath(assetId: string, version: number, draftId: string, consentId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(assetId) || !/^[0-9a-f-]{36}$/i.test(consentId) || !Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{64}$/.test(draftId)) throw new CaptionError("invalid_payload", "Invalid caption draft.");
  return `manual-captions/${assetId}/asr-v${version}-${consentId}-${draftId}.json`;
}

export async function readCaptionDraft(sc: SupabaseClient, ownerId: string, assetId: string, version: number, draftId?: string): Promise<CaptionDraft | null> {
  const asset = await readCaptionAsset(sc, assetId);
  if (asset.owner_user_id !== ownerId) throw new CaptionError("forbidden", "Only the video owner can review drafts.");
  if (asset.version !== version) throw new CaptionError("conflict", "The video changed.");
  await recheckCaptionAsset(sc, ownerId, asset);
  await requirePrivateCaptionStorage(sc);
  const active = await readActiveCaptionAsrGrant(sc, assetId);
  if (!active || active.consent.owner_user_id !== ownerId || active.consent.source_version !== version || active.job.state !== "completed") return null;
  const selectedId = active.job.result?.draftId;
  if (typeof selectedId !== "string" || draftId !== undefined && draftId !== selectedId) throw new CaptionError("not_found", "This draft is not current.");
  const path = captionDraftPath(assetId, version, selectedId, active.consent.id);
  if (active.job.result?.artifactKey !== path) throw new CaptionError("conflict", "Draft completion does not match its artifact.");
  const { data, error } = await sc.storage.from("post-media").download(path);
  if (error || !data || data.size > MAX_VTT_BYTES * 6 + 4096) throw new CaptionError("degraded_unavailable", "Caption draft unavailable.");
  let draft: CaptionDraft;
  try { draft = JSON.parse(await data.text()); } catch { throw new CaptionError("invalid_payload", "Invalid caption draft."); }
  if (!draft || draft.draftId !== selectedId || draft.consentId !== active.consent.id || draft.jobId !== active.job.id || draft.sourceKind !== "asr" || draft.aiLabel !== "AI transcription · needs creator review" || typeof draft.vtt !== "string" || draft.modelVersion !== active.consent.model_version || draft.configVersion !== active.consent.config_version || !draft.source || Object.keys(asset).some((key) => asset[key as keyof CaptionAsset] !== draft.source[key as keyof CaptionAsset]) || !parseWebVtt(draft.vtt, asset.duration_ms).ok) throw new CaptionError("conflict", "Caption draft does not match this source.");
  captionLanguage(draft.language);
  const manifest = await readCaptionManifest(sc, assetId);
  if (draft.revisionKey !== (manifest?.revision_key ?? EMPTY_CAPTION_REVISION)) throw new CaptionError("conflict", "Captions changed after this draft was requested.");
  await recheckCaptionAsset(sc, ownerId, asset);
  const latest = await readActiveCaptionAsrGrant(sc, assetId);
  if (!latest || latest.consent.id !== draft.consentId || latest.job.state !== "completed" || latest.job.result?.artifactKey !== path) throw new CaptionError("conflict", "Transcription consent changed.");
  return draft;
}

export async function publishCaptionDraft(sc: SupabaseClient, ownerId: string, assetId: string, version: number, draftId: string, consent: boolean, editedVtt?: string, expectedRevision = EMPTY_CAPTION_REVISION) {
  const draft = await readCaptionDraft(sc, ownerId, assetId, version, draftId);
  if (!draft) throw new CaptionError("not_found", "Caption draft unavailable.");
  if (draft.revisionKey !== expectedRevision) throw new CaptionError("conflict", "Captions changed. Review a current draft.");
  const result = await writeAuthoredCaptions(sc, ownerId, assetId, version, editedVtt ?? draft.vtt, consent, draft.language, { sourceKind: "asr", modelVersion: draft.modelVersion, sourceLanguage: draft.language, consentId: draft.consentId }, expectedRevision);
  let cleanupPending = result.cleanupPending;
  try { const removed = await sc.storage.from("post-media").remove([captionDraftPath(assetId, version, draftId, draft.consentId)]); cleanupPending = Boolean(removed.error) || cleanupPending; } catch { cleanupPending = true; }
  return { ...result, cleanupPending };
}
