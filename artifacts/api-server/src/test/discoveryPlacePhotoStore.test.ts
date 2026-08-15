/**
 * discoveryPlacePhotoStore — the persisted canonical resolved photo.
 *
 * WHAT THESE PIN. Persisting a photo is only safe if the invalidation story is
 * real, so most of this file is about the ways a stored photo must NOT be
 * served: expired, marked invalid, or unable to produce a URL. The failure mode
 * being guarded is the workstream's own invariant — a dead image renders as
 * "this place has no photo", which is indistinguishable from never having
 * resolved one.
 *
 * The store degrades to "no stored photo" on every error, which is exactly the
 * behaviour before it existed. That is load-bearing rather than incidental: the
 * table is created by a migration STAGED for the operator, so until it is
 * applied every call here fails and must stay invisible.
 *
 * Run: node --import tsx/esm --test src/test/discoveryPlacePhotoStore.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  normalisePlaceKey,
  mintPhotoUrl,
  readStoredPlacePhoto,
  writeStoredPlacePhoto,
  evictStoredPlacePhoto,
  PHOTO_TTL_MS,
  type StoredPlacePhoto,
} from "../lib/discoveryPlacePhotoStore.js";
import { _setTestServiceClient } from "../lib/supabase.js";

// ── A Supabase double that answers the exact query shapes the store issues ───
//
// Modelled on the calls in discoveryPlacePhotoStore.ts rather than on a generic
// "returns success" stub. A stub that answers everything the same way cannot
// detect a wrong request, and this workstream has already been bitten by
// precisely that: a round-trip test passed with its fix reverted because the
// stub returned success regardless of the URL it was handed.

interface FakeRow {
  place_key: string;
  source: string;
  photo_url: string | null;
  photo_ref: string | null;
  expires_at: string;
  invalid_at: string | null;
}

function fakeClient(rows: FakeRow[], log: { upserts: any[]; deletes: string[]; updates: any[] }) {
  return {
    from(table: string) {
      if (table !== "discovery_place_photos") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                maybeSingle: async () => {
                  const row = rows.find((r) => r.place_key === key);
                  return { data: row ?? null, error: null };
                },
              };
            },
          };
        },
        upsert(row: any) {
          log.upserts.push(row);
          return Promise.resolve({ error: null });
        },
        update(patch: any) {
          return {
            eq(_col: string, key: string) {
              log.updates.push({ key, patch });
              return Promise.resolve({ error: null });
            },
          };
        },
        delete() {
          return {
            eq(_col: string, key: string) {
              log.deletes.push(key);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as any;
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("normalisePlaceKey — place identity", () => {
  it("namespaces OSM ids the way discovery_places.tag already does", () => {
    // Consistency with the existing convention, not a second one.
    assert.equal(normalisePlaceKey("node/4089438971"), "osm:node/4089438971");
    assert.equal(normalisePlaceKey("way/123"), "osm:way/123");
    assert.equal(normalisePlaceKey("relation/9"), "osm:relation/9");
  });

  it("is idempotent on already-namespaced keys", () => {
    assert.equal(normalisePlaceKey("osm:node/123"), "osm:node/123");
  });

  it("accepts the db/<uuid> form the client actually sends", () => {
    // Read out of discovery.ts (`db/<entityId>`), not guessed — a bare uuid is
    // not what reaches this function.
    assert.equal(
      normalisePlaceKey("db/3f0a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"),
      "db:3f0a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8",
    );
  });

  it("refuses anything it does not recognise, rather than storing junk keys", () => {
    for (const bad of ["", "   ", "node/", "node/abc", "../../etc/passwd", "3f0a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"]) {
      assert.equal(normalisePlaceKey(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    assert.equal(normalisePlaceKey(null), null);
    assert.equal(normalisePlaceKey(undefined), null);
    assert.equal(normalisePlaceKey("node/" + "9".repeat(200)), null, "over-long keys are refused");
  });
});

describe("mintPhotoUrl — a stored Google row must never carry a credential", () => {
  const ORIGINAL_KEY = process.env.GOOGLE_MAPS_API_KEY;

  beforeEach(() => { process.env.GOOGLE_MAPS_API_KEY = "test-key-1"; });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = ORIGINAL_KEY;
  });

  it("mints the Google media URL from the stored REFERENCE and the current key", () => {
    const stored: StoredPlacePhoto = {
      source: "google",
      photoUrl: null,
      photoRef: "places/ChIJ123/photos/AeJb",
    };

    assert.equal(
      mintPhotoUrl(stored),
      "https://places.googleapis.com/v1/places/ChIJ123/photos/AeJb/media?maxWidthPx=800&key=test-key-1",
    );
  });

  it("survives a key rotation — the same row mints a URL with the NEW key", () => {
    // This is the entire reason the ref is stored instead of the rendered URL.
    // A stored key-bearing URL would become a dead link on rotation, and a dead
    // link renders as "no photo" — indistinguishable from never resolving one.
    const stored: StoredPlacePhoto = {
      source: "google",
      photoUrl: null,
      photoRef: "places/ChIJ123/photos/AeJb",
    };

    const before = mintPhotoUrl(stored);
    process.env.GOOGLE_MAPS_API_KEY = "test-key-2";
    const after = mintPhotoUrl(stored);

    assert.ok(before?.includes("key=test-key-1"));
    assert.ok(after?.includes("key=test-key-2"));
    assert.notEqual(before, after);
  });

  it("returns null when the key is gone, so the row reads as unusable", () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    assert.equal(
      mintPhotoUrl({ source: "google", photoUrl: null, photoRef: "places/x/photos/y" }),
      null,
    );
  });

  it("returns a Foursquare URL as-is — FSQ CDN URLs are stable and keyless", () => {
    assert.equal(
      mintPhotoUrl({ source: "foursquare", photoUrl: "https://fastly.4sqi.net/img/a.jpg", photoRef: null }),
      "https://fastly.4sqi.net/img/a.jpg",
    );
  });

  it("returns null for a row carrying neither a URL nor a ref", () => {
    assert.equal(mintPhotoUrl({ source: "foursquare", photoUrl: null, photoRef: null }), null);
    assert.equal(mintPhotoUrl({ source: "google", photoUrl: null, photoRef: null }), null);
  });
});

describe("Reading a stored photo — and the four ways it must refuse", () => {
  const KEY = "osm:node/1";
  let log: { upserts: any[]; deletes: string[]; updates: any[] };
  const ORIGINAL_KEY = process.env.GOOGLE_MAPS_API_KEY;

  beforeEach(() => {
    log = { upserts: [], deletes: [], updates: [] };
    process.env.GOOGLE_MAPS_API_KEY = "test-key-1";
  });
  afterEach(() => {
    _setTestServiceClient(null);
    if (ORIGINAL_KEY === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = ORIGINAL_KEY;
  });

  function withRows(rows: FakeRow[]) {
    _setTestServiceClient(fakeClient(rows, log));
  }

  const freshFsqRow: FakeRow = {
    place_key: KEY,
    source: "foursquare",
    photo_url: "https://fastly.4sqi.net/img/a.jpg",
    photo_ref: null,
    expires_at: iso(PHOTO_TTL_MS),
    invalid_at: null,
  };

  it("serves a fresh row", async () => {
    withRows([freshFsqRow]);
    const stored = await readStoredPlacePhoto(KEY);

    assert.equal(stored?.source, "foursquare");
    assert.equal(mintPhotoUrl(stored!), "https://fastly.4sqi.net/img/a.jpg");
  });

  it("REFUSES an expired row — expiry is enforced on read, not only by a sweep", async () => {
    // A store that is never swept still must not serve a stale photo.
    withRows([{ ...freshFsqRow, expires_at: iso(-1000) }]);
    assert.equal(await readStoredPlacePhoto(KEY), null);
  });

  it("REFUSES a row marked invalid", async () => {
    withRows([{ ...freshFsqRow, invalid_at: iso(-1000) }]);
    assert.equal(await readStoredPlacePhoto(KEY), null);
  });

  it("REFUSES — and marks — a row that cannot produce a URL", async () => {
    // A Google row whose key is gone. Worse than no row: it would answer the
    // read with nothing while suppressing the live lookup.
    delete process.env.GOOGLE_MAPS_API_KEY;
    withRows([{ ...freshFsqRow, source: "google", photo_url: null, photo_ref: "places/x/photos/y" }]);

    assert.equal(await readStoredPlacePhoto(KEY), null);
    // Marked rather than silently dropped — a broken row stays observable.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(log.updates.length, 1);
    assert.equal(log.updates[0].key, KEY);
    assert.ok(log.updates[0].patch.invalid_at);
  });

  it("returns null for a missing row", async () => {
    withRows([]);
    assert.equal(await readStoredPlacePhoto(KEY), null);
  });

  it("returns null — never throws — when the table does not exist yet", async () => {
    // The migration is STAGED for the operator, so this is the state the code
    // ships in. It must be invisible, not an error on every card.
    _setTestServiceClient({
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({
                    data: null,
                    error: { message: 'relation "discovery_place_photos" does not exist' },
                  }),
                };
              },
            };
          },
        };
      },
    } as any);

    assert.equal(await readStoredPlacePhoto(KEY), null);
  });

  it("returns null when there is no service client at all", async () => {
    _setTestServiceClient(null);
    assert.equal(await readStoredPlacePhoto(KEY), null);
  });
});

describe("Writing — one canonical photo per place", () => {
  let log: { upserts: any[]; deletes: string[]; updates: any[] };

  beforeEach(() => {
    log = { upserts: [], deletes: [], updates: [] };
    _setTestServiceClient(fakeClient([], log));
  });
  afterEach(() => { _setTestServiceClient(null); });

  it("upserts, so re-resolving REPLACES rather than accumulating candidates", async () => {
    // "Multiple candidates per place" is a named non-goal requiring a new
    // ruling. Upsert is how that stays true as rows are refreshed.
    await writeStoredPlacePhoto("osm:node/1", {
      source: "foursquare",
      photoUrl: "https://fastly.4sqi.net/img/a.jpg",
      photoRef: null,
    });

    assert.equal(log.upserts.length, 1);
    assert.equal(log.upserts[0].place_key, "osm:node/1");
    assert.equal(log.upserts[0].source, "foursquare");
    assert.equal(log.upserts[0].invalid_at, null, "a refresh must clear a previous invalid stamp");
  });

  it("sets an expiry ahead of the resolve time", async () => {
    await writeStoredPlacePhoto("osm:node/1", {
      source: "foursquare",
      photoUrl: "https://fastly.4sqi.net/img/a.jpg",
      photoRef: null,
    });

    const row = log.upserts[0];
    const span = Date.parse(row.expires_at) - Date.parse(row.resolved_at);
    assert.equal(span, PHOTO_TTL_MS);
  });

  it("never writes a row that carries neither a URL nor a ref", async () => {
    // The DB has a CHECK for this too. Refusing here as well keeps the store
    // from depending on a constraint to stop it storing a resolved nothing.
    await writeStoredPlacePhoto("osm:node/1", { source: "google", photoUrl: null, photoRef: null });
    assert.equal(log.upserts.length, 0);
  });

  it("stores the Google REFERENCE, never a key-bearing URL", async () => {
    await writeStoredPlacePhoto("osm:node/2", {
      source: "google",
      photoUrl: null,
      photoRef: "places/ChIJ123/photos/AeJb",
    });

    const row = log.upserts[0];
    assert.equal(row.photo_ref, "places/ChIJ123/photos/AeJb");
    assert.equal(row.photo_url, null);
    assert.ok(
      !JSON.stringify(row).includes("key="),
      "a persisted row must never contain an API key",
    );
  });
});

describe("Explicit eviction — an operator is never overruled by a cached photo", () => {
  let log: { upserts: any[]; deletes: string[]; updates: any[] };

  beforeEach(() => {
    log = { upserts: [], deletes: [], updates: [] };
    _setTestServiceClient(fakeClient([], log));
  });
  afterEach(() => { _setTestServiceClient(null); });

  it("deletes the row for a normalised key", async () => {
    await evictStoredPlacePhoto("db/3f0a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8");
    assert.deepEqual(log.deletes, ["db:3f0a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8"]);
  });

  it("does nothing for an unkeyable place, rather than deleting something else", async () => {
    await evictStoredPlacePhoto("not-a-place-id");
    assert.deepEqual(log.deletes, []);
  });
});

describe("The refresh horizon is real", () => {
  it("is 30 days — bounded, so an outage-era photo cannot stand forever", () => {
    // Foursquare was returning HTTP 429 on 2026-08-15 and Google was carrying
    // every card. A store with no horizon would freeze that fallback in as the
    // permanent answer, so "never refresh" is not an available design.
    assert.equal(PHOTO_TTL_MS, 30 * 24 * 60 * 60 * 1000);
    assert.ok(PHOTO_TTL_MS > 0, "a non-expiring photo is a stale field with no owner");
  });
});
