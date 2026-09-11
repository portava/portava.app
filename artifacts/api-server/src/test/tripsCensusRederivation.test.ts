/**
 * census-trips — the BUILT-AND-CORRECT rows, re-derived against the code and
 * pinned so they stay derived.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * §37 read census-trips against the code for the first time and found 37 rotted
 * citations. It says plainly what it did not do: "No verdict was re-derived.
 * §37 checked that each cited artifact exists and still says what the row says —
 * not whether the judgement was right."
 *
 * Re-deriving a verdict by reading the code proves it on the day you read it.
 * This file is the difference between that and a claim that stays true: each
 * test is named for the requirement it re-derives, and fails when the code stops
 * satisfying it.
 *
 * ── WHAT A TEST HERE IS ALLOWED TO BE ────────────────────────────────────────
 * Behavioural where behaviour is available — the serializer and the sanitiser
 * are pure functions and are CALLED here, not described. Structural only where
 * the claim is genuinely structural (a column that must not exist, a scheduler
 * that must be invoked and not merely imported). A structural test reads the
 * artifact rather than a sentence about it; census-trips §32.7 exists because
 * this document has twice recorded the sentence instead.
 *
 * These are NOT a substitute for the census. They pin the invariant a row
 * asserts; they do not re-count anything and they do not cover the W or N rows.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripsCensusRederivation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { toPrivateTripPreview } from "../lib/privacy/tripSerializers.js";
import { sanitizeToolResult } from "../compass/CompassTools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, "..", "..");
const read = (p: string) => readFileSync(join(API, p), "utf8");

// ── §6.3 public projection: TR117, TR118, TR120, TR121 ───────────────────────
// The census cites a test asserting a hotel name is absent. The stronger fact,
// and the one derived here, is that toPrivateTripPreview is a WHITELIST: it
// names its output fields and never spreads the row, so a column added to
// `trips` tomorrow cannot appear in a non-member's payload by default.

describe("TR117/TR118/TR120/TR121 — the non-member trip preview cannot leak a field it does not name", () => {
  /** A trips row carrying every sensitive thing §6.3 names, and then some. */
  const loadedRow = {
    id: "t1", title: "Cebu", destination_city: "Cebu City", destination_country: "PH",
    status: "planning", visibility: "public", created_at: "2026-01-01", updated_at: "2026-01-02",
    show_header_publicly: true, show_destination_city: true, show_exact_dates: true,
    start_date: "2026-02-01", end_date: "2026-02-10", cover_url: "https://x/c.jpg",
    // Everything below must not survive.
    accommodation_name: "Marco Polo Plaza", accommodation_address: "Nivel Hills",
    hotel_name: "Marco Polo Plaza", trip_notes: "door code 4417",
    budget_total: 90000, invite_code: "JOIN-ME-123", documents: ["passport.pdf"],
    member_list: ["u1", "u2"], safe_return_status: "RETURNING",
    owner_id: "u1", destination_lat: 10.3157, destination_lng: 123.8854,
    precise_location_visible: false,
  };

  /**
   * THE ALLOWED KEY SET, asserted exactly.
   *
   * An earlier draft of this test listed forbidden SNAKE_CASE column names and
   * asserted each was absent. It could not fail: the serializer emits camelCase,
   * so `accommodation_name` was never going to appear whatever the code did.
   * Mutation-tested and caught — leaking `ownerId` into the preview passed that
   * version 13/13. This is the fixture-pinning-a-fiction shape the codebase has
   * repaired repeatedly, and the fix is to assert the WHOLE key set rather than
   * a hand-listed absence: any field that appears and is not named here fails,
   * whatever it is called.
   */
  const ALLOWED = new Set([
    "id", "title", "destinationCity", "destinationCountry", "status", "visibility",
    "coverUrl", "tripType", "openToMeet", "isPrivate", "createdAt", "updatedAt",
    "startDate", "endDate", "myJoinRequestStatus", "showHeaderPublicly",
    // Only under the host's explicit opt-in; covered by its own test below.
    "destinationLat", "destinationLng",
  ]);

  it("TR117/TR120/TR121 — the preview carries NOTHING beyond its declared field set", () => {
    const out = toPrivateTripPreview(loadedRow, null) as Record<string, unknown>;
    const unexpected = Object.keys(out).filter((k) => !ALLOWED.has(k));
    assert.deepEqual(unexpected, [],
      `non-member preview carried undeclared field(s): ${unexpected.join(", ")}`);

    // And the sensitive values themselves appear nowhere in the payload, under
    // any key — a rename cannot smuggle one past the key check above.
    const serialized = JSON.stringify(out);
    for (const secret of ["Marco Polo Plaza", "Nivel Hills", "door code 4417",
                          "JOIN-ME-123", "passport.pdf", "RETURNING", "90000"]) {
      assert.ok(!serialized.includes(secret), `non-member preview leaked the value "${secret}"`);
    }

    // Positive control: the preview is not simply empty.
    assert.equal(out.title, "Cebu");
    assert.equal(out.id, "t1");
  });

  it("TR118 — exact coordinates appear ONLY under the host's explicit opt-in", () => {
    const off = toPrivateTripPreview(loadedRow, null) as Record<string, unknown>;
    assert.ok(!("destinationLat" in off), "coordinates leaked with precise_location_visible false");

    // The opt-in is strict equality to true, not truthiness: "1" or 1 must not
    // be read as consent by a row that arrived from a loose source.
    for (const loose of ["true", 1, "1", {}] as unknown[]) {
      const o = toPrivateTripPreview({ ...loadedRow, precise_location_visible: loose }, null) as Record<string, unknown>;
      assert.ok(!("destinationLat" in o), `coordinates leaked on a truthy-but-not-true opt-in: ${JSON.stringify(loose)}`);
    }
    const on = toPrivateTripPreview({ ...loadedRow, precise_location_visible: true }, null) as Record<string, unknown>;
    assert.equal(on.destinationLat, 10.3157);
  });

  it("a field added to the row tomorrow does not reach a non-member", () => {
    // This is the whitelist property itself, and the reason the row's verdict is
    // stronger than the test it cites. A blacklist would pass the case above and
    // fail this one.
    const out = toPrivateTripPreview(
      { ...loadedRow, some_column_invented_later: "secret" }, null,
    ) as Record<string, unknown>;
    assert.ok(!("some_column_invented_later" in out));
  });
});

// ── §12.2 Compass: TR216 ─────────────────────────────────────────────────────

describe("TR216 — Compass cannot be handed coordinates or private keys by a tool result", () => {
  it("strips coordinate-shaped and private keys at every depth, not just the top", () => {
    const result = sanitizeToolResult({
      name: "A place",
      lat: 10.3, lng: 123.8,
      nested: { latitude: 10.3, longitude: 123.8, email: "a@b.c", keep: "yes" },
      rows: [{ location_lat: 1, location_lng: 2, venueLat: 3, title: "t" }],
    }) as Record<string, any>;

    assert.ok(!("lat" in result) && !("lng" in result));
    assert.ok(!("latitude" in result.nested) && !("longitude" in result.nested));
    assert.ok(!("email" in result.nested), "a private key survived inside a nested object");
    assert.ok(!("location_lat" in result.rows[0]) && !("venueLat" in result.rows[0]),
      "a coordinate key survived inside an array element");
    // Positive control — the payload is not simply emptied.
    assert.equal(result.name, "A place");
    assert.equal(result.nested.keep, "yes");
    assert.equal(result.rows[0].title, "t");
  });

  it("null and primitives pass through rather than throwing", () => {
    assert.equal(sanitizeToolResult(null), null);
    assert.equal(sanitizeToolResult(7), 7);
    assert.deepEqual(sanitizeToolResult([1, "a"]), [1, "a"]);
  });
});

// ── §4.3 the event envelope: TR68–TR74 ───────────────────────────────────────
// Structural by nature — these are column and constraint claims. The DDL is read
// rather than a sentence about it.

describe("TR68–TR74 — the trip_events envelope is what the census says it is", () => {
  const ddl = read("src/migrations/2420_trip_kernel_foundation.sql");

  it("TR69 — aggregate_version is NOT NULL and constrained > 0", () => {
    assert.match(ddl, /aggregate_version\s+bigint\s+NOT NULL/);
    assert.match(ddl, /CHECK \(aggregate_version > 0 AND sequence > 0\)/);
  });

  it("TR70 — sequence is unique per trip and assigned as a real sequence", () => {
    assert.match(ddl, /CONSTRAINT trip_events_trip_sequence_unique UNIQUE \(trip_id, sequence\)/);
    // Not `created_at DESC` standing in for an ordering.
    assert.match(ddl, /coalesce\(max\(sequence\), 0\) \+ 1/);
  });

  it("TR71/TR72/TR73 — causation/correlation, schema_version, and two distinct timestamps", () => {
    assert.match(ddl, /causation_id\s+uuid/);
    assert.match(ddl, /correlation_id\s+uuid/);
    assert.match(ddl, /schema_version\s+integer\s+NOT NULL DEFAULT 1/);
    assert.match(ddl, /occurred_at\s+timestamptz\s+NOT NULL/);
    assert.match(ddl, /recorded_at\s+timestamptz\s+NOT NULL DEFAULT now\(\)/);
  });

  it("TR68 — append-only is a trigger, not a convention", () => {
    assert.match(ddl, /CREATE TRIGGER trg_trip_events_append_only/);
    assert.match(ddl, /trip_events is append-only: UPDATE refused/);
  });

  it("TR74 — the outbox row is written by the same function that writes the event", () => {
    const fn = ddl.slice(ddl.indexOf("INSERT INTO public.trip_events"));
    const outbox = fn.indexOf("INSERT INTO public.trip_outbox");
    assert.ok(outbox > -1 && outbox < 3000,
      "trip_outbox is not written alongside the event in the same function body");
  });
});

// ── TR76: registration is a CALL, not an import ──────────────────────────────

describe("TR76 — the trip map projection worker is actually started", () => {
  it("is imported AND invoked in index.ts", () => {
    const index = read("src/index.ts");
    assert.match(index, /import \{ startTripMapProjectionScheduler \}/);
    // The distinction this repository keeps paying for: an import registers
    // nothing. memoryKernelTransactionLive.test.ts had a package script and no
    // caller and was reported as wired for weeks.
    assert.match(index, /^\s*startTripMapProjectionScheduler\(\);/m,
      "startTripMapProjectionScheduler is imported but never called");
  });
});

// ── TR37: no boolean soup ────────────────────────────────────────────────────
// AMBIGUOUS BY CITATION, SO ASSERTED ACROSS BOTH RESOLUTIONS. TR37 cites
// `0001_spine.sql:72-89`, and two files in this repository carry that basename —
// migrations/ and travel-buddy-standalone/migrations/ — with neither in the
// canonical artifacts/api-server/src/migrations/ tree. §37's rule is that a
// basename resolving to more than one file has not been resolved, so rather than
// pick one, this asserts the claim holds in EVERY file that could be the cited
// one. Here they agree, which is what makes TR37 safe; the 0041 case §37 found
// is the one where three same-named files disagreed.

describe("TR37 — trips stores no isActive/isStarted/isFinished/isTraveling", () => {
  const CANDIDATES = [
    "../../migrations/0001_spine.sql",
    "../../travel-buddy-standalone/migrations/0001_spine.sql",
  ];
  const BANNED = ["is_active", "is_started", "is_finished", "is_traveling"];

  for (const rel of CANDIDATES) {
    it(`declares no lifecycle boolean on trips — ${rel.split("/").slice(-2).join("/")}`, () => {
      const sql = readFileSync(join(API, rel), "utf8");
      const start = sql.search(/create table if not exists trips \(/i);
      assert.ok(start > -1, "no trips table found in this candidate");
      const block = sql.slice(start, sql.indexOf(");", start));
      for (const banned of BANNED) {
        assert.ok(!new RegExp(`\\b${banned}\\b`, "i").test(block),
          `trips declares ${banned} — TR37 says lifecycle is computed, not stored`);
      }
      // Positive control: the block really is the trips table, so an empty or
      // mis-sliced read cannot pass this test by finding nothing.
      assert.match(block, /\bstatus\s+trip_status\b/);
      assert.match(block, /\bvisibility\s+trip_visibility\b/);
    });
  }
});
