/**
 * Lane B1-P — the decision ledger's retention and minimisation (triage press
 * P13), PRESSED, against the real migrated schema.
 *
 * Row: L163 — "Decision ledger — retained per safety/diagnostic policy;
 * minimise direct personal data." OD-MAP-4: a pseudonymised, access-restricted
 * audit record for up to 12 months, then deleted.
 *
 * THE PRESS: 3621 (pseudonym columns, the identity-or-pseudonym CHECK, the
 * session FK SET NULL) → 3622 (dead letters, index) → flip
 * `layover_events_post_session_pseudonymisation_enabled` (3622 seeds it FALSE).
 * Lead ruling: L163 is W until 3621 is applied.
 *
 * R1 drives the REAL `executeAccountDeletion` (contentOnly) over the pressed
 * chain through the bridge: every step ran, nothing unmodelled.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedErasure.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { executeAccountDeletion } from "../../services/accountDeletion/AccountDeletionService.js";
import { runLayoverPostSessionPseudonymisation } from "../../lib/layoverEventPseudonymisation.js";
import { runLayoverAuditRetentionSweep } from "../../lib/layoverAuditRetentionScheduler.js";

const PRESS = { migrations: ["3621", "3622"], flags: { layover_events_post_session_pseudonymisation_enabled: true } } as const;
const YEAR_MS = 366 * 86_400_000;

let db: PressedDb;
let app: PressedApp;
let seeded: boolean | "absent" = "absent";
const eventsOf = (sid: string) => db.query<any>(`SELECT * FROM public.layover_events WHERE session_id = '${sid}'`);

describe("B1-P decision ledger retention (P13)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seeded = await db.flag("layover_events_post_session_pseudonymisation_enabled");
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("R0 the press: 3622 seeds the post-session flag FALSE", () => { assert.equal(seeded, false); });

    it("R1 L163 — account deletion keeps the layover ledger only as a pseudonymised record: no user, no session, one pseudonym, emptied detail, kept at most 12 months", async () => {
      const u: PressedUser = await db.seedUser("leaver");
      const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 8 })).id;
      const before = await eventsOf(sid);
      assert.ok(before.length >= 1, "control: the session wrote ledger events");
      const ids = before.map((e) => `'${e.id}'`).join(",");
      const out = await executeAccountDeletion(db.client, u.id, { contentOnly: true } as any);
      assert.ok(out.steps.find((s: any) => s.step === "pseudonymise_layover_events")?.ok, JSON.stringify(out.steps.filter((s: any) => !s.ok)));
      assert.equal(db.bridge.unmodelled.length, 0, db.bridge.unmodelled.join(" | "));
      const after = await db.query<any>(`SELECT * FROM public.layover_events WHERE id IN (${ids})`);
      assert.equal(after.length, before.length, "the ledger was erased, not retained as an audit record");
      const pseudonyms = new Set(after.map((e) => e.erasure_pseudonym));
      assert.equal(pseudonyms.size, 1, "one pseudonym per deletion keeps the trail internally consistent");
      for (const e of after) {
        assert.equal(e.user_id, null);
        assert.equal(e.session_id, null);
        assert.ok(e.pseudonymised_at && e.retain_until);
        assert.ok(Date.parse(e.retain_until) - Date.parse(e.pseudonymised_at) <= YEAR_MS, "kept past 12 months");
        assert.deepEqual(e.metadata, {}, "direct personal data left in the retained detail");
        assert.ok(!JSON.stringify(e).includes(u.id));
      }
      assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_sessions WHERE id = '${sid}'`)).length, 0, "the session itself is erased");
    });

    it("R2 L163 — the table itself refuses a half-pseudonymised row and a retention past 12 months (3621's CHECK)", async () => {
      const row = (await db.query<any>(`SELECT id FROM public.layover_events WHERE pseudonymised_at IS NOT NULL LIMIT 1`))[0];
      assert.ok(row, "precondition: a pseudonymised row");
      const u = await db.seedUser("relink");
      await assert.rejects(db.exec(`UPDATE public.layover_events SET user_id = '${u.id}' WHERE id = '${row.id}'`), (e: any) => e?.code === "23514");
      await assert.rejects(db.exec(`UPDATE public.layover_events SET retain_until = pseudonymised_at + interval '13 months' WHERE id = '${row.id}'`), (e: any) => e?.code === "23514");
    });

    it("R3 L163 — after the layover is over (30 days), the post-session pass pseudonymises its ledger; a recent layover's stays named", async () => {
      const u = await db.seedUser("traveller");
      const old = (await startSession(app, u, { iata: "SIN" }, { departsInH: 8 })).id;
      const recent = (await startSession(app, u, { iata: "SIN" }, { departsInH: 8 })).id;
      await db.exec(`UPDATE public.layover_sessions SET arrival_time = now() - interval '41 days', departure_time = now() - interval '40 days', boarding_time = NULL, status = 'completed' WHERE id = '${old}'`);
      const r = await runLayoverPostSessionPseudonymisation(db.client, new Date());
      assert.equal(r.outcome, "pseudonymised", JSON.stringify(r));
      assert.ok(r.events >= 1);
      assert.equal((await eventsOf(old)).length, 0, "the old session's events are still named");
      const oldEvents = await db.query<any>(`SELECT * FROM public.layover_events WHERE pseudonymised_at IS NOT NULL AND user_id IS NULL AND session_id IS NULL`);
      assert.ok(oldEvents.length >= 1);
      const named = await eventsOf(recent);
      assert.ok(named.length >= 1 && named.every((e) => e.user_id === u.id && e.pseudonymised_at === null), "a live layover's ledger was pseudonymised");
    });

    it("R4 L163 — the retention sweep deletes a pseudonymised record once its retain_until has passed, and nothing else", async () => {
      const due = (await db.query<any>(`SELECT id FROM public.layover_events WHERE pseudonymised_at IS NOT NULL LIMIT 1`))[0];
      await db.exec(`UPDATE public.layover_events SET pseudonymised_at = now() - interval '13 months', retain_until = now() - interval '1 month' WHERE id = '${due.id}'`);
      const namedBefore = (await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_events WHERE pseudonymised_at IS NULL`))[0].n;
      const r = await runLayoverAuditRetentionSweep({ client: db.client, now: new Date() });
      assert.equal(r.outcome, "swept", JSON.stringify(r));
      assert.equal((await db.query<any>(`SELECT 1 FROM public.layover_events WHERE id = '${due.id}'`)).length, 0);
      assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_events WHERE pseudonymised_at IS NULL`))[0].n, namedBefore, "a named row was swept");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 post-session flag OFF → the pass does nothing and says 'off'", async () => {
      await db.setFlag("layover_events_post_session_pseudonymisation_enabled", false);
      const r = await runLayoverPostSessionPseudonymisation(db.client, new Date());
      assert.equal(r.outcome, "off");
      assert.equal(r.events, 0);
      await db.setFlag("layover_events_post_session_pseudonymisation_enabled", PRESS_ARM === "pressed");
    });

    it("A2 a client sees only its OWN named ledger rows, never a pseudonymised one", async () => {
      const u = await db.seedUser("reader");
      const rows = await db.asUser(u.id, `SELECT user_id FROM public.layover_events`);
      assert.ok(rows.every((r: any) => r.user_id === u.id));
    });

    it("A3 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
