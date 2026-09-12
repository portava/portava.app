/**
 * Trips spec §7.4 — the transport-mode policy a route-availability check
 * reads. EXECUTED against 2793 on a real database (census-trips TR137).
 *
 *   the mode vocabulary is a CHECK, not a convention ("taxi" is refused, the
 *   provider's own modes are accepted); a crew member reads the policy
 *   through RLS and a non-member does not; a signed-in user cannot write it
 *   directly — the server (owner-gated) does.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, asUser, command, deleteUser, exec, kernel, psql, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2793 trip_transport_policies on a real database", { skip: SKIP }, () => {
  let owner = ""; let outsider = ""; let tripId = "";
  const svc = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });

  before(() => {
    owner = seedUser("policy_owner"); outsider = seedUser("policy_outsider");
    const minted = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted, payload: { title: "no taxis", destination_city: "Kyoto", destination_country: "Japan", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    tripId = created.result?.id ?? minted;
  });
  after(() => { for (const u of [owner, outsider]) if (u) deleteUser(u); });

  it("the mode vocabulary is a CHECK: taxi is refused, the provider's modes are accepted", () => {
    const bad = psql(`SET LOCAL ROLE service_role; INSERT INTO public.trip_transport_policies (trip_id, disallowed_modes) VALUES ('${tripId}', ARRAY['taxi']);`, { single: true });
    assert.notEqual(bad.status, 0, "a mode the provider does not know is not a policy");
    assert.match(bad.stderr, /trip_transport_policies_modes_known/);
    svc(`INSERT INTO public.trip_transport_policies (trip_id, disallowed_modes, note, updated_by) VALUES ('${tripId}', ARRAY['drive', 'transit'], 'walking city', '${owner}')`);
    assert.equal(scalar(`SELECT array_to_string(disallowed_modes, ',') FROM public.trip_transport_policies WHERE trip_id = '${tripId}'`), "drive,transit");
  });

  it("the crew reads the policy through RLS; a non-member reads nothing; a signed-in user cannot write it", () => {
    const mine = asUser(owner, `SELECT count(*) FROM public.trip_transport_policies WHERE trip_id = '${tripId}';`);
    assert.equal(String(mine[mine.length - 1]).trim(), "1", JSON.stringify(mine));
    const theirs = asUser(outsider, `SELECT count(*) FROM public.trip_transport_policies WHERE trip_id = '${tripId}';`);
    assert.equal(String(theirs[theirs.length - 1]).trim(), "0", JSON.stringify(theirs));
    const write = psql(`SELECT set_config('request.jwt.claim.sub', '${owner}', true); SELECT set_config('request.jwt.claim.role', 'authenticated', true); SET LOCAL ROLE authenticated; UPDATE public.trip_transport_policies SET disallowed_modes = '{}' WHERE trip_id = '${tripId}';`, { single: true });
    assert.notEqual(write.status, 0, "even the owner does not write the policy directly; the server does");
    assert.match(write.stderr, /permission denied/);
  });
});
