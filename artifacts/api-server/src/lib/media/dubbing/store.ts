import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaJobContext } from "../jobs/worker.js";
import { DUBBING_DISCLOSURE_VERSION, DubbingError, checkCancelled, dubbingConsentStateSchema, validateDubbingInput, type TimedDubbingInput } from "./contracts.js";
import type { DubbingManifest } from "./render.js";
import { decodeWave } from "./wav.js";

export type TranslatedDubbingSource = Omit<TimedDubbingInput, "optedIn" | "disclosureVersion" | "consentRevision" | "requestedBy">;
export interface DubbingSourceAccess {
  loadTranslatedSource(assetId: string, ownerId: string, language: string): Promise<TranslatedDubbingSource>;
  canRead(assetId: string, viewerId: string): Promise<boolean>;
}

// Top-level (not a closure) so every RPC name sent here is a string literal at
// a same-file call site — the shape the §29 conversation→Memory boundary scan
// (src/domain/telegraph/policies/conversationMemoryBoundary.ts, rpcNameCandidates)
// resolves. A closure wrapper is unresolvable there and fails closed as a
// possible memory-creating RPC.
async function dubbingRpc(client: SupabaseClient, name: string, parameters: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw new DubbingError("storage_unavailable");
  return data;
}

export function createDubbingStore(client: SupabaseClient, bucketName: string | undefined, access: DubbingSourceAccess) {
  if (bucketName !== undefined && (!/^[a-z][a-z0-9-]{2,62}$/.test(bucketName) || bucketName === "post-media")) throw new DubbingError("not_configured");
  const bucket = bucketName ? client.storage.from(bucketName) : undefined;
  async function privateBucket() {
    if (!bucketName || !bucket) throw new DubbingError("storage_unavailable");
    const { data, error } = await client.storage.getBucket(bucketName);
    if (error || !data || data.public !== false) throw new DubbingError("storage_unavailable");
    return bucket;
  }
  async function consent(assetId: string, language: string) {
    const { data, error } = await client.from("media_dubbing_consents").select("owner_user_id,consent_revision,opted_in,source_version,caption_revision,translation_revision,disclosure_version").eq("asset_id", assetId).eq("target_language", language).maybeSingle();
    if (error) throw new DubbingError("storage_unavailable");
    if (!data || data.opted_in !== true || data.disclosure_version !== DUBBING_DISCLOSURE_VERSION) throw new DubbingError("source_revoked");
    return data;
  }
  async function load(assetId: string, ownerId: string, language: string): Promise<TimedDubbingInput> {
    const receipt = await consent(assetId, language);
    if (receipt.owner_user_id !== ownerId) throw new DubbingError("source_revoked");
    const source = await access.loadTranslatedSource(assetId, ownerId, language);
    if (source.assetId !== assetId || source.ownerId !== ownerId || source.targetLanguage !== language || source.sourceVersion !== receipt.source_version || source.captionRevision !== receipt.caption_revision || source.translationRevision !== receipt.translation_revision) throw new DubbingError("source_revoked");
    return validateDubbingInput({ ...source, requestedBy: ownerId, consentRevision: receipt.consent_revision, optedIn: true, disclosureVersion: DUBBING_DISCLOSURE_VERSION });
  }
  async function assertCurrent(input: TimedDubbingInput) {
    const current = await load(input.assetId, input.ownerId, input.targetLanguage);
    if (JSON.stringify(current) !== JSON.stringify(validateDubbingInput(input))) throw new DubbingError("source_revoked");
    const valid = await dubbingRpc(client, "media_dubbing_current", { p_asset: input.assetId, p_owner: input.ownerId, p_source: input.sourceVersion, p_language: input.targetLanguage, p_caption: input.captionRevision, p_translation: input.translationRevision, p_consent: input.consentRevision });
    if (valid !== true) throw new DubbingError("source_revoked");
  }
  async function erase(id: string, fence: { p_owner: string | null; p_job: string | null; p_token: string | null }) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new DubbingError("integrity_failed");
    try {
      const parameters = { p_id: id, ...fence };
      const artifact = await dubbingRpc(client, "media_dubbing_retire", parameters);
      if (!artifact) return;
      if (artifact.id !== id || artifact.storage_path !== `synthetic-dubbing/${id}.wav` || artifact.storage_bucket !== bucketName || !bucket) throw new DubbingError("cleanup_failed");
      if (artifact.write_state !== "uploaded" && artifact.write_state !== "aborted") throw new DubbingError("cleanup_failed");
      const removal = await bucket.remove([artifact.storage_path]);
      if (removal.error) throw new DubbingError("cleanup_failed");
      if (await dubbingRpc(client, "media_dubbing_forget", parameters) !== true) throw new DubbingError("cleanup_failed");
    } catch { throw new DubbingError("cleanup_failed"); }
  }
  async function assertReadable(input: { assetId: string; viewerId: string; manifest: DubbingManifest }) {
    if (!await access.canRead(input.assetId, input.viewerId)) throw new DubbingError("source_revoked");
    const receipt = await consent(input.assetId, input.manifest.language);
    const current = await load(input.assetId, receipt.owner_user_id, input.manifest.language);
    if (current.sourceVersion !== input.manifest.sourceVersion || current.captionRevision !== input.manifest.captionRevision || current.translationRevision !== input.manifest.translationRevision || current.consentRevision !== input.manifest.consentRevision) throw new DubbingError("source_revoked");
    await assertCurrent(current);
    const published = await client.from("media_dubbing_readable").select("id").eq("asset_id", input.assetId).eq("manifest->>revisionKey", input.manifest.revisionKey).eq("manifest->>sha256", input.manifest.sha256).limit(1).maybeSingle();
    if (published.error) throw new DubbingError("storage_unavailable");
    if (!published.data) throw new DubbingError("source_revoked");
    if (!await access.canRead(input.assetId, input.viewerId)) throw new DubbingError("source_revoked");
  }
  async function eraseOwned(ownerId: string, assetId?: string): Promise<number> {
    let query = client.from("media_dubbing_artifacts").select("id").eq("owner_user_id", ownerId).limit(100);
    if (assetId) query = query.eq("asset_id", assetId);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new DubbingError("cleanup_failed");
    let failed = false;
    for (const row of data) {
      try { await erase(row.id, { p_owner: ownerId, p_job: null, p_token: null }); }
      catch { failed = true; }
    }
    if (failed) throw new DubbingError("cleanup_failed");
    return data.length;
  }
  return {
    assertCurrent, assertReadable, eraseOwned,
    async consentState(input: { assetId: string; actorId: string; targetLanguage: string }) {
      const result = await dubbingRpc(client, "media_dubbing_consent_state", { p_asset: input.assetId, p_owner: input.actorId, p_language: input.targetLanguage });
      if (result === null) throw new DubbingError("consent_required");
      const state = dubbingConsentStateSchema.safeParse(result);
      if (!state.success) throw new DubbingError("storage_unavailable");
      return state.data;
    },
    async grantAndLoad(input: { assetId: string; actorId: string; targetLanguage: string; disclosureVersion: typeof DUBBING_DISCLOSURE_VERSION; expectedConsentRevision: string }) {
      const source = await access.loadTranslatedSource(input.assetId, input.actorId, input.targetLanguage);
      if (source.assetId !== input.assetId || source.ownerId !== input.actorId || source.targetLanguage !== input.targetLanguage) throw new DubbingError("consent_required");
      validateDubbingInput({ ...source, requestedBy: input.actorId, consentRevision: "0".repeat(64), optedIn: true, disclosureVersion: input.disclosureVersion });
      const receipt = await dubbingRpc(client, "media_dubbing_grant", { p_asset: input.assetId, p_owner: input.actorId, p_source: source.sourceVersion, p_language: input.targetLanguage, p_caption: source.captionRevision, p_translation: source.translationRevision, p_opt_in: true, p_disclosure: input.disclosureVersion, p_expected: input.expectedConsentRevision });
      if (typeof receipt !== "string" || !/^[a-f0-9]{64}$/.test(receipt)) throw new DubbingError("source_revoked");
      const value = await load(input.assetId, input.actorId, input.targetLanguage);
      if (value.consentRevision !== receipt) throw new DubbingError("source_revoked");
      await assertCurrent(value);
      return value;
    },
    async loadInput(context: MediaJobContext) {
      return load(context.job.assetId, context.job.ownerUserId, context.job.targetLanguage ?? "");
    },
    async stage(context: MediaJobContext, audio: Buffer, manifest: DubbingManifest) {
      checkCancelled(context.signal);
      const destination = await privateBucket();
      const decoded = decodeWave(audio);
      if (manifest.sha256 !== createHash("sha256").update(audio).digest("hex") || manifest.bytes !== audio.length || manifest.durationMs !== decoded.samples.length / 2 / decoded.sampleRate * 1000) throw new DubbingError("integrity_failed");
      const id = randomUUID();
      const storagePath = `synthetic-dubbing/${id}.wav`;
      const lease = { p_job: context.job.id, p_token: context.job.token, p_id: id };
      let reserved = false;
      let uploadStarted = false;
      try {
        const stored = await dubbingRpc(client, "media_dubbing_stage", { ...lease, p_manifest: manifest, p_bucket: bucketName });
        if (stored !== true) throw new DubbingError("source_revoked");
        reserved = true;
        checkCancelled(context.signal);
        uploadStarted = true;
        const answer = await destination.upload(storagePath, audio, { contentType: "audio/wav", cacheControl: "0", upsert: false });
        if (answer.error) throw new DubbingError("storage_unavailable");
        if (await dubbingRpc(client, "media_dubbing_settle", { ...lease, p_uploaded: true }) !== true) throw new DubbingError("cleanup_failed");
        checkCancelled(context.signal);
        return { artifactId: id };
      } catch (error) {
        if (reserved && !uploadStarted) {
          try { await dubbingRpc(client, "media_dubbing_settle", { ...lease, p_uploaded: false }); } catch {}
        }
        await erase(id, { p_owner: null, p_job: context.job.id, p_token: context.job.token });
        throw error;
      }
    },
    async remove(context: MediaJobContext, id: string) {
      await erase(id, { p_owner: null, p_job: context.job.id, p_token: context.job.token });
    },
    async revoke(input: { assetId: string; actorId: string }) {
      if (await dubbingRpc(client, "media_dubbing_revoke", { p_asset: input.assetId, p_owner: input.actorId }) !== true) throw new DubbingError("consent_required");
      if (await eraseOwned(input.actorId, input.assetId) === 100) throw new DubbingError("cleanup_failed");
    },
    async read(input: { assetId: string; viewerId: string; targetLanguage: string }) {
      if (!await access.canRead(input.assetId, input.viewerId)) return null;
      const { data, error } = await client.from("media_dubbing_readable").select("id,storage_bucket,storage_path,manifest").eq("asset_id", input.assetId).eq("manifest->>language", input.targetLanguage).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new DubbingError("storage_unavailable");
      if (!data) return null;
      if (data.storage_path !== `synthetic-dubbing/${data.id}.wav` || data.storage_bucket !== bucketName) throw new DubbingError("integrity_failed");
      const manifest = data.manifest as DubbingManifest;
      await assertReadable({ ...input, manifest });
      const destination = await privateBucket();
      const download = await destination.download(data.storage_path);
      if (download.error || !download.data || download.data.size > 14_400_044) throw new DubbingError("storage_unavailable");
      const audio = Buffer.from(await download.data.arrayBuffer());
      await assertReadable({ ...input, manifest });
      return { audio, manifest };
    },
  };
}
