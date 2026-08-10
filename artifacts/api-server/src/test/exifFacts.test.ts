/**
 * exifFacts — the EXIF/GPS presence parser behind `audit:storage-exif`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The audit script it serves cannot be run here or in CI: it reads live
 * Storage, and the only Supabase project this repo can reach is the one
 * live-db.yml names as KNOWN_PROD_PROJECT_REF, which ciSupabaseGuard refuses.
 * So the parser is the only part of the audit that can be proven, and proving
 * it is the difference between "we built an audit" and "we know what the audit
 * would say". Every number the census reports — EXIF count, GPS count, date
 * range — is this file's output, aggregated.
 *
 * WHY THE FIXTURES ARE HAND-BUILT AND NOT MADE WITH sharp
 * -------------------------------------------------------
 * sharp was the obvious fixture source and is the wrong one. Verified against
 * sharp 0.35.3 here: `.withExif({ GPS: {...} })` writes NO GPS IFD at all — the
 * resulting IFD0 has no 0x8825 entry — and `.withExif({ Exif: { DateTimeOriginal }})`
 * drops 0x9003 too. A fixture built that way would make the GPS test pass
 * vacuously by never containing the thing under test. So the TIFF is assembled
 * byte by byte below, which also lets both byte orders be exercised: EXIF is
 * either "II" or "MM", real cameras emit both, and an offset bug that only
 * shows up in big-endian is exactly the bug that under-reports a GPS census.
 *
 * THE LEAK TEST IS THE POINT
 * --------------------------
 * `never prints a coordinate` is not a style rule, it is the requirement the
 * audit exists under: a terminal log or CI artifact carrying real capture
 * coordinates is a worse leak than the EXIF being measured. The fixture plants
 * a distinctive digit run in the latitude seconds field and the test asserts it
 * appears NOWHERE in the serialised facts. That fails the moment someone adds a
 * "just for debugging" value read to the GPS walk — the change that would
 * otherwise pass review precisely because it makes the output more useful.
 *
 * NON-VACUOUSNESS — VERIFIED, NOT ASSUMED
 * ---------------------------------------
 * Each claim was confirmed by breaking exifFacts.ts and watching the right test
 * go red, then restoring to 10/10:
 *
 *   1. `if (tag === 0x8825)` disabled → both GPS tests and the ranged-read test
 *      fail; "carries EXIF" stays GREEN. That green is the point: it is exactly
 *      the shape of the old backfillFeedVariants --audit-exif flag, which
 *      reported EXIF presence while seeing nothing about GPS.
 *   2. findTiff returning `Buffer.alloc(0)` instead of `null` for an unknown
 *      container → only "UNSCANNED, never clean" fails. That is the failure
 *      that would make a census under-report by silently counting unreadable
 *      objects as clean ones.
 *   3. a GPS value dereferenced into a reported field → both leak tests fail.
 *      Worth recording: the FIRST attempted break wrote the leaked value into
 *      the DateTime variable, where DateTimeOriginal overwrote it before output
 *      — the leak tests stayed green and the date test failed instead. A leak
 *      only trips these assertions if it survives into the returned object, so
 *      the assertion is on the serialised result rather than on any intermediate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findTiff, parseExif, exifFactsFrom, NO_EXIF } from "../lib/exifFacts.js";

/** Distinctive digit run planted in the GPS latitude seconds. Must never surface. */
const COORD_SENTINEL = 3733;

const TYPE_ASCII = 2;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;

interface FixtureOpts {
  le?: boolean;
  withGps?: boolean;
  withDto?: boolean;
}

/** Assemble a TIFF block containing exactly the tags the parser claims to read. */
function buildTiff({ le = true, withGps = true, withDto = true }: FixtureOpts = {}): Buffer {
  const w16 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));

  const copyright = Buffer.from("fixture\0", "latin1");
  const dateTime = Buffer.from("2020:01:02 03:04:05\0", "latin1");
  const dto = Buffer.from("2021:07:14 09:30:00\0", "latin1");

  const rational = (pairs: Array<[number, number]>): Buffer => {
    const b = Buffer.alloc(pairs.length * 8);
    pairs.forEach(([n, d], i) => {
      w32(b, i * 8, n);
      w32(b, i * 8 + 4, d);
    });
    return b;
  };
  const lat = rational([[51, 1], [30, 1], [COORD_SENTINEL, 100]]);
  const lon = rational([[0, 1], [7, 1], [2500, 100]]);

  const n0 = 2 + (withDto ? 1 : 0) + (withGps ? 1 : 0);
  const ifd0Off = 8;
  const exifOff = ifd0Off + 2 + n0 * 12 + 4;
  const exifSize = withDto ? 2 + 12 + 4 : 0;
  const gpsOff = exifOff + exifSize;
  const nGps = 4;
  const gpsSize = withGps ? 2 + nGps * 12 + 4 : 0;
  const dataOff = gpsOff + gpsSize;

  const dataParts: Buffer[] = [];
  let cursor = dataOff;
  const put = (buf: Buffer): number => {
    const at = cursor;
    dataParts.push(buf);
    cursor += buf.length;
    return at;
  };
  const copyrightAt = put(copyright);
  const dateTimeAt = put(dateTime);
  const dtoAt = withDto ? put(dto) : 0;
  const latAt = withGps ? put(lat) : 0;
  const lonAt = withGps ? put(lon) : 0;

  const b = Buffer.alloc(cursor);
  b.write(le ? "II" : "MM", 0, "latin1");
  w16(b, 2, 42);
  w32(b, 4, ifd0Off);

  w16(b, ifd0Off, n0);
  let e = ifd0Off + 2;
  const entry = (tag: number, type: number, count: number, value: number) => {
    w16(b, e, tag);
    w16(b, e + 2, type);
    w32(b, e + 4, count);
    w32(b, e + 8, value);
    e += 12;
  };
  entry(0x8298, TYPE_ASCII, copyright.length, copyrightAt);
  entry(0x0132, TYPE_ASCII, dateTime.length, dateTimeAt);
  if (withDto) entry(0x8769, TYPE_LONG, 1, exifOff);
  if (withGps) entry(0x8825, TYPE_LONG, 1, gpsOff);
  w32(b, e, 0);

  if (withDto) {
    w16(b, exifOff, 1);
    const se = exifOff + 2;
    w16(b, se, 0x9003);
    w16(b, se + 2, TYPE_ASCII);
    w32(b, se + 4, dto.length);
    w32(b, se + 8, dtoAt);
    w32(b, se + 12, 0);
  }

  if (withGps) {
    w16(b, gpsOff, nGps);
    let ge = gpsOff + 2;
    const gpsEntry = (tag: number, type: number, count: number, value: number, ascii?: string) => {
      w16(b, ge, tag);
      w16(b, ge + 2, type);
      w32(b, ge + 4, count);
      if (ascii) b.write(ascii, ge + 8, "latin1");
      else w32(b, ge + 8, value);
      ge += 12;
    };
    gpsEntry(0x0001, TYPE_ASCII, 2, 0, "N\0");
    gpsEntry(0x0002, TYPE_RATIONAL, 3, latAt);
    gpsEntry(0x0003, TYPE_ASCII, 2, 0, "W\0");
    gpsEntry(0x0004, TYPE_RATIONAL, 3, lonAt);
    w32(b, ge, 0);
  }

  let p = dataOff;
  for (const part of dataParts) {
    part.copy(b, p);
    p += part.length;
  }
  return b;
}

/** Wrap a TIFF block in a minimal JPEG APP1 segment. */
function jpegWith(tiff: Buffer): Buffer {
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const lenB = Buffer.alloc(2);
  lenB.writeUInt16BE(app1.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
    lenB,
    app1,
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(64),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A JPEG with no APP1/EXIF segment at all — the post-strip shape. */
function jpegStripped(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.alloc(64),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe("exifFacts — presence and counts, never values", () => {
  for (const le of [true, false]) {
    const order = le ? "little-endian (II)" : "big-endian (MM)";

    it(`detects a GPS IFD and counts its entries — ${order}`, () => {
      const facts = exifFactsFrom(jpegWith(buildTiff({ le })));
      assert.ok(facts, "JPEG must be a scannable container");
      assert.equal(facts.hasExif, true, "fixture carries EXIF");
      assert.equal(facts.hasGpsIfd, true, "fixture carries a GPS IFD (tag 0x8825)");
      assert.equal(facts.gpsEntryCount, 4, "all four planted GPS tags must be counted");
    });

    it(`NEVER materialises a coordinate anywhere in its output — ${order}`, () => {
      const facts = exifFactsFrom(jpegWith(buildTiff({ le })));
      assert.ok(facts);
      const serialised = JSON.stringify(facts);
      assert.ok(
        !serialised.includes(String(COORD_SENTINEL)),
        `planted coordinate digits (${COORD_SENTINEL}) must not appear in the facts: ${serialised}`,
      );
      assert.deepEqual(
        Object.keys(facts).sort(),
        ["captureTs", "gpsEntryCount", "hasExif", "hasGpsIfd"],
        "fact shape must stay closed — a new field is how a value escapes",
      );
    });
  }

  it("separates 'carries EXIF' from 'carries GPS' — the old flag's blind spot", () => {
    const facts = exifFactsFrom(jpegWith(buildTiff({ withGps: false })));
    assert.ok(facts);
    assert.equal(facts.hasExif, true, "EXIF is present");
    assert.equal(facts.hasGpsIfd, false, "but no GPS IFD — the two must not be conflated");
    assert.equal(facts.gpsEntryCount, 0);
  });

  it("prefers DateTimeOriginal, falling back to DateTime", () => {
    const withDto = exifFactsFrom(jpegWith(buildTiff({})));
    assert.equal(withDto?.captureTs, "2021-07-14T09:30:00Z", "0x9003 wins when present");

    const noDto = exifFactsFrom(jpegWith(buildTiff({ withDto: false })));
    assert.equal(noDto?.captureTs, "2020-01-02T03:04:05Z", "falls back to IFD0 0x0132");
  });

  it("reports a stripped JPEG as clean, not as unscanned", () => {
    const buf = jpegStripped();
    assert.equal(findTiff(buf)?.length, 0, "container understood, no EXIF segment");
    assert.deepEqual(exifFactsFrom(buf), NO_EXIF);
  });

  it("reports an unknown container as UNSCANNED, never as clean", () => {
    const notAnImage = Buffer.from("this is not an image file at all", "latin1");
    assert.equal(findTiff(notAnImage), null, "unknown container must be null");
    assert.equal(
      exifFactsFrom(notAnImage),
      null,
      "null is what makes the census count it unscanned rather than clean",
    );
  });

  it("still finds EXIF in a header-only (ranged) read", () => {
    // The audit fetches bytes 0..128KB, never the whole object. Truncating to
    // just past the APP1 segment proves the parser does not need the pixels.
    const full = jpegWith(buildTiff({}));
    const head = full.slice(0, full.length - 40);
    const facts = exifFactsFrom(head);
    assert.ok(facts, "truncated JPEG header must still be scannable");
    assert.equal(facts.hasGpsIfd, true, "GPS detection must survive a ranged read");
  });

  it("rejects a TIFF block with no byte-order mark rather than guessing", () => {
    assert.deepEqual(parseExif(Buffer.from("XX\0\0\0\0\0\0", "latin1")), NO_EXIF);
    assert.deepEqual(parseExif(Buffer.alloc(4)), NO_EXIF, "too short to be a TIFF header");
  });
});
