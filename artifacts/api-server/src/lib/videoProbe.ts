/**
 * videoProbe — read a video's DURATION and DISPLAY DIMENSIONS from its
 * container, on the server, from the bytes that were actually stored.
 *
 * WHY THIS EXISTS (Media spec §37 "Duration metadata")
 * ====================================================
 * Until this module, the server never looked inside a video for anything but
 * location atoms (lib/videoMetadata.ts). Duration and width/height for every
 * video row were whatever the uploading client declared: `post_media.
 * duration_seconds` was written verbatim from the /complete request body, and
 * `media_assets.duration_ms` had a typed input that no call site filled. A
 * client that said "3 s, 1920×1080" about a 58 s portrait clip was believed.
 *
 * Measuring duration does NOT need a decoder. It is a field of the container:
 *
 *   ISO-BMFF (MP4 / MOV / M4V)
 *     moov/mvhd            timescale + duration — the PRESENTATION duration,
 *                          edit lists already applied
 *     moov/mvex/mehd       fragment_duration — fragmented files whose mvhd
 *                          carries 0 ("empty moov")
 *     moov/trak/mdia/mdhd  per-track timescale + duration — the fallback
 *     moof/traf/trun       summed sample durations — the last resort for a
 *                          fragmented file with neither of the above
 *     moov/trak/tkhd       width/height (16.16 fixed point) and the display
 *                          MATRIX, which is how a phone records portrait: the
 *                          frames are coded landscape and the matrix says
 *                          "rotate 90° on display". The width/height a viewer
 *                          sees is therefore the SWAPPED pair, and storing the
 *                          coded pair would lay every portrait clip out as
 *                          landscape.
 *   Matroska / WebM
 *     Segment/Info         TimecodeScale (ns per tick, default 1 000 000) and
 *                          Duration (a float, in ticks)
 *     Segment/Tracks/TrackEntry/Video  PixelWidth/PixelHeight, and
 *                          DisplayWidth/DisplayHeight when present
 *
 * So this is pure buffer work, like the location scrub, and adds NO dependency.
 * Transcoding, frame extraction and adaptive renditions DO need a decoder, and
 * this module does not pretend otherwise — see lib/mediaProcessing.ts's header.
 *
 * CONTRACT
 * ========
 *  • Never throws. Every read is bounds-checked; a box or element that claims
 *    to run past its parent ends that walk. A malformed file yields `null` or a
 *    probe with `durationMs: null` — never an exception into an upload route.
 *  • Never invents. A field the container does not state is `null`, not a
 *    default. A zero timescale, an all-ones "unknown" duration, and a
 *    Matroska file whose Info carries no Duration (a live MediaRecorder
 *    capture) all yield `durationMs: null`.
 *  • `hasVideoTrack` is reported, not assumed. An audio-only MP4 is a valid
 *    ISO-BMFF file and probes successfully with `hasVideoTrack: false`; the
 *    CALLER decides whether that is acceptable.
 */

export type VideoContainer = "iso-bmff" | "matroska";

export interface VideoProbe {
  container: VideoContainer;
  /** Presentation duration in milliseconds, or null when the container does not state it. */
  durationMs: number | null;
  /** Which field the duration was read from — recorded so a log can say how it was known. */
  durationSource: "mvhd" | "mehd" | "mdhd" | "fragments" | "matroska-info" | null;
  /** DISPLAY width in pixels (after the display matrix), or null. */
  width: number | null;
  /** DISPLAY height in pixels (after the display matrix), or null. */
  height: number | null;
  /** Clockwise display rotation applied by the container's matrix. */
  rotation: 0 | 90 | 180 | 270;
  hasVideoTrack: boolean;
  hasAudioTrack: boolean;
}

/** An upper bound on anything a phone could record; a larger value is corrupt, not long. */
const MAX_PLAUSIBLE_DURATION_MS = 24 * 60 * 60 * 1000;
/** Larger than any real frame; a bigger value is a misparse, not a resolution. */
const MAX_PLAUSIBLE_DIMENSION = 16384;

/**
 * Probe a video container. Returns null when the bytes are not a container
 * this module understands (not ISO-BMFF, not EBML), or when nothing at all
 * could be read from them.
 */
export function probeVideoContainer(buf: Buffer | null | undefined): VideoProbe | null {
  if (!buf || buf.length < 12) return null;
  try {
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
      return probeMatroska(buf);
    }
    if (buf.toString("latin1", 4, 8) === "ftyp") {
      return probeIsoBmff(buf);
    }
    return null;
  } catch {
    return null;
  }
}

/** Duration in whole-millisecond seconds, the unit `post_media.duration_seconds` stores. */
export function probedDurationSeconds(probe: VideoProbe | null): number | null {
  if (!probe || probe.durationMs == null) return null;
  return Math.round(probe.durationMs) / 1000;
}

/**
 * Decide the duration to STORE for an upload, given what the server measured
 * and what the client declared.
 *
 * The measured value wins whenever the container states one. The declared value
 * is used ONLY when the container is silent (a live-recorded WebM, a fragmented
 * file with no timing at all), and the result says so — `source: "declared"` —
 * so the caller can log that this row's duration is still the client's word.
 */
export function resolveStoredDuration(
  probe: VideoProbe | null,
  declaredSeconds: number | null | undefined,
): { seconds: number | null; source: "measured" | "declared" | "none" } {
  const measured = probedDurationSeconds(probe);
  if (measured != null && measured > 0) return { seconds: measured, source: "measured" };
  if (typeof declaredSeconds === "number" && Number.isFinite(declaredSeconds) && declaredSeconds > 0) {
    return { seconds: declaredSeconds, source: "declared" };
  }
  return { seconds: null, source: "none" };
}

// ── ISO-BMFF ──────────────────────────────────────────────────────────────────

interface Box {
  type: string;
  /** Payload start (after the 8- or 16-byte header). */
  body: number;
  /** Exclusive end. */
  end: number;
}

/** Walk the boxes in [start, end). Bounded and total; see lib/mediaProcessing.ts isoBoxes. */
function boxes(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  let guard = 0;
  while (p + 8 <= end && guard++ < 100_000) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let body = p + 8;
    if (size === 1) {
      if (p + 16 > end) break;
      const hi = buf.readUInt32BE(p + 8);
      const lo = buf.readUInt32BE(p + 12);
      // A 64-bit size past 2^53 cannot be a real box in a buffer we hold.
      size = hi * 0x1_0000_0000 + lo;
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    const boxEnd = p + size;
    if (size < body - p || boxEnd > end) break;
    out.push({ type, body, end: boxEnd });
    p = boxEnd;
  }
  return out;
}

function child(buf: Buffer, parent: Box, type: string): Box | null {
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
  return null;
}

function children(buf: Buffer, parent: Box, type: string): Box[] {
  return boxes(buf, parent.body, parent.end).filter((b) => b.type === type);
}

/** Read an unsigned 64-bit big-endian value as a JS number, or null if it exceeds 2^53. */
function u64(buf: Buffer, at: number): number | null {
  const hi = buf.readUInt32BE(at);
  const lo = buf.readUInt32BE(at + 4);
  if (hi > 0x1fffff) return null;
  return hi * 0x1_0000_0000 + lo;
}

/** (timescale, duration) from an mvhd / mdhd full box. Unknown durations are null. */
function timescaleAndDuration(buf: Buffer, box: Box): { timescale: number; duration: number | null } | null {
  if (box.body + 4 > box.end) return null;
  const version = buf[box.body];
  if (version === 1) {
    // version(1) flags(3) creation(8) modification(8) timescale(4) duration(8)
    if (box.body + 32 > box.end) return null;
    const timescale = buf.readUInt32BE(box.body + 20);
    const hi = buf.readUInt32BE(box.body + 24);
    const lo = buf.readUInt32BE(box.body + 28);
    const unknown = hi === 0xffffffff && lo === 0xffffffff;
    return { timescale, duration: unknown ? null : u64(buf, box.body + 24) };
  }
  // version 0: version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
  if (box.body + 20 > box.end) return null;
  const timescale = buf.readUInt32BE(box.body + 12);
  const raw = buf.readUInt32BE(box.body + 16);
  return { timescale, duration: raw === 0xffffffff ? null : raw };
}

function toMs(duration: number | null, timescale: number): number | null {
  if (duration == null || !timescale || duration <= 0) return null;
  const ms = (duration / timescale) * 1000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_PLAUSIBLE_DURATION_MS) return null;
  return ms;
}

interface TrackInfo {
  trackId: number | null;
  handler: string | null;
  mediaTimescale: number | null;
  mediaDurationMs: number | null;
  /** Coded width/height from tkhd (16.16), before the matrix. */
  width: number | null;
  height: number | null;
  rotation: 0 | 90 | 180 | 270;
}

/** Clockwise rotation from a tkhd matrix's a/b/c/d (16.16 fixed point). */
function rotationFromMatrix(a: number, b: number, c: number, d: number): 0 | 90 | 180 | 270 {
  const one = 0x10000;
  // Apple's own convention (CGAffineTransform a b c d), which is what an iPhone
  // writes for a clip held upright: (0, 1, -1, 0) is 90° clockwise.
  if (a === 0 && d === 0 && b === one && c === -one) return 90;
  if (a === 0 && d === 0 && b === -one && c === one) return 270;
  if (a === -one && d === -one && b === 0 && c === 0) return 180;
  return 0;
}

function readTrack(buf: Buffer, trak: Box): TrackInfo {
  const info: TrackInfo = {
    trackId: null, handler: null, mediaTimescale: null, mediaDurationMs: null,
    width: null, height: null, rotation: 0,
  };
  const tkhd = child(buf, trak, "tkhd");
  if (tkhd && tkhd.body + 4 <= tkhd.end) {
    const version = buf[tkhd.body];
    // version 1: flags(3) creation(8) modification(8) track_ID(4) reserved(4) duration(8)
    // version 0: flags(3) creation(4) modification(4) track_ID(4) reserved(4) duration(4)
    const idAt = tkhd.body + (version === 1 ? 20 : 12);
    const afterDuration = tkhd.body + (version === 1 ? 36 : 24);
    // reserved(8) layer(2) alternate_group(2) volume(2) reserved(2) matrix(36) width(4) height(4)
    const matrixAt = afterDuration + 16;
    const widthAt = matrixAt + 36;
    if (idAt + 4 <= tkhd.end) info.trackId = buf.readUInt32BE(idAt);
    if (widthAt + 8 <= tkhd.end) {
      const a = buf.readInt32BE(matrixAt);
      const b = buf.readInt32BE(matrixAt + 4);
      const c = buf.readInt32BE(matrixAt + 12);
      const d = buf.readInt32BE(matrixAt + 16);
      info.rotation = rotationFromMatrix(a, b, c, d);
      const w = buf.readUInt32BE(widthAt) / 0x10000;
      const h = buf.readUInt32BE(widthAt + 4) / 0x10000;
      info.width = plausibleDimension(w);
      info.height = plausibleDimension(h);
    }
  }
  const mdia = child(buf, trak, "mdia");
  if (mdia) {
    const hdlr = child(buf, mdia, "hdlr");
    // version+flags(4) pre_defined(4) handler_type(4)
    if (hdlr && hdlr.body + 12 <= hdlr.end) info.handler = buf.toString("latin1", hdlr.body + 8, hdlr.body + 12);
    const mdhd = child(buf, mdia, "mdhd");
    if (mdhd) {
      const td = timescaleAndDuration(buf, mdhd);
      if (td) {
        info.mediaTimescale = td.timescale || null;
        info.mediaDurationMs = toMs(td.duration, td.timescale);
      }
    }
  }
  return info;
}

function plausibleDimension(v: number): number | null {
  if (!Number.isFinite(v) || v <= 0 || v > MAX_PLAUSIBLE_DIMENSION) return null;
  return Math.round(v);
}

/**
 * Sum the sample durations of every fragment of `trackId`, in that track's
 * media timescale. `trex` supplies the default; `tfhd` may override it; `trun`
 * may carry per-sample durations. Returns ticks, or null if nothing was found.
 */
function fragmentTicks(
  buf: Buffer,
  top: Box[],
  trackId: number,
  trexDefault: number | null,
): number | null {
  let total = 0;
  let found = false;
  for (const moof of top) {
    if (moof.type !== "moof") continue;
    for (const traf of children(buf, moof, "traf")) {
      const tfhd = child(buf, traf, "tfhd");
      if (!tfhd || tfhd.body + 8 > tfhd.end) continue;
      const tfFlags = buf.readUInt32BE(tfhd.body) & 0x00ffffff;
      if (buf.readUInt32BE(tfhd.body + 4) !== trackId) continue;
      let q = tfhd.body + 8;
      if (tfFlags & 0x000001) q += 8; // base_data_offset
      if (tfFlags & 0x000002) q += 4; // sample_description_index
      let defaultDuration = trexDefault;
      if (tfFlags & 0x000008) {
        if (q + 4 > tfhd.end) continue;
        defaultDuration = buf.readUInt32BE(q);
      }
      for (const trun of children(buf, traf, "trun")) {
        if (trun.body + 8 > trun.end) continue;
        const flags = buf.readUInt32BE(trun.body) & 0x00ffffff;
        const count = buf.readUInt32BE(trun.body + 4);
        let r = trun.body + 8;
        if (flags & 0x000001) r += 4; // data_offset
        if (flags & 0x000004) r += 4; // first_sample_flags
        const perSampleDuration = (flags & 0x000100) !== 0;
        const stride =
          (perSampleDuration ? 4 : 0) +
          (flags & 0x000200 ? 4 : 0) +
          (flags & 0x000400 ? 4 : 0) +
          (flags & 0x000800 ? 4 : 0);
        if (perSampleDuration) {
          for (let i = 0; i < count; i++) {
            const at = r + i * stride;
            if (at + 4 > trun.end) break;
            total += buf.readUInt32BE(at);
            found = true;
          }
        } else if (defaultDuration != null && count > 0) {
          total += defaultDuration * count;
          found = true;
        }
      }
    }
  }
  return found ? total : null;
}

function probeIsoBmff(buf: Buffer): VideoProbe | null {
  const top = boxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;

  const tracks = children(buf, moov, "trak").map((t) => readTrack(buf, t));
  const video = tracks.find((t) => t.handler === "vide") ?? null;
  const hasVideoTrack = video !== null;
  const hasAudioTrack = tracks.some((t) => t.handler === "soun");

  let durationMs: number | null = null;
  let durationSource: VideoProbe["durationSource"] = null;

  const mvhd = child(buf, moov, "mvhd");
  const movie = mvhd ? timescaleAndDuration(buf, mvhd) : null;
  if (movie) {
    durationMs = toMs(movie.duration, movie.timescale);
    if (durationMs != null) durationSource = "mvhd";
  }

  const mvex = child(buf, moov, "mvex");
  if (durationMs == null && mvex && movie) {
    const mehd = child(buf, mvex, "mehd");
    if (mehd && mehd.body + 8 <= mehd.end) {
      const v = buf[mehd.body];
      const ticks = v === 1 ? u64(buf, mehd.body + 4) : buf.readUInt32BE(mehd.body + 4);
      durationMs = toMs(ticks, movie.timescale);
      if (durationMs != null) durationSource = "mehd";
    }
  }

  if (durationMs == null) {
    const longest = tracks
      .map((t) => t.mediaDurationMs)
      .filter((v): v is number => v != null)
      .sort((a, b) => b - a)[0];
    if (longest != null) {
      durationMs = longest;
      durationSource = "mdhd";
    }
  }

  if (durationMs == null && mvex) {
    // Prefer the video track; fall back to whichever track has timing.
    const candidates = video ? [video, ...tracks.filter((t) => t !== video)] : tracks;
    for (const t of candidates) {
      if (t.trackId == null || !t.mediaTimescale) continue;
      let trexDefault: number | null = null;
      for (const trex of children(buf, mvex, "trex")) {
        // version+flags(4) track_ID(4) default_sample_description_index(4) default_sample_duration(4)
        if (trex.body + 16 > trex.end) continue;
        if (buf.readUInt32BE(trex.body + 4) === t.trackId) trexDefault = buf.readUInt32BE(trex.body + 12);
      }
      const ticks = fragmentTicks(buf, top, t.trackId, trexDefault);
      const ms = toMs(ticks, t.mediaTimescale);
      if (ms != null) {
        durationMs = ms;
        durationSource = "fragments";
        break;
      }
    }
  }

  let width: number | null = null;
  let height: number | null = null;
  let rotation: VideoProbe["rotation"] = 0;
  if (video) {
    rotation = video.rotation;
    const swap = rotation === 90 || rotation === 270;
    width = swap ? video.height : video.width;
    height = swap ? video.width : video.height;
  }

  return {
    container: "iso-bmff",
    durationMs: durationMs == null ? null : Math.round(durationMs),
    durationSource,
    width,
    height,
    rotation,
    hasVideoTrack,
    hasAudioTrack,
  };
}

// ── Matroska / WebM (EBML) ────────────────────────────────────────────────────

const EBML_ID = {
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  Cluster: 0x1f43b675,
} as const;

interface Element {
  id: number;
  body: number;
  /** Exclusive end; for an unknown-size element, the parent's end. */
  end: number;
  unknownSize: boolean;
}

/** An element ID: the length marker bits are KEPT, as the spec's IDs are written with them. */
function readId(buf: Buffer, at: number, end: number): { id: number; len: number } | null {
  if (at >= end) return null;
  const first = buf[at]!;
  let len = 0;
  for (let mask = 0x80; mask >= 0x10; mask >>= 1) {
    len++;
    if (first & mask) break;
    if (mask === 0x10) return null;
  }
  if (!(first & (0x100 >> len))) return null;
  if (at + len > end) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[at + i]!;
  return { id, len };
}

/** A data size: the marker bit is REMOVED. All value bits set means "unknown". */
function readSize(buf: Buffer, at: number, end: number): { size: number | null; len: number } | null {
  if (at >= end) return null;
  const first = buf[at]!;
  let len = 0;
  let mask = 0x80;
  while (len < 8 && !(first & mask)) {
    len++;
    mask >>= 1;
  }
  if (len === 8) return null;
  len += 1;
  if (at + len > end) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < len; i++) {
    const byte = buf[at + i]!;
    if (byte !== 0xff) allOnes = false;
    value = value * 256 + byte;
  }
  return { size: allOnes ? null : value, len };
}

function elements(buf: Buffer, start: number, end: number): Element[] {
  const out: Element[] = [];
  let p = start;
  let guard = 0;
  while (p < end && guard++ < 100_000) {
    const id = readId(buf, p, end);
    if (!id) break;
    const size = readSize(buf, p + id.len, end);
    if (!size) break;
    const body = p + id.len + size.len;
    if (size.size == null) {
      // Unknown size (a live capture's Segment or Cluster): runs to the parent's end.
      out.push({ id: id.id, body, end, unknownSize: true });
      break;
    }
    const elEnd = body + size.size;
    if (elEnd > end) {
      // Truncated: keep what is wholly present of THIS element's children by
      // clamping, but stop the sibling walk.
      out.push({ id: id.id, body, end, unknownSize: true });
      break;
    }
    out.push({ id: id.id, body, end: elEnd, unknownSize: false });
    p = elEnd;
  }
  return out;
}

function uintValue(buf: Buffer, el: Element): number | null {
  const len = el.end - el.body;
  if (len < 1 || len > 8) return null;
  let v = 0;
  for (let i = el.body; i < el.end; i++) v = v * 256 + buf[i]!;
  return Number.isSafeInteger(v) ? v : null;
}

function floatValue(buf: Buffer, el: Element): number | null {
  const len = el.end - el.body;
  if (len === 4) return buf.readFloatBE(el.body);
  if (len === 8) return buf.readDoubleBE(el.body);
  return null;
}

function probeMatroska(buf: Buffer): VideoProbe | null {
  const top = elements(buf, 0, buf.length);
  const segment = top.find((e) => e.id === EBML_ID.Segment);
  if (!segment) return null;

  let timecodeScale = 1_000_000; // Matroska default: 1 ms per tick
  let rawDuration: number | null = null;
  let width: number | null = null;
  let height: number | null = null;
  let hasVideoTrack = false;
  let hasAudioTrack = false;
  let sawInfo = false;

  for (const el of elements(buf, segment.body, segment.end)) {
    // Metadata precedes the media in every muxer this app can receive; the
    // first Cluster is where the reading stops, so a 100 MB upload is not walked.
    if (el.id === EBML_ID.Cluster) break;
    if (el.id === EBML_ID.Info) {
      sawInfo = true;
      for (const f of elements(buf, el.body, el.end)) {
        if (f.id === EBML_ID.TimecodeScale) timecodeScale = uintValue(buf, f) ?? timecodeScale;
        if (f.id === EBML_ID.Duration) rawDuration = floatValue(buf, f);
      }
    }
    if (el.id === EBML_ID.Tracks) {
      for (const entry of elements(buf, el.body, el.end)) {
        if (entry.id !== EBML_ID.TrackEntry) continue;
        let type: number | null = null;
        let pw: number | null = null;
        let ph: number | null = null;
        let dw: number | null = null;
        let dh: number | null = null;
        for (const f of elements(buf, entry.body, entry.end)) {
          if (f.id === EBML_ID.TrackType) type = uintValue(buf, f);
          if (f.id === EBML_ID.Video) {
            for (const v of elements(buf, f.body, f.end)) {
              if (v.id === EBML_ID.PixelWidth) pw = uintValue(buf, v);
              if (v.id === EBML_ID.PixelHeight) ph = uintValue(buf, v);
              if (v.id === EBML_ID.DisplayWidth) dw = uintValue(buf, v);
              if (v.id === EBML_ID.DisplayHeight) dh = uintValue(buf, v);
            }
          }
        }
        if (type === 1 && !hasVideoTrack) {
          hasVideoTrack = true;
          width = plausibleDimension(dw ?? pw ?? NaN);
          height = plausibleDimension(dh ?? ph ?? NaN);
        }
        if (type === 2) hasAudioTrack = true;
      }
    }
  }

  if (!sawInfo && !hasVideoTrack && !hasAudioTrack) return null;

  let durationMs: number | null = null;
  if (rawDuration != null && Number.isFinite(rawDuration) && rawDuration > 0 && timecodeScale > 0) {
    const ms = (rawDuration * timecodeScale) / 1_000_000;
    if (Number.isFinite(ms) && ms > 0 && ms <= MAX_PLAUSIBLE_DURATION_MS) durationMs = Math.round(ms);
  }

  return {
    container: "matroska",
    durationMs,
    durationSource: durationMs == null ? null : "matroska-info",
    width,
    height,
    rotation: 0,
    hasVideoTrack,
    hasAudioTrack,
  };
}
