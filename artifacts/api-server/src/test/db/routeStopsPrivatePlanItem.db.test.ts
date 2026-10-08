/**
 * 3978 on a real database: a private plan item placed on a member's route does
 * not reach the rest of the crew through `route_stops` or `route_legs`
 * (census-trips §86; OD-TRIP-3; lead ruling D-65; wave 5 item 4).
 *
 * WHAT WAS WRONG: a stop made from a plan item copies its title and
 * {label, lat, lng}; 2334's crew policies let every accepted member read every
 * stop and leg of the trip's routes straight through PostgREST, around 3972's
 * owner-only door on `trip_plan_items`.
 *
 * THE SET-UP: the trip owner creates a PRIVATE item and a PUBLIC item; a crew
 * member ("route owner") builds a route with stops made from both, a manual
 * stop, a plan-item stop whose source_id is not an id, and one naming no item;
 * legs join them. Viewers: another crew member, a crew member holding the
 * owner's grant, the item's creator, the route's owner, a stranger.
 *
 *   S1  THE POINT: a crew member sees the manual and the public-item stops and
 *       not the private-item stop (nor the malformed / dangling plan-item stops);
 *   S2  THE POINT: that crew member sees only the leg that touches no withheld stop;
 *   S3  the item's creator sees the private stop and its legs;
 *   S4  a grantee sees it while sharing is ON, and not while it is OFF;
 *   S5  the route's owner keeps every stop and leg (0058's owner policies);
 *   S6  CONTROL: a stranger sees nothing; the service role sees everything;
 *   S7  the rule follows the item: made public, the crew member sees its stop.
 *
 * Skips without LOCAL_DB_URL (scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's api-server-local-db job runs every case).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";
const FLAG = "trip_private_anchor_sharing_enabled";

describe("3978: private plan items on a route, through route_stops / route_legs", { skip: SKIP }, () => {
  let owner = "";
  let routeOwner = "";
  let crew = "";
  let grantee = "";
  let stranger = "";
  let tripId = "";
  let privateItem = "";
  let publicItem = "";
  const planId = randomUUID();
  const stop = { manual: randomUUID(), priv: randomUUID(), pub: randomUUID(), malformed: randomUUID(), dangling: randomUUID() };
  const leg = { manualToPriv: randomUUID(), privToPub: randomUUID(), manualToPub: randomUUID() };

  function ok(over: Record<string, unknown>) {
    const r = kernel(command({ actor_user_id: owner, ...over }));
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }

  /**
   * One read as a signed-in user, through RLS, in a transaction that is rolled
   * back: `pre` runs first as the harness superuser (a flag flip, an item
   * update) and never persists.
   */
  function viewAs(uid: string, query: string, pre = ""): string[] {
    const out = exec(
      [
        "BEGIN;",
        pre,
        `SELECT set_config('request.jwt.claim.sub', '${uid}', true);`,
        `SELECT set_config('request.jwt.claim.role', 'authenticated', true);`,
        "SET LOCAL ROLE authenticated;",
        query,
        "ROLLBACK;",
      ].join("\n"),
    );
    return out.slice(2);
  }
  const FLAG_ON = `UPDATE public.feature_flags SET enabled = TRUE WHERE flag = '${FLAG}';`;
  const FLAG_OFF = `UPDATE public.feature_flags SET enabled = FALSE WHERE flag = '${FLAG}';`;
  const stopsQ = () => `SELECT id FROM public.route_stops WHERE route_plan_id = '${planId}' ORDER BY id;`;
  const legsQ = () => `SELECT id FROM public.route_legs WHERE route_plan_id = '${planId}' ORDER BY id;`;
  const sorted = (ids: string[]) => [...ids].sort();

  before(() => {
    owner = seedUser("rsp_owner");
    routeOwner = seedUser("rsp_route");
    crew = seedUser("rsp_crew");
    grantee = seedUser("rsp_grantee");
    stranger = seedUser("rsp_stranger");
    tripId = randomUUID();
    ok({ type: "CREATE_TRIP", trip_id: tripId, payload: { title: "rsp", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } });
    for (const m of [routeOwner, crew, grantee]) {
      exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${m}', 'member', 'accepted') ON CONFLICT DO NOTHING;`);
    }
    const stageId = ok({
      type: "ADD_STAGE", trip_id: tripId,
      payload: { stage_type: "city", city_id: randomUUID(), timezone: "Europe/Lisbon", sequence: 1, starts_at: "2026-10-01T08:00:00Z", ends_at: "2026-10-03T20:00:00Z" },
    }).result?.id;
    privateItem = ok({
      type: "ADD_PLAN", trip_id: tripId,
      payload: { title: "Secret Hotel", location_name: "Rua Secreta 4", stage_id: stageId, day_date: "2026-10-02", location_is_private: true },
    }).result?.id;
    publicItem = ok({
      type: "ADD_PLAN", trip_id: tripId,
      payload: { title: "Open Museum", stage_id: stageId, day_date: "2026-10-02", location_is_private: false },
    }).result?.id;
    assert.ok(privateItem && publicItem, "both items were created");
    // The owner's grant to `grantee` (after the membership: 3972's trigger clears grants when one begins).
    exec(`INSERT INTO public.trip_private_anchor_shares (plan_item_id, trip_id, owner_id, member_id) VALUES ('${privateItem}', '${tripId}', '${owner}', '${grantee}');`);
    const loc = (label: string) => `'{"label":"${label}","lat":38.71,"lng":-9.14}'::jsonb`;
    exec([
      `INSERT INTO public.route_plans (id, owner_user_id, trip_id, title) VALUES ('${planId}', '${routeOwner}', '${tripId}', 'rsp route');`,
      `INSERT INTO public.route_stops (id, route_plan_id, source_type, source_id, title, structured_location, order_index) VALUES`,
      `  ('${stop.manual}', '${planId}', 'manual', NULL, 'Start', ${loc("Start")}, 0),`,
      `  ('${stop.priv}', '${planId}', 'plan_item', '${privateItem}', 'Secret Hotel', ${loc("Rua Secreta 4")}, 1),`,
      `  ('${stop.pub}', '${planId}', 'plan_item', '${publicItem}', 'Open Museum', ${loc("Museum")}, 2),`,
      `  ('${stop.malformed}', '${planId}', 'plan_item', 'not-an-id', 'Odd', ${loc("Odd")}, 3),`,
      `  ('${stop.dangling}', '${planId}', 'plan_item', '${randomUUID()}', 'Gone', ${loc("Gone")}, 4);`,
      `INSERT INTO public.route_legs (id, route_plan_id, from_stop_id, to_stop_id, polyline) VALUES`,
      `  ('${leg.manualToPriv}', '${planId}', '${stop.manual}', '${stop.priv}', 'secret-way'),`,
      `  ('${leg.privToPub}', '${planId}', '${stop.priv}', '${stop.pub}', 'secret-way-out'),`,
      `  ('${leg.manualToPub}', '${planId}', '${stop.manual}', '${stop.pub}', 'open-way');`,
    ].join("\n"), { single: true });
  });

  after(() => {
    exec(`DELETE FROM public.route_plans WHERE id = '${planId}';`);
    for (const u of [owner, routeOwner, crew, grantee, stranger]) if (u) deleteUser(u);
  });

  it("precondition: the sharing flag exists (3970 seeds it) and 3978's policies are in place", () => {
    assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag = '${FLAG}';`), "1");
    assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'route_stops' AND policyname = 'route_stops_member_select' AND qual LIKE '%plan_item_stop_visible%';"), "1");
    assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'route_legs' AND policyname = 'route_legs_member_select' AND qual LIKE '%route_leg_endpoints_visible%';"), "1");
  });

  it("S1 THE POINT: a crew member sees the manual and public-item stops, never the private one", () => {
    assert.deepEqual(viewAs(crew, stopsQ(), FLAG_ON), sorted([stop.manual, stop.pub]));
    const text = viewAs(crew, `SELECT title || ' ' || structured_location::text FROM public.route_stops WHERE route_plan_id = '${planId}';`, FLAG_ON).join("\n");
    for (const leaked of ["Secret Hotel", "Rua Secreta"]) assert.equal(text.includes(leaked), false, `"${leaked}" reached the crew: ${text}`);
  });

  it("S2 THE POINT: that crew member sees only the leg that touches no withheld stop", () => {
    assert.deepEqual(viewAs(crew, legsQ(), FLAG_ON), [leg.manualToPub]);
  });

  it("S3 the item's creator sees the private stop and both of its legs", () => {
    assert.deepEqual(viewAs(owner, stopsQ()), sorted([stop.manual, stop.priv, stop.pub]));
    assert.deepEqual(viewAs(owner, legsQ()), sorted([leg.manualToPriv, leg.privToPub, leg.manualToPub]));
  });

  it("S4 a grantee sees it while sharing is ON, and not while it is OFF", () => {
    assert.deepEqual(viewAs(grantee, stopsQ(), FLAG_ON), sorted([stop.manual, stop.priv, stop.pub]));
    assert.deepEqual(viewAs(grantee, legsQ(), FLAG_ON), sorted([leg.manualToPriv, leg.privToPub, leg.manualToPub]));
    assert.deepEqual(viewAs(grantee, stopsQ(), FLAG_OFF), sorted([stop.manual, stop.pub]));
    assert.deepEqual(viewAs(grantee, legsQ(), FLAG_OFF), [leg.manualToPub]);
  });

  it("S5 the route's owner keeps every stop and leg", () => {
    assert.deepEqual(viewAs(routeOwner, stopsQ()), sorted(Object.values(stop)));
    assert.deepEqual(viewAs(routeOwner, legsQ()), sorted(Object.values(leg)));
  });

  it("S6 CONTROL: a stranger sees nothing; the service role sees everything", () => {
    assert.deepEqual(viewAs(stranger, stopsQ(), FLAG_ON), []);
    assert.deepEqual(viewAs(stranger, legsQ(), FLAG_ON), []);
    const all = exec(`SET LOCAL ROLE service_role;\n${stopsQ()}`, { single: true });
    assert.deepEqual(all, sorted(Object.values(stop)));
  });

  it("S7 the rule follows the item: made public, the crew member sees its stop and legs", () => {
    const flip = `UPDATE public.trip_plan_items SET location_is_private = FALSE WHERE id = '${privateItem}';`;
    assert.deepEqual(viewAs(crew, stopsQ(), flip), sorted([stop.manual, stop.priv, stop.pub]));
    assert.deepEqual(viewAs(crew, legsQ(), flip), sorted(Object.values(leg)));
    assert.equal(scalar(`SELECT location_is_private::text FROM public.trip_plan_items WHERE id = '${privateItem}';`), "true", "the flip was rolled back");
  });
});
