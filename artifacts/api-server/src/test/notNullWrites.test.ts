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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  notNullColumns,
  parseNullabilityOverrides,
  effectiveNotNullColumns,
} from "../scripts/parseBaselineSchema.js";
import { findNullWrites, nulledColumn } from "../scripts/checkNotNullWrites.js";

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
      mig("2312_x.sql", "ALTER TABLE public.alpha ALTER COLUMN a DROP NOT NULL;"),
    ]);
    const base = "CREATE TABLE public.alpha (\n    a text NOT NULL,\n    b text NOT NULL\n);";
    assert.deepEqual([...effectiveNotNullColumns(base, "alpha", o)], ["b"]);
  });

  it("a later SET NOT NULL re-tightens, and ORDER decides", () => {
    // The direction matters. Parsing only DROP would leave a re-tightened
    // column permanently exempt — a real weakening of every caller.
    const o = parseNullabilityOverrides([
      mig("2400_retighten.sql", "ALTER TABLE public.alpha ALTER COLUMN a SET NOT NULL;"),
      mig("2312_loosen.sql", "ALTER TABLE public.alpha ALTER COLUMN a DROP NOT NULL;"),
    ]);
    const base = "CREATE TABLE public.alpha (\n    a text NOT NULL\n);";
    assert.deepEqual([...effectiveNotNullColumns(base, "alpha", o)], ["a"],
      "2400 applies after 2312, so the column is NOT NULL again");
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
      mig("2312_x.sql", "-- ALTER TABLE public.alpha ALTER COLUMN a DROP NOT NULL;\nSELECT 1;"),
    ]);
    assert.equal(o.dropped.size, 0);
  });

  it("reads the REAL 2312, so this guard is not merely theoretical", () => {
    const sql = readFileSync(resolve(SRC_ROOT, "migrations/2312_layover_travel_time_unknown.sql"), "utf8");
    const o = parseNullabilityOverrides([mig("2312_layover_travel_time_unknown.sql", sql)]);
    assert.ok(o.dropped.get("layover_recommendations")?.has("travel_time_min"));
    assert.ok(o.dropped.get("layover_plan_stops")?.has("travel_min"));
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
    // 2312 drops NOT NULL from layover travel-time columns precisely so an
    // unmeasured journey can be stored as unknown, and this guard called that
    // honest write a violation. Schema truth here is the same as everywhere
    // else in this repo — the baseline PLUS later migrations.
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
    assert.doesNotMatch(read("routes/groupChat.ts"), /body:\s*null/,
      "messages.body is NOT NULL — nulling it made message deletion return db_error");
  });
});
