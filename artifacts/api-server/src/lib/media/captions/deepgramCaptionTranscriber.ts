import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { managedMediaJson, ManagedMediaError } from "../managedMediaRequest.js";

export const DEEPGRAM_DISCLOSURE = "deepgram-audio-opt-out-v1";
const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  metadata: z.object({ models: z.array(z.string()).length(1), model_info: z.record(z.string(), z.object({ arch: z.literal("nova-3"), version: z.string() })) }),
  results: z.object({ channels: z.array(z.object({
    detected_language: z.string(), language_confidence: probability.min(0.5),
    alternatives: z.array(z.object({ words: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().positive(), word: z.string().min(1).max(100), punctuated_word: z.string().min(1).max(100).optional(), confidence: probability })) .min(1).max(30000) })).min(1),
  })).length(1) }),
});

/** Uses word timestamps supplied by ASR; never synthesizes timing from transcript length. */
export function deepgramSegments(raw: unknown, version: string, languages: readonly string[], durationMs: number) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new ManagedMediaError("managed_invalid_transcription");
  const { metadata, results } = parsed.data;
  if (metadata.model_info[metadata.models[0]!] ?.version !== version) throw new ManagedMediaError("managed_model_pin_mismatch");
  const channel = results.channels[0]!;
  if (!languages.includes(channel.detected_language)) throw new ManagedMediaError("managed_language_unvalidated");
  const segments: { start: number; end: number; text: string }[] = [];
  let previousEnd = 0;
  for (const word of channel.alternatives[0]!.words) {
    const text = (word.punctuated_word ?? word.word).trim();
    if (word.start < previousEnd || word.end <= word.start || word.end * 1000 > durationMs + 1000 || !text || /[\x00-\x1f<>]/.test(text)) throw new ManagedMediaError("managed_invalid_word_timing");
    const last = segments.at(-1);
    if (last && text.length + last.text.length < 84 && word.end - last.start <= 5 && word.start - last.end < 0.8 && !/[.!?]$/.test(last.text)) {
      last.text += ` ${text}`;
      last.end = word.end;
    } else segments.push({ start: word.start, end: word.end, text });
    previousEnd = word.end;
  }
  return { language: channel.detected_language, languageProbability: channel.language_confidence, segments };
}

export function createDeepgramCaptionTranscriber(input: { apiKey: string; version: string; allowedLanguages: readonly string[]; fetch?: typeof fetch }) {
  if (!input.apiKey || /\s/.test(input.apiKey) || !/^[A-Za-z0-9._-]{1,100}$/.test(input.version) || ["latest", "beta"].includes(input.version)
    || !input.allowedLanguages.length || input.allowedLanguages.some((language) => !/^[a-z]{2,3}$/.test(language))) throw new ManagedMediaError("managed_invalid_configuration");
  return async (audioPath: string, signal: AbortSignal, timeoutMs: number, durationMs: number): Promise<unknown> => {
    signal.throwIfAborted();
    const file = await stat(audioPath);
    if (!file.isFile() || file.size < 44 || file.size > 30 * 1024 * 1024) throw new ManagedMediaError("managed_audio_budget");
    const audio = await readFile(audioPath);
    try {
      if (audio.length !== file.size || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") throw new ManagedMediaError("managed_invalid_audio");
      const url = new URL("https://api.deepgram.com/v1/listen");
      url.searchParams.set("model", "nova-3");
      url.searchParams.set("version", input.version);
      url.searchParams.set("mip_opt_out", "true");
      url.searchParams.set("punctuate", "true");
      for (const language of input.allowedLanguages) url.searchParams.append("detect_language", language);
      const raw = await managedMediaJson({ url: url.href, authorization: `Token ${input.apiKey}`, body: audio, contentType: "audio/wav", signal,
        timeoutMs: Math.min(timeoutMs, 120000), maxResponseBytes: 4 * 1024 * 1024, fetch: input.fetch });
      return deepgramSegments(raw, input.version, input.allowedLanguages, durationMs);
    } finally { audio.fill(0); }
  };
}
