/**
 * Telegraph §6.2/§6.3 VOICE — the recorder's and the player's rules, as pure
 * functions so they can be asserted without a microphone or a speaker.
 *
 * Spec §6.2:  "VOICE" is one of the thirteen message kinds.
 * Spec §6.3:  a voice message renders "waveform, seek, playback speed,
 *             optional transcript/translation".
 * Spec §11.3: "Captions/transcripts must be optional derivatives; original
 *             media remains accessible."
 *
 * ── WHY THESE NUMBERS ARE HERE AND NOT IN THE COMPONENTS ────────────────────
 * Every rule below is one a careless renderer gets subtly wrong and no one
 * notices: a seek that lands one bar off, a speed cycle that skips 1x so the
 * traveller cannot get back to normal, a waveform that renders 4,000 bars
 * because the meter ran at 60 Hz. Each of them is a rule, and a rule that lives
 * inside a component cannot be asserted without rendering one.
 *
 * ── THE SERVER OWNS THE SAME NUMBERS ────────────────────────────────────────
 * `VOICE_MAX_DURATION_SECONDS` and `WAVEFORM_MAX_PEAKS` are the SERVER's
 * (`artifacts/api-server/src/services/telegraph/voice.ts`), restated here
 * because this tree has no shared package between client and server. The
 * consequence of them drifting is concrete and worth naming: a recorder that
 * stopped at 360 s would produce a file the send route refuses AFTER the
 * traveller had recorded six minutes. So the recorder stops at the server's
 * ceiling, and `downsampleWaveform` produces at most the server's peak count —
 * the client never sends something it knows will be refused.
 */

/** The server's ceiling. A voice note is a message, not a podcast. */
export const VOICE_MAX_DURATION_SECONDS = 300;

/** The server's waveform cap. */
export const WAVEFORM_MAX_PEAKS = 120;

/** How many bars the player draws. Never more than the server will carry. */
export const WAVEFORM_BARS = 48;

/**
 * §6.3's "playback speed", as a CYCLE rather than a menu.
 *
 * 1x is FIRST and the cycle returns to it, which is the property that matters:
 * a traveller who taps past 2x must be able to get back to normal speed by
 * tapping again, not by hunting for a reset. A cycle that ran 1 → 1.5 → 2 and
 * stopped would strand them at 2x.
 */
export const PLAYBACK_SPEEDS = [1, 1.5, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export function nextPlaybackSpeed(current: number): PlaybackSpeed {
  const i = (PLAYBACK_SPEEDS as readonly number[]).indexOf(current);
  // An unknown speed resets to 1x rather than throwing: a stale persisted value
  // must not leave the player unable to cycle.
  if (i < 0) return PLAYBACK_SPEEDS[0];
  return PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length];
}

/** Clamp a peak into [0,1]; drop what is not a reading. Mirrors the server. */
export function normaliseWaveform(peaks: readonly number[] | null | undefined): number[] {
  if (!Array.isArray(peaks)) return [];
  const out: number[] = [];
  for (const p of peaks) {
    if (typeof p !== 'number' || !Number.isFinite(p)) continue;
    out.push(p < 0 ? 0 : p > 1 ? 1 : p);
  }
  return out;
}

/**
 * Reduce a peak series to at most `buckets` bars by AVERAGING each bucket.
 *
 * Averaging rather than sampling, for the reason the server's copy gives: a
 * 90-second recording metered at 10 Hz is 900 peaks, and taking every 8th makes
 * the drawn shape depend on which frames happened to be sampled — two
 * recordings of the same sentence would draw differently.
 */
export function downsampleWaveform(peaks: readonly number[], buckets = WAVEFORM_MAX_PEAKS): number[] {
  const clean = normaliseWaveform(peaks);
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

/**
 * Convert `expo-av`'s recording meter (dBFS, roughly -160..0) to a [0,1]
 * amplitude.
 *
 * -60 dB is treated as silence rather than -160: the metering floor is far
 * below room tone, so scaling from -160 makes every ordinary recording a flat
 * band near the top of the chart. Anchoring at -60 puts speech across the
 * usable range, which is the whole reason to draw a waveform.
 */
export const METER_FLOOR_DB = -60;

export function meteringToAmplitude(db: number | null | undefined): number {
  if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
  if (db >= 0) return 1;
  if (db <= METER_FLOOR_DB) return 0;
  return (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

/**
 * Which bar index a horizontal tap lands on.
 *
 * Clamped at both ends on purpose: a tap in the padding to the left of the
 * first bar is a request to go to the START, not an out-of-range index, and a
 * tap past the last bar is a request for the END. Returning -1 or `barCount`
 * would be technically accurate and would make the player seek to NaN.
 */
export function barIndexForTap(x: number, width: number, barCount: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0 || barCount <= 0) return 0;
  const raw = Math.floor((x / width) * barCount);
  return raw < 0 ? 0 : raw >= barCount ? barCount - 1 : raw;
}

/** The position, in milliseconds, a tap at `x` asks for. */
export function seekMillisForTap(
  x: number,
  width: number,
  durationSeconds: number,
  barCount: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const idx = barIndexForTap(x, width, barCount);
  const fraction = barCount > 0 ? idx / barCount : 0;
  return Math.round(fraction * durationSeconds * 1000);
}

/**
 * How much of the waveform is behind the playhead, as a fraction in [0,1].
 *
 * Guards a zero duration explicitly. A voice note whose duration failed to load
 * would otherwise divide by zero and fill the entire bar as "played", which
 * reads to a traveller as a message they have already heard.
 */
export function playedFraction(positionMillis: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  if (!Number.isFinite(positionMillis) || positionMillis <= 0) return 0;
  const f = positionMillis / (durationSeconds * 1000);
  return f > 1 ? 1 : f;
}

/** `m:ss`, the only format a voice note needs. */
export function formatDuration(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

/** True once a recording has run long enough that the recorder must stop it. */
export function recordingShouldStop(elapsedSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && elapsedSeconds >= VOICE_MAX_DURATION_SECONDS;
}

/**
 * Whether a finished recording may be sent.
 *
 * A sub-second recording is a mis-tap on the mic button, and sending it would
 * put an unplayable blip in the conversation — the server refuses it anyway
 * (`durationSeconds` has a floor of 1), so refusing it HERE is what turns a
 * server 400 into a recorder that simply discards a fumble.
 */
export function isSendableRecording(durationSeconds: number): boolean {
  return (
    Number.isFinite(durationSeconds) &&
    durationSeconds >= 1 &&
    durationSeconds <= VOICE_MAX_DURATION_SECONDS
  );
}

/**
 * §11.3 / WCAG 2.1.1 — how far ONE screen-reader adjustment moves the playhead.
 *
 * WHY THIS EXISTS AT ALL. The player draws its seek as a waveform and reads the
 * tap's `locationX`, which is a position in PIXELS. That is a perfectly good
 * affordance for a finger and it is the ONLY one there was: a person using
 * VoiceOver, TalkBack or Switch Control cannot land a tap on a chosen pixel, so
 * the entire seek was unreachable for them. The control even announced itself as
 * `adjustable`, which promises a swipe-up / swipe-down adjustment that nothing
 * implemented — an audible promise that was false.
 *
 * WHY FIVE SECONDS. It is the step every podcast and voice-note player uses, it
 * is coarse enough that traversing a five-minute note (the ceiling) takes a
 * bounded number of adjustments rather than hundreds, and it is fine enough to
 * find a sentence again. A PERCENTAGE step would move 3 s in a one-minute note
 * and 15 s in a five-minute one, so the same gesture would mean two things.
 */
export const ACCESSIBILITY_SEEK_STEP_SECONDS = 5;

/**
 * The position one increment/decrement asks for, in milliseconds.
 *
 * Clamped at BOTH ends for the same reason `barIndexForTap` is: a decrement at
 * the start is a request for the START, not a negative position, and an
 * increment at the end is a request for the END. Unclamped, either would hand
 * `setPositionAsync` a value the native player rejects, and the playhead the
 * person just moved would silently stay where it was.
 *
 * A zero or unreadable duration returns 0 rather than NaN — the same guard
 * `playedFraction` carries, for the same reason.
 */
export function seekMillisForStep(
  positionMillis: number,
  durationSeconds: number,
  direction: 1 | -1,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const from = Number.isFinite(positionMillis) && positionMillis > 0 ? positionMillis : 0;
  const next = from + direction * ACCESSIBILITY_SEEK_STEP_SECONDS * 1000;
  const max = durationSeconds * 1000;
  if (next <= 0) return 0;
  return next > max ? max : Math.round(next);
}
