/**
 * census-discovery §103 (DV-83, W11-X2 round 7): the verifier's §102.11 probe, kept as a failing-first test.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { _setTestClient } from "../lib/http.js";
import { nameVisibilitySetOrNull } from "../lib/publicIdentity.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { VIEWER, emptyCalls, emptyState, kitGet, makeKitClient, startKitServer, type KitState } from "./discoverySearchTestKit.js";

const NAMED = "c1000000-0000-4000-a000-000000000001"; // matched by real name only (handle does not contain the query)
const HANDLE = "c2000000-0000-4000-a000-000000000002"; // matched by handle

function person(id: string, handle: string, name: string) {
  return {
    id, handle, username: handle, name, display_name: null, avatar_url: null,
    is_private: false, home_city: null, home_country: null, account_status: "active", verified: false,
    is_official: false, show_profile_picture_publicly: true, buddy_verified_at: null,
  };
}

function world(over: Partial<KitState> = {}): KitState {
  return emptyState({
    rows: {
      profiles: [person(VIEWER, "viewer_one", "Viewer"), person(NAMED, "tr_one", "Zork Realname"), person(HANDLE, "zork_handle", "Somebody")],
      location_preferences: [], rent_buddy_profiles: [], rent_buddy_user_limits: [],
      blocks: [], user_privacy_settings: [],
      profile_privacy_settings: [{ user_id: NAMED, show_real_name: true, allow_profile_discovery: true }],
      user_follows: [], friend_requests: [], user_friendships: [], event_rsvps: [],
      canonical_locations: [], hashtags: [], stamp_definitions: [],
    },
    ...over,
  });
}

function install(s: KitState) {
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
  _resetRateLimit();
  _setTestClient(makeKitClient(s, emptyCalls()) as any, true);
}

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => server.close());

const failShowRealName: KitState["errorOn"] = ({ table, named }) =>
  table === "profile_privacy_settings" && named.has("show_real_name") ? { code: "57014", message: "canceling statement due to statement timeout" } : null;

describe("§102.11 / §103 search: the real-name visibility read (DV-83, D-W11X2-48)", () => {
  it("V6-N0 CONTROL: healthy read — both travelers served, no refusal", async () => {
    install(world());
    const { status, body } = await kitGet(base, "/discovery/search?q=zork&type=travelers&limit=20");
    assert.equal(status, 200);
    assert.deepEqual(body.results.map((r: any) => r.id).sort(), [NAMED, HANDLE].sort());
    assert.equal(body.refusal, undefined);
  });

  it("V6-N1 type=travelers: the show_real_name read FAILS → the name-matched traveler is withheld, and the answer must say so", async () => {
    install(world({ errorOn: failShowRealName }));
    const { status, body } = await kitGet(base, "/discovery/search?q=zork&type=travelers&limit=20");
    assert.equal(status, 200);
    assert.ok(body.refusal, "a list that withheld a row for an unread privacy set carries a refusal");
    assert.equal(body.refusal.coverage, "nothing");
    assert.deepEqual(body.results, [], "nothing is served as if the set had been read");
  });

  it("V6-N2 suggest: the same failure → the Travelers group is short with no refusal", async () => {
    install(world({ errorOn: failShowRealName }));
    const { body } = await kitGet(base, "/discovery/suggest?q=zork");
    assert.ok(body.refusal, "suggest names the unread source");
    assert.ok((body.refusal.failedSources ?? []).includes("travelers"), `failedSources names travelers: ${JSON.stringify(body.refusal)}`);
  });

  it("N3 type=all: the same failure names travelers in failedSources", async () => {
    install(world({ errorOn: failShowRealName }));
    const { status, body } = await kitGet(base, "/discovery/search?q=zork&type=all&limit=20");
    assert.equal(status, 200);
    assert.ok(body.refusal, "type=all carries a refusal");
    assert.ok((body.refusal.failedSources ?? []).includes("travelers"), `failedSources names travelers: ${JSON.stringify(body.refusal)}`);
  });

  it("C1 CONTROL: another privacy column failing is not this read (allow_profile_discovery keeps its own named refusal)", async () => {
    install(world({ errorOn: ({ table, named }) => table === "profile_privacy_settings" && named.has("allow_profile_discovery") ? { code: "57014", message: "timeout" } : null }));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=travelers&limit=20");
    assert.equal(body.refusal?.coverage, "nothing");
  });

  it("C2 CONTROL: a match on the handle alone needs no name read to be right — with every row name-visible the healthy answer is unchanged", async () => {
    install(world());
    const { body } = await kitGet(base, "/discovery/search?q=zork_handle&type=travelers&limit=20");
    assert.deepEqual(body.results.map((r: any) => r.id), [HANDLE]);
    assert.equal(body.refusal, undefined);
  });
});

describe("§103 nameVisibilitySetOrNull: a failed read is null, never an empty set (D-W11X2-48)", () => {
  const client = (answer: () => Promise<{ data: unknown; error: unknown }>) => ({
    from: () => ({ select: () => ({ in: () => ({ eq: answer }) }) }),
  });
  it("N4 an error answer is null", async () => {
    assert.equal(await nameVisibilitySetOrNull(client(async () => ({ data: null, error: { message: "x" } })), ["u1"]), null);
  });
  it("N5 a thrown read is null", async () => {
    assert.equal(await nameVisibilitySetOrNull(client(async () => { throw new Error("socket hang up"); }), ["u1"]), null);
  });
  it("C3 CONTROL: a healthy read is the set; no ids is the empty set with no read", async () => {
    assert.deepEqual([...(await nameVisibilitySetOrNull(client(async () => ({ data: [{ user_id: "u1" }], error: null })), ["u1", "u2"]))!], ["u1"]);
    assert.deepEqual([...(await nameVisibilitySetOrNull({ from: () => { throw new Error("no read expected"); } }, []))!], []);
  });
});

// ── §103 (DV-83, D-W11X2-51): the buddies launch gate's marketplace read ────────
// With `discovery_buddy_launch_gate_enabled` ON, buddies are withheld unless
// `rent_buddy_enabled` is TRUE. A FAILED read of it withheld them as "no buddies".
describe("§103 search: the buddies launch gate's marketplace flag, unread (D-W11X2-51)", () => {
  it("B1 gate ON + rent_buddy_enabled read FAILS → type=buddies is refused, not an empty list", async () => {
    install(world({ flags: { discovery_buddy_launch_gate_enabled: true, rent_buddy_enabled: "error" } } as Partial<KitState>));
    const { status, body } = await kitGet(base, "/discovery/search?q=zork&type=buddies&limit=20");
    assert.equal(status, 200);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
    assert.deepEqual(body.results, []);
  });

  it("B2 the same failure on type=all names buddies in failedSources", async () => {
    install(world({ flags: { discovery_buddy_launch_gate_enabled: true, rent_buddy_enabled: "error" } } as Partial<KitState>));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=all&limit=20");
    assert.ok((body.refusal?.failedSources ?? []).includes("buddies"), JSON.stringify(body.refusal));
  });

  it("C4 CONTROL: gate ON + marketplace flag read and FALSE → withheld with no refusal (an unlaunched marketplace has no buddies)", async () => {
    install(world({ flags: { discovery_buddy_launch_gate_enabled: true, rent_buddy_enabled: false } } as Partial<KitState>));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=buddies&limit=20");
    assert.deepEqual(body.results, []);
    assert.equal(body.refusal, undefined);
  });
});
