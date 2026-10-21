/**
 * LAYOVER 165, lane B2-CREW — L134 "Explicit split plans (A leaves at T1, B/C continue to T2)" and L135 "Crew plan
 * certified against every member branch", against the REAL migrated schema (lane B1-P's harness).
 *
 * THE PRESS: 3872 (layover_crew_plans + layover_crew_plan_branches + layover_propose_crew_plan) →
 * `layover_crew_split_plans_enabled` ON. Crews themselves are 2984, applied in production.
 *
 * Run (loopback; unsandboxed):
 *   LAYOVER_PGLITE_ROOT=<…> node --import tsx/esm --test src/test/db/layoverCrewSplitPlans.db.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PRESSED_SKIP_REASON, PRESS_ARM, applyPress, openForPress, type PressedDb, type PressedUser } from "./pressedLayoverDb.js";
import { productionBaseFlags, seedConfirmedCorridor, startPressedLayoverApp, startSession, type PressedApp } from "./pressedLayoverApp.js";

const PRESS = { migrations: ["3872"], flags: { layover_crew_split_plans_enabled: true } } as const;
const H = 3_600_000;

let db: PressedDb;
let app: PressedApp;
let seeded: boolean | "absent" = "absent";

interface M { u: PressedUser; sid: string }
const planPath = (m: M) => `/api/airport/sessions/${m.sid}/crew/plan`;
const plans = (crewId: string) => db.query<any>(`SELECT p.status, b.branch_key, b.member_user_ids, b.return_by FROM public.layover_crew_plans p LEFT JOIN public.layover_crew_plan_branches b ON b.plan_id = p.id WHERE p.crew_id = '${crewId}' ORDER BY p.created_at, b.position`);
const hardReturn = async (m: M) => {
  // The member's OWN certified hard return, as their own /safety surface publishes it.
  const r = await app.call("GET", `/api/airport/sessions/${m.sid}/safety`, m.u);
  if (r.status !== 200 || !r.body.hardReturnTime) throw new Error(`safety: ${r.raw.slice(0, 300)}`);
  return Date.parse(r.body.hardReturnTime);
};

/** A crew of members at SIN; `hours[i]` is member i's departure from now. Member 0 founds it. */
async function crew(label: string, hours: number[]): Promise<{ ms: M[]; crewId: string }> {
  const ms: M[] = [];
  for (const [i, h] of hours.entries()) {
    const u = await db.seedUser(`${label}${i}`);
    ms.push({ u, sid: (await startSession(app, u, { iata: "SIN" }, { departsInH: h })).id });
  }
  const c = await app.call("POST", `/api/airport/sessions/${ms[0]!.sid}/crew`, ms[0]!.u, { title: `crew ${label}` });
  if (c.status !== 200) throw new Error(`crew: ${c.raw}`);
  for (const m of ms.slice(1)) {
    const j = await app.call("POST", `/api/airport/sessions/${m.sid}/crew/${c.body.crew.id}/join`, m.u);
    if (j.status !== 200) throw new Error(`join: ${j.raw}`);
  }
  return { ms, crewId: c.body.crew.id };
}

describe("B2-CREW L134/L135 crew split plans (3872)", { skip: PRESSED_SKIP_REASON }, () => {
  before(async () => {
    db = await openForPress(PRESS);
    seeded = await db.flag("layover_crew_split_plans_enabled");
    await productionBaseFlags(db);
    await applyPress(db, PRESS);
    app = await startPressedLayoverApp(db);
  });
  after(async () => { await app?.close(); await db?.close(); });

  describe(`PRESSED [${PRESS_ARM}]`, () => {
    it("P0 the press: 3872 seeds layover_crew_split_plans_enabled FALSE", () => { assert.equal(seeded, false); });

    it("P1 L134 — A leaves at T1, B and C continue until T2: proposed, certified, stored as two branches, and every member's crew card shows it", async () => {
      const { ms: [a, b, c], crewId } = await crew("p1", [5, 10, 10]);
      const t1 = (await hardReturn(a!)) - 15 * 60_000;
      const t2 = (await hardReturn(b!)) - 15 * 60_000;
      assert.ok(t2 > t1 + H, "fixture: T2 must run well past A's deadline for this to be a split");
      const r = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date(t1).toISOString() }], rest: { returnBy: new Date(t2).toISOString() } });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.body.plan.feasible, true, JSON.stringify(r.body.plan));
      assert.equal(r.body.plan.split, true);
      const rows = await plans(crewId);
      assert.deepEqual(rows.map((x) => [x.status, x.branch_key, [...x.member_user_ids].sort()]), [
        ["proposed", "b1", [a!.u.id]],
        ["proposed", "rest", [b!.u.id, c!.u.id].sort()],
      ]);
      for (const m of [b!, c!]) {
        const card = await app.call("GET", `/api/airport/sessions/${m.sid}/crew`, m.u);
        assert.equal(card.status, 200, card.raw);
        const sp = card.body.splitPlan;
        assert.equal(sp?.available, true, JSON.stringify(card.body));
        assert.equal(sp.plan.feasible, true);
        const mine = sp.plan.branches.find((x: any) => x.includesYou);
        assert.equal(mine.key, "rest");
        assert.equal(Date.parse(mine.returnBy), t2);
      }
    });

    it("P2 L135 — certified against EVERY member branch BEFORE storing: a T2 past C's own deadline is refused with the branch's reason, and nothing is stored", async () => {
      const { ms: [a, b, c], crewId } = await crew("p2", [5, 10, 7]);
      const t1 = (await hardReturn(a!)) - 15 * 60_000;
      const t2 = (await hardReturn(b!)) - 15 * 60_000; // past c's hard return
      assert.ok(t2 > (await hardReturn(c!)), "fixture");
      const r = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date(t1).toISOString() }], rest: { returnBy: new Date(t2).toISOString() } });
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.body.reason, "crew_plan_not_certified");
      const rest = r.body.certification.branches.find((x: any) => x.key === "rest");
      assert.equal(rest.feasible, false);
      assert.ok(rest.reasons.includes("branch_returns_after_member_deadline"), JSON.stringify(rest.reasons));
      assert.equal(r.body.certification.branches.find((x: any) => x.key === "b1").feasible, true, "the good branch was not judged on its own members");
      assert.equal((await plans(crewId)).length, 0, "an uncertified plan was stored");
    });

    it("P3 L135 — the LIVE path re-certifies the stored plan on every read: a member whose layover shortens makes their branch infeasible on the next crew read", async () => {
      const { ms: [a, b], crewId } = await crew("p3", [5, 10]);
      const t2 = (await hardReturn(b!)) - 15 * 60_000;
      const ok = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date((await hardReturn(a!)) - 15 * 60_000).toISOString() }], rest: { returnBy: new Date(t2).toISOString() } });
      assert.equal(ok.status, 200, ok.raw);
      // b's flight moves earlier (a traveller-reported change of departure)
      const dep = new Date(Date.now() + 6 * H).toISOString();
      await db.exec(`UPDATE public.layover_sessions SET departure_time = '${dep}', boarding_time = NULL WHERE id = '${b!.sid}'`);
      const card = await app.call("GET", `/api/airport/sessions/${a!.sid}/crew`, a!.u);
      assert.equal(card.status, 200, card.raw);
      const plan = card.body.splitPlan.plan;
      assert.equal(plan.feasible, false, "the stored plan was served as still certified");
      assert.ok(plan.branches.find((x: any) => x.key === "rest").reasons.includes("branch_returns_after_member_deadline"));
      assert.equal((await plans(crewId))[0].status, "proposed", "the plan is kept; its certification is what changed");
    });

    it("P4 L135 — a branch that leaves the airport is certified against each member's own LANDSIDE GATE: on this chain an uncurated airport closes landside for everyone (B2-CURATE's maturity rule), so a landside branch is refused while an airside-only split certifies", async () => {
      const { ms: [a, b] } = await crew("p4", [10, 10]);
      await seedConfirmedCorridor(db, a!.u.id, "US", "SG");
      await db.exec(`INSERT INTO public.traveler_passports (user_id, issuing_country, is_primary) VALUES ('${b!.u.id}', 'XK', true);
        INSERT INTO public.entry_requirements (passport_country, destination_country, status, official_source_url) VALUES ('XK', 'SG', 'visa_required', 'https://example.test/official')`);
      const tA = (await hardReturn(a!)) - 30 * 60_000;
      const out = [{ title: "Gardens by the Bay", durationMin: 60, travelMin: 30, insideAirport: false }];
      const inside = [{ title: "Jewel", durationMin: 30, travelMin: 0, insideAirport: true }];
      const landside = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date(tA).toISOString(), stops: out }], rest: { returnBy: new Date(tA).toISOString(), stops: inside } });
      assert.equal(landside.status, 409, landside.raw);
      const b1 = landside.body.certification.branches.find((x: any) => x.key === "b1");
      assert.equal(b1.landside, "closed");
      assert.ok(b1.reasons.includes("landside_closed_for_member"), JSON.stringify(b1.reasons));
      assert.equal(landside.body.certification.branches.find((x: any) => x.key === "rest").feasible, true, "the airside branch was judged by the other branch's gate");
      const airside = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date(tA).toISOString(), stops: inside }], rest: { returnBy: new Date(tA).toISOString(), stops: inside } });
      assert.equal(airside.status, 200, airside.raw);
      assert.equal(airside.body.plan.feasible, true);
    });

    it("P5 a new proposal supersedes the old one atomically; the schema allows ONE live plan per crew and refuses edits to a branch", async () => {
      const { ms: [a, b], crewId } = await crew("p5", [10, 10]);
      const t = (await hardReturn(a!)) - H;
      const body = { branches: [{ memberIds: [a!.u.id], returnBy: new Date(t).toISOString() }], rest: { returnBy: new Date(t - H).toISOString() } };
      assert.equal((await app.call("POST", planPath(a!), a!.u, body)).status, 200);
      assert.equal((await app.call("POST", planPath(b!), b!.u, { branches: [{ memberIds: [b!.u.id], returnBy: new Date(t).toISOString() }], rest: { returnBy: new Date(t).toISOString() } })).status, 200);
      const live = (await plans(crewId)).filter((x) => x.status === "proposed");
      assert.equal(new Set(live.map((x) => x.branch_key)).size, 2);
      assert.deepEqual((await db.query<any>(`SELECT status, count(*)::int AS n FROM public.layover_crew_plans WHERE crew_id = '${crewId}' GROUP BY status ORDER BY status`)), [{ status: "proposed", n: 1 }, { status: "superseded", n: 1 }]);
      await assert.rejects(db.exec(`INSERT INTO public.layover_crew_plans (crew_id, proposed_by, proposed_session_id, crew_version) VALUES ('${crewId}', '${a!.u.id}', '${a!.sid}', 'x')`), /duplicate key|unique/i);
      await assert.rejects(db.exec(`UPDATE public.layover_crew_plan_branches SET return_by = now() WHERE plan_id IN (SELECT id FROM public.layover_crew_plans WHERE crew_id = '${crewId}')`), /never edited/i);
    });

    it("P6 only live crew members can be in a plan: the route refuses naming a stranger, and the schema refuses one even from the service role", async () => {
      const { ms: [a], crewId } = await crew("p6", [10, 10]);
      const x = await db.seedUser("p6x");
      const t = new Date((await hardReturn(a!)) - H).toISOString();
      const r = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [x.id], returnBy: t }], rest: { returnBy: t } });
      assert.equal(r.status, 400, r.raw);
      await assert.rejects(
        db.exec(`SELECT public.layover_propose_crew_plan('${crewId}', '${a!.u.id}', '${a!.sid}', 'v', '[{"key":"b1","memberUserIds":["${x.id}"],"returnBy":"${t}"}]'::jsonb)`),
        /not a live member/i,
      );
      await assert.rejects(
        db.exec(`SELECT public.layover_propose_crew_plan('${crewId}', '${x.id}', '${a!.sid}', 'v', '[{"key":"b1","memberUserIds":["${a!.u.id}"],"returnBy":"${t}"}]'::jsonb)`),
        /only a LIVE member/i,
      );
    });

    it("P7 a crewmate the proposer cannot see (blocked) can never be NAMED in a branch; they still land in the rest branch, which is certified against them", async () => {
      const { ms: [a, b, c], crewId } = await crew("p7", [10, 10, 10]);
      await db.exec(`INSERT INTO public.blocks (blocker_id, blocked_id) VALUES ('${c!.u.id}', '${a!.u.id}')`);
      const t = new Date((await hardReturn(a!)) - H).toISOString();
      assert.equal((await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [c!.u.id], returnBy: t }], rest: { returnBy: t } })).status, 400);
      const r = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id, b!.u.id], returnBy: t }], rest: { returnBy: t } });
      assert.equal(r.status, 200, r.raw);
      const rest = r.body.plan.branches.find((x: any) => x.key === "rest");
      assert.deepEqual(rest.memberIds, [], "a blocked crewmate's id reached the proposer");
      assert.equal(rest.hiddenMemberCount, 1);
      assert.deepEqual((await plans(crewId)).find((x) => x.branch_key === "rest").member_user_ids, [c!.u.id]);
    });

    it("P8 withdraw: any live member may withdraw the plan; the crew card is back to no plan", async () => {
      const { ms: [a, b], crewId } = await crew("p8", [10, 10]);
      const t = new Date((await hardReturn(a!)) - H).toISOString();
      assert.equal((await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id, b!.u.id], returnBy: t }] })).status, 200);
      const w = await app.call("DELETE", planPath(b!), b!.u);
      assert.equal(w.status, 200, w.raw);
      assert.equal(w.body.withdrawn, 1);
      assert.equal((await plans(crewId))[0].status, "withdrawn");
      assert.equal((await app.call("GET", planPath(a!), a!.u)).body.plan, null);
    });
    it("P10 live airport waits recertify every member branch and the crew's shared deadline", async () => {
      await db.setFlag("layover_live_signals_enabled", true);
      try {
        const { ms: [a, b] } = await crew("p10", [9, 10]);
        const first = await hardReturn(a!), second = await hardReturn(b!);
        const made = await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date(first - 15 * 60_000).toISOString() }], rest: { returnBy: new Date(second - 15 * 60_000).toISOString() } });
        assert.equal(made.status, 200, made.raw);
        await db.exec(`INSERT INTO public.airport_fact_observations (airport_ref, fact_type, fact_class, value, observer_kind, observer_id, source_ref, observed_at, expires_at) VALUES ('SIN', 'security_wait_minutes', 'FAST_LIVE', 60, 'official', 'feed:crew-test', 'feed:crew-test/live-wait', now(), now() + interval '20 minutes')`);
        const card = await app.call("GET", `/api/airport/sessions/${a!.sid}/crew`, a!.u);
        assert.equal(card.status, 200, card.raw);
        assert.equal(Date.parse(card.body.solution.sharedReturnBy), first - 40 * 60_000, "crew deadline ignored the official 40-minute buffer increase");
        assert.equal(card.body.solution.sharedReturnBy, new Date(await hardReturn(a!)).toISOString(), "crew and solo safety disagree on the earliest member");
        const plan = await app.call("GET", planPath(a!), a!.u);
        assert.equal(plan.status, 200, plan.raw);
        assert.equal(plan.body.plan.feasible, false, plan.raw);
        assert.ok(plan.body.plan.branches.every((branch: { feasible: boolean; reasons: string[] }) => !branch.feasible && branch.reasons.includes("branch_returns_after_member_deadline")), plan.raw);
      } finally {
        await db.exec("DELETE FROM public.airport_fact_observations WHERE source_ref = 'feed:crew-test/live-wait'");
        await db.setFlag("layover_live_signals_enabled", false);
      }
    });

    it("P9 a member who LEAVES takes every plan naming them with them (no departed person's id outlives them in an itinerary — deletion fate)", async () => {
      const { ms: [a, b, c], crewId } = await crew("p9", [10, 10, 10]);
      const t = new Date((await hardReturn(a!)) - H).toISOString();
      assert.equal((await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: t }], rest: { returnBy: t } })).status, 200);
      assert.ok((await plans(crewId)).some((x) => (x.member_user_ids as string[]).includes(c!.u.id)));
      const l = await app.call("POST", `/api/airport/sessions/${c!.sid}/crew/leave`, c!.u);
      assert.equal(l.status, 200, l.raw);
      const left = await db.query<any>(`SELECT b.member_user_ids FROM public.layover_crew_plan_branches b JOIN public.layover_crew_plans p ON p.id = b.plan_id WHERE p.crew_id = '${crewId}'`);
      assert.ok(!left.some((x) => (x.member_user_ids as string[]).includes(c!.u.id)), "a departed member's id outlived them in a plan");
      assert.equal((await app.call("GET", planPath(b!), b!.u)).body.plan, null);
    });
  });

  describe("ALWAYS (any arm)", () => {
    it("A1 flag OFF: GET answers unavailable, POST is refused, and the crew card has NO splitPlan key (byte-identical to before)", async () => {
      await db.setFlag("layover_crew_split_plans_enabled", false);
      try {
        const { ms: [a] } = await crew("a1", [10, 10]);
        assert.equal((await app.call("GET", planPath(a!), a!.u)).body.available, false);
        assert.equal((await app.call("POST", planPath(a!), a!.u, { branches: [{ memberIds: [a!.u.id], returnBy: new Date(Date.now() + H).toISOString() }] })).status, 404);
        const card = await app.call("GET", `/api/airport/sessions/${a!.sid}/crew`, a!.u);
        assert.equal(card.status, 200, card.raw);
        assert.ok(!("splitPlan" in card.body), "the crew card changed with the flag off");
      } finally { await db.setFlag("layover_crew_split_plans_enabled", PRESS_ARM === "pressed"); }
    });

    it("A2 no client role can read or write the plan tables or call the write function (service role only)", async () => {
      const u = await db.seedUser("nosy");
      for (const t of ["layover_crew_plans", "layover_crew_plan_branches"]) {
        await assert.rejects(db.asUser(u.id, `SELECT * FROM public.${t}`), (e: any) => e?.code === "42501" || e?.code === "42P01");
      }
      if (await db.hasTable("layover_crew_plans")) {
        await assert.rejects(db.asUser(u.id, `SELECT public.layover_propose_crew_plan(gen_random_uuid(), '${u.id}', gen_random_uuid(), 'v', '[]'::jsonb)`), (e: any) => e?.code === "42501");
      }
    });

    it("A3 owner-scoped: a stranger cannot read, propose or withdraw through someone else's session", async () => {
      await db.setFlag("layover_crew_split_plans_enabled", PRESS_ARM === "pressed");
      const { ms: [a] } = await crew("a3", [10, 10]);
      const x = await db.seedUser("a3x");
      assert.equal((await app.call("GET", planPath(a!), x)).status, 404);
      assert.equal((await app.call("POST", planPath(a!), x, { branches: [] })).status, 404);
      assert.equal((await app.call("DELETE", planPath(a!), x)).status, 404);
    });

    it("A4 the bridge saw no unmodelled request shape", () => { assert.deepEqual(db.bridge.unmodelled, []); });
  });
});
