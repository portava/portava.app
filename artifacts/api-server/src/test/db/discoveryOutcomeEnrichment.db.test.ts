/**
 * census-discovery §82 (lane W10-O) — on a REAL PostgreSQL 16.
 *
 *   E1  OUTCOME_ENRICHMENT_SQL runs on the real schema, read-only, and returns
 *       per exposure: the creator (hashed), the creator's first submission,
 *       reportable, reported within 7 days, regretted within 30 days — and an
 *       OSM item (no creator, not reportable) is null/false, never guessed.
 *   E2  no user id leaves the database: neither the viewer's nor the creator's
 *       raw id appears anywhere in the read's output.
 *   E3  the enriched report and the judgement built on it (D-W10-O-10/11).
 *   E4  3470 seeds `discovery_stop_enforcement_enabled` FALSE, re-applies as a
 *       no-op, refuses a database where it is ON; its rollback refuses while
 *       TRUE and removes the row while FALSE.
 *
 * Skips without LOCAL_DB_URL, like every suite in this directory; run it with
 * scripts/local-db (run-tests.sh refuses a skipped run).
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, LOCAL_DB_URL, psql, exec, rows as dbRows, scalar, seedUser, deleteUser } from "./localDb.js";
import { readOutcomeEnrichment, buildOutcomeReport, judgeOutcomeImprovement, OUTCOME_ENRICHMENT_SQL } from "../../lib/discoveryOutcomeReport.js";
import { runReadOnly } from "../../lib/discoveryTraceRead.js";
import { DISCOVERY_MODEL_VERSION, DISCOVERY_PDE_MODEL_VERSION } from "../../lib/discoveryRankProvenance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = resolve(HERE, "..", "..", "..");
const REPO = resolve(API, "..", "..");
const MIGRATION = join(API, "src", "migrations", "3470_discovery_stop_enforcement_flag.sql");
const ROLLBACK = join(REPO, "db", "rollback", "2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql");
const FLAG = "discovery_stop_enforcement_enabled";

// A window no other suite writes into.
const WINDOW = { since: "2032-02-01T00:00:00.000Z", until: "2032-02-02T00:00:00.000Z" };
const T = (h: number) => `'2032-02-01T${String(h).padStart(2, "0")}:00:00Z'`;
let viewer = "", creatorNew = "", creatorOld = "";
const P_NEW = randomUUID(), P_OLD = randomUUID(), P_OLD_FIRST = randomUUID();
const ids: Record<string, string> = {};

function runFile(path: string) { return psql(readFileSync(path, "utf8")); }
const features = (arm: "pde" | "legacy") =>
  `'${JSON.stringify({ modelVersion: arm === "pde" ? DISCOVERY_PDE_MODEL_VERSION : DISCOVERY_MODEL_VERSION, servePoint: 1 })}'::jsonb`;

describe("§82 — the outcome enrichment and the arming flag on a real database", { skip: !HAVE_DB }, () => {
  before(() => {
    viewer = seedUser("w10o_v"); creatorNew = seedUser("w10o_cn"); creatorOld = seedUser("w10o_co");
    exec(`
      INSERT INTO public.discovery_places (id, name, place_type, submitted_by, status, created_at) VALUES
        ('${P_NEW}', 'w10o new', 'restaurant', '${creatorNew}', 'active', '2032-01-25T00:00:00Z'),
        ('${P_OLD}', 'w10o old', 'restaurant', '${creatorOld}', 'active', '2032-01-30T00:00:00Z'),
        ('${P_OLD_FIRST}', 'w10o old first', 'cafe', '${creatorOld}', 'active', '2030-01-01T00:00:00Z');
    `);
    const ins = (key: string, item: string, outcome: string, h: number, arm: "pde" | "legacy") => {
      ids[key] = scalar(`INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, features) VALUES ('${viewer}', '${item}', 'discovery', '${outcome}', ${T(h)}, ${features(arm)}) RETURNING id;`)!;
    };
    ins("newSaved", `db/${P_NEW}`, "save", 1, "pde");         // later dismissed ⇒ regret; creator new (7 d)
    ins("newLater", `db/${P_NEW}`, "dismiss", 5, "pde");      // the later dismissal
    ins("oldTapped", `db/${P_OLD}`, "tap", 2, "legacy");      // reported 1 h later ⇒ reported; creator old (first 2030)
    ins("osm", "node/424242", "tap", 3, "legacy");            // no creator, not reportable
    exec(`INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason, created_at) VALUES ('${P_OLD}', '${viewer}', 'w10o', ${T(3)});`);
  });
  after(() => {
    exec(`
      DELETE FROM public.discovery_place_reports WHERE reporter_id = '${viewer}';
      DELETE FROM public.rank_events WHERE user_id = '${viewer}';
      DELETE FROM public.discovery_places WHERE id IN ('${P_NEW}', '${P_OLD}', '${P_OLD_FIRST}');
    `);
    for (const u of [viewer, creatorNew, creatorOld]) deleteUser(u);
    exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`);
    runFile(MIGRATION);
  });

  test("E1. the read returns each exposure's enrichment, and guesses nothing for an OSM item", () => {
    const r = readOutcomeEnrichment(LOCAL_DB_URL, WINDOW);
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (!r.ok) return;
    const e = r.enrichment;
    assert.equal(e.size, 4);
    const saved = e.get(ids.newSaved!)!, later = e.get(ids.newLater!)!, old = e.get(ids.oldTapped!)!, osm = e.get(ids.osm!)!;
    assert.equal(saved.regretted, true, "saved at 01:00, dismissed on a later exposure at 05:00");
    assert.equal(later.regretted, false);
    assert.equal(saved.reportable, true); assert.equal(saved.reported, false);
    assert.equal(old.reported, true, "reported one hour after the exposure");
    assert.equal(saved.creator, later.creator);
    assert.notEqual(saved.creator, old.creator);
    assert.equal(Date.parse(saved.creatorFirstAt!), Date.parse("2032-01-25T00:00:00Z"));
    assert.equal(Date.parse(old.creatorFirstAt!), Date.parse("2030-01-01T00:00:00Z"), "the creator's FIRST submission, not this place's");
    assert.deepEqual(osm, { creator: null, creatorFirstAt: null, reportable: false, reported: false, regretted: false });
  });

  test("E2. no user id leaves the database", () => {
    const raw = runReadOnly(LOCAL_DB_URL, OUTCOME_ENRICHMENT_SQL, { since: WINDOW.since, until: WINDOW.until });
    assert.ok(raw.ok);
    if (!raw.ok) return;
    for (const u of [viewer, creatorNew, creatorOld]) assert.ok(!raw.stdout.includes(u), `user id ${u} appears in the read's output`);
  });

  test("E3. the enriched report over the real read, and a judgement that refuses to judge a thin sample", () => {
    const r = readOutcomeEnrichment(LOCAL_DB_URL, WINDOW);
    assert.ok(r.ok);
    if (!r.ok) return;
    const rows = dbRows(`SELECT id, item_id, surface, outcome, event_type, features, served_at FROM public.rank_events WHERE user_id = '${viewer}'`);
    const report = buildOutcomeReport(rows, null, r.enrichment);
    const pde = report.arms.find((c) => c.arm === "pde")!;
    assert.deepEqual(pde.enriched["low_regret"], { status: "measured", n: 1, count: 1, share: 1 });
    assert.deepEqual(pde.enriched["new_creator_discovery"], { status: "measured", n: 2, count: 2, share: 1 });
    const legacy = report.arms.find((c) => c.arm === "legacy")!;
    assert.deepEqual(legacy.enriched["report_rate"], { status: "measured", n: 1, count: 1, share: 1 });
    assert.deepEqual(legacy.enriched["new_creator_discovery"], { status: "measured", n: 1, count: 0, share: 0 });
    assert.equal(judgeOutcomeImprovement(report).verdict, "insufficient_sample", "four exposures are not evidence of anything");
  });

  test("E4. 3470 seeds FALSE, re-applies as a no-op, refuses ON; its rollback refuses while TRUE and removes the row while FALSE", () => {
    assert.equal(runFile(MIGRATION).status, 0, "re-applying 3470 is a no-op");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "false");
    exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}';`);
    try {
      const refused = runFile(ROLLBACK);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /ROLLBACK REFUSED \(3470\)/);
      const reapply = runFile(MIGRATION);
      assert.notEqual(reapply.status, 0);
      assert.match(reapply.stderr, /POSTCONDITION FAILED \(3470\)/);
    } finally {
      exec(`UPDATE public.feature_flags SET enabled = false WHERE flag = '${FLAG}';`);
    }
    assert.equal(runFile(ROLLBACK).status, 0);
    assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag = '${FLAG}'`), "0");
    assert.equal(runFile(MIGRATION).status, 0, "and it applies again after its rollback");
    assert.equal(scalar(`SELECT enabled::text FROM public.feature_flags WHERE flag = '${FLAG}'`), "false");
  });
});
