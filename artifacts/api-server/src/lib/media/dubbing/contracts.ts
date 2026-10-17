import { z } from "zod";
import type { CaptionCue } from "../vendors/mediaCaptionSource.js";

export const DUBBING_LABEL = "AI-generated translated audio";
export const DUBBING_DISCLOSURE_VERSION = "synthetic-dubbing-v1";
export const DUBBING_SAMPLE_RATE = 24_000;
export const DUBBING_LIMITS = Object.freeze({ durationMs: 300_000, cues: 200, textBytes: 32_768, cueTextBytes: 2_048, segmentMs: 30_000 });

export type DubbingErrorCode = "not_configured" | "invalid_input" | "consent_required" | "source_revoked" | "unsupported_language" | "segment_overflow" | "invalid_audio" | "runtime_failed" | "runtime_timeout" | "runtime_busy" | "cancelled" | "output_limit" | "integrity_failed" | "storage_unavailable" | "cleanup_failed";

export class DubbingError extends Error {
  constructor(readonly code: DubbingErrorCode) {
    super(code);
    this.name = "DubbingError";
  }
}

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const dubbingConsentStateSchema = z.object({ consentRevision: revision, optedIn: z.boolean() }).strict();
export const languageSchema = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35);
const cueSchema = z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), text: z.string().min(1) }).strict();
const inputSchema = z.object({
  assetId: z.string().uuid(),
  ownerId: z.string().uuid(),
  requestedBy: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  captionRevision: revision,
  translationRevision: revision,
  consentRevision: revision,
  targetLanguage: languageSchema,
  optedIn: z.literal(true),
  disclosureVersion: z.literal(DUBBING_DISCLOSURE_VERSION),
  durationMs: z.number().int().min(1).max(DUBBING_LIMITS.durationMs),
  cues: z.array(cueSchema).min(1).max(DUBBING_LIMITS.cues),
}).strict();

export type TimedDubbingInput = z.infer<typeof inputSchema> & { cues: CaptionCue[] };
export type DubbingIdentity = Omit<TimedDubbingInput, "cues" | "durationMs" | "optedIn" | "disclosureVersion">;
export interface PcmAudio { sampleRate: number; samples: Buffer }
export interface SyntheticSpeechDescriptor {
  readonly id: string;
  readonly modelVersion: string;
  readonly language: string;
}
export interface SyntheticSpeechEngine extends SyntheticSpeechDescriptor {
  synthesize(text: string, signal: AbortSignal): Promise<PcmAudio>;
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DubbingError("cancelled");
}

export function validateSpeechText(text: string): string {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > DUBBING_LIMITS.cueTextBytes || /[<>\[\]\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)) {
    throw new DubbingError("invalid_input");
  }
  return text.replace(/\s+/gu, " ").trim();
}

export function validateDubbingInput(input: unknown): TimedDubbingInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new DubbingError("invalid_input");
  const value = parsed.data;
  if (value.ownerId !== value.requestedBy) throw new DubbingError("consent_required");
  let previousEnd = 0;
  let textBytes = 0;
  for (const cue of value.cues) {
    if (cue.startMs < previousEnd || cue.endMs <= cue.startMs || cue.endMs > value.durationMs || cue.endMs - cue.startMs > DUBBING_LIMITS.segmentMs) throw new DubbingError("invalid_input");
    cue.text = validateSpeechText(cue.text);
    textBytes += Buffer.byteLength(cue.text);
    previousEnd = cue.endMs;
  }
  if (textBytes > DUBBING_LIMITS.textBytes) throw new DubbingError("invalid_input");
  return value;
}
