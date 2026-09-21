/**
 * P12 — the Passport viewer context's buddy relationship, measured against the
 * REAL `rent_buddy_booking_status` vocabulary rather than against a fixture.
 *
 * ── THE DEFECT THIS PINS ────────────────────────────────────────────────────
 * `resolveBuddyRole` decided "are these two people in a buddy service
 * relationship" from a hand-rolled literal set:
 *
 *     const active = ["confirmed", "active", "completed", "in_progress"];
 *
 * Two of those four are fiction and one live status is missing:
 *
 *   • `active` is NOT a label of the enum. Because the membership test runs in
 *     JS (`active.includes(String(r.status))`) and not inside the predicate, it
 *     did not raise 22P02 the way the identical literal did in
 *     CompassAbuseDefenseEngine and interactionPermissions — the read succeeded
 *     and the literal simply never matched. Silent, and invisible to every fake
 *     that only answers "does my fixture's value appear in what you passed".
 *
 *   • `confirmed` is written by no route in src/ (see lib/rentBuddyBookingStatus.ts).
 *
 *   • `scheduled` — the ONE status a canonically accepted booking carries
 *     (rentABuddy.ts:2396 writes it on accept) — was absent. So between
 *     acceptance and session start, two people with a live booking resolved to
 *     `buddyRole: null` and the viewer never reached `buddy_provider` /
 *     `buddy_customer`.
 *
 * ── AND THE UNBOUND `.error` ────────────────────────────────────────────────
 * The read destructured `const { data } = await …`. supabase-js RESOLVES on a
 * database error, so an unreadable `rent_buddy_bookings` was indistinguishable
 * from "these two have never booked", and the `try/catch` wrapped around it was
 * dead code. `null` is the right (fail-closed) answer either way — buddyRole
 * only ever ADDS context — but the failure must be OBSERVABLE, so the error is
 * now bound and logged. Test 6 is what holds that line.
 *
 * VACUITY: tests 1-2 count what they inspected and refuse to pass on an empty
 * vocabulary or an empty status set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { vocabulary } from "./helpers/enumAwareSupabase.js";
import {
  BUDDY_RELATIONSHIP_STATUSES,
  resolveBuddyRole,
} from "../services/passport/PassportProjectionService.js";
import { logger } from "../lib/logger.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const VIEWER = "22222222-2222-4222-8222-222222222222";

function declaredStatuses(): Set<string> {
  const set = vocabulary().values.get("rent_buddy_bookings.status");
  assert.ok(set, "rent_buddy_bookings.status has no declared vocabulary — the sweep would be vacuous");
  assert.ok(set!.size >= 10, `expected the 14-label enum, saw ${set!.size}`);
  return set!;
}

test("1. every status resolveBuddyRole keys on is a real label of rent_buddy_booking_status", () => {
  const declared = declaredStatuses();
  const used = [...BUDDY_RELATIONSHIP_STATUSES];
  assert.ok(used.length > 0, "BUDDY_RELATIONSHIP_STATUSES is empty — this check would inspect nothing");
  let checked = 0;
  for (const s of used) {
    assert.ok(
      declared.has(s),
      `"${s}" is not a label of rent_buddy_booking_status (declared: ${[...declared].join("|")})`,
    );
    checked++;
  }
  assert.equal(checked, used.length);
  assert.ok(checked >= 5, `expected to inspect at least 5 statuses, inspected ${checked}`);
});

test("2. the two halves of the historical defect are both real: 'active' is fiction, 'scheduled' is not", () => {
  const declared = declaredStatuses();
  // The literal that used to sit in the set and could never match a row.
  assert.equal(declared.has("active"), false, "'active' unexpectedly became a real label — retire this test");
  // The literal the set used to omit, which accept actually writes.
  assert.equal(declared.has("scheduled"), true);
  assert.ok(
    BUDDY_RELATIONSHIP_STATUSES.includes("scheduled" as never),
    "the accepted-booking status is missing from the set again",
  );
  assert.equal(
    (BUDDY_RELATIONSHIP_STATUSES as readonly string[]).includes("active"),
    false,
    "the dead literal is back",
  );
});

test("3. an ACCEPTED (scheduled) booking resolves the relationship in both directions", async () => {
  const ownerProvides = makeFailClosedClient({
    rows: {
      rent_buddy_bookings: [{ buddy_id: OWNER, traveler_id: VIEWER, status: "scheduled" }],
    },
  });
  assert.equal(await resolveBuddyRole(ownerProvides, OWNER, VIEWER), "provider");

  const ownerBuys = makeFailClosedClient({
    rows: {
      rent_buddy_bookings: [{ buddy_id: VIEWER, traveler_id: OWNER, status: "scheduled" }],
    },
  });
  assert.equal(await resolveBuddyRole(ownerBuys, OWNER, VIEWER), "customer");
});

test("4. every status in the set resolves a relationship; none is dead", async () => {
  let resolved = 0;
  for (const status of BUDDY_RELATIONSHIP_STATUSES) {
    const sc = makeFailClosedClient({
      rows: { rent_buddy_bookings: [{ buddy_id: OWNER, traveler_id: VIEWER, status }] },
    });
    const role = await resolveBuddyRole(sc, OWNER, VIEWER);
    assert.equal(role, "provider", `status "${status}" is in the set but resolves no relationship`);
    resolved++;
  }
  assert.equal(resolved, BUDDY_RELATIONSHIP_STATUSES.length);
  assert.ok(resolved >= 5, `inspected only ${resolved} statuses`);
});

test("5. a booking that never became a relationship resolves to null", async () => {
  const notYet = ["requested", "pending", "declined", "expired", "cancelled", "cancelled_by_traveler", "cancelled_by_buddy"];
  const declared = declaredStatuses();
  let checked = 0;
  for (const status of notYet) {
    assert.ok(declared.has(status), `"${status}" is not a real label — this case tests nothing`);
    const sc = makeFailClosedClient({
      rows: { rent_buddy_bookings: [{ buddy_id: OWNER, traveler_id: VIEWER, status }] },
    });
    assert.equal(await resolveBuddyRole(sc, OWNER, VIEWER), null, `"${status}" must not grant a buddy context`);
    checked++;
  }
  assert.equal(checked, notYet.length);
});

test("6. an unreadable rent_buddy_bookings fails CLOSED and is LOGGED, not silently empty", async () => {
  const realWarn = logger.warn.bind(logger);
  const warns: any[] = [];
  (logger as any).warn = (...args: any[]) => { warns.push(args); };
  let reads = 0;
  try {
    const sc = makeFailClosedClient({
      // A booking that WOULD have resolved "provider" had the read succeeded —
      // so a green here cannot come from an empty seed.
      rows: { rent_buddy_bookings: [{ buddy_id: OWNER, traveler_id: VIEWER, status: "scheduled" }] },
      failOn: (ctx) => {
        if (ctx.table !== "rent_buddy_bookings") return null;
        reads++;
        return { message: "connection terminated unexpectedly", code: "57P01" };
      },
    });
    assert.equal(await resolveBuddyRole(sc, OWNER, VIEWER), null);
  } finally {
    (logger as any).warn = realWarn;
  }
  assert.equal(reads, 1, "the read was not ISSUED exactly once");
  assert.equal(warns.length, 1, "a failed read produced no log line — `.error` is unbound again");
  const [ctx, msg] = warns[0];
  assert.equal(ctx.table, "rent_buddy_bookings");
  assert.equal(ctx.code, "57P01");
  assert.match(String(msg), /resolveBuddyRole/);
});

test("7. a healthy read that finds nothing logs nothing (a silence that means 'none')", async () => {
  const realWarn = logger.warn.bind(logger);
  const warns: any[] = [];
  (logger as any).warn = (...args: any[]) => { warns.push(args); };
  try {
    const sc = makeFailClosedClient({ rows: { rent_buddy_bookings: [] } });
    assert.equal(await resolveBuddyRole(sc, OWNER, VIEWER), null);
  } finally {
    (logger as any).warn = realWarn;
  }
  assert.equal(warns.length, 0);
});
