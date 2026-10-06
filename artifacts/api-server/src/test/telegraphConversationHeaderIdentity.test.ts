/**
 * census-telegraph T295 (§45c, verifier finding 8) — the DM header's identity is
 * the SERVER's projection of the other person, not a raw `profiles` read.
 *
 * THE LEAK THIS CLOSES. `app/messages/[id].tsx` read `profiles` directly
 * (`name, handle, avatar_url, city`) for the direct-thread header and drew
 * `name` — while every server projection of a person to someone else hides the
 * name unless they chose to show it (`profile_privacy_settings.show_real_name`,
 * lib/publicIdentity.ts; GET /me/threads applies it to the same people). The
 * `profiles_select` policy lets a client read a non-private profile's name, so
 * the client skipping the rule was a leak, not only a layering violation.
 *
 * WHAT IS EXERCISED: the real GET /threads/:id/conversation-header over the
 * certification harness.
 *   - name hidden unless show_real_name; handle and avatar always;
 *   - show_real_name true: the name;
 *   - an unreadable privacy read hides the name (fails closed);
 *   - an unreadable profiles read: identity null, the header still answers;
 *   - no `city` is projected (no server identity rule makes it public).
 * And one structural pin beside the behaviour: neither conversation screen
 * reads a table directly any more (the header's `profiles` read was the last
 * `.from(` on either), so the leak cannot come back as a second raw read.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *        node --import tsx/esm --test src/test/telegraphConversationHeaderIdentity.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { _setTestClient } from "../lib/http.js";
import telegraphSharedContextRouter from "../routes/telegraphSharedContext.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the other person
const DM = "dddddddd-0000-4000-8000-00000000000d";

function seed(showRealName: boolean | null): Record<string, any[]> {
  return {
    feature_flags: [],
    message_threads: [{ id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null }],
    message_thread_members: [
      { thread_id: DM, user_id: ALICE, left_at: null },
      { thread_id: DM, user_id: BOB, left_at: null },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice Real", avatar_url: null, city: "Hue" },
      { id: BOB, handle: "bob", name: "Robert Realname", avatar_url: "post-media/b/avatar.jpg", city: "Da Nang" },
    ],
    profile_privacy_settings: showRealName === null ? [] : [{ user_id: BOB, show_real_name: showRealName }],
  };
}

let h: RouterHarness;
before(async () => { h = await startRouter(telegraphSharedContextRouter); });
after(async () => { _setTestClient(null, false); await h.close(); });

async function header(tables: Record<string, any[]>, opts?: FakeDbOptions) {
  _setTestClient(makeFakeClient(tables, opts), true);
  const r = await call(h.base, "GET", `/threads/${DM}/conversation-header`, ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as { participants: Array<{ userId: string; identity: { handle: string | null; name: string | null; avatarUrl: string | null } | null }> };
}

describe("T295 — the DM header identity is the server's projection", () => {
  it("no privacy row (the default): handle and avatar, NO name", async () => {
    const b = await header(seed(null));
    const p = b.participants[0]!;
    assert.equal(p.userId, BOB);
    assert.deepEqual(p.identity, { handle: "bob", name: null, avatarUrl: "post-media/b/avatar.jpg" });
    assert.ok(!JSON.stringify(b).includes("Robert Realname"), "the hidden name reached the client");
  });

  it("show_real_name false: still no name", async () => {
    const b = await header(seed(false));
    assert.equal(b.participants[0]!.identity!.name, null);
  });

  it("show_real_name true: the name", async () => {
    const b = await header(seed(true));
    assert.equal(b.participants[0]!.identity!.name, "Robert Realname");
  });

  it("an unreadable privacy read hides the name — it never defaults to showing it", async () => {
    const b = await header(seed(true), { errors: { profile_privacy_settings: { message: "privacy unreadable" } } });
    assert.equal(b.participants[0]!.identity!.name, null);
    assert.equal(b.participants[0]!.identity!.handle, "bob");
  });

  it("an unreadable profiles read: identity null, and the header still answers", async () => {
    // afterOps 1: requireUser's own profiles read (account standing) is the first and must succeed,
    // or this case would prove a refusal that came from somewhere else.
    const b = await header(seed(true), { errors: { profiles: { message: "profiles unreadable", afterOps: 1 } } });
    assert.equal(b.participants[0]!.identity, null);
  });

  it("no city is projected — no server identity rule makes it public", async () => {
    const b = await header(seed(true));
    const wire = JSON.stringify(b);
    assert.ok(!wire.includes("Da Nang") && !wire.includes("\"city\""), wire);
  });
});

describe("T295 — the two conversation screens read no table directly", () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  for (const rel of ["travel-buddy-standalone/app/messages/[id].tsx", "travel-buddy-standalone/src/components/GroupChatScreen.tsx"]) {
    it(`${rel} has no supabase .from( read`, () => {
      const src = readFileSync(resolve(REPO, rel), "utf8");
      const hits = src.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /\.from\(\s*['"`]/.test(l) && !/^\s*(\/\/|\*)/.test(l));
      assert.deepEqual(hits, [], `raw table reads on a conversation screen: ${JSON.stringify(hits)}`);
    });
  }
});
