/**
 * Lane B1-P — stable recommendation ids (triage press P4), PRESSED, against the
 * real migrated schema.
 *
 * Rows: L117, L122, L125 (the map pin's band is joined onto a card by `rec.id`:
 * `travel-buddy-standalone/app/layover/[id].tsx:397#candidateFeasibility`, and
 * the pin/blocked-area rendering is pinned client-side by
 * `LayoverMapCard.envelope.component.test.tsx` "a BLOCKED candidate is kept off
 * the map and explained"), and L296 (App C5: an add-to-plan is certified against
 * the snapshot the card was returned with).
 *
 * THE PRESS: flip `layover_stable_recommendation_ids_enabled` ON. Its migration
 * (2410) is applied in production and the flag is FALSE there (2026-09-22
 * snapshot), so there is no migration-absent arm: B1P_ARM=absent here is
 * "production today" (the chain as is, flags as production holds them).
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedStableIds.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = { migrations: [] as string[], flags: { layover_stable_recommendation_ids_enabled: true } } as const;

let db: PressedDb;
let app: PressedApp;
let ana: PressedUser, bob: PressedUser;
let sid = "";
let first: any = null;

/** The screen's join, verbatim in effect (app/layover/[id].tsx:397): recommendation id → the band its PIN renders. */
function screenJoin(recs: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of recs) if (r.id && r.feasibility) out[r.id] = r.feasibility;
  return out;
}

describe("B1-P stable recommendation ids (P4)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
    ana = await db.seedUser("ana");
    bob = await db.seedUser("bob");
    await seedConfirmedCorridor(db, ana.id); await seedCuratedAirport(app, db, "SIN"); // 3874 + the 2026-10-18 maturity decision: landside opens only at a curated airport
    // one place inside a ten-hour layover's reach, one 300 km away (outside any envelope Changi can certify)
    await db.exec(`INSERT INTO public.discovery_places (city, name, place_type, status, lat, lng) VALUES
      ('Singapore', 'Marina Bay Walk', 'attraction', 'active', 1.2834, 103.8607),
      ('Singapore', 'Far Away Fort', 'attraction', 'active', 3.139, 101.6869)`);
    sid = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 10 })).id;
    const r = await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, ana);
    if (r.status !== 200) throw new Error(r.raw);
    first = r.body;
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("I1 L122 L117 — every card carries its stable id and the feasibility state from the contract, so the screen's join bands EVERY pin", () => {
      const recs = first.recommendations as any[];
      assert.ok(recs.length > 0);
      for (const r of recs) assert.match(String(r.id ?? ""), /^[0-9a-f-]{36}$/, `a card without a stable id: ${r.title}`);
      const join = screenJoin(recs);
      assert.equal(Object.keys(join).length, recs.length, "a pin the screen cannot band");
      for (const f of Object.values(join)) {
        assert.ok(["SAFE", "TIGHT", "BLOCKED", "UNCERTIFIED"].includes(f.band), JSON.stringify(f));
        assert.equal(typeof f.certified, "boolean");
      }
    });

    it("I2 L117 L125 — the place outside the certified action universe is not offered, and no banded pin implies a fit it was not certified for", () => {
      const titles = (first.recommendations as any[]).filter((r) => r.available !== false).map((r) => r.title); // §83: a BLOCKED card (status flag ON) is served visibly unavailable, never offered
      assert.ok((first.recommendations as any[]).some((r) => r.title === "Marina Bay Walk"), `control: the reachable place is offered (${titles.join(", ")})`);
      assert.ok(!titles.includes("Far Away Fort") && (first.recommendations as any[]).filter((r) => r.title === "Far Away Fort").every((r) => r.status === "BLOCKED" && typeof r.statusExplanation === "string"), "a place outside the envelope was offered as a card");
      const join = screenJoin(first.recommendations);
      assert.ok(Object.keys(join).length > 0, "no pin is banded at all — nothing on the map can be 'visibly blocked'");
      for (const f of Object.values(join)) {
        if (f.band !== "SAFE") assert.equal(f.impliesFit, false, `L125: ${JSON.stringify(f)}`);
        // L125: a BLOCKED pin explains itself; UNCERTIFIED carries no reason by the envelope's own contract
        // (services/airport/LayoverEnvelope.ts EnvelopeVerdict.reason: "an absence needs no reason beyond itself").
        if (f.band === "BLOCKED") assert.ok(typeof f.reason === "string" && f.reason.length > 0, `L125: a blocked pin with no reason: ${JSON.stringify(f)}`);
      }
    });

    it("I3 — the ids are STABLE: a second read of the same session serves the same card ids (the plan's join survives a refresh)", async () => {
      const again = await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, ana);
      const a = new Set((first.recommendations as any[]).map((r) => `${r.title}|${r.id}`));
      for (const r of again.body.recommendations as any[]) { assert.ok(r.id, `${r.title} has no id`); assert.ok(a.has(`${r.title}|${r.id}`), `${r.title} changed id across reads`); }
      first = again.body;
    });

    it("I4 L296 — Add to plan is certified against the card's own snapshot: the current snapshot adds; a stale one is refused 409 RECOMMENDATION_EXPIRED and writes nothing", async () => {
      const airside = (first.recommendations as any[]).filter((r) => r.insideAirport && r.id);
      assert.ok(airside.length >= 2);
      const ok = await app.call("POST", `/api/airport/sessions/${sid}/stops/from-recommendation`, ana, { recommendationId: airside[0].id, snapshotId: first.snapshotId });
      assert.equal(ok.status, 200, ok.raw);
      assert.ok(ok.body.stops.some((s: any) => s.recommendationId === airside[0].id));
      const before = (await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_plan_stops WHERE session_id = '${sid}'`))[0].n;
      const stale = await app.call("POST", `/api/airport/sessions/${sid}/stops/from-recommendation`, ana, { recommendationId: airside[1].id, snapshotId: `snap:${"0".repeat(32)}` });
      assert.equal(stale.status, 409, stale.raw);
      assert.equal(stale.body.reason, "RECOMMENDATION_EXPIRED");
      assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM public.layover_plan_stops WHERE session_id = '${sid}'`))[0].n, before);
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 flag OFF (production today) → cards carry NO id, so the screen's join bands nothing and Add-to-plan is unreachable", async () => {
      await db.setFlag("layover_stable_recommendation_ids_enabled", false);
      try {
        const s = (await startSession(app, ana, { iata: "SIN" }, { departsInH: 9 })).id;
        const r = await app.call("GET", `/api/airport/sessions/${s}/recommendations`, ana);
        assert.equal(r.status, 200, r.raw);
        assert.ok(r.body.recommendations.length > 0);
        assert.equal(Object.keys(screenJoin(r.body.recommendations)).length, 0);
        assert.ok(r.body.recommendations.every((x: any) => !x.id));
      } finally { await db.setFlag("layover_stable_recommendation_ids_enabled", PRESS_ARM === "pressed"); }
    });

    it("A2 owner-scoped: another traveller cannot add this session's card to a plan, or read its cards", async () => {
      const card = (first?.recommendations ?? []).find((r: any) => r.id);
      const r = await app.call("POST", `/api/airport/sessions/${sid}/stops/from-recommendation`, bob, { recommendationId: card?.id ?? "x", snapshotId: first?.snapshotId });
      assert.equal(r.status, 404);
      assert.equal((await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, bob)).status, 404);
    });

    it("A3 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
