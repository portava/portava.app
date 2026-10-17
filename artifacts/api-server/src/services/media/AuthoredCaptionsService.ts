import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeMediaAccess } from "../../lib/mediaAccess.js";
import { appStorageUrlInfo, configuredStorageOrigin } from "../../lib/mediaUrl.js";
import { randomBytes } from "node:crypto";
import { parseWebVtt, MAX_VTT_BYTES } from "../../lib/media/vendors/mediaCaptionSource.js";
import type { ApiErrorCode } from "../../lib/http.js";

const ASSET_COLUMNS = "id, owner_user_id, storage_bucket, storage_path, media_type, duration_ms, version, deleted_at, purge_status, processing_status, moderation_status";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ARTIFACT_BYTES = MAX_VTT_BYTES * 6 + 4096;

export class CaptionError extends Error {
  constructor(public code: ApiErrorCode, message: string) { super(message); }
}

export interface CaptionAsset {
  id: string;
  owner_user_id: string;
  storage_bucket: string;
  storage_path: string;
  media_type: string;
  duration_ms: number;
  version: number;
  deleted_at: string | null;
  purge_status: string;
  processing_status: string;
  moderation_status: string;
}

export interface CaptionVariant {
  language: string;
  sourceKind: "manual" | "asr" | "translation";
  aiLabel: string | null;
  vtt: string;
  revision: number;
  modelVersion?: string;
  sourceLanguage?: string;
}

export const EMPTY_CAPTION_REVISION = "0".repeat(64);

export interface CaptionSnapshot {
  assetId: string;
  sourceVersion: number;
  revisionKey: string;
  tracks: CaptionVariant[];
}

export async function requirePrivateCaptionStorage(sc: SupabaseClient): Promise<void> {
  const { data, error } = await sc.storage.getBucket("post-media");
  if (error || !data || data.public !== false) throw new CaptionError("degraded_unavailable", "Private caption storage could not be verified.");
  if (data.allowed_mime_types?.length && !data.allowed_mime_types.some((mime) => ["application/json", "application/*", "*/*"].includes(mime))) throw new CaptionError("degraded_unavailable", "Caption artifact storage is not configured.");
}

interface CaptionManifest {
  asset_id: string;
  source_version: number;
  revision_key: string;
  object_path: string | null;
}

export async function readCaptionManifest(sc: SupabaseClient, assetId: string): Promise<CaptionManifest | null> {
  const { data, error } = await sc.from("media_caption_manifests").select("asset_id, source_version, revision_key, object_path").eq("asset_id", assetId).maybeSingle();
  if (error) throw new CaptionError("degraded_unavailable", "Caption state could not be verified.");
  if (data && (!/^[a-f0-9]{64}$/.test(data.revision_key) || (data.object_path !== null && data.object_path !== captionArtifactPath(assetId, data.source_version, data.revision_key)))) throw new CaptionError("conflict", "Invalid caption state.");
  return data;
}

export function captionLanguage(language: string): string {
  if (!/^(?:und|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(language) || language.length > 35) throw new CaptionError("invalid_payload", "Use a valid caption language code.");
  return language;
}

export function captionArtifactPath(assetId: string, version: number, revisionKey = EMPTY_CAPTION_REVISION): string {
  if (!UUID.test(assetId) || !Number.isSafeInteger(version) || version < 1 || version > 2147483647 || !/^[a-f0-9]{64}$/.test(revisionKey)) {
    throw new CaptionError("invalid_payload", "Invalid caption generation.");
  }
  return `manual-captions/${assetId}/v${version}-${revisionKey}.json`;
}

function sourceRef(source: string) {
  let normalized = source;
  try {
    const url = new URL(source);
    if (url.origin === configuredStorageOrigin()) {
      normalized = `${url.origin}${url.pathname.replace(/^\/storage\/v1\/object\/sign\//, "/storage/v1/object/public/")}`;
    }
  } catch {}
  const reference = appStorageUrlInfo(normalized);
  if (!reference || reference.bucket !== "post-media" || /[\\\x00-\x1f?#]/.test(reference.path) || reference.path.startsWith("manual-captions/")) {
    throw new CaptionError("invalid_payload", "Use the original app video reference.");
  }
  return reference;
}

export async function readCaptionAsset(sc: SupabaseClient, assetId: string): Promise<CaptionAsset> {
  if (!UUID.test(assetId)) throw new CaptionError("invalid_payload", "Invalid video.");
  const { data, error } = await sc.from("media_assets").select(ASSET_COLUMNS).eq("id", assetId).maybeSingle();
  if (error) throw new CaptionError("degraded_unavailable", "Video state could not be verified.");
  if (!data) throw new CaptionError("not_found", "Video unavailable.");
  return data as CaptionAsset;
}

function liveVideo(asset: CaptionAsset): void {
  if (asset.deleted_at !== null || asset.purge_status !== "not_requested" || asset.processing_status !== "ready" || !["active", "approved"].includes(asset.moderation_status)) {
    throw new CaptionError("not_found", "Video unavailable.");
  }
  if (asset.media_type !== "video" || asset.storage_bucket !== "post-media" || !asset.storage_path || !UUID.test(asset.owner_user_id) || !Number.isSafeInteger(asset.duration_ms) || asset.duration_ms <= 0 || asset.duration_ms > 2147483647) {
    throw new CaptionError("conflict", "A ready video with measured duration is required.");
  }
  captionArtifactPath(asset.id, asset.version);
}

function sameAsset(actual: CaptionAsset, expected: CaptionAsset): boolean {
  return ASSET_COLUMNS.split(", ").every((column) => actual[column as keyof CaptionAsset] === expected[column as keyof CaptionAsset]);
}

async function captionContext(sc: SupabaseClient, asset: CaptionAsset): Promise<void> {
  const { data: attachments, error: attachmentError } = await sc.from("media_attachments").select("entity_type, entity_id").eq("media_asset_id", asset.id).limit(51);
  if (attachmentError || !attachments || attachments.length >= 51 || attachments.some((entry) => entry.entity_type !== "post")) throw new CaptionError("not_found", "Captions currently support post videos only, not encrypted or other private contexts.");
  const { data: media, error: mediaError } = await sc.from("post_media").select("post_id, processing_status, moderation_status").eq("storage_path", asset.storage_path).limit(51);
  if (mediaError || !media || media.length >= 51 || media.some((entry) => entry.processing_status !== "ready" || !["approved", "active"].includes(entry.moderation_status))) throw new CaptionError("not_found", "Video attachment unavailable.");
  const ids = [...new Set([...attachments.map((entry) => entry.entity_id), ...media.map((entry) => entry.post_id)])];
  if (!ids.length) throw new CaptionError("not_found", "Attach this video to a post before adding captions.");
  const { data: posts, error: postError } = await sc.from("posts").select("id, author_id, status, post_status").in("id", ids);
  if (postError || !posts || posts.length !== ids.length || posts.some((post) => post.author_id !== asset.owner_user_id || post.status !== "active" || !["published", "draft"].includes(post.post_status))) throw new CaptionError("not_found", "Video post unavailable.");
}

async function authorizedAsset(sc: SupabaseClient, viewerId: string, assetId: string, version?: number): Promise<CaptionAsset> {
  const asset = await readCaptionAsset(sc, assetId);
  liveVideo(asset);
  await captionContext(sc, asset);
  if (version !== undefined && asset.version !== version) throw new CaptionError("conflict", "The video changed. Reload before using captions.");
  if (!(await authorizeMediaAccess(sc, viewerId, asset.storage_bucket, asset.storage_path))) {
    throw new CaptionError("not_found", "Video unavailable.");
  }
  return asset;
}

export async function recheckCaptionAsset(sc: SupabaseClient, viewerId: string, expected: CaptionAsset): Promise<void> {
  const snapshot = await readCaptionAsset(sc, expected.id);
  liveVideo(snapshot);
  if (!sameAsset(snapshot, expected)) throw new CaptionError("conflict", "The video changed. Reload before using captions.");
  const current = await authorizedAsset(sc, viewerId, expected.id, expected.version);
  if (!sameAsset(current, expected)) throw new CaptionError("conflict", "The video changed. Reload before using captions.");
}

export async function resolveCaptionSource(sc: SupabaseClient, viewerId: string, source: string) {
  const reference = sourceRef(source);
  const { data, error } = await sc.from("media_assets").select("id").eq("storage_bucket", reference.bucket).eq("storage_path", reference.path).maybeSingle();
  if (error) throw new CaptionError("degraded_unavailable", "Video state could not be verified.");
  if (!data) throw new CaptionError("not_found", "Video unavailable.");
  const asset = await authorizedAsset(sc, viewerId, data.id);
  if (asset.storage_path !== reference.path || asset.storage_bucket !== reference.bucket) throw new CaptionError("conflict", "Video changed.");
  await recheckCaptionAsset(sc, viewerId, asset);
  const manifest = await readCaptionManifest(sc, asset.id);
  return { assetId: asset.id, version: asset.version, revisionKey: manifest?.revision_key ?? EMPTY_CAPTION_REVISION, durationMs: asset.duration_ms, canEdit: viewerId === asset.owner_user_id };
}

export async function readAuthoredCaptions(sc: SupabaseClient, viewerId: string, assetId: string, version: number, language?: string) {
  if (language !== undefined) captionLanguage(language);
  const asset = await authorizedAsset(sc, viewerId, assetId, version);
  const { tracks, revisionKey } = await readVariants(sc, viewerId, asset);
  const original = tracks.find((track) => track.sourceKind !== "translation");
  const selected = (language ? tracks.find((track) => track.language === language) : undefined) ?? original;
  const parsed = selected ? parseWebVtt(selected.vtt, asset.duration_ms) : null;
  if (parsed && !parsed.ok) throw new CaptionError("invalid_payload", "Invalid caption track.");
  return { assetId, version, revisionKey, cues: parsed?.ok ? parsed.track.cues : [], vtt: asset.owner_user_id === viewerId ? selected?.vtt ?? null : null, language: selected?.language ?? "und", sourceKind: selected?.sourceKind ?? "manual", aiLabel: selected?.aiLabel ?? null, availableLanguages: tracks.map((track) => track.language) };
}

async function readVariants(sc: SupabaseClient, viewerId: string, asset: CaptionAsset): Promise<{ tracks: CaptionVariant[]; revisionKey: string }> {
  const manifest = await readCaptionManifest(sc, asset.id);
  const revisionKey = manifest?.revision_key ?? EMPTY_CAPTION_REVISION;
  if (!manifest?.object_path || manifest.source_version !== asset.version) {
    await recheckCaptionAsset(sc, viewerId, asset);
    return { tracks: [], revisionKey };
  }
  await requirePrivateCaptionStorage(sc);
  const { data, error } = await sc.storage.from("post-media").download(manifest.object_path);
  if (error || !data) throw new CaptionError("degraded_unavailable", "Captions could not be loaded.");
  let document: { source?: CaptionAsset; tracks?: CaptionVariant[]; consent?: unknown; deleted?: unknown } | null = null;
  if (data) {
    if (data.size > MAX_ARTIFACT_BYTES) throw new CaptionError("invalid_payload", "Invalid caption track.");
    try { document = JSON.parse(await data.text()); } catch { throw new CaptionError("invalid_payload", "Invalid caption track."); }
  }
  await recheckCaptionAsset(sc, viewerId, asset);
  const current = await readCaptionManifest(sc, asset.id);
  if (current?.revision_key !== revisionKey || current.object_path !== manifest.object_path) throw new CaptionError("conflict", "Captions changed. Reload before continuing.");
  if (!document) throw new CaptionError("invalid_payload", "Invalid caption track.");
  if (!document.source || !sameAsset(document.source, asset)) {
    throw new CaptionError("conflict", "Captions do not belong to this video generation.");
  }
  if (document.consent !== true || !Array.isArray(document.tracks) || document.tracks.length > 8) throw new CaptionError("invalid_payload", "Invalid caption track.");
  const languages = new Set<string>();
  for (const track of document.tracks) {
    if (!track || typeof track.vtt !== "string" || !["manual", "asr", "translation"].includes(track.sourceKind) || !Number.isSafeInteger(track.revision) || track.revision < 1 || (track.sourceKind !== "manual" && typeof track.aiLabel !== "string")) throw new CaptionError("invalid_payload", "Invalid caption track.");
    captionLanguage(track.language);
    if (languages.has(track.language) || !parseWebVtt(track.vtt, asset.duration_ms).ok) throw new CaptionError("invalid_payload", "Invalid caption track.");
    languages.add(track.language);
  }
  return { tracks: document.tracks, revisionKey };
}

export async function readCaptionSnapshot(sc: SupabaseClient, viewerId: string, assetId: string, sourceVersion: number): Promise<CaptionSnapshot> {
  const asset = await authorizedAsset(sc, viewerId, assetId, sourceVersion);
  return { assetId, sourceVersion, ...await readVariants(sc, viewerId, asset) };
}

export async function publishCaptionVariant(sc: SupabaseClient, ownerId: string, snapshot: CaptionSnapshot, variant: Omit<CaptionVariant, "revision" | "aiLabel">, consent: boolean) {
  return writeAuthoredCaptions(sc, ownerId, snapshot.assetId, snapshot.sourceVersion, variant.vtt, consent, variant.language,
    variant.sourceKind === "manual" ? undefined : { sourceKind: variant.sourceKind, modelVersion: variant.modelVersion ?? "", sourceLanguage: variant.sourceLanguage }, snapshot.revisionKey);
}

async function commitManifest(sc: SupabaseClient, asset: CaptionAsset, expectedRevision: string, revisionKey: string, path: string | null, consentId?: string): Promise<boolean> {
  const { data, error } = await sc.rpc("cas_media_caption_manifest", { p_asset_id: asset.id, p_owner_id: asset.owner_user_id, p_source: asset, p_expected_revision: expectedRevision, p_revision: revisionKey, p_object_path: path, p_asr_consent_id: consentId ?? null });
  if (error) throw new CaptionError("degraded_unavailable", "Caption commit could not be confirmed. Reload before retrying.");
  return data === true;
}

async function removeArtifact(sc: SupabaseClient, path: string): Promise<boolean> {
  try { return !(await sc.storage.from("post-media").remove([path])).error; } catch { return false; }
}

export async function writeAuthoredCaptions(sc: SupabaseClient, ownerId: string, assetId: string, version: number, vtt: string, consent: boolean, language = "und", origin?: { sourceKind: "asr" | "translation"; modelVersion: string; sourceLanguage?: string; consentId?: string }, expectedRevision = EMPTY_CAPTION_REVISION) {
  captionLanguage(language);
  const asset = await authorizedAsset(sc, ownerId, assetId, version);
  if (asset.owner_user_id !== ownerId) throw new CaptionError("forbidden", "Only the video owner can edit captions.");
  if (consent !== true) throw new CaptionError("invalid_payload", "Confirm that these captions may accompany your video.");
  const parsed = parseWebVtt(vtt, asset.duration_ms);
  if (!parsed.ok) throw new CaptionError("invalid_payload", `WebVTT refused: ${parsed.reason}.`);
  const snapshot = await readVariants(sc, ownerId, asset);
  if (snapshot.revisionKey !== expectedRevision) throw new CaptionError("conflict", "Captions changed. Reload before editing.");
  if (origin && (!origin.modelVersion || origin.modelVersion.length > 200)) throw new CaptionError("invalid_payload", "An AI model version is required.");
  const previous = snapshot.tracks;
  const existing = previous.find((track) => track.language === language);
  const tracks: CaptionVariant[] = [...previous.filter((track) => track.language !== language), { language, sourceKind: origin?.sourceKind ?? "manual", aiLabel: origin ? `AI ${origin.sourceKind === "asr" ? "transcription" : "translation"} · creator reviewed` : null, vtt, revision: (existing?.revision ?? 0) + 1, ...(origin ? { modelVersion: origin.modelVersion, sourceLanguage: origin.sourceLanguage } : {}) }];
  if (tracks.length > 8) throw new CaptionError("invalid_payload", "At most eight caption languages per video.");
  const revisionKey = randomBytes(32).toString("hex");
  const path = captionArtifactPath(assetId, version, revisionKey);
  const oldManifest = await readCaptionManifest(sc, assetId);
  await recheckCaptionAsset(sc, ownerId, asset);
  const bytes = Buffer.from(JSON.stringify({ source: asset, tracks, consent: true }));
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new CaptionError("invalid_payload", "Combined caption tracks are too large.");
  await requirePrivateCaptionStorage(sc);
  const { error } = await sc.storage.from("post-media").upload(path, bytes, { contentType: "application/json", upsert: false, cacheControl: "0" });
  if (error) throw new CaptionError("conflict", "Captions were not saved. Reload and retry.");
  try {
    await recheckCaptionAsset(sc, ownerId, asset);
    await requirePrivateCaptionStorage(sc);
  } catch (error) {
    if (!(await removeArtifact(sc, path))) throw new CaptionError("degraded_unavailable", "Captions were not published; storage cleanup needs retry.");
    throw error;
  }
  if (!(await commitManifest(sc, asset, expectedRevision, revisionKey, path, origin?.consentId))) {
    await removeArtifact(sc, path);
    throw new CaptionError("conflict", "The video or captions changed. Captions were not published.");
  }
  await recheckCaptionAsset(sc, ownerId, asset);
  const cleanupPending = oldManifest?.object_path ? !(await removeArtifact(sc, oldManifest.object_path)) : false;
  return { assetId, version, revisionKey, cues: parsed.track.cues, vtt, cleanupPending, language, sourceKind: origin?.sourceKind ?? "manual", aiLabel: tracks[tracks.length - 1]!.aiLabel, availableLanguages: tracks.map((track) => track.language) };
}

export async function deleteAuthoredCaptions(sc: SupabaseClient, ownerId: string, assetId: string, version: number, expectedRevision = EMPTY_CAPTION_REVISION) {
  const asset = await readCaptionAsset(sc, assetId);
  if (asset.owner_user_id !== ownerId) throw new CaptionError("forbidden", "Only the video owner can delete captions.");
  if (asset.version !== version) throw new CaptionError("conflict", "The video changed. Reload before deleting captions.");
  const prefix = `manual-captions/${assetId}`;
  let entries: { name: string }[] = [];
  let cleanupPending = false;
  try {
    const listed = await sc.storage.from("post-media").list(prefix, { limit: 1000 });
    entries = listed.data ?? [];
    cleanupPending = Boolean(listed.error || !listed.data || listed.data.length >= 1000);
  } catch { cleanupPending = true; }
  const revisionKey = randomBytes(32).toString("hex");
  if (!(await commitManifest(sc, asset, expectedRevision, revisionKey, null))) throw new CaptionError("conflict", "The video or captions changed. Reload before deleting captions.");
  const paths = entries.filter((entry) => /^(?:v[1-9]\d*(?:-[a-f0-9]{64})?|asr-v[1-9]\d*-(?:[a-f0-9-]{36}-)?[a-f0-9]{64})\.json$/.test(entry.name)).map((entry) => `${prefix}/${entry.name}`);
  if (paths.length) {
    try { const removed = await sc.storage.from("post-media").remove(paths); cleanupPending = Boolean(removed.error) || cleanupPending; } catch { cleanupPending = true; }
  }
  return { assetId, version, revisionKey, cues: [], vtt: null, cleanupPending };
}

export async function purgeAuthoredCaptionTracks(sc: SupabaseClient, assetId: string): Promise<void> {
  const asset = await readCaptionAsset(sc, assetId);
  if (asset.deleted_at === null && asset.purge_status === "not_requested") throw new CaptionError("conflict", "Mark the source deleted before lifecycle erasure.");
  const manifest = await readCaptionManifest(sc, assetId);
  if (!(await commitManifest(sc, asset, manifest?.revision_key ?? EMPTY_CAPTION_REVISION, randomBytes(32).toString("hex"), null))) throw new Error("Caption erasure state changed");
  return eraseCaptionArtifacts(sc, assetId);
}

async function eraseCaptionArtifacts(sc: SupabaseClient, assetId: string, keepPath?: string): Promise<void> {
  captionArtifactPath(assetId, 1);
  const prefix = `manual-captions/${assetId}`;
  for (let page = 0; page < 32; page++) {
    const { data, error } = await sc.storage.from("post-media").list(prefix, { limit: 100, offset: 0 });
    if (error || !data) throw new Error("Caption erasure could not be verified");
    if (data.length === 0) return;
    if (data.some((entry) => !/^(?:v[1-9]\d*(?:-[a-f0-9]{64})?|asr-v[1-9]\d*-(?:[a-f0-9-]{36}-)?[a-f0-9]{64})\.json$/.test(entry.name))) throw new Error("Unexpected caption artifact");
    const current = await readCaptionManifest(sc, assetId);
    const paths = data.map((entry) => `${prefix}/${entry.name}`).filter((path) => path !== keepPath && path !== current?.object_path);
    if (paths.length === 0) return;
    const removed = await sc.storage.from("post-media").remove(paths);
    if (removed.error) throw new Error("Caption erasure failed");
  }
  throw new Error("Caption erasure requires another bounded pass");
}
