/**
 * Trips under PRODUCTION'S OWN flag state (2026-10-24 capture, after the 2026-10-23 10:02:06Z press), PRESSED: the
 * Trips routers the deployed API mounts, over the replayed chain, with the service client the routes use injected
 * from the pressed database.
 *
 * THE HOTFIX THIS FILE PROVES (census-trips, 2026-10-24). With both Trips flags ON in production, two defects broke
 * what the press was meant to open:
 *   G   the operational gate could never open: its readiness probe filtered every table on `id`, and
 *       trip_decisions, trip_subgroup_members and trip_meeting_checkpoint_participants have none (42703), so every
 *       operational read refused. Proved open, and every door behind it served: /today, freedom windows, health and
 *       the switch Compass reads, the decision ledger, reservation history + If-Match + cancel-not-delete, and the
 *       offline bundle's commitments and meeting points.
 *   C   four doors sent a LABEL as the kernel's uuid correlation id: closeout answers, /regroup, meeting arrival and
 *       meeting close all came back TRIP_COMMAND_MALFORMED. Proved through the kernel, each with its event.
 *   K   the cutover itself (POST /trips, the plan route's ADD/MOVE/CONFIRM, If-Match) was already sound: kept here as
 *       the baseline the other cases build on.
 *
 * FALSIFIED BY `TRIPS_PRESS_ARM=pre-press`: the same chain and the same 383 flags, except trip_kernel_enabled and
 * trip_operational_projections_enabled FALSE (production before 2026-10-23 10:02:06Z). G, C and K fail there.
 *
 * Run (loopback; unsandboxed):
 *   PGTZ=UTC LOCAL_DB_URL=postgresql://postgres@127.0.0.1:<port>/portava_local \
 *     node --import tsx/esm --test src/test/db/tripsPressedProduction.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRESSED_SKIP_REASON, openPressedLayoverDb, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { startPressedLayoverApp, type PressedApp } from "./pressedLayoverApp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/productionFeatureFlags20261024.json");
const ARM = process.env["TRIPS_PRESS_ARM"] === "pre-press" ? "pre-press" : "production";
const TRIP_FLAGS = ["trip_kernel_enabled", "trip_operational_projections_enabled"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Production's 383 flags, refused unless they hash to the digest production computed itself. */
function productionFlags(): Record<string, boolean> {
  const cap = JSON.parse(readFileSync(FIXTURE, "utf8")) as { digest: string; flags: Record<string, boolean> };
  const names = Object.keys(cap.flags).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); // COLLATE "C"
  const digest = createHash("md5").update(names.map((f) => `${f}=${cap.flags[f] === true}`).join(",")).digest("hex");
  if (digest !== cap.digest) throw new Error(`flag capture digest ${digest} != ${cap.digest}`);
  return cap.flags;
}

const DAY = 86_400_000;
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const at = (offsetMinutes: number) => new Date(Date.now() + offsetMinutes * 60_000).toISOString();

let db: PressedDb;
let app: PressedApp;
let owner: PressedUser;
let mate: PressedUser;
let stranger: PressedUser;
const seeded: Record<string, boolean | "absent"> = {};

async function createTrip(u: PressedUser, startOffset: number, endOffset: number, title = "pressed"): Promise<string> {
  const r = await app.call("POST", "/api/trips", u, { title, destinationCity: "Lisbon", destinationCountry: "Portugal", startDate: isoDate(startOffset), endDate: isoDate(endOffset), visibility: "private" });
  assert.equal(r.status, 201, `POST /trips: ${r.raw}`);
  const id = r.body?.id ?? r.body?.trip?.id;
  assert.match(String(id), UUID, `no trip id in ${r.raw}`);
  return String(id);
}
async function addPlan(u: PressedUser, tripId: string, body: Record<string, unknown>): Promise<{ status: number; id: string; raw: string }> {
  const r = await app.call("POST", `/api/trips/${tripId}/plan/items`, u, { title: "Museum", category: "activity", status: "tentative", ...body });
  return { status: r.status, id: String(r.body?.id ?? ""), raw: r.raw };
}
async function command(u: PressedUser, tripId: string, type: string, payload: Record<string, unknown>): Promise<{ status: number; body: any; raw: string }> {
  return app.call("POST", `/api/trips/${tripId}/commands`, u, { type, payload, idempotency_key: `pressed:${randomUUID()}` });
}
/** A second accepted member, through the kernel's own invite and accept. */
async function addMember(tripId: string, u: PressedUser): Promise<void> {
  const { executeTripCommand } = await import("../../domain/trips/commands/tripKernel.js");
  const inv = await executeTripCommand(db.client, { commandId: randomUUID(), tripId, actorUserId: owner.id, idempotencyKey: randomUUID(), type: "INVITE_PARTICIPANT", payload: { user_id: u.id } });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const acc = await executeTripCommand(db.client, { commandId: randomUUID(), tripId, actorUserId: u.id, idempotencyKey: randomUUID(), type: "ACCEPT_INVITE", payload: {} });
  assert.equal(acc.ok, true, JSON.stringify(acc));
}
const events = (tripId: string) => db.query<{ event_type: string; aggregate_version: number; sequence: number; schema_version: number; correlation_id: string | null }>(
  `SELECT type AS event_type, aggregate_version::int, sequence::int, schema_version::int, correlation_id::text FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY sequence`);
const version = async (tripId: string) => Number((await db.query<{ v: number }>(`SELECT version::int AS v FROM public.trips WHERE id = '${tripId}'`))[0]?.v);

/** An Etc/GMT zone whose local hour is `hour` right now (offsets −12…+14 cover every target). */
function zoneAtLocalHour(hour: number): { zone: string; localDate: (offsetDays: number) => string } {
  const now = new Date();
  let k = ((hour - now.getUTCHours()) % 24 + 24) % 24;
  if (k > 14) k -= 24;
  const zone = k === 0 ? "UTC" : k > 0 ? `Etc/GMT-${k}` : `Etc/GMT+${-k}`;
  const localDate = (offsetDays: number) => new Date(now.getTime() + k * 3_600_000 + offsetDays * DAY).toISOString().slice(0, 10);
  return { zone, localDate };
}
async function tripInZone(u: PressedUser, zone: string, start: string, end: string, title: string): Promise<string> {
  const id = await createTrip(u, -1, 1, title);
  await db.exec(`UPDATE public.trips SET timezone = '${zone}', start_date = '${start}', end_date = '${end}' WHERE id = '${id}'`);
  return id;
}
async function resetGate(): Promise<void> {
  const { invalidateTripOperationalProjectionsGate } = await import("../../domain/trips/policies/tripOperationalProjections.js");
  invalidateTripOperationalProjectionsGate();
}
async function get(u: PressedUser, path: string): Promise<{ status: number; body: any; raw: string }> {
  await resetGate();
  return app.call("GET", path, u);
}
async function waitFor<T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 40; i++) { const v = await read(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${what}`);
}

describe(`Trips in production's flag state — the 2026-10-24 hotfix [${ARM}]`, { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    const flags = productionFlags();
    db = await openPressedLayoverDb();
    for (const f of TRIP_FLAGS) seeded[f] = await db.flag(f);
    await db.setFlags(ARM === "pre-press" ? { ...flags, trip_kernel_enabled: false, trip_operational_projections_enabled: false } : flags);
    process.env["SESSION_SECRET"] ??= "pressed-layover-session-secret";
    const routers = await Promise.all([
      import("../../routes/trips.js"), import("../../routes/tripFeasibility.js"), import("../../routes/tripOffline.js"),
      import("../../routes/tripMeetingCheckpoints.js"), import("../../routes/tripPostTrip.js"), import("../../routes/tripPresence.js"),
      import("../../routes/tripDecisions.js"), import("../../routes/tripStructure.js"),
      import("../../server/trips/readRoutes/tripMapProjection.js"), import("../../server/trips/readRoutes/tripProjections.js"),
      import("../../server/trips/commandRoute.js"), import("../../routes/tripReservations.js"),
    ]);
    app = await startPressedLayoverApp(db, { extraRouters: routers.map((m: any) => m.default) });
    await resetGate();
    owner = await db.seedUser("trips_press_owner");
    mate = await db.seedUser("trips_press_mate");
    stranger = await db.seedUser("trips_press_stranger");
  });
  after(async () => { await app?.close(); await db?.close(); });

  it("S0 the state is production's: the capture hashes to production's own digest, both Trips flags TRUE in it, and the chain seeds both FALSE", async () => {
    const flags = productionFlags();
    assert.equal(Object.keys(flags).length, 383);
    assert.equal(Object.values(flags).filter((v) => v === true).length, 304);
    for (const f of TRIP_FLAGS) {
      assert.equal(flags[f], true, `${f} in production`);
      assert.equal(seeded[f], false, `${f} as the chain seeds it`);
      assert.equal(await db.flag(f), ARM !== "pre-press", `${f} in this arm`);
    }
  });

  // ── G: the operational gate, and every door behind it ─────────────────────
  it("G0 the operational gate OPENS on production's chain under production's flags (every probe column exists)", async () => {
    await resetGate();
    const { tripOperationalProjectionsGate } = await import("../../domain/trips/policies/tripOperationalProjections.js");
    const gate = await tripOperationalProjectionsGate(db.client);
    assert.deepEqual(gate, { enabled: true }, JSON.stringify(gate));
  });

  it("G1 /today serves the §3.2 phase (ARRIVAL_DAY, DEPARTURE_DAY, ACTIVE_PLAN) and records the decision in trip_decisions, explained from the table", async () => {
    const z = zoneAtLocalHour(12);
    const arrival = await tripInZone(owner, z.zone, z.localDate(0), z.localDate(2), "G1a");
    const a = await get(owner, `/api/trips/${arrival}/today`);
    assert.equal(a.status, 200, a.raw.slice(0, 400));
    assert.equal(a.body.nowState?.phase, "ARRIVAL_DAY", a.raw.slice(0, 400));
    const departure = await tripInZone(owner, z.zone, z.localDate(-2), z.localDate(0), "G1b");
    assert.equal((await get(owner, `/api/trips/${departure}/today`)).body.nowState?.phase, "DEPARTURE_DAY");
    const mid = await tripInZone(owner, z.zone, z.localDate(-1), z.localDate(1), "G1c");
    const p = await addPlan(owner, mid, { status: "confirmed", startsAt: at(-30), endsAt: at(60), dayDate: z.localDate(0) });
    assert.equal(p.status, 201, p.raw);
    const t = await get(owner, `/api/trips/${mid}/today`);
    assert.equal(t.body.nowState?.phase, "ACTIVE_PLAN", t.raw.slice(0, 400));
    assert.equal(t.body.nowState?.evidence?.activePlanId, p.id);
    const decisionId = String(t.body.decisionId);
    const row = await waitFor(async () => (await db.query<{ decision_type: string; source_trip_version: number; inputs_json: unknown }>(
      `SELECT decision_type, source_trip_version::int, inputs_json FROM public.trip_decisions WHERE decision_id = '${decisionId}'`))[0], "the trip_decisions row");
    assert.equal(row.decision_type, "today_projection");
    assert.equal(row.source_trip_version, await version(mid));
    const { _resetTripDecisionLedger } = await import("../../domain/trips/services/TripDecisionLedger.js");
    _resetTripDecisionLedger();
    const e = await get(owner, `/api/trips/${mid}/decisions/${decisionId}/explain`);
    assert.equal(e.status, 200, e.raw.slice(0, 300));
    assert.deepEqual(e.body.decision.inputs, row.inputs_json, "explained from the stored inputs, not the process ring");
    assert.equal((await get(stranger, `/api/trips/${mid}/decisions/${decisionId}/explain`)).status, 403, "a stranger is not the crew");
  });

  it("G2 freedom windows and health are served; a realised risk makes the trip DISRUPTED and the switch Compass reads is CONSULTED and suppresses discovery", async () => {
    const z = zoneAtLocalHour(12);
    const t = await tripInZone(owner, z.zone, z.localDate(-1), z.localDate(1), "G2");
    const c = await command(owner, t, "ADD_COMMITMENT", { type: "booking", starts_at: at(240), required_arrival_at: at(230), flexibility: "fixed" });
    assert.equal(c.status, 200, c.raw);
    const fw = await get(owner, `/api/trips/${t}/freedom-windows`);
    assert.equal(fw.status, 200, fw.raw.slice(0, 300));
    assert.ok(Array.isArray(fw.body.windows), fw.raw.slice(0, 300));
    const h0 = await get(owner, `/api/trips/${t}/health`);
    assert.equal(h0.status, 200, h0.raw.slice(0, 300));
    const risk = await command(owner, t, "ADD_RISK", { likelihood: "high", impact: "high" });
    assert.equal(risk.status, 200, risk.raw);
    assert.equal((await command(owner, t, "UPDATE_RISK", { risk_id: risk.body.result.id, patch: { status: "realised" } })).status, 200);
    const h = await get(owner, `/api/trips/${t}/health`);
    assert.equal(h.status, 200, h.raw.slice(0, 300));
    assert.equal(h.body.phase?.phase ?? h.body.nowState?.phase, "DISRUPTED", h.raw.slice(0, 400));
    await resetGate();
    const { readTripAttention } = await import("../../domain/trips/policies/TripAttentionFilter.js");
    const reading: any = await readTripAttention(db.client, t, owner.id);
    assert.equal(reading.consulted, true, `Compass's switch was not consulted: ${JSON.stringify(reading)}`);
    assert.equal(reading.suppression?.discovery ?? reading.suppressed, true, `a disrupted trip did not suppress discovery: ${JSON.stringify(reading)}`);
  });

  it("G3 reservations: a stale If-Match is TRIP_VERSION_CONFLICT and writes nothing; DELETE cancels and keeps history, never a hard delete", async () => {
    const t = await createTrip(owner, 1, 4, "G3");
    const c = await app.call("POST", `/api/trips/${t}/reservations`, owner, { type: "stay", title: "Hotel", startsAt: `${isoDate(1)}T15:00:00.000Z` });
    assert.equal(c.status, 201, c.raw);
    const id = String(c.body.reservation.id); const v = Number(c.body.reservation.version);
    await resetGate();
    const stale = await app.call("PATCH", `/api/trips/${t}/reservations/${id}`, owner, { title: "Stale" }, { "if-match": String(v + 5) });
    assert.equal(stale.status, 409, `a stale If-Match was accepted: ${stale.raw.slice(0, 300)}`);
    assert.match(stale.raw, /TRIP_VERSION_CONFLICT/);
    assert.equal((await db.query<{ title: string }>(`SELECT title FROM public.trip_reservations WHERE id = '${id}'`))[0]!.title, "Hotel", "the stale edit wrote");
    const fresh = await app.call("PATCH", `/api/trips/${t}/reservations/${id}`, owner, { title: "Hotel, renamed" }, { "if-match": String(v) });
    assert.equal(fresh.status, 200, fresh.raw.slice(0, 300));
    assert.equal(Number(fresh.body.reservation.version), v + 1);
    const d = await app.call("DELETE", `/api/trips/${t}/reservations/${id}`, owner);
    assert.equal(d.status, 200, `DELETE answered ${d.status} (204 is the legacy hard delete): ${d.raw.slice(0, 200)}`);
    const row = await db.query<{ status: string; cancelled_at: string | null }>(`SELECT status, cancelled_at::text FROM public.trip_reservations WHERE id = '${id}'`);
    assert.equal(row.length, 1, "the confirmed row was deleted");
    assert.equal(row[0]!.status, "cancelled"); assert.ok(row[0]!.cancelled_at);
    assert.ok((await db.query(`SELECT 1 FROM public.trip_reservation_events WHERE reservation_id = '${id}'`)).length >= 1, "no history");
  });

  it("G4 the offline bundle carries the next commitment and the meeting point (both read behind the gate)", async () => {
    const t = await createTrip(owner, -1, 2, "G4");
    await addMember(t, mate);
    assert.equal((await command(owner, t, "ADD_COMMITMENT", { type: "booking", starts_at: at(240), required_arrival_at: at(230) })).status, 200);
    const g = await app.call("POST", `/api/trips/${t}/regroup`, owner, { point: { lat: 38.7139, lng: -9.1394, label: "Rossio fountain" }, meetAt: at(60), purpose: "regroup", participantIds: [owner.id, mate.id] });
    assert.equal(g.status, 201, g.raw.slice(0, 400));
    const b = await get(owner, `/api/trips/${t}/offline-bundle`);
    assert.equal(b.status, 200, b.raw.slice(0, 300));
    const contents = b.body.bundle?.contents ?? b.body.contents;
    assert.ok(JSON.stringify(contents?.meetingPoints ?? []).includes("Rossio fountain"), `meeting points: ${JSON.stringify(contents?.meetingPoints)}`);
    assert.ok((contents?.nextCommitments ?? []).length >= 1, `next commitments: ${JSON.stringify(contents?.nextCommitments)} (${b.raw.slice(0, 300)})`);
  });

  // ── C: the four doors that sent a label as the correlation id ────────────
  it("C1 a closeout answer is RECORD_OUTCOME through the kernel: one trip_outcomes row, a uuid correlation id shared by the trip's answers", async () => {
    const t = await createTrip(owner, -4, -1, "C1");
    const p1 = await addPlan(owner, t, { status: "confirmed", dayDate: isoDate(-2), startsAt: `${isoDate(-2)}T10:00:00.000Z`, endsAt: `${isoDate(-2)}T12:00:00.000Z` });
    const p2 = await addPlan(owner, t, { title: "Walk", status: "confirmed", dayDate: isoDate(-2), startsAt: `${isoDate(-2)}T14:00:00.000Z`, endsAt: `${isoDate(-2)}T15:00:00.000Z` });
    assert.equal(p1.status, 201, p1.raw); assert.equal(p2.status, 201, p2.raw);
    const a1 = await app.call("POST", `/api/trips/${t}/closeout/answers`, owner, { planId: p1.id, answer: "completed" });
    assert.ok(a1.status === 200 || a1.status === 201, a1.raw.slice(0, 300));
    const a2 = await app.call("POST", `/api/trips/${t}/closeout/answers`, owner, { planId: p2.id, answer: "skipped" });
    assert.ok(a2.status === 200 || a2.status === 201, a2.raw.slice(0, 300));
    const rows = await db.query<{ outcome_type: string; plan_id: string }>(`SELECT outcome_type, plan_id::text FROM public.trip_outcomes WHERE trip_id = '${t}' ORDER BY outcome_type`);
    assert.deepEqual(rows.map((r) => [r.plan_id, r.outcome_type]).sort(), [[p1.id, "completed"], [p2.id, "skipped"]].sort());
    const ev = (await events(t)).filter((e) => e.event_type === "trip.outcome_recorded" || /outcome/.test(e.event_type));
    assert.equal(ev.length, 2, JSON.stringify(await events(t)));
    assert.match(String(ev[0]!.correlation_id), UUID); assert.equal(ev[0]!.correlation_id, ev[1]!.correlation_id, "one closeout, one correlation");
    const again = await app.call("POST", `/api/trips/${t}/closeout/answers`, owner, { planId: p1.id, answer: "completed" });
    assert.ok(again.status === 200 || again.status === 201, again.raw.slice(0, 300));
    assert.equal((await db.query(`SELECT 1 FROM public.trip_outcomes WHERE trip_id = '${t}'`)).length, 2, "the same answer twice is one outcome");
  });

  it("C2 /regroup creates the checkpoint through the kernel; arrival and close follow it, each an event under the checkpoint's uuid correlation", async () => {
    const t = await createTrip(owner, -1, 2, "C2");
    await addMember(t, mate);
    const g = await app.call("POST", `/api/trips/${t}/regroup`, owner, { point: { lat: 38.7139, lng: -9.1394, label: "Praça do Comércio" }, meetAt: at(45), purpose: "regroup", participantIds: [owner.id, mate.id] });
    assert.equal(g.status, 201, g.raw.slice(0, 400));
    const cp = String(g.body.checkpoint?.id ?? (await db.query<{ id: string }>(`SELECT id FROM public.trip_meeting_checkpoints WHERE trip_id = '${t}'`))[0]?.id);
    assert.match(cp, UUID);
    const arr = await app.call("POST", `/api/trips/${t}/meeting-checkpoints/${cp}/arrival`, mate, { arrivalState: "arrived" });
    assert.ok(arr.status === 200 || arr.status === 201, arr.raw.slice(0, 300));
    assert.equal((await db.query<{ arrival_state: string }>(`SELECT arrival_state FROM public.trip_meeting_checkpoint_participants WHERE checkpoint_id = '${cp}' AND user_id = '${mate.id}'`))[0]?.arrival_state, "arrived");
    const close = await app.call("POST", `/api/trips/${t}/meeting-checkpoints/${cp}/close`, owner, { outcome: "met" });
    assert.ok(close.status === 200 || close.status === 201, close.raw.slice(0, 300));
    assert.notEqual((await db.query<{ status: string }>(`SELECT status FROM public.trip_meeting_checkpoints WHERE id = '${cp}'`))[0]?.status, "open", "the checkpoint was not closed");
    const ev = (await events(t)).filter((e) => /meeting|checkpoint|regroup/.test(e.event_type));
    assert.ok(ev.length >= 3, `create, arrival and close each emit: ${JSON.stringify(await events(t))}`);
    for (const e of ev) assert.match(String(e.correlation_id), UUID, `a meeting event carries no uuid correlation: ${JSON.stringify(e)}`);
    const own = ev.filter((e) => e.event_type !== ev[0]!.event_type);
    assert.equal(new Set(own.map((e) => e.correlation_id)).size, 1, "arrival and close of one checkpoint correlate");
    assert.equal((await app.call("POST", `/api/trips/${t}/meeting-checkpoints/${cp}/arrival`, stranger, { arrivalState: "arrived" })).status >= 400, true, "a stranger may not arrive at the crew's checkpoint");
  });

  it("C3 a non-uuid correlation_id at the command door is refused 400 before the kernel, and a uuid one is carried onto the event", async () => {
    const t = await createTrip(owner, 1, 3, "C3");
    const bad = await app.call("POST", `/api/trips/${t}/commands`, owner, { type: "ADD_RISK", payload: { likelihood: "low", impact: "low" }, idempotency_key: `k:${randomUUID()}`, correlation_id: "closeout:label" });
    assert.equal(bad.status, 400, bad.raw);
    const corr = randomUUID();
    const ok = await app.call("POST", `/api/trips/${t}/commands`, owner, { type: "ADD_RISK", payload: { likelihood: "low", impact: "low" }, idempotency_key: `k:${randomUUID()}`, correlation_id: corr });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal((await events(t)).at(-1)?.correlation_id, corr);
  });

  // ── K: the cutover baseline ───────────────────────────────────────────────
  it("K1 POST /trips is CREATE_TRIP through the kernel, and the plan route issues ADD_PLAN, MOVE_PLAN and CONFIRM_PLAN, each an event at the next version with its outbox row and receipt", async () => {
    const tripId = await createTrip(owner, 0, 3, "K1");
    assert.equal(await version(tripId), 1);
    const added = await addPlan(owner, tripId, { dayDate: isoDate(1), startsAt: `${isoDate(1)}T10:00:00.000Z`, endsAt: `${isoDate(1)}T12:00:00.000Z` });
    assert.equal(added.status, 201, added.raw);
    assert.equal((await app.call("PATCH", `/api/trips/${tripId}/plan/items/${added.id}`, owner, { startsAt: `${isoDate(1)}T14:00:00.000Z`, endsAt: `${isoDate(1)}T16:00:00.000Z` })).status, 200);
    assert.equal((await app.call("PATCH", `/api/trips/${tripId}/plan/items/${added.id}`, owner, { status: "confirmed" })).status, 200);
    const ev = await events(tripId);
    assert.deepEqual(ev.map((e) => e.event_type), ["trip.created", "trip.plan_added", "trip.plan_moved", "trip.plan_confirmed"]);
    assert.deepEqual(ev.map((e) => e.aggregate_version), [1, 2, 3, 4]);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.trip_outbox o JOIN public.trip_events e ON e.event_id = o.event_id WHERE e.trip_id = '${tripId}'`))[0]!.n, 4);
    assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.trip_command_receipts WHERE trip_id = '${tripId}'`))[0]!.n, 4);
    const stale = await app.call("PATCH", `/api/trips/${tripId}/plan/items/${added.id}`, owner, { title: "stale" }, { "if-match": "2" });
    assert.equal(stale.status, 409, stale.raw);
    assert.equal(await version(tripId), 4, "a stale If-Match moved the trip");
  });
});
