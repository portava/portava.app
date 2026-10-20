import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../../lib/featureFlags.js';
import { MAX_VTT_BYTES, parseWebVtt } from '../../lib/media/vendors/mediaCaptionSource.js';
import { subtitleTranslationDraftPath, type SubtitleTranslationConsent, type SubtitleTranslationContext, type SubtitleTranslationDraft } from '../../lib/media/captions/subtitleTranslationHandler.js';
import type { CaptionTranslationStatus, CaptionTranslationEnqueueResponse, CaptionTranslationRevokeResponse, CaptionTranslationPublishResponse } from '../../lib/media/captions/subtitleTranslationContract.js';
import { CaptionError, EMPTY_CAPTION_REVISION, captionArtifactPath, readCaptionAsset, readCaptionManifest, readCaptionSnapshot, recheckCaptionAsset, requirePrivateCaptionStorage, type CaptionVariant } from './AuthoredCaptionsService.js';
import { eraseTranslationArtifact, readTranslationArtifact, requireUploadedTranslationArtifact, reserveTranslationArtifact, uploadTranslationArtifact } from '../../lib/media/captions/translationArtifactStore.js';
import { RetainedCaptionTranslationReconciler } from './RetainedCaptionTranslationReconciler.js';
import { withMediaCleanup } from './MediaCleanupTransport.js';

const MODEL = /^[A-Za-z0-9._:/@+\-]{1,160}$/;
const LANGUAGE = /^(?!und$|zxx$)[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BYTES = MAX_VTT_BYTES * 6 + 4096;
const fail = (code: ConstructorParameters<typeof CaptionError>[0], message: string): never => { throw new CaptionError(code, message); };

export function validTranslationPairs(value: unknown): value is Array<{ source: string; target: string }> {
  return Array.isArray(value) && value.length > 0 && value.length <= 50 && value.every(pair =>
    pair && typeof pair.source === 'string' && typeof pair.target === 'string'
    && pair.source.length <= 35 && pair.target.length <= 35 && LANGUAGE.test(pair.source) && LANGUAGE.test(pair.target)
    && pair.source.toLowerCase() !== pair.target.toLowerCase());
}

export async function readCaptionTranslationConfig(sc: SupabaseClient) {
  const { data, error } = await sc.from('media_caption_translation_config')
    .select('enabled,model_version,config_version,allowed_pairs,runtime_verified_at').eq('singleton', true).maybeSingle();
  if (error) return fail('degraded_unavailable', 'Translation configuration unavailable.');
  if (!data || data.enabled !== true || !Number.isFinite(Date.parse(data.runtime_verified_at))
    || Date.parse(data.runtime_verified_at) > Date.now() || typeof data.model_version !== 'string' || !MODEL.test(data.model_version)
    || typeof data.config_version !== 'string' || !data.config_version || data.config_version.length > 200
    || !validTranslationPairs(data.allowed_pairs)) return null;
  return { modelVersion: String(data.model_version), configVersion: String(data.config_version), allowedPairs: data.allowed_pairs };
}

async function enabled(sc: SupabaseClient) {
  return await isFlagEnabled(sc, 'media_captions_enabled') && await isFlagEnabled(sc, 'media_caption_translation_enabled')
    && await isFlagEnabled(sc, 'media_derivative_jobs_enabled');
}

async function consentEpoch(sc: SupabaseClient, assetId: string): Promise<number> {
  const { data, error } = await sc.from('media_caption_translation_epochs').select('epoch').eq('asset_id', assetId).maybeSingle();
  if (error) return fail('degraded_unavailable', 'Translation consent version unavailable.');
  const epoch = data ? Number(data.epoch) : 0;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return fail('degraded_unavailable', 'Invalid translation consent version.');
  return epoch;
}

async function pendingCleanup(sc: SupabaseClient, assetId: string): Promise<boolean> {
  try {
    const { data, error } = await sc.from('media_caption_translation_consents').select('id').eq('asset_id', assetId).eq('cleanup_pending', true).limit(1);
    if (error || !Array.isArray(data) || data.length) return true;
    const retained = await sc.from('media_caption_translation_artifacts').select('write_state,cleanup_requested').eq('asset_id', assetId).limit(1000);
    return Boolean(retained.error || !Array.isArray(retained.data) || retained.data.length >= 1000
      || retained.data.some(row => row.cleanup_requested !== false || !['uploaded', 'never_dispatched'].includes(row.write_state)));
  } catch { return true; }
}

async function activeGrant(sc: SupabaseClient, assetId: string) {
  const { data: consent, error } = await sc.from('media_caption_translation_consents')
    .select('id,asset_id,owner_user_id,source_version,consent_epoch,caption_revision_key,job_revision_key,model_version,config_version,source_language,target_language,job_id,granted_at,revoked_at')
    .eq('asset_id', assetId).is('revoked_at', null).maybeSingle();
  if (error) return fail('degraded_unavailable', 'Translation permission unavailable.');
  if (!consent) return null;
  const { data: job, error: jobError } = await sc.from('media_derivative_jobs')
    .select('id,asset_id,owner_user_id,source_version,source_bucket,source_path,source_bytes,kind,model_version,target_language,revision_key,state,lease_token,lease_until,result')
    .eq('id', consent.job_id).maybeSingle();
  if (jobError) return fail('degraded_unavailable', 'Translation job unavailable.');
  if (!job || job.kind !== 'subtitle_translation' || job.asset_id !== consent.asset_id || job.owner_user_id !== consent.owner_user_id
    || job.source_version !== consent.source_version || job.model_version !== consent.model_version
    || job.target_language !== consent.target_language || job.revision_key !== consent.job_revision_key || job.state === 'cancelled') return null;
  return { consent, job };
}

function processingConsent(consent: NonNullable<Awaited<ReturnType<typeof activeGrant>>>['consent']): SubtitleTranslationConsent {
  return { consentId: consent.id, jobId: consent.job_id, jobRevisionKey: consent.job_revision_key, assetId: consent.asset_id,
    ownerId: consent.owner_user_id, sourceVersion: consent.source_version, revisionKey: consent.caption_revision_key,
    sourceLanguage: consent.source_language, targetLanguage: consent.target_language, modelVersion: consent.model_version,
    configVersion: consent.config_version, translation: true, recordedAt: consent.granted_at };
}

async function authorizedState(sc: SupabaseClient, ownerId: string, assetId: string, version: number) {
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) return fail('forbidden', 'Only the creator can manage subtitle translation.');
  if (source.version !== version) return fail('conflict', 'The original video changed.');
  await recheckCaptionAsset(sc, ownerId, source);
  await requirePrivateCaptionStorage(sc);
  if (!(await enabled(sc))) return fail('feature_disabled', 'Local subtitle translation is not enabled.');
  const config = await readCaptionTranslationConfig(sc);
  const active = await activeGrant(sc, assetId);
  if (!config || !active) return fail('not_found', 'No current subtitle translation permission.');
  const { consent, job } = active;
  const snapshot = await readCaptionSnapshot(sc, ownerId, assetId, version);
  if (consent.owner_user_id !== ownerId || consent.source_version !== version || Number(consent.consent_epoch) !== await consentEpoch(sc, assetId)
    || consent.caption_revision_key !== snapshot.revisionKey
    || job.source_bucket !== source.storage_bucket || job.source_path !== source.storage_path
    || consent.model_version !== config.modelVersion || consent.config_version !== config.configVersion
    || !config.allowedPairs.some(pair => pair.source === consent.source_language && pair.target === consent.target_language)
    || snapshot.tracks.filter(track => track.language === consent.source_language).length !== 1) {
    return fail('conflict', 'Translation permission no longer matches the original captions.');
  }
  return { source, snapshot, config, ...active };
}

export async function readSubtitleTranslationConsent(sc: SupabaseClient, request: SubtitleTranslationContext['job']): Promise<SubtitleTranslationConsent | null> {
  try {
    const { consent, job } = await authorizedState(sc, request.ownerUserId, request.assetId, request.sourceVersion);
    if (request.kind !== 'subtitle_translation' || job.id !== request.id || job.state !== 'processing'
      || job.lease_token !== request.token || !(Date.parse(job.lease_until) > Date.now())
      || job.source_bucket !== request.bucket || job.source_path !== request.path || Number(job.source_bytes) !== request.sizeBytes
      || job.model_version !== request.modelVersion || job.target_language !== request.targetLanguage || job.revision_key !== request.revisionKey) return null;
    return processingConsent(consent);
  } catch { return null; }
}

export async function getCaptionTranslationStatus(sc: SupabaseClient, ownerId: string, assetId: string): Promise<CaptionTranslationStatus> {
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) return fail('forbidden', 'Only the creator can manage subtitle translation.');
  const config = await readCaptionTranslationConfig(sc);
  const active = await activeGrant(sc, assetId);
  const manifest = await readCaptionManifest(sc, assetId);
  const revisionKey = manifest?.revision_key ?? EMPTY_CAPTION_REVISION;
  const epoch = await consentEpoch(sc, assetId);
  return { enabled: Boolean(config && await enabled(sc)), allowedPairs: config?.allowedPairs ?? [],
    cleanupPending: await pendingCleanup(sc, assetId),
    sourceVersion: source.version, revisionKey, consentEpoch: epoch, state: active?.job.state ?? 'not_requested', canRevoke: Boolean(active),
    current: !active || active.consent.source_version === source.version && active.consent.caption_revision_key === revisionKey
      && Number(active.consent.consent_epoch) === epoch
      && active.consent.model_version === config?.modelVersion && active.consent.config_version === config?.configVersion };
}

export async function enqueueCaptionTranslation(sc: SupabaseClient, ownerId: string, assetId: string,
  version: number, revisionKey: string, sourceLanguage: string, targetLanguage: string, consent: boolean, expectedConsentEpoch: number): Promise<CaptionTranslationEnqueueResponse> {
  if (!Number.isSafeInteger(expectedConsentEpoch) || expectedConsentEpoch < 0) return fail('invalid_payload', 'An original consent version is required.');
  if (consent !== true || !validTranslationPairs([{ source: sourceLanguage, target: targetLanguage }])) return fail('invalid_payload', 'Explicit translation permission and a distinct language pair are required.');
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) return fail('forbidden', 'Only the creator can request subtitle translation.');
  const snapshot = await readCaptionSnapshot(sc, ownerId, assetId, version);
  if (source.version !== version || snapshot.revisionKey !== revisionKey) return fail('conflict', 'The video or captions changed.');
  if (snapshot.tracks.filter(track => track.language === sourceLanguage).length !== 1) return fail('invalid_payload', 'Select an existing original caption language.');
  await recheckCaptionAsset(sc, ownerId, source);
  await requirePrivateCaptionStorage(sc);
  const config = await readCaptionTranslationConfig(sc);
  if (!config || !(await enabled(sc))) return fail('feature_disabled', 'Local subtitle translation is not enabled.');
  if (!config.allowedPairs.some(pair => pair.source === sourceLanguage && pair.target === targetLanguage)) return fail('invalid_payload', 'This translation pair has not been validated.');
  const { data, error } = await sc.rpc('media_caption_translation_enqueue', { p_asset_id: assetId, p_owner_id: ownerId,
    p_source: source, p_caption_revision: revisionKey, p_source_language: sourceLanguage, p_target_language: targetLanguage,
    p_consent: consent, p_expected_epoch: expectedConsentEpoch });
  if (error) return fail('degraded_unavailable', 'Translation could not be queued.');
  if (typeof data !== 'string' || !UUID.test(data)) return fail('conflict', 'Translation was not queued. Refresh the original captions.');
  await recheckCaptionAsset(sc, ownerId, source);
  let cleanupPending = false;
  try { await purgeRevokedTranslationDrafts(sc, assetId); } catch { cleanupPending = true; }
  const status = await getCaptionTranslationStatus(sc, ownerId, assetId);
  return { ...status, jobId: data, cleanupPending: cleanupPending || status.cleanupPending };
}

export async function purgeRevokedTranslationDrafts(sc: SupabaseClient, assetId: string): Promise<void> {
  if (!UUID.test(assetId)) return fail('invalid_payload', 'Invalid video.');
  return withMediaCleanup(sc, async client => {
    const inventory = await client.storage.from('post-media').list(`manual-captions/${assetId}`, { limit: 1000, offset: 0 });
    if (inventory.error || !Array.isArray(inventory.data) || inventory.data.length >= 1000) return fail('degraded_unavailable', 'Translation cleanup inventory unavailable.');
    const reconciled = await new RetainedCaptionTranslationReconciler(client).runPass({ assetId, limit: 50 });
    if (!reconciled.schemaInstalled || reconciled.failed || reconciled.unsettled || !reconciled.pageExhausted) return fail('degraded_unavailable', 'Translation cleanup needs retry; writer quiescence unconfirmed.');
    const prefix = `manual-captions/${assetId}`;
    const listed = await client.storage.from('post-media').list(prefix, { limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } });
    if (listed.error || !listed.data) return fail('degraded_unavailable', 'Translation draft erasure needs retry.');
    if (listed.data.length >= 1000) return fail('degraded_unavailable', 'Draft erasure requires another bounded pass.');
    for (const entry of listed.data) {
      if (!/^translation-v/.test(entry.name)) continue;
      const artifact = await readTranslationArtifact(client, `${prefix}/${entry.name}`);
      if (!artifact || artifact.cleanup_requested || artifact.write_state !== 'uploaded' || artifact.retirement_token) return fail('degraded_unavailable', 'Unexpected caption artifact; translation cleanup unconfirmed.');
    }
  });
}

export async function revokeCaptionTranslation(sc: SupabaseClient, ownerId: string, assetId: string): Promise<CaptionTranslationRevokeResponse> {
  const source = await readCaptionAsset(sc, assetId);
  if (source.owner_user_id !== ownerId) return fail('forbidden', 'Only the creator can revoke subtitle translation.');
  const { data, error } = await sc.rpc('media_caption_translation_revoke', { p_asset_id: assetId, p_owner_id: ownerId });
  if (error || data !== true) return fail('degraded_unavailable', 'Translation revocation could not be confirmed.');
  let cleanupPending = false;
  try { await purgeRevokedTranslationDrafts(sc, assetId); } catch { cleanupPending = true; }
  return { revoked: true, consentEpoch: await consentEpoch(sc, assetId), cleanupPending: cleanupPending || await pendingCleanup(sc, assetId) };
}

export async function readCaptionTranslationDraft(sc: SupabaseClient, ownerId: string, assetId: string, version: number, draftId?: string) {
  const state = await authorizedState(sc, ownerId, assetId, version);
  const { source, consent, job, snapshot } = state;
  if (job.state !== 'completed') return null;
  const selectedId = job.result?.draftId;
  if (typeof selectedId !== 'string' || !/^[a-f0-9]{64}$/.test(selectedId) || draftId !== undefined && selectedId !== draftId) return fail('not_found', 'No current translation draft.');
  const path = `manual-captions/${assetId}/translation-v${version}-${consent.id}-${selectedId}.json`;
  if (job.result?.state !== 'draft_ready' || job.result?.artifactKey !== path || job.result?.consentId !== consent.id) return fail('conflict', 'Draft completion identity changed.');
  try { await requireUploadedTranslationArtifact(sc, path); } catch { return fail('degraded_unavailable', 'Translation draft settlement unavailable.'); }
  const downloaded = await sc.storage.from('post-media').download(path);
  if (downloaded.error || !downloaded.data || downloaded.data.size > MAX_BYTES) return fail('degraded_unavailable', 'Translation draft unavailable.');
  let draft: SubtitleTranslationDraft;
  try { draft = JSON.parse(await downloaded.data.text()); } catch { return fail('invalid_payload', 'Invalid translation draft.'); }
  const original = snapshot.tracks.find(track => track.language === consent.source_language)!;
  const fingerprint = createHash('sha256').update(JSON.stringify([processingConsent(consent), source, snapshot])).digest('hex');
  if (!draft || draft.assetId !== assetId || draft.sourceVersion !== version || draft.draftId !== selectedId
    || draft.consentId !== consent.id || draft.jobId !== job.id || !UUID.test(draft.leaseToken) || draft.jobRevisionKey !== consent.job_revision_key
    || draft.revisionKey !== snapshot.revisionKey || draft.sourceTrackRevision !== original.revision || draft.sourceFingerprint !== fingerprint
    || draft.modelVersion !== consent.model_version || draft.configVersion !== consent.config_version
    || draft.sourceLanguage !== consent.source_language || draft.language !== consent.target_language || draft.provider !== 'self-hosted'
    || draft.sourceKind !== 'translation' || draft.aiLabel !== 'AI translation · needs creator review'
    || !draft.source || Object.entries(source).some(([key, value]) => draft.source[key] !== value)
    || typeof draft.vtt !== 'string' || !parseWebVtt(draft.vtt, source.duration_ms).ok
    || subtitleTranslationDraftPath({ id: job.id, token: draft.leaseToken, assetId, ownerUserId: ownerId,
      sourceVersion: version, kind: job.kind, bucket: job.source_bucket, path: job.source_path, sizeBytes: Number(job.source_bytes),
      modelVersion: job.model_version, targetLanguage: job.target_language, revisionKey: job.revision_key }, consent.config_version, consent.id) !== path) {
    return fail('conflict', 'Translation draft does not match the original permission and captions.');
  }
  const latest = await authorizedState(sc, ownerId, assetId, version);
  if (JSON.stringify(latest) !== JSON.stringify(state)) return fail('conflict', 'Translation authority changed during review.');
  return { draft, snapshot, path };
}

async function remove(sc: SupabaseClient, paths: string[]) {
  try { return !(await sc.storage.from('post-media').remove(paths)).error; } catch { return false; }
}

export async function publishCaptionTranslation(sc: SupabaseClient, ownerId: string, assetId: string, version: number,
  draftId: string, expectedRevision: string, reviewed: boolean, vtt: string): Promise<CaptionTranslationPublishResponse> {
  if (reviewed !== true) return fail('invalid_payload', 'Explicit creator review and publication permission are required.');
  const ready = await readCaptionTranslationDraft(sc, ownerId, assetId, version, draftId);
  if (!ready) return fail('not_found', 'No completed translation draft.');
  const { draft, snapshot, path: draftPath } = ready;
  if (snapshot.revisionKey !== expectedRevision) return fail('conflict', 'Original captions changed. Review a current draft.');
  const source = await readCaptionAsset(sc, assetId);
  const parsed = parseWebVtt(vtt, source.duration_ms);
  if (!parsed.ok) return fail('invalid_payload', 'Valid reviewed WebVTT is required.');
  const previous = snapshot.tracks.find(track => track.language === draft.language);
  const tracks: CaptionVariant[] = [...snapshot.tracks.filter(track => track.language !== draft.language), {
    language: draft.language, sourceKind: 'translation', aiLabel: 'AI translation · creator reviewed', vtt,
    revision: (previous?.revision ?? 0) + 1, modelVersion: draft.modelVersion, sourceLanguage: draft.sourceLanguage,
  }];
  if (tracks.length > 8) return fail('invalid_payload', 'At most eight caption languages per video.');
  const revisionKey = randomBytes(32).toString('hex');
  const path = captionArtifactPath(assetId, version, revisionKey);
  const bytes = Buffer.from(JSON.stringify({ source, tracks, consent: true }));
  if (bytes.length > MAX_BYTES) return fail('invalid_payload', 'Combined captions are too large.');
  await recheckCaptionAsset(sc, ownerId, source);
  await requirePrivateCaptionStorage(sc);
  let artifact;
  try {
    artifact = await reserveTranslationArtifact(sc, { asset_id: assetId, owner_user_id: ownerId, source_version: version,
      consent_id: draft.consentId, job_id: draft.jobId, lease_token: draft.leaseToken, kind: 'publication', draft_id: draftId,
      caption_revision: expectedRevision, output_revision: revisionKey }, source);
    artifact = await uploadTranslationArtifact(sc, artifact, bytes);
  } catch { return fail('degraded_unavailable', 'Translation staging outcome is unconfirmed; cleanup needs retry.'); }
  try {
    await recheckCaptionAsset(sc, ownerId, source);
    await requirePrivateCaptionStorage(sc);
  } catch (error) {
    try { if (!(await eraseTranslationArtifact(sc, artifact))) throw new Error('unconfirmed'); }
    catch { return fail('degraded_unavailable', 'Translation was not published; staging cleanup needs retry.'); }
    throw error;
  }
  const committed = await sc.rpc('cas_media_caption_translation', { p_asset_id: assetId, p_owner_id: ownerId,
    p_source: draft.source, p_expected_revision: expectedRevision, p_revision: revisionKey, p_object_path: path,
    p_consent_id: draft.consentId, p_draft_id: draftId, p_reviewed: reviewed });
  if (committed.error) return fail('degraded_unavailable', 'Publication outcome is unknown. Refresh captions before retrying.');
  if (committed.data !== true) {
    try { if (!(await eraseTranslationArtifact(sc, artifact))) throw new Error('unconfirmed'); }
    catch { return fail('degraded_unavailable', 'Publication refused; staging cleanup needs retry.'); }
    return fail('conflict', 'Translation permission or original captions changed. Nothing was published.');
  }
  const oldPath = captionArtifactPath(assetId, version, expectedRevision);
  let cleanupPending = true;
  try {
    const draftArtifact = await readTranslationArtifact(sc, draftPath);
    const erased = draftArtifact && await eraseTranslationArtifact(sc, draftArtifact);
    const current = await readCaptionManifest(sc, assetId);
    cleanupPending = !erased || current?.object_path !== path || !(await remove(sc, [oldPath]));
  } catch { cleanupPending = true; }
  return { assetId, version, revisionKey, language: draft.language, sourceKind: 'translation',
    aiLabel: 'AI translation · creator reviewed', availableLanguages: tracks.map(track => track.language), cleanupPending };
}
