/**
 * THE CRITERIA ENGINE LAUNDERS A PLANNED TRIP INTO A VISIT STAMP.
 *
 * Migration 2970 and `PassportMapService#buildStats` closed the Passport's
 * "Countries"/"Cities" numbers against planning stamps: only a definition
 * carrying `stamp_definitions.evidences_presence` may contribute. That
 * migration's own header names two surfaces it did NOT fix, and this suite is
 * about the first and worse of them:
 *
 *   `src/lib/stamps/criteria/metrics.ts`
 *     countries_visited: (sc, u) => distinctStampField(sc, u, "country")
 *
 * `distinctStampField` selects ONE COLUMN off `user_stamps` with no join and no
 * presence filter, so it counts exactly the rows 2970 excluded. Migration 0192
 * seeds `globe_trotter_5` as `{"metric":"countries_visited","gte":5}` and
 * `globe_trotter_10` at 10.
 *
 * So: plan five trips, take none, and the criteria engine MINTS Globe Trotter —
 * "Visit 5 different countries". And 2970 marks `globe_trotter_5` and
 * `globe_trotter_10` `evidences_presence = true`, because a GPS-verified
 * postcard is the only thing that was supposed to award them. The minted stamp
 * is therefore admitted by the very filter 2970 added: the planning rows are
 * excluded from Countries, and the achievement they illegitimately minted is
 * counted. The fix went around itself.
 *
 * The rule is the same one 2970 states and must be asked in the same place: a
 * been-there claim counts only definitions that evidence presence, and a
 * definition that did not load, or that carries no such property, is NOT
 * presence. Over-claiming is the defect; under-claiming is not.
 *
 * EVERY EXCLUSION HERE IS PAIRED WITH A POSITIVE CONTROL, because "the number
 * went down" also passes if the metric was broken outright — which is exactly
 * what `buildStats` shipped once before (four counters structurally zero, see
 * passportMapService.test.ts).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/stampCriteriaPresenceEvidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMetric } from "../lib/stamps/criteria/metrics.js";
import { evaluateCriteria } from "../lib/stamps/criteria/evaluator.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER = "criteria-presence-user-1";

/** A `user_stamps` row with its definition embedded, as PostgREST returns it. */
function stamp(
  slug: string,
  evidencesPresence: boolean | undefined,
  country: string,
  city: string,
) {
  const def: Record<string, any> = { slug };
  if (evidencesPresence !== undefined) def.evidences_presence = evidencesPresence;
  return {
    user_id: USER,
    country,
    city,
    is_revoked: false,
    stamp_definitions: def,
  };
}

const FIVE_PLACES: Array<[string, string]> = [
  ["Vietnam", "Da Nang"],
  ["Thailand", "Bangkok"],
  ["Japan", "Kyoto"],
  ["Portugal", "Lisbon"],
  ["Mexico", "Oaxaca"],
];

/** Exactly what `POST /api/trips` awards at creation, for five planned trips. */
function fivePlannedNeverTaken() {
  return FIVE_PLACES.flatMap(([country, city]) => [
    stamp("first_trip_created", false, country, city),
    stamp("trip_planner", false, country, city),
  ]);
}

/** The same five journeys, actually completed. */
function fiveCompleted() {
  return FIVE_PLACES.map(([country, city]) =>
    stamp("first_trip_completed", true, country, city),
  );
}

import type { EvalContext } from "../lib/stamps/criteria/metrics.js";

/** No trigger-site overrides: every metric below resolves from the DB. */
const ctx: EvalContext = { context: {} };

describe("countries_visited / cities_visited count only stamps that evidence presence", () => {
  it("DEFECT: five trips planned and none taken resolve countries_visited to 0, not 5", async () => {
    const db = makePassportDb({ user_stamps: fivePlannedNeverTaken() });
    assert.equal(await resolveMetric(db, USER, "countries_visited", ctx), 0);
    assert.equal(await resolveMetric(db, USER, "cities_visited", ctx), 0);
  });

  it("POSITIVE CONTROL: five journeys actually completed resolve to 5", async () => {
    // Without this the assertion above is satisfied by a metric that counts
    // nothing at all, which is a different defect wearing the fix's clothes.
    const db = makePassportDb({ user_stamps: fiveCompleted() });
    assert.equal(await resolveMetric(db, USER, "countries_visited", ctx), 5);
    assert.equal(await resolveMetric(db, USER, "cities_visited", ctx), 5);
  });

  it("POSITIVE CONTROL: the two mixed — only the presence half is counted", async () => {
    const db = makePassportDb({
      user_stamps: [
        ...fivePlannedNeverTaken(),
        stamp("first_trip_completed", true, "Iceland", "Reykjavik"),
      ],
    });
    assert.equal(await resolveMetric(db, USER, "countries_visited", ctx), 1);
    assert.equal(await resolveMetric(db, USER, "cities_visited", ctx), 1);
  });

  it("FAIL-CLOSED: a definition that did not load is NOT presence", async () => {
    // A missing join is not evidence of a visit. `undefined` must read as
    // "not presence", exactly as buildStats' `=== true` does.
    const db = makePassportDb({
      user_stamps: [
        { user_id: USER, country: "Peru", city: "Cusco", is_revoked: false },
        stamp("first_trip_completed", undefined, "Chile", "Valparaiso"),
      ],
    });
    assert.equal(await resolveMetric(db, USER, "countries_visited", ctx), 0);
    assert.equal(await resolveMetric(db, USER, "cities_visited", ctx), 0);
  });

  it("a REVOKED presence stamp still does not count (unchanged behaviour)", async () => {
    const rows = fiveCompleted().map((r) => ({ ...r, is_revoked: true }));
    const db = makePassportDb({ user_stamps: rows });
    assert.equal(await resolveMetric(db, USER, "countries_visited", ctx), 0);
  });
});

// ── §L.5's survivor G, applied to both sites this suite covers ──────────────
//
// census-highlights-memories §L.5 records a mutation that SURVIVED every
// behavioural test of `buildStats`: removing `evidences_presence` from its
// SELECT. The fixtures embed `stamp_definitions` whatever the select string
// says, so the double keeps returning it — while against a real database an
// unselected column reads `undefined`, every stamp reads non-presence, and the
// numbers silently become 0 for everyone. Only an assertion about the select
// string itself catches that, so the two sites this suite covers get one.
//
// §L.5 also records that a typo (`evidences_presenc`) survived
// `check:schema-references` unchanged — that checker does not parse columns
// inside embedded resources — so its passing is not evidence either.
describe("both readers ASK for the column, not just filter on it", () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const embed = /stamp_definitions\s*\(\s*[^)]*\bevidences_presence\b/;

  it("distinctStampField selects stamp_definitions(evidences_presence)", () => {
    const src = fs.readFileSync(path.join(SRC, "lib/stamps/criteria/metrics.ts"), "utf8");
    const fn = src.slice(src.indexOf("async function distinctStampField"));
    assert.match(
      fn.slice(0, fn.indexOf("\n}")), embed,
      "the presence filter reads a column this select does not ask for: against a real " +
      "database it is undefined, every stamp reads non-presence, and cities_visited / " +
      "countries_visited become 0 for everyone",
    );
  });

  it("buildGraphFromSources selects it on its user_stamps read", () => {
    const src = fs.readFileSync(path.join(SRC, "compass/CompassGraphEngine.ts"), "utf8");
    const i = src.indexOf('.from("user_stamps")');
    assert.ok(i > 0, "the graph builder no longer reads user_stamps");
    assert.match(
      src.slice(i, i + 400), embed,
      "the visited-edge gate reads a column this select does not ask for",
    );
  });
});

describe("globe_trotter_5 — 'Visit 5 different countries' — cannot be minted by planning", () => {
  // Migration 0192, verbatim.
  const GLOBE_TROTTER_5 = { version: 1, metric: "countries_visited", gte: 5 };

  it("DEFECT: five planned-never-taken trips do NOT satisfy it", async () => {
    const db = makePassportDb({ user_stamps: fivePlannedNeverTaken() });
    const r = await evaluateCriteria(db, USER, GLOBE_TROTTER_5, ctx);
    assert.equal(
      r.met, false,
      `five trips planned and none taken minted "Visit 5 different countries": ${JSON.stringify(r)}`,
    );
  });

  it("POSITIVE CONTROL: five completed journeys DO satisfy it", async () => {
    const db = makePassportDb({ user_stamps: fiveCompleted() });
    const r = await evaluateCriteria(db, USER, GLOBE_TROTTER_5, ctx);
    assert.equal(r.met, true, JSON.stringify(r));
  });
});
