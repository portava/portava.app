/**
 * census-input-intelligence (wave 5, 2026-10-17) — GET /api/cities/:cityKey/places
 * reads only the columns fsq_places has.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/fsqPlacesProductionColumns.test.ts
 *
 * THE DEFECT. getCityPlaces (lib/fsq/fsqPlaces.ts) selected ten "extended"
 * columns — tel, website, rating, price, stats, photos, hours, features,
 * amenities, photo_url — that no SQL in the repository ever declared:
 * fsq_places has the 19 columns of migration 0184 (the 2026-08-19 baseline and
 * the 2026-09-22 production capture agree). PostgREST failed the whole read with
 * 42703, getCityPlaces answered its fail-soft empty, and the route answered 200
 * `{ places: [], enabled: true }` for EVERY city while `fsq_places_enabled` is
 * TRUE in production. Found by test/schemaColumnProductionScan.test.ts (class A;
 * check:schema-references could not see it because the list is an array
 * `.join()`).
 *
 * THE FIX. Select only fsq_places' own columns; the FsqPlace fields the open
 * dataset has no value for answer null / [] (never invented). Proven on
 * schemaStrictSupabase, whose fsq_places is the live schema's:
 *   1. the read names no dead column and returns the city's places;
 *   2. the route answers them (200, enabled: true, attribution);
 *   3. contact, rating, price, photo, hours and amenity fields are null / [];
 *      isOpenNow is null (the dataset has no hours; lead ruling D-67).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import { getCityPlaces, FSQ_ATTRIBUTION } from "../lib/fsq/fsqPlaces.js";
import fsqPlacesRouter from "../routes/fsqPlaces.js";

const USER = "d0d0d0d0-0000-4000-a000-0000000000d0";
const TOKEN = "tok-user";
const noopLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return noopLog; } };

/** A row with exactly fsq_places' columns (0184), as the ingest writes it. */
function place(fsqId: string, name: string, cityKey: string, category: string) {
  return {
    fsq_id: fsqId, name, latitude: 10.3, longitude: 123.9, category, fsq_primary_label: "Café",
    fsq_category_ids: ["4bf58dd8d48988d16d941735"], fsq_category_labels: ["Dining and Drinking > Café"],
    address: "1 Colon St", locality: "Cebu City", region: "Cebu", postcode: "6000", country: "PH",
    city_key: cityKey, source: "fsq_os_places", confidence: "provider", dataset_date: "2026-06-01",
    ingested_at: "2026-06-02T00:00:00Z", geog: null,
  };
}

function world(): Seed {
  return {
    profiles: [{ id: USER, role: "user", handle: "u" }],
    user_account_states: [],
    feature_flags: [{ flag: "fsq_places_enabled", enabled: true }],
    fsq_places: [
      place("fsq-1", "Café Lechon", "cebu-ph", "food"),
      place("fsq-2", "Fort San Pedro", "cebu-ph", "culture"),
      place("fsq-3", "Elsewhere", "manila-ph", "food"),
    ],
  };
}

const auth = { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", fsqPlacesRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
});

function install(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const client = { from: (t: string) => strict.from(t), auth };
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  return strict;
}

describe("schema-strict: getCityPlaces reads only fsq_places' own columns", () => {
  it("names no dead column and returns the city's places (the 42703 answered none)", async () => {
    const strict = makeSchemaStrictClient(world());
    const r = await getCityPlaces(strict, { cityKey: "cebu-ph" });
    assert.deepEqual(strict.deadColumnErrors, [], "every selected column is a column fsq_places has");
    assert.deepEqual(r.places.map((p) => p.fsqId).sort(), ["fsq-1", "fsq-2"]);
    assert.equal(r.attribution, FSQ_ATTRIBUTION);
    assert.equal(r.datasetDate, "2026-06-01");
  });

  it("fields the open dataset has no value for are null / [] — never invented", async () => {
    const r = await getCityPlaces(makeSchemaStrictClient(world()), { cityKey: "cebu-ph", category: "food" });
    assert.equal(r.places.length, 1);
    const p = r.places[0]!;
    assert.equal(p.name, "Café Lechon");
    assert.equal(p.label, "Café");
    assert.equal(p.postalCode, "6000");
    assert.deepEqual(
      { phone: p.phone, website: p.website, rating: p.rating, reviewCount: p.reviewCount, fsqPrice: p.fsqPrice, photoUrl: p.photoUrl, isOpenNow: p.isOpenNow },
      { phone: null, website: null, rating: null, reviewCount: null, fsqPrice: null, photoUrl: null, isOpenNow: null },
    );
    assert.deepEqual(p.galleryImages, []);
    assert.deepEqual(p.amenities, []);
  });
});

describe("schema-strict: GET /api/cities/:cityKey/places with fsq_places_enabled TRUE (as in production)", () => {
  it("answers the city's places, enabled, with attribution", async () => {
    const strict = install(world());
    const res = await fetch(`${base}/api/cities/cebu-ph/places`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as any;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.enabled, true);
    assert.equal(body.attribution, FSQ_ATTRIBUTION);
    assert.deepEqual(body.places.map((p: any) => p.fsqId).sort(), ["fsq-1", "fsq-2"]);
    assert.deepEqual(strict.deadColumnErrors.filter((e) => e.table === "fsq_places"), []);
  });
});
