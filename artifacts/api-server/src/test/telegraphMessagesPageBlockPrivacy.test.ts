/**
 * Telegraph §11.1 / census-telegraph W5.2 — "the block is not told", on the
 * MESSAGES PAGE.
 *
 * `GET /threads/:id/capabilities` passes every reason through `redactForWire`,
 * so a blocked viewer reads the `TELEGRAPH_AUTH_NOT_MEMBER` a stranger gets and
 * neither learns which they are (server/telegraph/capabilityRoute.ts). The same
 * reasons ride on `GET /threads/:id/messages` as its §24 `permissions` block,
 * and W5.2 found them served RAW there: a blocked member who can still read
 * the page was sent `TELEGRAPH_AUTH_BLOCKED` in so many words.
 *
 * WHAT IS ASSERTED. Whole-field equality, not "does not contain BLOCKED": the
 * blocked member's page `permissions` — reasons, degradedReasons, and the three
 * fields beside them — equals what a stranger to the same conversation is
 * served by GET /capabilities. Any field that differs answers "did this person
 * block me?". A stranger cannot read the page at all (403), so the stranger's
 * side of the comparison is the one wire a stranger CAN read for this thread.
 *
 * CONTROLS. An unblocked member's reasons are the policy's, untouched (the
 * redaction removes only the internal code), and a degraded answer keeps its
 * degraded reasons (none of them is internal).
 *
 * PIN. `degradedReasons` never carries an internal code today (the policy only
 * marks TELEGRAPH_DEGRADED_*), so its redaction cannot be shown by behaviour;
 * the last case pins that both reason fields pass through `redactForWire`.
 *
 * Run (listens on loopback, so outside the sandbox):
 *   TZ=UTC SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphMessagesPageBlockPrivacy.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import messagingRouter from "../routes/messaging.js";
import capabilityRouter from "../server/telegraph/capabilityRoute.js";
import { makeFakeClient, startRouter, call, resetFakeIds, type InjectedError, type RouterHarness } from "./telegraphCertificationHarness.js";
import { CONVERSATION_CAPABILITY_NAMES } from "../domain/telegraph/contracts/conversationCapabilities.js";
import { resolveConversationCapabilities } from "../domain/telegraph/policies/conversationCapabilityPolicy.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // a member of DM_BLOCKED; CAROL blocked her
const BOB = "bbbbbbbb-0000-4000-8000-000000000002"; // never in DM_BLOCKED: the stranger
const CAROL = "cccccccc-0000-4000-8000-000000000003";

const DM_BLOCKED = "00000000-0000-4000-8000-00000000000b";
const DM_OPEN = "00000000-0000-4000-8000-00000000000c"; // ALICE and BOB, no block
const M1 = "11111111-0000-4000-8000-000000000001";
const M2 = "11111111-0000-4000-8000-000000000002";

const DOWN: InjectedError = { message: "permission denied for relation", code: "42501" };

function member(thread: string, user: string) {
  return { thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null, last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null };
}
function dm(id: string) {
  return { id, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: false, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-03-11T00:00:00.000Z", last_message_at: "2026-03-11T00:00:00.000Z" };
}
function message(id: string, thread: string, sender: string) {
  return { id, thread_id: thread, sender_id: sender, body: "hi", created_at: "2026-03-11T00:00:00.000Z", deleted_at: null, edited_at: null, original_language: "en", msg_type: "text", subtype: null, media_url: null, media_type: null, media_thumbnail_url: null, media_duration_seconds: null, reply_to_id: null };
}

function seed(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice", show_name: true },
      { id: BOB, handle: "bob", name: "Bob", show_name: true },
      { id: CAROL, handle: "carol", name: "Carol", show_name: true },
    ],
    blocks: [{ blocker_id: CAROL, blocked_id: ALICE }],
    message_threads: [dm(DM_BLOCKED), dm(DM_OPEN)],
    message_thread_members: [member(DM_BLOCKED, ALICE), member(DM_BLOCKED, CAROL), member(DM_OPEN, ALICE), member(DM_OPEN, BOB)],
    messages: [message(M1, DM_BLOCKED, CAROL), message(M2, DM_OPEN, BOB)],
    message_translations: [],
    trips: [],
    trip_members: [],
    message_requests: [],
    user_privacy_settings: [],
    trust_restrictions: [],
    rent_buddy_bookings: [],
    trip_crew_location_sessions: [],
  };
}

const PERMISSION_FIELDS = ["capabilities", "reasons", "inputsRead", "degraded", "degradedReasons"] as const;

let harness: RouterHarness;

function use(errors?: Record<string, InjectedError>) {
  const c = makeFakeClient(seed(), errors ? { errors } : undefined);
  _setTestClient(c, true);
  return c;
}

before(async () => {
  const both = express.Router();
  both.use(capabilityRouter);
  both.use(messagingRouter);
  harness = await startRouter(both);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});
beforeEach(() => resetFakeIds());

describe("§11.1 on GET /threads/:id/messages — a blocked member's permissions are a stranger's", () => {
  it("the blocked member's page reasons EQUAL the stranger's GET /capabilities reasons, whole field", async () => {
    use();
    const page = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/messages`, ALICE);
    use();
    const outsider = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/capabilities`, BOB);
    assert.equal(page.status, 200, "control: a blocked member still reads her DM");
    assert.equal(outsider.status, 200);
    assert.deepEqual(page.body.permissions.reasons, outsider.body.reasons, "the page tells the blocked member something the stranger is not told");
    assert.ok(!JSON.stringify(page.body.permissions).includes("BLOCKED"), "TELEGRAPH_AUTH_BLOCKED reached the wire");
  });

  it("every field of the permissions block equals the stranger's (capabilities, reasons, inputsRead, degraded, degradedReasons)", async () => {
    use();
    const page = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/messages`, ALICE);
    use();
    const outsider = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/capabilities`, BOB);
    assert.deepEqual(Object.keys(page.body.permissions).sort(), [...PERMISSION_FIELDS].sort());
    for (const f of PERMISSION_FIELDS) assert.deepEqual(page.body.permissions[f], outsider.body[f], `permissions.${f} differs from a stranger's`);
  });

  it("one rule on both wires: the blocked member's page reasons equal her own GET /capabilities reasons", async () => {
    use();
    const page = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/messages`, ALICE);
    use();
    const own = await call(harness.base, "GET", `/threads/${DM_BLOCKED}/capabilities`, ALICE);
    assert.deepEqual(page.body.permissions.reasons, own.body.reasons);
    assert.deepEqual(page.body.permissions.degradedReasons, own.body.degradedReasons);
  });

  it("CONTROL: the policy keeps the honest reason — the redaction is the route's", async () => {
    const c = use();
    const honest = await resolveConversationCapabilities(c as any, { viewerId: ALICE, conversationId: DM_BLOCKED });
    for (const name of CONVERSATION_CAPABILITY_NAMES) assert.equal(honest.reasons[name], "TELEGRAPH_AUTH_BLOCKED");
  });

  it("CONTROL: an unblocked member's page reasons are the policy's, untouched", async () => {
    const c = use();
    const direct = await resolveConversationCapabilities(c as any, { viewerId: ALICE, conversationId: DM_OPEN });
    use();
    const page = await call(harness.base, "GET", `/threads/${DM_OPEN}/messages`, ALICE);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.permissions.reasons, direct.reasons);
    assert.equal(page.body.permissions.capabilities.canSendMessage, true, "control: the open DM is open");
  });

  it("CONTROL: a degraded answer keeps its degraded reasons (none is internal)", async () => {
    use({ trust_restrictions: DOWN });
    const page = await call(harness.base, "GET", `/threads/${DM_OPEN}/messages`, ALICE);
    assert.equal(page.status, 200);
    assert.equal(page.body.permissions.degraded, true);
    assert.deepEqual(page.body.permissions.degradedReasons, ["TELEGRAPH_DEGRADED_TRUST_UNREADABLE"]);
  });

  it("PIN: both reason fields of the page's permissions block pass through redactForWire", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../routes/messaging.ts"), "utf8");
    const at = src.indexOf("router.get('/threads/:threadId/messages'");
    assert.ok(at > 0, "the messages page handler moved");
    const block = src.slice(src.indexOf("permissions: {", at), src.indexOf("},", src.indexOf("permissions: {", at)));
    assert.match(block, /\n\s*reasons: [^\n]*redactForWire\(raw\)/, "permissions.reasons is served without redactForWire");
    assert.match(block, /\n\s*degradedReasons: resolvedCapabilities\.degradedReasons\.map\(redactForWire\)/, "permissions.degradedReasons is served without redactForWire");
  });
});
