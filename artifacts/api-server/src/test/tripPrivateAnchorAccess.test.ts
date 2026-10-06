/**
 * Trips §14.1 / §14.4 — private anchors are their OWNER's (census-trips TR256),
 * and the owner's decision of 2026-10-04, verbatim:
 *
 *   "Private anchors: Owner-only by default. The owner can share an individual
 *    anchor with selected trip members; trip membership or organizer status
 *    alone does not grant access."
 *
 * WHAT WAS WRONG, VERIFIED BEFORE THE FIX. `GET /trips/:tripId/map-projection`
 * put every `location_is_private` plan item into its own `privateAnchors`
 * layer — and then served that layer, exact coordinates included, to EVERY
 * accepted member of the trip. The client never drew it; the wire carried it.
 * Nothing let an owner choose who sees a private place.
 *
 * WHAT IS ASSERTED, as the RESPONSE of the real routes over the certification
 * harness, and for writes as the resulting STORE:
 *
 *   A. the pure rule in every direction, including that a role cannot be an
 *      input (the function's arity) and that an unreadable grant list is an
 *      unreadable layer, never a shorter one;
 *   B. the projection: another member — and the trip's organizer — does NOT
 *      receive a member's private anchor; the owner does; a grant shows it to
 *      that member only, and only while sharing is ON; an unreadable grant list
 *      is `unread`; a database without migration 3970 is owner-only, exactly;
 *   C. the grant endpoints: only the anchor's owner may grant, list or revoke —
 *      the trip organizer may not; the member must be on the trip and is never
 *      the owner; a public item has nothing to share; the flag gates GRANTING
 *      and not revoking; every refusal leaves the store untouched.
 *
 * SHOWN RED before green: with `server/trips/readRoutes/tripMapProjection.ts`
 * at `2e46835263`, all seven B cases fail — B1 and B2 because the other member
 * and the organizer each receive the anchor's coordinates, B3–B6 because no
 * grant is consulted, and B0 because no point carries `meta.relation`. C cannot
 * run there at all: the routes do not exist. Mutants, each applied alone and
 * restored: grants honoured while sharing is off (A2); the owner check dropped
 * (A5, C2, C6); an unread grant list answered as own-only (A3, B5); revoke
 * gated by the flag (C5); the member-on-trip check dropped (C3).
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/tripPrivateAnchorAccess.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import mapProjectionRouter from "../server/trips/readRoutes/tripMapProjection.js";
import anchorSharesRouter from "../routes/tripAnchorShares.js";
import {
  anchorsVisibleTo,
  ownsShareableAnchor,
  type AnchorGrantRead,
} from "../domain/trips/policies/privateAnchorAccess.js";
import {
  makeFakeClient,
  startRouter,
  call,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const ORGANIZER = "11111111-0000-4000-8000-000000000001"; // trips.owner_id — the trip's organizer
const ANA = "22222222-0000-4000-8000-000000000002";       // adds a private hotel
const BEN = "33333333-0000-4000-8000-000000000003";       // a crew member
const CLEO = "44444444-0000-4000-8000-000000000004";      // a crew member
const STRANGER = "55555555-0000-4000-8000-000000000005";  // not on the trip
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const HOTEL = "bbbbbbbb-0000-4000-8000-00000000000b";      // Ana's private anchor
const DINNER = "cccccccc-0000-4000-8000-00000000000c";     // a public plan

type Rows = Array<Record<string, unknown>>;

function planItem(id: string, creator: string, isPrivate: boolean, o: Record<string, unknown> = {}) {
  return {
    id, trip_id: TRIP, creator_id: creator, title: isPrivate ? "Hotel" : "Dinner", category: "activity",
    status: "planned", lat: 38.72, lng: -9.14, location_is_private: isPrivate, location_name: null,
    removed_at: null, ...o,
  };
}

function store(over: Partial<Record<string, Rows>> = {}): Record<string, Rows> {
  return {
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: ORGANIZER, version: 3 }],
    trip_members: [
      { trip_id: TRIP, user_id: ORGANIZER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: ANA, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: CLEO, role: "member", status: "accepted" },
    ],
    trip_plan_items: [planItem(HOTEL, ANA, true), planItem(DINNER, BEN, false)],
    trip_private_anchor_shares: [],
    trip_stages: [], trip_commitments: [], trip_saved_places: [], places: [],
    route_plans: [], route_stops: [], safe_return_sessions: [],
    ...over,
  };
}

const SHARING_ON = { feature_flags: [{ flag: "trip_private_anchor_sharing_enabled", enabled: true }] };
const grant = (member: string) => ({ plan_item_id: HOTEL, trip_id: TRIP, owner_id: ANA, member_id: member, created_at: "2026-10-05T00:00:00Z" });

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(mapProjectionRouter);
  all.use(anchorSharesRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(seed: Record<string, Rows>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  const c = makeFakeClient(seed, opts);
  _setTestClient(c, true);
  _setTestServiceClient(c as never);
  return c;
}

const anchorIds = (body: { privateAnchors?: { status: string; items?: Array<{ id: string }> } }) => {
  assert.equal(body.privateAnchors?.status, "ok", JSON.stringify(body.privateAnchors));
  return (body.privateAnchors!.items ?? []).map((p) => p.id);
};
const projection = (as: string) => call(harness.base, "GET", `/trips/${TRIP}/map-projection`, as);
const shares = (c: FakeClient) => (c._store.trip_private_anchor_shares ?? []) as Rows;

describe("A. the rule, pure", () => {
  const anchors = [{ id: "h1", ownerId: ANA }, { id: "h2", ownerId: BEN }, { id: "h3", ownerId: null }];
  const none: AnchorGrantRead = { status: "ok", grantedToViewer: new Set() };

  it("A1. the owner sees their own; nobody else sees it ungranted; an unknown owner shows to nobody", () => {
    const own = anchorsVisibleTo(ANA, anchors, true, none);
    assert.deepEqual(own.status === "ok" ? own.items.map((i) => [i.anchor.id, i.relation]) : own, [["h1", "own"]]);
    const other = anchorsVisibleTo(CLEO, anchors, true, none);
    assert.deepEqual(other.status === "ok" ? other.items : other, []);
  });

  it("A2. a grant shows it to that member only, and only while sharing is on", () => {
    const granted: AnchorGrantRead = { status: "ok", grantedToViewer: new Set(["h1"]) };
    const on = anchorsVisibleTo(CLEO, anchors, true, granted);
    assert.deepEqual(on.status === "ok" ? on.items.map((i) => [i.anchor.id, i.relation]) : on, [["h1", "shared_with_me"]]);
    const off = anchorsVisibleTo(CLEO, anchors, false, granted);
    assert.deepEqual(off.status === "ok" ? off.items : off, [], "sharing off: grants are ignored, owner-only");
    const unknownOwner = anchorsVisibleTo(CLEO, anchors, true, { status: "ok", grantedToViewer: new Set(["h3"]) });
    assert.deepEqual(unknownOwner.status === "ok" ? unknownOwner.items : unknownOwner, []);
  });

  it("A3. an unreadable grant list is an unreadable layer while sharing is on — never 'only your own'", () => {
    const r = anchorsVisibleTo(ANA, anchors, true, { status: "unread", reason: "x" });
    assert.equal(r.status, "unread");
    const off = anchorsVisibleTo(ANA, anchors, false, { status: "unread", reason: "x" });
    assert.equal(off.status, "ok", "with sharing off nothing was read, so own-only is exact");
  });

  it("A4. a role is not an input: the signature has nowhere for 'organizer' to arrive", () => {
    assert.equal(anchorsVisibleTo.length, 4);
  });

  it("A5. only the creator of a live private item of THIS trip may share it", () => {
    const item = { trip_id: TRIP, creator_id: ANA, location_is_private: true, removed_at: null };
    assert.deepEqual(ownsShareableAnchor(ANA, TRIP, item), { ok: true });
    assert.equal((ownsShareableAnchor(ORGANIZER, TRIP, item) as { code: string }).code, "forbidden");
    assert.equal((ownsShareableAnchor(ANA, TRIP, { ...item, location_is_private: false }) as { code: string }).code, "invalid_payload");
    assert.equal((ownsShareableAnchor(ANA, TRIP, { ...item, removed_at: "2026-10-01T00:00:00Z" }) as { code: string }).code, "not_found");
    assert.equal((ownsShareableAnchor(ANA, "other-trip", item) as { code: string }).code, "not_found");
    assert.equal((ownsShareableAnchor(ANA, TRIP, null) as { code: string }).code, "not_found");
  });
});

describe("B. GET /trips/:tripId/map-projection serves a private anchor to its owner and to no one else", () => {
  it("B1. THE POINT: another crew member does NOT receive Ana's private hotel", async () => {
    use(store());
    const r = await projection(BEN);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(anchorIds(r.body), []);
    assert.ok(!JSON.stringify(r.body).includes(HOTEL), "the anchor's id appears nowhere in the response");
  });

  it("B2. THE POINT: the trip's ORGANIZER does not receive it either — organizer status grants nothing", async () => {
    use(store(SHARING_ON));
    const r = await projection(ORGANIZER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(anchorIds(r.body), []);
  });

  it("B0. CONTROL: Ana sees her own anchor, marked as hers", async () => {
    use(store());
    const r = await projection(ANA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(anchorIds(r.body), [HOTEL]);
    assert.equal(r.body.privateAnchors.items[0].meta.relation, "own");
    assert.equal(r.body.privateAnchors.items[0].privateAnchor, true);
  });

  it("B3. THE POINT: a grant to Ben shows it to Ben — and still not to Cleo", async () => {
    use(store({ ...SHARING_ON, trip_private_anchor_shares: [grant(BEN)] }));
    const ben = await projection(BEN);
    assert.deepEqual(anchorIds(ben.body), [HOTEL]);
    assert.equal(ben.body.privateAnchors.items[0].meta.relation, "shared_with_me");
    const cleo = await projection(CLEO);
    assert.deepEqual(anchorIds(cleo.body), []);
  });

  it("B4. THE POINT: with sharing OFF a stored grant is ignored — owner-only", async () => {
    use(store({ trip_private_anchor_shares: [grant(BEN)] }));
    const r = await projection(BEN);
    assert.deepEqual(anchorIds(r.body), []);
  });

  it("B5. THE POINT: an unreadable grant list makes the layer `unread`, not shorter", async () => {
    use(store(SHARING_ON), { errors: { trip_private_anchor_shares: { message: "shares down", code: "57014" } } });
    const r = await projection(ANA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.privateAnchors.status, "unread");
    assert.equal(r.body.activePlans.status, "ok", "only the anchor layer depends on the grant read");
  });

  it("B6. without migration 3970 (42P01) no grant can exist: owner-only, exactly, and the layer is ok", async () => {
    use(store(SHARING_ON), { errors: { trip_private_anchor_shares: { message: 'relation "public.trip_private_anchor_shares" does not exist', code: "42P01" } } });
    const own = await projection(ANA);
    assert.deepEqual(anchorIds(own.body), [HOTEL]);
    const other = await projection(BEN);
    assert.deepEqual(anchorIds(other.body), []);
  });
});

describe("C. the grant endpoints answer to the anchor's owner only", () => {
  const path = `/trips/${TRIP}/anchors/${HOTEL}/shares`;

  it("C1. CONTROL: Ana grants Ben — 201, the store holds exactly that grant, and the answer is read back", async () => {
    const c = use(store(SHARING_ON));
    const r = await call(harness.base, "POST", path, ANA, { memberId: BEN });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.memberIds, [BEN]);
    assert.deepEqual(shares(c).map((s) => [s.plan_item_id, s.owner_id, s.member_id]), [[HOTEL, ANA, BEN]]);
  });

  it("C2. THE POINT: the trip ORGANIZER cannot grant someone sight of Ana's hotel", async () => {
    const c = use(store(SHARING_ON));
    const r = await call(harness.base, "POST", path, ORGANIZER, { memberId: BEN });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(shares(c).length, 0);
  });

  it("C3. THE POINT: a person who is not on the trip cannot be granted it", async () => {
    const c = use(store(SHARING_ON));
    const r = await call(harness.base, "POST", path, ANA, { memberId: STRANGER });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(shares(c).length, 0);
  });

  it("C4. sharing OFF: a grant is refused feature_disabled and nothing is written", async () => {
    const c = use(store());
    const r = await call(harness.base, "POST", path, ANA, { memberId: BEN });
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(shares(c).length, 0);
  });

  it("C5. a REVOKE works with sharing OFF — a retraction is never refused", async () => {
    const c = use(store({ trip_private_anchor_shares: [grant(BEN), grant(CLEO)] }));
    const r = await call(harness.base, "DELETE", `${path}/${BEN}`, ANA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.memberIds, [CLEO]);
    assert.deepEqual(shares(c).map((s) => s.member_id), [CLEO]);
  });

  it("C6. nobody but the owner may revoke or list, and a refused revoke removes nothing", async () => {
    const c = use(store({ ...SHARING_ON, trip_private_anchor_shares: [grant(BEN)] }));
    const revoke = await call(harness.base, "DELETE", `${path}/${BEN}`, ORGANIZER);
    assert.equal(revoke.status, 403, JSON.stringify(revoke.body));
    const list = await call(harness.base, "GET", path, BEN);
    assert.equal(list.status, 403, JSON.stringify(list.body));
    assert.equal(shares(c).length, 1);
  });

  it("C7. self, a public item, and an outsider caller are each refused without a write", async () => {
    const c = use(store(SHARING_ON));
    const self = await call(harness.base, "POST", path, ANA, { memberId: ANA });
    assert.equal(self.status, 400, JSON.stringify(self.body));
    const pub = await call(harness.base, "POST", `/trips/${TRIP}/anchors/${DINNER}/shares`, BEN, { memberId: CLEO });
    assert.equal(pub.status, 400, JSON.stringify(pub.body));
    const outsider = await call(harness.base, "POST", path, STRANGER, { memberId: BEN });
    assert.equal(outsider.status, 403, JSON.stringify(outsider.body));
    assert.equal(shares(c).length, 0);
  });

  it("C8. an unreadable grant list is 503 on the owner's list, never 'shared with nobody'", async () => {
    use(store(SHARING_ON), { errors: { trip_private_anchor_shares: { message: "down", code: "57014", ops: ["select"] } } });
    const r = await call(harness.base, "GET", path, ANA);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
  });

  it("C9. CONTROL: the owner's list says whether sharing is on, and who holds a grant", async () => {
    use(store({ trip_private_anchor_shares: [grant(CLEO)] }));
    const r = await call(harness.base, "GET", path, ANA);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, sharingEnabled: false, sharing: "off", memberIds: [CLEO] });
  });
});
