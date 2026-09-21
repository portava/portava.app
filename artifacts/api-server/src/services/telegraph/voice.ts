/**
 * Telegraph §6.2 VOICE — the kind that was refused by name until the audio
 * asset type existed.
 *
 * ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────
 * The payload contract, the waveform rules, and the row shape a voice note
 * writes. Everything here is pure: no client, no I/O, no environment. The
 * route owns transport and authorization; this module owns what a voice note
 * IS, so the rules can be asserted without a database.
 *
 * ── WHY A WAVEFORM IS PART OF THE PAYLOAD AND NOT DERIVED ───────────────────
 * §6.3 asks a voice message to render "waveform, seek, playback speed". There
 * is no ffmpeg and no audio decoder in this tier — the same constraint
 * `lib/mediaProcessing.ts` records for video — so the server cannot compute
 * peaks from the bytes. The recorder already has them: `expo-av` reports
 * metering while recording, which is exactly a peak series sampled in real
 * time. So the waveform travels WITH the message, is validated here, and is
 * NORMALISED here, which matters more than it sounds: a client-supplied
 * amplitude series is the one field of this payload a sender controls and a
 * recipient renders, so it is clamped to [0,1] and capped in length rather
 * than trusted, and a bar chart cannot be turned into a denial-of-service by
 * sending a million peaks.
 *
 * A voice note with NO waveform is legal and renders as a flat bar — degraded,
 * not refused. §11.3's rule that a derivative may never gate access to the
 * original applies to the waveform exactly as it applies to a transcript: the
 * audio is the message, the picture of it is a convenience.
 *
 * ── WHY THERE IS NO TRANSCRIPT FIELD ────────────────────────────────────────
 * §6.3 and §18 ask for an OPTIONAL transcript. There is no speech-to-text
 * provider configured in this tree and none reachable from it. A nullable
 * `transcript` field would be a field nothing ever writes — the shape of a
 * promise rather than a feature — and `searchableTextOf` would silently index
 * nothing through it. It is left out, and the absence is recorded in
 * `docs/BUILD-BACKLOG.md` with the one thing that would close it. When a
 * provider exists, this is where the field goes and `searchableTextOf` already
 * reads `payload.text`-shaped fields.
 */
import { z } from "zod";

/**
 * How long a single voice note may run.
 *
 * A voice note is a message, not a podcast. This is the number the recorder
 * stops itself at, the number the payload schema refuses past, and the number
 * `lib/mediaPipeline.ts#VOICE_SIZE_LIMIT` is derived from — one constant, three
 * readers, so the recorder, the message and the upload ceiling cannot disagree.
 *
 * It lives HERE rather than beside the size cap on purpose: `mediaPipeline`
 * pulls in `sharp`, and how long a voice note may be is a §6.2 rule about the
 * kind, which every service that handles one needs to know.
 */
export const VOICE_MAX_DURATION_SECONDS = 300;

/** How many amplitude peaks a waveform may carry. */
export const WAVEFORM_MAX_PEAKS = 120;

/**
 * §6.2 VOICE.
 *
 * `url` is checked for being OUR storage by the route (`appStorageUrlInfo`),
 * not here — this module has no environment and cannot know the storage origin.
 * What it enforces is shape: a duration inside the product's own ceiling, and a
 * waveform that is a short series of normalised amplitudes.
 */
export const VoicePayload = z.object({
  url: z.string().min(1).max(2048),
  /**
   * Whole seconds. `1` is the floor because a zero-second voice note is a
   * mis-fire, not a message, and §6.2's kinds are things a person meant to
   * send. The ceiling is the pipeline's, so the recorder, the payload and the
   * upload policy cannot disagree about how long a voice note may be.
   */
  durationSeconds: z
    .number()
    .int()
    .min(1, "a voice note is at least one second long")
    .max(
      VOICE_MAX_DURATION_SECONDS,
      `a voice note runs at most ${VOICE_MAX_DURATION_SECONDS} seconds`,
    ),
  /**
   * Amplitude peaks in [0,1], oldest first. Empty is legal. Values outside the
   * range are CLAMPED rather than refused (see `normaliseWaveform`) because a
   * meter that reported -160 dB on a silent frame is a normal recording, not a
   * malformed message.
   */
  waveform: z.array(z.number()).max(WAVEFORM_MAX_PEAKS).default([]),
  /** The container actually stored, so a player does not have to guess. */
  mimeType: z.string().min(1).max(64),
  sizeBytes: z.number().int().positive().max(64 * 1024 * 1024).nullish(),
});

export type VoicePayloadInput = z.infer<typeof VoicePayload>;

/**
 * Clamp every peak into [0,1] and drop what will not render.
 *
 * NaN and Infinity are dropped rather than clamped: they are not quiet or loud,
 * they are "the meter did not report", and a renderer that receives one draws
 * nothing useful from it. Everything else is clamped, so a recorder that emits
 * decibels or a 0-255 scale degrades to a flat-topped waveform instead of an
 * error the traveller cannot act on.
 */
export function normaliseWaveform(peaks: readonly number[] | null | undefined): number[] {
  if (!Array.isArray(peaks)) return [];
  const out: number[] = [];
  for (const p of peaks) {
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    out.push(p < 0 ? 0 : p > 1 ? 1 : p);
    if (out.length >= WAVEFORM_MAX_PEAKS) break;
  }
  return out;
}

/**
 * Reduce an arbitrarily long peak series to at most `buckets` bars by AVERAGING
 * within each bucket.
 *
 * Averaging rather than sampling, deliberately: a 90-second recording metered
 * at 10 Hz is 900 peaks, and taking every 8th one makes the rendered shape
 * depend on which frames happened to be sampled — two recordings of the same
 * speech draw differently. The mean of each bucket is stable under that.
 *
 * Exported because the RECORDER runs it before sending, and the test asserts
 * the two agree; a downsample that lived only in the client would be a rule
 * with no way to fail.
 */
export function downsampleWaveform(peaks: readonly number[], buckets = WAVEFORM_MAX_PEAKS): number[] {
  const clean = normaliseWaveformUncapped(peaks);
  if (buckets <= 0) return [];
  if (clean.length <= buckets) return clean;
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i * clean.length) / buckets);
    const end = Math.max(start + 1, Math.floor(((i + 1) * clean.length) / buckets));
    let sum = 0;
    for (let j = start; j < end; j++) sum += clean[j]!;
    out.push(sum / (end - start));
  }
  return out;
}

/** `normaliseWaveform` without the length cap — the input to a downsample. */
function normaliseWaveformUncapped(peaks: readonly number[] | null | undefined): number[] {
  if (!Array.isArray(peaks)) return [];
  const out: number[] = [];
  for (const p of peaks) {
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    out.push(p < 0 ? 0 : p > 1 ? 1 : p);
  }
  return out;
}

export type VoiceValidation =
  | { ok: true; payload: VoicePayloadInput }
  | { ok: false; error: string };

/** Validate and normalise a client-supplied voice payload in one step. */
export function validateVoicePayload(input: unknown): VoiceValidation {
  const parsed = VoicePayload.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid voice payload" };
  }
  return {
    ok: true,
    payload: { ...parsed.data, waveform: normaliseWaveform(parsed.data.waveform) },
  };
}

/**
 * The `messages` row a voice note writes.
 *
 * BOTH the envelope AND the media columns, and the duplication is the point.
 * The envelope is what the renderer reads — it carries the waveform, which has
 * no column and should not get one. The media columns are what everything that
 * reasons about MESSAGE-OWNED ASSETS reads: the §6.4 drawer's preview, the
 * data-saver path, and `media_type`, which is the only place the schema records
 * that this message owns an audio object in our storage. A voice note written
 * with the envelope alone would be an asset the schema cannot describe.
 *
 * `media_type: "audio"` REQUIRES migration 2989. Before it is applied, the
 * insert is refused by the database's own CHECK constraint, and the route turns
 * that refusal into a sentence that names the migration rather than a generic
 * `db_error` — see `routes/telegraphVoice.ts`. A voice note is never written
 * with `media_type` NULL to get around the constraint: a CHECK evaluating to
 * NULL passes in Postgres, so that row would be accepted and would be wrong
 * quietly, which is worse than being refused loudly.
 */
export function voiceMessageRow(input: {
  threadId: string;
  senderId: string;
  payload: VoicePayloadInput;
  createdAt: string;
  replyToId?: string | null;
}): Record<string, unknown> {
  const envelope = {
    kind: "VOICE" as const,
    envelopeVersion: "1" as const,
    payload: input.payload,
  };
  return {
    thread_id: input.threadId,
    sender_id: input.senderId,
    body: JSON.stringify(envelope),
    created_at: input.createdAt,
    msg_type: "voice",
    subtype: null,
    reply_to_id: input.replyToId ?? null,
    media_url: input.payload.url,
    media_type: "audio",
    media_thumbnail_url: null,
    media_duration_seconds: input.payload.durationSeconds,
  };
}

/**
 * Postgres raises `23514` (check_violation) when a row fails a CHECK. On the
 * voice insert there is exactly ONE check it can be, and saying so turns an
 * opaque 500 into an operator instruction.
 */
export function isAudioMediaTypeRejection(err: unknown): boolean {
  const code = (err as any)?.code;
  const message = String((err as any)?.message ?? "");
  if (code === "23514") return true;
  return /messages_media_type_check/.test(message);
}

export const AUDIO_MIGRATION_PENDING_MESSAGE =
  "Voice notes need migration 2989_messages_audio_media_type.sql, which widens " +
  "messages.media_type to admit 'audio'. It is written and has not been applied " +
  "to this database. Nothing was sent.";
