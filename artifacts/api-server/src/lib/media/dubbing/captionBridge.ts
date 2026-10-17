import { createHash } from "node:crypto";
import type { PlatformTranslationResult } from "../../../services/platformTranslation.js";
import type { CaptionAsset, CaptionSnapshot } from "../../../services/media/AuthoredCaptionsService.js";
import { parseWebVtt, type CaptionCue } from "../vendors/mediaCaptionSource.js";
import { DubbingError, validateSpeechText } from "./contracts.js";
import type { TranslatedDubbingSource } from "./store.js";

export function translatedDubbingCues(cues: CaptionCue[], translation: PlatformTranslationResult, expected: { sourceRevision: string; targetLanguage: string }): CaptionCue[] {
  if (translation.status !== "translated" || !expected.sourceRevision || translation.sourceRevision !== expected.sourceRevision || translation.targetLanguage !== expected.targetLanguage || !translation.provider || !translation.providerVersion || /mock|fixture|test/i.test(`${translation.provider}:${translation.providerVersion}`) || cues.length < 1 || cues.length > 100 || Object.keys(translation.fields).length !== cues.length) throw new DubbingError("not_configured");
  return cues.map((cue, index) => {
    const text = translation.fields[`cue_${index}`];
    if (typeof text !== "string") throw new DubbingError("invalid_input");
    return { startMs: cue.startMs, endMs: cue.endMs, text: validateSpeechText(text) };
  });
}

export function dubbingSourceFromCaptionSnapshot(asset: CaptionAsset, snapshot: CaptionSnapshot, targetLanguage: string): TranslatedDubbingSource {
  if (asset.id !== snapshot.assetId || asset.version !== snapshot.sourceVersion || !/^[a-f0-9]{64}$/.test(snapshot.revisionKey) || snapshot.revisionKey === "0".repeat(64) || asset.deleted_at !== null || ["pending", "failed", "completed"].includes(asset.purge_status) || !["approved", "active"].includes(asset.moderation_status) || asset.media_type !== "video" || asset.storage_bucket !== "post-media") throw new DubbingError("source_revoked");
  const tracks = snapshot.tracks.filter((track) => track.language === targetLanguage && track.sourceKind === "translation");
  if (tracks.length !== 1) throw new DubbingError("not_configured");
  const track = tracks[0]!;
  if (!track.aiLabel || !track.modelVersion || /mock|fixture|test/i.test(track.modelVersion)) throw new DubbingError("not_configured");
  const parsed = parseWebVtt(track.vtt, asset.duration_ms);
  if (!parsed.ok) throw new DubbingError("invalid_input");
  return {
    assetId: asset.id, ownerId: asset.owner_user_id, sourceVersion: asset.version, targetLanguage,
    captionRevision: snapshot.revisionKey,
    translationRevision: createHash("sha256").update(JSON.stringify([snapshot.revisionKey, targetLanguage, track.modelVersion, track.vtt])).digest("hex"),
    durationMs: asset.duration_ms, cues: parsed.track.cues,
  };
}
