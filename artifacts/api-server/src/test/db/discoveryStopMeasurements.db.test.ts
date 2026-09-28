/**
 * discoveryStopMeasurements — census-discovery DV-82 / §54: migration 3391's
 * measurement function, read through the REAL lib/discoveryStopMeasurements.ts
 * and judged by the REAL lib/discoveryStopConditions.ts, against PostgreSQL 16.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoveryStopMeasurements.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database.
 *
 * CONTROLLED DATA, TWO WINDOWS. Every row this suite writes is timed inside one
 * of two ten-minute windows in 2031, so nothing any other suite writes "now"
 * can enter either measurement:
 *
 *   CALM   four creators, five exposures each, plus unresolvable OSM items;
 *          one dismiss in 25 exposures; a legitimate recomputation (a
 *          superseded attribution and its successor).
 *   STORM  one creator holds 18 of 20 resolvable exposures; 6 dismisses and a
 *          report; two LIVE attributions crediting one person twice for one
 *          save.
 *
 * Under rulings the TEST injects (the owner has ruled none), CALM clears and
 * STORM trips each of the four database conditions; with no ruling, both are
 * reported `unruled` with their measured values and nothing trips. RLS: the
 * posture reads zero deviations as built, and one re-GRANT inside a rolled-back
 * transaction is a deviation the measurement names.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, psql, seedUser, deleteUser } from "./localDb.js";
import { pgError } from "./discoverySearchPsqlClient.js";
import {
  measureDiscoveryStopInputs,
  parseStopMeasurements,
} from "../../lib/discoveryStopMeasurements.js";
import {
  DATABASE_MEASURED,
  evaluateStopConditions,
  recordStopMeasurement,
  _resetStopConditionsForTest,
  type StopRuling,
} from "../../lib/discoveryStopConditions.js";

const CALM = { since: Date.parse("2031-01-01T00:00:00Z"), until: Date.parse("2031-01-01T00:10:00Z") };
const STORM = { since: Date.parse("2031-02-01T00:00:00Z"), until: Date.parse("2031-02-01T00:10:00Z") };
const at = (w: { since: number }, s: number) => `'${new Date(w.since + s * 1000).toISOString()}'::timestamptz`;

/** A PostgREST-shaped `rpc` over psql, as service_role — the API's role. `prelude` runs first, in the same transaction. */
function psqlRpc(prelude = "") {
  return {
    async rpc(name: string, args: Record<string, string>) {
      if (!/^[a-z_]+$/.test(name)) throw new Error(`refusing rpc name ${name}`);
      const named = Object.entries(args).map(([k, v]) => `${k} => '${v}'::timestamptz`).join(", ");
      const r = psql(`\\set VERBOSITY verbose\nBEGIN;\n${prelude}\nSET LOCAL ROLE service_role;\nSELECT public.${name}(${named})::text;\nROLLBACK;`);
      if (r.status !== 0) return { data: null, error: pgError(r.stderr) };
      return { data: JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{"))[0]!), error: null };
    },
  };
}

const RULED: Record<(typeof DATABASE_MEASURED)[number], StopRuling> = {
  creator_concentration:    { threshold: 0.5, minSample: 10, status: "owner_ruled", source: "test-injected" },
  reports_hides:            { threshold: 0.1, minSample: 10, status: "owner_ruled", source: "test-injected" },
  attribution_double_count: { threshold: 0,   minSample: 1,  status: "owner_ruled", source: "test-injected" },
  rls_leak:                 { threshold: 0,   minSample: 1,  status: "owner_ruled", source: "test-injected" },
};

let V = "";                       // the viewer every exposure belongs to
const X: string[] = [];           // four creators
const P: string[] = [];           // their four places
let TRAIL = "";

async function measureAndRecord(w: { since: number; until: number }, prelude = "") {
  _resetStopConditionsForTest();
  const set = await measureDiscoveryStopInputs(psqlRpc(prelude), w.since, w.until, w.until);
  for (const c of DATABASE_MEASURED) recordStopMeasurement(c, set[c]);
  return set;
}

describe("census-discovery DV-82 — 3391: the four database stop conditions, measured on controlled data", { skip: !HAVE_DB }, () => {
  before(() => {
    V = seedUser("p9stop_v");
    for (let i = 0; i < 4; i++) { X.push(seedUser(`p9stop_x${i}`)); P.push(randomUUID()); }
    TRAIL = randomUUID();
    const places = P.map((p, i) => `('${p}', 'p9stop ${i}', 'restaurant', '${X[i]}', 'active')`).join(",");
    const ev: string[] = [];
    // CALM: 5 exposures for each of 4 creators + 5 OSM items; 1 of the 25 dismissed at +300s.
    for (let i = 0; i < 4; i++) for (let k = 0; k < 5; k++) ev.push(`('${V}', 'db/${P[i]}', 'discovery', 'impression', ${at(CALM, 10 + i * 5 + k)}, NULL)`);
    for (let k = 0; k < 5; k++) ev.push(`('${V}', 'node/${900 + k}', 'discovery', ${k === 0 ? "'dismiss'" : "'impression'"}, ${at(CALM, 60 + k)}, ${k === 0 ? at(CALM, 300) : "NULL"})`);
    // STORM: 18 exposures for creator 0, 2 for creator 1; 6 dismissed.
    for (let k = 0; k < 20; k++) {
      const place = k < 18 ? P[0] : P[1];
      const dismissed = k < 6;
      ev.push(`('${V}', 'db/${place}', 'discovery', ${dismissed ? "'dismiss'" : "'impression'"}, ${at(STORM, 10 + k)}, ${dismissed ? at(STORM, 400) : "NULL"})`);
    }
    // Another surface in the same window must not count.
    ev.push(`('${V}', 'db/${P[0]}', 'pulse', 'impression', ${at(STORM, 30)}, NULL)`);
    const R1 = randomUUID(), R2 = randomUUID(), VE = randomUUID(), VE2 = randomUUID();
    exec(`
      INSERT INTO public.discovery_places (id, name, place_type, submitted_by, status) VALUES ${places};
      INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, outcome_at) VALUES ${ev.join(",\n")};
      INSERT INTO public.discovery_place_reports (place_id, reporter_id, reason, created_at) VALUES ('${P[0]}', '${V}', 'p9', ${at(STORM, 200)});
      INSERT INTO public.trails (id, slug, title) VALUES ('${TRAIL}', 'p9stop-${TRAIL.slice(0, 8)}', 'p9'); INSERT INTO public.creator_rule_versions (creator_type, rule_version, params, effective_from, note) VALUES ('discovery_creator', 'p9-stop/v1', '{}'::jsonb, '2030-12-31T00:00:00Z', 'TEST FIXTURE (census-discovery §54 stop measurements) — not a production rule; deleted after the suite'), ('discovery_creator', 'p9-stop/v2', '{}'::jsonb, ${at(CALM, 150)}, 'TEST FIXTURE (census-discovery §54 stop measurements) — not a production rule; deleted after the suite'); -- 3387 (§52) refuses an attribution under an unpublished or superseded rule version
      -- CALM: a legitimate recomputation. R1 is superseded by R2; only R2 is live.
      INSERT INTO public.creator_attributions (id, creator_type, subject_kind, subject_id, value_event, value_event_id, attribution_basis,
                                               beneficiary_user_id, rule_version, idempotency_key, computed_at)
      VALUES ('${R1}', 'discovery_creator', 'place', '${P[2]}', 'save_to_trip', '${VE}', 'recorded_value_event', '${X[2]}', 'p9-stop/v1', 'p9-${R1}', ${at(CALM, 100)});
      INSERT INTO public.creator_attributions (id, creator_type, subject_kind, subject_id, value_event, value_event_id, attribution_basis,
                                               beneficiary_user_id, rule_version, idempotency_key, computed_at, supersedes_id)
      VALUES ('${R2}', 'discovery_creator', 'place', '${P[2]}', 'save_to_trip', '${VE}', 'recorded_value_event', '${X[2]}', 'p9-stop/v2', 'p9-${R2}', ${at(CALM, 200)}, '${R1}');
      -- STORM: one save credited twice to one creator, under two keys, both live.
      INSERT INTO public.creator_attributions (creator_type, subject_kind, subject_id, value_event, value_event_id, attribution_basis,
                                               beneficiary_user_id, rule_version, idempotency_key, computed_at)
      VALUES ('discovery_creator', 'place', '${P[0]}', 'save_to_trip', '${VE2}', 'recorded_value_event', '${X[0]}', 'p9-stop/v2', 'p9-a-${VE2}', ${at(STORM, 100)}),
             ('discovery_creator', 'place', '${P[0]}', 'save_to_trip', '${VE2}', 'recorded_value_event', '${X[0]}', 'p9-stop/v2', 'p9-b-${VE2}', ${at(STORM, 110)});
    `);
  });

  after(() => {
    exec(`
      DELETE FROM public.creator_attributions WHERE beneficiary_user_id IN (${X.map((x) => `'${x}'`).join(",")}); DELETE FROM public.creator_rule_versions WHERE note LIKE 'TEST FIXTURE (census-discovery §54 stop measurements)%';
      DELETE FROM public.rank_events WHERE user_id = '${V}';
      DELETE FROM public.trails WHERE id = '${TRAIL}';
      DELETE FROM public.discovery_places WHERE id IN (${P.map((p) => `'${p}'`).join(",")});
    `);
    for (const u of [V, ...X]) deleteUser(u);
    _resetStopConditionsForTest();
  });

  it("M1. CALM is measured exactly: four equal creators, OSM items as coverage, one hide in 25, no live double count", async () => {
    const m = await measureAndRecord(CALM);
    assert.equal(m.creator_concentration.state, "measured");
    assert.equal(m.creator_concentration.value, 0.25, "HHI of four equal creators");
    assert.equal(m.creator_concentration.sample, 20, "20 resolvable exposures");
    assert.equal((m.creator_concentration.detail as any).exposures, 25, "OSM items are exposures, not creators");
    assert.equal((m.creator_concentration.detail as any).coverage, 20 / 25);
    assert.equal(m.reports_hides.value, 1 / 25);
    assert.equal(m.attribution_double_count.value, 0, "a superseded row and its successor are ONE live attribution");
    assert.equal(m.attribution_double_count.sample, 2);
    assert.equal(m.rls_leak.value, 0, "3390's posture holds as built");
  });

  it("M2. CALM does not trip under rulings", async () => {
    await measureAndRecord(CALM);
    const v = evaluateStopConditions(CALM.until + 1, { rulings: RULED });
    for (const c of DATABASE_MEASURED) assert.equal(v.readings[c].state, "clear", `${c}: ${JSON.stringify(v.readings[c])}`);
    assert.deepEqual(v.tripped, []);
  });

  it("M3. STORM is measured exactly: 0.82 HHI, 7 of 20 hidden or reported, one live double count; another surface ignored", async () => {
    const m = await measureAndRecord(STORM);
    assert.ok(Math.abs(m.creator_concentration.value! - (0.9 ** 2 + 0.1 ** 2)) < 1e-9, `hhi ${m.creator_concentration.value}`);
    assert.equal((m.creator_concentration.detail as any).topCreatorShare, 0.9);
    assert.equal(m.reports_hides.value, 7 / 20);
    assert.equal((m.reports_hides.detail as any).hideRate, 6 / 20);
    assert.equal(m.attribution_double_count.value, 1);
    assert.equal((m.attribution_double_count.detail as any).extraRows, 1);
  });

  it("M4. STORM trips all three data conditions under rulings, and only those", async () => {
    await measureAndRecord(STORM);
    const v = evaluateStopConditions(STORM.until + 1, { rulings: RULED });
    assert.deepEqual([...v.tripped].sort(), ["attribution_double_count", "creator_concentration", "reports_hides"]);
    assert.equal(v.readings.rls_leak.state, "clear");
  });

  it("M5. with NO ruling, STORM is reported and nothing trips", async () => {
    await measureAndRecord(STORM);
    const v = evaluateStopConditions(STORM.until + 1);
    for (const c of DATABASE_MEASURED) assert.equal(v.readings[c].state, "unruled", c);
    assert.ok(v.readings.creator_concentration.measured! > 0.8);
    assert.deepEqual(v.tripped, []);
  });

  it("M6. an RLS deviation — a client re-granted SELECT on a service-only table — is measured and trips under a ruling", async () => {
    const m = await measureAndRecord(CALM, "GRANT SELECT ON public.discovery_place_photos TO anon;");
    assert.equal(m.rls_leak.value, 1);
    assert.deepEqual((m.rls_leak.detail as any).deviations, ["discovery_place_photos SELECT anon: privilege_beyond_posture"]);
    const v = evaluateStopConditions(CALM.until + 1, { rulings: RULED });
    assert.deepEqual(v.tripped, ["rls_leak"]);
  });

  it("M7. a widened kept policy and a dropped deny are deviations too", async () => {
    const m = await measureAndRecord(CALM,
      `DROP POLICY "Users read own saves" ON public.discovery_place_saves;
       CREATE POLICY "Users read own saves" ON public.discovery_place_saves FOR SELECT TO authenticated USING (true);
       DROP POLICY discovery_place_photos_deny_delete_clients ON public.discovery_place_photos;`);
    const devs = (m.rls_leak.detail as any).deviations as string[];
    assert.ok(devs.includes("discovery_place_saves SELECT authenticated: kept_policy_changed_or_missing (Users read own saves)"), devs.join("; "));
    assert.ok(devs.includes("discovery_place_photos DELETE anon: restrictive_deny_missing"), devs.join("; "));
    assert.ok(devs.includes("discovery_place_photos DELETE authenticated: restrictive_deny_missing"), devs.join("; "));
  });

  it("M8. an absent attribution table is `input_absent`, and a missing function is `unreadable` — neither is zero", async () => {
    const absent = await measureAndRecord(STORM, "ALTER TABLE public.creator_attributions RENAME TO creator_attributions_p9_hidden;");
    assert.equal(absent.attribution_double_count.state, "input_absent");
    assert.equal(absent.creator_concentration.state, "measured", "one absent input does not blank the others");
    const gone = await measureAndRecord(STORM, "DROP FUNCTION public.discovery_stop_measurements(timestamptz, timestamptz);");
    for (const c of DATABASE_MEASURED) {
      assert.equal(gone[c].state, "unreadable", c);
      assert.equal((gone[c].detail as any).reason, "function_absent");
    }
    const v = evaluateStopConditions(STORM.until + 1, { rulings: RULED });
    assert.deepEqual(v.tripped, [], "an unreadable measurement never trips");
  });

  it("M9. a client role cannot call the measurement", () => {
    const r = psql(`SET ROLE authenticated;\nSELECT public.discovery_stop_measurements(now() - interval '1 minute', now());`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /permission denied for function discovery_stop_measurements/);
  });

  it("M10. the parser agrees with the database on the empty window", async () => {
    const empty = { since: Date.parse("2031-03-01T00:00:00Z"), until: Date.parse("2031-03-01T00:10:00Z") };
    const raw = await psqlRpc().rpc("discovery_stop_measurements", { p_since: new Date(empty.since).toISOString(), p_until: new Date(empty.until).toISOString() });
    const m = parseStopMeasurements(raw.data, empty.until);
    assert.equal(m.creator_concentration.value, null, "no exposures is not concentration 0");
    assert.equal(m.reports_hides.value, null, "no exposures is not a hide rate of 0");
  });
});
