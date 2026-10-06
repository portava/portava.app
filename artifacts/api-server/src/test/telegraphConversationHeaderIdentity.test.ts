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

describe("re-verification 4 — the header identity follows the profile read rule (block, privacy), failing closed", () => {
  // The client read this replaced went through `profiles_select`: a profile is
  // readable by its owner, or when it is not private and no block stands either
  // way, or when no block stands and the two are friends. The endpoint reads with
  // the service client, so it applies that rule itself.
  const withRows = (over: Record<string, any[]>) => ({ ...seed(true), ...over });
  const identityOf = (b: Awaited<ReturnType<typeof header>>) => b.participants[0]!.identity;

  it("a block EITHER WAY withholds the identity — the other person's handle and avatar are not shown", async () => {
    for (const blocks of [[{ blocker_id: BOB, blocked_id: ALICE }], [{ blocker_id: ALICE, blocked_id: BOB }]]) {
      const b = await header(withRows({ blocks }));
      assert.equal(identityOf(b), null, JSON.stringify(b));
      assert.ok(!JSON.stringify(b).includes("\"bob\""), "the handle crossed the block");
    }
  });

  it("an unreadable blocks read withholds the identity — 'could not check' is not 'no block'", async () => {
    const b = await header(withRows({ blocks: [] }), { errors: { blocks: { message: "blocks unreadable" } } });
    assert.equal(identityOf(b), null);
  });

  it("only the SECOND block read ('has the other person blocked me?') is unreadable: the identity is still withheld", async () => {
    // Verification of a58aa01d3f, finding 6 (adopted from its probe
    // `__verifier_headerPartialBlockRead`): the case above fails BOTH reads, so a
    // decision that dropped one half of the block state stayed green. afterOps 1
    // lets the first `blocks` read succeed and fails the second.
    const b = await header(withRows({ blocks: [{ blocker_id: BOB, blocked_id: ALICE }] }),
      { errors: { blocks: { message: "blocks: second read timeout", ops: ["select"], afterOps: 1 } } });
    assert.equal(identityOf(b), null, `identity shown while the blocked-me read failed: ${JSON.stringify(identityOf(b))}`);
  });

  it("a PRIVATE profile is withheld from a non-friend", async () => {
    const b = await header(withRows({ blocks: [], profiles: [
      { id: ALICE, handle: "alice", name: "Alice Real", avatar_url: null, is_private: false },
      { id: BOB, handle: "bob", name: "Robert Realname", avatar_url: "post-media/b/avatar.jpg", is_private: true },
    ], user_friendships: [] }));
    assert.equal(identityOf(b), null);
  });

  it("CONTROL: a private profile is shown to a friend (either column order)", async () => {
    for (const f of [{ user_a: ALICE, user_b: BOB }, { user_a: BOB, user_b: ALICE }]) {
      const b = await header(withRows({ blocks: [], profiles: [
        { id: ALICE, handle: "alice", name: "Alice Real", avatar_url: null, is_private: false },
        { id: BOB, handle: "bob", name: "Robert Realname", avatar_url: "post-media/b/avatar.jpg", is_private: true },
      ], user_friendships: [f] }));
      assert.equal(identityOf(b)?.handle, "bob", JSON.stringify(f));
    }
  });

  it("a private profile with an unreadable friendships read is withheld", async () => {
    const b = await header(withRows({ blocks: [], profiles: [
      { id: ALICE, handle: "alice", name: "Alice Real", avatar_url: null, is_private: false },
      { id: BOB, handle: "bob", name: "Robert Realname", avatar_url: null, is_private: true },
    ] }), { errors: { user_friendships: { message: "friendships unreadable" } } });
    assert.equal(identityOf(b), null);
  });

  it("CONTROL: no block, not private — the identity is shown", async () => {
    const b = await header(withRows({ blocks: [] }));
    assert.equal(identityOf(b)?.handle, "bob");
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

describe("T372 / T305 — the Shared Context Rail is mounted on both conversation screens, gated by nothing but the thread id", () => {
  // Verification of a58aa01d3f, finding 4 (census-telegraph §45.1, §45f). The
  // rail's behaviour is proven where it lives (T13–T21; SharedContextRail's own
  // component suite) and its route is not flag-gated; what no test pinned was
  // that the two screens MOUNT it. This pins the mount and its only condition:
  //   - the screen imports the rail from the Telegraph feature;
  //   - exactly one live (non-comment) JSX line mounts it, and that line's
  //     condition is the thread id and nothing else — no flag, no state;
  //   - that line sits at the same JSX depth as the screen's message list, i.e.
  //     it is a sibling of the conversation itself, not nested in a branch.
  // DOES NOT COVER: a wrapper opened on an EARLIER line at a different depth that
  // re-indents nothing, or a condition computed elsewhere and hidden in `id`.
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const SCREENS: Array<[string, RegExp]> = [
    ["travel-buddy-standalone/app/messages/[id].tsx", /^(\s*)\{id \? <SharedContextRail threadId=\{id\}[ />]/],
    ["travel-buddy-standalone/src/components/GroupChatScreen.tsx", /^(\s*)\{thread\?\.id \? <SharedContextRail threadId=\{thread\.id\}[ />]/],
  ];
  for (const [rel, mount] of SCREENS) {
    it(`${rel} mounts <SharedContextRail> beside the message list, conditional only on the thread id`, () => {
      const lines = readFileSync(resolve(REPO, rel), "utf8").split("\n");
      const live = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => !/^\s*(\/\/|\*|\{\/\*)/.test(l));
      assert.ok(live.some(([, l]) => /^import \{[^}]*\bSharedContextRail\b[^}]*\} from '[^']*features\/telegraph\/index\.ts';/.test(l)),
        "the rail is not imported from the Telegraph feature");
      const mounts = live.filter(([, l]) => l.includes("<SharedContextRail"));
      assert.equal(mounts.length, 1, `expected exactly one mount: ${JSON.stringify(mounts)}`);
      const [lineNo, text] = mounts[0]!;
      const m = mount.exec(text);
      assert.ok(m, `line ${lineNo}: the mount's condition is not the thread id alone: ${text.trim()}`);
      const list = live.find(([n, l]) => n > lineNo && /^\s*<FlatList\b/.test(l));
      assert.ok(list, "no message list after the rail");
      assert.equal(/^(\s*)/.exec(list[1])![1], m[1], `line ${lineNo}: the rail is not at the message list's depth (line ${list[0]})`);
    });
  }
});
