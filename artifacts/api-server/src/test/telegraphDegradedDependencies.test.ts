/**
 * census-telegraph T376 (lane TELEGRAPH batch 4) — §30 "degraded dependencies do not break text/safety".
 *
 * T376's last remainder: the outbox / idempotency / reconnect / backpressure halves are proved, and
 * "the 'degraded dependencies do not break text/safety' half is unchanged". This pins it at the doors a
 * traveller uses — the text door (POST /threads/:id/messages) and the safety doors (a §6.2 SAFETY
 * typed message, and §9.1's NEED_HELP quick status) — with each NON-ESSENTIAL dependency failing in
 * turn, every read and write of it answering an error:
 *
 *   push / notices     notifications, their delivery attempts and both preference tables
 *   privacy settings   profile_privacy_settings (how a notice names the sender)
 *   report history     reports (the recipient's scam signals, text door)
 * and, structurally, the dependencies no door waits for: translation (fire-and-forget at every send
 * door), the outbox drainer (the one publisher nudges it and returns) and realtime.
 *
 * Each case asserts the send is ACCEPTED and the message is STORED — the person's words and their call
 * for help are never lost to a feature around them. The essential dependencies (membership, blocks,
 * trust restrictions) are deliberately NOT in this list: those fail CLOSED, by rule (T344 and the
 * block-guard suites), and a send refused because a block could not be read is the guard working.
 *
 * MUTANT (tgprod/mutants-b4.txt): DD1 the text door awaits translation and fails with it → red.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/telegraphDegradedDependencies.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _clearSendTierCache } from "../domain/telegraph/policies/sendRateLimit.js";
import messagingRouter from "../routes/messaging.js";
import telegraphKindsRouter from "../routes/telegraphKinds.js";
import telegraphCoordinationRouter from "../routes/telegraphCoordination.js";
import { call, makeFakeClient, startRouter, type FakeClient, type RouterHarness } from "./telegraphCertificationHarness.js";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const DM = "00000000-0000-4000-8000-0000000000d1";

const member = (thread: string, user: string) => ({
  thread_id: thread, user_id: user, role: "member", joined_at: "2026-01-01T00:00:00.000Z", left_at: null,
  last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
});

function seed(): Record<string, any[]> {
  return {
    feature_flags: [
      { flag: "telegraph_message_kernel_enabled", enabled: true },
      { flag: "telegraph_outbox_fanout_enabled", enabled: true },
      { flag: "telegraph_link_previews_enabled", enabled: true },
      { flag: "telegraph_structured_schemas_enabled", enabled: true },
    ],
    blocks: [], trust_profiles: [], trust_restrictions: [], user_account_states: [], user_message_settings: [], message_requests: [],
    profiles: [A, B].map((id, i) => ({ id, handle: `u${i}`, name: `U${i}`, preferred_language: i === 0 ? "en" : "vi", avatar_url: null, show_name_publicly: true })),
    message_threads: [{ id: DM, thread_type: "direct", trip_id: null, circle_owner_id: null, title: null, status: "active", is_e2ee: false,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", last_message_at: null }],
    message_thread_members: [member(DM, A), member(DM, B)],
    messages: [], message_translations: [], message_link_previews: [], notifications: [], push_tokens: [], telegraph_outbox: [], telegraph_events: [],
  };
}

/**
 * The non-essential dependencies each door ACTUALLY consults (measured on this tree: the fake records every
 * table a request reads or writes, and each case below asserts its dependency was consulted, so no case
 * passes because the door never touched what was broken).
 */
const DEGRADED: Array<{ name: string; tables: string[]; doors: Array<"text" | "safety" | "needHelp"> }> = [
  { name: "push and in-app notifications", tables: ["notifications", "notification_delivery_attempts", "notification_preferences", "notification_category_preferences"], doors: ["text", "safety", "needHelp"] },
  { name: "notification privacy settings", tables: ["profile_privacy_settings"], doors: ["text", "safety", "needHelp"] },
  { name: "report history (the recipient's scam signals)", tables: ["reports"], doors: ["text"] },
];

let harness: RouterHarness;
before(async () => {
  const all = express.Router();
  all.use(telegraphKindsRouter);
  all.use(telegraphCoordinationRouter);
  all.use(messagingRouter);
  harness = await startRouter(all);
});
after(async () => { _setTestClient(null, false); await harness.close(); });

function use(tables: string[]): FakeClient {
  _resetRateLimit();
  _clearSendTierCache();
  const errors: Record<string, { code: string; message: string }> = {};
  for (const t of tables) errors[t] = { code: "57014", message: `canceling statement due to statement timeout (${t})` };
  const c = makeFakeClient(seed(), { errors, columnDefaults: { message_threads: { status: "active", is_e2ee: false } } });
  _setTestClient(c, true);
  return c;
}
const stored = (c: FakeClient) => (c._store.messages ?? []).filter((m: any) => m.thread_id === DM);

describe("T376 — with a non-essential dependency down, text and safety still go through", () => {
  const consulted = (c: FakeClient, tables: string[]) =>
    tables.some((t) => c._observed.selects.some((x) => x.table === t) || c._observed.inserts.some((x) => x.table === t)
      || c._observed.updates.some((x) => x.table === t) || c._observed.upserts.some((x) => x.table === t));
  const settle = () => new Promise((r) => setTimeout(r, 200)); // fire-and-forget work (notifications) runs after the answer
  const DOORS = {
    text: { path: "messages", body: { body: "I'm at the north gate" }, stored: (m: any) => m.body === "I'm at the north gate" },
    safety: { path: "typed-messages", body: { kind: "SAFETY", payload: { kind: "need_help", label: "I need help", approximateLabel: "near the station" } }, stored: (m: any) => m.msg_type === "safety" },
    needHelp: { path: "coordination", body: { kind: "COORDINATION", payload: { state: "NEED_HELP" } }, stored: (m: any) => m.msg_type === "coordination" },
  } as const;
  for (const dep of DEGRADED) {
    for (const door of dep.doors) {
      it(`${dep.name} down: the ${door} door is accepted and stored (and did consult it)`, async () => {
        const c = use(dep.tables);
        const d = DOORS[door];
        const r = await call(harness.base, "POST", `/threads/${DM}/${d.path}`, A, d.body);
        await settle();
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.ok(stored(c).some(d.stored), "the message is in the store");
        assert.ok(consulted(c, dep.tables), `the ${door} door never touched ${dep.tables.join("/")}: this case would be vacuous`);
      });
    }
  }

  it("translation, the drainer and realtime are never awaited by the doors (structural)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../routes/messaging.ts"), "utf8");
    // Translation is fire-and-forget at every send door: started, never awaited.
    assert.equal((src.match(/await translateMessageForThread\(/g) ?? []).length, 0);
    assert.ok((src.match(/\n\s*translateMessageForThread\(sc, \{/g) ?? []).length >= 2);
    // The one publisher nudges the drainer and returns; it never waits for a drain pass.
    const drain = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../lib/telegraphOutboxDrainScheduler.ts"), "utf8");
    assert.match(drain, /if \(await outboxFanoutInForce\(sc\)\) \{\n\s*requestTelegraphOutboxDrain\(\);\n\s*return "outbox";/);
  });

  it("control: an ESSENTIAL dependency down (the block list) refuses — fail-closed by rule, not a degraded feature", async () => {
    const c = use(["blocks"]);
    const r = await call(harness.base, "POST", `/threads/${DM}/messages`, A, { body: "hello" });
    assert.notEqual(r.status, 201, "a send whose block state cannot be read is refused");
    assert.equal(stored(c).length, 0);
  });
});
