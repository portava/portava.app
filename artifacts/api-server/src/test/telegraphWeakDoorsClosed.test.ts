/**
 * Telegraph §22 / census-telegraph §42 — the two KNOWN WEAK doors into
 * `public.messages` that lane C owns now hold the send path's gates.
 *
 * §42 built one guard for every door (`guardTelegraphThreadWrite`: the
 * messaging stop, membership with its read error bound, the 1:1 block, the
 * end-to-end-encryption refusal and the burst limit) and declared four doors
 * KNOWN WEAK under a ceiling that may only fall. Two of them are lane C's:
 *
 *  - `POST /hidden-gems/:id/share-telegraph` checked membership ONLY, dropped
 *    that read's error, wrote a plaintext JSON card into whatever thread was
 *    named — an end-to-end encrypted one included — and never looked at the
 *    insert's result, so a refused write answered `ok: true`;
 *  - `POST /threads/:id/telegraph/suggestions/:id/start-poll` held membership
 *    and E2EE but not the stop, the block or the burst limit, so a person the
 *    other side had BLOCKED could still post a poll card into their 1:1 thread.
 *
 * Every refusal below is asserted as a STATE: the store is read back and the
 * `messages` rows that must not exist are counted. A 403 from a handler that
 * wrote first is the worst of both. Each THE POINT case is paired with a
 * CONTROL on the same fixture that must still write exactly one row, so a
 * guard that refuses everything cannot pass.
 *
 * SHOWN RED before green, with `routes/hiddenGems.ts` and
 * `routes/telegraphChat.ts` at `2e46835263`: the gem cases G1 (blocked → 200,
 * one row), G2 (E2EE → 200, one plaintext row), G3 (stop → 200, one row),
 * G4 (membership unreadable → 403, not 503) and G5 (insert refused → 200
 * ok:true) fail; the poll cases P1 (blocked → 200, one row) and P2 (stop → 200,
 * one row) fail — 7 of 11. G0, G6, P0 and P3 pass on both trees by design: G0
 * and P0 are what stop a guard that refuses everything from passing, and G6 and
 * P3 are the two refusals each door already held.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx/esm --test src/test/telegraphWeakDoorsClosed.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import telegraphChatRouter from "../routes/telegraphChat.js";
import {
  makeFakeClient,
  startRouter,
  call,
  type FakeClient,
  type RouterHarness,
} from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DM = "00000000-0000-4000-8000-00000000000d";
const DM_E2EE = "00000000-0000-4000-8000-00000000000e";
const GEM = "99999999-0000-4000-8000-000000000009";
const SUGG = "55555555-0000-4000-8000-000000000005";

const member = (thread: string, user: string) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
});
const thread = (id: string, e2ee = false) => ({
  id, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: e2ee,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null,
});

function store(over: Partial<Record<string, Array<Record<string, unknown>>>> = {}): Record<string, Array<Record<string, unknown>>> {
  return {
    feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
    blocks: [],
    profiles: [
      { id: A, handle: "a", name: "A" },
      { id: B, handle: "b", name: "B" },
    ],
    trust_profiles: [],
    trust_restrictions: [],
    message_threads: [thread(DM), thread(DM_E2EE, true)],
    message_thread_members: [member(DM, A), member(DM, B), member(DM_E2EE, A), member(DM_E2EE, B)],
    messages: [],
    hidden_gems: [{
      id: GEM, name: "Secret Rooftop", category: "viewpoint", city: "Tokyo", country: "Japan",
      neighborhood: "Shibuya", description: "view", latitude: 35.6762, longitude: 139.6503,
      approx_latitude: 35.68, approx_longitude: 139.65, vibe_tags: ["view"], price_range: "free",
      safety_notes: null, best_time_to_go: null, local_etiquette: null, layover_safe: false,
      minimum_layover_minutes: null, sensitivity_level: "public", verification_level: "community",
      status: "active", submitted_by: B, guide_verified_by: null, save_count: 0, visit_count: 0,
      report_count: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    }],
    telegraph_chat_suggestions: [{ id: SUGG, user_id: A, thread_id: DM, title: "Dinner", status: "shown" }],
    ...over,
  };
}

/** B has blocked A. The DM is 1:1, so the pairwise guard applies to it. */
const B_BLOCKED_A = { blocks: [{ blocker_id: B, blocked_id: A }] };
const STOP_ENGAGED = {
  feature_flags: [
    { flag: "hidden_gems_enabled", enabled: true },
    { flag: "disable_messaging", enabled: true },
  ],
};

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(hiddenGemsRouter);
  all.use(telegraphChatRouter);
  harness = await startRouter(all);
});
after(async () => {
  _setTestClient(null, false);
  await harness.close();
});

function use(seed: Record<string, Array<Record<string, unknown>>>, opts?: Parameters<typeof makeFakeClient>[1]): FakeClient {
  // The limiter's buckets are process state; reset per case.
  _resetRateLimit();
  _clearSendTierCache();
  const c = makeFakeClient(seed, opts);
  _setTestClient(c, true);
  return c;
}

const rows = (c: FakeClient, threadId: string) =>
  (c._store.messages ?? []).filter((m: Record<string, unknown>) => m.thread_id === threadId);

const shareGem = (threadId: string, as = A) =>
  call(harness.base, "POST", `/hidden-gems/${GEM}/share-telegraph`, as, { threadId });
const startPoll = (threadId: string, as = A) =>
  call(harness.base, "POST", `/threads/${threadId}/telegraph/suggestions/${SUGG}/start-poll`, as, {
    options: ["Morning", "Evening"],
  });

describe("POST /hidden-gems/:id/share-telegraph holds every gate", () => {
  it("G0. CONTROL: a member of an ordinary DM shares the gem — one card row, ok", async () => {
    const c = use(store());
    const r = await shareGem(DM);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const written = rows(c, DM);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.subtype, "hidden_gem");
  });

  it("G1. THE POINT: the other person BLOCKED the sender — refused, and no row", async () => {
    const c = use(store(B_BLOCKED_A));
    const r = await shareGem(DM);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(rows(c, DM).length, 0, "a blocked sender's card reached the thread");
  });

  it("G2. THE POINT: an end-to-end encrypted thread — refused, and no plaintext row", async () => {
    const c = use(store());
    const r = await shareGem(DM_E2EE);
    assert.equal(r.body.error, "e2ee_thread", JSON.stringify(r.body));
    assert.equal(rows(c, DM_E2EE).length, 0, "plaintext JSON was stored in an E2EE thread");
  });

  it("G3. THE POINT: the messaging stop is engaged — refused, and no row", async () => {
    const c = use(store(STOP_ENGAGED));
    const r = await shareGem(DM);
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(rows(c, DM).length, 0);
  });

  it("G4. THE POINT: an unreadable membership is 503, not 'not a member', and writes nothing", async () => {
    const c = use(store(), { errors: { message_thread_members: { message: "roster down", ops: ["select"] } } });
    const r = await shareGem(DM);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(rows(c, DM).length, 0);
  });

  it("G5. THE POINT: a refused insert is not a share — the answer is an error, not ok:true", async () => {
    use(store(), { errors: { messages: { message: "insert refused", ops: ["insert"] } } });
    const r = await shareGem(DM);
    assert.notEqual(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body?.ok, true);
    assert.equal(r.body.error, "db_error");
  });

  it("G6. a non-member is still refused, and nothing is written", async () => {
    const c = use(store({ message_thread_members: [member(DM, B)] }));
    const r = await shareGem(DM);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(rows(c, DM).length, 0);
  });
});

describe("POST .../start-poll holds every gate", () => {
  it("P0. CONTROL: a member posts the poll into an ordinary DM — one row", async () => {
    const c = use(store());
    const r = await startPoll(DM);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rows(c, DM).length, 1);
  });

  it("P1. THE POINT: the other person BLOCKED the sender — refused, and no poll row", async () => {
    const c = use(store(B_BLOCKED_A));
    const r = await startPoll(DM);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(rows(c, DM).length, 0, "a blocked sender's poll reached the thread");
  });

  it("P2. THE POINT: the messaging stop is engaged — refused, and no poll row", async () => {
    const c = use(store(STOP_ENGAGED));
    const r = await startPoll(DM);
    assert.equal(r.body.error, "feature_disabled", JSON.stringify(r.body));
    assert.equal(rows(c, DM).length, 0);
  });

  it("P3. the E2EE refusal still holds (its own check, before the guard)", async () => {
    const c = use(store({ telegraph_chat_suggestions: [{ id: SUGG, user_id: A, thread_id: DM_E2EE, title: "Dinner", status: "shown" }] }));
    const r = await startPoll(DM_E2EE);
    assert.equal(r.body.error, "e2ee_thread", JSON.stringify(r.body));
    assert.equal(rows(c, DM_E2EE).length, 0);
  });
});

/**
 * census-telegraph §43 (verifier finding 8, 2026-10-05): the BURST LIMIT on
 * both doors, by behaviour. Wave 1 asserted the guard's call by its text only,
 * so the mutation `if (!guard.ok && guard.code !== "rate_limited")` — every
 * gate but the burst limit — survived this file (11/11) and
 * telegraphMessageDoors (20/20). Here the sender really sends until refused.
 *
 * The bucket is ONE per sender for every ordinary door (lib/telegraphThreadWrite.ts
 * "ONE BUCKET, NOT ONE PER DOOR"), so the poll door is shown refused by a burst
 * spent through the gem-share door — a limit per door would be the same defect
 * with a limit on it.
 */
const MOST_GENEROUS_TIER = 160; // SEND_LIMITS.trusted: no sender gets more than this per window

describe("§43 the burst limit holds at both doors", () => {
  it("R1. THE POINT: sharing gems until refused — a 429 with Retry-After arrives within the most generous tier, and the refused send writes nothing", async () => {
    const c = use(store());
    let refused: Awaited<ReturnType<typeof shareGem>> | null = null; let admitted = 0;
    for (let i = 0; i <= MOST_GENEROUS_TIER && !refused; i += 1) {
      const r = await shareGem(DM);
      if (r.status === 429) refused = r; else { assert.equal(r.status, 200, JSON.stringify(r.body)); admitted += 1; }
    }
    assert.ok(refused, `no refusal after ${admitted} gem shares — the burst limit is not enforced at this door`);
    assert.equal(refused!.body.error, "rate_limited");
    assert.ok(admitted >= 20, "vacuity guard: the strictest tier still admits twenty");
    assert.equal(rows(c, DM).length, admitted, "the refused share wrote a card anyway");
  });

  it("R2. THE POINT: a burst spent at the gem door refuses the POLL door too — 429, no poll row, the suggestion untouched", async () => {
    const c = use(store());
    let spent = false;
    for (let i = 0; i <= MOST_GENEROUS_TIER && !spent; i += 1) spent = (await shareGem(DM)).status === 429;
    assert.ok(spent, "vacuity guard: the bucket was spent");
    const before = rows(c, DM).length;
    const r = await startPoll(DM);
    assert.equal(r.status, 429, JSON.stringify(r.body));
    assert.equal(r.body.error, "rate_limited");
    assert.equal(rows(c, DM).length, before, "a poll card reached the thread past the burst limit");
    const s = (c._store.telegraph_chat_suggestions ?? []).find((x: Record<string, unknown>) => x.id === SUGG) as Record<string, unknown>;
    assert.equal(s.status, "shown", "a refused poll must not consume the suggestion");
  });

  it("R3. the Retry-After header is set on the refusal, so a client waits instead of bursting again", async () => {
    use(store());
    const res = { status: 0, retry: null as string | null };
    for (let i = 0; i <= MOST_GENEROUS_TIER && res.status !== 429; i += 1) {
      const r = await fetch(`${harness.base}/hidden-gems/${GEM}/share-telegraph`, { method: "POST", headers: { authorization: `Bearer ${A}`, "content-type": "application/json" }, body: JSON.stringify({ threadId: DM }) });
      res.status = r.status; res.retry = r.headers.get("retry-after"); await r.text();
    }
    assert.equal(res.status, 429);
    assert.ok(Number(res.retry) >= 1, `Retry-After was ${res.retry}`);
  });
});
