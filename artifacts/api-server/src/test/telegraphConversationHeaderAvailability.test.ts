/**
 * Verification of a58aa01d3f, finding 1 (census-telegraph §45d.3, §45f) — the
 * conversation header's AVAILABILITY never crosses a block, and a window's
 * audience is tested against the viewer's REAL relationship to its owner.
 *
 * THE LEAK THIS CLOSES. `GET /threads/:id/conversation-header` withheld the
 * other person's IDENTITY across a block (re-verification 4), but projected
 * their live availability beside it with no block check: the person BOB blocked
 * still read whether BOB was free, until when, and for what. A blocked person
 * cannot read the blocker's profile at all (`profiles_select`), so this was a
 * block bypass for a presence-class signal. Separately, the handler assumed
 * every direct-thread counterpart was a `follower`, so a window BOB showed to
 * his followers only reached ALICE, who does not follow him.
 *
 * Adopted from the verifier's probe `__verifier_headerAvailabilityLeak` (its
 * four cases are the first four below, unchanged in what they assert), plus the
 * relationship's controls and failure modes.
 *
 * WHAT IS EXERCISED: the real router over the certification harness, with
 * `open_to_plans_windows_enabled` ON and BOB holding one explicit, live window.
 *
 * Run: node --import tsx/esm --test src/test/telegraphConversationHeaderAvailability.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { _setTestClient } from "../lib/http.js";
import telegraphSharedContextRouter from "../routes/telegraphSharedContext.js";
import { makeFakeClient, startRouter, call, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // the viewer
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // the other person, with a live window
const DM = "dddddddd-0000-4000-8000-00000000000d";

const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const future = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

type Edge = { follower_id: string; following_id: string };
type Block = { blocker_id: string; blocked_id: string };

function seed(opts: { blocks?: Block[]; visibility?: string; follows?: Edge[] } = {}): Record<string, unknown[]> {
  return {
    feature_flags: [{ flag: "open_to_plans_windows_enabled", enabled: true }],
    message_threads: [{ id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null }],
    message_thread_members: [
      { thread_id: DM, user_id: ALICE, left_at: null },
      { thread_id: DM, user_id: BOB, left_at: null },
    ],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", avatar_url: null, is_private: false },
      { id: BOB, handle: "bob", name: "Bob", avatar_url: null, is_private: false },
    ],
    profile_privacy_settings: [],
    user_friendships: [],
    user_follows: opts.follows ?? [],
    blocks: opts.blocks ?? [],
    availability_windows: [{
      id: "99990000-0000-4000-8000-000000000001", user_id: BOB, type: "quick", start_at: past, end_at: future,
      trip_id: null, open_to_plans: true, intents: ["coffee"], group_preference: null, max_travel_minutes: null,
      visibility: opts.visibility ?? "public", source: "explicit", social_availability: "open", expires_at: future,
      created_at: past, updated_at: past,
    }],
    circle_presence: [],
  };
}

interface HeaderBody {
  participants: Array<{
    userId: string;
    identity: { handle: string | null } | null;
    availability: { enabled: boolean; state: string | null; intents: string[]; expiresAt: string | null };
  }>;
}

let h: RouterHarness;
before(async () => { h = await startRouter(telegraphSharedContextRouter); });
after(async () => { _setTestClient(null, false); await h.close(); });

async function header(tables: Record<string, unknown[]>, opts?: FakeDbOptions): Promise<{ body: HeaderBody; wire: string }> {
  _setTestClient(makeFakeClient(tables, opts), true);
  const r = await call(h.base, "GET", `/threads/${DM}/conversation-header`, ALICE);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { body: r.body as HeaderBody, wire: JSON.stringify(r.body) };
}

const WITHHELD = { enabled: true, state: null, intents: [], expiresAt: null };

describe("finding 1 — availability on the conversation header never crosses a block", () => {
  it("CONTROL: no block, a public window — the state is shown (the case is live)", async () => {
    const { body } = await header(seed());
    const p = body.participants[0]!;
    assert.equal(p.userId, BOB);
    assert.equal(p.availability.state, "open");
    assert.deepEqual(p.availability.intents, ["coffee"]);
    assert.equal(p.availability.expiresAt, future);
  });

  it("BOB blocked ALICE: identity AND availability are withheld", async () => {
    const { body, wire } = await header(seed({ blocks: [{ blocker_id: BOB, blocked_id: ALICE }] }));
    const p = body.participants[0]!;
    assert.equal(p.identity, null, "identity crossed the block");
    assert.deepEqual(p.availability, WITHHELD, `availability crossed the block: ${JSON.stringify(p.availability)}`);
    assert.ok(!wire.includes("coffee"), "the blocker's intents reached the person they blocked");
  });

  it("ALICE blocked BOB: same, the other direction", async () => {
    const { body, wire } = await header(seed({ blocks: [{ blocker_id: ALICE, blocked_id: BOB }] }));
    const p = body.participants[0]!;
    assert.equal(p.identity, null);
    assert.deepEqual(p.availability, WITHHELD, `availability crossed the block: ${JSON.stringify(p.availability)}`);
    assert.ok(!wire.includes("coffee"));
  });

  it("a FOLLOWERS-only window: ALICE does not follow BOB, so it is not shown", async () => {
    const { body } = await header(seed({ visibility: "followers" }));
    assert.deepEqual(body.participants[0]!.availability, WITHHELD,
      `a followers-only window shown to a non-follower: ${JSON.stringify(body.participants[0]!.availability)}`);
  });

  it("an unreadable block read withholds availability — 'could not check' is not 'no block'", async () => {
    // Both reads, then only the SECOND ("has the other person blocked me?").
    // NOT covered: failing only the FIRST — the harness's afterOps injects from
    // the Nth operation onward, so it cannot — and a decision that dropped the
    // first read's error alone would stay green here (measured).
    for (const err of [{ message: "blocks unreadable" }, { message: "blocks: second read timeout", ops: ["select" as const], afterOps: 1 }]) {
      const { body } = await header(seed(), { errors: { blocks: err } });
      assert.deepEqual(body.participants[0]!.availability, WITHHELD, `${JSON.stringify(err)}: ${JSON.stringify(body.participants[0]!.availability)}`);
    }
  });
});

describe("finding 1 — the window's audience is tested against the viewer's REAL relationship", () => {
  it("CONTROL (lead ruling D-103): ALICE and BOB follow each other — his followers-only window is shown to her", async () => {
    const { body } = await header(seed({ visibility: "followers", follows: [{ follower_id: ALICE, following_id: BOB }, { follower_id: BOB, following_id: ALICE }] }));
    assert.equal(body.participants[0]!.availability.state, "open");
  });

  it("D-103: ALICE follows BOB but he does not follow her back — one-way is refused", async () => {
    const { body } = await header(seed({ visibility: "followers", follows: [{ follower_id: ALICE, following_id: BOB }] }));
    assert.deepEqual(body.participants[0]!.availability, WITHHELD);
  });

  it("only BOB follows ALICE — that makes her someone he follows, not his follower: not shown", async () => {
    const { body } = await header(seed({ visibility: "followers", follows: [{ follower_id: BOB, following_id: ALICE }] }));
    assert.deepEqual(body.participants[0]!.availability, WITHHELD);
  });

  it("L3: a FOLLOWING window — BOB (its owner) follows ALICE: shown", async () => {
    const { body } = await header(seed({ visibility: "following", follows: [{ follower_id: BOB, following_id: ALICE }] }));
    assert.equal(body.participants[0]!.availability.state, "open");
  });

  it("L3: a FOLLOWING window — only ALICE follows BOB: not shown (following him is not his choice)", async () => {
    const { body } = await header(seed({ visibility: "following", follows: [{ follower_id: ALICE, following_id: BOB }] }));
    assert.deepEqual(body.participants[0]!.availability, WITHHELD);
  });

  it("ALICE and BOB follow each other but the follow edges cannot be read — not mutual (fails closed)", async () => {
    const { body } = await header(
      seed({ visibility: "followers", follows: [{ follower_id: ALICE, following_id: BOB }, { follower_id: BOB, following_id: ALICE }] }),
      { errors: { user_follows: { message: "follows: timeout" } } },
    );
    assert.deepEqual(body.participants[0]!.availability, WITHHELD);
  });

  it("CONTROL: an unreadable follow edge does not hide a PUBLIC window — only what the edge would admit", async () => {
    const { body } = await header(seed({ visibility: "public" }), { errors: { user_follows: { message: "follows: timeout" } } });
    assert.equal(body.participants[0]!.availability.state, "open");
  });
});
