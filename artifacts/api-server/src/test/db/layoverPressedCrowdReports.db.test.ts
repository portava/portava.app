/**
 * Lane B1-P — the 3513 family, PRESSED, against the real migrated schema.
 *
 * Rows: L82, L84, L85, L86, L87, L88, L89, L181, L197, L251, L252, and L276's
 * publish limb. Every one is reachable only through GET/POST
 * /airport/sessions/:id/observations, which refuse unless
 * `layover_crowd_reports_enabled` is ON (routes/airport.ts:2790, :2830). 3513
 * seeds that flag — TRUE, by its own header — and is not applied in production
 * (census-layover 2026-10-18, "Wave 5, layover lanes 2–4": L181/L197 FALSE
 * GREEN; "the reachability rule applied uniformly": L84–L89, L251, L252).
 *
 * The database is the whole chain (pressedLayoverDb.ts) with 3513 in it, so the
 * flag row, airport_fact_observations (2860), its submission token (2982), the
 * event vocabulary (2983), the CHECKs and the RLS policy are the real ones, and
 * every request goes through the real router and the real supabase-js client.
 *
 * THE PRESS: apply 3513 (it seeds the flag TRUE; there is no separate flip).
 * Falsified by B1P_ARM=flag-off (the flag OFF) and B1P_ARM=absent (the chain
 * without 3513 — production today): every PRESSED case goes red, and the
 * ALWAYS cases stay green.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<node_modules/@electric-sql with pglite + pglite-postgis> \
 *   node --import tsx/esm --test src/test/db/layoverPressedCrowdReports.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_PRESSED_DB, PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = { migrations: ["3513"], flags: { layover_crowd_reports_enabled: true } } as const;
const FLAG = "layover_crowd_reports_enabled";
const CHANNEL = "portava:layover/traveller-report";
const token = () => `b1p-${randomUUID()}`;

let db: PressedDb;
let app: PressedApp;
const users: Record<string, PressedUser> = {};
const sessions: Record<string, string> = {};
let seededFlag: boolean | "absent" = "absent";

async function traveller(label: string, iata: string): Promise<void> {
  users[label] = await db.seedUser(label);
  sessions[label] = (await startSession(app, users[label]!, { iata })).id;
}
const obsPath = (who: string) => `/api/airport/sessions/${sessions[who]}/observations`;
const report = (who: string, factType: string, value: number, submissionToken = token()) =>
  app.call("POST", obsPath(who), users[who]!, { factType, value, submissionToken });
const read = (who: string) => app.call("GET", obsPath(who), users[who]!);
const factOf = (body: any, factType: string) => (body?.facts ?? []).find((f: any) => f.factType === factType);
const rowsAt = (ref: string, fact?: string) =>
  db.query<any>(`SELECT * FROM public.airport_fact_observations WHERE airport_ref = '${ref}'${fact ? ` AND fact_type = '${fact}'` : ""} ORDER BY observed_at`);
async function feedRow(ref: string, fact: string, value: number, kind: "official" | "operator_feed" | "community", ageMin: number, observer = `feed:${kind}`) {
  const at = new Date(Date.now() - ageMin * 60_000).toISOString();
  const exp = new Date(Date.now() + 60 * 60_000).toISOString();
  await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, source_ref, observed_at, expires_at)
    VALUES ('${ref}', '${fact}', 'TRAVELER_OBSERVATION', ${value}, '${kind}', '${observer}', 'feed:${kind}/${ref}', '${at}', '${exp}')`);
}

describe("B1-P 3513 family", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seededFlag = await db.flag(FLAG);
    await productionBaseFlags(db); // airport_mode + passport_entry_intelligence: TRUE in production (2026-09-22 snapshot); not part of this press
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    await traveller("ana", "SIN");
    await traveller("ben", "SIN");
    await traveller("cai", "SIN");
    await traveller("dee", "SIN");
    await traveller("eve", "BKK");
    await traveller("fay", "BKK");
    await traveller("gus", "BKK");
    await traveller("hal", "HKG");
  });
  after(async () => { await app?.close(); await db?.close(); });

 describe("PRESSED — the crowd-report channel on the real chain", () => {
  it(`P0 [${PRESS_ARM}] the press is 3513 itself: applying it seeds ${FLAG} TRUE (no separate flip)`, () => {
    assert.equal(seededFlag, true, `${FLAG} after the chain = ${String(seededFlag)}; 3513 must seed it TRUE`);
  });

  it("P1 L82 L197 L181 L88 — a traveller's report is screened, stored de-identified in airport_fact_observations, and ONE stranger moves nothing", async () => {
    const before = (await rowsAt("SIN", "queue_report_minutes")).length;
    const r = await report("ana", "queue_report_minutes", 20);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.airportRef, "SIN");
    const rows = await rowsAt("SIN", "queue_report_minutes");
    assert.equal(rows.length, before + 1, "L197: the product surface did not populate the table");
    const row = rows[rows.length - 1];
    assert.equal(row.observer_kind, "community");
    assert.match(row.observer_id, /^tv1-[0-9a-f]{40}$/, "the observer is a pseudonymous handle");
    assert.notEqual(row.observer_id, users["ana"]!.id);
    assert.equal(row.source_ref, CHANNEL);
    assert.equal(row.fact_class, "TRAVELER_OBSERVATION");
    assert.equal(Number(row.value), 20);
    assert.ok(Date.parse(row.expires_at) - Date.parse(row.observed_at) === 45 * 60_000, "the class TTL (45 min) is stored");
    const fact = r.body.fact;
    assert.equal(fact.truth, null, "L88: one community observer is below the corroboration floor — absence, not a low-confidence value");
    assert.equal(fact.corroboration.community, 1);
    assert.ok(fact.rulesApplied.some((s: string) => /below the corroboration floor of 2/.test(s)), JSON.stringify(fact.rulesApplied));
  });

  it("P2 L84 L86 L88 L181 — a second DISTINCT traveller corroborates: a full TruthValue with every spec member, provenance kept", async () => {
    const r = await report("ben", "queue_report_minutes", 25);
    assert.equal(r.status, 200, r.raw);
    const t = r.body.fact.truth;
    assert.ok(t, "corroborated by two distinct observers, yet no truth");
    for (const k of ["value", "confidence", "conflict", "sourceClass", "sourceRefs", "observedAt", "expiresAt", "fallbackLevel"]) assert.ok(k in t, `L84: TruthValue lacks ${k}`);
    assert.equal(t.value, 25, "L87: the larger (conservative) reading");
    assert.equal(t.conflict, false, "within the 10-minute tolerance — agreement, not contradiction");
    assert.equal(t.confidence, "LOW", "L251: community trust (0.3) — trust-weighted, not counted");
    assert.equal(t.sourceClass, "LIVE");
    assert.deepEqual(t.sourceRefs, [CHANNEL, CHANNEL], "L86: provenance of BOTH readings is preserved");
    assert.equal(t.fallbackLevel, 0);
    assert.ok(Date.parse(t.expiresAt) > Date.now() && Date.parse(t.observedAt) <= Date.now());
    assert.equal(r.body.fact.corroboration.community, 2);
    // the GET publishes the same reconciled truth (L181: reconcile over the stored corpus)
    const g = await read("cai");
    assert.equal(g.status, 200, g.raw);
    assert.equal(factOf(g.body, "queue_report_minutes").truth.value, 25);
  });

  it("P3 L85 L86 L87 L89 — a contradiction is flagged, never averaged: conservative value, both sources retained, confidence steps DOWN", async () => {
    assert.equal((await report("ana", "checkpoint_timing_minutes", 15)).status, 200);
    const r = await report("cai", "checkpoint_timing_minutes", 55);
    assert.equal(r.status, 200, r.raw);
    const f = r.body.fact;
    assert.equal(f.truth.conflict, true, "L85: a contradiction past tolerance must be flagged");
    assert.deepEqual(f.conflictBetween, { low: 15, high: 55 }, "L86: the conflict names both readings");
    assert.equal(f.truth.value, 55, "L87: the conservative (largest) delay, not the mean 35");
    assert.notEqual(f.truth.value, 35);
    assert.equal(f.truth.sourceRefs.length, 2, "L85: both sources retained");
    assert.equal(f.truth.confidence, "INSUFFICIENT", "L89: contradiction increases uncertainty (LOW stepped down)");
    assert.ok(f.rulesApplied.some((s: string) => /both sources retained, no average taken/.test(s)));
  });

  it("P4 L89 L251 — an official reading is not truth by being official: fresh corroborated contradiction wins conservatively and confidence steps down", async () => {
    await feedRow("BKK", "queue_report_minutes", 10, "official", 1);
    const alone = factOf((await read("eve")).body, "queue_report_minutes");
    assert.equal(alone.truth.value, 10);
    assert.equal(alone.truth.confidence, "HIGH", "L251 trust-weighting: an official reading (1.0) carries HIGH");
    assert.equal((await report("eve", "queue_report_minutes", 45)).status, 200);
    const r = await report("fay", "queue_report_minutes", 45);
    assert.equal(r.status, 200, r.raw);
    const t = r.body.fact.truth;
    assert.equal(t.value, 45, "L89: the official 10 did not win over fresh contradictory evidence");
    assert.equal(t.conflict, true);
    assert.equal(t.confidence, "MEDIUM", "L89: contradiction increases uncertainty (HIGH → MEDIUM)");
    assert.equal(r.body.fact.corroboration.official, 1);
    assert.equal(r.body.fact.corroboration.community, 2);
  });

  it("P5 L88 — decay: the same official reading 30 minutes old weighs LOW; past the class TTL it is gone (absence, not zero)", async () => {
    await feedRow("HKG", "queue_report_minutes", 12, "official", 30);
    const aged = factOf((await read("hal")).body, "queue_report_minutes");
    assert.equal(aged.truth.value, 12);
    assert.equal(aged.truth.confidence, "LOW", "1.0 × (1 − 30/45) = 0.33 → LOW");
    await feedRow("HKG", "checkpoint_timing_minutes", 12, "official", 50);
    const expired = factOf((await read("hal")).body, "checkpoint_timing_minutes");
    assert.equal(expired.truth, null, "a reading older than its class TTL must not be served");
    assert.ok(expired.rulesApplied.some((s: string) => /absence, not zero/.test(s)));
  });

  it("P6 L251 — rate limit: a fourth report of one fact inside 15 minutes is refused 429 and NOT stored", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await report("dee", "closure_reported", 1)).status, 200);
    const before = (await rowsAt("SIN", "closure_reported")).length;
    const r = await report("dee", "closure_reported", 1);
    assert.equal(r.status, 429, r.raw);
    assert.equal(r.body.error, "rate_limited");
    assert.equal((await rowsAt("SIN", "closure_reported")).length, before, "a refused report must not be written");
  });

  it("P7 L252 — outliers: a physically implausible queue is rejected before any write", async () => {
    const before = (await rowsAt("SIN")).length;
    for (const v of [900, -5]) {
      const r = await report("ben", "queue_report_minutes", v);
      assert.equal(r.status, 400, r.raw);
      assert.match(r.body.message, /outside the range this channel accepts/);
    }
    assert.equal((await rowsAt("SIN")).length, before);
  });

  it("P8 2982 — a retried submission token is a success, stored once", async () => {
    const tk = token();
    const a = await report("cai", "closure_reported", 0, tk);
    const b = await report("cai", "closure_reported", 0, tk);
    assert.equal(a.status, 200, a.raw);
    assert.equal(b.status, 200, b.raw);
    assert.equal(b.body.duplicate, true);
    const n = await db.query<any>(`SELECT count(*)::int AS n FROM public.airport_fact_observations WHERE submission_token = '${tk}'`);
    assert.equal(n[0].n, 1);
  });

  it("P9 L276 (publish limb) — what is published is de-identified: no reporter's id or handle on the wire; the client reads handles only and cannot write", async () => {
    const g = await read("ben");
    assert.equal(g.status, 200, g.raw);
    for (const u of Object.values(users)) assert.ok(!g.raw.includes(u.id), "a reporter's user id was published");
    assert.ok(!/tv1-[0-9a-f]{40}/.test(g.raw), "an observer handle was published");
    const asClient = await db.asUser(users["ben"]!.id, "SELECT observer_id FROM public.airport_fact_observations WHERE airport_ref = 'SIN'");
    assert.ok(asClient.length > 0, "RLS: authenticated may read the published observations");
    for (const r of asClient as any[]) for (const u of Object.values(users)) assert.notEqual(r.observer_id, u.id);
    await assert.rejects(
      db.asUser(users["ben"]!.id, "INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, source_ref, observed_at, expires_at) VALUES ('SIN','queue_report_minutes','TRAVELER_OBSERVATION',1,'official','x','y',now(),now()+interval '1 hour') RETURNING id"),
      (e: any) => e?.code === "42501", "a client must not be able to write an observation (let alone an official one)",
    );
    await assert.rejects(
      db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, source_ref, observed_at, expires_at) VALUES ('SIN','queue_report_minutes','TRAVELER_OBSERVATION',1,'community','${users["ben"]!.id}','y',now(),now()+interval '1 hour')`),
      (e: any) => e?.code === "23514", "2860's CHECK must refuse a community row carrying a profile id",
    );
  });
 });

 describe("ALWAYS (any arm): closed, unreadable and foreign-session requests refuse and write nothing", () => {
  let d: PressedDb;
  let a: PressedApp;
  let owner: PressedUser, other: PressedUser;
  let sid = "";
  before(async () => {
    d = db; a = app;
    owner = await d.seedUser("owner");
    other = await d.seedUser("other");
    sid = (await startSession(a, owner, { iata: "SIN" })).id;
  });
  const count = async () => (await d.query<any>("SELECT count(*)::int AS n FROM public.airport_fact_observations"))[0].n as number;

  it("A1 flag OFF → GET and POST answer 503 degraded_unavailable and nothing is written", async () => {
    await d.setFlag(FLAG, false);
    const n = await count();
    const g = await a.call("GET", `/api/airport/sessions/${sid}/observations`, owner);
    const p = await a.call("POST", `/api/airport/sessions/${sid}/observations`, owner, { factType: "queue_report_minutes", value: 10, submissionToken: token() });
    assert.equal(g.status, 503); assert.equal(g.body.error, "degraded_unavailable");
    assert.equal(p.status, 503); assert.equal(p.body.error, "degraded_unavailable");
    assert.equal(await count(), n);
  });

  it("A2 flag row ABSENT (3513 not applied) → refused the same way", async () => {
    await d.setFlag(FLAG, "absent");
    const p = await a.call("POST", `/api/airport/sessions/${sid}/observations`, owner, { factType: "queue_report_minutes", value: 10, submissionToken: token() });
    assert.equal(p.status, 503);
  });

  it("A3 flag UNREADABLE → refused (fail-closed), nothing written", async () => {
    await d.setFlag(FLAG, true);
    const n = await count();
    const fault = (req: any) => (req.target === "feature_flags" && String(req.params.get("flag") ?? "").includes(FLAG) ? { status: 500, body: { code: "XX000", message: "injected", details: null, hint: null } } : null);
    d.bridge.faults.push(fault);
    try {
      const p = await a.call("POST", `/api/airport/sessions/${sid}/observations`, owner, { factType: "queue_report_minutes", value: 10, submissionToken: token() });
      assert.equal(p.status, 503);
      assert.equal(await count(), n);
    } finally { d.bridge.faults.splice(d.bridge.faults.indexOf(fault), 1); }
  });

  it("A4 owner-scoped: another traveller cannot read or write through someone else's session; no token → 401", async () => {
    await d.setFlag(FLAG, true);
    const n = await count();
    const g = await a.call("GET", `/api/airport/sessions/${sid}/observations`, other);
    const p = await a.call("POST", `/api/airport/sessions/${sid}/observations`, other, { factType: "queue_report_minutes", value: 10, submissionToken: token() });
    assert.equal(g.status, 404); assert.equal(p.status, 404);
    assert.equal((await a.call("GET", `/api/airport/sessions/${sid}/observations`, null)).status, 401);
    assert.equal(await count(), n);
  });

  it("A5 the bridge saw no unmodelled request shape", () => {
    assert.deepEqual(d.bridge.unmodelled, []);
  });
 });
});
