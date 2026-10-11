/**
 * THE WRITER HALF of census-highlights-memories H4 / H239: a stamp that is not
 * evidence of presence is WRITTEN without a place.
 *
 * H4: "Planned/saved/nearby never represented as 'experienced' without
 * occurrence evidence or user confirmation." H239: "planned activity without
 * occurrence cannot earn a visit Memory/Stamp." Migration 2970 added
 * `stamp_definitions.evidences_presence` and four readers now filter on it
 * (§L, §N). §L.4 / §N.4 kept both rows `W` because the WRITERS still attached a
 * place — "a prohibition whose violation is filtered out downstream is not
 * satisfied". The writers named there, and one more of the same shape:
 *
 *   routes/trips.ts      POST /api/trips   first_trip_created + trip_planner, destination attached
 *   routes/hiddenGems.ts admin approve     hidden_gem_explorer to the submitter, gem's city attached
 *   routes/posts.ts      POST /api/posts   first_postcard, city attached, not gated on stampEligible
 *
 * What this suite proves:
 *   1. `placelessAward` — the wrapper all three writers now award through —
 *      carries no city/country/lat/lng, by type and at runtime;
 *   2. driven through the real StampAwardEngine, the user_stamps row they write
 *      has a NULL city and country, so even a reader that ignores the
 *      definition (22 of the 26 read sites §K.4 counted were never re-read)
 *      cannot count it — while a presence award still writes its place
 *      (positive control: the engine was not changed);
 *   3. a static guard over EVERY literal-slug award in routes/: a slug that is
 *      not in 2970's presence-TRUE list must not be handed a place, and the
 *      four slugs above are awarded through `placelessAward(...)` directly;
 *   4. the "You earned a stamp for <location>" notification for these awards no
 *      longer names the destination / gem city as the place earned.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/stampWritersNoPresenceClaim.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { awardStamp } from "../services/passport/StampAwardEngine.js";
import { placelessAward } from "../services/passport/nonPresenceStampAwards.js";
import { buildStats } from "../services/passport/PassportMapService.js";
import { makeEngineFake } from "./stampEngineFake.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");
const ROUTES = path.join(SRC, "routes");
const MIGRATION_2970 = path.join(SRC, "migrations", "2970_stamp_definitions_evidences_presence.sql");

const USER = "aaaaaaaa-0000-0000-0000-000000000001";
const TRIP = "bbbbbbbb-0000-0000-0000-000000000001";
const GEM = "bbbbbbbb-0000-0000-0000-000000000002";
const POSTCARD = "bbbbbbbb-0000-0000-0000-000000000003";
const PLACE_KEYS = ["city", "country", "lat", "lng"] as const;

/** 2970's presence-TRUE vocabulary, read from the delimited block (code lines only). */
function presenceTrueSlugs(): Set<string> {
  const sql = fs.readFileSync(MIGRATION_2970, "utf8");
  const block = /--\s*PRESENCE-TRUE-SLUGS-BEGIN([\s\S]*?)--\s*PRESENCE-TRUE-SLUGS-END/.exec(sql);
  assert.ok(block, "2970 must delimit its presence-TRUE slug list");
  const code = block[1].split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const slugs = new Set([...code.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.equal(slugs.size, 13, "2970's presence list parsed short — the guard below would be vacuous");
  return slugs;
}

function definitionRow(slug: string) {
  return {
    id: `def-${slug}`,
    slug,
    name: slug,
    stamp_type: "trip",
    is_active: true,
    is_repeatable: false,
    max_awards_per_user: 1,
    visibility_default: "public",
    criteria_type: "automatic",
    criteria: null,
  };
}

/** The four awards exactly as the three routes now build them. */
const TRIP_CREATION = ["first_trip_created", "trip_planner"].map((definitionSlug) =>
  placelessAward({ userId: USER, definitionSlug, sourceType: "trips", sourceId: TRIP }));
const GEM_APPROVAL = placelessAward({ userId: USER, definitionSlug: "hidden_gem_explorer", sourceType: "hidden_gems", sourceId: GEM });
const FIRST_POSTCARD = placelessAward({ userId: USER, definitionSlug: "first_postcard", sourceType: "postcards", sourceId: POSTCARD });
/** Slugs that must be awarded through placelessAward — 2970's own seed comments name each writer. */
const PLACELESS_SLUGS = ["first_trip_created", "trip_planner", "hidden_gem_explorer", "first_postcard"];

describe("placelessAward carries no place", () => {
  it("keeps the achievement fields and drops nothing else", () => {
    assert.deepEqual(GEM_APPROVAL, { userId: USER, definitionSlug: "hidden_gem_explorer", sourceType: "hidden_gems", sourceId: GEM });
    assert.deepEqual(FIRST_POSTCARD, { userId: USER, definitionSlug: "first_postcard", sourceType: "postcards", sourceId: POSTCARD });
    assert.deepEqual(TRIP_CREATION.map((i) => i.definitionSlug), ["first_trip_created", "trip_planner"]);
  });

  it("strips a place at RUNTIME too — an `as any` cannot smuggle the destination through", () => {
    const smuggled = placelessAward({
      userId: USER, definitionSlug: "trip_planner", sourceType: "trips", sourceId: TRIP,
      city: "Paris", country: "France", lat: 48.85, lng: 2.35,
    } as any);
    for (const k of PLACE_KEYS) assert.ok(!(k in smuggled), `'${k}' survived placelessAward`);
    assert.equal(smuggled.definitionSlug, "trip_planner");
  });

  it("every slug routed through it is one 2970 says is NOT presence", () => {
    const presence = presenceTrueSlugs();
    for (const s of PLACELESS_SLUGS) assert.ok(!presence.has(s), `${s} is presence-TRUE in 2970`);
  });
});

describe("driven through StampAwardEngine: the row written has no place", () => {
  it("creating a trip writes first_trip_created / trip_planner with NULL city and country", async () => {
    for (const input of TRIP_CREATION) {
      const fake = makeEngineFake({
        definition: definitionRow(input.definitionSlug),
        sources: { trips: { status: "planning" } },
      });
      const r = await awardStamp(fake.client, input);
      assert.equal(r.awarded, true, `${input.definitionSlug}: ${r.reason}`);
      const rows = fake.inserted.filter((x) => x.table === "user_stamps").map((x) => x.row);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].city, null, `${input.definitionSlug} row must not claim the destination city`);
      assert.equal(rows[0].country, null, `${input.definitionSlug} row must not claim the destination country`);
    }
  });

  it("approving a gem writes the submitter's stamp with NULL city and country", async () => {
    const fake = makeEngineFake({ definition: definitionRow("hidden_gem_explorer") });
    const r = await awardStamp(fake.client, GEM_APPROVAL);
    assert.equal(r.awarded, true, r.reason);
    const row = fake.inserted.find((x) => x.table === "user_stamps")!.row;
    assert.equal(row.user_id, USER);
    assert.equal(row.city, null, "the submitter's stamp must not claim the gem's city");
    assert.equal(row.country, null);
  });

  it("POSITIVE CONTROL: a presence award (trip completion) still writes its place — the engine is unchanged", async () => {
    const fake = makeEngineFake({
      definition: definitionRow("first_trip_completed"),
      sources: { trips: { status: "completed" } },
    });
    const r = await awardStamp(fake.client, {
      userId: USER, definitionSlug: "first_trip_completed", sourceType: "trips", sourceId: TRIP,
      city: "Lisbon", country: "Portugal",
    });
    assert.equal(r.awarded, true, r.reason);
    const row = fake.inserted.find((x) => x.table === "user_stamps")!.row;
    assert.equal(row.city, "Lisbon");
    assert.equal(row.country, "Portugal");
  });

  it("Countries/Cities stay unchanged after planning trips — even for a reader that ignores the definition", async () => {
    // Collect what the planning writers actually write, then hand those rows to
    // buildStats with the presence flag FORCED TRUE: the worst reader there
    // could be. With no place on the row there is nothing to count.
    const written: Record<string, unknown>[] = [];
    for (const input of TRIP_CREATION) {
      const fake = makeEngineFake({ definition: definitionRow(input.definitionSlug), sources: { trips: { status: "planning" } } });
      await awardStamp(fake.client, input);
      written.push(...fake.inserted.filter((x) => x.table === "user_stamps").map((x) => x.row));
    }
    const asRead = written.map((w) => ({
      user_id: USER, city: w.city, country: w.country, visibility: "public", is_revoked: false,
      stamp_definitions: { category: "trip", slug: String(w.stamp_definition_id).replace(/^def-/, ""), evidences_presence: true },
    }));
    const before = await buildStats(makePassportDb({ user_stamps: [] }) as any, USER);
    const after = await buildStats(makePassportDb({ user_stamps: asRead }) as any, USER);
    assert.equal(after.countries, before.countries, "planning a trip must not add a country");
    assert.equal(after.cities, before.cities, "planning a trip must not add a city");
    assert.equal(after.totalStamps, 2, "the achievements themselves are kept");
  });
});

/** Every `awardStamp(` / `_awardStamp(` call in a file, as its balanced argument text. */
function awardCalls(src: string): string[] {
  const out: string[] = [];
  const re = /\b_?awardStamp\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe("static guard: no route hands a place to a non-presence slug", () => {
  it("every literal-slug award in routes/ that 2970 does not mark presence carries no city/country/lat/lng", () => {
    const presence = presenceTrueSlugs();
    const violations: string[] = [];
    let literalSites = 0;
    for (const f of fs.readdirSync(ROUTES).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(ROUTES, f), "utf8");
      for (const args of awardCalls(src)) {
        const slug = /definitionSlug\s*:\s*["']([a-z0-9_]+)["']/.exec(args)?.[1];
        if (!slug) continue;
        literalSites++;
        if (presence.has(slug)) continue;
        for (const k of PLACE_KEYS) {
          if (new RegExp(`(?:^|[\\s,{])${k}\\s*[:,}\\n]`).test(args)) violations.push(`${f}: ${slug} carries '${k}'`);
        }
      }
    }
    // Non-vacuity: 11 literal-slug sites on main 850cd2b09 (the four of this
    // suite plus verified_traveler, first_event_joined, first_event_hosted,
    // first_buddy_booking, top_rated_buddy, safe_return_ready,
    // safe_return_completed). A parser that finds none proves nothing.
    assert.ok(literalSites >= 11, `found only ${literalSites} literal-slug award sites — the scan is broken`);
    assert.deepEqual(violations, [], "a non-presence stamp was handed a place:\n" + violations.join("\n"));
  });

  it("the four non-presence slugs are awarded through placelessAward(...) and nothing else", () => {
    // The wrapper's result is passed STRAIGHT to awardStamp. A spread such as
    // `{ ...placelessAward(..), city: gem.city }` type-checks (awardStamp takes
    // AwardInput) and would carry the place past the wrapper, so the whole
    // argument shape is pinned, per site.
    const found: string[] = [];
    for (const f of ["trips.ts", "hiddenGems.ts", "posts.ts"]) {
      const src = fs.readFileSync(path.join(ROUTES, f), "utf8");
      for (const args of awardCalls(src)) {
        const slug = /definitionSlug\s*:\s*["']([a-z0-9_]+)["']/.exec(args)?.[1];
        if (!slug || !PLACELESS_SLUGS.includes(slug)) continue;
        found.push(slug);
        assert.match(args, /^\s*\w+,\s*placelessAward\(\{[^{}]*\}\)\s*$/, `${f}: ${slug} is not awarded as awardStamp(client, placelessAward({ ... }))`);
      }
    }
    assert.deepEqual(found.sort(), [...PLACELESS_SLUGS].sort(), "each of the four writers must be found exactly once");
  });

  it("the stamp-earned notification for these awards does not name the destination or the gem's city", () => {
    const read = (f: string) => fs.readFileSync(path.join(ROUTES, f), "utf8");
    assert.doesNotMatch(read("trips.ts"), /location:\s*destinationCity\s*\?\?/);
    assert.doesNotMatch(read("hiddenGems.ts"), /location:\s*\(gemRow as any\)\.city/);
    assert.match(read("trips.ts"), /location:\s*TRIP_CREATION_STAMP_LOCATION_TEXT/);
    assert.match(read("hiddenGems.ts"), /location:\s*GEM_APPROVAL_STAMP_LOCATION_TEXT/);
    assert.match(read("posts.ts"), /location:\s*FIRST_POSTCARD_STAMP_LOCATION_TEXT/);
  });
});
