/**
 * Lane B1-P — §11 external events (triage press P7), PRESSED, against the real
 * migrated schema.
 *
 * Rows: L31 (layover_external_events' six members, populated by the producer
 * route), L92 (normalise + deduplicate), L93 (identify impacted active
 * sessions), L257 (validate every external payload; dedupe by stable source
 * keys), L263 (duplicate events — the unique dedup key).
 *
 * THE PRESS: 2981 (seeds `layover_event_ingest_enabled` FALSE) → flag ON, plus
 * 2986 (the airport fan-out indexes), plus `LAYOVER_EVENT_PRODUCER_SECRET`
 * provisioned in the API's environment. 2860 (the table) is applied in
 * production already. The secret here is a TEST value set in this process; no
 * upstream feed exists (named in the lane handback as the owner's dependency).
 *
 * Falsified by B1P_ARM=flag-off and B1P_ARM=absent (2981 and 2986 out of the chain).
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedExternalEvents.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { runLayoverExternalEventDrain } from "../../lib/layoverExternalEventScheduler.js";
import { drainPendingExternalEvents } from "../../services/layover/layoverExternalEventConsumer.js";
import { layoverExternalReplanPort } from "../../services/airport/LayoverExternalReplanPort.js";

const PRESS = { migrations: ["2981", "2986"], flags: { layover_event_ingest_enabled: true } } as const;
const SECRET = `b1p-test-producer-secret-${randomUUID()}`;
const HDR = { "x-layover-producer-secret": SECRET };

let db: PressedDb;
let app: PressedApp;
const sinSessions: string[] = [];
let bkkSession = "";
let seeded: boolean | "absent" = "absent";
const post = (body: unknown, headers: Record<string, string> = HDR) => app.call("POST", "/api/layover/events", null, body, headers);
const securityEvent = (over: Record<string, unknown> = {}) => ({
  eventId: `evt-${randomUUID()}`,
  eventType: "airport.security_wait_changed",
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
  source: "b1p-test-feed",
  sourceEventId: `src-${randomUUID()}`,
  subjectRefs: [{ kind: "airport", ref: "SIN" }],
  payload: { waitMinutes: 75 },
  confidence: "HIGH",
  ...over,
});
const rowByKey = (k: string) => db.query<any>(`SELECT * FROM public.layover_external_events WHERE dedup_key = '${k.replace(/'/g, "''")}'`);

describe("B1-P external events (P7)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    process.env["LAYOVER_EVENT_PRODUCER_SECRET"] = SECRET;
    db = await openForPress(PRESS);
    seeded = await db.flag("layover_event_ingest_enabled");
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    for (let i = 0; i < 3; i++) {
      const u: PressedUser = await db.seedUser(`sin${i}`);
      sinSessions.push((await startSession(app, u, { iata: "SIN" }, { departsInH: 8 })).id);
    }
    const b = await db.seedUser("bkk");
    bkkSession = (await startSession(app, b, { iata: "BKK" }, { departsInH: 8 })).id;
  });
  after(async () => { delete process.env["LAYOVER_EVENT_PRODUCER_SECRET"]; await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("E0 the press: 2981 seeds the ingest flag FALSE", () => { assert.equal(seeded, false); });

    it("E1 L31 — a producer's event lands in layover_external_events with all six spec members", async () => {
      const ev = securityEvent();
      const r = await post(ev);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.duplicate, false);
      const rows = await rowByKey(r.body.dedupKey);
      assert.equal(rows.length, 1);
      const row = rows[0];
      for (const k of ["occurred_at", "source", "source_event_id", "payload", "dedup_key", "processed_at"]) assert.ok(k in row, `L31: ${k}`);
      assert.equal(row.source, "b1p-test-feed");
      assert.equal(row.source_event_id, ev.sourceEventId);
      assert.deepEqual(row.payload, { waitMinutes: 75 });
      assert.equal(row.processed_at, null, "not yet processed");
      assert.equal(r.body.dedupKey, `b1p-test-feed:${ev.sourceEventId}`, "the stable SOURCE key is the dedup key when the producer supplies one");
    });

    it("E2 L92 L263 L257 — a re-delivery of the same fact is ONE row: by source key, and by content when no source key is given (…Z and +00:00 are one instant)", async () => {
      const ev = securityEvent();
      const a = await post(ev);
      const b = await post({ ...ev, eventId: `evt-${randomUUID()}` });
      assert.equal(b.status, 200, b.raw);
      assert.equal(b.body.duplicate, true);
      assert.equal(b.body.duplicateKind, "same_fact", "named by the unique dedup index");
      assert.equal((await rowByKey(a.body.dedupKey)).length, 1);
      const at = new Date(Date.now() - 120_000);
      const z = at.toISOString();
      const plus = z.replace("Z", "+00:00");
      const c = await post(securityEvent({ sourceEventId: undefined, occurredAt: z, payload: { waitMinutes: 40 } }));
      const d = await post(securityEvent({ sourceEventId: undefined, occurredAt: plus, payload: { waitMinutes: 40 } }));
      assert.equal(c.status, 200, c.raw);
      assert.equal(d.body.duplicate, true, `content key differs across instant spellings: ${c.body.dedupKey} vs ${d.body.dedupKey}`);
      await assert.rejects(
        db.exec(`INSERT INTO public.layover_external_events (event_id, event_type, occurred_at, received_at, source, dedup_key) VALUES ('raw-${randomUUID()}', 'airport.security_wait_changed', now(), now(), 'x', '${a.body.dedupKey}')`),
        (e: any) => e?.code === "23505", "L263: the dedup key must be UNIQUE in the table itself",
      );
    });

    it("E3 L257 — every external payload is validated, and the producer is told which validator refused it", async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [securityEvent({ eventType: "airport.teleporter_changed" }), "unknown_event_type"],
        [securityEvent({ payload: { waitMinutes: "lots" } }), "bad_payload"],
        [securityEvent({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }), "occurred_in_future"],
        [securityEvent({ subjectRefs: [] }), "no_subject"],
        [securityEvent({ confidence: "CERTAIN" }), "bad_confidence"],
      ];
      const before = (await db.query<any>("SELECT count(*)::int AS n FROM public.layover_external_events"))[0].n;
      for (const [body, reason] of cases) {
        const r = await post(body);
        assert.equal(r.status, 400, `${reason}: ${r.raw}`);
        assert.equal(r.body.reason, reason, r.raw);
      }
      assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM public.layover_external_events"))[0].n, before, "a refused payload must not be stored");
    });

    it("E4 L93 L92 L257 — the drain identifies the impacted ACTIVE sessions at the event's airport only, replans them, and stamps processed_at; a tampered stored row is refused at the last door", async () => {
      await db.exec("UPDATE public.layover_external_events SET processed_at = now() WHERE processed_at IS NULL");
      const r = await post(securityEvent({ payload: { waitMinutes: 90 } }));
      assert.equal(r.status, 200, r.raw);
      // a row written behind the route with a dedup key that is NOT its own stable key
      const forged = `evt-forged-${randomUUID()}`;
      await db.exec(`INSERT INTO public.layover_external_events (event_id, event_type, occurred_at, received_at, source, source_event_id, subject_refs, payload, dedup_key, confidence)
        VALUES ('${forged}', 'airport.security_wait_changed', now() - interval '1 minute', now(), 'b1p-test-feed', 'x', '[{"kind":"airport","ref":"BKK"}]', '{"waitMinutes":200}', 'not-its-own-key-${randomUUID()}', 'HIGH')`);
      const failedBefore = db.bridge.failed.length;
      const nowMs = Date.now();
      const report = await drainPendingExternalEvents(db.client, layoverExternalReplanPort(db.client, { nowMs }), { limit: 50, nowMs });
      assert.equal(report.readFailed, null);
      const mine = report.drained.find((d: any) => d.eventId === r.body.eventId);
      assert.ok(mine, `the SIN event was not replanned: ${JSON.stringify(report).slice(0, 500)}`);
      assert.equal(mine!.impacted, sinSessions.length, "L93: every active SIN session, and only those, is impacted");
      const refused = report.failedAfterClaim.find((f: any) => f.eventId === forged);
      assert.ok(refused && /dedup_key_mismatch/.test(refused.reason), `L257: the tampered row reached a session: ${JSON.stringify(report.failedAfterClaim)}`);
      assert.ok((await rowByKey(r.body.dedupKey))[0].processed_at, "processed_at was not stamped");
      assert.deepEqual(db.bridge.failed.slice(failedBefore), [], "a read on the fan-out path failed on the real schema");
      // the scheduler's own entry point runs the same pass (nothing pending now → a real, empty pass)
      const tick = await runLayoverExternalEventDrain({ client: db.client, nowMs: Date.now() });
      assert.equal(tick.skipped, false); assert.equal(tick.reason, null);
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 ingest flag OFF → 503 ingest_closed, nothing stored; the drain reads nothing (gate_closed)", async () => {
      await db.setFlag("layover_event_ingest_enabled", false);
      const n0 = (await db.query<any>("SELECT count(*)::int AS n FROM public.layover_external_events"))[0].n;
      const r = await post(securityEvent());
      assert.equal(r.status, 503); assert.equal(r.body.reason, "ingest_closed");
      assert.equal((await db.query<any>("SELECT count(*)::int AS n FROM public.layover_external_events"))[0].n, n0);
      const d = await runLayoverExternalEventDrain({ client: db.client, nowMs: Date.now() });
      assert.equal(d.reason, "gate_closed");
    });

    it("A2 the producer credential is required: wrong secret 401, unset secret 503 — before any flag or table is read", async () => {
      await db.setFlag("layover_event_ingest_enabled", true);
      assert.equal((await post(securityEvent(), { "x-layover-producer-secret": "wrong" })).status, 401);
      assert.equal((await post(securityEvent(), {})).status, 401);
      const saved = process.env["LAYOVER_EVENT_PRODUCER_SECRET"];
      delete process.env["LAYOVER_EVENT_PRODUCER_SECRET"];
      try { const r = await post(securityEvent()); assert.equal(r.status, 503); assert.equal(r.body.reason, "producer_secret_unset"); }
      finally { process.env["LAYOVER_EVENT_PRODUCER_SECRET"] = saved; }
    });

    it("A3 no client can read or write layover_external_events (RLS on, no policy, grants revoked)", async () => {
      const u = await db.seedUser("nosy");
      await assert.rejects(db.asUser(u.id, "SELECT * FROM public.layover_external_events"), (e: any) => e?.code === "42501");
    });

    it("A4 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
