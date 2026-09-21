/**
 * Sensing §3 / §4.3 / §4.4 — the anonymous contribution store (2315), its
 * replay key and time bounds (2340) and its contribution sessions (2480),
 * EXECUTED on a real database rather than read as text (census-sensing §1).
 *
 * The unit suites read the SQL and drive the TypeScript bindings against a
 * fake client. Nothing had ever INSERTed a row, hit the replay index, tripped
 * the time-bounds CHECK, called revoke_sensing_contributions or
 * sensing_session_consume, or aggregated rows a database handed back. This
 * suite does exactly that, as the roles the grants name:
 *
 *   the store holds no FK and no identity column, and a user role cannot read
 *   it; service_role writes and cannot UPDATE (2340's revoke); a row past 72 h
 *   is unrepresentable; a replay is a unique violation on exactly the replay
 *   index; a future or ancient bucket is a check violation; one device in two
 *   epochs is two unrelated tokens and revoking one epoch's secret removes
 *   that epoch only; the purge takes its instant; the aggregate over rows the
 *   database returned clears the real privacy gate at k and not below it, and
 *   the presence state built from it is OBSERVED there and UNKNOWN below;
 *   the differencing rule and the revocation model hold over real reads; a
 *   session's budget is consumed atomically in SQL and refused at zero,
 *   expired, revoked and unknown are told apart, and the bearer is stored
 *   nowhere.
 *
 * What this suite does NOT claim: that anything reaches the store. No route
 * writes it (the tripwire in src/test/sensingAnonStore.test.ts forbids one
 * until SENSING_AUTH_POSTURE is decided) and no surface reads an aggregate.
 * Every property here is a property of the schema and the pure bindings.
 *
 * The replica this runs on carries 2481 (the harness replays every file), so a
 * session row must name an issuing profile here; portava-ci carries neither
 * 2480 nor 2481. That is the harness's state, not a posture decision.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { HAVE_DB, deleteUser, exec, psql, rows, scalar, seedUser } from "./localDb.ts";
import {
  SENSING_TABLE,
  buildSensingContributionRow,
  deriveContributorToken,
  deriveEpochSecret,
  deriveGroupToken,
  deriveSensingCredentialHash,
  revocationCommitment,
  revocationTargetToken,
  rotationEpochFor,
  sensingCohortKey,
  sensingTimeBucket,
  type SensingContributionRow,
} from "../../lib/sensingAnonStore.js";
import { aggregateSensingCohort } from "../../lib/sensingCoverageAggregate.js";
import { buildSensingPresenceState } from "../../lib/sensingPresenceState.js";
import { evaluateDifferencing } from "../../lib/sensingDifferencingGate.js";
import { modelSensingRevocation } from "../../lib/sensingRevocationLineage.js";
import {
  buildSensingSessionRow,
  generateSensingCredential,
  type SensingContributionSessionRow,
} from "../../lib/sensingContributionSession.js";
import { PRIVACY_THRESHOLD_V1 } from "../../lib/intelContracts.js";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

/** A dedicated pepper for the derivations; never a real secret. */
const PEPPER = "sensing-db-suite-pepper-" + "p".repeat(24);
const ZONE_PREFIX = "dbsuite-";
const SESSIONS = "sensing_contribution_sessions";

const svc = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const svcTry = (sql: string) => psql(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
const asAuthenticated = (sql: string) => psql(`SET LOCAL ROLE authenticated;\n${sql}`, { single: true });

function insertSql(row: SensingContributionRow, over: Partial<SensingContributionRow> = {}): string {
  const r = { ...row, ...over };
  const g = r.group_token === null || r.group_token === undefined ? "NULL" : `'${r.group_token}'`;
  return (
    `INSERT INTO public.${SENSING_TABLE} ` +
    `(contributor_token, rotation_epoch, group_token, zone_id, time_bucket, cohort_key, signal_bucket, reduction_version, created_at, expires_at) VALUES (` +
    `'${r.contributor_token}', ${r.rotation_epoch}, ${g}, '${r.zone_id}', '${r.time_bucket}', '${r.cohort_key}', ${r.signal_bucket}, ${r.reduction_version}, '${r.created_at}', '${r.expires_at}');`
  );
}

/** One device's contribution for `observedAtMs`, built as the store builds it. */
function contribution(deviceSecret: string, zone: string, observedAtMs: number, nowMs: number, groupTag: string | null = null, bucket = 2): SensingContributionRow {
  const epoch = rotationEpochFor(observedAtMs);
  const built = buildSensingContributionRow(
    { commitment: revocationCommitment(deriveEpochSecret(deviceSecret, epoch)), rotationEpoch: epoch, zoneId: zone, observedAtMs, signalBucket: bucket, groupTag },
    nowMs,
  );
  assert.equal(built.ok, true, JSON.stringify(built));
  return (built as { ok: true; row: SensingContributionRow }).row;
}

/** Read one cohort back the way the aggregate expects it, timestamps as ISO. */
function readCohort(cohortKey: string): SensingContributionRow[] {
  return rows<SensingContributionRow>(
    `SELECT contributor_token, rotation_epoch, group_token, zone_id,
            to_char(time_bucket AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS time_bucket,
            cohort_key, signal_bucket, reduction_version,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
       FROM public.${SENSING_TABLE} WHERE cohort_key = '${cohortKey}'`,
  );
}

describe("2315 / 2340 / 2480 — the anonymous sensing store on a real database", { skip: SKIP }, () => {
  let savedPepper: string | undefined;
  let issuer = "";
  const NOW = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();

  before(() => {
    savedPepper = process.env["SENSING_CONTRIBUTOR_PEPPER"];
    process.env["SENSING_CONTRIBUTOR_PEPPER"] = PEPPER;
    issuer = seedUser("sensing_issuer");
  });
  after(() => {
    svc(`DELETE FROM public.${SENSING_TABLE} WHERE zone_id LIKE '${ZONE_PREFIX}%';`);
    svc(`DELETE FROM public.${SESSIONS} WHERE issued_to_profile_id = '${issuer}';`);
    if (issuer) deleteUser(issuer);
    if (savedPepper === undefined) delete process.env["SENSING_CONTRIBUTOR_PEPPER"];
    else process.env["SENSING_CONTRIBUTOR_PEPPER"] = savedPepper;
  });

  // ── 2315: the structure the ruling requires, on the catalog ────────────────

  it("the store holds no foreign key at all and no identity-shaped column; RLS is on with no user policy", () => {
    assert.equal(scalar(`SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.${SENSING_TABLE}'::regclass AND contype = 'f'`), "0");
    const identityCols = scalar(
      `SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${SENSING_TABLE}' AND column_name IN ('user_id','actor_id','profile_id','account_id','auth_id','owner_id','created_by','contributor_id','device_id','session_id','installation_id','credential_hash')`,
    );
    assert.equal(identityCols, "0");
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${SENSING_TABLE}'::regclass`), "t");
    assert.equal(scalar(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '${SENSING_TABLE}' AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles))`), "0");
  });

  it("service_role writes a contribution; a user role cannot read the table; service_role cannot UPDATE a row (2340)", () => {
    const zone = `${ZONE_PREFIX}grants`;
    const row = contribution("device-grants", zone, NOW - 20 * 60_000, NOW);
    svc(insertSql(row));
    assert.equal(scalar(`SELECT count(*) FROM public.${SENSING_TABLE} WHERE zone_id = '${zone}'`), "1");

    const read = asAuthenticated(`SELECT count(*) FROM public.${SENSING_TABLE};`);
    assert.notEqual(read.status, 0, "a pseudonym plus a zone and a bucket is a presence trace; no user role reads it");
    assert.match(read.stderr, /permission denied/);

    const update = svcTry(`UPDATE public.${SENSING_TABLE} SET signal_bucket = 4 WHERE zone_id = '${zone}';`);
    assert.notEqual(update.status, 0, "a contribution is written once and then only counted, expired or revoked");
    assert.match(update.stderr, /permission denied/);
  });

  it("a row that would live longer than 72 h is unrepresentable", () => {
    const row = contribution("device-ttl", `${ZONE_PREFIX}ttl`, NOW - 20 * 60_000, NOW);
    const r = svcTry(insertSql(row, { expires_at: iso(NOW + 73 * 3600_000) }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sensing_anon_contributions_ttl_check/);
  });

  // ── 2340: replay and time bounds, on the constraint ────────────────────────

  it("a replay of the same (cohort, contributor) is a unique violation on exactly the replay index — the second row never exists", () => {
    const zone = `${ZONE_PREFIX}replay`;
    const row = contribution("device-replay", zone, NOW - 20 * 60_000, NOW);
    svc(insertSql(row));
    const again = svcTry(insertSql(row, { signal_bucket: 4, created_at: iso(NOW + 1000) }));
    assert.notEqual(again.status, 0, "a second row under the replay key would let one device read as two");
    assert.match(again.stderr, /duplicate key value violates unique constraint "sensing_anon_contributions_replay_idx"/);
    assert.equal(scalar(`SELECT count(*) FROM public.${SENSING_TABLE} WHERE zone_id = '${zone}'`), "1");
  });

  it("forty writes from one device into one cohort are one row, and the aggregate over what the database holds is one contributor — below k", () => {
    const zone = `${ZONE_PREFIX}onedevice`;
    const row = contribution("device-prolific", zone, NOW - 20 * 60_000, NOW);
    let refused = 0;
    for (let i = 0; i < 40; i++) {
      const r = svcTry(insertSql(row, { signal_bucket: i % 5 }));
      if (r.status !== 0) refused += 1;
    }
    assert.equal(refused, 39);
    const agg = aggregateSensingCohort({ ok: true, complete: true, rows: readCohort(row.cohort_key) }, { nowMs: NOW });
    assert.equal(agg.distinctActors, 1);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_actor_threshold");
  });

  it("a bucket in the future or past the 72 h ceiling is a check violation; the edge of the window is accepted", () => {
    const zone = `${ZONE_PREFIX}bounds`;
    const row = contribution("device-bounds", zone, NOW - 20 * 60_000, NOW);
    const future = svcTry(insertSql(row, { time_bucket: iso(NOW + 2 * 60_000), created_at: iso(NOW) }));
    assert.notEqual(future.status, 0);
    assert.match(future.stderr, /sensing_anon_contributions_time_bounds_check/);
    const ancient = svcTry(insertSql(row, { time_bucket: iso(NOW - 73 * 3600_000), created_at: iso(NOW) }));
    assert.notEqual(ancient.status, 0);
    assert.match(ancient.stderr, /sensing_anon_contributions_time_bounds_check/);
    // Inside the window — 72 h less a minute — is a legitimate late arrival.
    const edge = svcTry(insertSql(row, { time_bucket: iso(NOW - 72 * 3600_000 + 60_000), created_at: iso(NOW), cohort_key: `${row.cohort_key}|edge` }));
    assert.equal(edge.status, 0, edge.stderr);
  });

  // ── rotating ids and identity-free revocation, executed ────────────────────

  it("one device in two epochs is two unrelated tokens, and revealing one epoch's secret revokes that epoch only", () => {
    const zone = `${ZONE_PREFIX}rotation`;
    const secret = "device-rotation-secret-that-never-leaves-the-device";
    const earlier = contribution(secret, zone, NOW - 2 * 3600_000, NOW);
    const later = contribution(secret, zone, NOW - 1 * 3600_000, NOW);
    assert.notEqual(earlier.rotation_epoch, later.rotation_epoch);
    assert.notEqual(earlier.contributor_token, later.contributor_token, "a token stable across epochs is a tracking id");
    // Two layers fold the epoch, and each is pinned on its own: the DEVICE
    // derives a fresh secret per epoch, and the SERVER folds the epoch into
    // the token, so one commitment presented under two epochs is two tokens.
    assert.notEqual(deriveEpochSecret(secret, earlier.rotation_epoch), deriveEpochSecret(secret, later.rotation_epoch));
    const oneCommitment = revocationCommitment(deriveEpochSecret(secret, earlier.rotation_epoch));
    assert.notEqual(deriveContributorToken(earlier.rotation_epoch, oneCommitment), deriveContributorToken(later.rotation_epoch, oneCommitment));
    svc(insertSql(earlier) + "\n" + insertSql(later));
    assert.equal(scalar(`SELECT count(*) FROM public.${SENSING_TABLE} WHERE zone_id = '${zone}'`), "2");

    // The device reveals the EARLIER epoch's secret. The server re-derives the
    // token and calls the function with (epoch, token) — nothing else exists to pass.
    const revocation = { rotationEpoch: earlier.rotation_epoch, epochSecret: deriveEpochSecret(secret, earlier.rotation_epoch) };
    const target = revocationTargetToken(revocation);
    assert.equal(target, earlier.contributor_token, "the preimage re-derives exactly the stored token");
    const revoked = svc(`SELECT public.revoke_sensing_contributions(${earlier.rotation_epoch}, '${target}');`);
    assert.equal(revoked[revoked.length - 1], "1");
    const left = rows<{ rotation_epoch: number }>(`SELECT rotation_epoch FROM public.${SENSING_TABLE} WHERE zone_id = '${zone}'`);
    assert.deepEqual(left.map((r) => Number(r.rotation_epoch)), [later.rotation_epoch], "the other epoch's row survives");

    // The stored token alone is not a credential: replaying the revocation
    // against the LATER epoch with the earlier token removes nothing.
    const wrongEpoch = svc(`SELECT public.revoke_sensing_contributions(${later.rotation_epoch}, '${target}');`);
    assert.equal(wrongEpoch[wrongEpoch.length - 1], "0");
  });

  it("the revocation and purge functions are service_role only", () => {
    const r = asAuthenticated(`SELECT public.revoke_sensing_contributions(1, 'x');`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied for function revoke_sensing_contributions/);
    const p = asAuthenticated(`SELECT public.purge_expired_sensing_contributions(now());`);
    assert.notEqual(p.status, 0);
    assert.match(p.stderr, /permission denied for function purge_expired_sensing_contributions/);
  });

  it("the purge takes its instant: an expired row goes, a live one stays, and a second pass deletes nothing", () => {
    const zone = `${ZONE_PREFIX}purge`;
    const live = contribution("device-purge-live", zone, NOW - 20 * 60_000, NOW);
    const gone = contribution("device-purge-gone", zone, NOW - 20 * 60_000, NOW);
    svc(insertSql(live) + "\n" + insertSql(gone, { created_at: iso(NOW - 30 * 3600_000), expires_at: iso(NOW - 6 * 3600_000), time_bucket: sensingTimeBucket(NOW - 30 * 3600_000), cohort_key: `${gone.cohort_key}|old` }));
    const first = svc(`SELECT public.purge_expired_sensing_contributions('${iso(NOW)}');`);
    assert.equal(first[first.length - 1], "1");
    assert.equal(scalar(`SELECT count(*) FROM public.${SENSING_TABLE} WHERE zone_id = '${zone}'`), "1");
    const second = svc(`SELECT public.purge_expired_sensing_contributions('${iso(NOW)}');`);
    assert.equal(second[second.length - 1], "0");
  });

  // ── the aggregate over rows the database returned ──────────────────────────

  it("k independent contributors read back from the database clear the real privacy gate; one fewer does not; the presence state says observed / unknown accordingly", () => {
    const zone = `${ZONE_PREFIX}cohort`;
    const observedAt = NOW - 20 * 60_000;
    const writtenAt = NOW - 15 * 60_000; // past the 10-minute publication delay
    const k = PRIVACY_THRESHOLD_V1.minUniqueActors;
    const groups = PRIVACY_THRESHOLD_V1.minIndependentGroups + 1; // share 3/18 < 0.2
    const perGroup = 3;
    const total = groups * perGroup; // 18 ≥ k
    assert.ok(total >= k);
    const built: SensingContributionRow[] = [];
    for (let i = 0; i < total; i++) {
      built.push(contribution(`device-cohort-${i}`, zone, observedAt, writtenAt, `party-${i % groups}`, i % 5));
    }
    const cohortKey = built[0]!.cohort_key;
    // All but one, first: one short of k must be UNKNOWN, not a smaller number.
    svc(built.slice(0, k - 1).map((r) => insertSql(r)).join("\n"));
    const under = aggregateSensingCohort({ ok: true, complete: true, rows: readCohort(cohortKey) }, { nowMs: NOW });
    assert.equal(under.distinctActors, k - 1);
    assert.equal(under.publishable, false);
    assert.equal(under.reason, "below_actor_threshold");
    assert.equal(under.medianSignalBucket, null, "a sub-k cohort carries no statistic, not even a coarse one");
    const unknownState = buildSensingPresenceState({ zoneId: zone, timeBucket: built[0]!.time_bucket, aggregate: under, nowMs: NOW });
    assert.equal(unknownState.presence, "unknown");
    assert.equal(unknownState.activityOrdinal, null);
    assert.equal(unknownState.coverage, "unknown");

    // The rest of the cohort arrives.
    svc(built.slice(k - 1).map((r) => insertSql(r)).join("\n"));
    const fromDb = readCohort(cohortKey);
    assert.equal(fromDb.length, total);
    const agg = aggregateSensingCohort({ ok: true, complete: true, rows: fromDb }, { nowMs: NOW });
    assert.equal(agg.publishable, true, JSON.stringify(agg));
    assert.equal(agg.distinctActors, total);
    assert.equal(agg.distinctGroups, groups);
    assert.ok(agg.maxGroupShare <= PRIVACY_THRESHOLD_V1.maxSingleGroupShare);
    assert.ok(Number.isInteger(agg.medianSignalBucket));

    const state = buildSensingPresenceState({ zoneId: zone, timeBucket: built[0]!.time_bucket, aggregate: agg, nowMs: NOW });
    assert.equal(state.presence, "observed");
    assert.equal(state.activityOrdinal, agg.medianSignalBucket);
    assert.equal(state.coverage, "few"); // 18 < 25: the read path's own bucket
    assert.equal(state.truthClass, "observed");
    assert.ok(["recent", "aging"].includes(state.freshness), state.freshness);
    // No person in it: nothing the database returned appears in the state.
    const json = JSON.stringify(state);
    for (const r of fromDb) {
      assert.ok(!json.includes(r.contributor_token));
      assert.ok(!r.group_token || !json.includes(r.group_token));
    }

    // §3 anti-differencing over two real reads: one more contributor is not a
    // new publication; the previous value is served.
    const extra = contribution(`device-cohort-extra`, zone, observedAt, writtenAt, `party-extra`, 1);
    svc(insertSql(extra));
    const next = aggregateSensingCohort({ ok: true, complete: true, rows: readCohort(cohortKey) }, { nowMs: NOW });
    assert.equal(next.distinctActors, total + 1);
    const diff = evaluateDifferencing(agg, next);
    assert.equal(diff.publish, false);
    assert.equal(diff.reason, "delta_below_minimum");
    assert.equal(diff.serve, agg);

    // §18.4 lineage: the in-memory revocation model predicts exactly what the
    // SQL function does to a fresh read.
    const revokedDevice = 3;
    const epoch = built[revokedDevice]!.rotation_epoch;
    const revocation = { rotationEpoch: epoch, epochSecret: deriveEpochSecret(`device-cohort-${revokedDevice}`, epoch) };
    const model = modelSensingRevocation(readCohort(cohortKey), next, revocation, NOW);
    assert.equal(model.removed, 1);
    assert.equal(model.publishedAggregateCarriedIdentity, null);
    const executed = svc(`SELECT public.revoke_sensing_contributions(${epoch}, '${revocationTargetToken(revocation)}');`);
    assert.equal(Number(executed[executed.length - 1]), model.removed);
    const after = aggregateSensingCohort({ ok: true, complete: true, rows: readCohort(cohortKey) }, { nowMs: NOW });
    assert.equal(after.distinctActors, model.after.distinctActors);
    assert.equal(after.publishable, model.after.publishable);
  });

  it("a group token is derived, never inferred: contributors with no party tag earn no group credit on the database either", () => {
    const zone = `${ZONE_PREFIX}nogroup`;
    const observedAt = NOW - 20 * 60_000;
    const built: SensingContributionRow[] = [];
    for (let i = 0; i < PRIVACY_THRESHOLD_V1.minUniqueActors; i++) built.push(contribution(`device-nogroup-${i}`, zone, observedAt, NOW - 15 * 60_000, null));
    svc(built.map((r) => insertSql(r)).join("\n"));
    assert.equal(scalar(`SELECT count(*) FROM public.${SENSING_TABLE} WHERE zone_id = '${zone}' AND group_token IS NOT NULL`), "0");
    const agg = aggregateSensingCohort({ ok: true, complete: true, rows: readCohort(built[0]!.cohort_key) }, { nowMs: NOW });
    assert.equal(agg.distinctActors, PRIVACY_THRESHOLD_V1.minUniqueActors);
    assert.equal(agg.distinctGroups, 0);
    assert.equal(agg.publishable, false);
    assert.equal(agg.reason, "below_group_threshold");
    // and the same tag under the same epoch is the same party token, server-side
    const epoch = rotationEpochFor(observedAt);
    assert.equal(deriveGroupToken(epoch, "party-x"), deriveGroupToken(epoch, "PARTY-X "));
    assert.notEqual(deriveGroupToken(epoch, "party-x"), deriveGroupToken(epoch + 1, "party-x"));
  });

  // ── 2480: sessions — the budget is consumed in SQL, the bearer stored nowhere ─

  it("a session stores only the bearer's HMAC; its budget is consumed atomically and refused at zero; unknown, expired and revoked are told apart; the purge removes both", () => {
    const credential = generateSensingCredential();
    const session = buildSensingSessionRow({ credential, issuanceClass: "authenticated_profile", nowMs: NOW, budget: 2, lifetimeSeconds: 3600 });
    assert.equal(session.ok, true);
    const row = (session as { ok: true; row: SensingContributionSessionRow }).row;
    const scopes = `ARRAY[${row.purpose_scopes.map((s) => `'${s}'`).join(",")}]::text[]`;
    svc(
      `INSERT INTO public.${SESSIONS} (credential_hash, policy_version, purpose_scopes, reduction_version, issuance_class, budget_cohorts_remaining, starts_at, expires_at, issued_to_profile_id) VALUES (` +
        `'${row.credential_hash}', ${row.policy_version}, ${scopes}, ${row.reduction_version}, '${row.issuance_class}', ${row.budget_cohorts_remaining}, '${row.starts_at}', '${row.expires_at}', '${issuer}');`,
    );
    assert.equal(row.credential_hash, deriveSensingCredentialHash(credential));
    assert.equal(scalar(`SELECT count(*) FROM public.${SESSIONS} WHERE credential_hash = '${credential}'`), "0", "the bearer is never stored");

    const consume = (hash: string, at: number) => {
      const out = svc(`SELECT public.sensing_session_consume('${hash}', '${iso(at)}');`);
      return out[out.length - 1];
    };
    assert.equal(consume(row.credential_hash, NOW + 1000), "ok");
    assert.equal(consume(row.credential_hash, NOW + 2000), "ok");
    assert.equal(consume(row.credential_hash, NOW + 3000), "budget_exhausted");
    assert.equal(scalar(`SELECT budget_cohorts_remaining FROM public.${SESSIONS} WHERE credential_hash = '${row.credential_hash}'`), "0");
    assert.equal(consume(row.credential_hash, NOW - 1000), "not_started");
    assert.equal(consume(row.credential_hash, NOW + 2 * 3600_000), "expired");
    assert.equal(consume(deriveSensingCredentialHash(generateSensingCredential()), NOW + 1000), "unknown");

    const revoked = svc(`SELECT public.revoke_sensing_session('${row.credential_hash}', '${iso(NOW + 4000)}');`);
    assert.equal(revoked[revoked.length - 1], "1");
    assert.equal(consume(row.credential_hash, NOW + 5000), "revoked");

    // UPDATE is not a path: budgets and revocation exist only through the functions.
    const direct = svcTry(`UPDATE public.${SESSIONS} SET budget_cohorts_remaining = 99 WHERE credential_hash = '${row.credential_hash}';`);
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /permission denied/);

    // A second, expired session; the purge removes the revoked one and the expired one.
    const stale = buildSensingSessionRow({ credential: generateSensingCredential(), issuanceClass: "authenticated_profile", nowMs: NOW - 2 * 3600_000, budget: 1, lifetimeSeconds: 60 });
    assert.equal(stale.ok, true);
    const staleRow = (stale as { ok: true; row: SensingContributionSessionRow }).row;
    svc(
      `INSERT INTO public.${SESSIONS} (credential_hash, policy_version, purpose_scopes, reduction_version, issuance_class, budget_cohorts_remaining, starts_at, expires_at, issued_to_profile_id) VALUES (` +
        `'${staleRow.credential_hash}', ${staleRow.policy_version}, ${scopes}, ${staleRow.reduction_version}, '${staleRow.issuance_class}', ${staleRow.budget_cohorts_remaining}, '${staleRow.starts_at}', '${staleRow.expires_at}', '${issuer}');`,
    );
    const purged = svc(`SELECT public.purge_expired_sensing_sessions('${iso(NOW + 6000)}');`);
    assert.equal(purged[purged.length - 1], "2");
    assert.equal(scalar(`SELECT count(*) FROM public.${SESSIONS} WHERE issued_to_profile_id = '${issuer}'`), "0");
  });

  it("a session row cannot name a purpose outside §3's seven verbs, cannot outlive 72 h, and the contribution store carries no session column", () => {
    const hash = deriveSensingCredentialHash(generateSensingCredential());
    const badScope = svcTry(
      `INSERT INTO public.${SESSIONS} (credential_hash, policy_version, purpose_scopes, reduction_version, issuance_class, budget_cohorts_remaining, starts_at, expires_at, issued_to_profile_id) VALUES ('${hash}', 1, ARRAY['collect','track']::text[], 1, 'authenticated_profile', 1, '${iso(NOW)}', '${iso(NOW + 3600_000)}', '${issuer}');`,
    );
    assert.notEqual(badScope.status, 0);
    assert.match(badScope.stderr, /sensing_contribution_sessions_scopes_check/);
    const tooLong = svcTry(
      `INSERT INTO public.${SESSIONS} (credential_hash, policy_version, purpose_scopes, reduction_version, issuance_class, budget_cohorts_remaining, starts_at, expires_at, issued_to_profile_id) VALUES ('${hash}', 1, ARRAY['collect']::text[], 1, 'authenticated_profile', 1, '${iso(NOW)}', '${iso(NOW + 73 * 3600_000)}', '${issuer}');`,
    );
    assert.notEqual(tooLong.status, 0);
    assert.match(tooLong.stderr, /sensing_contribution_sessions_lifetime_check/);
    assert.equal(scalar(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${SENSING_TABLE}' AND column_name IN ('session_id','credential_hash')`), "0");
    // The replica carries 2481 (the harness replays every file): an anonymous
    // session row is unrepresentable HERE. portava-ci carries neither 2480 nor
    // 2481; this records the harness's state, not a posture decision.
    const anonymous = svcTry(
      `INSERT INTO public.${SESSIONS} (credential_hash, policy_version, purpose_scopes, reduction_version, issuance_class, budget_cohorts_remaining, starts_at, expires_at) VALUES ('${hash}', 1, ARRAY['collect']::text[], 1, 'attested_device', 1, '${iso(NOW)}', '${iso(NOW + 3600_000)}');`,
    );
    assert.notEqual(anonymous.status, 0);
    assert.match(anonymous.stderr, /sensing_contribution_sessions_option_a_check/);
  });
});
