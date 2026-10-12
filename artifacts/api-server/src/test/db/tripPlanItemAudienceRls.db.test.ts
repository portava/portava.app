/**
 * 3727 on a real database: the explicit selection behind §6.3's SELECTED_PARTICIPANTS, and the client door that
 * never widens (census-trips §96, owner ruling OD-1012-PRIV-5).
 *
 * THE SET-UP: the organizer creates a trip; Ana, Ben and Cleo are accepted members. Ana adds a public place on a
 * plan scoped `selected_participants` and a `crew` plan. Viewers read through RLS as `authenticated` with the JWT
 * GUCs auth.uid() reads — the PostgREST path — each in a rolled-back transaction.
 *
 *   A1  the writer is service_role only; it refuses a non-author, a non-member, the author herself, and a plan
 *       not scoped selected_participants; a write replaces the selection;
 *   A2  THE POINT: Ana and Ben (selected) read the plan; Cleo and the organizer do not;
 *   A3  no client role reads the selection table;
 *   A4  a scope change clears the selection, and re-entering the scope starts empty (nothing revives);
 *   A5  a membership that ends clears the person's selection; rejoining does not restore it;
 *   A6  the client door: the organizer cannot widen Ana's crew plan, cannot take over creator_id, may narrow a
 *       public plan to crew; Ana may widen her own; service_role is not bound by the client guard.
 *
 * Skips without LOCAL_DB_URL (scripts/local-db/run-tests.sh refuses a run with skipped > 0, so CI's
 * api-server-local-db job runs every case).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("3727: trip_plan_item_audience, the selection arm and the client never-widen guard", { skip: SKIP }, () => {
  let organizer = "";
  let ana = "";
  let ben = "";
  let cleo = "";
  let outsider = "";
  let tripId = "";
  const sail = randomUUID();    // Ana: public place, selected_participants plan
  const dinner = randomUUID();  // Ana: crew plan
  const fair = randomUUID();    // Ana: public plan

  const asRole = (role: string, uid: string | null, query: string) => [
    "BEGIN;",
    ...(uid ? [`SELECT set_config('request.jwt.claim.sub', '${uid}', true);`, `SELECT set_config('request.jwt.claim.role', '${role}', true);`] : []),
    `SET LOCAL ROLE ${role};`,
    query,
    "ROLLBACK;",
  ].join("\n");
  function viewAs(uid: string, query: string): string[] {
    return exec(asRole("authenticated", uid, query)).slice(uid ? 2 : 0);
  }
  /** stderr of a statement expected to fail, or "" when it succeeded. */
  function failureOf(script: string): string {
    const r = psql(script);
    return r.status === 0 ? "" : r.stderr;
  }
  const replace = (actor: string, members: string[], item = sail) =>
    `SELECT public.trip_plan_item_audience_replace('${item}', '${actor}', ARRAY[${members.map((m) => `'${m}'`).join(",")}]::uuid[]);`;
  const selected = () => exec(`SELECT member_id FROM public.trip_plan_item_audience WHERE plan_item_id = '${sail}' ORDER BY member_id;`);
  const sees = (uid: string, item = sail) => viewAs(uid, `SELECT id FROM public.trip_plan_items WHERE id = '${item}';`).includes(item);

  let flagWas: string | null = null;
  before(() => {
    // The switch (seeded FALSE by 3727) gates the selection arm; this suite turns it ON and restores it after.
    flagWas = scalar("SELECT enabled::text FROM public.feature_flags WHERE flag = 'trip_plan_selected_participants_enabled';");
    exec("UPDATE public.feature_flags SET enabled = TRUE WHERE flag = 'trip_plan_selected_participants_enabled';");
    organizer = seedUser("tpa_org");
    ana = seedUser("tpa_ana");
    ben = seedUser("tpa_ben");
    cleo = seedUser("tpa_cleo");
    outsider = seedUser("tpa_out");
    tripId = randomUUID();
    const r = kernel(command({ actor_user_id: organizer, type: "CREATE_TRIP", trip_id: tripId,
      payload: { title: "tpa", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(r.ok, true, `CREATE_TRIP was rejected: ${JSON.stringify(r)}`);
    for (const m of [ana, ben, cleo]) {
      exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${m}', 'member', 'accepted') ON CONFLICT DO NOTHING;`);
    }
    exec([
      `INSERT INTO public.trip_plan_items (id, trip_id, creator_id, title, location_name, lat, lng, location_is_private, privacy_scope, visibility) VALUES`,
      `  ('${sail}', '${tripId}', '${ana}', 'Sail with Ben', 'Doca 2', 38.69, -9.2, FALSE, 'selected_participants', 'members'),`,
      `  ('${dinner}', '${tripId}', '${ana}', 'Dinner', 'Praca', 38.71, -9.14, FALSE, 'crew', 'members'),`,
      `  ('${fair}', '${tripId}', '${ana}', 'Fair', 'Feira', 38.72, -9.13, FALSE, 'public', 'public');`,
    ].join("\n"), { single: true });
  });

  after(() => {
    exec(`UPDATE public.feature_flags SET enabled = ${flagWas === "true" ? "TRUE" : "FALSE"} WHERE flag = 'trip_plan_selected_participants_enabled';`);
    exec(`DELETE FROM public.trip_plan_items WHERE trip_id = '${tripId}';`);
    for (const u of [organizer, ana, ben, cleo, outsider]) if (u) deleteUser(u);
  });

  it("precondition: 3727's objects are installed", () => {
    assert.equal(scalar("SELECT to_regclass('public.trip_plan_item_audience') IS NOT NULL;"), "t");
    assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname IN ('trip_plan_items_clear_audience', 'trip_members_clear_plan_audience', 'trip_plan_items_client_never_widens') AND NOT tgisinternal;"), "3");
    assert.match(String(scalar("SELECT pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polname = 'plan_items_privacy_scope_select';")), /plan_item_audience_admits/);
  });

  it("A1 the writer: service_role only, author only, crew only, selected_participants only; a write replaces", () => {
    assert.match(failureOf(asRole("authenticated", ana, replace(ana, [ben]))), /permission denied/);
    assert.match(failureOf(`SET ROLE service_role;\n${replace(organizer, [cleo])}`), /TRIP_PLAN_AUDIENCE_NOT_AUTHOR/);
    assert.match(failureOf(`SET ROLE service_role;\n${replace(ana, [outsider])}`), /TRIP_PLAN_AUDIENCE_NOT_CREW/);
    assert.match(failureOf(`SET ROLE service_role;\n${replace(ana, [ana])}`), /TRIP_PLAN_AUDIENCE_NOT_CREW/);
    assert.match(failureOf(`SET ROLE service_role;\n${replace(ana, [ben], dinner)}`), /TRIP_PLAN_AUDIENCE_SCOPE_MISMATCH/);
    exec(`SET ROLE service_role;\n${replace(ana, [cleo])}`, { single: true });
    exec(`SET ROLE service_role;\n${replace(ana, [ben])}`, { single: true });
    assert.deepEqual(selected(), [ben], "a replacement, not a union");
  });

  it("A2 THE POINT: the author and the person she selected read the plan; unselected crew and the organizer do not", () => {
    assert.equal(sees(ana), true, "CONTROL: the author");
    assert.equal(sees(ben), true, "Ben, selected");
    assert.equal(sees(cleo), false, "Cleo, crew");
    assert.equal(sees(organizer), false, "the organizer");
    assert.equal(sees(cleo, dinner), true, "vacuity guard: Cleo reads the crew plan");
  });

  it("A2b the switch OFF: a stored selection admits nobody through PostgREST; the author still reads her plan", () => {
    const off = "UPDATE public.feature_flags SET enabled = FALSE WHERE flag = 'trip_plan_selected_participants_enabled';";
    const q = `SELECT id FROM public.trip_plan_items WHERE id = '${sail}';`;
    const asBen = exec(["BEGIN;", off, `SELECT set_config('request.jwt.claim.sub', '${ben}', true);`, "SET LOCAL ROLE authenticated;", q, "ROLLBACK;"].join("\n")).slice(1);
    assert.deepEqual(asBen, [], "switch off: Ben is not admitted");
    const asAna = exec(["BEGIN;", off, `SELECT set_config('request.jwt.claim.sub', '${ana}', true);`, "SET LOCAL ROLE authenticated;", q, "ROLLBACK;"].join("\n")).slice(1);
    assert.deepEqual(asAna, [sail], "CONTROL: the author");
  });

  it("A3 no client role reads the selection table", () => {
    assert.match(failureOf(asRole("authenticated", ben, `SELECT * FROM public.trip_plan_item_audience;`)), /permission denied/);
    assert.match(failureOf(asRole("anon", null, `SELECT * FROM public.trip_plan_item_audience;`)), /permission denied/);
  });

  it("A4 a scope change clears the selection; re-entering selected_participants starts empty", () => {
    exec(`UPDATE public.trip_plan_items SET privacy_scope = 'private' WHERE id = '${sail}';`);
    assert.deepEqual(selected(), []);
    exec(`UPDATE public.trip_plan_items SET privacy_scope = 'selected_participants' WHERE id = '${sail}';`);
    assert.equal(sees(ben), false, "nothing revives");
    exec(`SET ROLE service_role;\n${replace(ana, [ben])}`, { single: true });
    assert.equal(sees(ben), true);
  });

  it("A5 a membership that ends clears the selection; rejoining does not restore it", () => {
    exec(`UPDATE public.trip_members SET status = 'left' WHERE trip_id = '${tripId}' AND user_id = '${ben}';`);
    assert.deepEqual(selected(), []);
    exec(`UPDATE public.trip_members SET status = 'accepted' WHERE trip_id = '${tripId}' AND user_id = '${ben}';`);
    assert.equal(sees(ben), false);
  });

  it("A6 the client door: the organizer narrows, never widens, never takes over; the author widens; service_role is unbound", () => {
    assert.match(failureOf(asRole("authenticated", organizer, `UPDATE public.trip_plan_items SET privacy_scope = 'public', visibility = 'public' WHERE id = '${dinner}';`)), /TRIP_PLAN_SCOPE_WIDENING_REFUSED/);
    assert.match(failureOf(asRole("authenticated", organizer, `UPDATE public.trip_plan_items SET creator_id = '${organizer}' WHERE id = '${dinner}';`)), /TRIP_PLAN_CREATOR_IMMUTABLE/);
    assert.deepEqual(viewAs(organizer, `UPDATE public.trip_plan_items SET privacy_scope = 'crew', visibility = 'members' WHERE id = '${fair}' RETURNING id;`), [fair], "narrowing public -> crew");
    assert.deepEqual(viewAs(ana, `UPDATE public.trip_plan_items SET privacy_scope = 'public', visibility = 'public' WHERE id = '${dinner}' RETURNING id;`), [dinner], "the author widens explicitly");
    exec(`SET ROLE service_role;\nUPDATE public.trip_plan_items SET privacy_scope = 'trip' WHERE id = '${dinner}';`, { single: true });
    assert.equal(scalar(`SELECT privacy_scope FROM public.trip_plan_items WHERE id = '${dinner}';`), "trip");
  });
});
