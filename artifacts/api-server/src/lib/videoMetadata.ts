/**
 * videoMetadata — remove capture LOCATION from uploaded video containers.
 *
 * WHY THIS EXISTS
 * ===============
 * Images are re-encoded through sharp on upload, and that re-encode drops all
 * EXIF — including GPS. That is the whole reason processImage() exists
 * (lib/mediaProcessing.ts). Video got none of it: mediaProcessing states
 * plainly that "Videos are NOT transcoded here (no ffmpeg in this tier)", and
 * both upload transports stored video bytes exactly as received.
 *
 * A phone video is geotagged the same way a phone photo is. An iPhone writes
 * `moov/udta/©xyz` (ISO-6109 latitude+longitude) and, on newer captures, an
 * Apple metadata `meta` box keyed `com.apple.quicktime.location.ISO6709`;
 * Android's MediaMuxer writes the same `©xyz` atom. So the app's location
 * privacy model (§33/§34) — coarsened public coordinates, geofenced publishing,
 * "location off" — held for stills and silently did not hold for video: the
 * exact capture point travelled inside every stored MOV/MP4 and reached every
 * authorized viewer.
 *
 * THE APPROACH: NEUTRALISE IN PLACE, NEVER RESIZE
 * ===============================================
 * There is no ffmpeg and no mp4 library in this tier (see the dependency note
 * at the bottom), so this is a container edit, not a transcode. The edit is
 * deliberately LENGTH-PRESERVING: a location box is rewritten to a `free` box
 * of exactly the same size and its payload is zeroed.
 *
 * That constraint is not cosmetic. `moov/trak/mdia/minf/stbl/stco` (and `co64`)
 * hold ABSOLUTE file offsets into `mdat`. Deleting bytes from `moov` — the
 * obvious way to "remove" an atom — shifts every byte after it and silently
 * invalidates every one of those offsets, producing a file that still parses
 * and no longer plays. Overwriting in place cannot do that: every offset in the
 * file still points where it did, and `free` is defined by ISO/IEC 14496-12 as
 * ignorable padding, so demuxers skip it. The bytes of the coordinates are gone
 * — zeroed, not merely unreferenced.
 *
 * WHAT IS REMOVED
 * ---------------
 *   • `©xyz` — QuickTime/3GPP ISO-6709 location string (iPhone, Android).
 *   • `loci` — 3GPP location information box.
 *   • any `meta` box whose bytes carry an Apple location key
 *     (`com.apple.quicktime.location...`). The whole `meta` box goes rather
 *     than the one `ilst` entry: `ilst` children are keyed by INDEX into the
 *     sibling `keys` table, so removing one value without renumbering the table
 *     re-points every later key at the wrong value. Dropping the box is the
 *     honest edit; what is lost with it is capture device/software metadata,
 *     which this app does not read.
 *
 * FAIL-CLOSED VERIFICATION
 * ------------------------
 * After the edit, the result is re-scanned at the byte level for the same
 * markers (`scanForLocationMarkers`). Anything still present means this module
 * did not understand the file, and the caller is told to REJECT it rather than
 * store a video whose coordinates it could not prove gone. That is why the
 * return type is a result, not a buffer.
 *
 * The byte scan is why the short markers are only ever looked for INSIDE the
 * `moov` box. `©xyz` is four bytes; over 100 MB of compressed video a random
 * four-byte match is likely enough (~2%) to reject real uploads, and `moov` is
 * small and structured, so a spurious hit there is not a practical concern.
 * The long Apple key is 28+ bytes and is scanned across the whole file, where a
 * random match cannot happen.
 *
 * WEBM / MATROSKA
 * ---------------
 * Matroska carries geo data as `SimpleTag` entries (TagName = LATITUDE /
 * LONGITUDE / GEO_LOCATION), which is a different container grammar with its
 * own variable-length integers. Rather than half-implement an EBML rewriter,
 * webm carrying such a tag is REFUSED (fail-closed) — the documented
 * alternative when stripping is not available. Phones record MP4/MOV, so this
 * refusal is not on the mobile capture path; a webm with no geo tag is
 * untouched and uploads normally.
 *
 * DEPENDENCY DECISION
 * ===================
 * No ffmpeg/mp4 dependency was added. artifacts/api-server has exactly one
 * media dependency (sharp, images only); ffmpeg would be a native binary and a
 * transcode tier, which is a platform decision, not a bug fix. Everything here
 * is pure Node buffer work with no new dependency at all.
 */

import type { SniffResult } from "./mediaProcessing.js";

/** Boxes that are, in themselves, capture location. Neutralised wherever found. */
const LOCATION_BOX_TYPES: ReadonlySet<string> = new Set([
  "©xyz", // ©xyz — ISO-6709 location string
  "loci", // 3GPP location information
]);

/**
 * Byte markers that prove location metadata is present.
 * `long` markers are unambiguous and scanned across the whole file; `short`
 * markers are scanned only inside `moov` (see the header note on false hits).
 */
const LONG_LOCATION_MARKERS: readonly string[] = ["com.apple.quicktime.location"];
const SHORT_LOCATION_MARKERS: readonly string[] = ["©xyz", "loci"];

/** Matroska SimpleTag names that carry geo data. Detection only — see header. */
const MATROSKA_LOCATION_TAGS: readonly string[] = [
  "GEO_LOCATION",
  "LATITUDE",
  "LONGITUDE",
];

/** ISO-BMFF boxes whose payload is a list of child boxes. */
const CONTAINER_BOX_TYPES: ReadonlySet<string> = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "edts",
  "udta",
  "moof",
  "traf",
]);

interface ParsedBox {
  type: string;
  /** Offset of the box's first byte (its size field). */
  start: number;
  /** Bytes of header consumed before the payload (8, or 16 for a 64-bit size). */
  headerSize: number;
  /** Offset one past the box's last byte. */
  end: number;
}

/**
 * Parse the boxes laid out between [start, end). Stops — rather than throwing —
 * at the first malformed or truncated box, so a partial buffer (a range read,
 * a test stub that is only an `ftyp` header) degrades to "no boxes here"
 * instead of an exception.
 */
function parseBoxes(buf: Buffer, start: number, end: number): ParsedBox[] {
  const out: ParsedBox[] = [];
  let off = start;
  while (off + 8 <= end) {
    const size32 = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      if (off + 16 > end) break;
      // 64-bit largesize. Anything above Number.MAX_SAFE_INTEGER is not a file
      // we can address anyway; readBigUInt64BE + Number() is exact below 2^53.
      const large = buf.readBigUInt64BE(off + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(large);
      headerSize = 16;
    } else if (size32 === 0) {
      // "extends to end of file"
      size = end - off;
    } else {
      size = size32;
    }
    if (size < headerSize || off + size > end) break;
    out.push({ type, start: off, headerSize, end: off + size });
    off += size;
  }
  return out;
}

/**
 * Rewrite one box into a `free` box of identical length and zero its payload.
 * The size field is untouched, so no byte after this box moves and every
 * chunk-offset table in the file stays valid.
 */
function neutraliseBox(buf: Buffer, box: ParsedBox): void {
  buf.write("free", box.start + 4, 4, "latin1");
  buf.fill(0, box.start + box.headerSize, box.end);
}

/**
 * True when `marker` (latin1 bytes, so `©` is the single byte 0xA9) occurs
 * wholly inside [start, end). Searched on a subarray rather than by comparing
 * an absolute indexOf against `end`, so a marker that merely STRADDLES the
 * boundary is not counted as inside it.
 */
function containsMarker(buf: Buffer, marker: string, start: number, end: number): boolean {
  const lo = Math.max(0, Math.min(start, buf.length));
  const hi = Math.max(lo, Math.min(end, buf.length));
  return buf.subarray(lo, hi).includes(Buffer.from(marker, "latin1"));
}

/**
 * Walk the box tree from [start, end), neutralising every location box found.
 * Returns the human-readable names of what was removed.
 */
function scrubBoxTree(buf: Buffer, start: number, end: number, stripped: string[]): void {
  for (const box of parseBoxes(buf, start, end)) {
    if (LOCATION_BOX_TYPES.has(box.type)) {
      neutraliseBox(buf, box);
      stripped.push(box.type);
      continue;
    }
    if (box.type === "meta") {
      // Whole-box decision — see the header note on `ilst` index keying.
      const carriesLocation = LONG_LOCATION_MARKERS.some((m) =>
        containsMarker(buf, m, box.start, box.end),
      );
      if (carriesLocation) {
        neutraliseBox(buf, box);
        stripped.push("meta(com.apple.quicktime.location)");
      }
      continue;
    }
    if (CONTAINER_BOX_TYPES.has(box.type)) {
      scrubBoxTree(buf, box.start + box.headerSize, box.end, stripped);
    }
  }
}

/** Byte range of the top-level `moov` box, or null when the file has none. */
function findMoovRange(buf: Buffer): { start: number; end: number } | null {
  for (const box of parseBoxes(buf, 0, buf.length)) {
    if (box.type === "moov") return { start: box.start, end: box.end };
  }
  return null;
}

/**
 * Independent, structure-free proof that no location metadata survives.
 * Long markers are checked across the whole buffer; short ones only inside
 * `moov`, where a chance four-byte match is not a practical risk.
 */
export function scanForLocationMarkers(buf: Buffer): string[] {
  const found: string[] = [];
  for (const marker of LONG_LOCATION_MARKERS) {
    if (containsMarker(buf, marker, 0, buf.length)) found.push(marker);
  }
  const moov = findMoovRange(buf);
  if (moov) {
    for (const marker of SHORT_LOCATION_MARKERS) {
      if (containsMarker(buf, marker, moov.start, moov.end)) found.push(marker);
    }
  }
  return found;
}

/** Matroska geo `SimpleTag` names present in the buffer (detection only). */
export function scanForMatroskaLocationTags(buf: Buffer): string[] {
  return MATROSKA_LOCATION_TAGS.filter((tag) => containsMarker(buf, tag, 0, buf.length));
}

export type VideoScrubResult =
  | { ok: true; buffer: Buffer; stripped: string[] }
  | { ok: false; failure: { code: "invalid_payload"; message: string } };

/**
 * Remove capture location metadata from a video container.
 *
 * MUTATES `buf` IN PLACE and returns the same Buffer. That is deliberate: the
 * video ceiling is 100 MB and copying to stay "pure" would double peak memory
 * in an autoscale process for no benefit — callers own the buffer they pass
 * (a request body, or bytes they just downloaded) and have no use for the
 * geotagged original. Pass a copy if you need one.
 *
 * Returns ok:false when the file carries location data this module cannot
 * remove. Callers MUST treat that as fatal for the upload — storing it is the
 * defect this exists to close.
 */
export function stripVideoLocationMetadata(buf: Buffer, sniffed: SniffResult): VideoScrubResult {
  if (sniffed.kind !== "video") {
    return {
      ok: false,
      failure: { code: "invalid_payload", message: "Not a video file" },
    };
  }

  // Matroska/WebM: detect and refuse; there is no EBML rewriter here.
  if (sniffed.mime === "video/webm") {
    const tags = scanForMatroskaLocationTags(buf);
    if (tags.length > 0) {
      return {
        ok: false,
        failure: {
          code: "invalid_payload",
          message:
            "This video carries location metadata that cannot be removed on the server. " +
            "Please re-export it without location data, or upload it as MP4/MOV.",
        },
      };
    }
    return { ok: true, buffer: buf, stripped: [] };
  }

  const stripped: string[] = [];
  scrubBoxTree(buf, 0, buf.length, stripped);

  // Fail-closed proof. If any marker survives the structural edit, this module
  // did not understand the container and must not let the bytes be stored.
  const residual = scanForLocationMarkers(buf);
  if (residual.length > 0) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          "This video carries location metadata that could not be removed. " +
          "Please re-export it without location data.",
      },
    };
  }

  return { ok: true, buffer: buf, stripped };
}
