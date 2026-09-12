/**
 * Trips spec §5.3 — the historical evidence class is policy-controlled with
 * minimised payloads; §20.2 — evidence preserved per policy. EXECUTED against
 * 2789 on a real database (census-trips TR100, TR387).
 *
 *   a row's retention is a year from its own creation, never before it;
 *   a row past retention is pruned and the prune reports the count, a live one
 *   stays; a coordinate key in `metadata` is refused at the table for every
 *   new row; the prune function is service_role's alone.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, psql, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2789 trip_activity_log retention on a real database", { skip: SKIP }, () => {
  let owner = "";
  let tripId = "";
  const svc = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });

  before(() => {
    owner = seedUser("activity_owner");
    const minted = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted, payload: { title: "evidence", destination_city: "Porto", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    tripId = created.result?.id ?? minted;
  });
  after(() => { if (owner) deleteUser(owner); });

  it("retain_until defaults to a year after created_at and cannot precede it; the minimised CHECK refuses a coordinate key", () => {
    const id = randomUUID();
    svc(`INSERT INTO public.trip_activity_log (id, trip_id, actor_id, event_type, metadata) VALUES ('${id}', '${tripId}', '${owner}', 'trip_completed', '{"note": "closeout"}')`);
    const row = rows<{ delta_days: number }>(`SELECT round(extract(epoch FROM (retain_until - created_at)) / 86400)::int AS delta_days FROM public.trip_activity_log WHERE id = '${id}'`)[0]!;
    assert.equal(Number(row.delta_days), 365);
    const early = psql(`SET LOCAL ROLE service_role; UPDATE public.trip_activity_log SET retain_until = created_at - interval '1 day' WHERE id = '${id}';`, { single: true });
    assert.notEqual(early.status, 0, "retention before creation is refused");
    assert.match(early.stderr, /trip_activity_log_retention_after_create/);
    const coord = psql(`SET LOCAL ROLE service_role; INSERT INTO public.trip_activity_log (trip_id, actor_id, event_type, metadata) VALUES ('${tripId}', '${owner}', 'plan_added', '{"lat": 41.15, "lng": -8.61}');`, { single: true });
    assert.notEqual(coord.status, 0, "a coordinate in the evidence payload is refused");
    assert.match(coord.stderr, /trip_activity_log_metadata_minimised/);
    const nested = psql(`SET LOCAL ROLE service_role; INSERT INTO public.trip_activity_log (trip_id, actor_id, event_type, metadata) VALUES ('${tripId}', '${owner}', 'plan_added', '{"latitude": 41.15}');`, { single: true });
    assert.notEqual(nested.status, 0);
  });

  it("the prune deletes past retention, keeps the live row, reports the count, and is not callable by a client role", () => {
    const old = randomUUID(); const live = randomUUID();
    svc(`INSERT INTO public.trip_activity_log (id, trip_id, actor_id, event_type, metadata, created_at, retain_until) VALUES ('${old}', '${tripId}', '${owner}', 'member_joined', '{}', now() - interval '400 days', now() - interval '35 days')`);
    svc(`INSERT INTO public.trip_activity_log (id, trip_id, actor_id, event_type, metadata) VALUES ('${live}', '${tripId}', '${owner}', 'member_joined', '{}')`);
    const pruned = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_activity_log_prune()::text`) ?? "{}");
    assert.equal(pruned.ok, true); assert.ok(pruned.pruned >= 1, JSON.stringify(pruned));
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_activity_log WHERE id = '${old}'`)), 0, "past retention: gone");
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_activity_log WHERE id = '${live}'`)), 1, "within retention: kept");
    const denied = psql(`SET LOCAL ROLE authenticated; SELECT public.trip_activity_log_prune();`, { single: true });
    assert.notEqual(denied.status, 0, "a client role cannot prune");
    assert.match(denied.stderr, /permission denied/);
  });
});
