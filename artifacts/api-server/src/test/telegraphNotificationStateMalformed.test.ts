import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  readThreadNotificationStates,
  THREAD_NOTIFICATION_POLICY_FLAG,
} from "../services/telegraph/threadNotificationState.js";
import { decideThreadNotification } from "../domain/telegraph/policies/threadNotificationPolicy.js";
import { makeFakeClient } from "./telegraphCertificationHarness.js";

const MEMBER = "71000000-0000-4000-8000-000000000002";
const THREAD = "71000000-0000-4000-8000-0000000000d1";

function clientFor(data: unknown, levelsOn = false, rejects = false): SupabaseClient {
  const client = makeFakeClient({
    feature_flags: [{ flag: THREAD_NOTIFICATION_POLICY_FLAG, enabled: levelsOn }],
  });
  const originalFrom = client.from.bind(client);
  client.from = ((table: string) => {
    if (table !== "message_thread_members") return originalFrom(table);
    const query = {
      select: () => query,
      eq: () => query,
      in: () => query,
      is: () => rejects ? Promise.reject(new Error("read unavailable")) : Promise.resolve({ data, error: null }),
    };
    return query;
  }) as typeof client.from;
  return client as unknown as SupabaseClient;
}

describe("Telegraph notification state distinguishes absent from unreadable", () => {
  for (const [label, data] of [
    ["null response", null],
    ["missing response", undefined],
    ["object instead of rows", {}],
    ["null row", [null]],
    ["missing member id", [{ muted_at: null }]],
    ["missing mute state", [{ user_id: MEMBER }]],
    ["non-string mute state", [{ user_id: MEMBER, muted_at: false }]],
    ["unexpected member", [{ user_id: "other-member", muted_at: null }]],
    ["duplicate member", [{ user_id: MEMBER, muted_at: null }, { user_id: MEMBER, muted_at: "2026-10-01T00:00:00Z" }]],
  ] as const) {
    it(`refuses ${label} rather than assuming nobody muted`, async () => {
      assert.deepEqual(await readThreadNotificationStates(clientFor(data), THREAD, [MEMBER]), { ok: false });
    });
  }

  for (const row of [
    { notification_level: null, muted_until: null },
    { notification_level: "unrecognized", muted_until: null },
    { notification_level: "all" },
    { notification_level: "all", muted_until: 123 },
  ]) {
    it(`refuses malformed enabled-policy fields ${JSON.stringify(row)}`, async () => {
      const data = [{ user_id: MEMBER, muted_at: null, ...row }];
      assert.deepEqual(await readThreadNotificationStates(clientFor(data, true), THREAD, [MEMBER]), { ok: false });
    });
  }

  it("turns a rejected membership read into unavailable state", async () => {
    assert.deepEqual(await readThreadNotificationStates(clientFor([], false, true), THREAD, [MEMBER]), { ok: false });
  });

  it("accepts a genuinely empty array as no active membership", async () => {
    const result = await readThreadNotificationStates(clientFor([]), THREAD, [MEMBER]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.states.size, 0);
  });

  it("keeps legacy muted and unmuted choices when the flag is off", async () => {
    for (const mutedAt of [null, "2026-10-01T00:00:00Z"]) {
      const result = await readThreadNotificationStates(clientFor([{ user_id: MEMBER, muted_at: mutedAt }]), THREAD, [MEMBER]);
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.equal(decideThreadNotification({ cause: "MENTION", state: result.states.get(MEMBER)!, nowMs: Date.now() }).deliver, mutedAt === null);
    }
  });

  it("keeps an unreadable timestamp suppressed rather than discarding the mute", async () => {
    const data = [{ user_id: MEMBER, muted_at: null, notification_level: "all", muted_until: "unreadable" }];
    const result = await readThreadNotificationStates(clientFor(data, true), THREAD, [MEMBER]);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(decideThreadNotification({ cause: "MENTION", state: result.states.get(MEMBER)!, nowMs: Date.now() }).deliver, false);
  });
});
