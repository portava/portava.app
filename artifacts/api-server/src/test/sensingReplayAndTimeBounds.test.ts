/**
 * 2340 — anti-replay key, observation-time bounds, the non-decorative grant —
 * and the store / service / aggregate changes that pair with it.
 *
 * Census rows: S33 (replay / idempotency per credential — the anonymous store
 * had none), S35 (impossible timestamps — the store bound the epoch to the
 * instant and nothing bound the instant to the clock), S13 (one device ≠ a
 * crowd — now a property of the rows, not of one reader's Set).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SENSING_MAX_OBSERVATION_AGE_SECONDS,
  SENSING_MAX_TTL_SECONDS,
  buildSensingContributionRow,
  deriveEpochSecret,
  recordSensingContribution,
  revocationCommitment,
  rotationEpochFor,
  sensingTimeBucket,
  type SensingContributionRow,
} from "../lib/sensingAnonStore.js";
import { recordAnonSensingContribution, _resetSensingStorePresence } from "../lib/sensingAnonService.js";
import { aggregateSensingCohort } from "../lib/sensingCoverageAggregate.js";
import { MAX_OBSERVED_AT_SKEW_MS } from "../lib/intelContracts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");
const REPO = resolve(SRC, "..", "..", "..");
const MIGRATION = join(SRC, "migrations", "2340_sensing_anon_replay_and_time_bounds.sql");
const ROLLBACK = join(REPO, "db", "rollback", "2026-09-07-2340-sensing-anon-replay-and-time-bounds-rollback.sql");
const SQL = readFileSync(MIGRATION, "utf8");
const CODE = SQL.replace(/--[^\n]*/g, "");
const TABLE = "sensing_anon_contributions";

process.env.SENSING_CONTRIBUTOR_PEPPER ??= "p".repeat(40);

const NOW = Date.UTC(2026, 8, 7, 22, 0, 0);
const DEVICE_SECRET = "device-secret-that-never-leaves-the-device";

function input(over: Record<string, unknown> = {}) {
  const observedAtMs = (over.observedAtMs as number | undefined) ?? NOW - 60_000;
  const epoch = rotationEpochFor(observedAtMs);
  return {
    commitment: revocationCommitment(deriveEpochSecret(DEVICE_SECRET, epoch)),
    rotationEpoch: epoch,
    zoneId: "zone-alpha",
    observedAtMs,
    signalBucket: 2,
    ...over,
  } as any;
}

// ── The migration ────────────────────────────────────────────────────────────

describe("2340 — the replay key", () => {
  it("is a UNIQUE index on exactly (cohort_key, contributor_token)", () => {
    assert.match(CODE, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_replay_idx\\s+ON public\\.${TABLE} \\(cohort_key, contributor_token\\)`));
  });
  it("a postcondition proves it is unique, not merely present", () => {
    assert.match(CODE, /indisunique[\s\S]{0,400}RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions_replay_idx is missing or not unique/);
  });
});

describe("2340 — the observation-time bounds", () => {
  it("bounds time_bucket to [created_at − 72 h, created_at + 60 s] — the intel skew and the TTL ceiling", () => {
    assert.match(CODE, /time_bucket <= created_at \+ interval '60 seconds'/);
    assert.match(CODE, /time_bucket >= created_at - interval '72 hours'/);
    assert.equal(MAX_OBSERVED_AT_SKEW_MS, 60_000);
    assert.equal(SENSING_MAX_OBSERVATION_AGE_SECONDS, SENSING_MAX_TTL_SECONDS);
  });
  it("is added only if absent, so the file is idempotent, and a postcondition proves it survived", () => {
    assert.match(CODE, /conname = 'sensing_anon_contributions_time_bounds_check'[\s\S]{0,200}IF NOT FOUND THEN\s+ALTER TABLE/);
    assert.match(CODE, /time_bounds_check'\s+AND contype = 'c'[\s\S]{0,200}RAISE EXCEPTION 'POSTCONDITION FAILED: the observation-time CHECK is missing/);
  });
});

describe("2340 — the grant is no longer decorative", () => {
  it("REVOKEs from service_role BEFORE granting back SELECT, INSERT, DELETE (2217's pattern)", () => {
    const revoke = CODE.indexOf(`REVOKE ALL ON public.${TABLE} FROM service_role;`);
    const grant = CODE.indexOf(`GRANT SELECT, INSERT, DELETE ON public.${TABLE} TO service_role;`);
    assert.ok(revoke > 0 && grant > revoke, "revoke must precede the narrow grant");
    assert.doesNotMatch(CODE, /GRANT[^;]*UPDATE[^;]*TO/);
  });
  it("a postcondition asserts service_role holds no UPDATE and user roles cannot read", () => {
    assert.match(CODE, /has_table_privilege\('service_role', 'public\.sensing_anon_contributions', 'UPDATE'\)[\s\S]{0,200}RAISE EXCEPTION/);
    assert.match(CODE, /has_table_privilege\('authenticated', 'public\.sensing_anon_contributions', 'SELECT'\)/);
  });
  it("re-asserts 2315's structural promises: no FK, RLS on, no user policy", () => {
    assert.match(CODE, /contype = 'f'[\s\S]{0,300}RAISE EXCEPTION 'POSTCONDITION FAILED: sensing_anon_contributions has % foreign key/);
    assert.match(CODE, /relrowsecurity[\s\S]{0,200}RAISE EXCEPTION 'POSTCONDITION FAILED: RLS is not enabled/);
    assert.match(CODE, /'anon' = ANY\(roles\) OR 'authenticated' = ANY\(roles\)[\s\S]{0,200}RAISE EXCEPTION/);
  });
});

describe("2340 — migration hygiene", () => {
  it("one transaction, additive, no row written, no flag, no ledger self-registration", () => {
    assert.equal((CODE.match(/\bBEGIN;/g) ?? []).length, 1);
    assert.equal((CODE.match(/\bCOMMIT;/g) ?? []).length, 1);
    assert.doesNotMatch(CODE, /INSERT INTO|UPDATE public\.|DROP TABLE|DROP COLUMN|TRUNCATE/i);
    assert.doesNotMatch(CODE, /feature_flags/i);
    assert.doesNotMatch(CODE, /schema_migration_ledger/);
  });
  it("preconditions require 2315's table and its TTL CHECK", () => {
    assert.match(CODE, /to_regclass\('public\.sensing_anon_contributions'\) IS NULL[\s\S]{0,120}PRECONDITION FAILED/);
    assert.match(CODE, /sensing_anon_contributions_ttl_check[\s\S]{0,200}PRECONDITION FAILED/);
  });
  it("every RAISE is guarded by a condition", () => {
    const raises = (CODE.match(/RAISE EXCEPTION/g) ?? []).length;
    const guards = (CODE.match(/\bIF\b(?!\s+NOT EXISTS)/g) ?? []).length;
    assert.ok(raises > 0 && guards >= raises, `${raises} RAISEs, ${guards} IFs`);
  });
  it("claims lane 2340 alone", () => {
    assert.doesNotMatch(SQL.replace(/2340/g, ""), /\b23[0-9]{2}_[a-z]/);
  });
  it("has an idempotent rollback that drops both objects, refuses over duplicates, and does not re-grant UPDATE", () => {
    assert.ok(existsSync(ROLLBACK), ROLLBACK);
    const rb = readFileSync(ROLLBACK, "utf8").replace(/--[^\n]*/g, "");
    assert.match(rb, new RegExp(`DROP INDEX IF EXISTS public\\.${TABLE}_replay_idx;`));
    assert.match(rb, /DROP CONSTRAINT IF EXISTS sensing_anon_contributions_time_bounds_check;/);
    assert.match(rb, /HAVING count\(\*\) > 1[\s\S]{0,300}RAISE EXCEPTION/);
    assert.doesNotMatch(rb, /GRANT/);
  });
});

// ── The store ────────────────────────────────────────────────────────────────

describe("the store refuses impossible instants before the round trip", () => {
  it("an observation beyond the intel skew allowance is in the future", () => {
    const r = buildSensingContributionRow(input({ observedAtMs: NOW + MAX_OBSERVED_AT_SKEW_MS + 1 }), NOW);
    assert.deepEqual(r, { ok: false, error: "observed_at_in_future" });
    assert.ok(buildSensingContributionRow(input({ observedAtMs: NOW + MAX_OBSERVED_AT_SKEW_MS - 1 }), NOW).ok);
  });
  it("a bucket older than the 72 h ceiling is too old; one inside it is fine", () => {
    const ceiling = NOW - SENSING_MAX_OBSERVATION_AGE_SECONDS * 1000;
    const tooOld = buildSensingContributionRow(input({ observedAtMs: ceiling - 60_000 }), NOW);
    assert.deepEqual(tooOld, { ok: false, error: "observed_at_too_old" });
    // 31 minutes inside the ceiling floors to a bucket that starts inside it.
    const inside = buildSensingContributionRow(input({ observedAtMs: ceiling + 31 * 60_000 }), NOW);
    assert.ok(inside.ok, JSON.stringify(inside));
    assert.ok(Date.parse(inside.row.time_bucket) >= ceiling);
  });
  it("the bound is at BUCKET granularity, matching the CHECK", () => {
    const ceiling = NOW - SENSING_MAX_OBSERVATION_AGE_SECONDS * 1000;
    // Inside the ceiling by 5 minutes, but the bucket it floors into starts before it.
    const t = ceiling + 5 * 60_000;
    const expectedBucketStart = Date.parse(sensingTimeBucket(t));
    const r = buildSensingContributionRow(input({ observedAtMs: t }), NOW);
    assert.equal(r.ok, expectedBucketStart >= ceiling, "the verdict must follow the bucket, not the raw instant");
  });
});

function fakeDb(insertResult: { error: any }) {
  const inserts: any[] = [];
  return {
    inserts,
    from(table: string) {
      assert.equal(table, TABLE);
      return {
        select(_c: string, o?: any) {
          if (o?.head) return { limit: async () => ({ data: null, error: null }) };
          throw new Error("unexpected read");
        },
        insert: async (row: any) => {
          inserts.push(row);
          return insertResult;
        },
      };
    },
  } as any;
}

describe("the store treats a replay as a successful no-op", () => {
  it("23505 ⇒ ok, duplicate: true — and nothing else was written", async () => {
    const db = fakeDb({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });
    const r = await recordSensingContribution(db, input(), NOW);
    assert.deepEqual(r, { ok: true, duplicate: true });
    assert.equal(db.inserts.length, 1);
  });
  it("a fresh insert is ok, duplicate: false", async () => {
    assert.deepEqual(await recordSensingContribution(fakeDb({ error: null }), input(), NOW), { ok: true, duplicate: false });
  });
  it("any other database error is still a failure", async () => {
    const r = await recordSensingContribution(fakeDb({ error: { code: "42501", message: "permission denied" } }), input(), NOW);
    assert.deepEqual(r, { ok: false, error: "permission denied" });
  });
  it("the service passes the duplicate flag through and maps the new refusals to invalid_input", async () => {
    _resetSensingStorePresence();
    const dup = await recordAnonSensingContribution(input(), { client: fakeDb({ error: { code: "23505", message: "dup" } }), nowMs: NOW });
    assert.deepEqual(dup, { ok: true, duplicate: true });
    _resetSensingStorePresence();
    const future = await recordAnonSensingContribution(input({ observedAtMs: NOW + 10 * 60_000 }), { client: fakeDb({ error: null }), nowMs: NOW });
    assert.deepEqual(future, { ok: false, reason: "invalid_input", error: "observed_at_in_future" });
    _resetSensingStorePresence();
  });
});

// ── The aggregate ────────────────────────────────────────────────────────────

function cohort(n: number, groups: number, over: (i: number) => Partial<SensingContributionRow> = () => ({})): SensingContributionRow[] {
  const rows: SensingContributionRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      contributor_token: `tok-${String(i).padStart(4, "0")}-${"x".repeat(12)}`,
      rotation_epoch: rotationEpochFor(NOW),
      group_token: `grp-${i % groups}-${"y".repeat(16)}`,
      zone_id: "zone-alpha",
      time_bucket: sensingTimeBucket(NOW - 20 * 60_000),
      cohort_key: "v1|zone-alpha|bucket",
      signal_bucket: i % 5,
      reduction_version: 1,
      created_at: new Date(NOW - 15 * 60_000).toISOString(),
      expires_at: new Date(NOW + 3600_000).toISOString(),
      ...over(i),
    });
  }
  return rows;
}

describe("the aggregate's per-contributor median", () => {
  it("a gate-cleared cohort carries the lower median of one bucket per contributor", () => {
    // 30 contributors, buckets 0..4 six times each → sorted middle (index 14) is 2.
    const a = aggregateSensingCohort({ ok: true, complete: true, rows: cohort(30, 6) }, { nowMs: NOW });
    assert.equal(a.publishable, true, a.reason ?? "");
    assert.equal(a.medianSignalBucket, 2);
  });
  it("a prolific contributor's duplicate rows count ONCE", () => {
    // 30 honest contributors at bucket 1, plus one contributor who wrote 40 rows at bucket 4.
    const honest = cohort(30, 6, () => ({ signal_bucket: 1 }));
    const noisy = cohort(40, 1, (i) => ({
      contributor_token: `tok-noisy-${"z".repeat(12)}`,
      group_token: `grp-0-${"y".repeat(16)}`,
      signal_bucket: 4,
      created_at: new Date(NOW - 15 * 60_000 + i).toISOString(),
    }));
    const a = aggregateSensingCohort({ ok: true, complete: true, rows: [...honest, ...noisy] }, { nowMs: NOW });
    assert.equal(a.publishable, true, a.reason ?? "");
    assert.equal(a.distinctActors, 31);
    assert.equal(a.medianSignalBucket, 1, "forty rows from one device must not drag the median to 4");
  });

  it("and of a contributor's duplicate rows, the LATEST by created_at is the one that counts — not the last in read order", () => {
    // 15 honest at bucket 0, 15 honest at bucket 4: one more contributor decides the lower median.
    const honest = cohort(30, 6, (i) => ({ signal_bucket: i < 15 ? 0 : 4 }));
    const newest = cohort(1, 1, () => ({
      contributor_token: `tok-flip-${"z".repeat(12)}`,
      group_token: `grp-0-${"y".repeat(16)}`,
      signal_bucket: 0,
      created_at: new Date(NOW - 14 * 60_000).toISOString(), // newer
    }));
    const older = cohort(1, 1, () => ({
      contributor_token: `tok-flip-${"z".repeat(12)}`,
      group_token: `grp-0-${"y".repeat(16)}`,
      signal_bucket: 4,
      created_at: new Date(NOW - 16 * 60_000).toISOString(), // older, but read LAST
    }));
    const a = aggregateSensingCohort({ ok: true, complete: true, rows: [...honest, ...newest, ...older] }, { nowMs: NOW });
    assert.equal(a.publishable, true, a.reason ?? "");
    assert.equal(a.distinctActors, 31);
    // 16 × 0 and 15 × 4 → lower median 0. If read order won instead, 15 × 0 and 16 × 4 → 4.
    assert.equal(a.medianSignalBucket, 0);
  });
  it("an unpublishable cohort carries NO median — not even a coarse one", () => {
    const a = aggregateSensingCohort({ ok: true, complete: true, rows: cohort(5, 5) }, { nowMs: NOW });
    assert.equal(a.publishable, false);
    assert.equal(a.medianSignalBucket, null);
    const empty = aggregateSensingCohort({ ok: true, complete: true, rows: [] }, { nowMs: NOW });
    assert.equal(empty.medianSignalBucket, null);
    const failed = aggregateSensingCohort({ ok: false, complete: false, rows: [], error: "boom", reportedCount: 500 }, { nowMs: NOW });
    assert.equal(failed.medianSignalBucket, null);
  });
});
