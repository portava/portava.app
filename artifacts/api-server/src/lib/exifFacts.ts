/**
 * exifFacts — presence-and-count EXIF inspection. NEVER reads a GPS value.
 *
 * Split out of scripts/auditStorageExif.ts so the parser is testable without
 * constructing a Supabase client, importing the CI target guard, or touching a
 * bucket. The audit script is a top-level-await program that talks to live
 * Storage; a parser that could only be exercised through it would in practice
 * never be exercised at all.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO HOLD
 * ==========================================
 *
 * Tag 0x8825 (GPS IFD pointer) is followed exactly far enough to read the
 * entry COUNT at the head of the GPS IFD, and not one byte further. The GPS
 * entries themselves — 0x0002 latitude, 0x0004 longitude, and every other —
 * are never iterated, never dereferenced, never decoded. There is deliberately
 * no code path in this module that can produce a coordinate, because the only
 * durable guarantee that a coordinate is never logged is that it is never
 * computed. Do not add a "just for debugging" value read here.
 */

export interface ExifFacts {
  hasExif: boolean;
  hasGpsIfd: boolean;
  /** Number of entries in the GPS IFD. A richness indicator, never a value. */
  gpsEntryCount: number;
  /** DateTimeOriginal (0x9003) else DateTime (0x0132), ISO-ish, or null. */
  captureTs: string | null;
}

export const NO_EXIF: ExifFacts = {
  hasExif: false,
  hasGpsIfd: false,
  gpsEntryCount: 0,
  captureTs: null,
};

/**
 * Locate the raw TIFF block inside a container.
 *
 * Returns a zero-length buffer when the container was understood but carries no
 * EXIF (a definite "clean"), and null when the format is one we do not scan (an
 * "unknown" the caller must report as UNSCANNED). Collapsing those two into one
 * value is how an audit accidentally reports unreadable files as clean ones.
 */
export function findTiff(buf: Buffer): Buffer | null {
  // JPEG: scan APP1 segments for the "Exif\0\0" marker.
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 4 < buf.length) {
      if (buf[p] !== 0xff) break;
      const marker = buf[p + 1];
      if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
      const segLen = buf.readUInt16BE(p + 2);
      if (segLen < 2) break;
      if (marker === 0xe1 && buf.slice(p + 4, p + 10).toString("latin1") === "Exif\0\0") {
        return buf.slice(p + 10, p + 2 + segLen);
      }
      p += 2 + segLen;
    }
    return Buffer.alloc(0);
  }

  // PNG: eXIf chunk.
  if (buf.length > 8 && buf.slice(0, 8).toString("latin1") === "\x89PNG\r\n\x1a\n") {
    let p = 8;
    while (p + 8 < buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.slice(p + 4, p + 8).toString("latin1");
      if (type === "eXIf") return buf.slice(p + 8, p + 8 + len);
      if (type === "IEND") break;
      p += 12 + len;
    }
    return Buffer.alloc(0);
  }

  // WebP (RIFF): EXIF chunk.
  if (
    buf.length > 12 &&
    buf.slice(0, 4).toString("latin1") === "RIFF" &&
    buf.slice(8, 12).toString("latin1") === "WEBP"
  ) {
    let p = 12;
    while (p + 8 < buf.length) {
      const type = buf.slice(p, p + 4).toString("latin1");
      const len = buf.readUInt32LE(p + 4);
      if (type === "EXIF") return buf.slice(p + 8, p + 8 + len);
      p += 8 + len + (len % 2);
    }
    return Buffer.alloc(0);
  }

  return null; // unsupported container — UNSCANNED, not clean
}

/**
 * Walk IFD0 for the facts the audit needs. Reads tag numbers, counts and the
 * two date strings only.
 */
export function parseExif(tiff: Buffer): ExifFacts {
  if (tiff.length < 8) return NO_EXIF;
  const bom = tiff.slice(0, 2).toString("latin1");
  const le = bom === "II";
  if (!le && bom !== "MM") return NO_EXIF;

  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));

  const ifd0 = u32(4);
  if (ifd0 + 2 > tiff.length) return NO_EXIF;

  const readAscii = (entryOff: number): string | null => {
    const count = u32(entryOff + 4);
    if (count === 0 || count > 64) return null;
    const off = count <= 4 ? entryOff + 8 : u32(entryOff + 8);
    if (off + count > tiff.length) return null;
    return tiff.slice(off, off + count).toString("latin1").replace(/\0+$/, "");
  };

  const entryCountAt = (off: number): number => {
    if (off + 2 > tiff.length) return 0;
    return u16(off);
  };

  let hasGpsIfd = false;
  let gpsEntryCount = 0;
  let dateTime: string | null = null;
  let dateTimeOriginal: string | null = null;

  const n0 = u16(ifd0);
  for (let i = 0; i < n0; i++) {
    const e = ifd0 + 2 + i * 12;
    if (e + 12 > tiff.length) break;
    const tag = u16(e);

    if (tag === 0x8825) {
      // GPS IFD POINTER. Followed ONLY to read the entry count at its head.
      // See the invariant at the top of this file.
      hasGpsIfd = true;
      gpsEntryCount = entryCountAt(u32(e + 8));
    } else if (tag === 0x0132) {
      dateTime = readAscii(e);
    } else if (tag === 0x8769) {
      const sub = u32(e + 8);
      const n1 = entryCountAt(sub);
      for (let j = 0; j < n1; j++) {
        const se = sub + 2 + j * 12;
        if (se + 12 > tiff.length) break;
        if (u16(se) === 0x9003) dateTimeOriginal = readAscii(se);
      }
    }
  }

  const raw = dateTimeOriginal ?? dateTime;
  // EXIF dates are "YYYY:MM:DD HH:MM:SS" — not ISO, and not parseable as-is.
  const captureTs =
    raw && /^\d{4}:\d{2}:\d{2}/.test(raw)
      ? `${raw.slice(0, 10).replace(/:/g, "-")}T${raw.slice(11) || "00:00:00"}Z`
      : null;

  return { hasExif: true, hasGpsIfd, gpsEntryCount, captureTs };
}

/** Convenience: container → facts, with null meaning "format not scanned". */
export function exifFactsFrom(buf: Buffer): ExifFacts | null {
  const tiff = findTiff(buf);
  if (tiff === null) return null;
  return tiff.length === 0 ? NO_EXIF : parseExif(tiff);
}
