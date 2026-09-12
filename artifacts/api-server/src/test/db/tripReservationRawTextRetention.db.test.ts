/**
 * Trips spec §21.3 — recorded "without retaining unnecessary sensitive raw
 * data". EXECUTED against 2791 on a real database (census-trips TR403).
 *
 *   a pasted reservation's raw_text has a deadline thirty days from its own
 *   creation; past it, trip_reservations_forget_raw_text() forgets the text,
 *   reports the count and leaves 2784's history saying so (an `updated` event
 *   whose changed_keys name raw_text, version bumped); text within retention
 *   stays; the function is service_role's alone.
 *
 * Skips without LOCAL_DB_URL exactly as the other db tests do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, exec, kernel, psql, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("2791 trip_reservations raw_text retention on a real database", { skip: SKIP }, () => {
  let owner = "";
  let tripId = "";
  const svc = (sql: string) => exec(`SET LOCAL ROLE service_role;\n${sql}`, { single: true });
  const PASTE = "Booking confirmed: Hotel Aurora, 2 nights, ref ABC123, guest passport P1234567";

  before(() => {
    owner = seedUser("raw_text_owner");
    const minted = randomUUID();
    const created = kernel(command({ actor_user_id: owner, type: "CREATE_TRIP", trip_id: minted, payload: { title: "retention", destination_city: "Lisbon", destination_country: "Portugal", visibility: "private" } }));
    assert.equal(created.ok, true, JSON.stringify(created));
    tripId = created.result?.id ?? minted;
  });
  after(() => { if (owner) deleteUser(owner); });

  it("a pasted reservation's text has a deadline thirty days from its creation", () => {
    const id = randomUUID();
    svc(`INSERT INTO public.trip_reservations (id, trip_id, user_id, type, title, raw_text, status, created_from) VALUES ('${id}', '${tripId}', '${owner}', 'stay', 'Hotel Aurora', $q$${PASTE}$q$, 'pending_confirm', 'paste')`);
    const row = rows<{ delta_days: number; has_text: boolean }>(`SELECT round(extract(epoch FROM (raw_text_retain_until - created_at)) / 86400)::int AS delta_days, raw_text IS NOT NULL AS has_text FROM public.trip_reservations WHERE id = '${id}'`)[0]!;
    assert.equal(Number(row.delta_days), 30);
    assert.equal(row.has_text, true);
  });

  it("past the deadline the text is forgotten and the history says so; within it the text stays; a client role cannot forget", () => {
    const old = randomUUID(); const live = randomUUID();
    svc(`INSERT INTO public.trip_reservations (id, trip_id, user_id, type, title, raw_text, status, created_from, created_at, raw_text_retain_until) VALUES ('${old}', '${tripId}', '${owner}', 'flight', 'TP 1234', $q$${PASTE}$q$, 'confirmed', 'paste', now() - interval '45 days', now() - interval '15 days')`);
    svc(`INSERT INTO public.trip_reservations (id, trip_id, user_id, type, title, raw_text, status, created_from) VALUES ('${live}', '${tripId}', '${owner}', 'activity', 'Museum', $q$${PASTE}$q$, 'pending_confirm', 'paste')`);
    const versionBefore = Number(scalar(`SELECT version FROM public.trip_reservations WHERE id = '${old}'`));

    const out = JSON.parse(scalar(`SET LOCAL ROLE service_role; SELECT public.trip_reservations_forget_raw_text()::text`) ?? "{}");
    assert.equal(out.ok, true); assert.ok(out.forgotten >= 1, JSON.stringify(out));

    const forgotten = rows<{ raw_text: string | null; deadline: string | null; version: number; title: string }>(`SELECT raw_text, raw_text_retain_until AS deadline, version, title FROM public.trip_reservations WHERE id = '${old}'`)[0]!;
    assert.equal(forgotten.raw_text, null, "past retention: the text is gone");
    assert.equal(forgotten.deadline, null, "and there is no deadline left");
    assert.equal(forgotten.title, "TP 1234", "the reservation itself is kept");
    assert.equal(Number(forgotten.version), versionBefore + 1, "2784 bumped the version");
    const history = rows<{ event_type: string; changed_keys: string }>(`SELECT event_type, changed_keys::text AS changed_keys FROM public.trip_reservation_events WHERE reservation_id = '${old}' ORDER BY id DESC LIMIT 1`)[0]!;
    assert.equal(history.event_type, "updated");
    assert.match(history.changed_keys, /raw_text/);
    assert.equal(String(scalar(`SELECT count(*) FROM public.trip_reservation_events WHERE reservation_id = '${old}' AND payload_json::text LIKE '%P1234567%'`)), "0", "the history does not keep the text either");

    assert.equal(scalar(`SELECT raw_text FROM public.trip_reservations WHERE id = '${live}'`), PASTE, "within retention: kept");

    const denied = psql(`SET LOCAL ROLE authenticated; SELECT public.trip_reservations_forget_raw_text();`, { single: true });
    assert.notEqual(denied.status, 0, "a client role cannot forget");
    assert.match(denied.stderr, /permission denied/);
  });
});
