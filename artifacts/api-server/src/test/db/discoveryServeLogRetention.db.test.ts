/**
 * census-discovery §120 — the owner's 30-day TESTING retention for
 * `public.recommendations` (3501), on a REAL PostgreSQL 16 carrying the whole
 * chain (scripts/local-db/up.sh).
 *
 *   D1  an expired row is deleted and a row newer than 30 days remains — run
 *       as service_role, which holds NO DELETE on the table: the DEFINER purge is
 *       the only way in
 *   D2  the boundary, exactly: created_at = now() - 30 days is KEPT, a
 *       microsecond older is deleted, a microsecond newer is kept
 *   D3  bounded batches: p_batch_size rows at most, oldest first, `more` true
 *       until the last; outside 1..10000 is refused
 *   D4  the serve log writes rows for a SIGNED-IN serve, an ANONYMOUS serve and
 *       an EMPTY serve (DV-06, DV-40) through the real writer, and the scheduler's
 *       real tick keeps them while they are new and purges them once expired,
 *       recording the run in job_health
 *   D5  dependents stay valid: the signed-in serve's rank_events rows (with
 *       their serveId), its keyed outcome and receipt (3420), and a creator
 *       attribution naming its exposure (3386) are all untouched by the purge;
 *       the 3386 trigger still admits a NEW attribution naming the same
 *       exposure; creator_earning_entries does not move
 *   D6  the purge refuses — deleting nothing — when a foreign key appears on the
 *       table, when the retention row is absent, or when keep_days is invalid;
 *       OFF answers `disabled` and deletes nothing, and the scheduler reports
 *       that as a FAILURE
 *   D7  no client role may execute either function
 *   D8  the per-request reports: a window reaching before the horizon reads the
 *       request rows as UNOBSERVED; a window inside it reads them
 *
 * Skips without LOCAL_DB_URL, like every suite in this directory; run-tests.sh
 * refuses a skipped run.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, LOCAL_DB_URL, exec, psql, rows, scalar, seedUser, deleteUser } from "./localDb.js";
import { bridge, lit, type Bridge } from "./discoveryVerifyBridge.js";
import { logDiscoveryServe, DiscoveryServePoint, invalidateServeLogFlagCache, _resetServeRequestTableLatch } from "../../lib/discoveryServeLog.js";
import {
  runDiscoveryServeLogRetentionTick, _resetDiscoveryServeLogRetentionStatus, JOB_KEY,
} from "../../lib/discoveryServeLogRetentionScheduler.js";
import { readTraceCorpus } from "../../lib/discoveryTraceRead.js";

const FLAG = "discovery_serve_log_retention_enabled";
const RULE_VERSION = "creator-rules/discovery-creator/v3501";
const RULE_NOTE = "TEST FIXTURE (census-discovery §120 serve-log retention suite) — not a production rule; deleted after the suite";
const ROUTE = { signed: "/r3501/signed-in", anon: "/r3501/anonymous", empty: "/r3501/empty" };
/** 22-character ids in 3376's shape, unique to this suite. */
const rid = (tag: string) => `R3501${tag}`.padEnd(22, "x");

let viewer = "", creator = "";
let b: Bridge;
const ITEMS = [{ id: "db/r3501-a" }, { id: "db/r3501-b" }];

/** One psql script as service_role, in one transaction — what the API's client runs as. */
function asService(sql: string): string[] {
  return exec(`SET ROLE service_role;\n${sql}`, { single: true });
}
function purge(batch: number): { status: string; deleted: number; more: boolean | null; cutoff: string } {
  return JSON.parse(asService(`SELECT public.purge_expired_discovery_recommendations(${batch})::text;`).pop()!);
}
/** Insert a probe row with an explicit created_at (as the owner: service_role cannot set it — it has no UPDATE and the door never names it). */
function probeRow(id: string, createdAt: string): string {
  return `INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, model_version, served_count, served_at, created_at)
          VALUES ('${id}', NULL, 'anonymous', gen_random_uuid(), 'discovery', 1, 'r3501', 0, now(), ${createdAt});`;
}
function drain(): void { for (let i = 0; i < 100 && purge(10000).more; i++) { /* expired rows other suites left, if any */ } }
const present = (ids: string[]) => rows<{ id: string }>(`SELECT id FROM public.recommendations WHERE id IN (${ids.map(lit).join(",")}) ORDER BY id`).map((r) => r.id);

describe("§120 — the serve-log testing retention on a real database", { skip: !HAVE_DB }, () => {
  let flagBefore = "";

  before(() => {
    viewer = seedUser("r3501v");
    creator = seedUser("r3501c");
    flagBefore = scalar(`SELECT enabled::text || '|' || metadata::text FROM public.feature_flags WHERE flag = '${FLAG}'`) ?? "";
    // A run that died before its after() leaves the fixture behind; clear it rather than collide with it.
    // The attribution delete needs replica mode: 3510's row-level guard refuses every DELETE of a creator
    // ledger row until the owner decides C-11, so a crashed run's leftover row cannot be cleared without it.
    // Same device, same reason, as creatorLedgerErasurePolicy.db.test.ts's purgeSyntheticSql().
    exec(`SET session_replication_role = replica;
          DELETE FROM public.creator_attributions WHERE rule_version = ${lit(RULE_VERSION)};
          SET session_replication_role = origin;
          DELETE FROM public.creator_rule_versions WHERE rule_version = ${lit(RULE_VERSION)};
          INSERT INTO public.creator_rule_versions (creator_type, rule_version, params, effective_from, note) VALUES ('discovery_creator', ${lit(RULE_VERSION)}, '{}'::jsonb, now() - interval '1 second', ${lit(RULE_NOTE)});`);
    b = bridge({
      flags: {
        discovery_serve_log_enabled: { enabled: true },
        [FLAG]: { enabled: true, metadata: { keep_days: 30, retention_scope: "testing" } },
      },
      tokens: {},
    });
    drain();
  });

  after(() => {
    if (flagBefore) exec(`UPDATE public.feature_flags SET enabled = ${flagBefore.split("|")[0] === "true"}, metadata = ${lit(flagBefore.slice(flagBefore.indexOf("|") + 1))}::jsonb WHERE flag = '${FLAG}';`);
    exec(`SET session_replication_role = replica;
          DELETE FROM public.creator_attributions WHERE beneficiary_user_id = '${creator}' OR rule_version = ${lit(RULE_VERSION)};
          SET session_replication_role = origin;
          DELETE FROM public.creator_rule_versions WHERE rule_version = ${lit(RULE_VERSION)};
          DELETE FROM public.rank_event_outcome_receipts WHERE user_id = '${viewer}';
          DELETE FROM public.rank_events WHERE user_id = '${viewer}';
          DELETE FROM public.recommendations WHERE id LIKE 'R3501%' OR route LIKE '/r3501/%' OR user_id = '${viewer}';
          DELETE FROM public.job_health WHERE job = '${JOB_KEY}';`);
    deleteUser(viewer);
    deleteUser(creator);
  });

  test("D1. an expired row is deleted and a newer row remains — as service_role, which holds no DELETE", () => {
    assert.equal(scalar(`SELECT has_table_privilege('service_role', 'public.recommendations', 'DELETE')::text`), "false", "3376's append-only posture stands");
    const refused = psql(`SET ROLE service_role;\nDELETE FROM public.recommendations WHERE id = '${rid("d1old")}';`);
    assert.notEqual(refused.status, 0, "a direct DELETE is refused");
    assert.match(refused.stderr, /permission denied/);

    exec(probeRow(rid("d1old"), "now() - interval '45 days'") + probeRow(rid("d1new"), "now() - interval '29 days'") + probeRow(rid("d1now"), "now()"));
    const r = purge(10000);
    assert.equal(r.status, "purged");
    assert.equal(r.deleted, 1);
    assert.equal(r.more, false);
    assert.deepEqual(present([rid("d1old"), rid("d1new"), rid("d1now")]), [rid("d1new"), rid("d1now")].sort());
    const again = purge(10000);
    assert.equal(again.deleted, 0, "idempotent: nothing new is expired");
  });

  test("D2. the boundary: exactly 30 days is kept, a microsecond older is deleted, a microsecond newer is kept", () => {
    // ONE transaction, so now() in the inserts IS now() in the purge — the boundary is exact, not approximate.
    const out = exec(`
      ${probeRow(rid("d2older"), "now() - interval '30 days' - interval '1 microsecond'")}
      ${probeRow(rid("d2exact"), "now() - interval '30 days'")}
      ${probeRow(rid("d2newer"), "now() - interval '30 days' + interval '1 microsecond'")}
      SET LOCAL ROLE service_role;
      SELECT public.purge_expired_discovery_recommendations(10000)::text;
      SELECT (public.discovery_recommendations_retention_cutoff() = now() - interval '30 days')::text;`, { single: true });
    const r = JSON.parse(out[0]!);
    assert.equal(r.deleted, 1, "only the row older than the horizon");
    assert.equal(out[1], "true", "the horizon is now() - keep_days, exactly");
    assert.deepEqual(present([rid("d2older"), rid("d2exact"), rid("d2newer")]), [rid("d2exact"), rid("d2newer")].sort());
  });

  test("D3. bounded batches: at most p_batch_size, oldest first, `more` until the last; outside 1..10000 is refused", () => {
    drain();   // D2's boundary rows are now a few seconds past the horizon themselves
    const ids = [1, 2, 3, 4, 5].map((i) => rid(`d3n${i}`));
    exec(ids.map((id, i) => probeRow(id, `now() - interval '40 days' - interval '${5 - i} minutes'`)).join("\n"));
    const first = purge(2);
    assert.deepEqual([first.deleted, first.more], [2, true]);
    assert.deepEqual(present(ids), ids.slice(2), "the two OLDEST went first");
    const second = purge(2);
    assert.deepEqual([second.deleted, second.more], [2, true]);
    const last = purge(2);
    assert.deepEqual([last.deleted, last.more], [1, false]);
    assert.deepEqual(present(ids), []);
    for (const bad of [0, -1, 10001]) {
      const r = psql(`SET ROLE service_role;\nSELECT public.purge_expired_discovery_recommendations(${bad});`);
      assert.notEqual(r.status, 0, `batch ${bad} refused`);
      assert.match(r.stderr, /p_batch_size must be 1\.\.10000/);
    }
  });

  test("D4+D5. signed-in, anonymous and empty serves are logged; the real tick keeps them while new, purges them once expired — and every dependent stays valid", async () => {
    invalidateServeLogFlagCache();
    _resetServeRequestTableLatch();
    const sessionId = randomUUID();
    const servedAt = new Date().toISOString();
    await logDiscoveryServe(b.client, { userId: viewer, servePoint: DiscoveryServePoint.CACHE_A_L1, items: ITEMS, route: ROUTE.signed, sessionId, servedAt });
    await logDiscoveryServe(b.client, { userId: "", servePoint: DiscoveryServePoint.COMMUNITY, items: ITEMS, route: ROUTE.anon, servedAt });
    await logDiscoveryServe(b.client, { userId: viewer, servePoint: DiscoveryServePoint.FEED, items: [], route: ROUTE.empty, servedAt });
    assert.deepEqual(b.unmodelled, [], "nothing on the writer's path went unmodelled");
    assert.deepEqual(b.failed, [], "the database refused nothing the writer sent");

    const reqs = () => rows<{ route: string; viewer_class: string; served_count: number; user_id: string | null; id: string }>(
      `SELECT route, viewer_class, served_count, user_id, id FROM public.recommendations WHERE route LIKE '/r3501/%' ORDER BY route`);
    const logged = reqs();
    assert.deepEqual(logged.map((r) => [r.route, r.viewer_class, r.served_count, r.user_id === null]), [
      [ROUTE.anon, "anonymous", 2, true],
      [ROUTE.empty, "signed_in", 0, false],
      [ROUTE.signed, "signed_in", 2, false],
    ], "DV-06 / DV-40: one request row each — anonymous and empty included");
    const signedServeId = logged.find((r) => r.route === ROUTE.signed)!.id;
    const exposures = rows<{ id: string; recommendation_id: string; serve_id: string }>(
      `SELECT id::text, recommendation_id, features->>'serveId' AS serve_id FROM public.rank_events WHERE user_id = '${viewer}' AND surface = 'discovery' ORDER BY position`);
    assert.equal(exposures.length, 2, "the signed-in serve's items; the empty and anonymous serves write none");
    assert.ok(exposures.every((e) => e.serve_id === signedServeId && e.recommendation_id));

    // Dependents: a keyed outcome (3420 receipt) on the first exposure, and a creator attribution naming it (3386).
    const exposureRid = exposures[0]!.recommendation_id;
    exec(`UPDATE public.rank_events SET outcome = 'tap', outcome_at = now(), outcome_client_event_id = '${randomUUID()}' WHERE id::text = '${exposures[0]!.id}';
          INSERT INTO public.creator_attributions (creator_type, subject_kind, subject_id, value_event, value_event_id, attribution_basis,
                                                   beneficiary_user_id, rule_version, idempotency_key, recommendation_id)
          VALUES ('discovery_creator', 'place', '${randomUUID()}', 'save_to_trip', '${randomUUID()}', 'recorded_value_event',
                  '${creator}', ${lit(RULE_VERSION)}, 'r3501-${randomUUID()}', '${exposureRid}');`);
    const snapshot = () => ({
      rankEvents: scalar(`SELECT count(*) || ':' || string_agg(outcome || '/' || coalesce(features->>'serveId', '-') || '/' || recommendation_id, ',' ORDER BY position) FROM public.rank_events WHERE user_id = '${viewer}'`),
      receipts: scalar(`SELECT count(*) FROM public.rank_event_outcome_receipts WHERE user_id = '${viewer}'`),
      attributions: scalar(`SELECT count(*) || ':' || string_agg(recommendation_id, ',') FROM public.creator_attributions WHERE beneficiary_user_id = '${creator}'`),
      earnings: scalar(`SELECT count(*) FROM public.creator_earning_entries`),
    });
    const before = snapshot();
    assert.equal(before.receipts, "1", "the keyed outcome wrote its receipt");
    assert.equal(before.attributions, `1:${exposureRid}`);

    // New rows: the real tick, over the bridge as service_role, keeps all three.
    _resetDiscoveryServeLogRetentionStatus();
    const kept = await runDiscoveryServeLogRetentionTick(b.client);
    assert.deepEqual(kept.lastFailures, []);
    assert.equal(reqs().length, 3, "newer than 30 days: kept");

    // Expire them (as the owner — nothing else can move created_at), then tick again.
    exec(`UPDATE public.recommendations SET created_at = now() - interval '31 days' WHERE route LIKE '/r3501/%';`);
    const ran = await runDiscoveryServeLogRetentionTick(b.client);
    assert.deepEqual(ran.lastFailures, [], "the purge ran and succeeded");
    assert.equal(ran.consecutiveFailures, 0);
    assert.ok((ran.lastReport?.deleted ?? 0) >= 3);
    assert.equal(ran.lastReport?.backlogRemains, false);
    assert.equal(reqs().length, 0, "expired: all three request rows purged");
    assert.deepEqual(b.failed, [], "nothing the tick sent was refused");

    // The job's run is on record in the database.
    const jh = rows<{ ok: boolean }>(`SELECT (last_success_at IS NOT NULL AND last_success_at = last_run_at) AS ok FROM public.job_health WHERE job = '${JOB_KEY}'`);
    assert.deepEqual(jh, [{ ok: true }], "job_health records the successful run");

    // D5: every dependent is exactly as it was.
    assert.deepEqual(snapshot(), before, "rank_events (outcome, serveId, exposure id), receipts, attributions and earnings are untouched");
    // The exposure link an attribution needs still resolves: 3386's trigger admits a NEW original naming it.
    exec(`INSERT INTO public.creator_attributions (creator_type, subject_kind, subject_id, value_event, value_event_id, attribution_basis,
                                                   beneficiary_user_id, rule_version, idempotency_key, recommendation_id)
          VALUES ('discovery_creator', 'place', '${randomUUID()}', 'save_to_trip', '${randomUUID()}', 'recorded_value_event',
                  '${creator}', ${lit(RULE_VERSION)}, 'r3501-${randomUUID()}', '${exposureRid}');`);
    assert.equal(scalar(`SELECT count(*) FROM public.creator_attributions WHERE beneficiary_user_id = '${creator}'`), "2");
  });

  test("D6. refusals delete nothing: a foreign key on the table, an absent row, an invalid keep_days; OFF answers disabled and the tick FAILS", async () => {
    exec(probeRow(rid("d6old"), "now() - interval '60 days'"));

    const fk = psql(`BEGIN;
      CREATE TABLE public.r3501_fk_probe (rec text REFERENCES public.recommendations(id));
      SET LOCAL ROLE service_role;
      SELECT public.purge_expired_discovery_recommendations(10);
      ROLLBACK;`);
    assert.notEqual(fk.status, 0);
    assert.match(fk.stderr, /a foreign key now references public\.recommendations/);

    for (const [meta, re] of [["{\"keep_days\": 0}", /1\.\.3650/], ["{\"keep_days\": 1.5}", /whole number/], ["{\"keep_days\": \"30\"}", /not a number/], ["{}", /not a number/]] as const) {
      const r = psql(`BEGIN;
        UPDATE public.feature_flags SET metadata = '${meta}'::jsonb WHERE flag = '${FLAG}';
        SET LOCAL ROLE service_role;
        SELECT public.purge_expired_discovery_recommendations(10);
        ROLLBACK;`);
      assert.notEqual(r.status, 0, `keep_days ${meta} refused`);
      assert.match(r.stderr, re);
    }
    const absent = psql(`BEGIN;
      DELETE FROM public.feature_flags WHERE flag = '${FLAG}';
      SET LOCAL ROLE service_role;
      SELECT public.purge_expired_discovery_recommendations(10);
      ROLLBACK;`);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /is absent; the retention period is never guessed/);
    assert.deepEqual(present([rid("d6old")]), [rid("d6old")], "every refusal deleted nothing");

    exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`);
    try {
      assert.deepEqual([purge(10).status, purge(10).deleted], ["disabled", 0]);
      _resetDiscoveryServeLogRetentionStatus();
      const s = await runDiscoveryServeLogRetentionTick(b.client);   // the bridge's TS flag says ON; the database says OFF
      assert.equal(s.consecutiveFailures, 1, "a purge that did not run is a failure");
      assert.match(s.lastFailures.join(" "), /answered disabled/);
      assert.equal(s.lastSuccessAt, null);
      assert.deepEqual(present([rid("d6old")]), [rid("d6old")]);
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}';`);
    }
    assert.equal(purge(10).deleted, 1, "back ON, the row goes");
  });

  test("D7. no client role may execute either retention function", () => {
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["public.purge_expired_discovery_recommendations(10)", "public.discovery_recommendations_retention_cutoff()"]) {
        const r = psql(`SET ROLE ${role};\nSELECT ${fn};`);
        assert.notEqual(r.status, 0, `${role} ${fn}`);
        assert.match(r.stderr, /permission denied for function/);
      }
    }
  });

  test("D8. the per-request reports read a window inside the horizon, and call one reaching before it UNOBSERVED", () => {
    const now = Date.now();
    const inside = readTraceCorpus(LOCAL_DB_URL, { since: new Date(now - 10 * 86_400_000).toISOString(), until: null });
    assert.ok(inside.ok, inside.ok ? "" : inside.error);
    if (inside.ok) {
      assert.ok(Array.isArray(inside.corpus.serveRequests), "inside the horizon the rows are read");
      assert.equal(inside.corpus.serveRequestsUnobserved, null);
    }
    const past = readTraceCorpus(LOCAL_DB_URL, { since: new Date(now - 45 * 86_400_000).toISOString(), until: null });
    assert.ok(past.ok, past.ok ? "" : past.error);
    if (past.ok) {
      assert.equal(past.corpus.serveRequests, null, "possibly purged: unobserved, never short");
      assert.match(past.corpus.serveRequestsUnobserved ?? "", /retention horizon/);
    }
  });
});
