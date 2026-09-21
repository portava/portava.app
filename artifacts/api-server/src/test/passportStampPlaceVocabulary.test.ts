/**
 * §12 "Place" (census-passport P61) and §11 "canProvideVisaBuddyService" (P59) —
 * the two Passport rows that need NEW CAPABILITY rather than a repair.
 *
 * Both were re-executed 2026-09-14. Neither can reach C on engineering alone,
 * and this file exists to make the REASONS testable facts rather than prose, so
 * that the owner decisions they wait on cannot be closed by accident or rot away
 * unnoticed.
 *
 * ── P61: Place is not Contributor ────────────────────────────────────────────
 * §12 names eleven stamp types, among them PLACE and CONTRIBUTOR as separate
 * entries. The tempting close is to declare them one concept under two names and
 * point `place` at the seeded `place_contributor`. That would be a lie in the
 * data model, and cases 1-4 pin the evidence that they are genuinely distinct:
 * different TABLE, different EARNING ACT, different PROVENANCE enum.
 *
 * Migration `2880_passport_stamps_place_vocabulary.sql` stages the label. It is
 * applied to nothing. Case 7 is the tripwire that replaces the one this lane
 * came past in passportStampTypeVocabulary.test.ts: a staged label with no
 * producer is only safe while nothing writes it, and the union member must not
 * appear before the constraint is applied — otherwise `createStamp` starts
 * emitting a value production rejects 23514 and swallows, which is the exact
 * silent blackout migration 2309 was written to end.
 *
 * ── P59: the tree argues against a Visa Buddy ────────────────────────────────
 * `canProvideVisaBuddyService` is genuinely absent, and this lane did NOT add
 * it. Rent-a-Buddy's own shipping policy is the reason, and it was not on the
 * record before: `POLICY_TEXT` enumerates what the product is for and closes the
 * list with the word "only", and visa assistance is not in it. That text is not
 * an internal constant — it is returned to users on three live endpoints. Cases
 * 8-10 pin it alongside the closed service-category vocabulary.
 *
 * Adding the capability would require amending a user-facing policy, inventing a
 * risk level for a licensed activity, and choosing a trust threshold for
 * immigration advice. That is product and legal work, not engineering.
 * passportProjection.test.ts already pins the six-capability shape, the
 * VISA_HELP scam family and the entry-requirements disclaimer; this file adds
 * the Rent-a-Buddy scope evidence those cases do not cover.
 *
 * MUTATION PROOF — each case names the edit that turns it red, inline.
 *
 * Run: node --import tsx --test src/test/passportStampPlaceVocabulary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { POLICY_TEXT, CATEGORY_RISK_LEVELS } from "../lib/rentaBuddyScanner.js";
import { mapStampSource } from "../services/passport/UnifiedStampService.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SERVER = path.resolve(HERE, "../..");
const MIGRATIONS = path.join(API_SERVER, "src/migrations");

const read = (rel: string) => fs.readFileSync(path.join(API_SERVER, rel), "utf8");

const MIGRATION_2880 = "src/migrations/2880_passport_stamps_place_vocabulary.sql";

/** Labels permitted by the LAST migration that redefines the stamp_type CHECK. */
function stampTypeLabels(): string[] {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (Number(/^(\d+)/.exec(a)?.[1] ?? 0) - Number(/^(\d+)/.exec(b)?.[1] ?? 0)));
  let labels: string[] = [];
  for (const f of files) {
    const ddl = fs
      .readFileSync(path.join(MIGRATIONS, f), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--")) // skip commented ROLLBACK blocks
      .join("\n");
    const re = /ADD CONSTRAINT\s+passport_stamps_stamp_type_check\s+(CHECK[\s\S]*?);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ddl))) {
      const arr = /ARRAY\s*\[([\s\S]*?)\]/.exec(m[1]);
      if (arr) {
        const found = [...arr[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        if (found.length) labels = found;
      }
    }
  }
  return labels;
}

// ─────────────────────────────────────────────────────────────────────────────
// P61 — Place and Contributor are two types, not one
// ─────────────────────────────────────────────────────────────────────────────

describe("§12 Place is not Contributor (census-passport P61)", () => {
  it("1. Contributor lives on stamp_definitions (v2 catalog); Place belongs to passport_stamps (v1)", () => {
    // MUTATION: change 0198's INSERT target to passport_stamps → RED.
    const seed = read("src/migrations/0198_place_contributor_stamps.sql");
    assert.match(
      seed,
      /INSERT INTO stamp_definitions/,
      "place_contributor is seeded into the v2 CATALOG table. If this ever became an " +
        "insert into passport_stamps the two vocabularies really would have merged and " +
        "P61's distinctness argument would need re-reading.",
    );
    assert.ok(
      !/INSERT INTO\s+(public\.)?passport_stamps/.test(seed),
      "0198 must not write passport_stamps — place_contributor is not a v1 presence stamp",
    );

    // ...and the v1 CHECK is where `place` lives.
    const m2880 = read(MIGRATION_2880);
    assert.match(
      m2880,
      /ALTER TABLE public\.passport_stamps[\s\S]*ADD CONSTRAINT passport_stamps_stamp_type_check/,
      "2880 must widen the v1 table's vocabulary, which is where a presence stamp lives",
    );
  });

  it("2. Contributor is earned by a POST COUNT, not by being somewhere", () => {
    // MUTATION: delete STAMP_THRESHOLDS from the worker, or make the award
    // unconditional → RED.
    const worker = read("src/lib/places/placeCollectionsWorker.ts");
    assert.match(
      worker,
      /const STAMP_THRESHOLDS = \[10, 50, 100\]/,
      "the Contributor tiers are post-count thresholds — that is the earning act that " +
        "distinguishes it from a presence stamp",
    );
    assert.match(
      worker,
      /if \(postCount >= threshold\)/,
      "the award must remain conditional on a POST COUNT. A Place stamp is earned by " +
        "presence (gps/checkin); a Contributor stamp by volume of contribution. Same " +
        "place_id, different fact.",
    );
  });

  it("3. the two carry different TABLE 16 provenance", () => {
    // MUTATION: change `case "posts"` in mapStampSource → RED.
    // Contributor is awarded with source_type "posts".
    assert.equal(
      mapStampSource("posts"),
      "contribution_earned",
      "Contributor's provenance is contribution_earned",
    );
    // A Place stamp would come off the v1 GPS writer's provenance strings.
    for (const presence of ["gps", "checkin"]) {
      assert.notEqual(
        mapStampSource(presence),
        "contribution_earned",
        `'${presence}' is a PRESENCE provenance and must not collapse onto the ` +
          `contribution credential — that collapse is exactly the aliasing P61 refuses`,
      );
    }
  });

  it("4. migration 2880 explicitly refuses to alias place_contributor into the v1 table", () => {
    // MUTATION: delete the place_contributor postcondition from 2880 → RED.
    const sql = read(MIGRATION_2880);
    const labels = stampTypeLabels();
    assert.ok(labels.includes("place"), "2880 must admit 'place'");
    assert.ok(
      !labels.includes("place_contributor"),
      "'place_contributor' must NOT be admitted to passport_stamps.stamp_type: it is the " +
        "v2 catalog's contribution credential on another table. Admitting it here would " +
        "make 'I posted here twenty times' and 'I was here' the same value in the column " +
        "every reader branches on.",
    );
    assert.match(
      sql,
      /POSTCONDITION FAILED \(2880\): ''place_contributor'' was added/,
      "2880 must fail loudly if a later edit aliases the two concepts",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P61 — the staged migration, and the producer that must not exist yet
// ─────────────────────────────────────────────────────────────────────────────

describe("§12 Place — migration 2880 is staged and has no producer (census-passport P61)", () => {
  it("5. 2880 follows the house style: staged banner, transaction, pre/postconditions, rollback with an expiry", () => {
    // MUTATION: delete any one of these sections from 2880 → RED.
    const sql = read(MIGRATION_2880);
    assert.match(sql, /⚠ STAGED\. NOT APPLIED TO ANY DATABASE/, "must carry the staged banner");
    assert.match(sql, /^BEGIN;/m, "ADD CONSTRAINT revalidates rows; must be transactional");
    assert.match(sql, /^COMMIT;/m);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS/, "must be re-runnable");
    assert.match(sql, /PRECONDITION FAILED \(2880\)/, "must state preconditions");
    assert.match(sql, /POSTCONDITION FAILED \(2880\)/, "must state postconditions");
    assert.match(sql, /REVERSIBLE BY/, "must state a rollback");
    assert.match(
      sql,
      /EXPIRY CONDITION/,
      "a rollback that deletes earned stamps must name the condition under which it stops " +
        "being a rollback and becomes data loss",
    );
    assert.match(sql, /WHAT WAS MEASURED BEFORE WRITING IT/, "must record the measurement");
    assert.match(sql, /WHAT THIS DOES NOT BUY/, "must state what it does not buy");
  });

  it("6. 2880 requires 2309 rather than silently delivering it", () => {
    // MUTATION: remove the 2309 precondition loop from 2880 → RED.
    // Measured 2026-09-14: production is STILL on the pre-2309 seven, so a 2880
    // that carried the full seventeen unconditionally would ship 2309's nine
    // labels as an undocumented side effect of a migration about Place.
    const sql = read(MIGRATION_2880);
    assert.match(
      sql,
      /so migration 2309 is not applied\. Apply 2309 first/,
      "2880 must refuse to run on a pre-2309 database and say why",
    );
  });

  it("7. NOTHING WRITES 'place' YET — the label is staged, the producer is an owner decision", () => {
    // THIS IS THE TRIPWIRE. It replaces the `!labels.includes("place")` guard
    // that passportStampTypeVocabulary.test.ts carried before 2880 was written.
    //
    // MUTATION: add "place" to PassportStampService's StampType union, or pass
    // `stampType: "place"` from any route → RED.
    //
    // WHY IT MUST STAY RED UNTIL THE OWNER RULES. `2880` is staged and applied
    // to nothing. A union member added before the constraint is applied lets a
    // developer write createStamp({ stampType: "place" }); production rejects it
    // 23514 and createStamp swallows the error with a null return that every
    // caller ignores. That is the silent blackout 2309 exists to end, and it
    // would be reintroduced by a one-word edit.
    const svc = read("src/services/passport/PassportStampService.ts");
    const union = /export type StampType\s*=([\s\S]*?);/.exec(svc);
    assert.ok(union, "PassportStampService must still declare `export type StampType`");
    const declared = [...union[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    assert.ok(
      !declared.includes("place"),
      "'place' was added to StampType while migration 2880 is still STAGED. The constraint " +
        "must be applied FIRST (2880's 'DO NOT APPLY BEFORE' section), and what earns a " +
        "Place stamp is owner decision D-STAMP, which exists in no spec in this repo. " +
        "Until both land, a Place write is rejected 23514 and silently swallowed.",
    );

    // And no route may pass the literal either.
    const routes = path.join(API_SERVER, "src/routes");
    const offenders: string[] = [];
    for (const f of fs.readdirSync(routes).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(routes, f), "utf8");
      if (/stampType:\s*["']place["']/.test(src)) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      `these routes already write a Place stamp: ${offenders.join(", ")}. The vocabulary ` +
        `migration that makes it storable is staged, not applied.`,
    );
  });
});

describe("§12 Place — data model, projection and UI labels agree (census-passport P61)", () => {
  it("12. the projection carries stamp_type VERBATIM, so it needs no change to admit 'place'", () => {
    // MUTATION: replace the verbatim passthrough with an allowlist → RED.
    // This is why P61 is a label + a producer and not a projection change.
    const unified = read("src/services/passport/UnifiedStampService.ts");
    assert.match(
      unified,
      /stampType:\s*r\.stamp_type\s*\?\?\s*null/,
      "readV1 must keep passing stamp_type through verbatim. An allowlist here would " +
        "silently drop a Place stamp after the migration made it storable — the reader " +
        "half of the same blackout 2309 fixed on the writer half.",
    );
  });

  it("13. the client's Location filter lists Place AND Contributor as distinct labels", () => {
    // MUTATION: remove 'place' (or 'place_contributor') from the location array
    // in StampsTab.tsx → RED.
    const tab = fs.readFileSync(
      path.resolve(API_SERVER, "../../travel-buddy-standalone/src/components/StampsTab.tsx"),
      "utf8",
    );
    const arr = /if \(cat === 'location'\)[\s\S]*?\[([^\]]*)\]\.includes\(sType\)/.exec(tab);
    assert.ok(arr, "StampsTab must still filter the Location pill by a stamp_type list");
    const listed = [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for (const label of ["place", "place_contributor"]) {
      assert.ok(
        listed.includes(label),
        `the Location pill does not list '${label}'. Place and Contributor are two of §12's ` +
          `eleven types and BOTH belong under Location; a type that is missing here renders ` +
          `under All and vanishes under the pill. They are listed separately on purpose — ` +
          `neither is an alias of the other.`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P59 — Rent-a-Buddy's shipping policy excludes visa assistance
// ─────────────────────────────────────────────────────────────────────────────

describe("§11 Visa Buddy — the Rent-a-Buddy scope that forbids it (census-passport P59)", () => {
  it("8. POLICY_TEXT enumerates what Rent-a-Buddy is for and closes the list with 'only'", () => {
    // MUTATION: delete the word "only" from POLICY_TEXT, or add visa support to
    // the enumeration → RED.
    //
    // This is the evidence P59 did not previously have on the record. The row
    // was argued from the VISA_HELP scam family and the entry-requirements
    // disclaimer (both pinned in passportProjection.test.ts). But Rent-a-Buddy —
    // the very architecture a Visa Buddy would have to be built inside — states
    // its own permitted scope, exhaustively, in text shown to users.
    assert.match(
      POLICY_TEXT,
      /\bonly\b/,
      "the scope list must remain CLOSED. An open list would make 'is visa help in scope?' " +
        "an engineering judgement instead of a product decision.",
    );
    for (const permitted of [
      "travel companionship",
      "city guidance",
      "language support",
      "local help",
      "arrival support",
    ]) {
      assert.ok(
        POLICY_TEXT.includes(permitted),
        `POLICY_TEXT must still enumerate '${permitted}' — the enumeration is the scope`,
      );
    }
    assert.ok(
      !/visa/i.test(POLICY_TEXT),
      "visa assistance has been added to the Rent-a-Buddy scope. That is a product and " +
        "legal change (immigration advice is licensed in several markets this product " +
        "names), and it is the FIRST of the three things census-passport P59 needs. " +
        "Re-read P59 and VISA_BUDDY_CAPABILITY before adding canProvideVisaBuddyService.",
    );
  });

  it("9. the service-category vocabulary is closed, and has no visa category", () => {
    // MUTATION: add a `visa` key to CATEGORY_RISK_LEVELS → RED.
    const categories = Object.keys(CATEGORY_RISK_LEVELS);
    assert.ok(categories.length > 0, "CATEGORY_RISK_LEVELS must remain the category vocabulary");
    const visaish = categories.filter((c) => /visa|immigration|border|entry/i.test(c));
    assert.deepEqual(
      visaish,
      [],
      `a visa-adjacent buddy service category now exists: ${visaish.join(", ")}. Every ` +
        `category carries a risk level that gates the booking flow; choosing one for ` +
        `immigration assistance is the policy call P59 is waiting on, not a default.`,
    );
  });

  it("10. POLICY_TEXT is user-facing, so its scope is a promise and not an internal note", () => {
    // MUTATION: stop returning policyText from the booking routes → RED.
    // This is what makes case 8 load-bearing: the scope list is shipped to the
    // traveller and the buddy at booking time.
    const rab = read("src/routes/rentABuddy.ts");
    const served = [...rab.matchAll(/policyText:\s*POLICY_TEXT/g)];
    assert.ok(
      served.length >= 3,
      `POLICY_TEXT must still be served to users (found ${served.length} of the 3 known ` +
        `booking responses). If it stopped shipping, the scope would become an internal ` +
        `constant and P59's strongest evidence would be weaker than this file claims.`,
    );
  });

  it("11. this lane added no Visa Buddy capability, table, or payment path", () => {
    // MUTATION: create any of these → RED.
    //
    // The instruction for this row was to build Visa Buddy only through the
    // existing capability / authorization / payment / safety architecture, and
    // explicitly NOT to create a parallel booking or trust system. Having traced
    // it, the honest finding is that the existing architecture does not have a
    // seam for it — it has a closed scope list that excludes it. So nothing was
    // built. This case proves the negative.
    const capSrc = read("src/services/passport/PassportProjectionService.ts");
    assert.ok(
      !/canProvideVisaBuddyService/.test(capSrc),
      "a seventh capability appeared in the projection. P59 needs an owner ruling first " +
        "(VISA_BUDDY_CAPABILITY): what it authorises that VISA_HELP does not already " +
        "classify as fraud, and what evidence — not what trust score — qualifies a person.",
    );
    // No parallel booking/eligibility/payment surface was introduced.
    for (const dir of ["src/routes", "src/services", "src/lib"]) {
      const base = path.join(API_SERVER, dir);
      const walk = (d: string): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
        );
      const hits = walk(base).filter((f) => /visabuddy|visa_buddy/i.test(path.basename(f)));
      assert.deepEqual(
        hits.map((h) => path.relative(API_SERVER, h)),
        [],
        "a Visa Buddy module was created. Rent-a-Buddy already owns booking, eligibility, " +
          "payment and safety; a second one of any of those is a failure of this task even " +
          "if every test passes.",
      );
    }
    // And no new migration introduced a visa_buddy table.
    const visaMigrations = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => /visa/i.test(f));
    assert.deepEqual(visaMigrations, [], "no visa_buddy schema may be staged without the owner ruling");
  });
});
