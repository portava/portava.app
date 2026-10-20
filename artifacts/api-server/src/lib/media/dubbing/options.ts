import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readCaptionAsset, readCaptionManifest, recheckCaptionAsset } from "../../../services/media/AuthoredCaptionsService.js";
import { parseDubbingEnvironment, type DubbingEnvironment } from "./config.js";
import { DUBBING_DISCLOSURE_VERSION, DubbingError, languageSchema } from "./contracts.js";

export interface DubbingPlaybackOptions {
  assetId: string;
  sourceVersion: number;
  sourceKey: string;
  canEdit: boolean;
  enabled: boolean;
  languages: { code: string; label: string; ready: boolean }[];
  disclosure?: { version: typeof DUBBING_DISCLOSURE_VERSION; text: string; approved: true };
}

export async function readDubbingPlaybackOptions(client: SupabaseClient, assetId: string, viewerId: string,
  enabled: boolean, env: DubbingEnvironment = process.env): Promise<DubbingPlaybackOptions> {
  const asset = await readCaptionAsset(client, assetId);
  await recheckCaptionAsset(client, viewerId, asset);
  const manifest = await readCaptionManifest(client, assetId);
  const config = parseDubbingEnvironment(env);
  const { data, error } = await client.from("media_dubbing_readable").select("id,manifest")
    .eq("asset_id", assetId).order("created_at", { ascending: false }).limit(33);
  if (error || !Array.isArray(data) || data.length >= 33) throw new DubbingError("storage_unavailable");
  const languages = new Map<string, { code: string; label: string; ready: boolean }>();
  const receipts: string[] = [];
  for (const artifact of data) {
    const output = artifact.manifest;
    const code = languageSchema.safeParse(output?.language);
    if (!code.success || output?.assetId !== assetId || output?.sourceVersion !== asset.version ||
      output?.captionRevision !== manifest?.revision_key || !/^[a-f0-9]{64}$/.test(output?.consentRevision ?? "") ||
      !/^[a-f0-9]{64}$/.test(output?.revisionKey ?? "")) throw new DubbingError("integrity_failed");
    languages.set(code.data, { code: code.data, label: code.data, ready: true });
    receipts.push(`${artifact.id}:${output.revisionKey}:${output.consentRevision}`);
  }
  const canEdit = asset.owner_user_id === viewerId;
  if (canEdit && config.descriptor && !languages.has(config.descriptor.language)) {
    const code = config.descriptor.language;
    languages.set(code, { code, label: code, ready: false });
  }
  await recheckCaptionAsset(client, viewerId, asset);
  const current = await readCaptionManifest(client, assetId);
  if (JSON.stringify(current) !== JSON.stringify(manifest)) throw new DubbingError("source_revoked");
  const latest = await client.from("media_dubbing_readable").select("id,manifest")
    .eq("asset_id", assetId).order("created_at", { ascending: false }).limit(33);
  if (latest.error || !Array.isArray(latest.data) || latest.data.length >= 33) throw new DubbingError("storage_unavailable");
  const latestReceipts = latest.data.map((artifact) => `${artifact.id}:${artifact.manifest?.revisionKey}:${artifact.manifest?.consentRevision}`).sort();
  if (JSON.stringify(latestReceipts) !== JSON.stringify([...receipts].sort())) throw new DubbingError("source_revoked");
  const sourceKey = createHash("sha256").update(JSON.stringify([asset.id, asset.version, manifest?.revision_key,
    enabled, receipts.sort(), config.descriptor?.modelVersion])).digest("hex");
  return {
    assetId, sourceVersion: asset.version, sourceKey, canEdit, enabled,
    languages: [...languages.values()].sort((left, right) => left.code.localeCompare(right.code)),
    ...(canEdit && enabled && env.MEDIA_DUBBING_DISCLOSURE_APPROVED === "true" ? {
      disclosure: { version: DUBBING_DISCLOSURE_VERSION, approved: true as const,
        text: "I authorize a clearly labeled stock synthetic voice to read my approved translated subtitles. This does not clone my voice. My original audio remains unchanged. I can withdraw permission and remove generated audio." },
    } : {}),
  };
}
