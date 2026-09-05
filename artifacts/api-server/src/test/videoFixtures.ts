/**
 * videoFixtures — synthetic ISO-BMFF / Matroska buffers for the video
 * location-metadata tests.
 *
 * These are hand-built containers, not recordings: the point is to reproduce
 * the exact boxes a phone writes (`moov/udta/©xyz`, and Apple's
 * `moov/meta` + `keys` = `com.apple.quicktime.location.ISO6709`) around a
 * recognisable `mdat` payload, so a test can prove both that the coordinates
 * are gone AND that nothing else in the file moved.
 *
 * Deliberately NOT a .test.ts file: importing one test file from another runs
 * its suites twice in the same process.
 */

/** ISO-6709 coordinate string a phone writes into `©xyz` (San Francisco). */
export const FIXTURE_ISO6709 = "+37.7749-122.4194+010.000/";

/** Build one ISO-BMFF box: 4-byte size, 4-byte type, payload. */
export function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** `©xyz` — the QuickTime/3GPP location box (2-byte length, 2-byte lang, text). */
export function xyzBox(coords: string = FIXTURE_ISO6709): Buffer {
  const text = Buffer.from(coords, "latin1");
  const head = Buffer.alloc(4);
  head.writeUInt16BE(text.length, 0);
  head.writeUInt16BE(0x15c7, 2); // packed lang code, as QuickTime writes it
  return box("©xyz", Buffer.concat([head, text]));
}

/** Apple-style `meta` box whose `keys` table names the location key. */
export function appleLocationMetaBox(): Buffer {
  const hdlr = box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("mdta", "latin1"), Buffer.alloc(12)]));
  const keyName = Buffer.from("com.apple.quicktime.location.ISO6709", "latin1");
  const keyEntry = Buffer.concat([
    (() => { const b = Buffer.alloc(8); b.writeUInt32BE(8 + keyName.length, 0); b.write("mdta", 4, 4, "latin1"); return b; })(),
    keyName,
  ]);
  const keysPayload = Buffer.concat([
    Buffer.alloc(4),                                            // version + flags
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1, 0); return b; })(), // entry count
    keyEntry,
  ]);
  const value = box("data", Buffer.concat([Buffer.alloc(8), Buffer.from(FIXTURE_ISO6709, "latin1")]));
  const ilstEntry = (() => {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(8 + value.length, 0);
    b.writeUInt32BE(1, 4); // ilst children are keyed by INDEX into `keys`
    return Buffer.concat([b, value]);
  })();
  // `meta` carries a 4-byte version/flags before its children.
  return box("meta", Buffer.concat([
    Buffer.alloc(4),
    hdlr,
    box("keys", keysPayload),
    box("ilst", ilstEntry),
  ]));
}

export interface Mp4FixtureOptions {
  /** Include `moov/udta/©xyz`. Default true. */
  xyz?: boolean;
  /** Include the Apple location `meta` box under `moov`. Default true. */
  appleMeta?: boolean;
}

/**
 * A minimal but structurally real MP4: `ftyp`, a recognisable `mdat`, and a
 * `moov` carrying the requested location metadata plus an unrelated `©nam`
 * box (so a test can prove the scrub is targeted, not a blanket wipe).
 */
export function mp4WithLocation(opts: Mp4FixtureOptions = {}): Buffer {
  const { xyz = true, appleMeta = true } = opts;
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from("isom", "latin1"),
    Buffer.alloc(4),
    Buffer.from("isomiso2mp41", "latin1"),
  ]));
  const mdat = box("mdat", Buffer.from("PORTAVA-SAMPLE-VIDEO-PAYLOAD-DO-NOT-TOUCH", "latin1"));
  const udtaChildren: Buffer[] = [box("©nam", Buffer.from("holiday clip", "latin1"))];
  if (xyz) udtaChildren.push(xyzBox());
  const moovChildren: Buffer[] = [
    box("mvhd", Buffer.alloc(100)),
    box("udta", Buffer.concat(udtaChildren)),
  ];
  if (appleMeta) moovChildren.push(appleLocationMetaBox());
  const moov = box("moov", Buffer.concat(moovChildren));
  return Buffer.concat([ftyp, mdat, moov]);
}

/** A WebM/Matroska buffer whose tag block names geo coordinates. */
export function webmWithLocationTag(): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // EBML header magic
    Buffer.alloc(32),
    Buffer.from("LATITUDE", "latin1"),
    Buffer.from("37.7749", "latin1"),
    Buffer.from("LONGITUDE", "latin1"),
    Buffer.from("-122.4194", "latin1"),
    Buffer.alloc(32),
  ]);
}

/** A WebM/Matroska buffer with no geo tag at all. */
export function webmWithoutLocationTag(): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc(64),
    Buffer.from("TITLE", "latin1"),
    Buffer.from("holiday clip", "latin1"),
    Buffer.alloc(32),
  ]);
}
