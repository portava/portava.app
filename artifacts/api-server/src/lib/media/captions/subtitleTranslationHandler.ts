import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSelfHostedTranslationProvider, type TranslationProvider } from '../../translation.js';
import { createAuthorizedTranslationService } from '../../../services/platformTranslation.js';
import { MAX_VTT_BYTES, parseWebVtt, type CaptionCue } from '../vendors/mediaCaptionSource.js';
import { eraseTranslationArtifact, readTranslationArtifact, requireUploadedTranslationArtifact, reserveTranslationArtifact, settleNeverDispatchedTranslationArtifact, uploadTranslationArtifact, type TranslationArtifact } from './translationArtifactStore.js';

export interface SubtitleTranslationConsent {
  consentId: string;
  jobId: string;
  jobRevisionKey: string;
  assetId: string;
  ownerId: string;
  sourceVersion: number;
  revisionKey: string;
  sourceLanguage: string;
  targetLanguage: string;
  modelVersion: string;
  configVersion: string;
  translation: true;
  recordedAt: string;
}

export interface SubtitleCaptionSnapshot {
  assetId: string;
  sourceVersion: number;
  revisionKey: string;
  tracks: Array<{ language: string; sourceKind: 'manual' | 'asr' | 'translation'; aiLabel: string | null;
    vtt: string; revision: number; modelVersion?: string; sourceLanguage?: string }>;
}

export interface SubtitleTranslationContext {
  job: Readonly<{ id: string; token: string; assetId: string; ownerUserId: string; sourceVersion: number;
    kind: string; bucket: string; path: string; sizeBytes: number; modelVersion: string;
    targetLanguage?: string; revisionKey?: string }>;
  signal: AbortSignal;
  isCurrent(): Promise<boolean>;
}

export interface SubtitleTranslationConfig {
  enabled: boolean;
  modelVersion: string;
  configVersion: string;
  allowedPairs: ReadonlyArray<{ source: string; target: string }>;
  timeoutMs?: number;
}

export interface SubtitleTranslationDependencies {
  readConsent(job: SubtitleTranslationContext['job']): Promise<SubtitleTranslationConsent | null>;
  readCaptionSnapshot(sc: SupabaseClient, viewerId: string, assetId: string, sourceVersion: number): Promise<SubtitleCaptionSnapshot>;
  jobError(code: string, retryable: boolean): Error;
  provider?: () => TranslationProvider;
}

export interface SubtitleTranslationDraft {
  draftId: string;
  assetId: string;
  sourceVersion: number;
  source: Record<string, unknown>;
  sourceFingerprint: string;
  revisionKey: string;
  sourceTrackRevision: number;
  consentId: string;
  jobId: string;
  leaseToken: string;
  jobRevisionKey: string;
  configVersion: string;
  modelVersion: string;
  provider: 'self-hosted';
  sourceLanguage: string;
  language: string;
  sourceKind: 'translation';
  aiLabel: 'AI translation · needs creator review';
  vtt: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
const LANGUAGE = /^(?!und$|zxx$)[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const MODEL = /^[A-Za-z0-9._:/@+\-]{1,200}$/;
const SOURCE_COLUMNS = 'id, owner_user_id, storage_bucket, storage_path, media_type, duration_ms, version, deleted_at, purge_status, processing_status, moderation_status';
const MAX_DRAFT_BYTES = MAX_VTT_BYTES * 6 + 4096;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function timestamp(milliseconds: number): string {
  return `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, '0')}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(milliseconds / 1_000) % 60).padStart(2, '0')}.${String(milliseconds % 1_000).padStart(3, '0')}`;
}

export function subtitleTranslationDraftPath(job: SubtitleTranslationContext['job'], configVersion: string, consentId: string): string {
  if (!UUID.test(consentId)) throw new Error('invalid_translation_consent');
  const identity = createHash('sha256').update(JSON.stringify([
    job.id, job.token, job.assetId, job.ownerUserId, job.sourceVersion, job.bucket, job.path,
    job.modelVersion, job.targetLanguage, job.revisionKey, configVersion,
  ])).digest('hex');
  return `manual-captions/${job.assetId}/translation-v${job.sourceVersion}-${consentId}-${identity}.json`;
}

export function createSubtitleTranslationMediaJobHandler(
  sc: SupabaseClient, config: SubtitleTranslationConfig, dependencies: SubtitleTranslationDependencies,
) {
  const failure = (code: string, retryable = false) => dependencies.jobError(code, retryable);
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 120_000, 1_000), 120_000);
  const validJob = (job: SubtitleTranslationContext['job']) => {
    if (job.kind !== 'subtitle_translation' || ![job.id, job.token, job.assetId, job.ownerUserId].every(value => UUID.test(value))
      || job.bucket !== 'post-media' || !job.path || job.path.length > 2048 || job.path.startsWith('manual-captions/')
      || !Number.isSafeInteger(job.sourceVersion) || job.sourceVersion < 1 || job.sourceVersion > 2147483647
      || !Number.isSafeInteger(job.sizeBytes) || job.sizeBytes < 1 || job.sizeBytes > 100 * 1024 * 1024
      || !REVISION.test(job.revisionKey ?? '') || !LANGUAGE.test(job.targetLanguage ?? '')
      || !MODEL.test(job.modelVersion) || job.modelVersion !== config.modelVersion || !config.configVersion || config.configVersion.length > 200) {
      throw failure('invalid_subtitle_job');
    }
  };
  const remove = async (path: string) => {
    try {
      const artifact = await readTranslationArtifact(sc, path);
      if (!artifact || !(await eraseTranslationArtifact(sc, artifact))) throw failure('subtitle_cleanup_required', true);
    } catch { throw failure('subtitle_cleanup_required', true); }
  };
  return {
    kind: 'subtitle_translation' as const,
    modelVersion: config.modelVersion,
    timeoutMs,
    async handle(context: SubtitleTranslationContext): Promise<{ result: Record<string, unknown>; inputBytes: number; outputBytes: number }> {
      const { job, signal } = context;
      validJob(job);
      const started = Date.now();
      let path = '';
      let settledUpload = false;
      let reservation: TranslationArtifact | undefined;
      let dispatchStarted = false;
      const checkLease = async () => {
        if (signal.aborted) throw failure('cancelled');
        if (!config.enabled) throw failure('subtitle_disabled');
        if (Date.now() - started >= timeoutMs) throw failure('subtitle_timeout', true);
        if (!(await context.isCurrent()) || signal.aborted) throw failure('subtitle_lease_lost');
      };
      const readAuthorized = async () => {
        await checkLease();
        const consent = await dependencies.readConsent(job);
        if (!consent || consent.translation !== true || !UUID.test(consent.consentId) || consent.jobId !== job.id
          || consent.jobRevisionKey !== job.revisionKey || consent.assetId !== job.assetId || consent.ownerId !== job.ownerUserId
          || consent.sourceVersion !== job.sourceVersion || !REVISION.test(consent.revisionKey)
          || consent.modelVersion !== job.modelVersion || consent.configVersion !== config.configVersion
          || consent.targetLanguage !== job.targetLanguage || !LANGUAGE.test(consent.sourceLanguage)
          || consent.sourceLanguage.toLowerCase() === consent.targetLanguage.toLowerCase()
          || !Number.isFinite(Date.parse(consent.recordedAt))
          || !config.allowedPairs.some(pair => pair.source === consent.sourceLanguage && pair.target === consent.targetLanguage)) {
          throw failure('subtitle_consent_required');
        }
        const sourceResult = await sc.from('media_assets').select(SOURCE_COLUMNS).eq('id', job.assetId).maybeSingle();
        const source = sourceResult.data as Record<string, unknown> | null;
        if (sourceResult.error) throw failure('subtitle_source_unavailable', true);
        if (!source || source.id !== job.assetId || source.owner_user_id !== job.ownerUserId || source.version !== job.sourceVersion
          || source.storage_bucket !== job.bucket || source.storage_path !== job.path || source.media_type !== 'video'
          || source.deleted_at !== null || source.purge_status !== 'not_requested' || source.processing_status !== 'ready'
          || !['active', 'approved'].includes(String(source.moderation_status)) || typeof source.duration_ms !== 'number'
          || !Number.isSafeInteger(source.duration_ms) || source.duration_ms <= 0 || source.duration_ms > 900_000) {
          throw failure('subtitle_source_changed');
        }
        const snapshot = await dependencies.readCaptionSnapshot(sc, job.ownerUserId, job.assetId, job.sourceVersion);
        if (snapshot.assetId !== job.assetId || snapshot.sourceVersion !== job.sourceVersion || snapshot.revisionKey !== consent.revisionKey
          || !Array.isArray(snapshot.tracks) || snapshot.tracks.length > 8) throw failure('subtitle_revision_changed');
        const tracks = snapshot.tracks.filter(track => track.language === consent.sourceLanguage);
        if (tracks.length !== 1 || !Number.isSafeInteger(tracks[0]!.revision) || tracks[0]!.revision < 1) throw failure('subtitle_track_missing');
        const track = tracks[0]!;
        const parsed = parseWebVtt(track.vtt, source.duration_ms);
        if (!parsed.ok) throw failure('subtitle_track_invalid');
        const bucket = await sc.storage.getBucket('post-media');
        if (bucket.error || !bucket.data || bucket.data.public !== false
          || bucket.data.allowed_mime_types?.length && !bucket.data.allowed_mime_types.some(mime => ['application/json', 'application/*', '*/*'].includes(mime))) {
          throw failure('subtitle_storage_not_private');
        }
        await checkLease();
        return { consent, source, snapshot, track, cues: parsed.track.cues, stamp: fingerprint([consent, source, snapshot]) };
      };
      try {
        const original = await readAuthorized();
        path = subtitleTranslationDraftPath(job, config.configVersion, original.consent.consentId);
        const draftId = path.slice(path.lastIndexOf('-') + 1, -5);
        const ensureCurrent = async () => {
          const latest = await readAuthorized();
          if (latest.stamp !== original.stamp) throw failure('subtitle_authority_changed');
          return latest;
        };
        const metadata = {
          draftId, assetId: job.assetId, sourceVersion: job.sourceVersion, source: original.source,
          sourceFingerprint: original.stamp, revisionKey: original.consent.revisionKey,
          sourceTrackRevision: original.track.revision, consentId: original.consent.consentId, jobId: job.id,
          leaseToken: job.token, jobRevisionKey: job.revisionKey!, configVersion: config.configVersion,
          modelVersion: job.modelVersion, provider: 'self-hosted' as const, sourceLanguage: original.consent.sourceLanguage,
          language: job.targetLanguage!, sourceKind: 'translation' as const, aiLabel: 'AI translation · needs creator review' as const,
        };
        const validateTrack = (text: string) => {
          const parsed = parseWebVtt(text, original.source.duration_ms as number);
          if (!parsed.ok || parsed.track.cues.length !== original.cues.length
            || parsed.track.cues.some((cue, index) => cue.startMs !== original.cues[index]!.startMs || cue.endMs !== original.cues[index]!.endMs)) {
            throw failure('subtitle_output_invalid');
          }
        };
        const output = (draft: SubtitleTranslationDraft, cached: boolean) => ({
          result: { state: 'draft_ready', draftId, artifactKey: path, consentId: metadata.consentId,
            sourceVersion: job.sourceVersion, revisionKey: metadata.revisionKey, sourceLanguage: metadata.sourceLanguage,
            targetLanguage: metadata.language, modelVersion: metadata.modelVersion, cached },
          inputBytes: Buffer.byteLength(original.track.vtt), outputBytes: Buffer.byteLength(JSON.stringify(draft)),
        });
        const readCached = async () => {
          await requireUploadedTranslationArtifact(sc, path);
          const stored = await sc.storage.from('post-media').download(path);
          if (stored.error || !stored.data || stored.data.size > MAX_DRAFT_BYTES) throw failure('subtitle_draft_unavailable', true);
          const draft = JSON.parse(await stored.data.text()) as SubtitleTranslationDraft;
          if (!draft || Object.entries(metadata).some(([key, value]) => JSON.stringify(draft[key as keyof SubtitleTranslationDraft]) !== JSON.stringify(value))
            || typeof draft.vtt !== 'string') throw failure('subtitle_draft_mismatch');
          validateTrack(draft.vtt);
          await ensureCurrent();
          return output(draft, true);
        };
        const prefix = path.slice(0, path.lastIndexOf('/'));
        const filename = path.slice(path.lastIndexOf('/') + 1);
        const listed = await sc.storage.from('post-media').list(prefix, { search: filename, limit: 2 });
        if (listed.error || !listed.data) throw failure('subtitle_draft_unavailable', true);
        if (listed.data.some(entry => entry.name === filename)) return await readCached();
        const provider = (dependencies.provider ?? getSelfHostedTranslationProvider)();
        const guardedProvider: TranslationProvider = {
          detectLanguage: async () => { throw failure('subtitle_source_language_required'); },
          async translateText(text, source, target) {
            await ensureCurrent();
            const result = await provider.translateText(text, source, target);
            await ensureCurrent();
            if (result.provider !== 'self-hosted' || result.providerVersion !== job.modelVersion) throw failure('subtitle_model_changed');
            return result;
          },
        };
        const translated: CaptionCue[] = [];
        for (let offset = 0; offset < original.cues.length;) {
          const batch: Record<string, string> = {};
          let size = 0;
          const start = offset;
          while (offset < original.cues.length && offset - start < 100) {
            const cue = original.cues[offset]!;
            if (cue.text.length > 8_000) throw failure('subtitle_input_limit');
            if (size + cue.text.length > 32_000) break;
            batch[String(offset)] = cue.text;
            size += cue.text.length;
            offset++;
          }
          const service = createAuthorizedTranslationService({
            provider: () => guardedProvider, enabled: () => config.enabled && !signal.aborted,
            async loadAuthorizedSubject() {
              await ensureCurrent();
              return { revision: original.consent.revisionKey, protection: 'server-readable', sourceLanguage: original.consent.sourceLanguage,
                fields: batch, preferences: { enabled: true, targetLanguage: job.targetLanguage } };
            },
          });
          const result = await service.translate({ viewerId: job.ownerUserId, subjectId: `${job.id}:${start}`, targetLanguage: job.targetLanguage! });
          service.clear();
          if (result.status !== 'translated') throw failure('subtitle_translation_unavailable', result.status === 'unavailable');
          if (result.sourceRevision !== original.consent.revisionKey || result.provider !== 'self-hosted' || result.providerVersion !== job.modelVersion) throw failure('subtitle_model_changed');
          for (let index = start; index < offset; index++) {
            const text = result.fields[String(index)];
            if (typeof text !== 'string' || !text.trim()) throw failure('subtitle_output_invalid');
            translated.push({ ...original.cues[index]!, text });
          }
        }
        const vtt = `WEBVTT\n\n${translated.map(cue => `${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${cue.text}`).join('\n\n')}\n`;
        validateTrack(vtt);
        const draft: SubtitleTranslationDraft = { ...metadata, vtt };
        const encoded = Buffer.from(JSON.stringify(draft));
        if (encoded.length > MAX_DRAFT_BYTES) throw failure('subtitle_output_limit');
        await ensureCurrent();
        reservation = await reserveTranslationArtifact(sc, { asset_id: job.assetId, owner_user_id: job.ownerUserId,
          source_version: job.sourceVersion, consent_id: original.consent.consentId, job_id: job.id, lease_token: job.token,
          kind: 'draft', draft_id: draftId, caption_revision: original.consent.revisionKey, output_revision: draftId }, original.source);
        await ensureCurrent();
        dispatchStarted = true;
        await uploadTranslationArtifact(sc, reservation, encoded);
        settledUpload = true;
        await ensureCurrent();
        return output(draft, false);
      } catch (error) {
        if (reservation && !dispatchStarted) {
          try { await settleNeverDispatchedTranslationArtifact(sc, reservation); } catch {}
        }
        if (settledUpload) await remove(path);
        const code = (error as { code?: unknown })?.code;
        if (typeof code === 'string' && /^(subtitle_[a-z_]+|cancelled)$/.test(code)) throw error;
        throw failure(signal.aborted ? 'cancelled' : 'subtitle_processing_failed', !signal.aborted);
      }
    },
    async discard(context: SubtitleTranslationContext, output: { result: Record<string, unknown> }) {
      validJob(context.job);
      const path = subtitleTranslationDraftPath(context.job, config.configVersion, String(output.result.consentId));
      if (output.result.artifactKey !== path || output.result.draftId !== path.slice(path.lastIndexOf('-') + 1, -5)) {
        throw failure('foreign_subtitle_artifact');
      }
      await remove(path);
    },
  };
}
