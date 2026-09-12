/**
 * Trips spec §6.1 policy functions — every rule, against every actor §6.2 names.
 *
 * §6.2: "Policy tests must include negative assertions for anonymous,
 * non-member, removed member, guest, host, and service-facing paths."
 * census-trips TR115 measured four of the six proven, spread across route
 * tests that each exercised one rule through one handler. This file is the
 * matrix: each capability × each actor kind, against the policy function
 * itself, so a rule is tested as a rule.
 *
 * THE ACTOR KINDS
 *   anonymous       userId null
 *   non-member      signed in, no trip_members row
 *   removed member  a row whose status is not "accepted"
 *   invited         a row with role "invited" (not yet crew)
 *   guest / viewer  role "viewer" — crew, read-only
 *   member          role "member"
 *   host            role "co_host"
 *   owner           trips.owner_id (no trip_members row: owners never get one)
 *   blocked         signed in, a blocks row either direction with the owner
 *   service-facing  the SERVICE client — which can read every row — asking on
 *                   behalf of a non-member. §6.2: "service role is not business
 *                   authorization." The fake here IS unrestricted, so a policy
 *                   that admitted anyone the client could see would pass a
 *                   non-member; the assertions below are that it does not.
 *
 * FAIL-CLOSED: an unreadable input THROWS, and the throw is asserted rather
 * than assumed — a policy that quietly said "no" on a failed read would pass
 * every negative test in this file for the wrong reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TripAccessUnavailableError } from "../lib/http.js";
import {
  canViewTrip, canInviteParticipant, canManageJoinRequests, canEditTrip,
  canCreatePlan, canModifyPlan, canManageBooking, canSeePresence, canManageSafety,
  canSeePreciseLocation, CREW_ROLES, HOST_ROLES,
  canAccessTripContent, canHostTrip, canContributeToTrip, canEditOwnOrAsOwner, canSeePrivateContributions,
  tripRoleOf, isTripOwner, planEditPermits, CONTRIBUTING_ROLES,
} from "../lib/tripPolicy.js";
import { INTERNAL_ONLY_REASONS } from "../lib/tripReasonCodes.js";

const TRIP = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLAN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, any>;
interface Tables { [t: string]: Row[] }

/**
 * A minimal supabase-js stand-in: eq / is / in filters, maybeSingle, thenable
 * list, and an `or(...)` that understands the two-clause block query
 * lib/blockGuard.ts issues. `errorOn` makes a table's read fail, which is how
 * the fail-closed assertions are driven.
 */
function fake(tables: Tables, errorOn: string[] = []) {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b: any = {
        select() { return b; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        is(c: string, v: unknown) { filters.push((r) => r[c] === v); return b; },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b; },
        or(expr: string) {
          // and(blocker_id.eq.A,blocked_id.eq.B),and(blocker_id.eq.B,blocked_id.eq.A)
          const pairs = [...expr.matchAll(/blocker_id\.eq\.([^,]+),blocked_id\.eq\.([^)]+)/g)]
            .map((m) => [m[1], m[2]]);
          filters.push((r) => pairs.some(([a, c]) => r.blocker_id === a && r.blocked_id === c));
          return b;
        },
        limit() { return b; },
        order() { return b; },
        maybeSingle: async () => {
          if (errorOn.includes(table)) return { data: null, error: { message: `${table} down` } };
          const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          return { data: rows[0] ?? null, error: null };
        },
        then(onF: any, onR: any) {
          const p = errorOn.includes(table)
            ? Promise.resolve({ data: null, error: { message: `${table} down` } })
            : Promise.resolve({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
          return p.then(onF, onR);
        },
      };
      return b;
    },
  } as any;
}

const trip = (o: Row = {}) => ({ id: TRIP, owner_id: OWNER, visibility: "private", plan_edit_permission: "all_members", ...o });
const member = (role: string, status: string | null = "accepted") => ({ trip_id: TRIP, user_id: ALICE, role, status });

/** The world with ALICE in a given relationship to the trip. */
function world(kind: string, tripOverrides: Row = {}): Tables {
  const base: Tables = { trips: [trip(tripOverrides)], trip_members: [], blocks: [], user_follows: [], plan_editors: [],
    trip_plan_items: [{ id: PLAN, trip_id: TRIP, creator_id: OWNER, removed_at: null }] };
  switch (kind) {
    case "anonymous": case "non-member": break;
    case "removed": base.trip_members = [member("member", "removed")]; break;
    case "invited": base.trip_members = [member("invited", null)]; break;
    case "viewer": base.trip_members = [member("viewer")]; break;
    case "member": base.trip_members = [member("member")]; break;
    case "host": base.trip_members = [member("co_host")]; break;
    case "blocked": base.trip_members = [member("member")]; base.blocks = [{ blocker_id: OWNER, blocked_id: ALICE }]; break;
  }
  return base;
}
const actorOf = (kind: string) => ({ userId: kind === "anonymous" ? null : kind === "owner" ? OWNER : ALICE });

const NEGATIVE = ["anonymous", "non-member", "removed", "invited"] as const;
const CREW = ["viewer", "member", "host"] as const;

describe("§6.1 vocabulary", () => {
  it("crew and host role sets are the ones requireTripMember and the kernel use", () => {
    assert.deepEqual([...CREW_ROLES], ["owner", "co_host", "member", "viewer"]);
    assert.deepEqual([...HOST_ROLES], ["owner", "co_host"]);
  });
  it("canSeePreciseLocation is the existing, graded-C resolver, not a second one", () => {
    assert.equal(typeof canSeePreciseLocation, "function");
  });
});

describe("canViewTrip — §6.3 visibility ladder", () => {
  for (const kind of NEGATIVE) {
    it(`${kind}: a private trip is refused with TRIP_PRIVACY_NOT_VISIBLE`, async () => {
      const d = await canViewTrip(fake(world(kind)), actorOf(kind), TRIP);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, "TRIP_PRIVACY_NOT_VISIBLE");
    });
    it(`${kind}: a public trip yields the PREVIEW, never the authorized view`, async () => {
      const d = await canViewTrip(fake(world(kind, { visibility: "public" })), actorOf(kind), TRIP);
      assert.equal(d.allowed, true);
      if (d.allowed) assert.equal(d.view, "preview");
    });
  }
  for (const kind of CREW) {
    it(`${kind}: authorized view regardless of visibility`, async () => {
      const d = await canViewTrip(fake(world(kind)), actorOf(kind), TRIP);
      assert.equal(d.allowed, true);
      if (d.allowed) assert.equal(d.view, "authorized");
    });
  }
  it("owner: authorized, via owner, with no trip_members row", async () => {
    const d = await canViewTrip(fake(world("non-member")), { userId: OWNER }, TRIP);
    assert.equal(d.allowed, true);
    if (d.allowed) { assert.equal(d.view, "authorized"); assert.equal(d.via, "owner"); }
  });
  it("blocked: refused BEFORE membership is consulted, and the reason is internal-only", async () => {
    // A blocked MEMBER. Membership would say yes; the block must win.
    const d = await canViewTrip(fake(world("blocked")), { userId: ALICE }, TRIP);
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.equal(d.reason, "TRIP_AUTH_BLOCKED");
      assert.ok(INTERNAL_ONLY_REASONS.has(d.reason), "a block must never be told to the blocked party");
    }
  });
  it("buddies: mutual follow yields preview; one-way does not", async () => {
    const mutual = world("non-member", { visibility: "buddies" });
    mutual.user_follows = [
      { follower_id: ALICE, following_id: OWNER }, { follower_id: OWNER, following_id: ALICE },
    ];
    const a = await canViewTrip(fake(mutual), { userId: ALICE }, TRIP);
    assert.equal(a.allowed, true);
    if (a.allowed) assert.equal(a.view, "preview");

    const oneWay = world("non-member", { visibility: "buddies" });
    oneWay.user_follows = [{ follower_id: ALICE, following_id: OWNER }];
    const b = await canViewTrip(fake(oneWay), { userId: ALICE }, TRIP);
    assert.equal(b.allowed, false);
    if (!b.allowed) assert.equal(b.reason, "TRIP_PRIVACY_BUDDIES_ONLY");

    const anon = await canViewTrip(fake(oneWay), { userId: null }, TRIP);
    assert.equal(anon.allowed, false);
  });
  it("fail-closed: an unreadable trips table throws rather than answering", async () => {
    await assert.rejects(
      () => canViewTrip(fake(world("member"), ["trips"]), { userId: ALICE }, TRIP),
      TripAccessUnavailableError,
    );
  });
  it("fail-closed: an unreadable blocks table DENIES, as lib/blockGuard.ts documents", async () => {
    // isBlockedBetween returns true on a read error on purpose — "a transient
    // error briefly over-denying is far better than leaking to a blocked
    // user". The policy inherits that rather than overriding it: the member is
    // refused with the internal-only reason, which the route renders as 404.
    const d = await canViewTrip(fake(world("member"), ["blocks"]), { userId: ALICE }, TRIP);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "TRIP_AUTH_BLOCKED");
  });
});

describe("canInviteParticipant — owner only", () => {
  for (const kind of [...NEGATIVE, ...CREW]) {
    it(`${kind}: refused`, async () => {
      const d = await canInviteParticipant(fake(world(kind)), actorOf(kind), TRIP);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, kind === "anonymous" ? "TRIP_AUTH_UNAUTHENTICATED" : "TRIP_AUTH_NOT_OWNER");
    });
  }
  it("owner: allowed", async () => {
    assert.equal((await canInviteParticipant(fake(world("non-member")), { userId: OWNER }, TRIP)).allowed, true);
  });
  it("host is NOT an inviter — inviting and approving a join request are different capabilities", async () => {
    const d = await canInviteParticipant(fake(world("host")), { userId: ALICE }, TRIP);
    assert.equal(d.allowed, false);
  });
});

describe("canManageJoinRequests — host (owner or accepted co-host)", () => {
  for (const kind of [...NEGATIVE, "viewer", "member"] as const) {
    it(`${kind}: refused`, async () => {
      const d = await canManageJoinRequests(fake(world(kind)), actorOf(kind), TRIP);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, kind === "anonymous" ? "TRIP_AUTH_UNAUTHENTICATED" : "TRIP_AUTH_NOT_HOST");
    });
  }
  it("host: allowed", async () => {
    const d = await canManageJoinRequests(fake(world("host")), { userId: ALICE }, TRIP);
    assert.equal(d.allowed, true);
    if (d.allowed) assert.equal(d.via, "host:co_host");
  });
  it("a co_host whose row is not accepted is not a host", async () => {
    const w = world("non-member"); w.trip_members = [member("co_host", "pending")];
    assert.equal((await canManageJoinRequests(fake(w), { userId: ALICE }, TRIP)).allowed, false);
  });
  it("owner: allowed", async () => {
    assert.equal((await canManageJoinRequests(fake(world("non-member")), { userId: OWNER }, TRIP)).allowed, true);
  });
});

describe("canEditTrip — owner only", () => {
  for (const kind of [...NEGATIVE, ...CREW]) {
    it(`${kind}: refused`, async () => {
      assert.equal((await canEditTrip(fake(world(kind)), actorOf(kind), TRIP)).allowed, false);
    });
  }
  it("owner: allowed", async () => {
    assert.equal((await canEditTrip(fake(world("non-member")), { userId: OWNER }, TRIP)).allowed, true);
  });
  it("fail-closed on an unreadable trips table", async () => {
    await assert.rejects(() => canEditTrip(fake(world("member"), ["trips"]), { userId: OWNER }, TRIP), TripAccessUnavailableError);
  });
});

describe("canCreatePlan / canModifyPlan — the two that already existed, under their spec names", () => {
  it("anonymous cannot create a plan", async () => {
    const d = await canCreatePlan(fake(world("anonymous")), { userId: null }, TRIP);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "TRIP_AUTH_UNAUTHENTICATED");
  });
  it("a member may create a plan under all_members; a non-member may not", async () => {
    assert.equal((await canCreatePlan(fake(world("member")), { userId: ALICE }, TRIP)).allowed, true);
    const d = await canCreatePlan(fake(world("non-member")), { userId: ALICE }, TRIP);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "TRIP_AUTH_NOT_CREW");
  });
  it("owner_only policy refuses a member", async () => {
    const d = await canCreatePlan(fake(world("member", { plan_edit_permission: "owner_only" })), { userId: ALICE }, TRIP);
    assert.equal(d.allowed, false);
  });
  it("a member may not modify someone else's plan item; the owner may", async () => {
    const m = await canModifyPlan(fake(world("member")), { userId: ALICE }, TRIP, PLAN);
    assert.equal(m.allowed, false);
    if (!m.allowed) assert.equal(m.reason, "TRIP_AUTH_NOT_CREATOR");
    const o = await canModifyPlan(fake(world("member")), { userId: OWNER }, TRIP, PLAN);
    assert.equal(o.allowed, true);
  });
});

describe("canManageBooking — crew may read/write; delete is creator or owner", () => {
  for (const kind of NEGATIVE) {
    it(`${kind}: refused for every action`, async () => {
      for (const action of ["read", "write", "delete"] as const) {
        const d = await canManageBooking(fake(world(kind)), actorOf(kind), TRIP, action);
        assert.equal(d.allowed, false, `${kind} was allowed to ${action}`);
        if (!d.allowed) assert.equal(d.reason, kind === "anonymous" ? "TRIP_AUTH_UNAUTHENTICATED" : "TRIP_BOOKING_NOT_MEMBER");
      }
    });
  }
  for (const kind of CREW) {
    it(`${kind}: may read and write`, async () => {
      assert.equal((await canManageBooking(fake(world(kind)), actorOf(kind), TRIP, "read")).allowed, true);
      assert.equal((await canManageBooking(fake(world(kind)), actorOf(kind), TRIP, "write")).allowed, true);
    });
    it(`${kind}: may NOT delete another's reservation`, async () => {
      const d = await canManageBooking(fake(world(kind)), actorOf(kind), TRIP, "delete", { reservationCreatorId: OWNER });
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, "TRIP_BOOKING_NOT_CREATOR_OR_OWNER");
    });
    it(`${kind}: may delete their OWN reservation`, async () => {
      assert.equal((await canManageBooking(fake(world(kind)), actorOf(kind), TRIP, "delete", { reservationCreatorId: ALICE })).allowed, true);
    });
  }
  it("owner may delete anyone's reservation", async () => {
    assert.equal((await canManageBooking(fake(world("non-member")), { userId: OWNER }, TRIP, "delete", { reservationCreatorId: ALICE })).allowed, true);
  });
});

describe("canSeePresence — §10.3, pure", () => {
  const NOW = Date.parse("2026-10-01T12:00:00Z");
  const future = "2026-10-01T13:00:00Z";
  const past = "2026-10-01T11:00:00Z";

  it("ghost mode is invisible, even with an active live share", () => {
    const d = canSeePresence({ ghostModeEnabled: true, defaultVisibility: "nearby", liveShareExpiresAt: future }, NOW);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "TRIP_PRESENCE_GHOST");
  });
  it("an active live share overrides a hidden default", () => {
    const d = canSeePresence({ ghostModeEnabled: false, defaultVisibility: "hidden", liveShareExpiresAt: future }, NOW);
    assert.deepEqual(d, { allowed: true, via: "live_share" });
  });
  it("an EXPIRED live share is no grant: hidden default stands", () => {
    const d = canSeePresence({ ghostModeEnabled: false, defaultVisibility: "hidden", liveShareExpiresAt: past }, NOW);
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, "TRIP_PRESENCE_HIDDEN");
  });
  it("an unparseable expiry fails closed", () => {
    const d = canSeePresence({ ghostModeEnabled: false, defaultVisibility: "hidden", liveShareExpiresAt: "not-a-date" }, NOW);
    assert.equal(d.allowed, false);
  });
  it("no preferences row means hidden", () => {
    assert.equal(canSeePresence({ ghostModeEnabled: false, defaultVisibility: null, liveShareExpiresAt: null }, NOW).allowed, false);
  });
  it("a non-hidden default is visible at that level", () => {
    assert.deepEqual(canSeePresence({ ghostModeEnabled: false, defaultVisibility: "city_only", liveShareExpiresAt: null }, NOW),
      { allowed: true, via: "default_visibility" });
  });
});

describe("canManageSafety — only crew may attach Safe Return to a trip", () => {
  for (const kind of NEGATIVE) {
    it(`${kind}: refused`, async () => {
      const d = await canManageSafety(fake(world(kind)), actorOf(kind), TRIP);
      assert.equal(d.allowed, false);
      if (!d.allowed) assert.equal(d.reason, kind === "anonymous" ? "TRIP_AUTH_UNAUTHENTICATED" : "TRIP_AUTH_NOT_CREW");
    });
  }
  for (const kind of CREW) {
    it(`${kind}: allowed`, async () => {
      assert.equal((await canManageSafety(fake(world(kind)), actorOf(kind), TRIP)).allowed, true);
    });
  }
  it("owner: allowed", async () => {
    assert.equal((await canManageSafety(fake(world("non-member")), { userId: OWNER }, TRIP)).allowed, true);
  });
  it("fail-closed on an unreadable trip_members table", async () => {
    await assert.rejects(() => canManageSafety(fake(world("member"), ["trip_members"]), { userId: ALICE }, TRIP), TripAccessUnavailableError);
  });
});

describe("§6.2 service-facing: service role is not business authorization", () => {
  // The fake client here is UNRESTRICTED — it can read every row, exactly like
  // the service client. Each policy must still refuse a non-member.
  it("every trip-scoped policy refuses a non-member asked through an unrestricted client", async () => {
    const c = fake(world("non-member"));
    const a = { userId: ALICE };
    assert.equal((await canViewTrip(c, a, TRIP)).allowed, false);
    assert.equal((await canInviteParticipant(c, a, TRIP)).allowed, false);
    assert.equal((await canManageJoinRequests(c, a, TRIP)).allowed, false);
    assert.equal((await canEditTrip(c, a, TRIP)).allowed, false);
    assert.equal((await canCreatePlan(c, a, TRIP)).allowed, false);
    assert.equal((await canModifyPlan(c, a, TRIP, PLAN)).allowed, false);
    assert.equal((await canManageBooking(c, a, TRIP, "read")).allowed, false);
    assert.equal((await canManageSafety(c, a, TRIP)).allowed, false);
  });
});


// ── §50 (census-trips TR102): the vocabulary the routes were spelling inline ──
describe("TR102 — the five decisions the inline checks became", () => {
  const trip = { id: TRIP, owner_id: OWNER };
  const me = (u: string) => ({ userId: u });
  const withRole = (role: string | null) => fake({ trips: [trip], trip_members: role ? [{ trip_id: TRIP, user_id: ALICE, role, status: "accepted" }] : [] });

  it("canAccessTripContent: the owner and every accepted crew role; a stranger is TRIP_AUTH_NOT_CREW; `given` saves the read", async () => {
    assert.equal((await canAccessTripContent(withRole(null) as any, me(OWNER), TRIP)).allowed, true);
    for (const r of CREW_ROLES) assert.equal((await canAccessTripContent(withRole(r) as any, me(ALICE), TRIP)).allowed, true, r);
    const d = await canAccessTripContent(withRole(null) as any, me(ALICE), TRIP);
    assert.equal(d.allowed, false); assert.equal(!d.allowed && d.reason, "TRIP_AUTH_NOT_CREW");
    const given = await canAccessTripContent(fake({}, ["trips", "trip_members"]) as any, me(ALICE), TRIP, { trip, role: "viewer" });
    assert.equal(given.allowed, true, "with trip and role given, nothing is read");
    assert.equal((await canAccessTripContent(withRole("member") as any, { userId: null }, TRIP)).allowed, false);
  });
  it("canHostTrip: owner and co_host; a member is TRIP_AUTH_NOT_HOST", async () => {
    assert.equal((await canHostTrip(withRole(null) as any, me(OWNER), TRIP)).allowed, true);
    assert.equal((await canHostTrip(withRole("co_host") as any, me(ALICE), TRIP)).allowed, true);
    const d = await canHostTrip(withRole("member") as any, me(ALICE), TRIP);
    assert.equal(d.allowed, false); assert.equal(!d.allowed && d.reason, "TRIP_AUTH_NOT_HOST");
  });
  it("canContributeToTrip: owner, co_host, member; a viewer is TRIP_AUTH_ROLE_NOT_PERMITTED; a stranger TRIP_AUTH_NOT_CREW", async () => {
    assert.deepEqual([...CONTRIBUTING_ROLES], ["owner", "co_host", "member"]);
    for (const r of ["co_host", "member"]) assert.equal((await canContributeToTrip(withRole(r) as any, me(ALICE), TRIP)).allowed, true, r);
    const viewer = await canContributeToTrip(withRole("viewer") as any, me(ALICE), TRIP);
    assert.equal(!viewer.allowed && viewer.reason, "TRIP_AUTH_ROLE_NOT_PERMITTED");
    const stranger = await canContributeToTrip(withRole(null) as any, me(ALICE), TRIP);
    assert.equal(!stranger.allowed && stranger.reason, "TRIP_AUTH_NOT_CREW");
  });
  it("canEditOwnOrAsOwner: the owner, or the row's creator; anyone else is TRIP_AUTH_NOT_CREATOR", async () => {
    assert.equal((await canEditOwnOrAsOwner(withRole("member") as any, me(OWNER), TRIP, ALICE)).allowed, true);
    assert.equal((await canEditOwnOrAsOwner(withRole("member") as any, me(ALICE), TRIP, ALICE)).allowed, true);
    const d = await canEditOwnOrAsOwner(withRole("member") as any, me(ALICE), TRIP, OWNER);
    assert.equal(!d.allowed && d.reason, "TRIP_AUTH_NOT_CREATOR");
    assert.equal((await canEditOwnOrAsOwner(withRole("member") as any, me(ALICE), TRIP, null)).allowed, false, "no creator: only the owner");
  });
  it("canSeePrivateContributions: the owner alone", async () => {
    assert.equal((await canSeePrivateContributions(withRole("co_host") as any, me(OWNER), TRIP)).allowed, true);
    const d = await canSeePrivateContributions(withRole("co_host") as any, me(ALICE), TRIP);
    assert.equal(!d.allowed && d.reason, "TRIP_AUTH_NOT_OWNER");
  });
  it("tripRoleOf: owner, the crew role, or null", async () => {
    assert.equal(await tripRoleOf(withRole(null) as any, me(OWNER), TRIP), "owner");
    assert.equal(await tripRoleOf(withRole("viewer") as any, me(ALICE), TRIP), "viewer");
    assert.equal(await tripRoleOf(withRole(null) as any, me(ALICE), TRIP), null);
    assert.equal(await tripRoleOf(withRole("member") as any, { userId: null }, TRIP), null);
  });
  it("isTripOwner and planEditPermits are pure and say what the routes used to spell", () => {
    assert.equal(isTripOwner(trip, me(OWNER)), true); assert.equal(isTripOwner(trip, me(ALICE)), false); assert.equal(isTripOwner(null, me(OWNER)), false);
    assert.equal(planEditPermits({ owner_id: OWNER }, OWNER, []), true, "the owner always");
    assert.equal(planEditPermits({ owner_id: OWNER, plan_edit_permission: null }, ALICE, []), true, "unset means all_members");
    assert.equal(planEditPermits({ owner_id: OWNER, plan_edit_permission: "owner_only" }, ALICE, [ALICE]), false);
    assert.equal(planEditPermits({ owner_id: OWNER, plan_edit_permission: "selected_members" }, ALICE, [ALICE]), true);
    assert.equal(planEditPermits({ owner_id: OWNER, plan_edit_permission: "selected_members" }, ALICE, []), false);
  });
});
