/**
 * No write payload may put null in a NOT NULL column.
 *
 * These assert against the committed BASELINE SCHEMA rather than a mock. That
 * distinction is the whole point: the deletion tests mock the Supabase client,
 * and a mocked .update() accepts a payload the real column constraint rejects
 * with 23502. A suite cannot catch a schema violation it never sends to a
 * schema — which is how four of these shipped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync, readdirSync, statSync,
  mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  notNullColumns,
  parseNullabilityOverrides,
  effectiveNotNullColumns,
} from "../scripts/parseBaselineSchema.js";
import { findNullWrites, nulledColumn, evaluate, type NullWrite } from "../scripts/checkNotNullWrites.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dir, "..");
const BASELINE_SQL = readFileSync(BASELINE_PATH, "utf8");

describe("baseline nullability parser", () => {
  it("reads NOT NULL columns for a table", () => {
    const nn = notNullColumns(BASELINE_SQL, "profiles");
    assert.ok(nn.has("handle"), "profiles.handle is NOT NULL in the baseline");
    assert.ok(nn.has("name"), "profiles.name is NOT NULL in the baseline");
    assert.ok(!nn.has("username"), "profiles.username is nullable — must not be reported");
  });

  it("does not bleed into the next CREATE TABLE", () => {
    const sql = [
      "CREATE TABLE public.alpha (", "    a text NOT NULL,", "    b text", ");",
      "CREATE TABLE public.beta (", "    c text NOT NULL", ");",
    ].join("\n");
    assert.deepEqual([...notNullColumns(sql, "alpha")], ["a"]);
    assert.deepEqual([...notNullColumns(sql, "beta")], ["c"]);
  });

  it("returns empty for a table absent from the dump", () => {
    assert.equal(notNullColumns(BASELINE_SQL, "no_such_table_anywhere").size, 0);
  });
});

describe("payload parsing — the false-positive class", () => {
  it("attributes a `?? null` to the RIGHT key when several share a line", () => {
    // Regression: a per-line regex matched the whole line and reported the
    // FIRST key, so a null belonging to `description` was blamed on `owner_id`.
    // That produced 16 confident, entirely fictional findings, every one of them
    // claiming a foreign key was being nulled.
    const src = `await sc.from("shared_moments").insert({
      owner_id: ctx.userId, title: p.title, description: p.description ?? null,
    });`;
    const [w] = findNullWrites(src, "fixture.ts");
    assert.deepEqual(w.nulled, ["description"], "the null belongs to description, not owner_id");
  });

  it("catches both shapes: a literal null and a `?? null` fallback", () => {
    assert.equal(nulledColumn("handle: null"), "handle");
    assert.equal(nulledColumn("recommendation_id: event.recommendationId ?? null"), "recommendation_id");
  });

  it("does not flag a non-null value, or a `??` fallback to something else", () => {
    assert.equal(nulledColumn("handle: `deleted_${userId}`"), null);
    assert.equal(nulledColumn("body: ''"), null);
    assert.equal(nulledColumn("category: p.category ?? 'unknown'"), null);
    assert.equal(nulledColumn("trip_id: tripId"), null);
  });

  it("ignores nulls nested inside a sub-object, which are not this payload's columns", () => {
    const src = `await sc.from("posts").insert({ author_id: uid, meta: { inner: null } });`;
    assert.deepEqual(findNullWrites(src, "fixture.ts")[0]?.nulled ?? [], []);
  });

  it("never attributes a payload to the wrong table", () => {
    const src = `
      await sc.from("alpha").insert({ a: 1 });
      await sc.from("beta").insert({ b: null });`;
    const w = findNullWrites(src, "fixture.ts");
    assert.equal(w.length, 1);
    assert.equal(w[0].table, "beta");
  });
});

describe("post-baseline nullability overrides", () => {
  const mig = (name: string, sql: string) => ({ name, sql });

  it("a later DROP NOT NULL removes the baseline's constraint", () => {
    const o = parseNullabilityOverrides([
      mig("2000_loosen_alpha_a.sql", "ALTER TABLE public.alpha ALTER COLUMN a DROP NOT NULL;"),
    ]);
    const base = "CREATE TABLE public.alpha (\n    a text NOT NULL,\n    b text NOT NULL\n);";
    assert.deepEqual([...effectiveNotNullColumns(base, "alpha", o)], ["b"]);
  });

  it("a later SET NOT NULL re-tightens, and ORDER decides", () => {
    // The direction matters. Parsing only DROP would leave a re-tightened
    // column permanently exempt — a real weakening of every caller.
    const o = parseNullabilityOverrides([
      mig("2400_retighten.sql", "ALTER TABLE public.alpha ALTER COLUMN a SET NOT NULL;"),
      mig("2000_loosen.sql", "ALTER TABLE public.alpha ALTER COLUMN a DROP NOT NULL;"),
    ]);
    const base = "CREATE TABLE public.alpha (\n    a text NOT NULL\n);";
    assert.deepEqual([...effectiveNotNullColumns(base, "alpha", o)], ["a"],
      "2400 sorts after 2000, so it applies later and the column is NOT NULL again");
  });

  it("a column made NOT NULL after the baseline is added, not ignored", () => {
    const o = parseNullabilityOverrides([
      mig("2320_x.sql", "ALTER TABLE public.alpha ALTER COLUMN b SET NOT NULL;"),
    ]);
    const base = "CREATE TABLE public.alpha (\n    a text NOT NULL,\n    b text\n);";
    assert.deepEqual([...effectiveNotNullColumns(base, "alpha", o)].sort(), ["a", "b"]);
  });

  it("a COMMENTED-OUT alter changes nothing", () => {
    // This band comments heavily, and migrations routinely DESCRIBE constraints
    // they are not touching. A described change must not register as one.
    const o = parseNullabilityOverrides([
      mig("2000_x.sql", "-- ALTER TABLE public.alpha ALTER COLUMN a DROP NOT NULL;\nSELECT 1;"),
    ]);
    assert.equal(o.dropped.size, 0);
  });

  // Three REAL migrations on this tree, so none of the above is merely
  // theoretical. Each one drops a NOT NULL that the committed baseline still
  // carries, which is the exact disagreement this parser exists to resolve —
  // and each is a DROP, which is why the honest summary of this change is
  // "stops flagging", not "flags more".
  const REAL_DROPS: Array<[string, string, string]> = [
    ["3359_passport_postcard_cover_nullable.sql", "passport_postcards", "media_url"],
    ["3421_ranking_debug_samples_content_id_nullable.sql", "ranking_debug_samples", "content_id"],
    ["2975_highlights_permanent_lifetime.sql", "highlights", "expires_at"],
  ];

  for (const [file, table, column] of REAL_DROPS) {
    it(`reads the REAL ${file.slice(0, 4)} and sees ${table}.${column} lose NOT NULL`, () => {
      const sql = readFileSync(resolve(SRC_ROOT, "migrations", file), "utf8");
      const o = parseNullabilityOverrides([mig(file, sql)]);
      assert.ok(o.dropped.get(table)?.has(column),
        `${file} drops NOT NULL from ${table}.${column}; the parser did not see it`);
      // And the baseline still disagrees — which is why reading the baseline
      // alone would report a write this migration legalised as a defect.
      assert.ok(notNullColumns(BASELINE_SQL, table).has(column),
        `${table}.${column} is still NOT NULL in the committed baseline; if this ` +
        "fails the baseline was recaptured and this test is no longer evidence of anything");
      assert.equal(effectiveNotNullColumns(BASELINE_SQL, table, o).has(column), false);
    });
  }

  // ═════════════════════════
  // THE MULTI-CLAUSE STATEMENT — pinned because it was WRONG and is now right.
  //
  // 2999 is ONE `ALTER TABLE public.trust_profiles` carrying twenty
  // comma-separated `ALTER COLUMN` clauses: ten DROP NOT NULL interleaved with
  // ten DROP DEFAULT. A single contiguous `ALTER TABLE ... ALTER COLUMN ...`
  // regex matches only the FIRST clause, because the scan then resumes
  // mid-statement where no `ALTER TABLE` follows. MEASURED 2026-10-02: that
  // shape saw 1 of 10 columns and left the other NINE stale-NOT-NULL — the
  // same false accusation this module exists to stop, only quieter and harder
  // to notice. The parser now scopes to the statement and scans its clauses.
  it("reads the REAL 2999 and sees ALL TEN of its comma-separated DROP NOT NULLs", () => {
    const file = "2999_trust_profiles_nullable_scores.sql";
    const sql = readFileSync(resolve(SRC_ROOT, "migrations", file), "utf8");
    const o = parseNullabilityOverrides([mig(file, sql)]);
    assert.deepEqual([...(o.dropped.get("trust_profiles") ?? [])].sort(), [
      "communication", "community_value", "content_quality", "guide_accuracy",
      "host_quality", "location_honesty", "overall_score", "passport_authenticity",
      "plan_attendance", "respect_safety",
    ], "a contiguous regex sees only `overall_score`; the other nine must not be " +
       "left reading as NOT NULL after 2999 dropped them");
  });

  it("a multi-clause statement is parsed whole, not just its first clause", () => {
    // The unit statement of the same fact, independent of 2999's wording.
    const o = parseNullabilityOverrides([mig("2000_multi.sql", [
      "ALTER TABLE public.alpha",
      "  ALTER COLUMN a DROP NOT NULL,",
      "  ALTER COLUMN b DROP NOT NULL,",
      "  ALTER COLUMN c SET NOT NULL;",
    ].join("\n"))]);
    assert.deepEqual([...(o.dropped.get("alpha") ?? [])].sort(), ["a", "b"]);
    assert.deepEqual([...(o.added.get("alpha") ?? [])].sort(), ["c"]);
  });

  it("DROP DEFAULT is INVISIBLE here — this parser reads nullability only", () => {
    // Pinned as a LIMIT, not a bug. 2999 drops ten defaults alongside its ten
    // NOT NULLs and this function reports none of them, by design: a caller
    // that needs to know whether a column still has a default must not ask
    // this one. Recorded so it is read here rather than discovered downstream.
    const o = parseNullabilityOverrides([mig("2000_default.sql",
      "ALTER TABLE public.alpha ALTER COLUMN a DROP DEFAULT;")]);
    assert.equal(o.dropped.size, 0, "a default is not a nullability constraint");
    assert.equal(o.added.size, 0);
  });

  it("dynamic DDL whose table is a runtime placeholder matches NOTHING", () => {
    // 3002 really contains `EXECUTE format('ALTER TABLE public.%I ALTER COLUMN
    // actor_id DROP NOT NULL', t)` inside a DO loop. The table is `%I` — no
    // static parser can know it. The one answer that is never acceptable is
    // attributing the column to a table named `public`, which is what a looser
    // statement regex does by backtracking. Matching nothing is correct.
    const o = parseNullabilityOverrides([mig("3002_dynamic.sql",
      "EXECUTE format('ALTER TABLE public.%I ALTER COLUMN actor_id DROP NOT NULL', t);")]);
    assert.equal(o.dropped.get("public"), undefined,
      "`public` is a schema, not a table; capturing it invents a constraint");
    assert.equal(o.dropped.size, 0);
  });
});

describe("the whole tree — no write nulls a NOT NULL column", () => {
  const SKIP_DIRS = new Set(["test", "node_modules"]);
  const SKIP_FILES = new Set(["database.types.ts"]);

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { if (!SKIP_DIRS.has(entry)) walk(full, acc); }
      else if (entry.endsWith(".ts") && !SKIP_FILES.has(entry)) acc.push(full);
    }
    return acc;
  }

  const writes = walk(SRC_ROOT).flatMap((f) =>
    findNullWrites(readFileSync(f, "utf8"), relative(SRC_ROOT, f)));

  const MIGRATIONS_DIR = resolve(SRC_ROOT, "migrations");
  const OVERRIDES = parseNullabilityOverrides(
    readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .map((n) => ({ name: n, sql: readFileSync(join(MIGRATIONS_DIR, n), "utf8") })),
  );

  it("finds payloads at all — a vacuous check is worse than none", () => {
    assert.ok(writes.length > 50, `only ${writes.length} payloads found; the extractor is stale`);
  });

  it("no nulled column is NOT NULL in the EFFECTIVE schema (baseline + migrations)", () => {
    // The baseline is a SNAPSHOT, not the current schema. Checking a write
    // against it alone reports a forward migration's own intent as a defect:
    // 3359, 3421, 2975 and 2999 each drop a NOT NULL this baseline still
    // carries, precisely so an absent cover / an unattributable sample / a
    // PERMANENT Highlight / an uncomputed score can be stored as unknown
    // instead of fabricated. Schema truth here is the same as everywhere else
    // in this repo — the baseline PLUS later migrations.
    const bad: string[] = [];
    for (const w of writes) {
      const nn = effectiveNotNullColumns(BASELINE_SQL, w.table, OVERRIDES);
      for (const col of w.nulled) if (nn.has(col)) bad.push(`${w.file}:${w.line} ${w.table}.${col}`);
    }
    assert.deepEqual(bad, [], `write payload(s) null a NOT NULL column:\n  ${bad.join("\n  ")}`);
  });

  it("the four fixed sites stay fixed", () => {
    // Strip comments first: these fixes are DOCUMENTED at the call site, and the
    // documentation necessarily quotes the defect ("`body: null` raised 23502"),
    // which a naive match reads as the defect itself.
    const read = (p: string) =>
      readFileSync(resolve(SRC_ROOT, p), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(read("services/accountDeletion/AccountDeletionService.ts"), /handle:\s*null/,
      "profiles.handle is NOT NULL — nulling it aborts deletion after content is destroyed");
    assert.doesNotMatch(read("routes/preferences.ts"), /recommendation_id:\s*null/,
      "user_preference_events.recommendation_id is NOT NULL — mute-category silently wrote nothing");
    assert.doesNotMatch(read("lib/preferenceEvent.ts"), /recommendation_id:.*\?\?\s*null/,
      "the shared helper's `?? null` dropped every event from a caller that omitted the id");
    // `body:` has to be the PROPERTY, not the tail of a longer one.
    //
    // MEASURED 2026-09-13: the bare `/body:\s*null/` fired on
    // `translated_body: null` — a key in the synthesised message_translations
    // row that census-telegraph §17.4 added to this file, so that an unreadable
    // `message_translations` reports §18's `failed` instead of inventing a
    // monolingual thread. That row is not a write at all; it never leaves
    // memory. A guard that fails on a DIFFERENT column, in a payload that is
    // not a payload, is not a stricter guard — it is a wrong one, and the
    // cheapest way for a lane to "fix" it would have been to rename a column
    // reference to dodge the regex.
    //
    // The two assertions above it are the controls, and they are what keeps the
    // narrowing honest: the pattern must still catch the exact defect this
    // check exists for (`.update({ deleted_at: now, body: null })`, which
    // raised 23502 and made deleting your own group-chat message return
    // db_error) while ignoring a column whose name merely ends in `body`.
    const NULLED_BODY = /(?<![\w$])body:\s*null/;
    assert.match("    .update({ deleted_at: now, body: null })", NULLED_BODY,
      "the narrowed pattern must still catch the defect it was written for");
    assert.doesNotMatch("        translated_body: null,", NULLED_BODY,
      "and must not fire on a different column that happens to end in `body`");
    assert.doesNotMatch(read("routes/groupChat.ts"), NULLED_BODY,
      "messages.body is NOT NULL — nulling it made message deletion return db_error");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// THE WIRING — the part that was actually broken
// ══════════════════════════════════════════════════════════════════════════════
//
// `effectiveNotNullColumns` was added to parseBaselineSchema and tested above,
// and it was correct the whole time. The guard that CI runs went on calling
// `notNullColumns`, so a column a forward migration had already freed kept
// reading as NOT NULL — a false accusation against code that was right, from
// a guard whose own unit tests were green.
//
// A test of the parser cannot catch that, because the parser was never the
// broken part. These drive the guard's decision function instead, which is
// where the baseline and the migrations are combined. The LAST describe in this
// file goes one step further and drives the real ENTRY POINT, because an
// exported `evaluate()` that main() does not call is the same defect again.
describe("evaluate() — the guard honours migrations, not just the baseline", () => {
  const BASE = [
    "CREATE TABLE public.widgets (",
    "    id uuid NOT NULL,",
    "    travel_min integer NOT NULL,",
    "    label text",
    ");",
  ].join("\n");

  const write = (cols: string[]): NullWrite =>
    ({ file: "routes/w.ts", line: 7, table: "widgets", op: "insert", nulled: cols });

  it("reports a null written to a column the baseline declares NOT NULL", () => {
    const { problems } = evaluate([write(["travel_min"])], BASE, parseNullabilityOverrides([]));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /widgets sets travel_min to null/);
  });

  it("stops reporting once a migration DROPS the constraint", () => {
    // This is the regression. Same code, same baseline — but the schema moved,
    // and a guard that cannot see the move blames the code for agreeing with it.
    const overrides = parseNullabilityOverrides([{
      name: "2000_widgets_travel_time_unknown.sql",
      sql: "ALTER TABLE public.widgets ALTER COLUMN travel_min DROP NOT NULL;",
    }]);
    const { problems } = evaluate([write(["travel_min"])], BASE, overrides);
    assert.deepEqual(problems, [],
      "the migration dropped this constraint; reporting it is a false accusation");
  });

  it("still reports OTHER columns the same migration did not touch", () => {
    // The failure mode on the other side: a DROP NOT NULL must not be read as
    // "this table is now unchecked".
    const overrides = parseNullabilityOverrides([{
      name: "2000_widgets_travel_time_unknown.sql",
      sql: "ALTER TABLE public.widgets ALTER COLUMN travel_min DROP NOT NULL;",
    }]);
    const { problems } = evaluate([write(["id"])], BASE, overrides);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /widgets sets id to null/);
  });

  it("a later SET NOT NULL puts the constraint back", () => {
    const overrides = parseNullabilityOverrides([
      { name: "2000_a.sql", sql: "ALTER TABLE public.widgets ALTER COLUMN travel_min DROP NOT NULL;" },
      { name: "2400_b.sql", sql: "ALTER TABLE public.widgets ALTER COLUMN travel_min SET NOT NULL;" },
    ]);
    const { problems } = evaluate([write(["travel_min"])], BASE, overrides);
    assert.equal(problems.length, 1, "the last migration wins, and it restored the constraint");
  });

  it("a table absent from the baseline is UNVERIFIABLE, never a pass", () => {
    // The distinction the whole platform turns on: not-checked is not clean.
    const { problems, unverifiable } = evaluate(
      [{ file: "routes/w.ts", line: 3, table: "not_in_baseline", op: "insert", nulled: ["x"] }],
      BASE, parseNullabilityOverrides([]));
    assert.deepEqual(problems, []);
    assert.ok(unverifiable.has("not_in_baseline"),
      "an unverifiable table must be reported as unverifiable, not silently counted as clean");
  });

  // The end-to-end statement, against the REAL migrations on this tree. Every
  // column below is NOT NULL in the committed baseline and nullable after its
  // migration, so each assertion fails the moment the guard goes back to
  // reading the snapshot.
  //
  // This is the latent value of the change, stated plainly: MEASURED
  // 2026-10-02, no write payload in src/ nulls any of these columns, so the
  // guard flags nothing new today. The write paths are already there —
  // src/services/ranking/DiscoveryRankingService.ts for ranking_debug_samples
  // and src/services/trust/TrustScoreService.ts for the 2999 columns — so the
  // first `?? null` on one of them would turn a BLOCKING gate red against code
  // the migration authors deliberately legalised.
  const REAL_CLEARED: Array<[string, string]> = [
    ["passport_postcards", "media_url"],
    ["ranking_debug_samples", "content_id"],
    ["highlights", "expires_at"],
    ["trust_profiles", "overall_score"],
    ["trust_profiles", "guide_accuracy"],
  ];

  for (const [table, column] of REAL_CLEARED) {
    it(`the REAL guard, against the REAL schema, clears ${table}.${column}`, () => {
      const MIG_DIR = resolve(SRC_ROOT, "migrations");
      const real = parseNullabilityOverrides(
        readdirSync(MIG_DIR)
          .filter((n) => n.endsWith(".sql"))
          .map((n) => ({ name: n, sql: readFileSync(join(MIG_DIR, n), "utf8") })),
      );
      assert.ok(notNullColumns(BASELINE_SQL, table).has(column),
        `${table}.${column} must still be NOT NULL in the baseline for this to mean anything`);
      const { problems } = evaluate(
        [{ file: "routes/x.ts", line: 1, table, op: "insert", nulled: [column] }],
        BASELINE_SQL, real);
      assert.deepEqual(problems, [],
        `a forward migration dropped ${table}.${column}'s NOT NULL; if this fails, ` +
        "the guard is once again reading a stale snapshot");
    });
  }
});
// ════════════════════════════════════════════════════════════════════════════
// THE ENTRY POINT — three things no test above can see
// ════════════════════════════════════════════════════════════════════════════
//
// Everything above imports `evaluate` and calls it. That leaves three holes,
// and each one lets the exact defect this change fixes come straight back:
//
//   1. THE `< 100` REFUSAL has no test, and it is the headline fail-closed
//      behaviour. An unreadable migrations directory is not a directory with
//      no migrations in it, and silently reverting to baseline-only is the
//      original defect wearing a hat.
//
//   2. NOTHING ASSERTS THAT main() CALLS evaluate(—, overrides). That is the
//      very defect being fixed: the parser was correct and unit-tested green
//      for weeks while main() went on calling `notNullColumns`. Reverting
//      main() to `notNullColumns` while leaving `evaluate()` perfect kills no
//      test above. It must kill one here.
//
//   3. NOTHING ASSERTS THE `unverifiable` COUNT REACHES STDOUT, which is where
//      guardRegistry's `countPattern` reads from. A count computed and not
//      printed is a count nobody can act on, and "not checked" must never be
//      indistinguishable from "clean".
//
// HOW, AND WHY THIS WAY. `MIGRATIONS_DIR`, `SRC_ROOT` and `BASELINE_PATH` are
// all module-level `resolve()`s off `import.meta.url`, with no injection seam.
// Two ways out: add a directory parameter to `loadMigrations`, or drive the
// script as a subprocess over a fixture tree. The subprocess is chosen, for
// one reason: hole 2 is specifically "main() does not use what it computed",
// and a seam added for the test is a seam main() can be refactored to bypass
// while every test stays green. A fixture tree needs no seam at all — it
// COPIES the real script files and lets their own `import.meta.url` resolve
// into the fixture, so what runs is the shipped entry point, byte for byte,
// read fresh from disk on every run.
describe("the guard SCRIPT — main() honours migrations, and refuses when it cannot read them", () => {
  const REAL_SCRIPTS = resolve(__dir, "../scripts");

  const FIXTURE_BASELINE = [
    "CREATE TABLE public.widgets (",
    "    id uuid NOT NULL,",
    "    travel_min integer NOT NULL,",
    "    label text",
    ");",
  ].join("\n");

  /**
   * A miniature api-server: `src/scripts` holding COPIES of the two real
   * script files, `src/migrations`, `src/routes` and a `baseline/` whose
   * filename is the one BASELINE_PATH resolves to. Both copied modules
   * resolve every path off their own location, so each lands inside here.
   */
  function fixture(opts: {
    migrations: Array<{ name: string; sql: string }>;
    source: string;
  }): string {
    const root = mkdtempSync(join(tmpdir(), "notnull-guard-"));
    for (const d of ["src/scripts", "src/migrations", "src/routes", "baseline"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    for (const f of ["checkNotNullWrites.ts", "parseBaselineSchema.ts"]) {
      copyFileSync(join(REAL_SCRIPTS, f), join(root, "src/scripts", f));
    }
    // The copied guard imports "./parseBaselineSchema.js", which only resolves to
    // the .ts beside it when node treats the tree as ESM. Node decides that by
    // walking UP for a package.json, and this tree is under $TMPDIR — so what it
    // finds depends on where $TMPDIR happens to be. On CI that resolves; on macOS
    // ($TMPDIR = /var/folders/...) nothing above it declares a type, node falls
    // back to CJS, and the require fails with MODULE_NOT_FOUND — six cases red for
    // a reason that has nothing to do with the guard. Declare it here so the tree
    // carries its own answer and the test means the same thing everywhere.
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "baseline/20260819_baseline_structure.sql"), FIXTURE_BASELINE);
    writeFileSync(join(root, "src/routes/w.ts"), opts.source);
    for (const m of opts.migrations) {
      writeFileSync(join(root, "src/migrations", m.name), m.sql);
    }
    return root;
  }

  /** Enough padding migrations to clear the `< 100` refusal honestly. */
  function padding(n: number): Array<{ name: string; sql: string }> {
    return Array.from({ length: n }, (_, i) => ({
      name: `${String(i + 1).padStart(4, "0")}_pad.sql`,
      sql: "SELECT 1;\n",
    }));
  }

  function runGuard(root: string) {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", join(root, "src/scripts/checkNotNullWrites.ts")],
      { encoding: "utf8", cwd: resolve(__dir, "../..") },
    );
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  function withFixture(opts: Parameters<typeof fixture>[0], fn: (r: ReturnType<typeof runGuard>) => void) {
    const root = fixture(opts);
    try { fn(runGuard(root)); } finally { rmSync(root, { recursive: true, force: true }); }
  }

  // ---- hole 1: the refusal -------------------------------------------------
  it("REFUSES, exit 1, when the migrations directory yields fewer than 100 files", () => {
    withFixture({
      migrations: [...padding(99)],
      source: "await sb.from('widgets').insert({ id: x, travel_min: null });\n",
    }, (r) => {
      assert.equal(r.status, 1,
        "99 migration files is an unreadable directory, not an empty one; the guard must refuse");
      assert.match(r.stderr, /found only 99 migration file\(s\)/);
      assert.match(r.stderr, /Refusing to evaluate NOT NULL against the baseline alone/);
      assert.doesNotMatch(r.stdout, /no write payload nulls a NOT NULL column/,
        "a refusal must not also print a pass");
    });
  });

  it("does NOT refuse at exactly 100 — the boundary is `< 100`, not `<= 100`", () => {
    // Pinning the comparison itself, so a `<=` slip is a failing test rather
    // than a guard that refuses to run on a legitimate tree.
    withFixture({
      migrations: [...padding(100)],
      source: "await sb.from('widgets').insert({ id: x, label: null });\n",
    }, (r) => {
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /this read is broken/);
    });
  });

  // ---- hole 2: main() must use the overrides it computed -------------------
  it("exits 0 for a write nulling a column a MIGRATION dropped NOT NULL from", () => {
    // The whole point. The baseline says travel_min is NOT NULL; a migration
    // dropped it. main() must consult both. If main() goes back to
    // `notNullColumns` this fails, and nothing above it would.
    withFixture({
      migrations: [
        ...padding(120),
        { name: "9000_widgets_travel_unknown.sql",
          sql: "ALTER TABLE public.widgets ALTER COLUMN travel_min DROP NOT NULL;\n" },
      ],
      source: "await sb.from('widgets').insert({ id: x, travel_min: null });\n",
    }, (r) => {
      assert.equal(r.status, 0,
        `the migration legalised this write; the guard reported it anyway:\n${r.stderr}`);
      assert.match(r.stdout, /no write payload nulls a NOT NULL column/);
    });
  });

  it("exits 1, in the NEW wording, for a write nulling a column a migration SET NOT NULL", () => {
    // The other direction, which is the half that "strengthens the check"
    // actually describes. `label` is nullable in the baseline and tightened
    // afterwards, so only a guard reading migrations can catch this at all.
    withFixture({
      migrations: [
        ...padding(120),
        { name: "9000_widgets_label_required.sql",
          sql: "ALTER TABLE public.widgets ALTER COLUMN label SET NOT NULL;\n" },
      ],
      source: "await sb.from('widgets').insert({ id: x, label: null });\n",
    }, (r) => {
      assert.equal(r.status, 1, "a post-baseline SET NOT NULL must be enforced");
      assert.match(r.stderr, /on widgets sets label to null/);
      assert.match(r.stderr, /the schema \(baseline \+ migrations\) declares it NOT NULL/,
        "the diagnostic must name what it actually consulted, not 'the baseline'");
    });
  });

  it("the same write passes when NO migration tightens the column", () => {
    // The control for the test above: it must fail for the SET NOT NULL, not
    // merely because nulling `label` upsets the guard on its own.
    withFixture({
      migrations: [...padding(120)],
      source: "await sb.from('widgets').insert({ id: x, label: null });\n",
    }, (r) => {
      assert.equal(r.status, 0, r.stderr);
    });
  });

  // ---- hole 3: the unverifiable count must reach stdout --------------------
  it("PRINTS the unverifiable count, and the summary line guardRegistry parses", () => {
    // `src/scripts/guardRegistry.ts` records this guard's unit as
    // `countPattern: "(\\d+) source file\\(s\\), \\d+ write payload"`, read from
    // this line. A count computed and not printed is a count nobody can act
    // on, and an unverifiable table must never read as a clean one.
    withFixture({
      migrations: [...padding(120)],
      source: [
        "await sb.from('ghosts').insert({ id: x, whatever: null });",
        "await sb.from('widgets').insert({ id: x, label: null });",
      ].join("\n") + "\n",
    }, (r) => {
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\d+ source file\(s\), \d+ write payload/,
        "guardRegistry's countPattern reads this exact summary line; its shape is load-bearing");
      assert.match(r.stdout, /1 table\(s\) absent from the baseline — not verifiable here: ghosts/,
        "an unverifiable table must be NAMED on stdout, not silently counted as clean");
    });
  });
});
