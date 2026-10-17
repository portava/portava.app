import type { SupabaseClient } from "@supabase/supabase-js";
import { generationKey, normalizeVector, sameSource, validSource, UUID, type IndexedImage, type SourceIdentity, type VisualIndexStore } from "./contracts.js";
import { VisualIndexError } from "./visualIndexError.js";

function argumentsFor(source: SourceIdentity) {
  if (!validSource(source)) throw new Error("invalid source identity");
  return { p_asset_id: source.assetId, p_source_version: source.sourceVersion, p_bucket: source.bucket, p_path: source.path };
}

function parseEntry(row: any): IndexedImage {
  const source = { assetId: row?.asset_id, sourceVersion: row?.source_version, bucket: row?.storage_bucket, path: row?.storage_path };
  const expiresAtMs = Date.parse(row?.expires_at);
  if (!validSource(source) || typeof row.model_id !== "string" || !/^[a-f0-9]{64}$/.test(row.content_sha256) || !UUID.test(row.consent_revision) || !Number.isFinite(expiresAtMs)
    || !UUID.test(row.job_id) || !UUID.test(row.lease_token)) {
    throw new Error("invalid visual index record");
  }
  return { source, modelId: row.model_id, vector: normalizeVector(typeof row.embedding === "string" ? JSON.parse(row.embedding) : row.embedding),
    contentSha256: row.content_sha256, expiresAtMs, consentRevision: row.consent_revision, publication: { jobId: row.job_id, leaseToken: row.lease_token } };
}

export class PostgresVisualIndex implements VisualIndexStore {
  constructor(private readonly sc: SupabaseClient) {}

  async commit(entry: IndexedImage, lease: { jobId: string; leaseToken: string }): Promise<void> {
    if (!UUID.test(entry.consentRevision) || !/^[a-f0-9]{64}$/.test(entry.contentSha256) || !UUID.test(lease.jobId) || !UUID.test(lease.leaseToken)) throw new Error("invalid index commit");
    const { data, error } = await this.sc.rpc("media_visual_index_commit", {
      ...argumentsFor(entry.source), p_model_id: entry.modelId, p_embedding: JSON.stringify(normalizeVector(entry.vector)),
      p_content_sha256: entry.contentSha256, p_expires_at: new Date(entry.expiresAtMs).toISOString(), p_consent_revision: entry.consentRevision,
      p_job_id: lease.jobId, p_lease_token: lease.leaseToken, p_revision_key: generationKey(entry.source, `${entry.modelId}:${entry.consentRevision}`),
    });
    if (error && ["visual_index_disabled", "visual_source_stale", "visual_consent_revoked", "visual_asset_erased", "visual_embedding_invalid", "visual_source_bytes_changed", "visual_lease_lost"].includes(error.message)) {
      throw new VisualIndexError(error.message, "visual index commit refused", error.message === "visual_lease_lost");
    }
    if (error || data?.applied !== true) throw new Error("visual index commit refused");
  }

  async seed(postId: string, modelId: string): Promise<IndexedImage[]> {
    if (!UUID.test(postId)) throw new Error("invalid post identity");
    const { data, error } = await this.sc.rpc("media_visual_index_seed", { p_post_id: postId, p_model_id: modelId });
    if (error || !Array.isArray(data) || data.length > 64) throw new Error("visual index seed unavailable");
    return data.map(parseEntry);
  }

  async nearest(vector: number[], modelId: string, limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("invalid visual limit");
    const { data, error } = await this.sc.rpc("media_visual_index_match", {
      p_model_id: modelId, p_embedding: JSON.stringify(normalizeVector(vector)), p_limit: limit,
    });
    if (error || !Array.isArray(data) || data.length > limit) throw new Error("visual index search unavailable");
    return data.map((row: any) => {
      if (typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) throw new Error("invalid cosine score");
      return { entry: parseEntry(row), score: row.score };
    });
  }

  async erase(source: SourceIdentity): Promise<void> {
    const { data, error } = await this.sc.rpc("media_visual_index_erase", argumentsFor(source));
    if (error || data?.erased !== true || data?.remaining !== 0) throw new Error("visual index erase incomplete");
  }

  async current(entries: IndexedImage[]): Promise<boolean[]> {
    if (entries.length > 61 || entries.some(entry => !validSource(entry.source))) throw new Error("invalid visual publication batch");
    if (!entries.length) return [];
    const ids = [...new Set(entries.map(entry => entry.source.assetId))];
    const { data, error } = await this.sc.from("media_visual_index_current")
      .select("asset_id,source_version,storage_bucket,storage_path,model_id,embedding,content_sha256,expires_at,consent_revision,job_id,lease_token")
      .in("asset_id", ids).limit(ids.length);
    if (error || !Array.isArray(data) || data.length > ids.length) throw new Error("visual publication state unavailable");
    const current = new Map<string, IndexedImage>();
    for (const row of data) {
      const entry = parseEntry(row);
      if (!ids.includes(entry.source.assetId) || current.has(entry.source.assetId)) throw new Error("invalid visual publication state");
      current.set(entry.source.assetId, entry);
    }
    return entries.map(entry => {
      const fresh = current.get(entry.source.assetId);
      return Boolean(fresh && entry.publication && sameSource(fresh.source, entry.source) && fresh.modelId === entry.modelId
        && fresh.consentRevision === entry.consentRevision && fresh.contentSha256 === entry.contentSha256 && fresh.expiresAtMs === entry.expiresAtMs
        && fresh.publication?.jobId === entry.publication.jobId && fresh.publication?.leaseToken === entry.publication.leaseToken
        && fresh.vector.length === entry.vector.length && fresh.vector.every((value, index) => value === entry.vector[index]));
    });
  }

  async discard(source: SourceIdentity, lease: { jobId: string; leaseToken: string }): Promise<void> {
    if (!validSource(source) || !UUID.test(lease.jobId) || !UUID.test(lease.leaseToken)) throw new Error("invalid index lease discard");
    const { data, error } = await this.sc.rpc("media_visual_index_discard", { p_asset_id: source.assetId, p_job_id: lease.jobId, p_lease_token: lease.leaseToken });
    if (error || data?.remaining !== 0) throw new Error("visual index lease discard incomplete");
  }
}

export async function eraseVisualIndexAsset(sc: SupabaseClient, source: SourceIdentity): Promise<void> {
  await new PostgresVisualIndex(sc).erase(source);
}
