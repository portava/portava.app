/**
 * mediaCaptionSource — the captions seam (census-media §37, MD280).
 *
 * §37 "Captions" means a timed text track that travels with the video and a
 * player that renders its cues. §15.9 of the census stands: a "Captions" toggle
 * over the creator's note is not this. The track needs a SOURCE, and there are
 * exactly two: speech recognition (a vendor) or an authoring flow (a person
 * types them). This file is the seam for the first and the gate for both:
 * whatever produces a track, `parseWebVtt` must accept it before it is kept.
 *
 * `parseWebVtt` is deliberately strict — a subset of W3C WebVTT that every
 * mobile player renders:
 *   • the file starts with `WEBVTT` (an optional BOM before it, an optional
 *     header text after a space or tab);
 *   • cues are separated by blank lines; a cue is an optional identifier line,
 *     a timing line `HH:MM:SS.mmm --> HH:MM:SS.mmm` (hours optional), and at
 *     least one text line;
 *   • end > start, cues in non-decreasing start order, every cue ending within
 *     the video's duration when one is known (+1 s of slack), at most
 *     MAX_CUES cues and MAX_VTT_BYTES bytes;
 *   • NOTE / STYLE / REGION blocks are skipped; cue settings after the timing
 *     are ignored; text is kept verbatim.
 * A file that fails any of these is refused whole — a half-parsed caption
 * track shows the wrong words at the wrong time, which is worse than none.
 *
 * WHERE A TRACK GOES. `captionTrackPathFor` derives it from the video's own
 * storage path (`<storage_path>.captions.vtt`), the same derivation posters use
 * (lib/mediaPosterPath). A stored track is NOT yet served to anyone: serving it
 * needs lib/mediaAccess to authorise it as its video and a player-side track —
 * built once the source is chosen (census-media §37).
 *
 * CANDIDATE VENDORS — named with the capability each must have; not chosen:
 *   an ASR service that accepts a server-side audio/video reference, returns
 *   word or segment timings, and can return WebVTT (or segments this file
 *   renders to it), with language detection, and a data-processing agreement
 *   that covers user audio (e.g. AWS Transcribe, Google Cloud Speech-to-Text,
 *   Azure AI Speech batch transcription, Deepgram, AssemblyAI, a hosted
 *   Whisper-family model). The alternative is not a vendor at all: an authored
 *   WebVTT flow in the composer, which is a product decision.
 * Env (by name only): MEDIA_CAPTION_SOURCE selects the adapter; its credentials
 * (e.g. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION,
 * GOOGLE_APPLICATION_CREDENTIALS, DEEPGRAM_API_KEY, ASSEMBLYAI_API_KEY) are the
 * adapter's business.
 */
import {
  callVendor,
  refused,
  selectVendor,
  type VendorAnswer,
  type VendorSelection,
} from "./vendorCommon.js";

export const MAX_VTT_BYTES = 256 * 1024;
export const MAX_CUES = 2000;
/** A cue may end this far past a KNOWN duration (container rounding). */
const DURATION_SLACK_MS = 1000;

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionTrack {
  cues: CaptionCue[];
}

export type VttRefusal =
  | "too_large"
  | "no_header"
  | "bad_timing"
  | "empty_cue"
  | "out_of_order"
  | "beyond_duration"
  | "too_many_cues"
  | "no_cues";

const TIME_RE = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

function parseTimestamp(s: string): number | null {
  const m = TIME_RE.exec(s);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return ((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

/**
 * Parse and validate a WebVTT document. Returns the cues, or the first reason
 * it was refused. `durationMs` is the video's measured duration when known.
 */
export function parseWebVtt(
  input: string,
  durationMs: number | null = null,
): { ok: true; track: CaptionTrack } | { ok: false; reason: VttRefusal; line: number | null } {
  if (Buffer.byteLength(input, "utf8") > MAX_VTT_BYTES) return { ok: false, reason: "too_large", line: null };
  const text = input.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? "")) return { ok: false, reason: "no_header", line: 1 };

  const cues: CaptionCue[] = [];
  let i = 1;
  // The header block runs to the first blank line.
  while (i < lines.length && lines[i]!.trim() !== "") i++;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trim() === "") i++;
    if (i >= lines.length) break;
    const blockStart = i;
    const first = lines[i]!;
    if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(first)) {
      while (i < lines.length && lines[i]!.trim() !== "") i++;
      continue;
    }
    // Optional identifier line: anything that is not a timing line.
    let timingLine = first;
    if (!first.includes("-->")) {
      i++;
      timingLine = lines[i] ?? "";
    }
    const parts = timingLine.split("-->");
    if (parts.length !== 2) return { ok: false, reason: "bad_timing", line: i + 1 };
    const startMs = parseTimestamp(parts[0]!.trim());
    const endMs = parseTimestamp((parts[1]!.trim().split(/[ \t]+/)[0]) ?? "");
    if (startMs === null || endMs === null || endMs <= startMs) return { ok: false, reason: "bad_timing", line: i + 1 };
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "") {
      if (lines[i]!.includes("-->")) return { ok: false, reason: "bad_timing", line: i + 1 };
      textLines.push(lines[i]!);
      i++;
    }
    if (textLines.length === 0) return { ok: false, reason: "empty_cue", line: blockStart + 1 };
    const prev = cues[cues.length - 1];
    if (prev && startMs < prev.startMs) return { ok: false, reason: "out_of_order", line: blockStart + 1 };
    if (durationMs !== null && durationMs > 0 && endMs > durationMs + DURATION_SLACK_MS) {
      return { ok: false, reason: "beyond_duration", line: blockStart + 1 };
    }
    cues.push({ startMs, endMs, text: textLines.join("\n") });
    if (cues.length > MAX_CUES) return { ok: false, reason: "too_many_cues", line: blockStart + 1 };
  }
  if (cues.length === 0) return { ok: false, reason: "no_cues", line: null };
  return { ok: true, track: { cues } };
}

/** `<storage_path>.captions.vtt` — derived from the video, like its poster. */
export function captionTrackPathFor(videoStoragePath: string): string {
  return `${videoStoragePath}.captions.vtt`;
}

export interface CaptionSubject {
  assetId: string;
  bucket: string;
  path: string;
  durationMs: number | null;
}

export interface MediaCaptionSource {
  readonly name: string;
  readonly capabilities: { transcribe: boolean };
  /** A WebVTT document for this video's speech, and the language it detected (BCP-47). */
  transcribe(input: CaptionSubject): Promise<VendorAnswer<{ vtt: string; language: string | null }>>;
}

export const REFUSING_CAPTION_SOURCE: MediaCaptionSource = Object.freeze({
  name: "none",
  capabilities: Object.freeze({ transcribe: false }),
  async transcribe() { return refused<{ vtt: string; language: string | null }>("not_configured", "no caption source is configured"); },
});

/** Adapters written so far. EMPTY: no vendor has been chosen. */
export const IMPLEMENTED_CAPTION_SOURCES: Readonly<Record<string, () => MediaCaptionSource>> = Object.freeze({});

let _override: MediaCaptionSource | null = null;

export function _setMediaCaptionSourceForTest(s: MediaCaptionSource | null): void {
  _override = s;
}

export function selectMediaCaptionSource(env: NodeJS.ProcessEnv = process.env): VendorSelection<MediaCaptionSource> {
  if (_override) return { adapter: _override, configured: _override.name, configuredButUnknown: false };
  return selectVendor(env.MEDIA_CAPTION_SOURCE, IMPLEMENTED_CAPTION_SOURCES, REFUSING_CAPTION_SOURCE);
}

/** Ask the source for a track and validate it. A refusal and a malformed track both mean: no captions. */
export async function captionTrackFor(
  source: MediaCaptionSource,
  subject: CaptionSubject,
): Promise<VendorAnswer<{ vtt: string; language: string | null; cues: number }>> {
  if (!source.capabilities.transcribe) {
    return source.name === REFUSING_CAPTION_SOURCE.name
      ? refused("not_configured", "no caption source is configured")
      : refused("unsupported", `${source.name} does not transcribe`);
  }
  const answer = await callVendor(() => source.transcribe(subject));
  if (!answer.ok) return answer;
  const vtt = (answer.value as { vtt?: unknown } | null)?.vtt;
  if (typeof vtt !== "string") return refused("invalid_answer", "no WebVTT document");
  const parsed = parseWebVtt(vtt, subject.durationMs);
  if (!parsed.ok) return refused("invalid_answer", `WebVTT refused: ${parsed.reason}`);
  const lang = (answer.value as { language?: unknown }).language;
  const language = typeof lang === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang) ? lang : null;
  return { ok: true, value: { vtt, language, cues: parsed.track.cues.length } };
}
