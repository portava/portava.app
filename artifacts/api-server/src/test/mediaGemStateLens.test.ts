/**
 * mediaGemStateLens — §16 / §43 `GET /media/gems`, the Hidden Gems LENS of the
 * Media v2 World shell (census-media MD360).
 *
 * WHAT THIS FILE IS FOR. census-media MD360 records that the World shell's Hidden
 * Gems lens had no endpoint of its own and fell back to `GET /media/gems-feed`,
 * "a ranked social feed, not a §16 gem-state projection". The difference is not
 * cosmetic: §16.2 says in its own words **"No popularity-first ranking"** and
 * "Suppress aggressive recommendations if a small place is being overloaded",
 * and the fallback orders by exactly the signals §16.2 forbids.
 *
 * So the properties asserted here are the ones that make this a GEM-STATE lens
 * rather than a second feed:
 *
 *   1. the §16 ten-state `HiddenGemState` is SERVED, derived at read time —
 *      not the row's stored `status`;
 *   2. it is NOT popularity-first: a gem with a large `save_count` does not
 *      outrank a better-evidenced peer, and an overcrowded gem is DEMOTED;
 *   3. a gem whose identity may not be disclosed is not NAMED — the predicate
 *      is `mayDiscloseGemIdentity`, the same one MediaSearchService uses,
 *      because naming a protected gem against a city de-anonymizes it;
 *   4. NO coordinate ever leaves the lens, proved with the same
 *      `isLocationSafe` detector the rest of the World shell uses;
 *   5. an unreadable `hidden_gems` read reports `determined: false` instead of
 *      answering "there are no hidden gems here" — supabase-js RESOLVES on a
 *      database error, so `{ data }` alone would make the two byte-identical;
 *   6. empty data is a well-formed empty projection, never an error.
 *
 * Fake Supabase clients only — no DB, no network, no HTTP listen.
 *
 * Run:
 *   node --import tsx/esm --test src/test/mediaGemStateLens.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLocationSafe, findPreciseLocation } from "../lib/media/mediaLocationSafety.js";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { buildGemStateProjection } from "../services/media/MediaGemStateService.js";
import type { ViewerResolved } from "../services/media/MediaProjectionService.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const STRANGER = "22222222-2222-2222-2222-222222222222";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");

function viewer(id: string = VIEWER): ViewerResolved {
  return {
    viewerId: id,
    viewerCountry: "VN",
    viewerAge: 30,
    followedCreatorIds: new Set<string>(),
    viewerTripIds: new Set<string>(),
  };
}

function isoAgo(days: number): string {
  return new Date(NOW - days * 86_400_000).toISOString();
}

interface GemOverrides {
  id?: string;
  name?: string;
  status?: string;
  sensitivity_level?: string;
  verification_level?: string;
  submitted_by?: string | null;
  city?: string;
  crowd_level?: string | null;
  save_count?: number;
  visit_count?: number;
  updated_at?: string;
  canonical_place_id?: string | null;
  /** Deliberately present so the "no coordinates" assertions are meaningful. */
  withCoords?: boolean;
}

let seq = 0;
function makeGem(o: GemOverrides = {}): Record<string, any> {
  const id = o.id ?? `gem-${++seq}`;
  const row: Record<string, any> = {
    id,
    name: o.name ?? `Gem ${id}`,
    category: "viewpoint",
    city: o.city ?? "Da Nang",
    country: "Vietnam",
    neighborhood: "An Thuong",
    vibe_tags: ["quiet"],
    sensitivity_level: o.sensitivity_level ?? "public",
    verification_level: o.verification_level ?? "unverified",
    status: o.status ?? "active",
    submitted_by: o.submitted_by === undefined ? STRANGER : o.submitted_by,
    save_count: o.save_count ?? 0,
    visit_count: o.visit_count ?? 0,
    crowd_level: o.crowd_level === undefined ? null : o.crowd_level,
    canonical_place_id: o.canonical_place_id === undefined ? `place-${id}` : o.canonical_place_id,
    created_at: isoAgo(400),
    updated_at: o.updated_at ?? isoAgo(400),
  };
  // hidden_gems carries exact AND approximate coordinates. The lens must never
  // read them; putting them on every fixture is what makes (4) falsifiable.
  if (o.withCoords !== false) {
    row.latitude = 16.0544;
    row.longitude = 108.2497;
    row.approx_latitude = 16.05;
    row.approx_longitude = 108.25;
  }
  return row;
}

function clientWith(gems: Record<string, any>[], extra: Record<string, any[]> = {}) {
  return makeFailClosedClient({
    rows: {
      hidden_gems: gems,
      hidden_gem_verifications: [],
      hidden_gem_visits: [],
      hidden_gem_contributions: [],
      ...extra,
    },
  });
}

describe("MD360 — GET /media/gems serves a §16 gem-STATE projection", () => {
  it("serves the DERIVED §16 state, not the row's stored status", async () => {
    // An active gem confirmed 3 days ago by two independent confirmers is
    // `recently_confirmed` under §16; its stored `status` is the single word
    // "active", which is not one of the ten states.
    const gem = makeGem({ id: "g1" });
    const sc = clientWith([gem], {
      hidden_gem_verifications: [
        { gem_id: "g1", user_id: "c1", result: "approved", created_at: isoAgo(3) },
        { gem_id: "g1", user_id: "c2", result: "approved", created_at: isoAgo(3) },
      ],
    });
    const out = await buildGemStateProjection(sc, viewer(), { city: "Da Nang" }, NOW);
    assert.equal(out.gems.length, 1, "the gem must reach the lens");
    assert.equal(out.gems[0]!.state, "recently_confirmed");
    assert.notEqual(out.gems[0]!.state as string, "active", "the stored status is not a §16 state");
    assert.ok(out.gems[0]!.confidence.score > 0, "a confirmed gem carries evidence");
  });

  it("is NOT popularity-first: a heavily-saved gem does not outrank a better-evidenced one", async () => {
    // `popular` has 240 saves and 90 visits and no verification. `evidenced` has
    // none of either and is guide-verified. §16.2 forbids the first winning.
    const popular = makeGem({
      id: "popular",
      save_count: 240,
      visit_count: 90,
      verification_level: "unverified",
    });
    const evidenced = makeGem({ id: "evidenced", verification_level: "guide" });
    const out = await buildGemStateProjection(
      clientWith([popular, evidenced]),
      viewer(),
      { city: "Da Nang" },
      NOW,
    );
    assert.deepEqual(
      out.gems.map((g) => g.gemId),
      ["evidenced", "popular"],
      "§16.2: no popularity-first ranking",
    );
  });

  it("DEMOTES an overcrowded gem below an uncrowded peer (§16.2 overloading rule)", async () => {
    const crowded = makeGem({
      id: "crowded",
      verification_level: "guide",
      crowd_level: "very_busy",
    });
    const quiet = makeGem({ id: "quiet", verification_level: "unverified", crowd_level: "quiet" });
    const out = await buildGemStateProjection(
      clientWith([crowded, quiet]),
      viewer(),
      { city: "Da Nang" },
      NOW,
    );
    assert.deepEqual(
      out.gems.map((g) => g.gemId),
      ["quiet", "crowded"],
      "a gem being overloaded must not be recommended over an uncrowded peer",
    );
  });

  it("never NAMES a gem whose identity may not be disclosed", async () => {
    // Every one of these is undisclosable to a non-owner: a protected gem, a
    // pending gem, and an approximate-sensitivity gem.
    const gems = [
      makeGem({ id: "protected", sensitivity_level: "protected" }),
      makeGem({ id: "pending", status: "pending" }),
      makeGem({ id: "approx", sensitivity_level: "approximate" }),
      makeGem({ id: "ok" }),
    ];
    const out = await buildGemStateProjection(clientWith(gems), viewer(), { city: "Da Nang" }, NOW);
    assert.deepEqual(out.gems.map((g) => g.gemId), ["ok"]);
    const blob = JSON.stringify(out);
    for (const hidden of ["protected", "pending", "approx"]) {
      assert.equal(blob.includes(hidden), false, `${hidden} must not be named anywhere in the payload`);
    }
  });

  it("the SUBMITTER sees their own not-yet-active gem (owner bypass)", async () => {
    const mine = makeGem({ id: "mine", status: "pending", submitted_by: VIEWER });
    const out = await buildGemStateProjection(
      clientWith([mine]),
      viewer(),
      { city: "Da Nang" },
      NOW,
    );
    assert.deepEqual(out.gems.map((g) => g.gemId), ["mine"]);
    // …and a stranger does not.
    const theirs = await buildGemStateProjection(
      clientWith([mine]),
      viewer(STRANGER),
      { city: "Da Nang" },
      NOW,
    );
    assert.deepEqual(theirs.gems, []);
  });

  it("emits NO precise location anywhere, although every fixture row carries one", async () => {
    const out = await buildGemStateProjection(
      clientWith([makeGem({ id: "g1" }), makeGem({ id: "g2" })]),
      viewer(),
      { city: "Da Nang" },
      NOW,
    );
    assert.equal(out.gems.length, 2, "the fixtures must actually reach the projection");
    assert.equal(
      isLocationSafe(out),
      true,
      `precise location leaked: ${JSON.stringify(findPreciseLocation(out))}`,
    );
  });

  it("an UNREADABLE gem table reports determined:false — not 'there are no gems here'", async () => {
    const sc = makeFailClosedClient({
      rows: { hidden_gems: [makeGem({ id: "g1" })] },
      failOn: (ctx) => (ctx.table === "hidden_gems" ? { message: "boom", code: "57P01" } : null),
    });
    const out = await buildGemStateProjection(sc, viewer(), { city: "Da Nang" }, NOW);
    assert.equal(out.determined, false, "a failed read is not an empty answer");
    assert.deepEqual(out.gems, []);
    assert.ok(
      out.undetermined.includes("gems"),
      "the CALLER must be able to see which list was not looked at",
    );
  });

  it("a HEALTHY empty city is determined:true with an empty list", async () => {
    const out = await buildGemStateProjection(clientWith([]), viewer(), { city: "Nowhere" }, NOW);
    assert.equal(out.determined, true);
    assert.deepEqual(out.gems, []);
    assert.deepEqual(out.undetermined, []);
    assert.equal(typeof out.generatedAt, "string");
  });

  it("an unreadable OBSERVATION aggregate does not silently become a confident gem", async () => {
    // The state/confidence deriver reads three aggregate tables. If one cannot
    // be read, the lens must say so rather than serve a gem graded on silence.
    const sc = makeFailClosedClient({
      rows: {
        hidden_gems: [makeGem({ id: "g1" })],
        hidden_gem_verifications: [],
        hidden_gem_visits: [],
        hidden_gem_contributions: [],
      },
      failOn: (ctx) =>
        ctx.table === "hidden_gem_verifications" ? { message: "boom", code: "57P01" } : null,
    });
    const out = await buildGemStateProjection(sc, viewer(), { city: "Da Nang" }, NOW);
    assert.ok(
      out.undetermined.includes("gemState"),
      "a gem state derived from an unreadable aggregate must be declared undetermined",
    );
  });
});
