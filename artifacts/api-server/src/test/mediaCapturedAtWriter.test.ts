/**
 * media_assets.captured_at — the column that had no writer (Wall §16, Media §6).
 *
 * WHAT WAS WRONG
 * --------------
 * `captured_at` existed on media_assets, `RecordAssetInput.capturedAt` existed,
 * the provenance + evidence-eligibility computation read it, and the Wall's §16
 * "two clocks" producer (`loadCapturedAtByEntity`) joined to it — but BOTH
 * production callers of `recordMediaAsset` omitted the field. The column had no
 * writer at all, so `experienceAt` could never differ from `publishedAt` and
 * every Wall consumer took the `?? publishedAt` fallback forever. A read path
 * with no writer is not a feature; it is a shape.
 *
 * POST /media/upload already holds the raw bytes and already parses their EXIF
 * (lib/exifFacts, the parser behind `audit:storage-exif`, which reads
 * DateTimeOriginal/DateTime and is structurally incapable of producing a
 * coordinate). It now reads the capture instant from the RAW buffer — before
 * processImage strips the metadata — and passes it down.
 *
 * MUTATION PROOF (verified: revert → RED, restore → GREEN)
 *   • remove `capturedAt` from the recordMediaAsset call in routes/posts.ts →
 *     "the upload route supplies captured_at" RED, everything else GREEN.
 *   • read the EXIF from the PROCESSED buffer instead of `rawBody` → same test
 *     RED (the strip has already removed it by then).
 *   • drop the plausibility window from capturedAtFromImageBytes → the
 *     wrong-decade and future-date tests RED.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import sharp from "sharp";
import {
  capturedAtFromImageBytes,
  EARLIEST_PLAUSIBLE_CAPTURE_ISO,
  CAPTURE_CLOCK_SKEW_MS,
} from "../lib/mediaAssets.js";
import { _setTestClient, _clearTestClient, _setTestServiceClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";

// ── The extractor ─────────────────────────────────────────────────────────────

/** Wrap a hand-built TIFF block in a minimal JPEG APP1 segment. */
function jpegWithExifDate(dateTime: string): Buffer {
  const ascii = Buffer.from(`${dateTime}\0`, "latin1");
  // IFD0 with one entry: DateTime (0x0132), ASCII, pointing past the IFD.
  const ifd0Off = 8;
  const entries = 1;
  const dataOff = ifd0Off + 2 + entries * 12 + 4;
  const tiff = Buffer.alloc(dataOff + ascii.length);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Off, 4);
  tiff.writeUInt16LE(entries, ifd0Off);
  tiff.writeUInt16LE(0x0132, ifd0Off + 2);
  tiff.writeUInt16LE(2, ifd0Off + 4); // ASCII
  tiff.writeUInt32LE(ascii.length, ifd0Off + 6);
  tiff.writeUInt32LE(dataOff, ifd0Off + 10);
  tiff.writeUInt32LE(0, ifd0Off + 2 + entries * 12);
  ascii.copy(tiff, dataOff);

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

const NOW = new Date("2026-09-01T12:00:00.000Z");

describe("capturedAtFromImageBytes — the §6 clock", () => {
  it("reads DateTime out of a JPEG's EXIF block", () => {
    const out = capturedAtFromImageBytes(jpegWithExifDate("2026:07:14 09:30:00"), NOW);
    assert.equal(out, "2026-07-14T09:30:00.000Z");
  });

  it("is null when the image carries no EXIF at all", () => {
    const bare = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xda, 0x00, 0x02]),
      Buffer.alloc(64),
      Buffer.from([0xff, 0xd9]),
    ]);
    assert.equal(capturedAtFromImageBytes(bare, NOW), null);
  });

  it("is null for a container exifFacts does not scan, rather than guessing", () => {
    assert.equal(capturedAtFromImageBytes(Buffer.from("not an image at all"), NOW), null);
  });

  it("refuses a wrong-decade date (a dead camera clock)", () => {
    // Derived from the gate's own constant, so the fixture cannot drift away
    // from the bound it is meant to sit outside.
    const earliest = new Date(Date.parse(EARLIEST_PLAUSIBLE_CAPTURE_ISO) - 24 * 3600_000);
    const stamp = earliest.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
    assert.equal(capturedAtFromImageBytes(jpegWithExifDate(stamp), NOW), null);
  });

  it("refuses a date beyond the clock-skew allowance", () => {
    const tooFar = new Date(NOW.getTime() + CAPTURE_CLOCK_SKEW_MS + 60_000);
    const stamp = tooFar.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
    assert.equal(capturedAtFromImageBytes(jpegWithExifDate(stamp), NOW), null);

    // Control: just INSIDE the allowance is accepted — EXIF has no timezone, so
    // a photo taken "now" in a far-east zone legitimately reads ahead of us.
    const justInside = new Date(NOW.getTime() + CAPTURE_CLOCK_SKEW_MS - 60_000);
    const okStamp = justInside.toISOString().slice(0, 19).replace(/-/g, ":").replace("T", " ");
    assert.ok(capturedAtFromImageBytes(jpegWithExifDate(okStamp), NOW));
  });
});

// ── The route supplies it ─────────────────────────────────────────────────────

const TOKEN = "tok";
const USER_ID = "user-1";

let server: http.Server;
let base = "";

function upload(body: Buffer, contentType: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + "/api/media/upload");
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": contentType,
          "content-length": String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: any = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function makeClient(flags: Record<string, boolean>) {
  const inserted: Array<{ table: string; row: any }> = [];
  function builder(table: string) {
    const eqs: Record<string, unknown> = {};
    let pending: any = null;
    const b: any = {
      select: () => b,
      insert: (row: any) => {
        pending = row;
        inserted.push({ table, row });
        return b;
      },
      upsert: (row: any) => {
        pending = row;
        inserted.push({ table, row });
        return b;
      },
      update: () => b,
      eq: (c: string, v: unknown) => {
        eqs[c] = v;
        return b;
      },
      in: () => b, is: () => b, not: () => b, or: () => b,
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      order: () => b, limit: () => b, range: () => b,
      maybeSingle: () =>
        Promise.resolve(
          table === "feature_flags"
            ? { data: { enabled: flags[String(eqs.flag)] === true }, error: null }
            : { data: null, error: null },
        ),
      single: () =>
        Promise.resolve(
          pending
            ? { data: { id: "asset-1", ...pending }, error: null }
            : table === "feature_flags"
              ? { data: { enabled: flags[String(eqs.flag)] === true }, error: null }
              : { data: null, error: null },
        ),
      then: (onF: any, onR: any) =>
        Promise.resolve(
          table === "feature_flags"
            ? { data: { enabled: flags[String(eqs.flag)] === true }, error: null }
            : { data: [], error: null },
        ).then(onF, onR),
    };
    return b;
  }
  const client: any = {
    from: builder,
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string) {
            return { data: { path }, error: null };
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `${bucket}/${path}` } };
          },
          async remove(paths: string[]) {
            return { data: paths, error: null };
          },
        };
      },
    },
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    _inserted: inserted,
  };
  return client;
}

/** Wait for the fire-and-forget recordMediaAsset dual-write to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r));
}

describe("POST /api/media/upload — supplies captured_at to the canonical write", () => {
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => {
      r.log = { error() {}, info() {}, warn() {}, debug() {} };
      next();
    });
    app.use("/api", postsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("writes the EXIF capture instant into media_assets.captured_at", async () => {
    const client = makeClient({ media_canonical_enabled: true });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    // A REAL, decodable JPEG carrying a DateTimeOriginal — sharp must be able to
    // process it, and processImage must strip the EXIF from what gets stored.
    const withExif = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#3a5" },
    })
      .jpeg()
      // IFD2 is the EXIF SubIFD, where a real camera puts DateTimeOriginal —
      // so this also exercises exifFacts' 0x8769 pointer path, not just IFD0.
      .withExif({ IFD2: { DateTimeOriginal: "2026:03:04 05:06:07" } } as any)
      .toBuffer();

    const res = await upload(withExif, "image/jpeg");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await settle();

    const asset = client._inserted.find((i: any) => i.table === "media_assets");
    assert.ok(asset, "the canonical dual-write must run with media_canonical_enabled on");
    assert.equal(
      asset.row.captured_at,
      "2026-03-04T05:06:07.000Z",
      "captured_at must carry the EXIF capture instant, not null and not the upload time",
    );
  });

  it("leaves captured_at null for an image with no EXIF date — the honest unknown", async () => {
    const client = makeClient({ media_canonical_enabled: true });
    _setTestClient(client, true);
    _setTestServiceClient(client);

    const plain = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#123" },
    })
      .jpeg()
      .toBuffer();

    const res = await upload(plain, "image/jpeg");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await settle();

    const asset = client._inserted.find((i: any) => i.table === "media_assets");
    assert.ok(asset);
    assert.equal(asset.row.captured_at, null);
  });
});
