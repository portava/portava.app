/**
 * discoveryEcosystemReport — census-discovery DV-80 / §58: the ecosystem
 * monitor report's reads, EXECUTED against PostgreSQL 16, read-only.
 *
 * The pure suite (discoveryEcosystemGovernor.test.ts) proves the arithmetic
 * from fixture JSON. This one proves the SQL: each read runs through the same
 * lib/discoveryTraceRead.runReadOnly the script uses (BEGIN TRANSACTION READ
 * ONLY, rolled back), over controlled rows, and the report's numbers are the
 * ones the rows imply. Then the script itself runs end to end.
 *
 * The window is 2024-02-28 .. 2024-03-02 — a leap-day window no other suite
 * writes into; Trails and pages created by this suite are dated inside it and
 * `until` precedes every Trail another suite creates at now().
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoveryEcosystemReport.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, LOCAL_DB_URL, exec, seedUser, deleteUser } from "./localDb.js";
import { runReadOnly, readTraceCorpus } from "../../lib/discoveryTraceRead.js";
import {
  buildEcosystemReport, ECOSYSTEM_STOP_SQL, ECOSYSTEM_REPEATS_SQL, ECOSYSTEM_SPAM_SQL,
  ECOSYSTEM_TRAILS_SQL, ECOSYSTEM_PAGES_SQL, type ReadOutcome, ECOSYSTEM_NEW_CREATORS_SQL, ECOSYSTEM_STALE_SQL,  // §84: the two defined monitors
} from "../../lib/discoveryEcosystemGovernor.js";
import { DiscoveryServePoint } from "../../lib/discoveryServeLog.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const API = join(__dir, "..", "..", "..");
const SINCE = "2024-02-28T00:00:00.000Z";
const UNTIL = "2024-03-02T00:00:00.000Z";
const inWin = (h: number) => `'${new Date(Date.parse(SINCE) + h * 3_600_000).toISOString()}'::timestamptz`;
const vars = { since: SINCE, until: UNTIL };

let V1 = "", V2 = "", C1 = "", C2 = "";
const DP1 = randomUUID(), DP2 = randomUUID(), TRAIL = randomUUID();
const PAGE = "p8ecoPAGE".padEnd(22, "x");

const read = (sql: string): ReadOutcome => {
  const r = runReadOnly(LOCAL_DB_URL, sql, vars);
  return r.ok ? { ok: true, value: r.stdout } : { ok: false, error: r.error };
};

function report() {
  const corpus = readTraceCorpus(LOCAL_DB_URL, vars);
  return buildEcosystemReport({
    window: vars,
    stop: read(ECOSYSTEM_STOP_SQL),
    corpus: corpus.ok ? { ok: true, rows: corpus.corpus.rankEvents } : { ok: false, error: corpus.error },
    repeats: read(ECOSYSTEM_REPEATS_SQL),
    spam: read(ECOSYSTEM_SPAM_SQL),
    trails: read(ECOSYSTEM_TRAILS_SQL),
    pages: read(ECOSYSTEM_PAGES_SQL), newCreators: read(ECOSYSTEM_NEW_CREATORS_SQL), stale: read(ECOSYSTEM_STALE_SQL),
  });
}
const m = (r: ReturnType<typeof report>, id: string) => r.monitors.find((x) => x.id === id)!.reading as any;

describe("census-discovery DV-80 — the monitor reads, executed read-only", { skip: !HAVE_DB }, () => {
  before(() => {
    V1 = seedUser("p8eco_v1"); V2 = seedUser("p8eco_v2"); C1 = seedUser("p8eco_c1"); C2 = seedUser("p8eco_c2");
    const sp = (p: number) => `'{"servePoint": ${p}}'::jsonb`;
    const HG = DiscoveryServePoint.HIDDEN_GEMS, CA = DiscoveryServePoint.CACHE_A_L1;
    exec(`
      INSERT INTO public.discovery_places (id, name, place_type, submitted_by) VALUES
        ('${DP1}', 'p8eco one', 'cafe', '${C1}'), ('${DP2}', 'p8eco two', 'cafe', '${C2}');
      INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, features) VALUES
        -- V1 is served DP1 three times, once under its bare id: ONE place, so two repeats.
        ('${V1}', 'db/${DP1}', 'discovery', 'impression', ${inWin(1)}, ${sp(CA)}),
        ('${V1}', 'db/${DP1}', 'discovery', 'impression', ${inWin(2)}, ${sp(CA)}),
        ('${V1}', '${DP1}',    'discovery', 'impression', ${inWin(3)}, ${sp(CA)}),
        ('${V2}', 'db/${DP2}', 'discovery', 'impression', ${inWin(4)}, ${sp(CA)}),
        ('${V2}', 'node/p8eco', 'discovery', 'impression', ${inWin(5)}, ${sp(HG)}),
        -- Not exposures: bookkeeping, another surface, and a row outside the window.
        ('${V2}', 'node/p8eco', 'discovery', 'analytics', ${inWin(5)}, ${sp(HG)}),
        ('${V2}', 'node/p8eco', 'pulse', 'impression', ${inWin(6)}, ${sp(HG)}),
        ('${V1}', 'db/${DP1}', 'discovery', 'impression', '2024-03-05T00:00:00Z', ${sp(CA)});
      INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason, created_at) VALUES
        ('${DP1}', '${V2}', 'spam', ${inWin(7)}), ('${DP2}', '${V1}', 'inaccurate', ${inWin(8)});
      INSERT INTO public.recommendations (id, user_id, viewer_class, session_id, surface, serve_point, model_version,
                                          served_count, item_ids, item_kinds, served_at) VALUES
        ('${PAGE}', '${V1}', 'signed_in', '${randomUUID()}', 'discovery', ${CA}, 'p8eco', 3,
         ARRAY['db/${DP1}', '${DP1}', 'node/p8eco'], ARRAY['place','place','place'], ${inWin(1)});
      INSERT INTO public.trails (id, slug, title, created_at) VALUES ('${TRAIL}', 'p8eco-${TRAIL.slice(0, 8)}', 'p8 eco', ${inWin(0)});
      INSERT INTO public.trail_health_snapshots (trail_id, metrics, model_version, member_count, captured_at) VALUES
        ('${TRAIL}', '{"content_freshness": 0.1, "stale_object_ratio": 0.5, "duplicate_density": 0.2}'::jsonb, 'trail-health-v1', 4, ${inWin(1)}),
        ('${TRAIL}', '{"content_freshness": 0.4, "stale_object_ratio": 0.25, "duplicate_density": 0}'::jsonb, 'trail-health-v1', 4, ${inWin(10)});
    `);
  });

  after(() => {
    exec(`
      DELETE FROM public.trails WHERE id = '${TRAIL}';
      DELETE FROM public.recommendations WHERE id = '${PAGE}';
      DELETE FROM public.discovery_places WHERE id IN ('${DP1}', '${DP2}');
    `);
    for (const u of [V1, V2, C1, C2]) deleteUser(u);
  });

  it("E1. each monitor reads what the rows imply", () => {
    const r = report();
    // P9's HHI: served db/ exposures by creator — C1 twice, C2 once (the bare id is not P9's join).
    assert.ok(Math.abs(m(r, "concentration").value - (4 / 9 + 1 / 9)) < 1e-9, JSON.stringify(m(r, "concentration")));
    assert.equal(m(r, "concentration").sample, 3);
    // Five exposures; V1×DP1 (folded) three times, V2×DP2 once, V2×node once: two repeats.
    assert.equal(m(r, "repeated_recommendations").value, 2 / 5);
    assert.equal(m(r, "repeated_recommendations").detail.repeatedPairs, 1);
    // Two community places served; one carries a spam report.
    assert.equal(m(r, "spam_rate").value, 1 / 2);
    assert.equal(m(r, "spam_rate").detail.reportsInWindow, 2);
    // The Trail's NEWEST snapshot at or before until.
    assert.equal(m(r, "trail_freshness").value, 0.4);
    assert.equal(m(r, "trail_freshness").detail.trailsWithoutSnapshot, 0);
    // One of five Discovery exposures came from the hidden-gems surface.
    assert.equal(m(r, "hidden_gem_exposure").value, 1 / 5);
    // One page of three items, one of them the same place under its other id.
    assert.equal(m(r, "duplicate_saturation").value, 1 / 3);
    assert.equal(m(r, "new_creator_success").state, "insufficient_sample"); assert.equal(m(r, "new_creator_success").detail.newCreators, 0); assert.equal(m(r, "stale_content").value, 0); assert.equal(m(r, "stale_content").sample, 5);  // §84 (D-W10-R1-15): measured now; C1/C2's places are dated after `until`, so no creator is new in this window, and every item was first served inside it, so none is stale
  });

  it("E2. the reads run inside a READ ONLY transaction: the same runner refuses a write", () => {
    const w = runReadOnly(LOCAL_DB_URL, "INSERT INTO public.feature_flags (flag, enabled) VALUES ('p8eco_never', false);");
    assert.equal(w.ok, false);
    assert.match((w as any).error, /read-only transaction/);
  });

  it("E3. the script end to end: exit 0, JSON, the same readings, and nothing written", () => {
    const count = () => exec("SELECT count(*) FROM public.place_momentum; SELECT count(*) FROM public.feature_flags;").join(",");
    const before = count();
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "src/scripts/reportDiscoveryEcosystem.ts",
      "--db-url", LOCAL_DB_URL, "--since", SINCE, "--until", UNTIL, "--json"], { cwd: API, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.monitors.find((x: any) => x.id === "spam_rate").reading.value, 1 / 2);
    assert.match(out.adjust, /^not built/);
    assert.equal(count(), before);
  });

  it("E4. the script refuses to guess a database", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "src/scripts/reportDiscoveryEcosystem.ts", "--days", "7"],
      { cwd: API, encoding: "utf8", timeout: 120_000, env: { ...process.env, REPORT_DB_URL: "" } });
    assert.equal(r.status, 2);
  });
});
