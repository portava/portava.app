import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withMediaCleanup } from '../../../services/media/MediaCleanupTransport.js';

export interface TranslationArtifactIntent {
  asset_id: string;
  owner_user_id: string;
  source_version: number;
  consent_id: string;
  job_id: string;
  lease_token: string;
  kind: 'draft' | 'publication';
  draft_id: string;
  caption_revision: string;
  output_revision: string;
}

export interface TranslationArtifact {
  id: string;
  write_token: string;
  asset_id: string;
  owner_user_id: string;
  source_version: number;
  kind: TranslationArtifactIntent['kind'];
  storage_bucket: 'post-media';
  storage_path: string;
  intent: TranslationArtifactIntent;
  write_state: 'reserved' | 'dispatched' | 'uploaded' | 'never_dispatched';
  write_settled_at: string | null;
  cleanup_requested: boolean;
  source_deleted: boolean;
  retirement_token: string | null;
  created_at: string;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const validTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const failure = () => new Error('Translation retained output state unavailable; cleanup needs retry');

export function translationArtifactPath(intent: TranslationArtifactIntent): string {
  return `manual-captions/${intent.asset_id}/${intent.kind === 'draft'
    ? `translation-v${intent.source_version}-${intent.consent_id}-${intent.draft_id}`
    : `v${intent.source_version}-${intent.output_revision}`}.json`;
}

export function decodeTranslationArtifact(value: unknown): TranslationArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
  const row = value as Record<string, unknown>;
  if (!row.intent || typeof row.intent !== 'object' || Array.isArray(row.intent)) throw failure();
  const intent = row.intent as Record<string, unknown>;
  for (const field of ['id', 'write_token', 'asset_id', 'owner_user_id']) {
    if (typeof row[field] !== 'string' || !UUID.test(row[field])) throw failure();
  }
  for (const field of ['asset_id', 'owner_user_id', 'consent_id', 'job_id', 'lease_token']) {
    if (typeof intent[field] !== 'string' || !UUID.test(intent[field])) throw failure();
  }
  for (const field of ['draft_id', 'caption_revision', 'output_revision']) {
    if (typeof intent[field] !== 'string' || !HASH.test(intent[field])) throw failure();
  }
  if (!Number.isSafeInteger(row.source_version) || Number(row.source_version) < 1 || Number(row.source_version) > 2147483647
    || !['draft', 'publication'].includes(String(row.kind)) || intent.kind !== row.kind
    || intent.asset_id !== row.asset_id || intent.owner_user_id !== row.owner_user_id || intent.source_version !== row.source_version
    || Object.keys(intent).length !== 10 || (row.kind === 'draft' && intent.output_revision !== intent.draft_id)
    || row.storage_bucket !== 'post-media' || row.storage_path !== translationArtifactPath(intent as unknown as TranslationArtifactIntent)
    || !['reserved', 'dispatched', 'uploaded', 'never_dispatched'].includes(String(row.write_state))
    || typeof row.cleanup_requested !== 'boolean' || typeof row.source_deleted !== 'boolean' || !validTime(row.created_at)
    || row.source_deleted === true && row.cleanup_requested !== true
    || (row.retirement_token !== null && (typeof row.retirement_token !== 'string' || !UUID.test(row.retirement_token)))) throw failure();
  const settled = row.write_state === 'uploaded' || row.write_state === 'never_dispatched';
  if (settled ? !validTime(row.write_settled_at) : row.write_settled_at !== null) throw failure();
  if (row.retirement_token !== null && (!settled || row.cleanup_requested !== true)) throw failure();
  return value as TranslationArtifact;
}

function sameIdentity(left: TranslationArtifact, right: TranslationArtifact): boolean {
  return (['id', 'write_token', 'asset_id', 'owner_user_id', 'source_version', 'kind', 'storage_bucket', 'storage_path', 'created_at'] as const)
    .every(key => left[key] === right[key]) && Object.entries(left.intent).every(([key, value]) => right.intent[key as keyof TranslationArtifactIntent] === value);
}

export async function reserveTranslationArtifact(client: SupabaseClient, intent: TranslationArtifactIntent, source: object): Promise<TranslationArtifact> {
  return withMediaCleanup(client, async sc => {
    const id = randomUUID(), token = randomUUID();
    const result = await sc.rpc('media_caption_translation_artifact_reserve', { p_id: id, p_token: token, p_intent: intent, p_source: source });
    if (result.error) throw failure();
    const receipt = decodeTranslationArtifact(result.data);
    if (receipt.id !== id || receipt.write_token !== token || receipt.write_state !== 'reserved' || receipt.cleanup_requested || receipt.retirement_token
      || Object.entries(intent).some(([key, value]) => receipt.intent[key as keyof TranslationArtifactIntent] !== value)) throw failure();
    return receipt;
  });
}

export async function uploadTranslationArtifact(client: SupabaseClient, artifact: TranslationArtifact, bytes: Buffer): Promise<TranslationArtifact> {
  return withMediaCleanup(client, async sc => {
    const dispatched = await sc.rpc('media_caption_translation_artifact_dispatch', { p_id: artifact.id, p_token: artifact.write_token });
    if (dispatched.error) throw failure();
    if (dispatched.data === null) {
      await settleNeverDispatchedTranslationArtifact(sc, artifact);
      throw failure();
    }
    const capability = decodeTranslationArtifact(dispatched.data);
    if (!sameIdentity(artifact, capability) || capability.write_state !== 'dispatched' || capability.cleanup_requested || capability.retirement_token) throw failure();
    const uploaded = await sc.storage.from('post-media').upload(artifact.storage_path, bytes, { contentType: 'application/json', upsert: false, cacheControl: '0' });
    if (uploaded.error || uploaded.data?.path !== artifact.storage_path || typeof uploaded.data.id !== 'string'
      || !UUID.test(uploaded.data.id) || uploaded.data.fullPath !== `${artifact.storage_bucket}/${artifact.storage_path}`) throw failure();
    const result = await sc.rpc('media_caption_translation_artifact_settle', { p_id: artifact.id, p_token: artifact.write_token, p_state: 'uploaded' });
    if (result.error) throw failure();
    const settled = decodeTranslationArtifact(result.data);
    if (!sameIdentity(artifact, settled) || settled.write_state !== 'uploaded') throw failure();
    return settled;
  });
}

export async function settleNeverDispatchedTranslationArtifact(client: SupabaseClient, artifact: TranslationArtifact): Promise<TranslationArtifact> {
  return withMediaCleanup(client, async sc => {
    const result = await sc.rpc('media_caption_translation_artifact_settle', { p_id: artifact.id, p_token: artifact.write_token, p_state: 'never_dispatched' });
    if (result.error) throw failure();
    const settled = decodeTranslationArtifact(result.data);
    if (!sameIdentity(artifact, settled) || settled.write_state !== 'never_dispatched') throw failure();
    return settled;
  });
}

export async function readTranslationArtifact(client: SupabaseClient, path: string): Promise<TranslationArtifact | null> {
  return withMediaCleanup(client, async sc => {
    const result = await sc.from('media_caption_translation_artifacts').select('*').eq('storage_path', path).maybeSingle();
    if (result.error || result.data === undefined) throw failure();
    if (result.data === null) return null;
    const artifact = decodeTranslationArtifact(result.data);
    if (artifact.storage_path !== path) throw failure();
    return artifact;
  });
}

export async function requireUploadedTranslationArtifact(client: SupabaseClient, path: string): Promise<TranslationArtifact> {
  const artifact = await readTranslationArtifact(client, path);
  if (!artifact || artifact.write_state !== 'uploaded' || artifact.cleanup_requested || artifact.retirement_token) throw failure();
  return artifact;
}

export async function eraseTranslationArtifact(client: SupabaseClient, artifact: TranslationArtifact): Promise<boolean> {
  decodeTranslationArtifact(artifact);
  if (artifact.write_state === 'reserved' || artifact.write_state === 'dispatched') return false;
  return withMediaCleanup(client, async sc => {
    const result = await sc.rpc('media_caption_translation_artifact_retire', { p_expected: artifact });
    if (result.error || result.data === undefined) throw failure();
    if (result.data === null) return false;
    const receipt = decodeTranslationArtifact(result.data);
    if (!sameIdentity(artifact, receipt) || !receipt.cleanup_requested || !receipt.retirement_token
      || receipt.write_state !== artifact.write_state || receipt.write_settled_at !== artifact.write_settled_at
      || receipt.source_deleted !== artifact.source_deleted || !['uploaded', 'never_dispatched'].includes(receipt.write_state)) throw failure();
    const bucket = await sc.storage.getBucket(receipt.storage_bucket);
    if (bucket.error || bucket.data?.id !== receipt.storage_bucket || bucket.data.public !== false) throw failure();
    if (receipt.write_state === 'uploaded') {
      const removed = await sc.storage.from(receipt.storage_bucket).remove([receipt.storage_path]);
      if (removed.error) throw failure();
    }
    const forgotten = await sc.rpc('media_caption_translation_artifact_forget', { p_receipt: receipt });
    if (forgotten.error || forgotten.data !== true) throw failure();
    const remaining = await sc.from('media_caption_translation_artifacts').select('id').eq('id', receipt.id).maybeSingle();
    if (remaining.error || remaining.data !== null) throw failure();
    return true;
  });
}
