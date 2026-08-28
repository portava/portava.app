/**
 * backfillPlacePhotos — operator-run bulk warming of the discovery photo store.
 *
 * Proves: arg parsing + the ruling-ack guard shape; Google resolution degrades to
 * null on every failure; the pass is idempotent (never overwrites a warmed row),
 * honours --dry-run, and writes Google rows as a RESOURCE NAME through the store.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs, resolveGooglePhotoName, runBackfill, type BackfillDeps,
} from "../scripts/backfillPlacePhotos.js";

describe("backfillPlacePhotos — parseArgs + ruling guard", () => {
  it("requires the explicit confirm flag (refuses to run without it)", () => {
    assert.equal(parseArgs(["--city", "Da Nang"]).confirmed, false);
    assert.equal(parseArgs(["--city", "Da Nang", "--confirm-bulk-prepopulation"]).confirmed, true);
  });
  it("parses city/limit/delay and defaults sensibly", () => {
    const a = parseArgs(["--city", "Da Nang", "--limit", "500", "--delay-ms", "100", "--dry-run"]);
    assert.equal(a.city, "Da Nang"); assert.equal(a.limit, 500); assert.equal(a.delayMs, 100); assert.equal(a.dryRun, true);
    const d = parseArgs(["--city", "Hoi An"]);
    assert.equal(d.limit, 200); assert.equal(d.delayMs, 250); assert.equal(d.dryRun, false);
  });
});

describe("backfillPlacePhotos — resolveGooglePhotoName degrades to null", () => {
  const okFetch = (photoName: string | null) => (async () => ({
    ok: true, json: async () => ({ places: photoName ? [{ photos: [{ name: photoName }] }] : [{}] }),
  })) as unknown as typeof fetch;
  it("returns the first photo resource name on success", async () => {
    assert.equal(await resolveGooglePhotoName("X", 16, 108, "k", okFetch("places/ABC/photos/1")), "places/ABC/photos/1");
  });
  it("null when there is no photo", async () => {
    assert.equal(await resolveGooglePhotoName("X", 16, 108, "k", okFetch(null)), null);
  });
  it("null on a non-OK response", async () => {
    const bad = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal(await resolveGooglePhotoName("X", null, null, "k", bad), null);
  });
  it("null when fetch throws", async () => {
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    assert.equal(await resolveGooglePhotoName("X", null, null, "k", boom), null);
  });
});

// ── runBackfill (fake deps) ───────────────────────────────────────────────────
function fakePlacesClient(rows: any[]) {
  const q: any = {
    select: () => q, or: () => q, eq: () => q, is: () => q, order: () => q,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return { from: () => q };
}

function deps(over: Partial<BackfillDeps> & { rows: any[]; stored?: Record<string, any> }): BackfillDeps {
  const stored = over.stored ?? {};
  const writes: Array<{ key: string; photo: any }> = [];
  const d: BackfillDeps & { _writes: typeof writes } = {
    sc: fakePlacesClient(over.rows),
    resolvePhotoName: over.resolvePhotoName ?? (async () => "places/ABC/photos/1"),
    readStored: over.readStored ?? (async (k: string) => stored[k] ?? null),
    writeStored: over.writeStored ?? (async (key: string, photo: any) => { writes.push({ key, photo }); }),
    sleep: async () => {},
    log: () => {},
    _writes: writes,
  } as any;
  return d;
}

const ARGS = { city: "Da Nang", limit: 500, delayMs: 0, dryRun: false, confirmed: true };

describe("backfillPlacePhotos — runBackfill", () => {
  it("warms a cold place with a Google RESOURCE NAME row", async () => {
    const d = deps({ rows: [{ id: "11111111-1111-4111-8111-111111111111", name: "Cafe", latitude: 16.06, longitude: 108.2 }] }) as any;
    const r = await runBackfill(ARGS, d);
    assert.equal(r.resolved, 1);
    assert.equal(d._writes.length, 1);
    assert.equal(d._writes[0].key, "db:11111111-1111-4111-8111-111111111111");
    assert.deepEqual(d._writes[0].photo, { source: "google", photoUrl: null, photoRef: "places/ABC/photos/1" });
  });

  it("is idempotent — never overwrites an already-warmed row", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const d = deps({
      rows: [{ id, name: "Bar", latitude: 16, longitude: 108 }],
      stored: { [`db:${id}`]: { source: "foursquare", photoUrl: "https://fsq/x.jpg", photoRef: null } },
    }) as any;
    const r = await runBackfill(ARGS, d);
    assert.equal(r.skippedExisting, 1);
    assert.equal(r.resolved, 0);
    assert.equal(d._writes.length, 0, "a place warmed FSQ-first keeps its Foursquare photo");
  });

  it("--dry-run resolves but writes nothing", async () => {
    const d = deps({ rows: [{ id: "33333333-3333-4333-8333-333333333333", name: "Spot", latitude: 16, longitude: 108 }] }) as any;
    const r = await runBackfill({ ...ARGS, dryRun: true }, d);
    assert.equal(r.resolved, 1);
    assert.equal(d._writes.length, 0);
  });

  it("counts noPhoto when Google resolves nothing, and never writes", async () => {
    const d = deps({
      rows: [{ id: "44444444-4444-4444-8444-444444444444", name: "Nowhere", latitude: 16, longitude: 108 }],
      resolvePhotoName: async () => null,
    }) as any;
    const r = await runBackfill(ARGS, d);
    assert.equal(r.noPhoto, 1); assert.equal(r.resolved, 0); assert.equal(d._writes.length, 0);
  });

  it("counts an unkeyable place id and skips it", async () => {
    const d = deps({ rows: [{ id: "not-a-uuid", name: "Bad", latitude: 16, longitude: 108 }] }) as any;
    const r = await runBackfill(ARGS, d);
    assert.equal(r.unkeyable, 1); assert.equal(r.resolved, 0);
  });
});
