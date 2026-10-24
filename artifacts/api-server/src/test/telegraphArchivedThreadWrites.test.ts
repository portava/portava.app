/**
 * An archived thread takes no write — at every door, and exactly where the
 * capabilities projection says so.
 *
 * THE DEFECT (found on main at ffdf6428c while fixing PR #786). The projection
 * (`conversationCapabilityPolicy.ts`) denies `canSendMessage` with
 * TELEGRAPH_POLICY_THREAD_ARCHIVED whenever `message_threads.status` is not
 * 'active'. No door performed that refusal: the shared guard
 * (`lib/telegraphThreadWrite.ts` — forward, typed kinds, voice, share,
 * coordination, the kernel command door, postPlainThreadMessage, highlights,
 * hidden gems, polls, group formation) never read the column, and neither did
 * the two inline doors in `routes/messaging.ts` (text, media). A refusal
 * announced and never performed: a client that ignored the capability, or any
 * script, wrote into a thread the server called closed.
 *
 * WHAT THIS PINS. Every assertion is on a response AND on the rows the door did
 * or did not write.
 *   1. every door refuses an archived thread (403 forbidden, reason
 *      TELEGRAPH_POLICY_THREAD_ARCHIVED) and writes nothing; the SAME door on an
 *      active twin thread writes (the control that stops a guard refusing
 *      everything from passing);
 *   2. a safety send (coordination NEED_HELP) is refused too — the projection
 *      has no safety exception for an archived thread, and neither does the guard;
 *   3. the projection, the shared guard and the text door give one answer on
 *      archived / active / absent-status threads, with the same reason;
 *   4. ordering: a non-member of an archived thread is still "not a member"
 *      (nothing about the thread's state leaks to a stranger), and a blocked
 *      sender's refusal is unchanged.
 *
 * MUTANTS (each run against this suite plus telegraphForwarding.test.ts, 50
 * tests, before the PR was opened; counts are red tests of the 50):
 *   M1 the guard's status line removed (lib/telegraphThreadWrite.ts gate 3b)
 *      → 16 red: every guarded door in 1, both cases of 2, 3, and the forward
 *      case; the text and media cases in 1 stay green (they hold their own).
 *   M2 the text door's status check removed (routes/messaging.ts) → 3 red
 *      (text in 1, direct and group; 3).
 *   M3 the media door's status check removed → 2 red (media in 1).
 *   M4 threadAcceptsWrites returns true → 21 red.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphArchivedThreadWrites.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import { postPlainThreadMessage } from "../lib/threadMessage.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";
import { threadAcceptsWrites, THREAD_ARCHIVED_MESSAGE } from "../domain/telegraph/policies/messageDoorPolicy.js";
import messagingRouter from "../routes/messaging.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphVoiceRouter from "../routes/telegraphVoice.js";
import telegraphShareRouter from "../routes/telegraphShare.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import commandRouter from "../server/telegraph/commandRoute.js";
import { makeFakeClient, startRouter, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001"; // the sender in every case
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

const T = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
const DM_ACTIVE = T("d1"); //     direct A+B, active, B has written
const DM_ARCHIVED = T("d2"); //   direct A+B, archived, B has written
const GRP_ACTIVE = T("d3"); //    group A+B+C, active
const GRP_ARCHIVED = T("d4"); //  group A+B+C, archived
const DM_NO_STATUS = T("d5"); //  direct A+B, status column absent from the row (reads as active)
const ARCHIVED_FOREIGN = T("d6"); // group B+C, archived — A is not a member
const GEM = "55550000-0000-4000-8000-000000000001";

const member = (thread: string, user: string) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
});
const thread = (id: string, type: string, status: string | undefined) => {
  const row: Record<string, unknown> = {
    id, thread_type: type, trip_id: null, circle_owner_id: null, title: null, is_e2ee: false,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
  };
  if (status !== undefined) row.status = status;
  return row;
};
const message = (id: string, threadId: string, sender: string) => ({
  id, thread_id: threadId, sender_id: sender, body: "hello", created_at: "2026-05-02T00:00:00.000Z",
  deleted_at: null, unsent_at: null, edited_at: null, msg_type: "text", subtype: null, reply_to_id: null,
});

function seed(over: Partial<Record<string, any[]>> = {}): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "telegraph_message_kernel_enabled", enabled: true }],
    blocks: [],
    profiles: [A, B, C].map((id, i) => ({ id, handle: `u${i}`, name: `U${i}`, preferred_language: "en", avatar_url: null, show_name_publicly: true })),
    user_message_settings: [], user_friendships: [], user_follows: [], circle_memberships: [], trip_members: [],
    trust_profiles: [], trust_restrictions: [], message_requests: [],
    message_threads: [
      thread(DM_ACTIVE, "direct", "active"), thread(DM_ARCHIVED, "direct", "archived"),
      thread(GRP_ACTIVE, "group", "active"), thread(GRP_ARCHIVED, "group", "archived"),
      thread(DM_NO_STATUS, "direct", undefined), thread(ARCHIVED_FOREIGN, "group", "archived"),
    ],
    message_thread_members: [
      member(DM_ACTIVE, A), member(DM_ACTIVE, B),
      member(DM_ARCHIVED, A), member(DM_ARCHIVED, B),
      member(GRP_ACTIVE, A), member(GRP_ACTIVE, B), member(GRP_ACTIVE, C),
      member(GRP_ARCHIVED, A), member(GRP_ARCHIVED, B), member(GRP_ARCHIVED, C),
      member(DM_NO_STATUS, A), member(DM_NO_STATUS, B),
      member(ARCHIVED_FOREIGN, B), member(ARCHIVED_FOREIGN, C),
    ],
    messages: [
      message("11111111-0000-4000-8000-000000000001", DM_ACTIVE, B),
      message("11111111-0000-4000-8000-000000000002", DM_ARCHIVED, B),
      message("11111111-0000-4000-8000-000000000003", DM_NO_STATUS, B),
    ],
    message_translations: [], message_reactions: [], rent_buddy_bookings: [],
    hidden_gems: [{
      id: GEM, name: "Rooftop", city: "Hue", neighborhood: "Old town", category: "bar", status: "active",
      sensitivity_level: "public", merged_into: null, updated_at: "2026-05-02T00:00:00.000Z",
    }],
    ...over,
  };
}

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(telegraphShareRouter);
  all.use(telegraphKindsRouter);
  all.use(telegraphVoiceRouter);
  all.use(telegraphCoordinationRouter);
  all.use(commandRouter);
  all.use(messagingRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(over: Partial<Record<string, any[]>> = {}): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  // No `status` column default here on purpose: DM_NO_STATUS must reach the predicate with the key absent.
  const c = makeFakeClient(seed(over), { columnDefaults: { message_threads: { thread_type: "direct", is_e2ee: false } } });
  _setTestClient(c, true);
  return c;
}

interface Outcome { ok: boolean; status: number; error: string | null; reason: string | null; message: string | null; raw: string }

async function http(path: string, body: unknown, asUser = A): Promise<Outcome> {
  const res = await fetch(`${harness.base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${asUser}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  return {
    ok: res.status >= 200 && res.status < 300, status: res.status,
    error: typeof parsed?.error === "string" ? parsed.error : null,
    reason: typeof parsed?.reason === "string" ? parsed.reason : null,
    message: typeof parsed?.message === "string" ? parsed.message : null,
    raw: `${res.status} ${raw}`,
  };
}

async function plain(c: FakeClient, threadId: string): Promise<Outcome> {
  const r = await postPlainThreadMessage(c as any, { threadId, senderId: A, body: "On a layover — any quick tips?" });
  if (r.ok) return { ok: true, status: 201, error: null, reason: null, message: null, raw: JSON.stringify(r) };
  return { ok: false, status: 0, error: r.reason, reason: null, message: "message" in r ? (r.message ?? null) : null, raw: JSON.stringify(r) };
}

let seq = 0;
interface Door { name: string; guarded: boolean; send(c: FakeClient, threadId: string): Promise<Outcome> }
const DOORS: readonly Door[] = [
  { name: "text   POST /threads/:id/messages", guarded: false, send: (_c, t) => http(`/threads/${t}/messages`, { body: `hello ${++seq}` }) },
  { name: "media  POST /threads/:id/media", guarded: false, send: (_c, t) => http(`/threads/${t}/media`, { mediaUrl: `post-media/${A}/p${++seq}.webp`, mediaType: "image" }) },
  { name: "typed  POST /threads/:id/typed-messages", guarded: true, send: (_c, t) => http(`/threads/${t}/typed-messages`, { kind: "ANNOUNCEMENT", payload: { title: "Leaving at eight" } }) },
  {
    name: "voice  POST /threads/:id/voice", guarded: true,
    send: (_c, t) => http(`/threads/${t}/voice`, { payload: {
      url: `post-media/${A}/voice/17000000${++seq}.m4a`, durationSeconds: 12, waveform: [0.1, 0.5, 0.9], mimeType: "audio/mp4", sizeBytes: 98_304,
    } }),
  },
  { name: "share  POST /threads/:id/share", guarded: true, send: (_c, t) => http(`/threads/${t}/share`, { objectType: "HIDDEN_GEM", objectId: GEM }) },
  { name: "coord  POST /threads/:id/coordination", guarded: true, send: (_c, t) => http(`/threads/${t}/coordination`, { kind: "COORDINATION", payload: { state: "ARRIVED" } }) },
  {
    name: "cmd    POST /telegraph/commands CREATE_COORDINATION_SESSION", guarded: true,
    send: (_c, t) => http(`/telegraph/commands`, { type: "CREATE_COORDINATION_SESSION", conversationId: t, idempotency_key: `k-${++seq}`, params: { title: "Dinner run" } }),
  },
  { name: "lib    postPlainThreadMessage", guarded: true, send: (c, t) => plain(c, t) },
];

const fromA = (c: FakeClient, threadId: string) => (c._store.messages ?? []).filter((m) => m.thread_id === threadId && m.sender_id === A).length;

describe("1. every door refuses an archived thread and writes nothing; the same door writes into its active twin", () => {
  for (const door of DOORS) {
    for (const [archived, active, shape] of [[DM_ARCHIVED, DM_ACTIVE, "direct"], [GRP_ARCHIVED, GRP_ACTIVE, "group"]] as const) {
      it(`${door.name} — ${shape}`, async () => {
        const c = use();
        const out = await door.send(c, archived);
        assert.equal(out.ok, false, `archived ${shape}: admitted — ${out.raw}`);
        assert.equal(fromA(c, archived), 0, `archived ${shape}: refused AND written`);
        if (door.name.startsWith("lib")) {
          assert.equal(out.error, "forbidden", out.raw);
        } else {
          assert.equal(out.status, 403, out.raw);
          assert.equal(out.error, "forbidden", out.raw);
          assert.equal(out.reason, "TELEGRAPH_POLICY_THREAD_ARCHIVED", `the refusal names why: ${out.raw}`);
          assert.equal(out.message, THREAD_ARCHIVED_MESSAGE, out.raw);
        }

        const c2 = use();
        const ok = await door.send(c2, active);
        assert.equal(ok.ok, true, `CONTROL active ${shape}: refused — ${ok.raw}`);
        assert.ok(fromA(c2, active) >= 1, `CONTROL active ${shape}: answered ok and wrote nothing`);
      });
    }
  }
});

describe("2. a safety send into an archived thread is refused — the projection has no safety exception here", () => {
  it("coordination NEED_HELP: refused, nothing written; the same send into the active twin is written", async () => {
    const c = use();
    const out = await http(`/threads/${GRP_ARCHIVED}/coordination`, { kind: "COORDINATION", payload: { state: "NEED_HELP" } });
    assert.equal(out.status, 403, out.raw);
    assert.equal(out.reason, "TELEGRAPH_POLICY_THREAD_ARCHIVED", out.raw);
    assert.equal(fromA(c, GRP_ARCHIVED), 0);
    const c2 = use();
    const ok = await http(`/threads/${GRP_ACTIVE}/coordination`, { kind: "COORDINATION", payload: { state: "NEED_HELP" } });
    assert.equal(ok.ok, true, ok.raw);
    assert.equal(fromA(c2, GRP_ACTIVE), 1);
  });

  it("the guard itself, asked for a safety send, refuses an archived thread by name", async () => {
    const g = await guardTelegraphThreadWrite(use() as any, DM_ARCHIVED, A, { safety: true, sendBucket: "safety" });
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.reason, "TELEGRAPH_POLICY_THREAD_ARCHIVED");
  });
});

describe("3. projection, shared guard and text door give one answer", () => {
  it("archived, active and absent-status threads, direct and group", async () => {
    const want: Record<string, boolean> = { [DM_ACTIVE]: true, [GRP_ACTIVE]: true, [DM_NO_STATUS]: true, [DM_ARCHIVED]: false, [GRP_ARCHIVED]: false };
    for (const [t, expected] of Object.entries(want)) {
      const projection = await resolveConversationCapabilities(use() as any, { viewerId: A, conversationId: t });
      const guard = await guardTelegraphThreadWrite(use() as any, t, A);
      use();
      const text = await http(`/threads/${t}/messages`, { body: "agreement" });
      assert.equal(projection.capabilities.canSendMessage, expected, `${t}: projection`);
      assert.equal(guard.ok, expected, `${t}: guard`);
      assert.equal(text.ok, expected, `${t}: text door ${text.raw}`);
      if (!expected) {
        assert.equal(projection.reasons.canSendMessage, "TELEGRAPH_POLICY_THREAD_ARCHIVED", t);
        assert.equal(!guard.ok && guard.reason, "TELEGRAPH_POLICY_THREAD_ARCHIVED", t);
        assert.equal(text.reason, "TELEGRAPH_POLICY_THREAD_ARCHIVED", t);
      }
    }
  });

  it("the one predicate: only 'active' (or no status at all) accepts writes", () => {
    assert.equal(threadAcceptsWrites({ status: "active" }), true);
    assert.equal(threadAcceptsWrites({}), true);
    assert.equal(threadAcceptsWrites({ status: null }), true);
    assert.equal(threadAcceptsWrites(null), true, "a missing row is decided by membership, not by this gate");
    assert.equal(threadAcceptsWrites({ status: "archived" }), false);
    assert.equal(threadAcceptsWrites({ status: "closed" }), false, "anything but 'active' is closed, as the projection reads it");
  });
});

describe("4. order: the archived gate tells a stranger nothing and leaves the block refusal as it was", () => {
  it("a non-member of an archived thread is refused as a non-member, at the guard and the text door", async () => {
    const g = await guardTelegraphThreadWrite(use() as any, ARCHIVED_FOREIGN, A);
    assert.equal(g.ok, false);
    if (!g.ok) {
      assert.equal(g.message, "Not a member of this thread");
      assert.equal(g.reason, undefined, "the archived reason must not reach a non-member");
    }
    const c = use();
    const text = await http(`/threads/${ARCHIVED_FOREIGN}/messages`, { body: "probe" });
    assert.equal(text.ok, false);
    assert.notEqual(text.reason, "TELEGRAPH_POLICY_THREAD_ARCHIVED", text.raw);
    assert.equal(fromA(c, ARCHIVED_FOREIGN), 0);
  });

  it("a blocked sender in an archived 1:1 is refused by the block gate, unchanged", async () => {
    const g = await guardTelegraphThreadWrite(use({ blocks: [{ blocker_id: B, blocked_id: A }] }) as any, DM_ARCHIVED, A);
    assert.equal(g.ok, false);
    if (!g.ok) assert.equal(g.message, "You cannot message this user");
  });
});
