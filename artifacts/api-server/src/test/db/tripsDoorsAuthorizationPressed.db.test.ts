/**
 * The Trips doors that #797 opened on production, PRESSED: the deployed Trips routers over the replayed chain, under
 * production's own 383-flag capture (test/fixtures/productionFeatureFlags20261024.json, refused unless it hashes to
 * the digest production computed itself). Adopted from the #797 verifier's own suite, with its debug logging removed,
 * plus the three live follow-ups the verifier found (follow-up hotfix, 2026-10-24).
 *
 * AUTHORIZATION (the verifier's eight). Every refusal has a positive control, so none can pass because a door is shut
 * for everyone:
 *   V1  every gated read is served to the owner AND an accepted member (the control).
 *   V2  a stranger, a pending invitee and a member who LEFT get nothing from /today, health, freedom windows, the
 *       decision ledger, the offline bundle, reservations or a reservation's history, and no secret leaks.
 *   V3  cross-trip IDOR: trip B's owner cannot reach trip A's decision, reservation or history through trip B's path.
 *   V4  a plain member and a co-host may not cancel (nor the member edit) the owner's reservation; nothing is written.
 *   V5  strangers write nothing: DELETE, PATCH, POST /commands (a valid uuid correlation) and the offline queue.
 *   V6  the control for V4: a member cancels their OWN reservation, with history; the owner may cancel a member's.
 *   V7  the gate REFUSES when a required table is truly absent: /today is not served (last: it drops a table).
 *   V8  no GET moves trips.version (today, freedom windows, health, the bundle, pulse, opportunities).
 *
 * THE FOLLOW-UPS:
 *   F1  the FIRST /today on a trip WITH commitments is a 200, not 503 TRIP_PROJECTION_VERSION_AHEAD, and viewing it
 *       leaves a plan edit's If-Match valid (a GET must not move the version a client edits against).
 *   F2  a reservation DELETE while the gate is closed with the flag ON (here a transient probe error) is a retryable
 *       503 and destroys nothing; it never falls back to the flag-off hard delete. The same holds when the FLAG READ
 *       itself fails (fix to #803, verifier finding 1): an unreadable flag is `flag_unknown`, never `flag_off`.
 *   F3  the trip chat takes its owner, under the production CHECK (role member | admin): the owner is the thread's
 *       admin, an accepted member a member, and a pending invitee is not in the chat until they accept.
 *
 * Run (loopback; unsandboxed):
 *   PGTZ=UTC LOCAL_DB_URL=postgresql://postgres@127.0.0.1:<port>/portava_local \
 *     node --import tsx/esm --test src/test/db/tripsDoorsAuthorizationPressed.db.test.ts
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const isoDate = (o: number) => new Date(Date.now() + o * DAY).toISOString().slice(0, 10);
const at = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const SECRET_TRIP = "secret-trip-v797";
const SECRET_HOTEL = "SecretHotel-v797";

function productionFlags(): Record<string, boolean> {
  const cap = JSON.parse(readFileSync(FIXTURE, "utf8")) as { digest: string; flags: Record<string, boolean> };
  const names = Object.keys(cap.flags).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); // COLLATE "C"
  const digest = createHash("md5").update(names.map((f) => `${f}=${cap.flags[f] === true}`).join(",")).digest("hex");
  if (digest !== cap.digest) throw new Error(`flag capture digest ${digest} != ${cap.digest}`);
  return cap.flags;
}

let db: PressedDb; let app: PressedApp;
let owner: PressedUser, mate: PressedUser, cohost: PressedUser, pending: PressedUser, leaver: PressedUser, stranger: PressedUser, other: PressedUser;
let tripA = ""; let tripB = ""; let decisionA = ""; let resOwner = ""; let resMateA = ""; let resMateB = ""; let resB = "";
let firstToday: { status: number; raw: string } = { status: 0, raw: "" };
let versionBeforeFirstToday = -1; let versionAfterFirstToday = -1;

async function resetGate() { (await import("../../domain/trips/policies/tripOperationalProjections.js")).invalidateTripOperationalProjectionsGate(); }
async function resetProbes() { (await import("../../lib/capability/schemaCapability.js")).resetSchemaCapabilityMemo(); await resetGate(); }
async function get(u: PressedUser, p: string) { await resetGate(); return app.call("GET", p, u); }
async function kernel(tripId: string, actor: string, type: string, payload: Record<string, unknown>) {
  const { executeTripCommand } = await import("../../domain/trips/commands/tripKernel.js");
  const r = await executeTripCommand(db.client, { commandId: randomUUID(), tripId, actorUserId: actor, idempotencyKey: randomUUID(), type: type as any, payload });
  assert.equal(r.ok, true, JSON.stringify(r));
}
async function createTrip(u: PressedUser, title: string) {
  const r = await app.call("POST", "/api/trips", u, { title, destinationCity: "Lisbon", destinationCountry: "Portugal", startDate: isoDate(-1), endDate: isoDate(2), visibility: "private" });
  assert.equal(r.status, 201, r.raw); const id = String(r.body?.id ?? r.body?.trip?.id); assert.match(id, UUID); return id;
}
async function reserve(u: PressedUser, tripId: string, title: string) {
  const r = await app.call("POST", `/api/trips/${tripId}/reservations`, u, { type: "stay", title, startsAt: `${isoDate(1)}T15:00:00.000Z` });
  assert.equal(r.status, 201, r.raw); return String(r.body.reservation.id);
}
const resRow = async (id: string) => (await db.query<{ status: string; title: string; version: number }>(`SELECT status, title, version::int FROM public.trip_reservations WHERE id = '${id}'`))[0];
const resEvents = async (id: string) => Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.trip_reservation_events WHERE reservation_id = '${id}'`))[0]!.n);
const tripVersion = async (id: string) => Number((await db.query<{ v: number }>(`SELECT version::int AS v FROM public.trips WHERE id = '${id}'`))[0]!.v);

describe("the Trips doors #797 opened, in production's flag state: authorization and the three follow-ups", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openPressedLayoverDb();
    await db.setFlags(productionFlags());
    process.env["SESSION_SECRET"] ??= "pressed-layover-session-secret";
    const routers = await Promise.all([
      import("../../routes/trips.js"), import("../../routes/tripOffline.js"), import("../../routes/tripMeetingCheckpoints.js"),
      import("../../routes/tripPostTrip.js"), import("../../routes/tripDecisions.js"), import("../../routes/tripStructure.js"),
      import("../../server/trips/readRoutes/tripProjections.js"), import("../../server/trips/commandRoute.js"), import("../../routes/tripReservations.js"),
    ]);
    app = await startPressedLayoverApp(db, { extraRouters: routers.map((m: any) => m.default) });
    owner = await db.seedUser("v797_owner"); mate = await db.seedUser("v797_mate"); cohost = await db.seedUser("v797_cohost");
    pending = await db.seedUser("v797_pending"); leaver = await db.seedUser("v797_leaver"); stranger = await db.seedUser("v797_stranger"); other = await db.seedUser("v797_other");
    tripA = await createTrip(owner, SECRET_TRIP);
    for (const u of [mate, cohost, leaver]) { await kernel(tripA, owner.id, "INVITE_PARTICIPANT", { user_id: u.id }); await kernel(tripA, u.id, "ACCEPT_INVITE", {}); }
    await kernel(tripA, owner.id, "INVITE_PARTICIPANT", { user_id: pending.id });
    await db.exec(`UPDATE public.trip_members SET role = 'co_host' WHERE trip_id = '${tripA}' AND user_id = '${cohost.id}'`);
    await db.exec(`UPDATE public.trip_members SET status = 'left' WHERE trip_id = '${tripA}' AND user_id = '${leaver.id}'`);
    await kernel(tripA, owner.id, "ADD_COMMITMENT", { type: "booking", starts_at: at(240), required_arrival_at: at(230) });
    resOwner = await reserve(owner, tripA, SECRET_HOTEL);
    resMateA = await reserve(mate, tripA, "mate-own-A"); resMateB = await reserve(mate, tripA, "mate-own-B");
    // F1's measurement is taken here, on the FIRST read of a trip with a commitment, before any other read warms anything.
    versionBeforeFirstToday = await tripVersion(tripA);
    const t = await get(owner, `/api/trips/${tripA}/today`);
    firstToday = { status: t.status, raw: t.raw };
    versionAfterFirstToday = await tripVersion(tripA);
    assert.equal(t.status, 200, `the first /today: ${t.raw.slice(0, 300)}`);
    decisionA = String(t.body.decisionId); assert.match(decisionA, UUID);
    tripB = await createTrip(other, "other-trip-v797");
    resB = await reserve(other, tripB, "other-hotel");
  });
  after(async () => { await app?.close(); await db?.close(); });

  const READS = () => [
    `/api/trips/${tripA}/today`, `/api/trips/${tripA}/health`, `/api/trips/${tripA}/freedom-windows`, `/api/trips/${tripA}/decisions`,
    `/api/trips/${tripA}/offline-bundle`, `/api/trips/${tripA}/reservations`, `/api/trips/${tripA}/reservations/${resOwner}/history`,
    `/api/trips/${tripA}/decisions/${decisionA}/explain`,
  ];

  it("V1 every gated read is served to the owner AND an accepted member (positive control)", async () => {
    for (const u of [owner, mate]) for (const p of READS()) {
      const r = await get(u, p);
      assert.equal(r.status, 200, `${u.handle} ${p}: ${r.status} ${r.raw.slice(0, 200)}`);
    }
  });

  it("V2 a stranger, a pending invitee and a member who LEFT get nothing from /today, health, freedom windows, the ledger, the bundle, reservations or history", async () => {
    for (const u of [stranger, pending, leaver]) for (const p of READS()) {
      const r = await get(u, p);
      assert.ok(r.status === 403 || r.status === 404, `${u.handle} ${p}: ${r.status} ${r.raw.slice(0, 200)}`);
      for (const s of [SECRET_TRIP, SECRET_HOTEL, `"decisionId":"${decisionA}"`]) assert.ok(!r.raw.includes(s), `${u.handle} ${p} leaked ${s}`);
    }
  });

  it("V3 cross-trip IDOR: the owner of trip B cannot reach trip A's decision, reservation or history through trip B's path", async () => {
    const e = await get(other, `/api/trips/${tripB}/decisions/${decisionA}/explain`);
    assert.equal(e.status, 404, e.raw.slice(0, 200));
    const h = await get(other, `/api/trips/${tripB}/reservations/${resOwner}/history`);
    assert.equal(h.status, 404, h.raw.slice(0, 200));
    const before = await resRow(resOwner); const evBefore = await resEvents(resOwner);
    await resetGate();
    const d = await app.call("DELETE", `/api/trips/${tripB}/reservations/${resOwner}`, other);
    assert.equal(d.status, 404, d.raw.slice(0, 200));
    await resetGate();
    const p = await app.call("PATCH", `/api/trips/${tripB}/reservations/${resOwner}`, other, { title: "pwned" }, { "if-match": String(before!.version) });
    assert.equal(p.status, 404, p.raw.slice(0, 200));
    assert.deepEqual(await resRow(resOwner), before); assert.equal(await resEvents(resOwner), evBefore);
  });

  it("V4 a plain member and a co-host may NOT cancel (or, for the member, edit) the owner's reservation; nothing is written", async () => {
    const before = await resRow(resOwner); const evBefore = await resEvents(resOwner);
    for (const u of [mate, cohost]) {
      await resetGate();
      const d = await app.call("DELETE", `/api/trips/${tripA}/reservations/${resOwner}`, u);
      assert.equal(d.status, 403, `${u.handle} DELETE: ${d.raw.slice(0, 200)}`);
    }
    await resetGate();
    const p = await app.call("PATCH", `/api/trips/${tripA}/reservations/${resOwner}`, mate, { title: "mate-edit" }, { "if-match": String(before!.version) });
    assert.equal(p.status, 403, p.raw.slice(0, 200));
    assert.deepEqual(await resRow(resOwner), before, "a refused write changed the row");
    assert.equal(await resEvents(resOwner), evBefore, "a refused write appended history");
  });

  it("V5 strangers write nothing: DELETE, PATCH, POST /commands (valid uuid correlation) and the offline queue are refused", async () => {
    const before = await resRow(resOwner); const vBefore = await tripVersion(tripA);
    await resetGate();
    assert.equal((await app.call("DELETE", `/api/trips/${tripA}/reservations/${resOwner}`, stranger)).status, 403);
    await resetGate();
    assert.equal((await app.call("PATCH", `/api/trips/${tripA}/reservations/${resOwner}`, stranger, { title: "x" }, { "if-match": String(before!.version) })).status, 403);
    const c = await app.call("POST", `/api/trips/${tripA}/commands`, stranger, { type: "ADD_RISK", payload: { likelihood: "low", impact: "low" }, idempotency_key: `v:${randomUUID()}`, correlation_id: randomUUID() });
    assert.equal(c.status, 403, c.raw.slice(0, 200));
    const q = await app.call("POST", `/api/trips/${tripA}/operations`, stranger, { operations: [{ operationId: randomUUID(), tripId: tripA, type: "ADD_RISK", payload: { likelihood: "low", impact: "low" }, idempotencyKey: `v:${randomUUID()}`, clientOccurredAt: new Date().toISOString() }] });
    assert.equal(q.status, 403, `${q.status} ${q.raw.slice(0, 200)}`);
    assert.deepEqual(await resRow(resOwner), before);
    assert.equal(await tripVersion(tripA), vBefore, "a stranger moved the trip");
  });

  it("V6 positive control for V4: a member cancels their OWN reservation (with history); the owner may cancel a member's", async () => {
    await resetGate();
    const own = await app.call("DELETE", `/api/trips/${tripA}/reservations/${resMateA}`, mate);
    assert.equal(own.status, 200, own.raw.slice(0, 200)); assert.equal((await resRow(resMateA))!.status, "cancelled");
    assert.ok((await resEvents(resMateA)) >= 1);
    await resetGate();
    const byOwner = await app.call("DELETE", `/api/trips/${tripA}/reservations/${resMateB}`, owner);
    assert.equal(byOwner.status, 200, byOwner.raw.slice(0, 200)); assert.equal((await resRow(resMateB))!.status, "cancelled");
    assert.ok(resB.length > 0);
  });

  it("V8 no GET moves trips.version: today ×3, freedom windows ×2, health, the offline bundle, pulse and opportunities", async () => {
    const v0 = await tripVersion(tripA);
    for (const p of ["today", "today", "today", "freedom-windows", "freedom-windows", "health", "offline-bundle", "pulse", "opportunities"]) {
      const r = await get(owner, `/api/trips/${tripA}/${p}`);
      assert.ok(r.status === 200, `${p}: ${r.status} ${r.raw.slice(0, 200)}`);
      assert.equal(await tripVersion(tripA), v0, `GET /${p} moved trips.version`);
    }
    const derived = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.trip_events WHERE trip_id = '${tripA}' AND type IN ('trip.free_window_created', 'trip.commitment_at_risk', 'trip.opportunities_changed')`);
    assert.equal(derived[0]!.n, 0, "a read recorded a derived event");
  });

  it("F1 the FIRST /today on a trip with commitments is a 200, it does not move trips.version, and a plan edit's If-Match survives viewing it", async () => {
    assert.equal(firstToday.status, 200, `the first /today: ${firstToday.raw.slice(0, 300)}`);
    assert.equal(versionAfterFirstToday, versionBeforeFirstToday, "the first /today moved trips.version");
    const c = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.trip_commitments WHERE trip_id = '${tripA}'`);
    assert.ok(c[0]!.n >= 1, "the trip has no commitment, so this proves nothing");
    const add = await app.call("POST", `/api/trips/${tripA}/plan/items`, owner, { title: "Museum", category: "activity", status: "tentative", dayDate: isoDate(1), startsAt: `${isoDate(1)}T10:00:00.000Z`, endsAt: `${isoDate(1)}T12:00:00.000Z` });
    assert.equal(add.status, 201, add.raw);
    const v = await tripVersion(tripA);
    for (const p of ["today", "freedom-windows", "health"]) assert.equal((await get(mate, `/api/trips/${tripA}/${p}`)).status, 200);
    const edit = await app.call("PATCH", `/api/trips/${tripA}/plan/items/${add.body?.id}`, owner, { title: "Museum (edited)" }, { "if-match": String(v) });
    assert.equal(edit.status, 200, `an If-Match taken before viewing Today went stale: ${edit.raw.slice(0, 200)}`);
  });

  it("F2 DELETE while the gate is closed with the flag ON (a transient probe error) is a retryable 503 and destroys nothing", async () => {
    const id = await reserve(owner, tripA, "f2-keep-me");
    const before = await resRow(id); const evBefore = await resEvents(id);
    const fault = (q: { target: string; method: string }) => (q.target === "trip_meeting_checkpoint_participants" && q.method === "GET" ? { status: 503, body: { code: "XX000", message: "test: transient probe failure" } } : null);
    db.bridge.faults.push(fault as any);
    try {
      await resetProbes();
      const { tripOperationalProjectionsGate } = await import("../../domain/trips/policies/tripOperationalProjections.js");
      const gate: any = await tripOperationalProjectionsGate(db.client);
      assert.deepEqual([gate.enabled, gate.reason], [false, "schema_unknown"], JSON.stringify(gate));
      await resetProbes();
      const d = await app.call("DELETE", `/api/trips/${tripA}/reservations/${id}`, owner);
      assert.equal(d.status, 503, `a closed gate with the flag ON answered ${d.status}: ${d.raw.slice(0, 200)}`);
      assert.match(d.raw, /TRIP_PROJECTION_UNAVAILABLE/);
    } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(fault as any), 1); await resetProbes(); }
    assert.deepEqual(await resRow(id), before, "the reservation was destroyed or changed");
    assert.equal(await resEvents(id), evBefore);
    // The FLAG READ failing (only the read of this gate's flag: the route's other flags still read) is not "flag off".
    // Mutant: read the flag through isFlagEnabled (false on error) — the gate says flag_off and the DELETE is a 204
    // hard delete with the flag ON in production.
    const flagFault = (q: { target: string; method: string; params: URLSearchParams }) =>
      (q.target === "feature_flags" && q.method === "GET" && q.params.get("flag") === "eq.trip_operational_projections_enabled"
        ? { status: 503, body: { code: "XX000", message: "test: transient flag read failure" } } : null);
    db.bridge.faults.push(flagFault as any);
    try {
      await resetProbes();
      const { tripOperationalProjectionsGate } = await import("../../domain/trips/policies/tripOperationalProjections.js");
      const gate: any = await tripOperationalProjectionsGate(db.client);
      assert.deepEqual([gate.enabled, gate.reason], [false, "flag_unknown"], JSON.stringify(gate));
      await resetProbes();
      const d = await app.call("DELETE", `/api/trips/${tripA}/reservations/${id}`, owner);
      assert.equal(d.status, 503, `an unreadable flag answered ${d.status}: ${d.raw.slice(0, 200)}`);
      assert.match(d.raw, /TRIP_PROJECTION_UNAVAILABLE/);
    } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(flagFault as any), 1); await resetProbes(); }
    assert.deepEqual(await resRow(id), before, "an unreadable flag destroyed or changed the reservation");
    assert.equal(await resEvents(id), evBefore);
    const ok = await app.call("DELETE", `/api/trips/${tripA}/reservations/${id}`, owner);
    assert.equal(ok.status, 200, `control: with the gate open the same DELETE cancels: ${ok.raw.slice(0, 200)}`);
    assert.equal((await resRow(id))!.status, "cancelled");
  });

  it("F3 the trip chat takes its owner under the production CHECK: owner admin, accepted crew member, a pending invitee not until they accept", async () => {
    const check = await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'public.message_thread_members'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%role%'`);
    assert.deepEqual(check.map((c) => c.def), ["CHECK ((role = ANY (ARRAY['member'::text, 'admin'::text])))"], "the chain's CHECK is not production's");
    const host = await db.seedUser("v797_chat_owner"); const crew = await db.seedUser("v797_chat_crew"); const invitee = await db.seedUser("v797_chat_invitee");
    const trip = await createTrip(host, "chat-v797");
    await kernel(trip, host.id, "INVITE_PARTICIPANT", { user_id: crew.id }); await kernel(trip, crew.id, "ACCEPT_INVITE", {});
    await kernel(trip, host.id, "INVITE_PARTICIPANT", { user_id: invitee.id });
    // Production's own shapes (2026-10-24 read: one 'member'/'invited' row sat in a trip chat): a pending invitee whose
    // ROLE is already 'member', and a member who LEFT. Both are kept out by status, not by role.
    await db.exec(`UPDATE public.trip_members SET role = 'member', status = 'invited' WHERE trip_id = '${trip}' AND user_id = '${invitee.id}'`);
    const gone = await db.seedUser("v797_chat_left");
    await kernel(trip, host.id, "INVITE_PARTICIPANT", { user_id: gone.id }); await kernel(trip, gone.id, "ACCEPT_INVITE", {});
    await db.exec(`UPDATE public.trip_members SET status = 'left' WHERE trip_id = '${trip}' AND user_id = '${gone.id}'`);
    const roster = async () => (await db.query<{ user_id: string; role: string }>(
      `SELECT m.user_id::text, m.role FROM public.message_thread_members m JOIN public.message_threads t ON t.id = m.thread_id WHERE t.trip_id = '${trip}' AND t.thread_type = 'trip' AND m.left_at IS NULL ORDER BY m.role, m.user_id`));
    // POST /trips starts a sync of its own, fire-and-forget; let it settle first so the two do not race on one insert.
    for (let i = 0; i < 40 && !(await roster()).some((m) => m.user_id === host.id); i++) await new Promise((r) => setTimeout(r, 50));
    for (const [label, sync] of [
      ["lib/chatSync", async () => (await import("../../lib/chatSync.js")).syncTripChatMembers(trip, db.client as any)],
      ["services/groupChatSync", async () => (await import("../../services/groupChatSync.js")).syncTripChatMembers(db.client as any, trip)],
    ] as const) {
      const threadId = await sync();
      assert.match(String(threadId), UUID, `${label}: the sync refused (the owner insert failing the CHECK is how it used to end)`);
      const r = await roster();
      assert.deepEqual(r.find((m) => m.user_id === host.id)?.role, "admin", `${label}: the owner is not the chat's admin: ${JSON.stringify(r)}`);
      assert.deepEqual(r.find((m) => m.user_id === crew.id)?.role, "member", `${label}: ${JSON.stringify(r)}`);
      assert.equal(r.some((m) => m.user_id === invitee.id), false, `${label}: a pending invitee is in the crew chat`);
      assert.equal(r.some((m) => m.user_id === gone.id), false, `${label}: a member who left is in the crew chat`);
    }
    await db.exec(`UPDATE public.trip_members SET status = 'accepted' WHERE trip_id = '${trip}' AND user_id = '${invitee.id}'`); // accepted, as ACCEPT_INVITE leaves it
    await (await import("../../lib/chatSync.js")).syncTripChatMembers(trip, db.client as any);
    assert.equal((await roster()).find((m) => m.user_id === invitee.id)?.role, "member", "accepted, the invitee joins the chat");
    // fix to #803 (verifier finding 4): an owner with NO trip_members row (2337 found 5 such trips in production) is
    // still the chat's admin — requireTripMember admits them by trips.owner_id. Production's shape is an owner who never
    // had a row and so was never put into the chat: the row is deleted (its trigger ends the owner's thread membership)
    // and the owner's thread row removed, then each sync must ADD the owner as admin, and a second sync keep them.
    await db.exec(`DELETE FROM public.trip_members WHERE trip_id = '${trip}' AND user_id = '${host.id}'`);
    assert.equal((await db.query(`SELECT 1 FROM public.trip_members WHERE trip_id = '${trip}' AND user_id = '${host.id}'`)).length, 0, "the owner's membership row is still there");
    for (const [label, sync] of [
      ["lib/chatSync", async () => (await import("../../lib/chatSync.js")).syncTripChatMembers(trip, db.client as any)],
      ["services/groupChatSync", async () => (await import("../../services/groupChatSync.js")).syncTripChatMembers(db.client as any, trip)],
    ] as const) {
      await db.exec(`DELETE FROM public.message_thread_members m USING public.message_threads t WHERE t.id = m.thread_id AND t.trip_id = '${trip}' AND t.thread_type = 'trip' AND m.user_id = '${host.id}'`);
      assert.equal((await roster()).some((m) => m.user_id === host.id), false);
      assert.match(String(await sync()), UUID, `${label}: the sync refused`);
      assert.equal((await roster()).find((m) => m.user_id === host.id)?.role, "admin", `${label}: an owner with no trip_members row is not in their own chat`);
      assert.match(String(await sync()), UUID, `${label}: the second sync refused`);
      assert.equal((await roster()).find((m) => m.user_id === host.id)?.role, "admin", `${label}: a second sync evicted the owner`);
      assert.equal((await roster()).find((m) => m.user_id === crew.id)?.role, "member", `${label}: the crew member was lost`);
    }
  });

  it("F4 a cached flag OFF never authorises a hard delete: OFF read, flag flipped ON, DELETE inside the gate's TTL cancels", async () => {
    // fix to #803 (re-verification): the gate cached `flag_off` for 30 s per client, and `flag_off` is what lets DELETE
    // hard-delete. Mutant: cache `flag_off` again — the second DELETE below is a 204 and the row is gone.
    const FLAG = "trip_operational_projections_enabled";
    const scratch = await reserve(owner, tripA, "f4-scratch"); const keep = await reserve(owner, tripA, "f4-keep-me");
    await db.setFlags({ [FLAG]: false }); await resetProbes();
    try {
      // The route reads the gate itself, on its own client: the flag-off hard delete is the legitimate OFF behaviour.
      const off = await app.call("DELETE", `/api/trips/${tripA}/reservations/${scratch}`, owner);
      assert.equal(off.status, 204, `control: with the flag OFF the legacy hard delete runs: ${off.raw.slice(0, 200)}`);
    } finally { await db.exec(`UPDATE public.feature_flags SET enabled = true WHERE flag = '${FLAG}'`); }
    // NO gate reset here: the flip happens inside the TTL a cached OFF would still be served from.
    const on = await app.call("DELETE", `/api/trips/${tripA}/reservations/${keep}`, owner);
    assert.notEqual(on.status, 204, "a flag OFF cached before the flip hard-deleted the reservation after it");
    assert.equal(on.status, 200, on.raw.slice(0, 200));
    const row = await resRow(keep); assert.ok(row, "the row was destroyed"); assert.equal(row!.status, "cancelled");
  });

  it("V7 the gate REFUSES when a required table is truly absent (dropped on this isolated chain): /today is not served", async () => {
    await db.exec(`DROP TABLE public.trip_meeting_checkpoint_participants CASCADE`);
    await resetProbes();
    const { tripOperationalProjectionsGate } = await import("../../domain/trips/policies/tripOperationalProjections.js");
    const gate: any = await tripOperationalProjectionsGate(db.client);
    assert.equal(gate.enabled, false, JSON.stringify(gate));
    await resetProbes();
    const t = await get(owner, `/api/trips/${tripA}/today`);
    assert.notEqual(t.status, 200, t.raw.slice(0, 200));
    await resetProbes();
    const r = await app.call("POST", `/api/trips/${tripA}/reservations`, owner, { type: "stay", title: "after-drop", startsAt: `${isoDate(1)}T15:00:00.000Z` });
    if (r.status === 201) {
      await resetProbes();
      const closed: any = await tripOperationalProjectionsGate(db.client);
      await resetProbes();
      const d = await app.call("DELETE", `/api/trips/${tripA}/reservations/${r.body?.reservation?.id}`, owner);
      // schema_missing is a STABLE state: feature_disabled (404), as refusalForGate answers it; schema_unknown is the
      // retryable 503. Either way it is a refusal and never the 204 hard delete.
      const want = closed.reason === "schema_missing" ? 404 : 503;
      assert.equal(d.status, want, `an absent schema with the flag ON (${closed.reason}) must refuse the DELETE, not hard-delete: ${d.status} ${d.raw.slice(0, 200)}`);
      assert.equal((await db.query(`SELECT 1 FROM public.trip_reservations WHERE id = '${r.body?.reservation?.id}'`)).length, 1, "the row was destroyed");
    }
  });
});
