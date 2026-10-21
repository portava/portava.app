/**
 * Lane B1-P — rollout switches with no new storage of their own, PRESSED,
 * against the real migrated schema.
 *
 * Rows and presses:
 *   L269  flip `layover_discovery_mode_enabled` (2971 applied; FALSE in production) — P10.
 *         Discovery's Layover gate (lib/discoveryLayoverMode.ts, called by
 *         routes/discovery.ts GET /discovery and GET /discovery/community).
 *   L242  apply 3784, then `layover_ranking_mode` enabled with mode=shadow for a
 *         tester cohort — P14 (who is shadowed first is OQ-L242-1 / OQ-7).
 *   L254  `rent_buddy_enabled` ON — IN THIS TEST DATABASE ONLY. It is FALSE in
 *         production and this lane does not propose turning it on (owner
 *         decision: never activate unverified buddy services in production).
 *   L276  (consume limb) apply 2851, flip `layover_live_intersection_enabled` — P9. The
 *         Live gates it reads behind (intel_live_label_crowd, intel_claim_projection_crowd,
 *         intel_capture_quick_signal, intel_limited_live) are TRUE in production already.
 *   L41   3771 (the device capability column) + PUSH_IOS_TIME_SENSITIVE_ENTITLED=true
 *         on the server — P18. The rest is Apple's: the Time Sensitive
 *         Notifications capability on the App ID and a signed-build device check
 *         (LAY-4a). The server half is proven here; the platform half cannot be.
 *
 * Expo is never called: `lib/push.ts`'s test fetch captures the request.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverPressedRollout.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor, seedCuratedAirport, seedVerifiedLayoverSpecialist, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";
import { discoveryLayoverGate } from "../../lib/discoveryLayoverMode.js";
import { _setTestFetch } from "../../lib/push.js";

const PRESS = {
  migrations: ["3784", "3771", "2851"],
  flags: { layover_discovery_mode_enabled: true, rent_buddy_enabled: true, layover_live_intersection_enabled: true },
} as const;
const pressed = PRESS_ARM === "pressed";

let db: PressedDb;
let app: PressedApp;
const pushes: any[] = [];

/** Tomorrow's date in Singapore, "YYYY-MM-DD", so wall times are unambiguous whatever the clock says now. */
function sgtDay(offsetDays: number): string {
  const d = new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

describe("B1-P rollout switches (P10, P14, L254 test-only, P18)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    if (pressed) process.env["PUSH_IOS_TIME_SENSITIVE_ENTITLED"] = "true"; else delete process.env["PUSH_IOS_TIME_SENSITIVE_ENTITLED"];
    _setTestFetch((async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      pushes.push(...body);
      return new Response(JSON.stringify({ data: body.map(() => ({ status: "ok", id: "ticket" })) }), { status: 200 });
    }) as any);
    app = await startPressedLayoverApp(db); await seedCuratedAirport(app, db, "SIN"); await db.setFlag("layover_buddy_specialist_enabled", true); // 3874 + the 2026-10-18 maturity decision: landside opens only at a curated airport; the buddies route's second gate (routes/airport.ts, ee52da82c) — G3 presses rent_buddy_enabled
  });
  after(async () => { _setTestFetch(null); delete process.env["PUSH_IOS_TIME_SENSITIVE_ENTITLED"]; await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("G1 L269 — in Layover mode Discovery serves ONLY the certified action universe: the place whose leg the traveller stated is admitted, the unmeasured one is withheld with its reason", async () => {
      const u = await db.seedUser("explorer");
      await seedConfirmedCorridor(db, u.id);
      const places = await db.query<any>(`INSERT INTO public.discovery_places (city, name, place_type, status, lat, lng) VALUES
        ('Singapore', 'Hawker Centre', 'restaurant', 'active', 1.3521, 103.9442), ('Singapore', 'Unmeasured Museum', 'attraction', 'active', 1.2966, 103.8485) RETURNING id, name`);
      const near = places.find((p) => p.name === "Hawker Centre"), far = places.find((p) => p.name === "Unmeasured Museum");
      const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 11 })).id;
      const st = await app.call("POST", `/api/airport/sessions/${sid}/stops`, u, { title: "Hawker Centre", durationMin: 45, travelMin: 20, insideAirport: false, lat: 1.3521, lng: 103.9442, placeId: near.id });
      assert.ok(st.status < 300, st.raw);
      const gate: any = await discoveryLayoverGate(db.client, u.id, [{ id: near.id, lat: 1.3521, lng: 103.9442 }, { id: far.id, lat: 1.2966, lng: 103.8485 }], "GET /discovery");
      assert.equal(gate.ok, true, JSON.stringify(gate.refusal ?? null));
      assert.equal(gate.active, true, "Layover mode did not engage for a traveller in a live layover");
      assert.ok(gate.admittedIds.has(near.id), JSON.stringify(gate.summary?.excluded));
      assert.ok(!gate.admittedIds.has(far.id), "an experience outside the certified universe was admitted");
      const why = gate.summary.excluded.find((x: any) => x.id === far.id);
      assert.ok(why && why.state && why.reason, "a withheld place must say why");
    });

    it("G2 L242 — shadow mode for a tester cohort: the objective is compared and COUNTED beside the live order, and nothing it produced is served", async () => {
      const tester = await db.seedUser("tester"), other = await db.seedUser("other");
      // the press (P14): the row 3784 seeds, turned on in shadow for a tester cohort. flag-off: the row as seeded (enabled
      // false, mode legacy); absent: no row at all (3784 not applied) — both resolve to legacy.
      if (pressed) await db.setFlag("layover_ranking_mode", true, { mode: "shadow", cohort: { kind: "users", userIds: [tester.id] } });
      else if (PRESS_ARM === "flag-off") await db.setFlag("layover_ranking_mode", false, { mode: "legacy" });
      const ts = (await startSession(app, tester, { iata: "SIN" }, { departsInH: 10 })).id;
      const os = (await startSession(app, other, { iata: "SIN" }, { departsInH: 10 })).id;
      const rt = await app.call("GET", `/api/airport/sessions/${ts}/recommendations`, tester);
      const ro = await app.call("GET", `/api/airport/sessions/${os}/recommendations`, other);
      assert.equal(rt.status, 200, rt.raw); assert.equal(ro.status, 200, ro.raw);
      const ev = async (s: string) => (await db.query<any>(`SELECT metadata FROM public.layover_events WHERE session_id = '${s}' AND event_type = 'recommendation_generated' ORDER BY created_at DESC LIMIT 1`))[0]?.metadata;
      const mt = await ev(ts), mo = await ev(os);
      assert.equal(mt?.ranking?.mode, "shadow", `the tester's generation was not shadowed: ${JSON.stringify(mt?.ranking)}`);
      assert.equal(mt.ranking.compared, rt.body.recommendations.length);
      assert.equal(mo?.ranking, undefined, "a traveller outside the cohort was shadowed");
      assert.deepEqual(rt.body.recommendations.map((r: any) => r.title), ro.body.recommendations.map((r: any) => r.title), "shadow changed what the tester was SERVED");
    });

    it("G3 L254 (test database only) — a high-risk (night) layover lists ONLY verified, non-new buddies; a daytime one lists the rest too", async () => {
      const t = await db.seedUser("nighttraveller");
      await seedConfirmedCorridor(db, t.id);
      const mk = async (label: string, verified: boolean, level: string) => {
        const b = await db.seedUser(label); await seedVerifiedLayoverSpecialist(db, b); // L273: each is a live-verified, payout-ready `layover` specialist, so the PROFILE's verified/level (L254) is the only difference
        await db.exec(`INSERT INTO public.rent_buddy_profiles (user_id, display_name, city, country, categories, status, verified, buddy_level)
          VALUES ('${b.id}', '${label}', 'Singapore', 'Singapore', '{layover}', 'active', ${verified}, '${level}')`);
        return b.id;
      };
      const trusted = await mk("trusted_buddy", true, "trusted");
      const unverified = await mk("unverified_buddy", false, "trusted");
      const fresh = await mk("new_buddy", true, "new");
      const night = (await startSession(app, t, { iata: "SIN", arrivalLocal: `${sgtDay(1)}T20:00`, departureLocal: `${sgtDay(2)}T09:00` })).id;
      const r = await app.call("GET", `/api/airport/sessions/${night}/buddies`, t);
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.trustRequirement?.applied, true, JSON.stringify(r.body).slice(0, 400));
      assert.ok(r.body.trustRequirement.reasons.includes("night_window"));
      const ids = r.body.buddies.map((b: any) => b.userId);
      assert.ok(ids.includes(trusted), "the verified, established buddy is missing");
      assert.ok(!ids.includes(unverified) && !ids.includes(fresh), "an unverified or new buddy was offered for a night layover");
      const day = (await startSession(app, t, { iata: "SIN", arrivalLocal: `${sgtDay(1)}T09:00`, departureLocal: `${sgtDay(1)}T19:30` })).id;
      const d = await app.call("GET", `/api/airport/sessions/${day}/buddies`, t);
      assert.equal(d.body.trustRequirement?.applied, false, JSON.stringify(d.body.trustRequirement));
      assert.ok(d.body.buddies.map((b: any) => b.userId).includes(unverified), "control: the requirement is specific to the high-risk window");
    });

    it("G4 L41 (server half) — RETURN_SOON sends the actionable warning at high priority on the return channel, and time-sensitive ONLY to the device that reported the entitlement", async () => {
      const u = await db.seedUser("returner");
      await db.exec(`INSERT INTO public.notification_devices (user_id, push_token, platform, ios_time_sensitive_capable) VALUES
        ('${u.id}', 'ExponentPushToken[ios-entitled]', 'expo', true), ('${u.id}', 'ExponentPushToken[older-build]', 'expo', NULL)`);
      const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 10 })).id;
      pushes.length = 0;
      const p = await app.call("PATCH", `/api/airport/sessions/${sid}`, u, { departureTime: new Date(Date.now() + 3.27 * 3_600_000).toISOString() });
      assert.equal(p.status, 200, p.raw);
      assert.equal(p.body.replan.opportunityNotification?.returnWarning, "start_heading_back", JSON.stringify(p.body.replan.opportunityNotification));
      for (let i = 0; i < 50 && pushes.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
      const entitled = pushes.find((m) => m.to === "ExponentPushToken[ios-entitled]");
      const older = pushes.find((m) => m.to === "ExponentPushToken[older-build]");
      assert.ok(entitled && older, `push not attempted: ${JSON.stringify(pushes).slice(0, 300)}`);
      assert.equal(entitled.title, "Start heading back to the airport");
      assert.equal(entitled.priority, "high");
      assert.equal(entitled.channelId, "layover_return");
      assert.equal(entitled.interruptionLevel, "time-sensitive", "the entitled device was not asked for time-sensitive delivery");
      assert.equal(older.interruptionLevel, undefined, "an unknown build was upgraded");
      assert.equal(older.priority, "high", "Android/APNs high priority is independent of the entitlement");
    });
    it("G5 L276 (consume limb) — a promoted, privacy-eligible live reading of unsafe density at a place DROPS that place's card; a place with no reading is untouched", async () => {
      const u = await db.seedUser("crowdwise");
      await seedConfirmedCorridor(db, u.id);
      const place = (await db.query<any>(`INSERT INTO public.places (name, normalized_name, latitude, longitude) VALUES ('Crowded Market', 'crowded market', 1.3, 103.85) RETURNING id`))[0].id;
      await db.exec(`INSERT INTO public.discovery_places (city, name, place_type, status, lat, lng, canonical_location_id) VALUES
        ('Singapore', 'Crowded Market', 'attraction', 'active', 1.3, 103.85, '${place}'), ('Singapore', 'Calm Garden', 'attraction', 'active', 1.31, 103.86, NULL)`);
      await db.exec(`INSERT INTO public.intel_live_promoted_scopes (scope_key, zone_id, claim_type) VALUES ('|crowd.level', NULL, 'crowd.level') ON CONFLICT (scope_key) DO NOTHING`);
      await db.exec(`INSERT INTO public.intel_state_snapshots (subject_id, zone_id, claim_type, value, confidence, source_count, privacy_eligible, observed_at, expires_at, source_class, conflict_state)
        VALUES ('${place}', '', 'crowd.level', '{"level":"unsafe_density"}', 0.92, 6, true, now() - interval '2 minutes', now() + interval '1 hour', 'verified_firsthand', 'none')`);
      const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 10 })).id;
      const r = await app.call("GET", `/api/airport/sessions/${sid}/recommendations`, u);
      assert.equal(r.status, 200, r.raw);
      const titles = r.body.recommendations.map((c: any) => c.title);
      assert.ok(titles.includes("Calm Garden"), `control: the place without a reading is served (${titles.join(", ")})`);
      assert.ok(!titles.includes("Crowded Market"), "a card was served into a live unsafe-density reading");
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 production today: discovery mode OFF → the gate does not engage; rent_buddy OFF → the buddies list is empty and says why", async () => {
      await db.setFlag("layover_discovery_mode_enabled", false);
      await db.setFlag("rent_buddy_enabled", false);
      try {
        const u = await db.seedUser("today");
        const sid = (await startSession(app, u, { iata: "SIN" }, { departsInH: 9 })).id;
        const gate: any = await discoveryLayoverGate(db.client, u.id, [{ id: "00000000-0000-0000-0000-000000000001" }], "GET /discovery");
        assert.equal(gate.active, false);
        const b = await app.call("GET", `/api/airport/sessions/${sid}/buddies`, u);
        assert.deepEqual(b.body.buddies, []);
        assert.equal(b.body.reason, "rent_buddy_not_enabled");
      } finally {
        await db.setFlag("layover_discovery_mode_enabled", pressed);
        await db.setFlag("rent_buddy_enabled", pressed);
      }
    });

    it("A2 the discovery-mode flag UNREADABLE for a traveller in a live layover refuses (transient_db), never serves the ungated list", async () => {
      const u = await db.seedUser("unreadable");
      await startSession(app, u, { iata: "SIN" }, { departsInH: 9 });
      const fault = (req: any) => (req.target === "feature_flags" && String(req.params.get("flag") ?? "").includes("layover_discovery_mode_enabled") ? { status: 500, body: { code: "XX000", message: "injected", details: null, hint: null } } : null);
      db.bridge.faults.push(fault);
      try {
        const gate: any = await discoveryLayoverGate(db.client, u.id, [{ id: "00000000-0000-0000-0000-000000000001" }], "GET /discovery");
        assert.equal(gate.ok, false);
      } finally { db.bridge.faults.splice(db.bridge.faults.indexOf(fault), 1); }
    });

    it("A3 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
