/**
 * §12 pattern invalidation — a tombstone must be REACHABLE by the read path, and
 * writing one must be IDEMPOTENT.
 *
 * WHAT THIS EXISTS FOR
 * --------------------
 * `intel_historical_patterns` is append-only: a retracted / superseded /
 * corrected source claim retires its dependent pattern by INSERTing an
 * `is_invalidation` tombstone that supersedes it (spec §12 "Pattern
 * invalidation"). The reader — lib/liveClaimRead.readTypicalPatterns — resolves
 * a served pattern with
 *
 *     .eq("subject_id", …).eq("time_band", "hour_HH").eq("dow", 0..6)
 *
 * and only THEN takes the newest row per (zone, claim_family, pattern_kind),
 * skipping the scope when that newest row is a tombstone.
 *
 * `dow` is therefore part of the tombstone's key, not decoration. The scheduler
 * used to write the tombstone WITHOUT `dow` (the column is nullable, so the row
 * landed with dow = NULL): it never passed the reader's `.eq("dow", …)` filter,
 * the newest MATCHING row stayed the pattern itself, and a retracted or corrected
 * historical pattern kept being served as "Typical" indefinitely.
 *
 * The same pass also handed `deriveInvalidations` every non-tombstone row as
 * "currently served" and never looked at existing tombstones, so it re-inserted
 * the identical tombstone on every nightly run, forever.
 *
 * Both are proven END TO END against the REAL read path, not a restatement of it:
 * the pass writes into a table the fake DB actually keeps, and those written rows
 * are then served through readTypicalPatterns.
 *
 * Run: node --import tsx/esm --test src/test/intelPatternTombstoneKey.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPatternLearningPass } from "../lib/intelPatternScheduler.js";
import { readTypicalPatterns } from "../lib/liveClaimRead.js";
import { currentlyServedPatterns, type StoredPatternRow } from "../lib/intelPatternLearning.js";

const NOW = new Date("2026-09-04T20:00:00.000Z"); // Friday → dow 5, hour_20 UTC
const DOW = NOW.getUTCDay();
const BAND = `hour_${String(NOW.getUTCHours()).padStart(2, "0")}`;
const SUBJECT = "p1";

/** The pattern the nightly pass would have written on an earlier night. */
function servedPatternRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: "pat-1",
    subject_id: SUBJECT,
    zone_id: "z1",
    claim_family: "crowd.level",
    pattern_kind: "typical_crowd_by_weekday_hour",
    time_band: BAND,
    dow: DOW,
    value_json: { level: "busy" },
    cohort_size: 30,
    distinct_contributors: 12,
    distinct_dates: 9,
    window_days: 120,
    confidence: 0.6,
    source_label: "historical_pattern",
    is_invalidation: false,
    computed_at: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** The retraction that must retire it. */
const RETRACTED_CLAIM = {
  subject_id: SUBJECT,
  zone_id: "z1",
  claim_type: "crowd.level",
  status: "retracted",
};

/**
 * A fake Supabase that STORES what is inserted, so the same table object can be
 * read back by the reader and by a second scheduler pass. `.eq` / `.in` / `.gte`
 * are applied the way the DB would — including `.eq("dow", …)`, which is the
 * whole point: a fake that ignored it could not see this defect.
 */
function makeDb(tables: Record<string, any[]>, flags: Record<string, boolean> = { intel_pattern_learning: true }) {
  let seq = 0;
  function from(name: string) {
    const st: any = { op: "select", payload: null, filters: [] as [string, string, any][], single: false };
    const b: any = {
      select() { if (st.op === "insert") st.op = "insert_select"; return b; },
      insert(rows: any) { st.op = "insert"; st.payload = rows; return b; },
      eq(k: string, v: any) { st.filters.push(["eq", k, v]); return b; },
      in(k: string, v: any) { st.filters.push(["in", k, v]); return b; },
      gte(k: string, v: any) { st.filters.push(["gte", k, v]); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      single() { st.single = true; return Promise.resolve(run()); },
      then(res: (r: any) => any, rej?: any) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      if (name === "feature_flags") {
        const flag = st.filters.find((f: any[]) => f[1] === "flag")?.[2];
        return { data: { enabled: Boolean(flags[String(flag)]) }, error: null };
      }
      if (st.op === "insert" || st.op === "insert_select") {
        const rows = (Array.isArray(st.payload) ? st.payload : [st.payload])
          .map((r: any) => ({ id: `ins-${++seq}`, ...r }));
        (tables[name] ??= []).push(...rows);
        return { data: null, error: null };
      }
      let rows = (tables[name] ?? []).slice();
      for (const [op, col, val] of st.filters as [string, string, any][]) {
        if (op === "in") rows = rows.filter((r: any) => (val as any[]).includes(r[col]));
        else if (op === "gte") rows = rows.filter((r: any) => String(r[col]) >= String(val));
        else rows = rows.filter((r: any) => (r[col] ?? null) === val);
      }
      // The reader asks for computed_at DESC; sort newest-first the way PostgREST would.
      rows = rows.sort((a: any, b: any) => String(b.computed_at ?? "").localeCompare(String(a.computed_at ?? "")));
      if (st.single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    return b;
  }
  return { from } as any;
}

/** Read-only client for readTypicalPatterns over the SAME stored rows. */
function readerFor(tables: Record<string, any[]>) {
  const db = makeDb(tables, {});
  return {
    from(table: string) {
      // The live path must stay silent so the read degrades to 'typical'.
      if (table === "feature_flags") {
        const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { enabled: false }, error: null }) };
        return q;
      }
      return db.from(table);
    },
  } as any;
}

describe("§12 tombstones are written with the key their READER matches on", () => {
  it("a retracted pattern stops being served by the real read path", async () => {
    const tables: Record<string, any[]> = {
      intel_observations: [],
      intel_claims: [RETRACTED_CLAIM],
      intel_historical_patterns: [servedPatternRow()],
    };

    // Before the pass, the pattern is served.
    const before = await readTypicalPatterns(readerFor(tables), SUBJECT, { now: NOW });
    assert.equal(before.length, 1, "the pattern is served before it is retracted");

    const r = await runPatternLearningPass({ client: makeDb(tables), now: NOW });
    assert.equal(r.skipped, false);
    assert.equal(r.invalidationsWritten, 1, "the retraction produced one tombstone");

    const tomb = tables.intel_historical_patterns.find((row) => row.is_invalidation === true);
    assert.ok(tomb, "a tombstone row was inserted");
    assert.equal(tomb.time_band, BAND);
    assert.equal(tomb.dow, DOW, "the tombstone carries dow — without it the reader can never match it");
    assert.equal(tomb.supersedes_id, "pat-1");

    // The REAL reader must now serve nothing for this scope.
    const after = await readTypicalPatterns(readerFor(tables), SUBJECT, { now: NOW });
    assert.deepEqual(after, [], "a retracted pattern must stop being served");
  });

  it("re-running the nightly pass does not duplicate the tombstone", async () => {
    const tables: Record<string, any[]> = {
      intel_observations: [],
      intel_claims: [RETRACTED_CLAIM],
      intel_historical_patterns: [servedPatternRow()],
    };

    const first = await runPatternLearningPass({ client: makeDb(tables), now: NOW });
    assert.equal(first.invalidationsWritten, 1);

    const second = await runPatternLearningPass({
      client: makeDb(tables),
      now: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
    });
    assert.equal(second.invalidationsWritten, 0, "an already-retired scope must not be tombstoned again");

    const third = await runPatternLearningPass({
      client: makeDb(tables),
      now: new Date(NOW.getTime() + 48 * 60 * 60 * 1000),
    });
    assert.equal(third.invalidationsWritten, 0);

    const tombs = tables.intel_historical_patterns.filter((row) => row.is_invalidation === true);
    assert.equal(tombs.length, 1, "exactly one tombstone survives three nightly passes");
  });

  it("a superseded older row is not tombstoned — only what the reader would serve", async () => {
    const tables: Record<string, any[]> = {
      intel_observations: [],
      intel_claims: [RETRACTED_CLAIM],
      intel_historical_patterns: [
        servedPatternRow({ id: "pat-old", computed_at: "2026-07-01T00:00:00.000Z" }),
        servedPatternRow({ id: "pat-new", computed_at: "2026-08-20T00:00:00.000Z" }),
      ],
    };
    const r = await runPatternLearningPass({ client: makeDb(tables), now: NOW });
    assert.equal(r.invalidationsWritten, 1, "one tombstone for the one row actually served");
    const tomb = tables.intel_historical_patterns.find((row) => row.is_invalidation === true);
    assert.equal(tomb.supersedes_id, "pat-new");
  });
});

describe("currentlyServedPatterns — the reader's own notion of 'served'", () => {
  const base: StoredPatternRow = {
    id: "a", subjectId: SUBJECT, zoneId: "z1", claimFamily: "crowd.level",
    patternKind: "typical_crowd_by_weekday_hour", timeBand: BAND, dow: DOW,
    computedAt: "2026-08-01T00:00:00.000Z", isInvalidation: false,
  };

  it("keeps the newest row per full key and drops an already-tombstoned scope", () => {
    const served = currentlyServedPatterns([
      base,
      { ...base, id: "b", computedAt: "2026-08-10T00:00:00.000Z", isInvalidation: true },
    ]);
    assert.deepEqual(served, []);
  });

  it("treats a different dow as a DIFFERENT scope (the reader filters on it)", () => {
    const served = currentlyServedPatterns([
      base,
      { ...base, id: "b", dow: (DOW + 1) % 7, computedAt: "2026-08-10T00:00:00.000Z", isInvalidation: true },
    ]);
    assert.deepEqual(served.map((p) => p.id), ["a"], "Thursday's tombstone must not retire Friday's pattern");
  });

  it("a tombstone at the same instant wins (conservative: do not re-serve)", () => {
    const served = currentlyServedPatterns([
      base,
      { ...base, id: "b", isInvalidation: true },
    ]);
    assert.deepEqual(served, []);
  });
});
