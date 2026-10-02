/**
 * census-discovery §55 (lane P6, outcome measurement) — on a REAL PostgreSQL 16.
 *
 *   B1  3395 seeds the dwell flag FALSE, re-applies as a no-op, and its rollback
 *       refuses while the flag is TRUE and removes the row while it is FALSE
 *   B2  the attention rows lib/discoveryDwell writes are ADMITTED by every live
 *       CHECK (2890's dwell trio, 2891's shape, 3375's version, the privacy and
 *       retention classes) — idle included — and a retry lands NOTHING through
 *       2891's arbiter (ON CONFLICT DO NOTHING, as the writer's upsert sends it)
 *   B3  the reports' read runs on the real schema and returns what was written,
 *       including an outcome event whose exposure it had to reach by id
 *   B4  the read-only door is enforced by the DATABASE: a write through it is
 *       refused and nothing lands
 *   B5  both report scripts run end to end against a database they are given
 *
 * Skips without LOCAL_DB_URL, like every suite in this directory; run it with
 * scripts/local-db (run-tests.sh refuses a skipped run).
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, LOCAL_DB_URL, psql, exec, scalar, jsonLiteral, seedUser, deleteUser } from "./localDb.js";
import { dwellRowFor } from "../../lib/discoveryDwell.js";
import { servedRecommendationId } from "../../lib/discoveryRecommendationRecord.js";
import { readTraceCorpus, runReadOnly } from "../../lib/discoveryTraceRead.js";
import { buildTraceCoverageReport } from "../../lib/discoveryTraceCoverage.js";
import { buildOutcomeReport } from "../../lib/discoveryOutcomeReport.js";
import { DISCOVERY_MODEL_VERSION } from "../../lib/discoveryRankProvenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..", "..", "..");
const REPO = resolve(API, "..", "..");
const MIGRATION = join(API, "src", "migrations", "3395_discovery_dwell_telemetry_flag.sql");
const ROLLBACK = join(REPO, "db", "rollback", "2026-09-27-3395-discovery-dwell-telemetry-flag-rollback.sql");
const FLAG = "discovery_dwell_telemetry_enabled";

// A window no other suite writes into, so the reads below see only this suite's rows.
const SERVED_AT = "2031-01-01T10:00:00.000Z";
const WINDOW = { since: "2031-01-01T00:00:00.000Z", until: "2031-01-02T00:00:00.000Z" };
const SESSION = "5e55a000-0000-4000-8000-000000000055";
const SERVE_ID = "P6servePointOneRequest";   // 22 chars: 3376's id shape
let user = "";

function runFile(path: string) { return psql(readFileSync(path, "utf8")); }

describe("§55 — outcome measurement on a real database", { skip: !HAVE_DB }, () => {
  before(() => { user = seedUser("p6"); });
  after(() => {
    exec(`DELETE FROM public.rank_events WHERE user_id = '${user}';`);
    exec(`DELETE FROM public.recommendations WHERE session_id = '${SESSION}';`);
    deleteUser(user);
    // Leave 3395 applied and FALSE, as the harness found it — whatever a failed case left behind.
    exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`);
    runFile(MIGRATION);
  });

  test("B1. 3395 seeds the flag FALSE, re-applies as a no-op; its rollback refuses while TRUE and removes it while FALSE", () => {
    assert.equal(runFile(MIGRATION).status, 0, "re-applying 3395 is a no-op");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "false");
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}';`);
    try {
      const refused = runFile(ROLLBACK);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /ROLLBACK REFUSED \(3395\)/);
      assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "true", "a refused rollback changes nothing");
      const reapply = runFile(MIGRATION);
      assert.notEqual(reapply.status, 0, "3395's postcondition refuses a database where the flag is ON");
      assert.match(reapply.stderr, /POSTCONDITION FAILED \(3395\)/);
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`);
    }
    assert.equal(runFile(ROLLBACK).status, 0);
    assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag = '${FLAG}'`), "0");
    assert.equal(runFile(MIGRATION).status, 0, "and it applies again after its rollback");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "false");
  });

  test("B2. attention rows are admitted by every live CHECK, idle included, and a retry lands nothing", () => {
    const rid = servedRecommendationId({ userId: user, sessionId: SESSION, servedAt: SERVED_AT }, 0, "db/p6-a");
    exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, surface, session_id, recommendation_id, schema_version, privacy_class)
          VALUES ('${user}', 'db/p6-a', 'gem', 0, ${jsonLiteral({ servePoint: 1, rankedInRequest: false, recommendationId: rid, modelVersion: DISCOVERY_MODEL_VERSION, serveId: SERVE_ID, servedCount: 2, schemaVersion: 1, privacyClass: "raw_behavioral_event" })},
                  'impression', '${SERVED_AT}', 'discovery', '${SESSION}', '${rid}', 1, 'raw_behavioral_event');`);
    const exposure = { id: "x", user_id: user, item_id: "db/p6-a", item_kind: "gem", surface: "discovery", outcome: "impression", event_type: null, position: 0, served_at: SERVED_AT, session_id: SESSION, recommendation_id: rid };
    const rows = (["active", "passive_foreground", "idle"] as const).map((kind, i) =>
      dwellRowFor(user, exposure, rid, "0f0f0f0f-1111-4222-8333-000000000055", { kind, ms: 1000 * (i + 1) }, "2031-01-01T10:05:00.000Z"));
    // The writer's upsert (ignoreDuplicates) as PostgREST sends it: exactly the
    // writer's columns, ON CONFLICT on 2891's arbiter DO NOTHING. The columns are
    // named so `id` takes its default.
    const cols = Object.keys(rows[0]!).join(", ");
    const insert = `INSERT INTO public.rank_events (${cols}) SELECT ${cols} FROM jsonb_populate_recordset(NULL::public.rank_events, ${jsonLiteral(rows)})
                    ON CONFLICT (recommendation_id, outcome) DO NOTHING RETURNING id;`;
    const first = exec(insert);
    assert.equal(first.length, 3, "all three kinds admitted, idle included");
    const retry = exec(insert);
    assert.equal(retry.length, 0, "a retry of the same emission lands nothing");
    assert.equal(scalar(`SELECT count(*) FROM public.rank_events WHERE user_id = '${user}' AND event_type = 'place_dwell'`), "3");
    assert.equal(scalar(`SELECT string_agg(dwell_kind || ':' || dwell_ms, ',' ORDER BY dwell_ms) FROM public.rank_events WHERE user_id = '${user}' AND event_type = 'place_dwell'`),
      "active:1000,passive_foreground:2000,idle:3000");
    assert.equal(scalar(`SELECT outcome FROM public.rank_events WHERE recommendation_id = '${rid}'`), "impression", "the exposure is untouched");
  });

  test("B3. the reports' read returns what was written, on the real schema — the outcome event reached by id", () => {
    const rid = servedRecommendationId({ userId: user, sessionId: SESSION, servedAt: SERVED_AT }, 0, "db/p6-a");
    // An outcome event written AFTER the window (its served_at is the outcome time), naming the exposure.
    exec(`UPDATE public.rank_events SET outcome = 'tap', outcome_at = '2031-02-01T00:00:00Z' WHERE recommendation_id = '${rid}' AND outcome = 'impression';
          INSERT INTO public.rank_events (user_id, item_id, surface, outcome, event_type, served_at, recommendation_id, features)
          VALUES ('${user}', 'db/p6-a', 'discovery', 'analytics', 'ranking_item_opened', '2031-02-01T00:00:00Z', '${rid}', '{}'::jsonb);
          INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, route, model_version, served_count, item_ids, item_kinds, served_at)
          VALUES ('${SERVE_ID}', '${user}', 'signed_in', '${SESSION}', 'discovery', 1, 'GET /discovery', '${DISCOVERY_MODEL_VERSION}', 2, ARRAY['db/p6-a','db/p6-b'], ARRAY['gem','gem'], '${SERVED_AT}')
          ON CONFLICT (id) DO NOTHING;`);
    const read = readTraceCorpus(LOCAL_DB_URL, WINDOW);
    assert.ok(read.ok, read.ok ? "" : read.error);
    if (!read.ok) return;
    const mine = read.corpus.rankEvents;
    assert.equal(mine.filter((r) => r.event_type === null).length, 1, "the exposure");
    assert.equal(mine.filter((r) => r.event_type === "ranking_item_opened").length, 1, "the outcome event, reached through its id");
    assert.equal(mine.filter((r) => r.event_type === "place_dwell").length, 3);
    assert.ok(mine.every((r) => !("user_id" in r)), "the read selects no user id");
    assert.ok(Array.isArray(read.corpus.serveRequests), "3376 is applied here");
    const coverage = buildTraceCoverageReport(mine, read.corpus.serveRequests);
    const g = coverage.surfaces[0]!.groups.find((x) => x.servePoint === 1)!;
    assert.deepEqual(g.servedItems, { observed: true, value: { requests: 1, emptyRequests: 0, items: 2, withExposure: 1, withoutExposure: 1 } });
    assert.deepEqual(g.outcomes.onExposure, { tap: 1 });
    assert.deepEqual(g.outcomes.boundEvents, { ranking_item_opened: 1 });
    assert.deepEqual(g.attention, { active: 1, passive_foreground: 1, idle: 1 });
    const outcomes = buildOutcomeReport(mine, read.corpus.serveRequests);
    assert.equal(outcomes.arms.find((a) => a.arm === "legacy")!.n, 1);
    assert.equal(outcomes.arms.find((a) => a.arm === "pde")!.metrics["place_opens"]!.status, "insufficient_sample");
  });

  test("B4. the read-only door is enforced by the database: a write through it is refused and nothing lands", () => {
    const before = scalar(`SELECT count(*) FROM public.rank_events WHERE user_id = '${user}'`);
    const r = runReadOnly(LOCAL_DB_URL, `INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, features) VALUES ('${user}', 'db/p6-z', 'discovery', 'impression', now(), '{}'::jsonb);`);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /read-only transaction/);
    assert.equal(scalar(`SELECT count(*) FROM public.rank_events WHERE user_id = '${user}'`), before);
  });

  test("B5. both report scripts run end to end against the database they are given", () => {
    for (const script of ["reportDiscoveryTraceCoverage.ts", "reportDiscoveryOutcomes.ts"]) {
      const r = spawnSync(process.execPath, ["--import", "tsx/esm", join("src", "scripts", script),
        "--db-url", LOCAL_DB_URL, "--since", WINDOW.since, "--until", WINDOW.until, "--json"], { cwd: API, encoding: "utf8", timeout: 120_000 });
      assert.equal(r.status, 0, `${script}: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.window.since, WINDOW.since);
      assert.ok(out.rowsRead >= 5, `${script} read the suite's rows`);
    }
  });
});
