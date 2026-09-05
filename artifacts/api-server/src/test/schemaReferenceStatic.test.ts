/**
 * Static schema-reference contract — `check:schema-references`.
 *
 * THE RECURRENCE THIS EXISTS FOR
 * ------------------------------
 * `places.country` — the table has `country_code` and has never had `country` —
 * broke place identity on every media projection, silently, because PostgREST
 * fails the WHOLE read on an unknown select-list column (PGRST100) and the read
 * sat in a best-effort catch. It was found, documented as the founding example
 * in `silentSchemaErrorCatches.test.ts`, fixed, AND THEN RECURRED in
 * `MediaProjectionService.ts`, reaching `main`.
 *
 * TWO INDEPENDENT DEFENCES, DELIBERATELY NOT MERGED
 * -------------------------------------------------
 *   wrong schema reference        -> THIS contract catches the CAUSE
 *   schema error swallowed by a
 *     best-effort catch           -> silentSchemaErrorCatches catches the
 *                                    MECHANISM that hides it
 *
 * Either alone leaves a hole. A correct reference inside a silent catch is
 * fine today and lethal after the next rename; a wrong reference that throws
 * loudly is caught in minutes. The pair is the point, and neither test should
 * be folded into the other.
 *
 * WHY THIS ONE IS STATIC
 * ----------------------
 * The repo already had a check that catches this class — `check:write-path-columns`
 * — but it diffs against the LIVE database, so it runs only where credentials
 * exist, on a lane that was evicting 64 of every 100 runs and leaving 45% of
 * commits with no verdict. `places.country` walked through that gap. A wrong
 * column name is a fact about the REPOSITORY, decidable with no network, so the
 * static half runs everywhere and cannot be starved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCanonicalSchema,
  parseCreateTableColumns,
  splitStatements,
  isModelled,
  type CanonicalSchema,
} from "../scripts/lib/canonicalSchema.js";
import { findUndeclaredReferences } from "../scripts/checkSchemaReferences.js";
import { extractSchemaReferences } from "../scripts/lib/schemaReferenceExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");
const MIGRATIONS = [resolve(API_ROOT, "migrations"), resolve(API_ROOT, "src/migrations")];

let cached: CanonicalSchema | null = null;
const schema = () => (cached ??= buildCanonicalSchema(BASELINE, MIGRATIONS));

describe("canonical schema — the model the static check judges against", () => {
  it("models a plausible number of tables", () => {
    // A parse that silently collapsed would make every reference "unmodelled"
    // and the check vacuous.
    assert.ok(schema().columns.size > 300,
      `only ${schema().columns.size} tables modelled — the parse broke`);
  });

  it("knows the columns that actually exist", () => {
    for (const [t, c] of [
      ["places", "country_code"],
      ["profiles", "current_city"],
      ["hidden_gems", "save_count"],
      ["trips", "status"],
      // Added by a MULTI-column ALTER TABLE — the shape a windowed regex missed,
      // reporting five real columns as undeclared until parsing became
      // statement-scoped.
      ["user_deletion_requests", "worker_version"],
      ["user_deletion_requests", "tombstoned_counts"],
    ] as const) {
      assert.ok(isModelled(schema(), t), `${t} is not modelled`);
      assert.ok(schema().columns.get(t)!.has(c), `${t}.${c} should be declared by the repo`);
    }
  });

  it("does NOT know the columns that never existed", () => {
    for (const [t, c] of [
      ["places", "country"],                    // the founding defect
      ["profiles", "current_country"],          // lives on compass_user_profiles
      ["hidden_gems", "confirmation_count"],    // exists on no table at all
      ["hidden_gems", "days_since_last_confirmation"],
    ] as const) {
      assert.ok(isModelled(schema(), t), `${t} must be modelled for this to mean anything`);
      assert.ok(!schema().columns.get(t)!.has(c),
        `${t}.${c} is declared by the model but exists nowhere — the model is too permissive`);
    }
  });

  it("parses multi-column ALTER TABLE statements completely", () => {
    const stmts = splitStatements(`
      ALTER TABLE public.t
        ADD COLUMN IF NOT EXISTS a text,
        ADD COLUMN IF NOT EXISTS b jsonb NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN IF NOT EXISTS c text;
    `);
    const alter = stmts.find((x) => /ALTER TABLE/.test(x))!;
    const found = [...alter.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)]
      .map((m) => m[1]);
    assert.deepEqual(found, ["a", "b", "c"],
      "a multi-column ALTER must yield every column, not just the first");
  });

  it("keeps $$ bodies intact when splitting statements", () => {
    const stmts = splitStatements(`SELECT 1; DO $$ BEGIN a; b; END $$; SELECT 2;`);
    assert.equal(stmts.length, 3, `expected 3 statements, got ${stmts.length}`);
    assert.match(stmts[1]!, /BEGIN a; b; END/, "the $$ body was split apart");
  });

  it("reads columns out of a CREATE TABLE body without mistaking constraints for columns", () => {
    const cols = parseCreateTableColumns(
      `id uuid NOT NULL, name text, CONSTRAINT pk PRIMARY KEY (id), PRIMARY KEY (id)`,
    );
    assert.deepEqual([...cols!].sort(), ["id", "name"]);
  });
});

describe("static schema-reference check — catches the recurrence", () => {
  const fixture: CanonicalSchema = {
    columns: new Map([["places", new Set(["id", "name", "city", "country_code", "neighborhood"])]]),
    unmodelled: new Set(),
    sources: { baseline: "fixture", migrationFiles: 0 },
  };

  it("rejects the exact places.country defect", () => {
    const found = findUndeclaredReferences(fixture, [{
      file: "src/services/media/MediaProjectionService.ts",
      line: 367, table: "places", method: "select",
      columns: ["id", "name", "city", "country", "neighborhood"],
    }], new Set());
    assert.equal(found.length, 1);
    assert.equal(found[0]!.table, "places");
    assert.equal(found[0]!.column, "country");
    assert.match(found[0]!.where[0]!, /MediaProjectionService\.ts:367/);
  });

  it("accepts the corrected reference", () => {
    const found = findUndeclaredReferences(fixture, [{
      file: "x.ts", line: 1, table: "places", method: "select",
      columns: ["id", "name", "city", "country_code", "neighborhood"],
    }], new Set());
    assert.deepEqual(found, []);
  });

  it("declines to judge a table the model could not build", () => {
    // Over-flagging blocks unrelated work; silence about an unmodelled table is
    // the safe direction, and the live check still owns it.
    const s: CanonicalSchema = {
      columns: new Map([["weird", new Set(["id"])]]),
      unmodelled: new Set(["weird"]),
      sources: { baseline: "fixture", migrationFiles: 0 },
    };
    assert.deepEqual(
      findUndeclaredReferences(s, [{
        file: "x.ts", line: 1, table: "weird", method: "select", columns: ["anything"],
      }], new Set()),
      [],
    );
  });

  it("honours the undeclared-live allowlist but only for listed columns", () => {
    const sites = [{
      file: "x.ts", line: 1, table: "places", method: "select",
      columns: ["country", "neighborhood"],
    }];
    assert.deepEqual(findUndeclaredReferences(fixture, sites, new Set(["places.country"])), []);
    assert.equal(findUndeclaredReferences(fixture, sites, new Set(["places.other"])).length, 1);
  });

  it("finds nothing new in routes+services, the dirs the live check also covers", () => {
    const { sites } = extractSchemaReferences(API_ROOT, [
      resolve(API_ROOT, "src/routes"), resolve(API_ROOT, "src/services"),
    ]);
    assert.ok(sites.length > 1000, `only ${sites.length} references extracted — the scan broke`);
    assert.deepEqual(
      findUndeclaredReferences(schema(), sites).map((f) => `${f.table}.${f.column}`),
      [],
    );
  });

  it("scans BEYOND routes+services, where the recurrence was actually hiding", () => {
    // check:write-path-columns only ever looked at routes+services. Sweeping the
    // rest found `places.country` a THIRD time, in src/lib — plus ten more dead
    // references, all verified missing in production. A check that cannot see
    // src/lib could not have caught any of them.
    const { sites } = extractSchemaReferences(API_ROOT, [
      resolve(API_ROOT, "src/lib"),
      resolve(API_ROOT, "src/compass"),
      resolve(API_ROOT, "src/scripts"),
    ]);
    assert.ok(sites.length > 500, `only ${sites.length} references outside routes+services`);
    const found = findUndeclaredReferences(schema(), sites).map((f) => `${f.table}.${f.column}`);
    // The probe moves as the ratchet shrinks, exactly as this test's own
    // instruction says. places.country was fixed in 9e82e8450;
    // close_friends.friend_id (src/lib/mediaAccess.ts) was fixed by the
    // dead-literals batch, which struck the whole mediaAccess entry off the
    // ratchet — those two reads were media AUTHORIZATION decisions failing
    // 42703 into a `false` verdict. posts.view_count in
    // src/lib/places/placeCollectionsWorker.ts is the next src/lib entry;
    // when it is fixed too, move this probe to whichever one remains.
    assert.ok(
      found.includes("posts.view_count"),
      "the src/lib dead reference posts.view_count is no longer detected — " +
        `either it was fixed (update this test) or coverage regressed. Found: ${found.join(", ")}`,
    );
    // And the founding defect must not come back a FOURTH time.
    assert.ok(
      !found.includes("places.country"),
      "places.country is back — the table has country_code and has never had country",
    );
  });

});

describe("static schema-reference check — cannot be starved", () => {
  it("the extractor reaches no network and reads no credentials", () => {
    // The whole reason this is a separate module: it used to be welded to
    // checkWritePathColumns' live-credential guard, so nothing without a
    // database could reuse it.
    const src = readFileSync(
      resolve(API_ROOT, "src/scripts/lib/schemaReferenceExtract.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "ciProdReadOnlyAuditGuard", "process.env", "fetch(", "api.supabase.com",
    ]) {
      assert.ok(!code.includes(forbidden),
        `schemaReferenceExtract.ts references ${forbidden} — that re-creates the ` +
          "coupling this module exists to remove, and the static check would " +
          "become starvable again");
    }
  });

  it("the canonical model reaches no network either", () => {
    const src = readFileSync(
      resolve(API_ROOT, "src/scripts/lib/canonicalSchema.ts"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of ["fetch(", "process.env", "api.supabase.com"]) {
      assert.ok(!code.includes(forbidden),
        `canonicalSchema.ts references ${forbidden}`);
    }
  });

  it("the static check runs in ci.yml, not only in the live-DB lane", () => {
    const ci = readFileSync(resolve(API_ROOT, "../../.github/workflows/ci.yml"), "utf8");
    assert.match(ci, /check:schema-references/,
      "check:schema-references is not wired into ci.yml — if it only runs on the " +
        "live-DB lane it inherits exactly the starvation it was built to escape");
  });

  it("the live check still exists and still owns the live question", () => {
    const pkg = JSON.parse(readFileSync(resolve(API_ROOT, "package.json"), "utf8"));
    assert.ok(pkg.scripts["check:write-path-columns"],
      "the live check was removed — static and live answer different questions " +
        "(code-vs-declared vs declared-vs-database) and neither implies the other");
    assert.ok(pkg.scripts["check:schema-references"], "the static check is not registered");
  });
});
