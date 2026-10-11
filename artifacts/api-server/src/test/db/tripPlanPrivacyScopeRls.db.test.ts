/**
 * 3720 on a real database: §6.3's `privacy_scope` at the client door to
 * `trip_plan_items` (census-trips §90, TR116).
 *
 * THE SET-UP: the organizer creates a trip; Ana and Cleo are accepted members.
 * Ana adds a PUBLIC place (location_is_private = FALSE) on a plan she scoped
 * `private`, a second on `selected_participants`, and Cleo a `crew` dinner. A
 * public place on a private plan is the case 3972's anchor clause cannot see:
 * only the scope may withhold it. Viewers read through RLS as `authenticated`
 * with the JWT GUCs auth.uid() reads — the PostgREST path — each in a
 * rolled-back transaction.
 *
 *   S1  CONTROL: Ana reads all three — her own plans whatever their scope;
 *   S2  THE POINT: Cleo reads only the crew dinner;
 *   S3  THE POINT: the organizer reads only the crew dinner;
 *   S4  every crew-wide scope (crew, trip, friends_nearby, public) is read by
 *       Cleo — the policy narrows only what §6.3 narrows;
 *   S5  the organizer cannot widen Ana's private plan through PostgREST's
 *       filtered UPDATE (0 rows); Ana can; service_role reads every row;
 *   S6  the policy is RESTRICTIVE: it survives as its own policy beside 3972's
 *       plan_items_select, and the crew's read of a crew row is unchanged.
 *
 * Skips without LOCAL_DB_URL (scripts/local-db/run-tests.sh refuses a run with
 * skipped > 0, so CI's api-server-local-db job runs every case).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("3720: privacy_scope through plan_items_privacy_scope_select", { skip: SKIP }, () => {
  let organizer = "";
  let ana = "";
  let cleo = "";
  let tripId = "";
  const spa = randomUUID();     // Ana: public place, PRIVATE plan
  const sail = randomUUID();    // Ana: public place, selected_participants plan
  const dinner = randomUUID();  // Cleo: public place, crew plan

  const itemsQ = () => `SELECT id FROM public.trip_plan_items WHERE trip_id = '${tripId}' ORDER BY id;`;
  const sorted = (ids: string[]) => [...ids].sort();

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

  before(() => {
    organizer = seedUser("tps_org");
    ana = seedUser("tps_ana");
    cleo = seedUser("tps_cleo");
    tripId = randomUUID();
    const r = kernel(command({ actor_user_id: organizer, type: "CREATE_TRIP", trip_id: tripId,
      payload: { title: "tps", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(r.ok, true, `CREATE_TRIP was rejected: ${JSON.stringify(r)}`);
    for (const m of [ana, cleo]) {
      exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${m}', 'member', 'accepted') ON CONFLICT DO NOTHING;`);
    }
    exec([
      `INSERT INTO public.trip_plan_items (id, trip_id, creator_id, title, location_name, lat, lng, location_is_private, privacy_scope, visibility) VALUES`,
      `  ('${spa}', '${tripId}', '${ana}', 'Hammam Secreto', 'Rua do Banho 3', 38.70417, -9.13853, FALSE, 'private', 'members'),`,
      `  ('${sail}', '${tripId}', '${ana}', 'Sail with Ben', 'Doca 2', 38.69, -9.2, FALSE, 'selected_participants', 'members'),`,
      `  ('${dinner}', '${tripId}', '${cleo}', 'Dinner', 'Praca', 38.71, -9.14, FALSE, 'crew', 'members');`,
    ].join("\n"), { single: true });
  });

  after(() => {
    exec(`DELETE FROM public.trip_plan_items WHERE trip_id = '${tripId}';`);
    for (const u of [organizer, ana, cleo]) if (u) deleteUser(u);
  });

  it("precondition: 3720's policy is installed, RESTRICTIVE, beside plan_items_select", () => {
    assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'trip_plan_items' AND policyname = 'plan_items_privacy_scope_select' AND permissive = 'RESTRICTIVE' AND cmd = 'SELECT';"), "1");
    assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'trip_plan_items' AND policyname = 'plan_items_select' AND permissive = 'PERMISSIVE';"), "1");
  });

  it("S1 CONTROL: the creator reads her own plans whatever their scope", () => {
    assert.deepEqual(viewAs(ana, itemsQ()), sorted([spa, sail, dinner]));
  });

  it("S2 THE POINT: a crew member reads the crew dinner and neither of Ana's narrow plans", () => {
    assert.deepEqual(viewAs(cleo, itemsQ()), [dinner]);
    const text = viewAs(cleo, `SELECT coalesce(title, '') || ' ' || coalesce(location_name, '') FROM public.trip_plan_items WHERE trip_id = '${tripId}';`).join("\n");
    for (const leaked of ["Hammam", "Rua do Banho", "Sail with Ben", "Doca"]) assert.equal(text.includes(leaked), false, `"${leaked}" reached the crew: ${text}`);
  });

  it("S3 THE POINT: the trip's organizer does not read them either", () => {
    assert.deepEqual(viewAs(organizer, itemsQ()), [dinner]);
  });

  it("S4 every crew-wide scope is read by the crew; only the narrow ones are withheld", () => {
    for (const scope of ["crew", "trip", "friends_nearby", "public"]) {
      const pre = `UPDATE public.trip_plan_items SET privacy_scope = '${scope}', visibility = '${scope === "public" ? "public" : "members"}' WHERE id = '${spa}';`;
      assert.deepEqual(viewAs(cleo, itemsQ(), pre), sorted([spa, dinner]), scope);
    }
  });

  it("S5 the organizer cannot widen Ana's private plan through a filtered UPDATE (0 rows); Ana can; service_role reads all", () => {
    const widen = `UPDATE public.trip_plan_items SET privacy_scope = 'crew' WHERE id = '${spa}' RETURNING id;`;
    assert.deepEqual(viewAs(organizer, widen), [], "the restrictive SELECT policy hides the row from a filtered UPDATE");
    assert.deepEqual(viewAs(ana, widen), [spa], "CONTROL: the statement itself works for the creator");
    assert.deepEqual(viewAs(organizer, `UPDATE public.trip_plan_items SET notes = 'x' WHERE id = '${dinner}' RETURNING id;`), [dinner],
      "vacuity guard: the organizer CAN update a crew row (2337's owner branch), so the 0 above is the hiding");
    assert.equal(scalar(`SELECT privacy_scope FROM public.trip_plan_items WHERE id = '${spa}';`), "private", "rolled back");
    assert.deepEqual(exec(`SET LOCAL ROLE service_role;\n${itemsQ()}`, { single: true }), sorted([spa, sail, dinner]));
  });
});
