/**
 * Lead ruling D-103 on Compass: in a DIRECT conversation,
 * telegraph_get_participant_availability admits a `followers` availability
 * window only when the viewer and the window's owner follow each other
 * (compass/TelegraphConversationTools.ts, isMutualFollow). Before the ruling
 * Compass read every non-crew conversation as `public`, so a followers window
 * never reached anyone — narrower than the ruling; one-way in either direction
 * must still be refused.
 *
 *   M1  mutual → the followers window is returned;
 *   M2  viewer follows owner only → refused;
 *   M3  owner follows viewer only → refused;
 *   M4  the follow edges unreadable → refused (an unread edge is no edge);
 *   M5  CONTROL: a public window is returned with no follow at all.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphCompassAvailabilityMutual.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeTelegraphConversationTool } from "../compass/TelegraphConversationTools.js";
import { makeFakeClient, type FakeDbOptions } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer, asking Compass
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";   // the window's owner
const DM = "dddddddd-0000-4000-8000-00000000000d";
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

type Edge = { follower_id: string; following_id: string };

function seed(visibility: string, follows: Edge[]): Record<string, unknown[]> {
  return {
    feature_flags: [{ flag: "open_to_plans_windows_enabled", enabled: true }],
    message_threads: [{ id: DM, thread_type: "direct", status: "active", trip_id: null, circle_owner_id: null, is_e2ee: false }],
    message_thread_members: [
      { thread_id: DM, user_id: ALICE, role: "member", left_at: null, last_read_at: null },
      { thread_id: DM, user_id: BOB, role: "member", left_at: null, last_read_at: null },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", is_private: false, show_telegraph_dm: true },
      { id: BOB, handle: "bob", name: "Bob", is_private: false, show_telegraph_dm: true },
    ],
    profile_privacy_settings: [],
    user_privacy_settings: [],
    user_friendships: [],
    user_follows: follows,
    blocks: [],
    trust_restrictions: [],
    availability_windows: [{
      id: "99990000-0000-4000-8000-000000000001", user_id: BOB, type: "today", start_at: past, end_at: future,
      trip_id: null, open_to_plans: true, intents: ["coffee"], group_preference: null, max_travel_minutes: null,
      visibility, source: "explicit", social_availability: "open", expires_at: future, created_at: past, updated_at: past,
    }],
  };
}

const MUTUAL: Edge[] = [{ follower_id: ALICE, following_id: BOB }, { follower_id: BOB, following_id: ALICE }];

async function bobsWindows(tables: Record<string, unknown[]>, opts?: FakeDbOptions): Promise<unknown[]> {
  const sc = makeFakeClient(tables, opts);
  const out = await executeTelegraphConversationTool(sc as never, ALICE, "telegraph_get_participant_availability", { conversationId: DM }) as {
    authorized?: boolean; availability?: Array<{ userId: string; windows: unknown[] }>;
  };
  assert.notEqual(out.authorized, false, JSON.stringify(out).slice(0, 300));
  return out.availability?.find((a) => a.userId === BOB)?.windows ?? [];
}

describe("D-103 on Compass: a followers window is the mutual follows'", () => {
  it("M5. CONTROL: a public window is returned with no follow at all (the path is live)", async () => {
    assert.equal((await bobsWindows(seed("public", []))).length, 1);
  });
  it("M1. THE POINT: mutual follow → the followers window is returned", async () => {
    assert.equal((await bobsWindows(seed("followers", MUTUAL))).length, 1);
  });
  it("M2. the viewer follows the owner only → refused", async () => {
    assert.equal((await bobsWindows(seed("followers", [{ follower_id: ALICE, following_id: BOB }]))).length, 0);
  });
  it("M3. the owner follows the viewer only → refused", async () => {
    assert.equal((await bobsWindows(seed("followers", [{ follower_id: BOB, following_id: ALICE }]))).length, 0);
  });
  it("M4. the follow edges unreadable → refused (an unread edge is no edge)", async () => {
    assert.equal((await bobsWindows(seed("followers", MUTUAL), { errors: { user_follows: { message: "follows: timeout" } } })).length, 0);
  });
});
