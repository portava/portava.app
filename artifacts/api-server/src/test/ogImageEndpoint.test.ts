/**
 * ogImageEndpoint.test.ts
 *
 * GET /og/:type/:id/image.png — the server-rendered Open Graph image.
 *
 * The endpoint exists because a link-preview scraper cannot hydrate a signed
 * URL: Slack, iMessage and WhatsApp fetch one URL, unauthenticated, and never
 * run our JavaScript. So the server resolves the stored object itself.
 *
 * Two properties matter and both are asserted here:
 *
 *   1. A raw storage reference never leaves the process. The response is image
 *      bytes — not a redirect to a signed URL, which would expire and would
 *      hand the scraper a credential to cache.
 *   2. Private, blocked, missing, unknown-type and storage-failure outcomes are
 *      BYTE-IDENTICAL 200s. A different status, or a different image, would
 *      leak entity existence exactly as the cover photo would.
 *
 * Run: node --import tsx/esm --test src/test/ogImageEndpoint.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http, { createServer } from "node:http";
import express from "express";
import { _setTestServiceClient } from "../lib/supabase.js";
import ogRouter from "../routes/og.js";

const ALICE_ID   = "aa000000-0000-4000-a000-000000000001";
const PUB_EVENT  = "ee000000-0000-4000-a000-000000000010";
const PRIV_EVENT = "ee000000-0000-4000-a000-000000000011";
const ABSENT_EVENT = "ee000000-0000-4000-a000-0000000000ff";
const PUB_TRIP   = "ff000000-0000-4000-a000-000000000020";
const EXTERNAL_EVENT = "ee000000-0000-4000-a000-000000000012";
const BROKEN_EVENT   = "ee000000-0000-4000-a000-000000000013";

/** The bare `<bucket>/<path>` shape the upload endpoints write today. */
const COVER_REF = "post-media/covers/festival.jpg";
const TRIP_COVER_REF = "post-media/covers/japan.jpg";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EVENTS = [
  { id: PUB_EVENT, title: "Beach Festival", description: "Music by the sea.", city: "Lisbon", country: "Portugal", visibility: "public", host_id: ALICE_ID, state: "published", cover_url: COVER_REF },
  { id: PRIV_EVENT, title: "Secret Rooftop Party", description: "Exclusive.", city: "Porto", country: "Portugal", visibility: "invite_only", host_id: ALICE_ID, state: "published", cover_url: COVER_REF },
  // cover_url is written from a client-supplied field and is NOT validated
  // against our buckets on write — an external host must never be fetched.
  { id: EXTERNAL_EVENT, title: "Linked Cover", description: "Elsewhere.", city: "Madrid", country: "Spain", visibility: "public", host_id: ALICE_ID, state: "published", cover_url: "https://cdn.example.com/events/remote.jpg" },
  { id: BROKEN_EVENT, title: "Missing Object", description: "Gone.", city: "Rome", country: "Italy", visibility: "public", host_id: ALICE_ID, state: "published", cover_url: "post-media/covers/gone.jpg" },
];

const TRIPS = [
  { id: PUB_TRIP, title: "Summer in Japan", destination_city: "Tokyo", destination_country: "Japan", visibility: "public", owner_id: ALICE_ID, cover_url: TRIP_COVER_REF, show_destination_city: true },
];

/** Records every storage object the route asked for. */
let downloadCalls: Array<{ bucket: string; path: string }> = [];

/** A real 4-pixel JPEG, so sharp has genuine bytes to re-encode. */
let SOURCE_IMAGE: Buffer;

function makeClient() {
  const table = (rows: any[]) => {
    const filters: Array<(r: any) => boolean> = [];
    const b: any = {
      select: () => b,
      eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return b; },
      or: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      then: (onF: any) => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }).then(onF),
    };
    return b;
  };

  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: "no token" } }) },
    from: (name: string) => {
      if (name === "events") return table(EVENTS);
      if (name === "trips") return table(TRIPS);
      return table([]);
    },
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          downloadCalls.push({ bucket, path });
          if (path.endsWith("gone.jpg")) return { data: null, error: { message: "Object not found" } };
          return { data: { arrayBuffer: async () => SOURCE_IMAGE }, error: null };
        },
      }),
    },
  };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function getBinary(
  server: ReturnType<typeof createServer>,
  path: string,
): Promise<{ status: number; contentType: string; cacheControl: string; location: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as import("net").AddressInfo;
    const r = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          cacheControl: String(res.headers["cache-control"] ?? ""),
          location: String(res.headers["location"] ?? ""),
          body: Buffer.concat(chunks),
        }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

let server: ReturnType<typeof createServer>;

before(async () => {
  const sharp = (await import("sharp")).default;
  SOURCE_IMAGE = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 40, b: 40 } },
  }).jpeg().toBuffer();

  const app = express();
  app.use((req: any, _res, next) => { req.log = { info() {}, warn() {}, error() {} }; next(); });
  _setTestServiceClient(makeClient() as any);
  app.use("/", ogRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestServiceClient(null as any);
});

async function pngSize(buf: Buffer): Promise<{ width?: number; height?: number; format?: string }> {
  const sharp = (await import("sharp")).default;
  const m = await sharp(buf).metadata();
  return { width: m.width, height: m.height, format: m.format };
}

// ── A: the image is served as bytes, never as a storage URL ───────────────────

describe("A: the endpoint serves image bytes, never a storage URL", () => {
  it("a public event returns a 1200x630 PNG resolved from its stored cover", async () => {
    downloadCalls = [];
    const r = await getBinary(server, `/og/event/${PUB_EVENT}/image.png`);

    assert.equal(r.status, 200, "must be 200");
    assert.equal(r.contentType, "image/png", `expected image/png, got ${r.contentType}`);

    const meta = await pngSize(r.body);
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 1200, "OG cards are 1200 wide");
    assert.equal(meta.height, 630, "OG cards are 630 tall");

    assert.deepEqual(
      downloadCalls,
      [{ bucket: "post-media", path: "covers/festival.jpg" }],
      "the bare bucket/path cover must be downloaded server-side through the service client",
    );
  });

  it("never redirects — a redirect would hand the scraper an expiring signed URL", async () => {
    const r = await getBinary(server, `/og/event/${PUB_EVENT}/image.png`);
    assert.ok(r.status < 300 || r.status >= 400, `must not be a redirect, got ${r.status}`);
    assert.equal(r.location, "", "must not send a Location header");
  });

  it("the response body contains no storage reference of any kind", async () => {
    const r = await getBinary(server, `/og/event/${PUB_EVENT}/image.png`);
    const asText = r.body.toString("latin1");
    for (const needle of ["post-media", "covers/festival.jpg", "/storage/v1/", "token="]) {
      assert.ok(!asText.includes(needle), `rendered PNG must not embed ${needle}`);
    }
  });

  it("a public trip resolves its own cover", async () => {
    downloadCalls = [];
    const r = await getBinary(server, `/og/trip/${PUB_TRIP}/image.png`);
    assert.equal(r.status, 200);
    assert.deepEqual(downloadCalls, [{ bucket: "post-media", path: "covers/japan.jpg" }]);
  });
});

// ── B: every non-public outcome is the same generic card ──────────────────────

describe("B: private, missing, unknown and broken all return the identical generic card", () => {
  it("a private event returns the generic card and never touches storage", async () => {
    downloadCalls = [];
    const r = await getBinary(server, `/og/event/${PRIV_EVENT}/image.png`);

    assert.equal(r.status, 200, "must be 200, not 403/404 — a status difference leaks existence");
    assert.equal(r.contentType, "image/png");
    assert.deepEqual(downloadCalls, [], "a private event's cover must never be read");
  });

  it("private, absent, unknown-type and unresolvable-object responses are byte-identical", async () => {
    const priv     = await getBinary(server, `/og/event/${PRIV_EVENT}/image.png`);
    const absent   = await getBinary(server, `/og/event/${ABSENT_EVENT}/image.png`);
    const unknown  = await getBinary(server, `/og/place/${PUB_EVENT}/image.png`);
    const external = await getBinary(server, `/og/event/${EXTERNAL_EVENT}/image.png`);
    const broken   = await getBinary(server, `/og/event/${BROKEN_EVENT}/image.png`);

    for (const [name, r] of Object.entries({ absent, unknown, external, broken })) {
      assert.equal(r.status, 200, `${name} must be 200`);
      assert.ok(
        r.body.equals(priv.body),
        `${name} must return the same bytes as a private entity — any difference distinguishes the two`,
      );
    }
  });

  it("the generic card is a valid 1200x630 PNG, not an empty body", async () => {
    const r = await getBinary(server, `/og/event/${PRIV_EVENT}/image.png`);
    const meta = await pngSize(r.body);
    assert.equal(meta.format, "png");
    assert.equal(meta.width, 1200);
    assert.equal(meta.height, 630);
  });
});

// ── C: SSRF — a client-written cover_url must not become an outbound fetch ────

describe("C: an external cover_url is never fetched", () => {
  it("an https cover on a foreign host renders the generic card and touches no storage", async () => {
    downloadCalls = [];
    const r = await getBinary(server, `/og/event/${EXTERNAL_EVENT}/image.png`);

    assert.equal(r.status, 200);
    assert.deepEqual(
      downloadCalls,
      [],
      "cover_url is client-written and unvalidated on write — a foreign host must never be dereferenced",
    );
  });
});

// ── D: cache headers ──────────────────────────────────────────────────────────

describe("D: cache headers match how long each render stays truthful", () => {
  it("a resolved cover is no-store so a visibility flip stops serving it quickly", async () => {
    const r = await getBinary(server, `/og/event/${PUB_EVENT}/image.png`);
    assert.match(r.cacheControl, /no-store/, `expected no-store, got: ${r.cacheControl}`);
  });

  it("the generic card carries no entity data and is cacheable", async () => {
    const r = await getBinary(server, `/og/event/${PRIV_EVENT}/image.png`);
    assert.match(r.cacheControl, /max-age=600/, `expected a public cache, got: ${r.cacheControl}`);
  });
});
