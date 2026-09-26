/**
 * The anti-differencing gate over DURABLE state (migration 3110).
 *
 * census-sensing's S24 states the defect precisely: `evaluateDifferencing`'s own
 * header says "the caller keeps the last published aggregate and hands it back
 * in", and THAT CALLER HAS NOWHERE TO KEEP IT. A previous value held in process
 * memory resets on every deploy, restart and replica, and a reset reads as
 * `no_previous` — which PUBLISHES. The failure mode of forgetting is the unsafe
 * direction.
 *
 * The row also rules out the obvious candidate: intel_state_snapshots is one row
 * per (subject, zone, claim) UPSERTED IN PLACE, so the value the gate must
 * compare against has already been overwritten by the value it is being compared
 * with. A gate handed (current, current) always sees delta 0 and publishes.
 *
 * So the property under test is not "the rule is right" — src/test/
 * sensingDifferencingGate.test.ts already proves that, purely. It is:
 *
 *   * the previous publication SURVIVES the call that made it, and a second,
 *     independent invocation reads it back and suppresses on it;
 *   * a read that FAILED is not treated as "nothing published yet", because
 *     that would publish;
 *   * a publication that could not be RECORDED is not served, because the next
 *     call would then compare against nothing;
 *   * an unpublishable aggregate can never become a stored publication, in the
 *     code AND structurally in the schema.
 *
 * The fake client below is a real in-memory table: round two reads what round
 * one wrote. Without that, "durable" would be asserted rather than exercised.
 *
 * No database, and no Supabase credential env var is named anywhere in this file.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { SENSING_MAX_TTL_SECONDS } from "../lib/sensingAnonStore.js";
import {
  SENSING_PUBLISHED_TABLE,
  SENSING_PUBLICATION_MAX_TTL_SECONDS,
  aggregateFromPublicationRow,
  buildPublicationRow,
  evaluateDifferencing,
  publishThroughDifferencingGate,
  readLastPublishedAggregate,
  type PublicationIdentity,
  type SensingPublishedAggregateRow,
} from "../lib/sensingDifferencingGate.js";
import type { SensingCohortAggregate } from "../lib/sensingCoverageAggregate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REPO = resolve(HERE, "..", "..", "..", "..");
const MIGRATION_FILE = join(SRC, "migrations", "3110_sensing_published_aggregates.sql");
const SQL = readFileSync(MIGRATION_FILE, "utf8");
/** The SQL with comments removed, so a promise in prose can never satisfy an assertion. */
const CODE = SQL.replace(/--[^\n]*/g, "");
const GATE_TS = readFileSync(join(SRC, "lib", "sensingDifferencingGate.ts"), "utf8");

const K = PRIVACY_THRESHOLD_V1.minIndependentGroups; // the default minDelta
const IDENTITY: PublicationIdentity = {
  cohortKey: "v1|zone-alpha|2026-09-25T12:00:00.000Z",
  zoneId: "zone-alpha",
  timeBucketIso: "2026-09-25T12:00:00.000Z",
  reductionVersion: 1,
};

function aggregate(over: Partial<SensingCohortAggregate> = {}): SensingCohortAggregate {
  return {
    publishable: true,
    reason: null,
    distinctActors: 20,
    distinctGroups: 6,
    maxGroupShare: 0.15,
    contributions: 20,
    observedAt: "2026-09-25T12:10:00.000Z",
    medianSignalBucket: 3,
    // A publication row carries no 3312 feature statistics, so an aggregate
    // that round-trips through one reads back with `features: null`.
    features: null,
    ...over,
  };
}

/**
 * An in-memory `sensing_published_aggregates`. Append-only, exactly as 3110
 * grants: there is no update() here at all, so a caller that tried to overwrite
 * a publication in place would fail rather than quietly succeed.
 */
function store(opts: { readError?: string; insertError?: string; seed?: SensingPublishedAggregateRow[] } = {}) {
  const rows: SensingPublishedAggregateRow[] = [...(opts.seed ?? [])];
  const state = { reads: 0, inserts: 0, tables: [] as string[] };
  return {
    rows,
    state,
    from(table: string) {
      state.tables.push(table);
      assert.equal(table, SENSING_PUBLISHED_TABLE);
      const q: any = {};
      let cohort = "";
      let after = "";
      q.select = () => q;
      q.eq = (_col: string, val: string) => {
        cohort = val;
        return q;
      };
      q.gt = (_col: string, val: string) => {
        after = val;
        return q;
      };
      q.order = () => q;
      q.limit = async () => {
        state.reads++;
        if (opts.readError) return { data: null, error: { message: opts.readError } };
        const matching = rows
          .filter((r) => r.cohort_key === cohort && (!after || Date.parse(r.expires_at) > Date.parse(after)))
          .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
        return { data: matching.slice(0, 1), error: null };
      };
      q.insert = async (row: SensingPublishedAggregateRow) => {
        state.inserts++;
        if (opts.insertError) return { error: { message: opts.insertError } };
        rows.push(row);
        return { error: null };
      };
      return q;
    },
  };
}

// ── The migration: the store exists, and its floors are the code's floors ────

describe("3110 — the durable last-published store", () => {
  it("the migration and its rollback are both in the tree", () => {
    assert.ok(existsSync(MIGRATION_FILE), "3110 is missing");
    assert.ok(
      existsSync(join(REPO, "db", "rollback", "2026-09-25-3110-sensing-published-aggregates-rollback.sql")),
      "3110 has no rollback script",
    );
  });

  it("is transactional and its postcondition ABORTS rather than logs", () => {
    assert.match(SQL, /^BEGIN;$/m);
    assert.match(SQL, /^COMMIT;$/m);
    assert.match(CODE, /DO \$post\$/);
    assert.match(CODE, /RAISE EXCEPTION 'POSTCONDITION FAILED/);
    // migrationDeployability's rule: every RAISE sits inside an IF.
    for (const line of SQL.split("\n")) {
      if (/^\s*RAISE\s+(EXCEPTION\b|')/.test(line)) {
        assert.ok(
          /RAISE EXCEPTION '(PRE|POST)CONDITION FAILED/.test(line) || /purge_expired_sensing_publications:/.test(line),
          `unexpected RAISE shape: ${line.trim()}`,
        );
      }
    }
  });

  it("is idempotent — re-running it creates nothing twice", () => {
    assert.match(CODE, /CREATE TABLE IF NOT EXISTS public\.sensing_published_aggregates/);
    assert.match(CODE, /CREATE INDEX IF NOT EXISTS sensing_published_aggregates_cohort_idx/);
    assert.match(CODE, /CREATE OR REPLACE FUNCTION public\.purge_expired_sensing_publications/);
    assert.match(CODE, /DROP POLICY IF EXISTS sensing_published_aggregates_service/);
  });

  it("the k-floor in SQL is PRIVACY_THRESHOLD_V1's, not a second opinion", () => {
    // Deliberate duplication of a code constant, in 2340's spirit: the SQL is
    // the authority and this pins the two together so neither can drift.
    assert.match(
      CODE,
      new RegExp(
        `CHECK \\(distinct_contributors >= ${PRIVACY_THRESHOLD_V1.minUniqueActors} AND distinct_groups >= ${PRIVACY_THRESHOLD_V1.minIndependentGroups}\\)`,
      ),
      "the structural k-floor no longer equals PRIVACY_THRESHOLD_V1",
    );
  });

  it("the TTL ceiling is the contribution store's — a publication cannot outlive its cohort", () => {
    assert.equal(SENSING_PUBLICATION_MAX_TTL_SECONDS, SENSING_MAX_TTL_SECONDS);
    assert.match(CODE, /expires_at <= published_at \+ interval '72 hours'/);
  });

  it("is APPEND-ONLY — service_role is granted no UPDATE, and that is asserted in SQL", () => {
    assert.match(CODE, /REVOKE ALL ON public\.sensing_published_aggregates FROM service_role;/);
    assert.match(CODE, /GRANT SELECT, INSERT, DELETE ON public\.sensing_published_aggregates TO service_role;/);
    assert.doesNotMatch(CODE, /GRANT[^;]*UPDATE[^;]*ON public\.sensing_published_aggregates/);
    assert.match(
      CODE,
      /has_table_privilege\('service_role', 'public\.sensing_published_aggregates', 'UPDATE'\)[\s\S]{0,200}RAISE EXCEPTION/,
    );
    // And the module never calls update() either.
    assert.doesNotMatch(GATE_TS, /SENSING_PUBLISHED_TABLE\)[\s\S]{0,120}\.(update|upsert)\(/);
  });

  it("carries no identity, no contributor token and no foreign key", () => {
    assert.doesNotMatch(CODE.replace(/'(?:[^']|'')*'/g, "''"), /REFERENCES/i);
    assert.match(CODE, /c\.contype = 'f'[\s\S]{0,400}RAISE EXCEPTION/);
    for (const forbidden of ["contributor_token", "group_token", "commitment", "rotation_epoch", "actor_id", "credential_hash"]) {
      assert.ok(CODE.includes(`'${forbidden}'`), `${forbidden} is not in the refused-name list`);
    }
    const body = CODE.slice(
      CODE.indexOf("CREATE TABLE IF NOT EXISTS public.sensing_published_aggregates"),
      CODE.indexOf("CREATE INDEX"),
    );
    for (const forbidden of ["actor_id", "user_id", "profile_id", "contributor_token", "group_token"]) {
      assert.doesNotMatch(body, new RegExp(`(^|[^a-z_])${forbidden}\\b`, "i"), `${forbidden} is on the published store`);
    }
  });

  it("RLS is on and no anon/authenticated policy exists", () => {
    assert.match(CODE, /ALTER TABLE public\.sensing_published_aggregates ENABLE ROW LEVEL SECURITY/);
    assert.match(CODE, /REVOKE ALL ON public\.sensing_published_aggregates FROM anon;/);
    assert.match(CODE, /REVOKE ALL ON public\.sensing_published_aggregates FROM authenticated;/);
    assert.doesNotMatch(CODE, /CREATE POLICY [a-z_]+ ON public\.sensing_published_aggregates\s+FOR ALL TO (anon|authenticated)/);
  });
});

// ── Building a publication row ───────────────────────────────────────────────

describe("a suppression is not a publication", () => {
  it("refuses to build a row for an unpublishable aggregate, by name", () => {
    const r = buildPublicationRow(IDENTITY, aggregate({ publishable: false, reason: "below_actor_threshold" }), 1_700_000_000_000);
    assert.deepEqual(r, { ok: false, error: "aggregate_not_publishable" });
  });

  it("refuses a TTL past the 72-hour ceiling before any round trip", () => {
    const r = buildPublicationRow(IDENTITY, aggregate(), 1_700_000_000_000, SENSING_PUBLICATION_MAX_TTL_SECONDS + 1);
    assert.deepEqual(r, { ok: false, error: "ttl_exceeds_maximum" });
  });

  it("a built row round-trips back to the aggregate it published", () => {
    const built = buildPublicationRow(IDENTITY, aggregate(), 1_700_000_000_000);
    assert.equal(built.ok, true);
    const row = (built as { ok: true; row: SensingPublishedAggregateRow }).row;
    assert.deepEqual(aggregateFromPublicationRow(row), aggregate());
    // And the row carries nothing about a person.
    for (const forbidden of ["contributor_token", "group_token", "commitment", "actor_id", "credential_hash"]) {
      assert.equal(forbidden in row, false, `${forbidden} reached a published aggregate`);
    }
  });
});

// ── The durability property itself ───────────────────────────────────────────

describe("the gate holds over TWO REAL READS, because the previous value is durable", () => {
  it("publication one is recorded, and publication two READS IT BACK and suppresses a small delta", async () => {
    const db = store();
    const now = 1_700_000_000_000;

    // Round one: nothing published yet.
    const first = await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 20 }), now);
    assert.deepEqual([first.publish, first.reason, first.recorded], [true, "no_previous", true]);
    assert.equal(db.rows.length, 1, "the publication was not made durable");

    // Round two, a SEPARATE invocation that shares nothing with the first but
    // the store. One more contributor is exactly the differencing attack.
    const second = await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 21 }), now + 60_000);
    assert.equal(second.publish, false, "a one-contributor move was published — that IS the differencing leak");
    assert.equal(second.reason, "delta_below_minimum");
    assert.equal(second.serve?.distinctActors, 20, "the previous value must be re-served, not the new one");
    assert.equal(second.recorded, false);
    assert.equal(db.rows.length, 1, "a suppressed re-publication must not be recorded as one");
  });

  it("a move of a whole independent party or more IS published, and recorded", async () => {
    const db = store();
    const now = 1_700_000_000_000;
    await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 20 }), now);
    const second = await publishThroughDifferencingGate(
      db as any,
      IDENTITY,
      aggregate({ distinctActors: 20 + K }),
      now + 60_000,
    );
    assert.deepEqual([second.publish, second.reason, second.recorded], [true, "delta_at_least_minimum", true]);
    assert.equal(db.rows.length, 2, "append-only: the second publication is a second row");
    // And the NEXT read gets the newest of the two.
    const read = await readLastPublishedAggregate(db as any, IDENTITY.cohortKey, new Date(now + 120_000).toISOString());
    assert.equal(read.ok, true);
    assert.equal((read as { ok: true; row: SensingPublishedAggregateRow }).row.distinct_contributors, 20 + K);
  });

  it("an unchanged cohort re-serves without suppressing — a re-serve leaks nothing new", async () => {
    const db = store();
    const now = 1_700_000_000_000;
    await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 20 }), now);
    const second = await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 20 }), now + 60_000);
    assert.deepEqual([second.publish, second.reason], [true, "unchanged"]);
  });

  it("one cohort's publication is not another cohort's previous value", async () => {
    const db = store();
    const now = 1_700_000_000_000;
    await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 20 }), now);
    const other = { ...IDENTITY, cohortKey: "v1|zone-beta|2026-09-25T12:00:00.000Z", zoneId: "zone-beta" };
    const d = await publishThroughDifferencingGate(db as any, other, aggregate({ distinctActors: 21 }), now + 1000);
    assert.equal(d.reason, "no_previous", "a different cohort read another cohort's history");
  });

  it("an EXPIRED publication is not read back as the previous value", async () => {
    const db = store();
    const now = 1_700_000_000_000;
    await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 20 }), now, {
      ttlSeconds: 3600,
    });
    const later = now + 2 * 3600 * 1000;
    const d = await publishThroughDifferencingGate(db as any, IDENTITY, aggregate({ distinctActors: 21 }), later);
    assert.equal(d.reason, "no_previous");
  });
});

// ── Fail-closed: the two ways this could quietly become unsafe ───────────────

describe("fail-closed — 'we could not look' is never answered as 'nothing to compare'", () => {
  it("a FAILED read of the previous publication refuses, and serves nothing", async () => {
    const db = store({ readError: "connection reset" });
    const d = await publishThroughDifferencingGate(db as any, IDENTITY, aggregate(), 1_700_000_000_000);
    assert.equal(d.publish, false, "an unreadable history published — a `?? null` here IS the bug");
    assert.equal(d.reason, "previous_unreadable");
    assert.equal(d.serve, null);
    assert.equal(d.recorded, false);
    assert.equal(db.state.inserts, 0);
  });

  it("a publication that could not be RECORDED is not served", async () => {
    // A value served whose record did not land is a value the next call would
    // compare against nothing, which re-opens the attack immediately.
    const db = store({ insertError: "disk full" });
    const d = await publishThroughDifferencingGate(db as any, IDENTITY, aggregate(), 1_700_000_000_000);
    assert.equal(d.publish, false);
    assert.equal(d.reason, "publication_not_recorded");
    assert.equal(d.serve, null);
    assert.equal(d.recorded, false);
  });

  it("an unpublishable cohort is refused by the privacy gate first, and records nothing", async () => {
    const db = store();
    const d = await publishThroughDifferencingGate(
      db as any,
      IDENTITY,
      aggregate({ publishable: false, reason: "below_actor_threshold" }),
      1_700_000_000_000,
    );
    assert.deepEqual([d.publish, d.reason, d.serve, d.recorded], [false, "not_publishable", null, false]);
    assert.equal(db.state.inserts, 0);
  });

  it("the pure rule is unchanged — the durable half added no second opinion", () => {
    // The in-memory rule and the durable path must agree; if they ever did not,
    // the durable path would be a second copy of the control.
    const prev = aggregate({ distinctActors: 20 });
    const cur = aggregate({ distinctActors: 21 });
    assert.deepEqual(
      [evaluateDifferencing(prev, cur).publish, evaluateDifferencing(prev, cur).reason],
      [false, "delta_below_minimum"],
    );
  });
});
