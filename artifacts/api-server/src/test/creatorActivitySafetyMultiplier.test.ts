/**
 * creatorActivitySafetyMultiplier.test.ts
 *
 * Two facts about CreatorActivityScoreService that nothing else pins.
 *
 * 1. THE SAFETY KILL-SWITCH THAT NEVER FIRED
 *    `_fetchSafetyMultiplier` opened with
 *        if (level === "suspended" || level === "restricted") return 0.0;
 *    — the documented "collapse the score on verified severe restriction"
 *    rule. `trust_profiles_public_level_check` admits exactly six ladder
 *    labels and neither of those is one of them, so on every row in every
 *    environment the branch was skipped. It compiled because the value was
 *    widened to `string` on the way out of the row, and it raised no 22P02
 *    because `public_level` carries a CHECK constraint rather than an ENUM:
 *    the label was never sent to Postgres at all, it was compared in JS
 *    against a value the column cannot hold.
 *
 *    The mutation proof is the negative control below: a fixture row carrying
 *    the impossible label `suspended`. Under the old code it returns 0.0 and
 *    the creator's whole score collapses; under the fix it returns 1.0. The
 *    fixture is deliberately impossible — it is an adversarial input asserting
 *    the reader does NOT key off the label, not a fiction being pinned as
 *    truth. The vocabulary test immediately above it proves the row cannot
 *    exist, so the two are read together.
 *
 *    Vocabulary comes from the committed baseline (plus later migrations —
 *    verified: none touches public_level), never from src/lib/database.types.ts.
 *
 * 2. `activity_events` HAS NO PRODUCER
 *    The service reads it in five lanes on 22 event_type literals. The table
 *    has exactly one writer in this repo — an internal-secret-gated route that
 *    nothing calls — so every one of those reads returns zero rows, silently
 *    and permanently. `event_type` is plain TEXT with no ENUM and no CHECK, so
 *    `check:enum-literals` cannot see the literals: that guard only judges
 *    columns that carry a vocabulary. This test is the pin instead. If it goes
 *    RED because a producer appeared, that is good news — revisit the score's
 *    activity lanes and the scheduler's cold start, then update this test.
 *
 * Pattern: node:test + tsx/esm, no vitest.
 * Run: node --import tsx/esm --test src/test/creatorActivitySafetyMultiplier.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreatorSignalAggregator,
  computeActivityScore,
  type CreatorSignals,
} from "../services/ranking/CreatorActivityScoreService.js";

const HERE     = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "../..");
const SRC_ROOT = resolve(API_ROOT, "src");
const BASELINE = resolve(API_ROOT, "baseline/20260819_baseline_structure.sql");

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";

// ─── Baseline vocabulary ──────────────────────────────────────────────────────

/**
 * The labels `public.trust_profiles.public_level` can actually hold, read off
 * the CHECK constraint in the committed baseline. Deliberately not read from
 * database.types.ts: that file is generated and has been wrong about live
 * columns before, and a fake Supabase client cannot see a dead literal at all.
 */
function publicLevelVocabulary(): string[] {
  const sql  = readFileSync(BASELINE, "utf8");
  const line = sql
    .split("\n")
    .find((l) => l.includes("CONSTRAINT trust_profiles_public_level_check"));
  assert.ok(line, "trust_profiles_public_level_check not found in the baseline");
  return [...line.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string);
}

describe("trust_profiles.public_level — the vocabulary the multiplier may key off", () => {
  it("models the six ladder labels (positive control — a collapsed parse would make every assertion below vacuous)", () => {
    const vocab = publicLevelVocabulary();
    assert.deepEqual(
      [...vocab].sort(),
      [
        "building_trust",
        "city_trusted",
        "highly_trusted",
        "new_traveler",
        "reliable_traveler",
        "trusted_traveler",
      ],
      `unexpected public_level vocabulary: ${JSON.stringify(vocab)}`,
    );
  });

  it("admits neither 'suspended' nor 'restricted' — the removed branch was unreachable by construction", () => {
    const vocab = publicLevelVocabulary();
    for (const impossible of ["suspended", "restricted"]) {
      assert.ok(
        !vocab.includes(impossible),
        `public_level now admits '${impossible}'. A migration changed the ladder — ` +
          `revisit whether the creator score should collapse on it, deliberately, ` +
          `rather than letting a branch reappear that no row can reach.`,
      );
    }
  });
});

// ─── Fake Supabase client ─────────────────────────────────────────────────────

interface FakeTables {
  trust_profiles?: Array<Record<string, unknown>>;
  posts?:          Array<Record<string, unknown>>;
  events?:         Array<Record<string, unknown>>;
  trips?:          Array<Record<string, unknown>>;
  reviews?:        Array<Record<string, unknown>>;
  discovery_places?: Array<Record<string, unknown>>;
}

/**
 * Minimal chainable double. Filters are applied literally; it cannot tell a
 * real label from a dead one — which is precisely why the vocabulary above is
 * asserted against the schema and not against this double.
 */
function makeDb(tables: FakeTables): unknown {
  const buildChain = (table: string) => {
    let one = false;
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
      neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return chain; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return chain; },
      gte: (col: string, val: string) => { filters.push((r) => String(r[col] ?? "") >= val); return chain; },
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => { one = true; return chain; },
      single: () => { one = true; return chain; },
      then: (resolveFn: (v: unknown) => unknown, rejectFn: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => {
            const all  = (tables as Record<string, Array<Record<string, unknown>>>)[table] ?? [];
            const rows = all.filter((r) => filters.every((f) => f(r)));
            return resolveFn({ data: one ? (rows[0] ?? null) : rows, error: null });
          })
          .catch(rejectFn),
    };
    return chain;
  };
  return { from: (t: string) => buildChain(t) };
}

async function multiplierFor(row: Record<string, unknown> | null): Promise<number> {
  const agg = new CreatorSignalAggregator(
    makeDb({ trust_profiles: row ? [row] : [] }) as never,
  );
  const signals: CreatorSignals = await agg.aggregate(CREATOR_ID);
  return signals.safetyMultiplier;
}

// ─── The kill-switch ──────────────────────────────────────────────────────────

describe("_fetchSafetyMultiplier — the label never collapses the score, the number does", () => {
  it("every ladder label leaves a healthy creator at full multiplier", async () => {
    for (const level of publicLevelVocabulary()) {
      const m = await multiplierFor({ user_id: CREATOR_ID, overall_score: 75, public_level: level });
      assert.strictEqual(m, 1.0, `public_level '${level}' should not reduce the multiplier; got ${m}`);
    }
  });

  it("NEGATIVE CONTROL: an impossible 'suspended' row does not collapse the multiplier", async () => {
    // This row cannot exist — the CHECK forbids it (asserted above). It is here
    // as the mutation proof: restore `if (level === "suspended") return 0.0` and
    // this returns 0.0 instead of 1.0.
    const m = await multiplierFor({ user_id: CREATOR_ID, overall_score: 80, public_level: "suspended" });
    assert.strictEqual(
      m, 1.0,
      "the multiplier keyed off a public_level label the column cannot hold — " +
        "a kill-switch that can never fire is worse than none, because it reads as protection",
    );
  });

  it("NEGATIVE CONTROL: the same for 'restricted', and the creator keeps a real score end to end", async () => {
    const agg = new CreatorSignalAggregator(
      makeDb({
        trust_profiles: [{ user_id: CREATOR_ID, overall_score: 80, public_level: "restricted" }],
        posts: [{ author_id: CREATOR_ID, status: "published", created_at: new Date().toISOString() }],
      }) as never,
    );
    const signals = await agg.aggregate(CREATOR_ID);
    assert.strictEqual(signals.safetyMultiplier, 1.0);

    const result = computeActivityScore(CREATOR_ID, signals);
    assert.ok(
      result.score > 0,
      `a contributing creator scored ${result.score}; the dead label collapsed the whole score`,
    );
  });

  it("the LIVE kill-switch still fires: the numeric rungs are untouched", async () => {
    const rung = async (score: number) =>
      multiplierFor({ user_id: CREATOR_ID, overall_score: score, public_level: "new_traveler" });

    assert.strictEqual(await rung(15), 0.0, "overall_score < 20 must collapse to 0");
    assert.strictEqual(await rung(25), 0.3);
    assert.strictEqual(await rung(35), 0.6);
    assert.strictEqual(await rung(45), 0.8);
    assert.strictEqual(await rung(55), 1.0);
  });

  it("a user with no trust profile keeps the full multiplier", async () => {
    assert.strictEqual(await multiplierFor(null), 1.0);
  });
});

// ─── activity_events producer pin ─────────────────────────────────────────────

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const WRITE_TO_ACTIVITY_EVENTS =
  /from\(\s*["']activity_events["']\s*\)[\s\S]{0,400}?\.(insert|upsert)\(/;

/** Drop block and line comments so a prose mention never reads as a call site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("activity_events — the table the creator-activity lane reads", () => {
  it("still has exactly one writer, and it is the internal route", () => {
    const writers = walkTsFiles(SRC_ROOT)
      .filter((f) => !f.includes(`${"/"}test${"/"}`) && !f.endsWith("database.types.ts"))
      .filter((f) => WRITE_TO_ACTIVITY_EVENTS.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(API_ROOT, f))
      .sort();

    assert.deepEqual(
      writers,
      ["src/routes/notifications.ts"],
      "the set of activity_events writers changed. If a producer was added, the " +
        "creator-activity score's five inert lanes (consistency, participation, " +
        "positive response, maintenance, spam/repetition penalties) start moving " +
        "ranking output for the first time — check the 22 event_type literals in " +
        "CreatorActivityScoreService actually match what the new producer writes, " +
        "then update this test.",
    );
  });

  it("that one writer is still reachable only through an endpoint nothing calls", () => {
    // Code only — a prose mention in a doc comment is not a caller.
    const referrers = walkTsFiles(SRC_ROOT)
      .filter((f) => !f.includes(`${"/"}test${"/"}`))
      .filter((f) => stripComments(readFileSync(f, "utf8")).includes("internal/activity-events"))
      .map((f) => relative(API_ROOT, f))
      .sort();

    assert.deepEqual(
      referrers,
      ["src/routes/notifications.ts"],
      "POST /internal/activity-events gained an in-repo reference. If something " +
        "now calls it, activity_events stops being permanently empty — see the " +
        "note above.",
    );
  });
});
