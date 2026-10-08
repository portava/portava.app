/**
 * 3972 on a real database: the client door to a private plan item
 * (`plan_items_select`) and the triggers that keep a private-anchor grant from
 * outliving what made it true (census-trips §81 / §81.3; OD-TRIP-3; lead
 * ruling D-65).
 *
 * WHY THIS FILE EXISTS. 3972 was pinned only by reading its SQL as text. CI's
 * local-db job then executed it, and its membership trigger raised
 * `invalid input value for enum member_role: ""` on EVERY update of a
 * trip_members row's role or status — ACCEPT_INVITE, SET_PARTICIPANT_ROLE and
 * the offline-replay suite all died on it — because `coalesce(OLD.role, '')`
 * casts '' to the enum. A text reading could not see that; this file executes
 * every branch of the trigger and the policy.
 *
 * THE SET-UP: the organizer creates a trip; Ana, Ben and Cleo are accepted
 * members; Ana adds a PRIVATE stay and Cleo a public dinner; Ana grants Ben
 * sight of her stay. Viewers read through RLS as `authenticated` with the JWT
 * GUCs auth.uid() reads — the PostgREST path — each in a rolled-back
 * transaction.
 *
 *   R1  CONTROL: Ana (the creator) reads her stay, every locating column;
 *   R2  THE POINT: Cleo (crew, no grant) reads the dinner and not the stay;
 *   R3  THE POINT: the organizer does not read it either;
 *   R4  Ben reads it while sharing is ON and not while it is OFF;
 *   R5  a grant whose giver is no longer an accepted member admits nobody
 *       (the read-time rule, with the trigger's cleanup bypassed);
 *   R6  a pending invitee and a stranger read nothing; service_role reads both;
 *   R7  the organizer cannot reach the stay through an UPDATE either: the
 *       PostgREST shape (a filtered PATCH) touches 0 rows, so it cannot flip
 *       the stay public and read it back; Ana's own update of it works;
 *   L1  THE DEFECT: a role change between two accepted roles (member ->
 *       co_host) succeeds and keeps the grant;
 *   L2  the grantee leaving clears the grant TO him;
 *   L3  the giver being removed clears the grant BY her;
 *   L4  a move out of accepted membership by role (-> invited) clears it;
 *   L5  deleting the membership clears it;
 *   L6  a membership that BEGINS clears grants left over from an earlier one;
 *   L7  the stay made public, or soft-removed, clears every grant on it.
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

describe("3972: a private plan item through plan_items_select, and the grant lifecycle", { skip: SKIP }, () => {
  let organizer = "";
  let ana = "";
  let ben = "";
  let cleo = "";
  let invitee = "";
  let stranger = "";
  let dave = "";
  let tripId = "";
  const stay = randomUUID();
  const dinner = randomUUID();

  const FLAG_ON = `UPDATE public.feature_flags SET enabled = TRUE WHERE flag = '${FLAG}';`;
  const FLAG_OFF = `UPDATE public.feature_flags SET enabled = FALSE WHERE flag = '${FLAG}';`;
  const itemsQ = () => `SELECT id FROM public.trip_plan_items WHERE trip_id = '${tripId}' ORDER BY id;`;
  const sorted = (ids: string[]) => [...ids].sort();

  /** One statement as a signed-in user through RLS; `pre` runs first as the harness superuser; nothing persists. */
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

  /** As the harness superuser: `change`, then how many grant rows name `who`; rolled back. Throws on any SQL error. */
  function grantsAfter(change: string, where = `trip_id = '${tripId}'`): string {
    const out = exec(["BEGIN;", change, `SELECT count(*) FROM public.trip_private_anchor_shares WHERE ${where};`, "ROLLBACK;"].join("\n"));
    return out.at(-1)!;
  }

  before(() => {
    organizer = seedUser("pia_org");
    ana = seedUser("pia_ana");
    ben = seedUser("pia_ben");
    cleo = seedUser("pia_cleo");
    invitee = seedUser("pia_inv");
    stranger = seedUser("pia_str");
    dave = seedUser("pia_dave");
    tripId = randomUUID();
    const r = kernel(command({ actor_user_id: organizer, type: "CREATE_TRIP", trip_id: tripId,
      payload: { title: "pia", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(r.ok, true, `CREATE_TRIP was rejected: ${JSON.stringify(r)}`);
    for (const m of [ana, ben, cleo]) {
      exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${m}', 'member', 'accepted') ON CONFLICT DO NOTHING;`);
    }
    exec(`INSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${invitee}', 'invited', 'invited') ON CONFLICT DO NOTHING;`);
    exec([
      `INSERT INTO public.trip_plan_items (id, trip_id, creator_id, title, location_name, notes, lat, lng, location_is_private, city, description) VALUES`,
      `  ('${stay}', '${tripId}', '${ana}', 'Casa Segreta', 'Rua do Segredo 7', 'door code 4471', 38.70417, -9.13853, TRUE, 'Vila Segreta', 'suite over the garden'),`,
      `  ('${dinner}', '${tripId}', '${cleo}', 'Dinner', 'Praca', NULL, 38.71, -9.14, FALSE, NULL, NULL);`,
      // After the memberships: 3972's trigger clears grants when one begins.
      `INSERT INTO public.trip_private_anchor_shares (plan_item_id, trip_id, owner_id, member_id) VALUES ('${stay}', '${tripId}', '${ana}', '${ben}');`,
    ].join("\n"), { single: true });
  });

  after(() => {
    exec(`DELETE FROM public.trip_plan_items WHERE trip_id = '${tripId}';`);
    for (const u of [organizer, ana, ben, cleo, invitee, stranger, dave]) if (u) deleteUser(u);
  });

  it("precondition: the flag exists and ships OFF; 3972's policy and both triggers are installed; Ben's grant is in place", () => {
    assert.equal(scalar(`SELECT count(*) FROM public.feature_flags WHERE flag = '${FLAG}' AND enabled = FALSE;`), "1");
    assert.equal(scalar("SELECT count(*) FROM pg_policies WHERE tablename = 'trip_plan_items' AND policyname = 'plan_items_select' AND qual LIKE '%private_anchor_granted%';"), "1");
    assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname IN ('trip_members_clear_anchor_grants', 'trip_plan_items_clear_anchor_grants') AND NOT tgisinternal;"), "2");
    assert.equal(scalar(`SELECT count(*) FROM public.trip_private_anchor_shares WHERE plan_item_id = '${stay}' AND member_id = '${ben}';`), "1");
  });

  it("R1 CONTROL: the creator reads her private stay, every locating column", () => {
    assert.deepEqual(viewAs(ana, itemsQ()), sorted([stay, dinner]));
    const row = viewAs(ana, `SELECT title || '|' || location_name || '|' || lat::text || '|' || notes FROM public.trip_plan_items WHERE id = '${stay}';`);
    assert.deepEqual(row, ["Casa Segreta|Rua do Segredo 7|38.70417|door code 4471"]);
  });

  it("R2 THE POINT: a crew member with no grant reads the public dinner and not the stay", () => {
    assert.deepEqual(viewAs(cleo, itemsQ(), FLAG_ON), [dinner]);
    const text = viewAs(cleo, `SELECT coalesce(title, '') || ' ' || coalesce(location_name, '') || ' ' || coalesce(notes, '') FROM public.trip_plan_items WHERE trip_id = '${tripId}';`, FLAG_ON).join("\n");
    for (const leaked of ["Casa Segreta", "Rua do Segredo", "door code"]) assert.equal(text.includes(leaked), false, `"${leaked}" reached the crew: ${text}`);
  });

  it("R3 THE POINT: the trip's organizer does not read it either", () => {
    assert.deepEqual(viewAs(organizer, itemsQ(), FLAG_ON), [dinner]);
  });

  it("R4 the grantee reads it while sharing is ON, and not while it is OFF", () => {
    assert.deepEqual(viewAs(ben, itemsQ(), FLAG_ON), sorted([stay, dinner]));
    assert.deepEqual(viewAs(ben, itemsQ(), FLAG_OFF), [dinner]);
  });

  it("R5 a grant whose giver is no longer an accepted member admits nobody (read-time rule; the trigger's cleanup is bypassed by re-inserting the row)", () => {
    const giverLeft = [
      FLAG_ON,
      `UPDATE public.trip_members SET status = 'left' WHERE trip_id = '${tripId}' AND user_id = '${ana}';`,
      `INSERT INTO public.trip_private_anchor_shares (plan_item_id, trip_id, owner_id, member_id) VALUES ('${stay}', '${tripId}', '${ana}', '${ben}') ON CONFLICT DO NOTHING;`,
    ].join("\n");
    assert.deepEqual(viewAs(ben, itemsQ(), giverLeft), [dinner]);
  });

  it("R6 a pending invitee and a stranger read nothing; service_role reads both", () => {
    assert.deepEqual(viewAs(invitee, itemsQ(), FLAG_ON), []);
    assert.deepEqual(viewAs(stranger, itemsQ(), FLAG_ON), []);
    assert.deepEqual(exec(`SET LOCAL ROLE service_role;\n${itemsQ()}`, { single: true }), sorted([stay, dinner]));
  });

  it("R7 the organizer cannot flip the stay public through PostgREST's filtered UPDATE (0 rows); its creator can update it", () => {
    const flip = `UPDATE public.trip_plan_items SET location_is_private = FALSE WHERE id = '${stay}' RETURNING id;`;
    assert.deepEqual(viewAs(organizer, flip, FLAG_ON), [], "the SELECT policy hides the row from a filtered UPDATE");
    assert.deepEqual(viewAs(ana, flip, FLAG_ON), [stay], "CONTROL: the statement itself works for the creator");
    assert.deepEqual(viewAs(organizer, `UPDATE public.trip_plan_items SET notes = 'x' WHERE id = '${dinner}' RETURNING id;`, FLAG_ON), [dinner],
      "vacuity guard: the organizer CAN update a row he can see (2337's owner branch), so the 0 above is the hiding");
    assert.equal(scalar(`SELECT location_is_private::text FROM public.trip_plan_items WHERE id = '${stay}';`), "true", "rolled back");
  });

  it("L1 THE DEFECT: a role change between two accepted roles succeeds and keeps the grant", () => {
    assert.equal(grantsAfter(`UPDATE public.trip_members SET role = 'co_host' WHERE trip_id = '${tripId}' AND user_id = '${ben}';`), "1");
    assert.equal(grantsAfter(`UPDATE public.trip_members SET role = 'viewer' WHERE trip_id = '${tripId}' AND user_id = '${ana}';`), "1");
    // A status write that leaves the person accepted is not a membership change either.
    assert.equal(grantsAfter(`UPDATE public.trip_members SET status = 'accepted' WHERE trip_id = '${tripId}' AND user_id = '${ben}';`), "1");
  });

  it("L2 the grantee leaving clears the grant to him", () => {
    assert.equal(grantsAfter(`UPDATE public.trip_members SET status = 'left' WHERE trip_id = '${tripId}' AND user_id = '${ben}';`), "0");
  });

  it("L3 the giver being removed clears the grant she gave", () => {
    assert.equal(grantsAfter(`UPDATE public.trip_members SET status = 'removed' WHERE trip_id = '${tripId}' AND user_id = '${ana}';`), "0");
  });

  it("L4 a move out of accepted membership by ROLE (-> invited) clears it", () => {
    assert.equal(grantsAfter(`UPDATE public.trip_members SET role = 'invited' WHERE trip_id = '${tripId}' AND user_id = '${ben}';`), "0");
  });

  it("L5 deleting the membership clears it", () => {
    assert.equal(grantsAfter(`DELETE FROM public.trip_members WHERE trip_id = '${tripId}' AND user_id = '${ben}';`), "0");
  });

  it("L6 a membership that BEGINS clears grants left over from an earlier one", () => {
    const leftover = `INSERT INTO public.trip_private_anchor_shares (plan_item_id, trip_id, owner_id, member_id) VALUES ('${stay}', '${tripId}', '${ana}', '${dave}');`;
    assert.equal(grantsAfter(leftover, `member_id = '${dave}'`), "1", "vacuity guard: the leftover row is written");
    assert.equal(grantsAfter(`${leftover}\nINSERT INTO public.trip_members (trip_id, user_id, role, status) VALUES ('${tripId}', '${dave}', 'member', 'accepted');`, `member_id = '${dave}'`), "0");
    // ...and a pending invitation accepted (invited -> member/accepted) is a membership beginning too.
    assert.equal(grantsAfter([
      `INSERT INTO public.trip_private_anchor_shares (plan_item_id, trip_id, owner_id, member_id) VALUES ('${stay}', '${tripId}', '${ana}', '${invitee}');`,
      `UPDATE public.trip_members SET role = 'member', status = 'accepted' WHERE trip_id = '${tripId}' AND user_id = '${invitee}';`,
    ].join("\n"), `member_id = '${invitee}'`), "0");
  });

  it("L7 the stay made public, or soft-removed, clears every grant on it; an unrelated edit keeps them", () => {
    assert.equal(grantsAfter(`UPDATE public.trip_plan_items SET location_is_private = FALSE WHERE id = '${stay}';`), "0");
    assert.equal(grantsAfter(`UPDATE public.trip_plan_items SET removed_at = now() WHERE id = '${stay}';`), "0");
    assert.equal(grantsAfter(`UPDATE public.trip_plan_items SET title = 'Casa Segreta II' WHERE id = '${stay}';`), "1");
  });
});
