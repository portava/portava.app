/**
 * geotaggedImageFixtures — decodable JPEG / PNG / WebP stills that carry
 * location metadata in EVERY place a phone or an editor writes it, for the
 * tests that prove the upload pipeline removes it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Five test fixtures in this suite planted their GPS tags as
 * `sharp().withExif({ GPS: { ... } })`. sharp 0.35.3 has no `GPS` key — the
 * GPS IFD is `IFD3` — so those calls wrote an EXIF block with NO 0x8825 GPS
 * pointer at all (exifFacts.test.ts measured the same thing for its own
 * fixtures). Every "GPS must be stripped" assertion built on them passed
 * against an input that never carried GPS. The EXIF-block assertions next to
 * them were real, because IFD0 was planted; the GPS claim was not.
 *
 * So the bytes here are assembled by hand, independent of sharp's writer, and
 * each builder's output is checked by `fixtureCarries()` before any test may
 * rely on it. One still carries, at once:
 *
 *   - an EXIF APP1 / eXIf / EXIF chunk whose IFD0 points (0x8825) to a GPS IFD
 *     with version, both refs, latitude, longitude and a processing-method
 *     string holding GPS_SENTINEL; whose Exif sub-IFD (0x8769) carries a
 *     MakerNote (0x927C) holding MAKERNOTE_SENTINEL — maker notes are where
 *     some vendors write location of their own; and Orientation 6;
 *   - an XMP packet with exif:GPSLatitude / exif:GPSLongitude and a
 *     photoshop:City holding XMP_SENTINEL (JPEG APP1, PNG iTXt, WebP "XMP ");
 *   - JPEG only: an IPTC-IIM APP13 record 2:90 (City) holding IPTC_SENTINEL,
 *     a COM comment holding COMMENT_SENTINEL, and an APP11 (JUMBF / C2PA
 *     content-credentials carrier) payload holding JUMBF_SENTINEL;
 *   - PNG only: a tEXt "Comment" chunk holding COMMENT_SENTINEL.
 *
 * Coordinates are fixed (Da Nang, a launch city) and are never decoded by any
 * test: the strip is asserted by presence, never by reading a value back.
 *
 * Deliberately NOT a .test.ts file: importing one test file from another runs
 * its suites twice in the same process (see videoFixtures.ts).
 */
import sharp from "sharp";
import { exifFactsFrom } from "../lib/exifFacts.js";

export const GPS_SENTINEL = "PORTAVA_GPS_IFD_SENTINEL";
export const MAKERNOTE_SENTINEL = "PORTAVA_MAKERNOTE_SENTINEL";
export const XMP_SENTINEL = "PORTAVA_XMP_LOCATION_SENTINEL";
export const IPTC_SENTINEL = "PORTAVA_IPTC_CITY_SENTINEL";
export const COMMENT_SENTINEL = "PORTAVA_COMMENT_SENTINEL";
export const JUMBF_SENTINEL = "PORTAVA_JUMBF_SENTINEL";

/** Every sentinel a given container format carries. */
export const SENTINELS = {
  jpeg: [GPS_SENTINEL, MAKERNOTE_SENTINEL, XMP_SENTINEL, IPTC_SENTINEL, COMMENT_SENTINEL, JUMBF_SENTINEL],
  png: [GPS_SENTINEL, MAKERNOTE_SENTINEL, XMP_SENTINEL, COMMENT_SENTINEL],
  webp: [GPS_SENTINEL, MAKERNOTE_SENTINEL, XMP_SENTINEL],
} as const;

/** Number of entries the planted GPS IFD carries (exifFacts counts them). */
export const GPS_ENTRY_COUNT = 6;

// ── TIFF / EXIF ──────────────────────────────────────────────────────────────

const T_BYTE = 1;
const T_ASCII = 2;
const T_SHORT = 3;
const T_LONG = 4;
const T_RATIONAL = 5;
const T_UNDEFINED = 7;

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes in the TIFF's byte order. */
  bytes: Buffer;
}

function ifdSize(entries: IfdEntry[]): number {
  let data = 0;
  for (const e of entries) if (e.bytes.length > 4) data += e.bytes.length + (e.bytes.length % 2);
  return 2 + entries.length * 12 + 4 + data;
}

/** A complete TIFF block: IFD0 → Exif sub-IFD (MakerNote) and GPS IFD. */
export function buildGeotaggedTiff(opts: { le?: boolean; orientation?: number } = {}): Buffer {
  const le = opts.le ?? true;
  const u16 = (v: number) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(v) : b.writeUInt16BE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(v) : b.writeUInt32BE(v); return b; };
  const rationals = (pairs: Array<[number, number]>) => Buffer.concat(pairs.flatMap(([n, d]) => [u32(n), u32(d)]));
  const ascii = (s: string) => Buffer.from(`${s}\0`, "latin1");

  const makerNote = Buffer.from(`PORTAVA-CAM\0${MAKERNOTE_SENTINEL}\0location=16.0545,108.2022`, "latin1");
  const exifIfd: IfdEntry[] = [
    { tag: 0x9003, type: T_ASCII, count: 20, bytes: ascii("2026:10:14 09:30:00") },
    { tag: 0x927c, type: T_UNDEFINED, count: makerNote.length, bytes: makerNote },
  ];
  // GPSProcessingMethod is UNDEFINED with an 8-byte character-code prefix.
  const method = Buffer.concat([Buffer.from("ASCII\0\0\0", "latin1"), Buffer.from(GPS_SENTINEL, "latin1")]);
  const gpsIfd: IfdEntry[] = [
    { tag: 0x0000, type: T_BYTE, count: 4, bytes: Buffer.from([2, 3, 0, 0]) },
    { tag: 0x0001, type: T_ASCII, count: 2, bytes: ascii("N") },
    { tag: 0x0002, type: T_RATIONAL, count: 3, bytes: rationals([[16, 1], [3, 1], [1640, 100]]) },
    { tag: 0x0003, type: T_ASCII, count: 2, bytes: ascii("E") },
    { tag: 0x0004, type: T_RATIONAL, count: 3, bytes: rationals([[108, 1], [12, 1], [792, 100]]) },
    { tag: 0x001b, type: T_UNDEFINED, count: method.length, bytes: method },
  ];
  const ifd0: IfdEntry[] = [
    { tag: 0x0112, type: T_SHORT, count: 1, bytes: Buffer.concat([u16(opts.orientation ?? 6), Buffer.alloc(2)]) },
    { tag: 0x8769, type: T_LONG, count: 1, bytes: Buffer.alloc(4) }, // patched below
    { tag: 0x8825, type: T_LONG, count: 1, bytes: Buffer.alloc(4) }, // patched below
  ];

  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0);
  const gpsAt = exifAt + ifdSize(exifIfd);
  ifd0[1].bytes = u32(exifAt);
  ifd0[2].bytes = u32(gpsAt);

  const serialise = (entries: IfdEntry[], at: number): Buffer => {
    const head: Buffer[] = [u16(entries.length)];
    const data: Buffer[] = [];
    let dataAt = at + 2 + entries.length * 12 + 4;
    for (const e of entries) {
      head.push(u16(e.tag), u16(e.type), u32(e.count));
      if (e.bytes.length <= 4) {
        head.push(Buffer.concat([e.bytes, Buffer.alloc(4 - e.bytes.length)]));
      } else {
        head.push(u32(dataAt));
        const padded = e.bytes.length % 2 ? Buffer.concat([e.bytes, Buffer.alloc(1)]) : e.bytes;
        data.push(padded);
        dataAt += padded.length;
      }
    }
    head.push(u32(0)); // no next IFD
    return Buffer.concat([...head, ...data]);
  };

  const header = Buffer.concat([Buffer.from(le ? "II" : "MM", "latin1"), u16(42), u32(ifd0At)]);
  return Buffer.concat([header, serialise(ifd0, ifd0At), serialise(exifIfd, exifAt), serialise(gpsIfd, gpsAt)]);
}

/** An XMP packet carrying GPS coordinates and a city. */
export function geotaggedXmp(): string {
  return (
    `<?xpacket begin="\u{feff}" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" ` +
    `xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" ` +
    `exif:GPSLatitude="16,3.2733N" exif:GPSLongitude="108,12.132E" photoshop:City="${XMP_SENTINEL}"/>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

function jpegSegment(marker: number, payload: Buffer): Buffer {
  if (payload.length + 2 > 0xffff) throw new Error("JPEG segment too large");
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** IPTC-IIM inside a Photoshop 3.0 image-resource block (resource 0x0404). */
function iptcApp13(): Buffer {
  const city = Buffer.from(IPTC_SENTINEL, "latin1");
  const dataset = Buffer.concat([Buffer.from([0x1c, 0x02, 90]), Buffer.from([city.length >> 8, city.length & 0xff]), city]);
  const iim = dataset.length % 2 ? Buffer.concat([dataset, Buffer.alloc(1)]) : dataset;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(dataset.length);
  return Buffer.concat([
    Buffer.from("Photoshop 3.0\0", "latin1"),
    Buffer.from("8BIM", "latin1"),
    Buffer.from([0x04, 0x04]),
    Buffer.from([0x00, 0x00]), // empty Pascal name, padded to even
    size,
    iim,
  ]);
}

/**
 * A decodable JPEG with every location carrier listed in the header. The
 * segments are spliced in right after SOI, which is where a camera writes them.
 */
export async function geotaggedJpeg(opts: { width?: number; height?: number; le?: boolean } = {}): Promise<Buffer> {
  const base = await sharp({
    create: { width: opts.width ?? 640, height: opts.height ?? 480, channels: 3, background: "#3a5" },
  }).jpeg().toBuffer();
  const segments = Buffer.concat([
    jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), buildGeotaggedTiff({ le: opts.le })])),
    jpegSegment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(geotaggedXmp(), "utf8")])),
    jpegSegment(0xed, iptcApp13()),
    jpegSegment(0xeb, Buffer.concat([Buffer.from([0x4a, 0x50, 0x00, 0x01]), Buffer.from(`c2pa ${JUMBF_SENTINEL}`, "latin1")])),
    jpegSegment(0xfe, Buffer.from(`${COMMENT_SENTINEL} taken at 16.0545,108.2022`, "latin1")),
  ]);
  return Buffer.concat([base.subarray(0, 2), segments, base.subarray(2)]);
}

/**
 * Every marker segment before the first SOS, as `APPn` / `COM` / `DQT` …
 * names. Used to assert that an output JPEG carries NO application segment
 * other than the JFIF header — a parser-independent check that no metadata of
 * any kind (known or unknown to sharp) survived.
 */
export function jpegHeaderSegments(buf: Buffer): string[] {
  const out: string[] = [];
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error("not a JPEG");
  let p = 2;
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) throw new Error(`JPEG marker expected at ${p}`);
    const m = buf[p + 1];
    if (m === 0xd9) break;
    const len = buf.readUInt16BE(p + 2);
    const name =
      m >= 0xe0 && m <= 0xef ? `APP${m - 0xe0}${m === 0xe0 ? `:${buf.toString("latin1", p + 4, p + 8)}` : ""}` :
      m === 0xfe ? "COM" : m === 0xdb ? "DQT" : m === 0xc4 ? "DHT" : m === 0xdd ? "DRI" :
      m >= 0xc0 && m <= 0xcf ? `SOF${m - 0xc0}` : m === 0xda ? "SOS" : `0x${m.toString(16)}`;
    out.push(name);
    if (m === 0xda) break;
    p += 2 + len;
  }
  return out;
}

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** Every chunk type in a PNG, in order. */
export function pngChunkTypes(buf: Buffer): string[] {
  const out: string[] = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    out.push(type);
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}

/** A decodable PNG with eXIf (GPS IFD + MakerNote), iTXt XMP and a tEXt comment. */
export async function geotaggedPng(opts: { width?: number; height?: number } = {}): Promise<Buffer> {
  const base = await sharp({
    create: { width: opts.width ?? 320, height: opts.height ?? 240, channels: 3, background: "#c73" },
  }).png().toBuffer();
  const ihdrEnd = 8 + 12 + base.readUInt32BE(8);
  const itxt = Buffer.concat([
    Buffer.from("XML:com.adobe.xmp\0", "latin1"),
    Buffer.from([0, 0]), // uncompressed, method 0
    Buffer.from("\0\0", "latin1"), // empty language tag + empty translated keyword
    Buffer.from(geotaggedXmp(), "utf8"),
  ]);
  const chunks = Buffer.concat([
    pngChunk("eXIf", buildGeotaggedTiff({ le: false })),
    pngChunk("iTXt", itxt),
    pngChunk("tEXt", Buffer.from(`Comment\0${COMMENT_SENTINEL} taken at 16.0545,108.2022`, "latin1")),
  ]);
  return Buffer.concat([base.subarray(0, ihdrEnd), chunks, base.subarray(ihdrEnd)]);
}

// ── WebP ─────────────────────────────────────────────────────────────────────

function riffChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 4, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Every chunk FourCC in a RIFF/WEBP container, in order. */
export function webpChunkTypes(buf: Buffer): string[] {
  const out: string[] = [];
  let p = 12;
  while (p + 8 <= buf.length) {
    const type = buf.toString("latin1", p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    out.push(type);
    p += 8 + len + (len % 2);
  }
  return out;
}

/** A decodable extended-format (VP8X) WebP with EXIF (GPS IFD + MakerNote) and XMP chunks. */
export async function geotaggedWebp(opts: { width?: number; height?: number } = {}): Promise<Buffer> {
  const width = opts.width ?? 320;
  const height = opts.height ?? 240;
  const base = await sharp({ create: { width, height, channels: 3, background: "#257" } }).webp({ quality: 80 }).toBuffer();
  const types = webpChunkTypes(base);
  if (types.length !== 1 || types[0] !== "VP8 ") throw new Error(`expected a simple lossy WebP, got ${types.join(",")}`);
  const vp8 = base.subarray(12);
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08 | 0x04; // EXIF + XMP present
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    riffChunk("VP8X", vp8x),
    vp8,
    riffChunk("EXIF", buildGeotaggedTiff({ le: true })),
    riffChunk("XMP ", Buffer.from(geotaggedXmp(), "utf8")),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, 4, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

// ── Checks ───────────────────────────────────────────────────────────────────

export type StillFormat = "jpeg" | "png" | "webp";

/** Build the geotagged still for a format. */
export function geotagged(format: StillFormat, dims?: { width?: number; height?: number }): Promise<Buffer> {
  return format === "jpeg" ? geotaggedJpeg(dims) : format === "png" ? geotaggedPng(dims) : geotaggedWebp(dims);
}

/**
 * Throws unless the fixture really carries what this module claims: a GPS
 * IFD with all its entries (parsed by lib/exifFacts, which never reads a
 * value), XMP and — for JPEG — IPTC, as sharp's own parser sees them, and every
 * sentinel in the raw bytes. A test that skips this check can pass against an
 * input that never had metadata, which is the defect this file was written for.
 */
export async function fixtureCarries(buf: Buffer, format: StillFormat): Promise<void> {
  const facts = exifFactsFrom(buf);
  if (!facts?.hasGpsIfd) throw new Error(`${format} fixture: no GPS IFD (0x8825) — the fixture is vacuous`);
  if (facts.gpsEntryCount !== GPS_ENTRY_COUNT) throw new Error(`${format} fixture: GPS IFD has ${facts.gpsEntryCount} entries`);
  const meta = await sharp(buf).metadata();
  if (!meta.exif?.length) throw new Error(`${format} fixture: sharp sees no EXIF`);
  if (!meta.xmp?.length) throw new Error(`${format} fixture: sharp sees no XMP`);
  if (format === "jpeg" && !meta.iptc?.length) throw new Error("jpeg fixture: sharp sees no IPTC");
  if (meta.orientation !== 6) throw new Error(`${format} fixture: orientation ${meta.orientation}, expected 6`);
  for (const s of SENTINELS[format]) {
    if (!buf.includes(Buffer.from(s, "latin1"))) throw new Error(`${format} fixture: sentinel ${s} missing`);
  }
}

/** Container segments/chunks that may legitimately follow a full metadata strip. */
const ALLOWED = {
  jpeg: (s: string) => s === "APP0:JFIF" || /^(DQT|DHT|DRI|SOF\d+|SOS)$/.test(s),
  png: (s: string) => /^(IHDR|PLTE|IDAT|IEND|tRNS|gAMA|cHRM|sRGB|pHYs|sBIT|bKGD)$/.test(s),
  webp: (s: string) => /^(VP8 |VP8L|VP8X|ALPH)$/.test(s),
};

/**
 * Every way this suite knows to find surviving metadata in a stored object,
 * returned as a list of human-readable leaks (empty = clean). Asserting on the
 * list rather than throwing lets one test report every carrier that survived.
 */
export async function locationLeaks(out: Buffer): Promise<string[]> {
  const leaks: string[] = [];
  const meta = await sharp(out).metadata();
  const format = meta.format === "jpeg" ? "jpeg" : meta.format === "png" ? "png" : meta.format === "webp" ? "webp" : null;
  if (!format) return [`unexpected output format ${meta.format}`];
  if (meta.exif !== undefined) leaks.push("sharp: EXIF block present");
  if (meta.xmp !== undefined) leaks.push("sharp: XMP present");
  if (meta.iptc !== undefined) leaks.push("sharp: IPTC present");
  if (meta.comments !== undefined && meta.comments.length > 0) leaks.push("sharp: text comments present");
  if (meta.orientation !== undefined) leaks.push(`sharp: orientation tag ${meta.orientation} present`);
  const facts = exifFactsFrom(out);
  if (facts === null) leaks.push("exifFacts: container not scannable");
  else if (facts.hasExif) leaks.push(`exifFacts: EXIF present (GPS IFD: ${facts.hasGpsIfd})`);
  for (const s of [GPS_SENTINEL, MAKERNOTE_SENTINEL, XMP_SENTINEL, IPTC_SENTINEL, COMMENT_SENTINEL, JUMBF_SENTINEL]) {
    if (out.includes(Buffer.from(s, "latin1"))) leaks.push(`raw bytes: ${s}`);
  }
  if (out.includes(Buffer.from("108.2022", "latin1"))) leaks.push("raw bytes: planted decimal coordinate");
  const structure = format === "jpeg" ? jpegHeaderSegments(out) : format === "png" ? pngChunkTypes(out) : webpChunkTypes(out);
  for (const s of structure) if (!ALLOWED[format](s)) leaks.push(`container: ${format} carries ${JSON.stringify(s)}`);
  return leaks;
}
