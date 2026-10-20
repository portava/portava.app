import { createHash } from "node:crypto";
import { DUBBING_LABEL, DUBBING_SAMPLE_RATE, DubbingError, checkCancelled, validateDubbingInput, type SyntheticSpeechDescriptor, type SyntheticSpeechEngine, type TimedDubbingInput } from "./contracts.js";
import { encodeWave, resamplePcm } from "./wav.js";

export interface DubbingManifest {
  kind: "synthetic_dubbing";
  label: typeof DUBBING_LABEL;
  originalPreserved: true;
  voiceCloning: false;
  training: false;
  language: string;
  assetId: string;
  sourceVersion: number;
  captionRevision: string;
  translationRevision: string;
  consentRevision: string;
  revisionKey: string;
  engine: string;
  modelVersion: string;
  sampleRate: number;
  durationMs: number;
  bytes: number;
  sha256: string;
  segments: Array<{ startMs: number; endMs: number; spokenMs: number }>;
}

export function dubbingRevision(input: TimedDubbingInput, engine: SyntheticSpeechDescriptor): string {
  return createHash("sha256").update(JSON.stringify({ input, engine: engine.id, modelVersion: engine.modelVersion, alignment: "pcm-pad-no-stretch-v1" })).digest("hex");
}

export async function renderDubbing(input: unknown, engine: SyntheticSpeechEngine, options: {
  signal: AbortSignal;
  assertCurrent: (input: TimedDubbingInput) => Promise<void>;
}): Promise<{ audio: Buffer; manifest: DubbingManifest }> {
  const value = validateDubbingInput(input);
  if (engine.language !== value.targetLanguage) throw new DubbingError("unsupported_language");
  if (!/^[a-z0-9._:-]{1,100}$/.test(engine.id) || !/^[a-zA-Z0-9._:/@+-]{1,200}$/.test(engine.modelVersion)) throw new DubbingError("not_configured");
  const check = async () => {
    checkCancelled(options.signal);
    await options.assertCurrent(structuredClone(value));
    checkCancelled(options.signal);
  };
  await check();
  const samples = Buffer.alloc(Math.round(value.durationMs * DUBBING_SAMPLE_RATE / 1000) * 2);
  const segments: DubbingManifest["segments"] = [];
  try {
    for (const cue of value.cues) {
      await check();
      const audio = await engine.synthesize(cue.text, options.signal);
      await check();
      const rendered = resamplePcm(audio, DUBBING_SAMPLE_RATE);
      const start = Math.round(cue.startMs * DUBBING_SAMPLE_RATE / 1000);
      const end = Math.round(cue.endMs * DUBBING_SAMPLE_RATE / 1000);
      if (rendered.length / 2 > end - start) throw new DubbingError("segment_overflow");
      let audible = false;
      for (let offset = 0; offset < rendered.length; offset += 2) {
        if (Math.abs(rendered.readInt16LE(offset)) > 16) { audible = true; break; }
      }
      if (!audible) throw new DubbingError("invalid_audio");
      rendered.copy(samples, start * 2);
      segments.push({ startMs: cue.startMs, endMs: cue.endMs, spokenMs: rendered.length / 2 / DUBBING_SAMPLE_RATE * 1000 });
    }
    await check();
    const audio = encodeWave({ sampleRate: DUBBING_SAMPLE_RATE, samples });
    return { audio, manifest: {
      kind: "synthetic_dubbing", label: DUBBING_LABEL, originalPreserved: true, voiceCloning: false, training: false,
      language: value.targetLanguage, assetId: value.assetId, sourceVersion: value.sourceVersion,
      captionRevision: value.captionRevision, translationRevision: value.translationRevision, consentRevision: value.consentRevision,
      revisionKey: dubbingRevision(value, engine), engine: engine.id, modelVersion: engine.modelVersion,
      sampleRate: DUBBING_SAMPLE_RATE, durationMs: value.durationMs, bytes: audio.length,
      sha256: createHash("sha256").update(audio).digest("hex"), segments,
    } };
  } finally {
    samples.fill(0);
  }
}
