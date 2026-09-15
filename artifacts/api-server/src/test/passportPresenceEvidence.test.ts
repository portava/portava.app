/**
 * PASSPORT PRESENCE — a planned trip is not a country you have visited.
 *
 * THE DEFECT THIS SUITE EXISTS FOR (census-highlights-memories §K.4):
 *
 *   `POST /api/trips` awards `first_trip_created` and `trip_planner` AT CREATION
 *   (routes/trips.ts), passing `city: destinationCity, country: destinationCountry`.
 *   `StampAwardEngine#awardStamp` writes that city/country into `user_stamps`.
 *   `buildStats` then did `if (r.country) countries.add(r.country)` for EVERY
 *   non-revoked row — so five trips planned and none taken produced
 *   `countries: 5`, which `PassportIdentityCard.tsx` renders as "Countries" and
 *   which earns the "World Traveler — 5 or more countries visited" watermark.
 *
 *   Plan five trips, take none, become a World Traveler.
 *
 * That is census-highlights-memories H4's prohibition ("Planned/saved/nearby
 * never represented as 'experienced' without occurrence evidence or user
 * confirmation") and H239's invariant ("planned activity without occurrence
 * cannot earn a visit Memory/Stamp"), on a shipping screen.
 *
 * WHERE THE PROPERTY LIVES. "Does this stamp evidence that the traveller was
 * actually THERE?" is a property of the STAMP DEFINITION, not of one service.
 * Migration 2970 adds `stamp_definitions.evidences_presence` (NOT NULL DEFAULT
 * false — see that file's header for why the default fails safe) and seeds it
 * per slug. A hard-coded list private to `PassportMapService` would have been
 * the first of twenty: §K.4 counts 26 non-test read sites of `user_stamps`
 * across 20 files.
 *
 * EVERY EXCLUSION HERE IS PAIRED WITH A POSITIVE CONTROL. A test that only
 * asserts "the number went down" also passes if the counter was broken
 * outright — which is the exact defect `buildStats` shipped once already (all
 * four category counters structurally zero, see passportMapService.test.ts).
 * So each "planned trips do not count" assertion sits beside one that a
 * genuinely-earned presence stamp DOES still count.
 *
 * MUTATION PROOFS: see the lane report. Each of these was performed and each
 * turned this file RED — (a) removing the presence filter from `buildStats`,
 * (b) flipping `trip_planner` to `evidences_presence = true` in the seed,
 * (c) making the column default true, (d) making every slug non-presence
 * (which reddens the positive controls, not the exclusions).
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/passportPresenceEvidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStats } from "../services/passport/PassportMapService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "presence-owner-1";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

/** The column the stamp definition carries the property on. */
const PRESENCE_COLUMN = "evidences_presence";

/**
 * A `user_stamps` row in the shape `buildStats` reads it: the row's own
 * city/country plus the embedded definition. `evidences_presence` rides on the
 * EMBEDDED DEFINITION, not on the stamp row — the property belongs to the
 * definition, and a per-row copy would be a second place for it to drift.
 */
function userStamp(
  slug: string,
  evidencesPresence: boolean,
  over: Record<string, any> = {},
) {
  return {
    user_id: OWNER,
    country: "Vietnam",
    city: "Da Nang",
    visibility: "public",
    is_revoked: false,
    stamp_definitions: { category: "trip", slug, [PRESENCE_COLUMN]: evidencesPresence },
    ...over,
  };
}

/** The five trips of §K.4: planned, published, never taken. */
function fivePlannedNeverTaken() {
  const places: Array<[string, string]> = [
    ["Vietnam", "Da Nang"],
    ["Thailand", "Bangkok"],
    ["Japan", "Kyoto"],
    ["Portugal", "Lisbon"],
    ["Mexico", "Oaxaca"],
  ];
  // Exactly what routes/trips.ts:413-440 awards at creation, per trip.
  return places.flatMap(([country, city]) => [
    userStamp("first_trip_created", false, { country, city }),
    userStamp("trip_planner", false, { country, city }),
  ]);
}

describe("buildStats — a trip you planned and never took is not a country you visited", () => {
  it("§K.4 verbatim: five trips planned, zero taken, countries is 0 and not 5", async () => {
    const db = makePassportDb({ user_stamps: fivePlannedNeverTaken() });
    const stats = await buildStats(db as any, OWNER);

    assert.equal(
      stats.countries,
      0,
      "five planned-and-never-taken trips must earn ZERO countries — " +
        "this reading 5 is the World Traveler watermark being earned by planning",
    );
    assert.equal(stats.cities, 0, "and zero cities, by the same argument");

    // WHAT KEEPS THIS HONEST: totalStamps is NOT a been-there claim — it is
    // "how many stamps do you have" — so it must be untouched by this repair.
    // If this drops to 0 the filter has been applied to the wrong thing.
    assert.equal(stats.totalStamps, 10, "totalStamps keeps its meaning: every non-revoked row");
    assert.equal(stats.readFailed, false, "a healthy read, not a swallowed failure");
  });

  it("POSITIVE CONTROL: a genuinely-earned presence stamp still counts its country", async () => {
    // `first_trip_completed` is awarded by awardTripCompletionStamps
    // (routes/trips.ts:115-230) only when the trip reaches status 'completed'.
    const db = makePassportDb({
      user_stamps: [userStamp("first_trip_completed", true, { country: "Japan", city: "Kyoto" })],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.countries, 1, "a COMPLETED trip must still count its country");
    assert.equal(stats.cities, 1);
    assert.equal(stats.totalStamps, 1);
  });

  it("POSITIVE CONTROL: the two mix — only the presence half reaches the count", async () => {
    const db = makePassportDb({
      user_stamps: [
        ...fivePlannedNeverTaken(),
        // Really went to Kyoto (trip completed) and really posted from Bangkok
        // (GPS-verified postcard → city_explorer, routes/posts.ts:721-765).
        userStamp("first_trip_completed", true, { country: "Japan", city: "Kyoto" }),
        userStamp("city_explorer", true, { country: "Thailand", city: "Bangkok" }),
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.countries, 2, "Japan and Thailand — NOT the five planned destinations");
    assert.equal(stats.cities, 2, "Kyoto and Bangkok");
    assert.equal(stats.totalStamps, 12, "all twelve rows are still stamps");
  });

  it("the four STATS_SLUG_BUCKETS counters and totalStamps keep their current meaning", async () => {
    // The repair must not make a planning stamp VANISH. `trip_planner` is a
    // stamp the user really did earn; it is only not EVIDENCE OF PRESENCE. It
    // is in none of the four buckets (those are attend/host/gem/safe-return),
    // so what proves it survived is `totalStamps`.
    const db = makePassportDb({
      user_stamps: [
        userStamp("trip_planner", false, { stamp_definitions: { category: "community", slug: "trip_planner", [PRESENCE_COLUMN]: false } }),
        userStamp("event_participant", false, { stamp_definitions: { category: "event", slug: "event_participant", [PRESENCE_COLUMN]: false } }),
        userStamp("good_host", true, { stamp_definitions: { category: "community", slug: "good_host", [PRESENCE_COLUMN]: true } }),
        userStamp("safe_return_completed", false, { stamp_definitions: { category: "safety", slug: "safe_return_completed", [PRESENCE_COLUMN]: false } }),
        userStamp("hidden_gem_explorer", false, { stamp_definitions: { category: "special", slug: "hidden_gem_explorer", [PRESENCE_COLUMN]: false } }),
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.planStamps, 1, "event_participant still counts as a plan stamp");
    assert.equal(stats.hostStamps, 1, "good_host still counts as a host stamp");
    assert.equal(stats.safeReturnStamps, 1, "safe_return_completed still counts as a safe return");
    assert.equal(stats.hiddenGemStamps, 1, "hidden_gem_explorer still counts as a gem stamp");
    assert.equal(stats.totalStamps, 5, "every non-revoked row is still a stamp the user earned");
    // ...and the been-there claim is the ONLY thing narrowed: good_host is the
    // one presence row here, so exactly one country.
    assert.equal(stats.countries, 1, "only the presence row reaches the country set");
  });

  it("a MISSING presence property is treated as NOT presence, not as presence", async () => {
    // The fail-safe direction, at the one place a NULL can still arrive: a row
    // whose embedded definition predates the column, or an embed that came back
    // without it. Over-claiming is the defect; under-claiming is not.
    const db = makePassportDb({
      user_stamps: [
        { user_id: OWNER, country: "Peru", city: "Cusco", visibility: "public", is_revoked: false,
          stamp_definitions: { category: "trip", slug: "some_future_slug" } },
        { user_id: OWNER, country: "Peru", city: "Cusco", visibility: "public", is_revoked: false,
          stamp_definitions: { category: "trip", slug: "another_future_slug", [PRESENCE_COLUMN]: null } },
      ],
    });
    const stats = await buildStats(db as any, OWNER);
    assert.equal(stats.countries, 0, "absent/null presence must read as NOT presence");
    assert.equal(stats.totalStamps, 2);
  });

  it("reads the embedded definition whether PostgREST returns an object or a one-element array", async () => {
    // The same both-shapes hazard the slug buckets already handle. A wrong guess
    // here reintroduces the defect in a new disguise — or silently zeroes the
    // count for everyone, which is why both directions are asserted.
    const asArray = makePassportDb({
      user_stamps: [
        { user_id: OWNER, country: "Japan", city: "Kyoto", visibility: "public", is_revoked: false,
          stamp_definitions: [{ category: "trip", slug: "first_trip_completed", [PRESENCE_COLUMN]: true }] },
        { user_id: OWNER, country: "Chile", city: "Valparaiso", visibility: "public", is_revoked: false,
          stamp_definitions: [{ category: "trip", slug: "first_trip_created", [PRESENCE_COLUMN]: false }] },
      ],
    });
    const stats = await buildStats(asArray as any, OWNER);
    assert.equal(stats.countries, 1, "the array-shaped embed must be read, both ways round");
  });
});

describe("the presence property is asked for, and is a real column", () => {
  it("buildStats NAMES the presence column in its user_stamps select", async () => {
    // WITHOUT THIS the behavioural tests above can pass on a fixture that
    // supplies a column production never selected — the blind spot
    // test/helpers/selectProjection.ts exists to close, and which the embedded
    // `stamp_definitions(...)` resource makes the projector bail on here.
    // Against the real database an unselected column reads `undefined`, every
    // stamp reads as non-presence, and the Countries number silently becomes 0
    // for everyone. So: capture the real select string and assert it.
    const selects: string[] = [];
    const db: any = {
      from(table: string) {
        const b: any = {
          select(cols: string) { if (table === "user_stamps") selects.push(cols); return b; },
          eq() { return b; },
          then(res: any) { return Promise.resolve({ data: [], error: null }).then(res); },
        };
        return b;
      },
    };
    await buildStats(db, OWNER);
    assert.equal(selects.length, 1, "buildStats reads user_stamps exactly once");
    assert.ok(
      selects[0].includes(PRESENCE_COLUMN),
      `buildStats must SELECT ${PRESENCE_COLUMN} on the embedded stamp_definitions; ` +
        `got: ${selects[0]}`,
    );
    assert.ok(
      new RegExp(`stamp_definitions\\s*\\([^)]*\\b${PRESENCE_COLUMN}\\b`).test(selects[0]),
      `${PRESENCE_COLUMN} must be selected INSIDE the stamp_definitions embed, not at top level; ` +
        `got: ${selects[0]}`,
    );
  });

  it("a migration in band 2970-2979 adds the column and seeds it per slug", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^297\d_.*\.sql$/.test(f));
    assert.equal(files.length, 1, `expected exactly one migration in band 2970-2979, got ${files.join(", ") || "none"}`);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), "utf8");

    assert.ok(
      new RegExp(`ALTER\\s+TABLE[\\s\\S]{0,80}stamp_definitions[\\s\\S]{0,200}${PRESENCE_COLUMN}`, "i").test(sql),
      "the migration must ADD the column to stamp_definitions",
    );
    // MATCH THE DDL, NOT THE PROSE. `/DEFAULT\s+false/` over the whole file
    // passed even with the ALTER changed to `DEFAULT true`, because the header
    // and the COMMENT both contain the words "DEFAULT false". That mutation
    // SURVIVED until this assertion was narrowed to the statement itself.
    const alter = /ALTER\s+TABLE\s+public\.stamp_definitions\s+ADD\s+COLUMN[^;]*;/i.exec(sql);
    assert.ok(alter, "the migration must carry an ALTER TABLE ... ADD COLUMN statement");
    assert.ok(
      new RegExp(`${PRESENCE_COLUMN}[^;]*\\bDEFAULT\\s+false\\b`, "i").test(alter[0]),
      "the column must default FALSE in the DDL — over-claiming 'you have been to N countries' " +
        `is the defect, under-claiming is not. Statement was: ${alter[0]}`,
    );
    assert.ok(
      !/\bDEFAULT\s+true\b/i.test(alter[0]),
      `the DDL must not default TRUE: ${alter[0]}`,
    );
    assert.ok(
      /NOT\s+NULL/i.test(alter[0]),
      "the column must be NOT NULL — a three-valued flag pushes the NULL decision out to 26 readers",
    );
    assert.ok(/-- REVERSAL/i.test(sql), "the migration must carry an exact REVERSAL block");
    assert.ok(/RAISE\s+NOTICE/i.test(sql), "the migration must RAISE NOTICE if its assertion would be vacuous");

    // The two slugs of §K.4 must be seeded FALSE by name, in the migration, so a
    // later reader can see the decision rather than infer it from the default.
    for (const slug of ["first_trip_created", "trip_planner"]) {
      assert.ok(sql.includes(`'${slug}'`), `the migration must name '${slug}' explicitly`);
    }
  });

  it("every slug the migration marks presence is one a migration actually seeds", () => {
    // A presence seed naming a slug that does not exist is a no-op that reads
    // like a decision. The postconditions in the migration assert the COUNT for
    // the same reason; this asserts the vocabulary.
    const seeded = new Set<string>();
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?stamp_definitions\b([\s\S]*?);/gi)) {
        const cm = /\(([^)]*?)\)\s*(?:VALUES|SELECT)/i.exec(m[1]);
        if (!cm) continue;
        const cols = cm[1].split(",").map((c) => c.trim());
        if (cols[0] !== "slug") continue;
        for (const t of m[1].slice(cm.index + cm[0].length).matchAll(/\(\s*'([a-z0-9_]+)'/g)) {
          seeded.add(t[1]);
        }
      }
    }
    assert.ok(seeded.size >= 60, `slug vocabulary looks truncated: ${seeded.size} slugs`);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^297\d_.*\.sql$/.test(f));
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, files[0]), "utf8");
    const presenceBlock = /--\s*PRESENCE-TRUE-SLUGS-BEGIN([\s\S]*?)--\s*PRESENCE-TRUE-SLUGS-END/.exec(sql);
    assert.ok(presenceBlock, "the migration must delimit its presence-TRUE slug list for this check");
    // Strip `--` comment lines first: the block carries prose that quotes SQL
    // literals (`status = 'completed'`), and those are not slugs.
    const codeOnly = presenceBlock[1]
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    const named = [...codeOnly.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    assert.equal(named.length, 13, `expected 13 presence slugs in the delimited block, got ${named.length}: ${named.join(", ")}`);

    // WHY A COUNT IS NOT ENOUGH — this caught a SURVIVING mutation. Swapping
    // `trip_planner` INTO the presence list and `good_host` OUT keeps the count
    // at 13 and satisfies every other check in this file. The migration's own
    // SQL postcondition would refuse it, but that postcondition runs only when
    // the migration is APPLIED, and it is applied nowhere. So the exclusion is
    // asserted here, by name, against the list the defect is actually about.
    const MUST_NOT_EVIDENCE_PRESENCE = [
      "first_trip_created",    // awarded at POST /api/trips with the destination attached
      "trip_planner",          // same call site, same payload
      "hidden_gem_explorer",   // awarded to the SUBMITTER on admin approval
      "first_postcard",        // postcard city attached but not gated on stampEligible
      "safe_return_ready",
      "safe_return_completed",
      "event_participant",
      "first_event_joined",
      "first_event_hosted",
      "verified_traveler",
    ];
    for (const slug of MUST_NOT_EVIDENCE_PRESENCE) {
      assert.ok(
        !named.includes(slug),
        `'${slug}' is in the presence-TRUE list. It is earned without being there — ` +
          `marking it presence re-opens census-highlights-memories §K.4 exactly.`,
      );
    }

    // And the other direction: each of those must be set FALSE by name in the
    // migration, so the decision is visible rather than inherited from the
    // default. A slug that appears in NEITHER list has been forgotten.
    const falseBlock = /SET\s+evidences_presence = false\s+WHERE\s+slug IN \(([\s\S]*?)\);/.exec(sql);
    assert.ok(falseBlock, "the migration must set the planning slugs FALSE by name");
    const falseCode = falseBlock[1]
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    const namedFalse = [...falseCode.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    for (const slug of MUST_NOT_EVIDENCE_PRESENCE) {
      assert.ok(namedFalse.includes(slug), `'${slug}' is not set FALSE by name in the migration`);
    }

    // POSITIVE CONTROL for the two assertions above: the lists must be
    // DISJOINT and both non-empty, or "not in the other list" is vacuous.
    assert.ok(named.length > 0 && namedFalse.length > 0, "both lists must be populated");
    assert.equal(
      named.filter((x) => namedFalse.includes(x)).length,
      0,
      "a slug cannot be both presence-evidencing and not",
    );
    assert.ok(named.length > 0, "at least one slug must evidence presence, or Countries is dead for everyone");
    for (const slug of named) {
      assert.ok(seeded.has(slug), `presence slug '${slug}' is seeded by no migration`);
    }
  });
});
