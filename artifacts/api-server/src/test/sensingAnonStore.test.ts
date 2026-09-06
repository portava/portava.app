/**
 * Sensing anonymous contribution store — the four properties the owner ruling of
 * 2026-09-06 turns on, each proved rather than asserted in a comment:
 *
 *   1. NO USER FK CAN EXIST on the new table (and no user-identifying column,
 *      which is the same harm with no constraint attached).
 *   2. A CONTRIBUTION EXPIRES — at write time, at read time, and in the count
 *      the privacy gate is handed.
 *   3. REVOCATION WORKS WITHOUT AN IDENTITY — one holder's rows disappear across
 *      every bucket, another holder's survive, and the secret never leaves the
 *      process.
 *   4. THE AGGREGATION REFUSES TO PUBLISH below the EXISTING privacy threshold,
 *      by routing through lib/privacyGate.evaluatePrivacy rather than deciding.
 *
 * Every schema-level claim is checked against the migration TEXT, with a
 * doctored positive control beside it, so the assertion cannot pass vacuously if
 * the detector stops looking (the idiom of schemaReferenceStatic.test.ts). No
 * database is touched, and none is needed: what is asserted here is a fact about
 * the repository.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENSING_TABLE,
  SENSING_SIGNAL_BANDS,
  SENSING_MAX_TTL_SECONDS,
  SENSING_ROTATION_PERIOD_MINUTES,
  aggregateSensingCohort,
  buildSensingContributionRow,
  deriveSensingGroupKey,
  deriveSensingRevocationTag,
  deriveSensingRotationId,
  isSensingDigest,
  liveSensingBucketStarts,
  purgeExpiredSensingContributions,
  readSensingCohort,
  revokeSensingContributions,
  sensingBucketStartMs,
  writeSensingContribution,
  type SensingCohortRow,
  type SensingContributionInput,
} from "../lib/sensingAnonStore.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { USER_IDENTIFYING_COLUMNS } from "../lib/deletionDispositions.js";
import { stripSqlComments } from "../scripts/lib/canonicalSchema.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const MIGRATION_PATH = resolve(
  API_ROOT,
  "src/migrations/2315_sensing_anonymous_contributions.sql",
);

const SECRET_A = "holder-a-secret-0123456789abcdef";
const SECRET_B = "holder-b-secret-fedcba9876543210";
const PERIOD_MS = SENSING_ROTATION_PERIOD_MINUTES * 60_000;

// Every test derives HMACs, and lib/sensingAnonStore fails closed without a
// server key (deliberately — a guessable key makes a rotating pseudonym stable).
// Set at module scope rather than in a hook so no ordering question can arise;
// `??=` leaves a real value alone, and node --test gives each file its own
// process, so nothing else sees this.
process.env.SESSION_SECRET ??= "test-session-secret-please-ignore-0123456789";

// ─────────────────────────────────────────────────────────────────────────────
// Static detectors over the migration text. Each takes SQL so the same detector
// can be pointed at a DOCTORED copy as a positive control — the assertion then
// proves the detector still looks, not merely that the file is currently clean.
// ─────────────────────────────────────────────────────────────────────────────

const migrationSql = (): string => readFileSync(MIGRATION_PATH, "utf8");

/**
 * DDL only: comments removed AND every single-quoted string literal blanked.
 *
 * Both are load-bearing. The migration's own postcondition MESSAGES contain the
 * words "FOREIGN KEY" and its column COMMENT contains "references none", and a
 * detector that reads those as declarations reports a violation the file does
 * not commit — a false failure, which is worse than no check. Blanking keeps the
 * quotes so statement shape survives.
 */
function ddlOnly(sql: string): string {
  return stripSqlComments(sql).replace(/'(?:[^']|'')*'/g, "''");
}

/** The `CREATE TABLE public.sensing_contributions ( ... )` body, comments removed. */
function createTableBody(sql: string): string {
  const stripped = stripSqlComments(sql);
  const start = stripped.search(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.sensing_contributions\s*\(/i,
  );
  assert.notEqual(start, -1, "the migration must declare public.sensing_contributions");
  let depth = 0;
  let started = false;
  let body = "";
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i]!;
    if (ch === "(") {
      depth++;
      started = true;
      if (depth === 1) continue;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) break;
    }
    if (started) body += ch;
  }
  assert.ok(started && body.length > 0, "the CREATE TABLE body must be parseable");
  return body;
}

/** Column names declared in the CREATE TABLE body (table constraints skipped). */
function declaredColumns(sql: string): string[] {
  const body = createTableBody(sql);
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out: string[] = [];
  for (const raw of parts) {
    const line = raw.trim();
    const first = line.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (["constraint", "primary", "unique", "foreign", "check", "exclude", "like"].includes(first)) {
      continue;
    }
    const m = /^([A-Za-z0-9_]+)\s+\S/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Every foreign-key declaration anywhere in the migration — inline `REFERENCES`
 * on a column, a table-level `FOREIGN KEY`, or a later `ADD CONSTRAINT`.
 * Deliberately not limited to profiles/auth.users: an FK to any user-keyed table
 * reintroduces the same join one indirection away.
 */
function foreignKeyDeclarations(sql: string): string[] {
  const stripped = ddlOnly(sql);
  const hits: string[] = [];
  for (const m of stripped.matchAll(/\bREFERENCES\s+([A-Za-z0-9_."]+)/gi)) hits.push(m[0].trim());
  for (const m of stripped.matchAll(/\bFOREIGN\s+KEY\b/gi)) hits.push(m[0].trim());
  return hits;
}

/** Policies created on the table, with the roles they are granted to. */
function policyGrants(sql: string): string[] {
  const stripped = ddlOnly(sql);
  const hits: string[] = [];
  for (const m of stripped.matchAll(
    /CREATE\s+POLICY\s+[A-Za-z0-9_"]+\s+ON\s+public\.sensing_contributions([\s\S]*?);/gi,
  )) {
    hits.push(m[0].replace(/\s+/g, " ").trim());
  }
  return hits;
}

/** Principals the migration GRANTs anything on the table to. */
function grantees(sql: string): string[] {
  const stripped = ddlOnly(sql);
  const out = new Set<string>();
  for (const m of stripped.matchAll(
    /GRANT\s+[^;]*?\s+ON\s+public\.sensing_contributions\s+TO\s+([A-Za-z0-9_, ]+);/gi,
  )) {
    for (const g of m[1]!.split(",")) out.add(g.trim().toLowerCase());
  }
  return [...out].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NO USER FK CAN EXIST
// ─────────────────────────────────────────────────────────────────────────────
describe("sensing_contributions — the ruling's identity bar", () => {
  it("declares NO foreign key at all (the profiles/auth.users bar, checked as zero FKs)", () => {
    assert.deepEqual(
      foreignKeyDeclarations(migrationSql()),
      [],
      "the anonymous store may not reference any table — an FK to a user-keyed table is a user link one indirection away",
    );
  });

  it("the FK detector really looks — a doctored profiles FK is reported", () => {
    // POSITIVE CONTROL. Without this, deleting the detector's body would leave
    // the assertion above passing forever.
    const doctored = migrationSql().replace(
      "  rotation_id     text NOT NULL",
      "  actor_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,\n  rotation_id     text NOT NULL",
    );
    const found = foreignKeyDeclarations(doctored);
    assert.ok(found.length > 0, "a doctored REFERENCES public.profiles must be detected");
    assert.match(found.join(" "), /profiles/);
  });

  it("declares no user-identifying column, judged by the repo's OWN manifest", () => {
    // Reuses deletionDispositions.USER_IDENTIFYING_COLUMNS rather than a local
    // list, so a column name the repo later decides is user-identifying starts
    // being checked here for free.
    const cols = declaredColumns(migrationSql());
    const offending = cols.filter((c) => USER_IDENTIFYING_COLUMNS.includes(c));
    assert.deepEqual(offending, [], `user-identifying column(s) on ${SENSING_TABLE}`);
    assert.ok(cols.length >= 8, "sanity: the column parser found the real column list");
  });

  it("the user-column detector really looks — a doctored actor_id is reported", () => {
    const doctored = migrationSql().replace(
      "  rotation_id     text NOT NULL",
      "  actor_id uuid,\n  rotation_id     text NOT NULL",
    );
    const cols = declaredColumns(doctored);
    assert.ok(
      cols.filter((c) => USER_IDENTIFYING_COLUMNS.includes(c)).length > 0,
      "a doctored actor_id column must be detected",
    );
  });

  it("carries a pg_constraint POSTCONDITION that RAISEs if an FK ever appears", () => {
    const sql = stripSqlComments(migrationSql());
    assert.match(sql, /pg_constraint/, "the postcondition must inspect pg_constraint");
    assert.match(sql, /contype\s*=\s*'f'/, "it must look for foreign-key constraints specifically");
    // Deployability rule (migrationDeployability.test.ts): a top-level DO block
    // may only RAISE from inside a failure condition, never unconditionally.
    const fkBlock = /pg_constraint[\s\S]*?IF\s+offending\s+IS\s+NOT\s+NULL\s+THEN[\s\S]*?RAISE\s+EXCEPTION/i;
    assert.match(sql, fkBlock, "the RAISE must be guarded by the failure condition");
  });

  it("carries a postcondition naming the user-identifying columns it forbids", () => {
    const sql = stripSqlComments(migrationSql());
    assert.match(sql, /information_schema\.columns[\s\S]*?'actor_id'/);
    assert.match(sql, /information_schema\.columns[\s\S]*?'user_id'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1b. NOT A SECOND INTEL LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────
describe("sensing_contributions — does not duplicate the intel lifecycle", () => {
  const FORBIDDEN = [
    "status", "state", "claim", "review", "conflict", "snapshot",
    "confidence", "verified", "supersed", "resolv", "observation",
  ];

  it("declares no claim/review/status/conflict/snapshot column", () => {
    const cols = declaredColumns(migrationSql());
    const offending = cols.filter((c) => FORBIDDEN.some((f) => c.toLowerCase().includes(f)));
    assert.deepEqual(
      offending,
      [],
      "claim/review/status/conflict/snapshot semantics stay in the canonical intel spine",
    );
  });

  it("the lifecycle detector really looks — a doctored claim_status is reported", () => {
    const doctored = migrationSql().replace(
      "  rotation_id     text NOT NULL",
      "  claim_status text,\n  rotation_id     text NOT NULL",
    );
    const cols = declaredColumns(doctored);
    assert.ok(cols.filter((c) => FORBIDDEN.some((f) => c.toLowerCase().includes(f))).length > 0);
  });

  it("touches no canonical intel table — it creates exactly one table and alters none", () => {
    const sql = stripSqlComments(migrationSql());
    const created = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi)]
      .map((m) => m[1]!);
    assert.deepEqual(created, [SENSING_TABLE], "exactly one new table, and it is the sensing store");

    const altered = [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?public\.([a-z0-9_]+)/gi)]
      .map((m) => m[1]!);
    assert.deepEqual(
      [...new Set(altered)],
      [SENSING_TABLE],
      "the only ALTER is this table's own RLS enable — the intel spine is untouched",
    );
    for (const t of ["intel_observations", "intel_claims", "intel_state_snapshots"]) {
      assert.ok(!altered.includes(t), `${t} must not be altered`);
    }
  });

  it("stores no aggregate — the ruling's 'coverage aggregation' is a read-time function", () => {
    // 2130 refused a second coverage model; 2181 built the one that exists.
    // aggregateSensingCohort returns its result and writes nothing, which is why
    // this migration creates no snapshot table.
    const sql = stripSqlComments(migrationSql());
    assert.ok(!/INSERT\s+INTO/i.test(sql), "the migration seeds no rows and stores no aggregate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1c. RLS POSTURE — service_role only, no anon/authenticated policy
// ─────────────────────────────────────────────────────────────────────────────
describe("sensing_contributions — RLS posture (2217's deny-by-default)", () => {
  it("enables RLS and creates no policy at all", () => {
    const sql = stripSqlComments(migrationSql());
    assert.match(sql, /ALTER\s+TABLE\s+public\.sensing_contributions\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    assert.deepEqual(policyGrants(migrationSql()), [], "RLS on with ZERO policies is the deny-by-default state");
  });

  it("the policy detector really looks — a doctored authenticated policy is reported", () => {
    const doctored = migrationSql().replace(
      "ALTER TABLE public.sensing_contributions ENABLE ROW LEVEL SECURITY;",
      "ALTER TABLE public.sensing_contributions ENABLE ROW LEVEL SECURITY;\nCREATE POLICY sensing_read_own ON public.sensing_contributions FOR SELECT TO authenticated USING (true);",
    );
    const found = policyGrants(doctored);
    assert.equal(found.length, 1);
    assert.match(found[0]!, /authenticated/);
  });

  it("grants to service_role and to nobody else", () => {
    assert.deepEqual(grantees(migrationSql()), ["service_role"]);
    const sql = stripSqlComments(migrationSql());
    for (const principal of ["PUBLIC", "anon", "authenticated"]) {
      assert.match(
        sql,
        new RegExp(`REVOKE\\s+ALL\\s+ON\\s+public\\.sensing_contributions\\s+FROM\\s+${principal}`, "i"),
        `${principal} must be explicitly revoked`,
      );
    }
    assert.ok(
      !/GRANT\s+[^;]*?UPDATE[^;]*?ON\s+public\.sensing_contributions/i.test(sql),
      "no UPDATE grant to anyone: expiry and revocation are DELETEs",
    );
  });

  it("carries a POSTCONDITION asserting the absence of anon/authenticated policies", () => {
    const sql = stripSqlComments(migrationSql());
    assert.match(sql, /pg_policies/, "the postcondition must inspect pg_policies");
    assert.match(
      sql,
      /pg_policies[\s\S]*?ARRAY\[\s*'anon',\s*'authenticated',\s*'public'\s*\]/i,
      "it must name anon/authenticated explicitly",
    );
    assert.match(
      sql,
      /IF\s+exposed\s+IS\s+NOT\s+NULL\s+THEN[\s\S]*?RAISE\s+EXCEPTION/i,
      "the RAISE must be guarded by the failure condition",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A CONTRIBUTION EXPIRES
// ─────────────────────────────────────────────────────────────────────────────
const BUCKET = Date.parse("2026-09-06T12:00:00.000Z"); // already grid-aligned
const NOW = BUCKET + PERIOD_MS + 20 * 60_000; // bucket closed, past the 10-min delay

function input(over: Partial<SensingContributionInput> = {}): SensingContributionInput {
  return {
    secret: SECRET_A,
    cohortKey: "zone-danang-01",
    signalKind: "crowd_density" as const,
    signalBand: "high" as const,
    atMs: BUCKET,
    nowMs: NOW,
    ...over,
  };
}

describe("sensing contribution — TTL", () => {
  it("the schema itself caps the lifetime at 72 hours from the bucket", () => {
    const sql = stripSqlComments(migrationSql());
    assert.match(
      sql,
      /expires_at\s*<=\s*bucket_start\s*\+\s*interval\s*'72 hours'/i,
      "the ceiling must be a CHECK, not a convention",
    );
    assert.match(sql, /expires_at\s*>\s*bucket_start/i, "a row must outlive its own bucket start");
  });

  it("refuses a TTL past the ceiling instead of silently clamping it", () => {
    const r = buildSensingContributionRow(input({ ttlSeconds: SENSING_MAX_TTL_SECONDS + 1 }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "invalid_ttl");
  });

  it("accepts a TTL at exactly the ceiling", () => {
    const r = buildSensingContributionRow(input({ ttlSeconds: SENSING_MAX_TTL_SECONDS }));
    assert.equal(r.ok, true);
  });

  it("refuses a row that would be born expired", () => {
    // A bucket 30 hours old with a 24-hour TTL: already dead on arrival.
    const r = buildSensingContributionRow(
      input({ atMs: NOW - 30 * 60 * 60 * 1000, ttlSeconds: 24 * 60 * 60 }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "already_expired");
  });

  it("an expired contribution does not reach the aggregate, and drops the cohort below k", () => {
    const rows = cohort({ actors: PRIVACY_THRESHOLD_V1.minUniqueActors, groups: 5 });
    // Expire enough that the survivors fall one below the actor threshold.
    const expired = rows.slice(0, 1).map((r) => ({ ...r, expires_at: new Date(NOW - 1).toISOString() }));
    const mixed = [...expired, ...rows.slice(1)];

    const before = aggregateSensingCohort(rows, { bucketStartMs: BUCKET, nowMs: NOW });
    assert.equal(before.decision.publishable, true, "control: the full cohort publishes");

    const after = aggregateSensingCohort(mixed, { bucketStartMs: BUCKET, nowMs: NOW });
    assert.equal(after.contributions, rows.length - 1, "the expired row is not counted");
    assert.equal(after.distinctActors, PRIVACY_THRESHOLD_V1.minUniqueActors - 1);
    assert.equal(after.decision.publishable, false);
    assert.equal(after.decision.reason, "below_actor_threshold");
  });

  it("the reader filters expiry at the database too, not only in memory", async () => {
    const db = makeDb();
    await readSensingCohort(db, { cohortKey: "z1", bucketStartMs: BUCKET, nowMs: NOW });
    const q = db._queries.at(-1)!;
    assert.equal(q.table, SENSING_TABLE);
    assert.equal(q.filters["gt:expires_at"], new Date(NOW).toISOString());
    assert.equal(q.filters["eq:cohort_key"], "z1");
    assert.equal(q.filters["eq:bucket_start"], new Date(BUCKET).toISOString());
    assert.ok(!q.select!.includes("revocation_tag"), "the aggregation never reads the revocation handle");
  });

  it("the purge deletes by expiry and by nothing else", async () => {
    const db = makeDb();
    await purgeExpiredSensingContributions(db, NOW);
    const q = db._queries.at(-1)!;
    assert.equal(q.op, "delete");
    assert.deepEqual(Object.keys(q.filters), ["lte:expires_at"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. REVOCATION WITHOUT AN IDENTITY
// ─────────────────────────────────────────────────────────────────────────────
describe("sensing contribution — revocation carries no identity", () => {
  it("the stored handles are one-way digests, and the secret is not one of them", () => {
    const rot = deriveSensingRotationId(SECRET_A, BUCKET, "z1");
    const tag = deriveSensingRevocationTag(SECRET_A, BUCKET);
    assert.ok(isSensingDigest(rot) && isSensingDigest(tag));
    assert.notEqual(rot, tag, "the two contexts must not collide");
    assert.ok(!rot.includes(SECRET_A) && !tag.includes(SECRET_A));
  });

  it("the pseudonym rotates: same holder, next bucket ⇒ a different id", () => {
    assert.notEqual(
      deriveSensingRotationId(SECRET_A, BUCKET, "z1"),
      deriveSensingRotationId(SECRET_A, BUCKET + PERIOD_MS, "z1"),
    );
  });

  it("the pseudonym does not link cohorts: same holder, same bucket, two cohorts ⇒ different ids", () => {
    assert.notEqual(
      deriveSensingRotationId(SECRET_A, BUCKET, "z1"),
      deriveSensingRotationId(SECRET_A, BUCKET, "z2"),
    );
  });

  it("the pseudonym is stable WITHIN a bucket — one person is one actor, never many", () => {
    // The direction that matters: a pseudonym rotating faster than the
    // aggregation window would inflate distinctActors and weaken the gate.
    assert.equal(sensingBucketStartMs(BUCKET), BUCKET, "the fixture bucket is grid-aligned");
    const a = deriveSensingRotationId(SECRET_A, BUCKET, "z1");
    const b = deriveSensingRotationId(SECRET_A, BUCKET + PERIOD_MS - 1, "z1");
    assert.equal(a, b, "any instant inside the bucket derives the same pseudonym");
  });

  it("rotates on EXACTLY the privacy gate's aggregation clock", () => {
    assert.equal(SENSING_ROTATION_PERIOD_MINUTES, PRIVACY_THRESHOLD_V1.timeBucketMinutes);
  });

  it("revokes one holder's rows across every live bucket, and leaves the other holder's", async () => {
    const db = makeDb();
    // Three buckets, two holders, same cohort.
    for (const back of [0, 1, 2]) {
      const at = BUCKET - back * PERIOD_MS;
      for (const secret of [SECRET_A, SECRET_B]) {
        const w = await writeSensingContribution(db, input({ secret, atMs: at, nowMs: NOW }));
        assert.equal(w.ok, true, `write must succeed for bucket -${back}`);
      }
    }
    assert.equal(db._rows.length, 6);

    const r = await revokeSensingContributions(db, { secret: SECRET_A, nowMs: NOW });
    assert.equal(r.ok, true);
    assert.ok(r.bucketsCovered >= 3, "the sweep must span at least the buckets that were written");

    assert.equal(db._rows.length, 3, "exactly holder A's three rows are gone");
    const survivingTags = new Set(db._rows.map((row: any) => row.revocation_tag));
    for (const back of [0, 1, 2]) {
      const at = BUCKET - back * PERIOD_MS;
      assert.ok(!survivingTags.has(deriveSensingRevocationTag(SECRET_A, at)), "A's tag is gone");
      assert.ok(survivingTags.has(deriveSensingRevocationTag(SECRET_B, at)), "B's tag survives");
    }
  });

  it("the revocation query names no identity — only the revocation tag", async () => {
    const db = makeDb();
    await revokeSensingContributions(db, { secret: SECRET_A, nowMs: NOW });
    const q = db._queries.at(-1)!;
    assert.equal(q.op, "delete");
    assert.deepEqual(Object.keys(q.filters), ["in:revocation_tag"]);
    const serialized = JSON.stringify(q);
    assert.ok(!serialized.includes(SECRET_A), "the holder's secret never reaches the database");
    for (const col of USER_IDENTIFYING_COLUMNS) {
      assert.ok(!serialized.includes(col), `no ${col} may appear in a revocation`);
    }
  });

  it("the sweep is bounded by the TTL ceiling — that bound is what makes it possible", () => {
    const buckets = liveSensingBucketStarts(NOW);
    const maxBuckets = SENSING_MAX_TTL_SECONDS / (SENSING_ROTATION_PERIOD_MINUTES * 60) + 1;
    assert.ok(buckets.length <= maxBuckets, `at most ${maxBuckets} buckets, got ${buckets.length}`);
    assert.ok(buckets.length > 1);
    const oldest = buckets.at(-1)!;
    assert.ok(oldest > NOW - SENSING_MAX_TTL_SECONDS * 1000, "no bucket older than the ceiling");
  });

  it("refuses a low-entropy secret rather than revoking on a guessable one", async () => {
    const db = makeDb();
    const r = await revokeSensingContributions(db, { secret: "short", nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(db._queries.length, 0, "no query is issued at all");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE AGGREGATION REFUSES TO PUBLISH BELOW THE EXISTING THRESHOLD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A synthetic cohort: `actors` distinct pseudonyms spread evenly over `groups`
 * attested crew tokens (0 ⇒ every contribution is unattested, the normal
 * anonymous case).
 */
function cohort(opts: { actors: number; groups: number; band?: "low" | "moderate" | "high" }): SensingCohortRow[] {
  const rows: SensingCohortRow[] = [];
  for (let i = 0; i < opts.actors; i++) {
    const groupKey =
      opts.groups > 0
        ? deriveSensingGroupKey("zone-danang-01", BUCKET, { kind: "crew", crewId: `trip-${i % opts.groups}` })
        : null;
    rows.push({
      rotation_id: deriveSensingRotationId(`holder-secret-${i}-padding-0123456789`, BUCKET, "zone-danang-01"),
      group_key: groupKey,
      signal_kind: "crowd_density",
      signal_band: opts.band ?? "high",
      expires_at: new Date(NOW + 60 * 60_000).toISOString(),
    });
  }
  return rows;
}

describe("sensing aggregation — routed through the existing privacy gate", () => {
  it("publishes at exactly the existing thresholds", () => {
    const a = aggregateSensingCohort(
      cohort({ actors: PRIVACY_THRESHOLD_V1.minUniqueActors, groups: PRIVACY_THRESHOLD_V1.minIndependentGroups }),
      { bucketStartMs: BUCKET, nowMs: NOW },
    );
    assert.equal(a.distinctActors, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(a.distinctGroups, PRIVACY_THRESHOLD_V1.minIndependentGroups);
    assert.deepEqual(a.decision, { publishable: true, reason: null });
    assert.ok(a.published, "a publishable aggregate carries its payload");
  });

  it("refuses one actor below the threshold, with the gate's own reason", () => {
    const a = aggregateSensingCohort(
      cohort({ actors: PRIVACY_THRESHOLD_V1.minUniqueActors - 1, groups: PRIVACY_THRESHOLD_V1.minIndependentGroups }),
      { bucketStartMs: BUCKET, nowMs: NOW },
    );
    assert.equal(a.decision.publishable, false);
    assert.equal(a.decision.reason, "below_actor_threshold");
  });

  it("a suppressed aggregate returns NO payload, not a payload with a false flag", () => {
    const a = aggregateSensingCohort(cohort({ actors: 2, groups: 2 }), {
      bucketStartMs: BUCKET,
      nowMs: NOW,
    });
    assert.equal(a.decision.publishable, false);
    assert.equal(a.published, null);
    assert.ok(!JSON.stringify(a).includes('"bands"'), "the bands never leave the module when suppressed");
  });

  it("never INFERS a group from a separate pseudonym — 100 anonymous actors still cannot publish", () => {
    // The anonymous case, and the one most likely to be 'fixed' wrongly later.
    // lib/intelGroupKey's ruling: an unattested contribution earns zero group
    // credit. So an all-anonymous cohort fails the group clause at any size.
    const a = aggregateSensingCohort(cohort({ actors: 100, groups: 0 }), {
      bucketStartMs: BUCKET,
      nowMs: NOW,
    });
    assert.equal(a.distinctActors, 100);
    assert.equal(a.distinctGroups, 0);
    assert.equal(a.decision.publishable, false);
    assert.equal(a.decision.reason, "below_group_threshold");
    assert.equal(a.published, null);
  });

  it("suppresses when one group dominates the cohort", () => {
    const rows = cohort({ actors: 40, groups: PRIVACY_THRESHOLD_V1.minIndependentGroups });
    // Re-point most of the cohort at a single crew so its share breaches 20%.
    const dominant = deriveSensingGroupKey("zone-danang-01", BUCKET, { kind: "crew", crewId: "trip-0" });
    const skewed = rows.map((r, i) => (i < 30 ? { ...r, group_key: dominant } : r));
    const a = aggregateSensingCohort(skewed, { bucketStartMs: BUCKET, nowMs: NOW });
    assert.ok(a.maxGroupShare > PRIVACY_THRESHOLD_V1.maxSingleGroupShare);
    assert.equal(a.decision.publishable, false);
    assert.equal(a.decision.reason, "single_group_dominates");
  });

  it("respects the publication delay — an aggregate published the instant its bucket closes is a live tracker", () => {
    const a = aggregateSensingCohort(
      cohort({ actors: 20, groups: PRIVACY_THRESHOLD_V1.minIndependentGroups }),
      { bucketStartMs: BUCKET, nowMs: BUCKET + PERIOD_MS + 60_000 }, // 1 min after close
    );
    assert.equal(a.decision.publishable, false);
    assert.equal(a.decision.reason, "publication_delay_not_elapsed");
  });

  it("uses the gate rather than a private copy of the numbers — a stricter threshold changes the verdict", () => {
    // If the thresholds were reimplemented here, an injected threshold would be
    // ignored and this cohort would still publish.
    const rows = cohort({ actors: PRIVACY_THRESHOLD_V1.minUniqueActors, groups: PRIVACY_THRESHOLD_V1.minIndependentGroups });
    const strict = { ...PRIVACY_THRESHOLD_V1, minUniqueActors: PRIVACY_THRESHOLD_V1.minUniqueActors + 1 };
    const a = aggregateSensingCohort(rows, { bucketStartMs: BUCKET, nowMs: NOW, threshold: strict });
    assert.equal(a.decision.publishable, false);
    assert.equal(a.decision.reason, "below_actor_threshold");
  });

  it("refuses a sensitive subject regardless of cohort size (the gate's absolute clause)", () => {
    const a = aggregateSensingCohort(cohort({ actors: 500, groups: 50 }), {
      bucketStartMs: BUCKET,
      nowMs: NOW,
      sensitiveSubject: true,
    });
    assert.equal(a.decision.reason, "sensitive_subject");
    assert.equal(a.published, null);
  });

  it("counts PEOPLE, not contributions — a cohort that would publish on ROW count is still suppressed", () => {
    // The discriminating shape, and the reason a smaller one is not enough: five
    // people in five independent parties, each contributing four times. TWENTY
    // contributions is past the fifteen-actor threshold; FIVE people is far
    // below it. A gate handed the row count publishes this — which is exactly
    // the defect lib/privacyGate.ts records for CompassGraphEngine, where three
    // stamps from one traveller read as "3 observations".
    const people = cohort({ actors: 5, groups: 5 });
    const repeated = people.flatMap((r) => Array.from({ length: 4 }, () => r));
    const a = aggregateSensingCohort(repeated, { bucketStartMs: BUCKET, nowMs: NOW });
    assert.equal(a.contributions, 20);
    assert.ok(
      a.contributions > PRIVACY_THRESHOLD_V1.minUniqueActors,
      "the fixture must be one that a row-counting gate WOULD publish, or it proves nothing",
    );
    assert.equal(a.distinctActors, 5);
    assert.equal(a.decision.publishable, false);
    assert.equal(a.decision.reason, "below_actor_threshold");
  });

  it("ten rows from one holder are one actor", () => {
    const one = cohort({ actors: 1, groups: 1 });
    const repeated = Array.from({ length: 10 }, () => one[0]!);
    const a = aggregateSensingCohort(repeated, { bucketStartMs: BUCKET, nowMs: NOW });
    assert.equal(a.contributions, 10);
    assert.equal(a.distinctActors, 1);
    assert.equal(a.decision.publishable, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INERT BY CONSTRUCTION
// ─────────────────────────────────────────────────────────────────────────────
describe("sensing store — wired into nothing", () => {
  function tsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...tsFilesUnder(p));
      else if (entry.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  it("no route, scheduler or other module imports it — only this test does", () => {
    const importers = tsFilesUnder(resolve(API_ROOT, "src"))
      .filter((f) => !f.endsWith("sensingAnonStore.ts") && !f.endsWith("sensingAnonStore.test.ts"))
      .filter((f) => /from\s+["'][^"']*sensingAnonStore(\.js)?["']/.test(readFileSync(f, "utf8")));
    assert.deepEqual(
      importers.map((f) => f.slice(API_ROOT.length + 1)),
      [],
      "this is a foundation: it must be reachable from no live path until a capture unit is separately ruled on",
    );
  });

  it("seeds no feature flag — the rollout control is the absence of a writer", () => {
    const sql = stripSqlComments(migrationSql());
    assert.ok(!/feature_flags/i.test(sql), "no flag: a privacy store with an off switch invites the switch");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The write path, for completeness of the contract.
// ─────────────────────────────────────────────────────────────────────────────
describe("sensing contribution — the writer", () => {
  it("writes exactly the declared columns, and no identity among them", async () => {
    const db = makeDb();
    const r = await writeSensingContribution(db, input());
    assert.equal(r.ok, true);
    const row = db._rows[0]!;
    assert.deepEqual(
      Object.keys(row).sort(),
      ["bucket_start", "cohort_key", "expires_at", "group_key", "revocation_tag", "rotation_id", "signal_band", "signal_kind"],
    );
    for (const col of USER_IDENTIFYING_COLUMNS) {
      assert.ok(!(col in row), `${col} must never be written`);
    }
    // The row's own columns must be a subset of the migration's declared columns.
    const declared = new Set(declaredColumns(migrationSql()));
    for (const key of Object.keys(row)) {
      assert.ok(declared.has(key), `${key} is written but not declared by migration 2315`);
    }
  });

  it("an anonymous contribution has no group key by default", async () => {
    const db = makeDb();
    await writeSensingContribution(db, input());
    assert.equal(db._rows[0]!.group_key, null);
  });

  it("reports a failed write rather than reporting success", async () => {
    const db = makeDb({ failWrites: true });
    const r = await writeSensingContribution(db, input());
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "write_failed");
  });

  it("refuses a band outside the stored vocabulary", () => {
    const r = buildSensingContributionRow(input({ signalBand: "extreme" as any }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "invalid_signal_band");
  });

  it("its band vocabulary matches the migration's CHECK exactly", () => {
    const sql = stripSqlComments(migrationSql());
    const m = /signal_band[\s\S]*?IN\s*\(([^)]*)\)/i.exec(sql);
    assert.ok(m, "the migration must constrain signal_band");
    const inSql = m![1]!.split(",").map((s) => s.trim().replace(/'/g, "")).sort();
    assert.deepEqual(inSql, [...SENSING_SIGNAL_BANDS].sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// In-memory PostgREST stand-in. Records every query so the tests can assert what
// was asked of the database, not only what came back.
// ─────────────────────────────────────────────────────────────────────────────
interface RecordedQuery {
  table: string;
  op: "select" | "insert" | "delete";
  select?: string;
  filters: Record<string, any>;
}

function makeDb(cfg: { failWrites?: boolean } = {}) {
  const rows: any[] = [];
  const queries: RecordedQuery[] = [];

  function from(table: string) {
    const q: RecordedQuery = { table, op: "select", filters: {} };
    let recorded = false;
    const record = () => {
      if (!recorded) {
        queries.push(q);
        recorded = true;
      }
    };
    const b: any = {
      select(cols: string) { q.select = cols; return b; },
      insert(payload: any) { q.op = "insert"; (q as any).payload = payload; return b; },
      delete() { q.op = "delete"; return b; },
      eq(k: string, v: any) { q.filters[`eq:${k}`] = v; return b; },
      gt(k: string, v: any) { q.filters[`gt:${k}`] = v; return b; },
      lte(k: string, v: any) { q.filters[`lte:${k}`] = v; return b; },
      in(k: string, v: any) { q.filters[`in:${k}`] = v; return b; },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };

    function matches(row: any): boolean {
      for (const [k, v] of Object.entries(q.filters)) {
        const [op, col] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
        if (op === "eq" && row[col] !== v) return false;
        if (op === "gt" && !(String(row[col]) > String(v))) return false;
        if (op === "lte" && !(String(row[col]) <= String(v))) return false;
        if (op === "in" && !(v as any[]).includes(row[col])) return false;
      }
      return true;
    }

    function run() {
      record();
      if (q.op === "insert") {
        if (cfg.failWrites) return { data: null, error: { message: "forced write failure" } };
        const payload = (q as any).payload;
        for (const r of Array.isArray(payload) ? payload : [payload]) rows.push({ ...r });
        return { data: null, error: null };
      }
      if (q.op === "delete") {
        for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i])) rows.splice(i, 1);
        return { data: null, error: null };
      }
      return { data: rows.filter(matches), error: null };
    }
    return b;
  }

  return { from, _rows: rows, _queries: queries };
}
