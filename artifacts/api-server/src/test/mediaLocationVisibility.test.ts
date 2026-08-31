/**
 * mediaLocationVisibility — Media v2 Phase 1b (Security).
 *
 * Proves the two security properties this slice ships:
 *
 *   A. An INDEPENDENT LocationVisibility axis for media (§33): served media
 *      location is coarsened to no finer than its tier, fail-closed on an
 *      unknown/absent tier, and a NON-owner never receives the raw exact
 *      coordinate on any tier.
 *   B. The Hidden-Gem de-anonymization hole is CLOSED: media pinned at / sitting
 *      on a place that hosts a protected/approximate gem inherits the STRICTER
 *      of (its own tier, the gem's ceiling) — so media can never disclose a gem
 *      location the gem guard itself would hide. Fail-closed when the gem status
 *      cannot be determined; owner bypass so a media owner still sees their own.
 *
 * Every property is MUTATION-PROVEN: each test's comment names the exact code
 * mutation that turns it RED (and thus what security regression it guards).
 *
 * No DB, no network — pure functions + a fake Supabase client. Run:
 *   node --import tsx/esm --test src/test/mediaLocationVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coarsenMediaLocation,
  resolveMediaLocationWithGemProtection,
  gemCeilingForItem,
  gemSensitivityToCeiling,
  normalizeTier,
  stricterTier,
  loadRestrictiveGems,
  toGemProtection,
  RESTRICTIVE_GEM_SENSITIVITIES,
  UNDETERMINED_GEM_CEILING,
  type RestrictiveGem,
} from "../lib/mediaLocationVisibility.js";

// The exact coordinate a protected gem is hiding. If ANY non-owner disclosure
// returns this pair, the location has leaked.
const EXACT = { lat: 16.047079, lng: 108.20623 };
const OWNER = "owner-1";
const VIEWER = "viewer-2";

function isExact(lat: number | null, lng: number | null): boolean {
  return lat === EXACT.lat && lng === EXACT.lng;
}

// ── A. Independent LocationVisibility coarsening (the helper) ───────────────────

describe("coarsenMediaLocation — independent LocationVisibility axis", () => {
  const input = {
    ...EXACT,
    name: "Secret Waterfall",
    neighborhood: "Son Tra",
    city: "Da Nang",
    country: "Vietnam",
  };

  it("(1) location_visibility='city' serves ONLY city-level, never exact coords", () => {
    // MUTATION: make coarsenMediaLocation return the raw input coords for the
    // 'city' branch (a pass-through coarsener) → this test goes RED.
    const d = coarsenMediaLocation(input, { locationVisibility: "city", isOwner: false });
    assert.equal(d.precision, "city");
    assert.equal(d.city, "Da Nang");
    assert.equal(d.country, "Vietnam");
    // The exact place name and neighborhood must be gone at city tier.
    assert.equal(d.name, null);
    assert.equal(d.neighborhood, null);
    // And the exact coordinate must never appear.
    assert.equal(d.coordsAreExact, false);
    assert.ok(!isExact(d.lat, d.lng), "exact coords leaked at city tier");
  });

  it("(2) hidden tier ⇒ no location at all", () => {
    // MUTATION: change the 'hidden'/default branch to echo labels → RED.
    const d = coarsenMediaLocation(input, { locationVisibility: "hidden", isOwner: false });
    assert.equal(d.precision, "none");
    assert.equal(d.name, null);
    assert.equal(d.city, null);
    assert.equal(d.country, null);
    assert.equal(d.lat, null);
    assert.equal(d.lng, null);
  });

  it("(2b) absent / unknown tier ⇒ fail-closed to 'hidden' (no location)", () => {
    // MUTATION: make normalizeTier default to 'place' instead of 'hidden' → RED.
    for (const tier of [undefined, null, "", "garbage", "PRECISE", 5 as unknown]) {
      const d = coarsenMediaLocation(input, { locationVisibility: tier, isOwner: false });
      assert.equal(d.visibility, "hidden", `tier ${String(tier)} did not fail closed`);
      assert.equal(d.precision, "none");
      assert.equal(d.city, null);
      assert.equal(d.lat, null);
    }
  });

  it("(3) precise_private ⇒ exact ONLY to owner; coarsened to others", () => {
    // MUTATION: return exact coords for a non-owner on precise_private → RED.
    const nonOwner = coarsenMediaLocation(input, {
      locationVisibility: "precise_private",
      isOwner: false,
    });
    assert.equal(nonOwner.coordsAreExact, false);
    assert.ok(!isExact(nonOwner.lat, nonOwner.lng), "precise_private leaked exact to non-owner");
    // Downgraded to place-level for the non-owner (still no exact coord).
    assert.equal(nonOwner.precision, "place");

    const owner = coarsenMediaLocation(input, {
      locationVisibility: "precise_private",
      isOwner: true,
    });
    assert.equal(owner.coordsAreExact, true);
    assert.ok(isExact(owner.lat, owner.lng), "owner did not receive their own exact coords");
  });

  it("(5) owner sees their OWN exact location on every tier", () => {
    // MUTATION: drop the owner bypass → owner stops getting exact → RED.
    for (const tier of ["hidden", "city", "place", "precise_private"] as const) {
      const d = coarsenMediaLocation(input, { locationVisibility: tier, isOwner: true });
      assert.equal(d.coordsAreExact, true, `owner lost exact at tier ${tier}`);
      assert.ok(isExact(d.lat, d.lng));
      assert.equal(d.name, "Secret Waterfall");
    }
  });

  it("a non-owner NEVER receives exact coords — invariant across all tiers", () => {
    // MUTATION: any tier that lets a non-owner keep exact coords → RED.
    for (const tier of [
      "hidden",
      "country",
      "city",
      "neighborhood",
      "place",
      "precise_private",
    ] as const) {
      const d = coarsenMediaLocation(input, { locationVisibility: tier, isOwner: false });
      assert.equal(d.coordsAreExact, false, `tier ${tier} exposed exact to non-owner`);
      assert.ok(!isExact(d.lat, d.lng), `tier ${tier} leaked the raw coordinate`);
    }
  });

  it("emitCoarseCoords produces a stable, coarse, non-exact coordinate", () => {
    const a = coarsenMediaLocation(input, {
      locationVisibility: "city",
      isOwner: false,
      coarsenSeed: "post-9",
      emitCoarseCoords: true,
    });
    const b = coarsenMediaLocation(input, {
      locationVisibility: "city",
      isOwner: false,
      coarsenSeed: "post-9",
      emitCoarseCoords: true,
    });
    assert.notEqual(a.lat, null);
    assert.ok(!isExact(a.lat, a.lng));
    // Deterministic per seed.
    assert.deepEqual({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    // Coarse: at least ~1 km away from the true point.
    assert.ok(Math.abs((a.lat ?? 0) - EXACT.lat) > 0.005 || Math.abs((a.lng ?? 0) - EXACT.lng) > 0.005);
  });
});

// ── tier algebra ───────────────────────────────────────────────────────────────

describe("tier helpers", () => {
  it("normalizeTier fails closed", () => {
    assert.equal(normalizeTier("city"), "city");
    assert.equal(normalizeTier("nope"), "hidden");
    assert.equal(normalizeTier(undefined), "hidden");
  });
  it("stricterTier picks the coarser tier", () => {
    assert.equal(stricterTier("place", "city"), "city");
    assert.equal(stricterTier("hidden", "precise_private"), "hidden");
    assert.equal(stricterTier("neighborhood", "neighborhood"), "neighborhood");
  });
  it("gemSensitivityToCeiling maps protection to a ceiling, fail-closed on unknown", () => {
    assert.equal(gemSensitivityToCeiling("protected"), "city");
    assert.equal(gemSensitivityToCeiling("reveal_after_save"), "city");
    assert.equal(gemSensitivityToCeiling("reveal_after_acceptance"), "city");
    assert.equal(gemSensitivityToCeiling("approximate"), "neighborhood");
    assert.equal(gemSensitivityToCeiling("public"), null);
    // Unknown sensitivity must NOT widen — fail closed to the strictest ceiling.
    assert.equal(gemSensitivityToCeiling("weird_new_level"), "city");
  });
});

// ── B. The gem hole (gemCeilingForItem + resolveMediaLocationWithGemProtection) ─

describe("gemCeilingForItem — cross-check by place AND coordinate proximity", () => {
  const protectedGem: RestrictiveGem = {
    canonical_place_id: "place-A",
    sensitivity_level: "protected",
    latitude: EXACT.lat,
    longitude: EXACT.lng,
    approx_latitude: null,
    approx_longitude: null,
  };
  const approxGem: RestrictiveGem = {
    canonical_place_id: "place-B",
    sensitivity_level: "approximate",
    latitude: null,
    longitude: null,
    approx_latitude: EXACT.lat,
    approx_longitude: EXACT.lng,
  };

  it("matches by canonical_place_id", () => {
    assert.equal(gemCeilingForItem([protectedGem], { placeId: "place-A" }), "city");
    assert.equal(gemCeilingForItem([approxGem], { placeId: "place-B" }), "neighborhood");
  });

  it("matches by coordinate proximity even with a different / absent placeId", () => {
    // MUTATION: delete the proximity branch → this returns null → RED. This is
    // the leak where a post sits ON the gem but resolved to no / another place.
    const onGem = { placeId: "some-other-place", lat: EXACT.lat + 0.0005, lng: EXACT.lng };
    assert.equal(gemCeilingForItem([protectedGem], onGem), "city");
  });

  it("does not match a far-away item", () => {
    const far = { placeId: "elsewhere", lat: EXACT.lat + 1, lng: EXACT.lng + 1 };
    assert.equal(gemCeilingForItem([protectedGem], far), null);
  });

  it("public gems impose no ceiling", () => {
    const pub: RestrictiveGem = { ...protectedGem, sensitivity_level: "public" };
    assert.equal(gemCeilingForItem([pub], { placeId: "place-A" }), null);
  });

  it("returns the STRICTEST ceiling across multiple matching gems", () => {
    const both = [approxGem, { ...protectedGem, canonical_place_id: "place-B" }];
    // place-B now hosts both an approximate (neighborhood) and a protected (city)
    // gem → the stricter 'city' wins.
    assert.equal(gemCeilingForItem(both, { placeId: "place-B" }), "city");
  });
});

describe("resolveMediaLocationWithGemProtection — closes the de-anonymization hole", () => {
  // A media whose OWN tier would happily disclose the exact place — the worst case.
  const media = {
    ...EXACT,
    name: "Secret Waterfall",
    neighborhood: "Son Tra",
    city: "Da Nang",
    country: "Vietnam",
  };

  it("(4) media at a protected gem's place returns COARSENED, not exact — even when its own tier is finer", () => {
    // The gem cross-check found a protected gem at this place → ceiling 'city'.
    const gem = toGemProtection("city", /*determined*/ true);
    const d = resolveMediaLocationWithGemProtection(media, {
      locationVisibility: "precise_private", // media would allow the finest
      isOwner: false,
      gem,
    });
    // Stricter-of-the-two wins: city.
    assert.equal(d.visibility, "city");
    assert.equal(d.precision, "city");
    assert.equal(d.name, null, "the gem's place NAME leaked through media");
    assert.equal(d.neighborhood, null);
    assert.equal(d.coordsAreExact, false);
    assert.ok(!isExact(d.lat, d.lng), "the protected gem's exact coords leaked through media");
  });

  it("(4-mutation) WITHOUT the gem cross-check the gem's exact location leaks", () => {
    // This is the pre-fix behaviour: no gem ceiling supplied, media tier honored.
    // It documents the vulnerability the cross-check closes — media at
    // precise_private for the OWNER exposes exact; and even a non-owner at
    // 'place' tier would expose the place NAME. Removing the resolver's gem step
    // (equivalent to gem=null with a permissive tier) re-opens this.
    const leak = coarsenMediaLocation(media, { locationVisibility: "place", isOwner: false });
    // Place tier alone still exposes the gem's exact NAME — the leak.
    assert.equal(leak.name, "Secret Waterfall");
    // Whereas the gem-protected path above stripped it. Prove they differ.
    const guarded = resolveMediaLocationWithGemProtection(media, {
      locationVisibility: "place",
      isOwner: false,
      gem: toGemProtection("city", true),
    });
    assert.notEqual(guarded.name, leak.name);
    assert.equal(guarded.name, null);
  });

  it("fail-closed: undetermined gem status coarsens to at least the fallback ceiling", () => {
    // MUTATION: treat determined=false as "no gem" (ceiling passthrough) → RED.
    const gem = toGemProtection(null, /*determined*/ false);
    const d = resolveMediaLocationWithGemProtection(media, {
      locationVisibility: "place",
      isOwner: false,
      gem,
    });
    assert.equal(d.visibility, UNDETERMINED_GEM_CEILING); // 'city'
    assert.equal(d.name, null);
    assert.ok(!isExact(d.lat, d.lng));
  });

  it("fail-closed: a MISSING gem option is treated as undetermined", () => {
    // A seam that forgot to run the cross-check must not leak.
    const d = resolveMediaLocationWithGemProtection(media, {
      locationVisibility: "place",
      isOwner: false,
      // no `gem`
    });
    assert.equal(d.visibility, UNDETERMINED_GEM_CEILING);
    assert.ok(!isExact(d.lat, d.lng));
  });

  it("no gem constraint (determined, ceiling null) leaves the media's own tier intact", () => {
    const d = resolveMediaLocationWithGemProtection(media, {
      locationVisibility: "place",
      isOwner: false,
      gem: toGemProtection(null, true),
    });
    // Not near any gem → the post keeps its place-level label (no regression).
    assert.equal(d.visibility, "place");
    assert.equal(d.name, "Secret Waterfall");
    assert.equal(d.coordsAreExact, false); // still never exact for a non-owner
  });

  it("(5) media OWNER at a protected gem's place still sees their own exact location", () => {
    // Gem protection guards OTHER viewers; the owner placed the media.
    const d = resolveMediaLocationWithGemProtection(media, {
      locationVisibility: "precise_private",
      isOwner: true,
      gem: toGemProtection("city", true),
    });
    assert.equal(d.coordsAreExact, true);
    assert.ok(isExact(d.lat, d.lng));
  });
});

// ── loadRestrictiveGems — DB shape + fail-closed contract ──────────────────────

describe("loadRestrictiveGems", () => {
  // A fake that hands out a fresh query builder per .from(), records the filters
  // applied to each, and resolves to a per-query result. `resultFor` chooses the
  // result by the membership column of the query (canonical_place_id | city).
  function fakeDb(resultFor: (col: string | null) => { data: any; error: any }, queries: any[]) {
    return {
      from(table: string) {
        const q: any = { table, filters: {}, membershipCol: null as string | null };
        queries.push(q);
        const builder: any = {
          select(_s: string) { return builder; },
          in(col: string, vals: any[]) {
            q.filters[col] = vals;
            if (col === "canonical_place_id" || col === "city") q.membershipCol = col;
            return builder;
          },
          then(resolve: (v: any) => void) { resolve(resultFor(q.membershipCol)); },
        };
        return builder;
      },
    };
  }

  it("issues SAFE parameterized .in() queries (no injectable or-string) per arm", async () => {
    const queries: any[] = [];
    const db = fakeDb(() => ({ data: [], error: null }), queries);
    await loadRestrictiveGems(db as any, {
      placeIds: ["p1", "p2", null, "p1"],
      cities: ["Da Nang", null],
    });
    // Exactly two arms: one keyed by place, one by city.
    assert.equal(queries.length, 2);
    const placeQ = queries.find((q) => q.membershipCol === "canonical_place_id");
    const cityQ = queries.find((q) => q.membershipCol === "city");
    assert.ok(placeQ && cityQ, "both the place arm and the city arm must run");
    // Each arm filters to live status + restrictive sensitivities.
    for (const q of queries) {
      assert.equal(q.table, "hidden_gems");
      assert.deepEqual(q.filters.status, ["active", "pending", "hidden"]);
      assert.deepEqual(q.filters.sensitivity_level, [...RESTRICTIVE_GEM_SENSITIVITIES]);
    }
    // Values are passed as ARRAYS to .in() (encoded by the client), never spliced
    // into a hand-built filter string. Place ids de-duped.
    assert.deepEqual(placeQ.filters.canonical_place_id, ["p1", "p2"]);
    assert.deepEqual(cityQ.filters.city, ["Da Nang"]);
  });

  it("de-dupes a gem returned by both the place arm and the city arm", async () => {
    const gem = {
      canonical_place_id: "p1",
      sensitivity_level: "protected",
      latitude: 1,
      longitude: 2,
      approx_latitude: null,
      approx_longitude: null,
    };
    const queries: any[] = [];
    const db = fakeDb(() => ({ data: [gem], error: null }), queries);
    const out = await loadRestrictiveGems(db as any, { placeIds: ["p1"], cities: ["Da Nang"] });
    assert.equal(out.length, 1);
  });

  it("returns [] without a query when there are no places or cities", async () => {
    const queries: any[] = [];
    const db = fakeDb(() => ({ data: [{ canonical_place_id: "x" }], error: null }), queries);
    const out = await loadRestrictiveGems(db as any, { placeIds: [null], cities: [] });
    assert.deepEqual(out, []);
    assert.equal(queries.length, 0); // never touched the DB
  });

  it("THROWS on a query error (caller must fail closed)", async () => {
    // MUTATION: swallow the error and return [] → this test goes RED, and the
    // seams would treat a failed lookup as "no gems" (a leak).
    const queries: any[] = [];
    const db = fakeDb(() => ({ data: null, error: { message: "boom" } }), queries);
    await assert.rejects(
      () => loadRestrictiveGems(db as any, { placeIds: ["p1"], cities: [] }),
      /loadRestrictiveGems failed/,
    );
  });
});
