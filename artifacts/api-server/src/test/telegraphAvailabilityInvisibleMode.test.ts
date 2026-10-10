/**
 * Telegraph §4.3 — "Invisible mode suppresses Nearby/Bump/public availability" —
 * on the two Telegraph surfaces that show ANOTHER person's availability windows.
 *
 * THE LEAK THIS CLOSES. `lib/invisibleMode.ts` names `public_availability` as a
 * surface invisible mode suppresses, and Nearby applies it. The conversation
 * header (`GET /threads/:id/conversation-header`) and Compass's
 * `telegraph_get_participant_availability` did not consult it at all: a person
 * who paused sharing, turned location off, or set discovery to "nobody" vanished
 * from Nearby and still had their live window — free until when, for what —
 * shown in every conversation and handed to Compass.
 *
 * WHAT IS EXERCISED: the real header router over the certification harness, and
 * the real Compass tool through `executeTelegraphConversationTool`, each with BOB
 * holding one explicit, live, public window. Each invisible reading, an
 * unreadable consent row, and the controls (a default row; no row at all).
 *
 * Run: node --import tsx/esm --test src/test/telegraphAvailabilityInvisibleMode.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import telegraphSharedContextRouter from "../routes/telegraphSharedContext.js";
import { executeTelegraphConversationTool } from "../compass/TelegraphConversationTools.js";
import { availabilityWithheldOwners } from "../services/telegraph/availabilityInvisibility.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the other person, with a live window
const DM = "dddddddd-0000-4000-8000-00000000000d";

const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

type Prefs = { location_mode?: string; sharing_paused?: boolean; discovery_visibility?: string } | null;

/** BOB's consent row; `null` = no row at all. The defaults are the baseline column defaults. */
function prefsRow(p: Prefs): Record<string, unknown>[] {
  if (p === null) return [];
  return [{
    user_id: BOB,
    location_mode: p.location_mode ?? "city",
    sharing_paused: p.sharing_paused ?? false,
    discovery_visibility: p.discovery_visibility ?? "everyone",
  }];
}

function seed(prefs: Prefs): Record<string, unknown[]> {
  return {
    feature_flags: [{ flag: "open_to_plans_windows_enabled", enabled: true }],
    message_threads: [{ id: DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false }],
    message_thread_members: [
      { thread_id: DM, user_id: ALICE, role: "member", left_at: null },
      { thread_id: DM, user_id: BOB, role: "member", left_at: null },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false,
        show_telegraph_dm: true, show_telegraph_trip: true, show_telegraph_circle: true },
      { id: BOB, handle: "bob", name: "Bob", avatar_url: null, is_private: false },
    ],
    profile_privacy_settings: [],
    user_privacy_settings: [],
    user_friendships: [],
    user_follows: [],
    blocks: [],
    trust_restrictions: [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
    location_preferences: prefsRow(prefs),
    availability_windows: [{
      id: "99990000-0000-4000-8000-000000000001", user_id: BOB, type: "quick", start_at: past, end_at: future,
      trip_id: null, open_to_plans: true, intents: ["coffee"], group_preference: null, max_travel_minutes: null,
      visibility: "public", source: "explicit", social_availability: "open", expires_at: future,
      created_at: past, updated_at: past,
    }],
    circle_presence: [],
  };
}

const INVISIBLE: Array<[string, Prefs]> = [
  ["sharing paused", { sharing_paused: true }],
  ["location off", { location_mode: "off" }],
  ["discovery set to nobody", { discovery_visibility: "nobody" }],
];

const WITHHELD = { enabled: true, state: null, intents: [], expiresAt: null };

let h: RouterHarness;
before(async () => { h = await startRouter(telegraphSharedContextRouter); });
after(async () => { _setTestClient(null, false); await h.close(); });

async function header(tables: Record<string, unknown[]>, opts?: FakeDbOptions) {
  _setTestClient(makeFakeClient(tables, opts), true);
  const r = await call(h.base, "GET", `/threads/${DM}/conversation-header`, ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const body = r.body as { participants: Array<{ userId: string; availability: Record<string, unknown> }> };
  return { p: body.participants.find((x) => x.userId === BOB)!, wire: JSON.stringify(r.body) };
}

describe("§4.3 invisible mode — the conversation header's availability", () => {
  it("CONTROL: a default consent row — BOB's window is shown (the case is live)", async () => {
    const { p } = await header(seed({}));
    assert.equal(p.availability.state, "open");
    assert.deepEqual(p.availability.intents, ["coffee"]);
  });

  it("CONTROL: no consent row at all is the discoverable default — shown", async () => {
    const { p } = await header(seed(null));
    assert.equal(p.availability.state, "open");
  });

  for (const [why, prefs] of INVISIBLE) {
    it(`BOB is invisible (${why}): his availability is withheld, exactly as 'not sharing'`, async () => {
      const { p, wire } = await header(seed(prefs));
      assert.deepEqual(p.availability, WITHHELD, `${why}: ${JSON.stringify(p.availability)}`);
      assert.ok(!wire.includes("coffee"), `${why}: an invisible person's intents reached the conversation`);
      assert.ok(!wire.includes(future), `${why}: an invisible person's window end reached the conversation`);
    });
  }

  it("an unreadable consent read withholds the availability — 'could not check' is not 'visible'", async () => {
    const { p, wire } = await header(seed({}), { errors: { location_preferences: { message: "location_preferences unreadable" } } });
    assert.deepEqual(p.availability, WITHHELD);
    assert.ok(!wire.includes("coffee"));
  });
});

async function compass(tables: Record<string, unknown[]>, opts?: FakeDbOptions): Promise<any> {
  const sc = makeFakeClient(tables, opts) as any;
  _setTestClient(sc, true);
  return executeTelegraphConversationTool(sc, ALICE, "telegraph_get_participant_availability", { conversationId: DM });
}

describe("§4.3 invisible mode — Compass's participant availability", () => {
  it("CONTROL: a default consent row — BOB's window reaches Compass", async () => {
    const out = await compass(seed({}));
    assert.equal(out.authorized, true, JSON.stringify(out));
    assert.equal(out.participantsSharing, 1, JSON.stringify(out));
    assert.equal(out.availability[0].userId, BOB);
    assert.equal(out.unreadable, 0);
  });

  for (const [why, prefs] of INVISIBLE) {
    it(`BOB is invisible (${why}): Compass is told nobody is sharing`, async () => {
      const out = await compass(seed(prefs));
      assert.equal(out.authorized, true, JSON.stringify(out));
      assert.equal(out.participantsSharing, 0, `${why}: ${JSON.stringify(out)}`);
      assert.deepEqual(out.availability, []);
      assert.ok(!JSON.stringify(out).includes("coffee"), `${why}: an invisible person's intents reached Compass`);
    });
  }

  it("an unreadable consent read withholds everyone and is COUNTED as unreadable, never as 'not sharing'", async () => {
    const out = await compass(seed({}), { errors: { location_preferences: { message: "location_preferences unreadable" } } });
    assert.equal(out.authorized, true, JSON.stringify(out));
    assert.equal(out.participantsSharing, 0);
    assert.equal(out.unreadable, 1, JSON.stringify(out));
    assert.ok(!JSON.stringify(out).includes("coffee"));
  });
});

describe("availabilityWithheldOwners — the reader both surfaces share", () => {
  it("no service client is an unknown (null), not an empty set", async () => {
    assert.equal(await availabilityWithheldOwners([BOB], null), null);
  });

  it("an empty owner list reads nothing and withholds nothing", async () => {
    const withheld = await availabilityWithheldOwners([], null);
    assert.ok(withheld !== null && withheld.size === 0);
  });
});
