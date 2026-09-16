import test from "node:test";
import assert from "node:assert/strict";
import { runPresenceCleanup } from "../lib/intelRetentionScheduler.js";

function client(rows: any[], enabled = true, failures: Record<string, any> = {}) {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        order: () => chain,
        range: async () => failures.read ?? { data: rows, error: null },
        eq: (column: string, value: any) => {
          if (table === "feature_flags") return { maybeSingle: async () => ({ data: { enabled }, error: null }) };
          return chain;
        },
        limit: async () => failures.read ?? { data: rows, error: null },
        update: (value: any) => ({ in: async () => failures.update ?? { error: null, value } }),
        delete: () => ({ in: async () => failures.delete ?? { error: null } }),
      };
      return chain;
    },
  };
}

test("presence cleanup marks stale and erases expired rows", async () => {
  const now = new Date("2026-08-31T12:00:00Z");
  const result = await runPresenceCleanup({
    client: client([
      { id: "stale", last_seen_at: "2026-08-31T11:00:00Z", stale_after_secs: 60, expires_at: null },
      { id: "expired", last_seen_at: "2026-08-31T11:59:59Z", stale_after_secs: 3600, expires_at: "2026-08-31T11:00:00Z" },
    ]),
    now,
  });
  assert.deepEqual(result, { markedStale: 1, deleted: 1, skipped: false, reason: null });
});

test("presence cleanup is explicitly inert when its rollout flag is off", async () => {
  const result = await runPresenceCleanup({ client: client([], false) });
  assert.deepEqual(result, { markedStale: 0, deleted: 0, skipped: true, reason: "disabled" });
});

test("presence cleanup reports scheduler storage failures", async () => {
  const result = await runPresenceCleanup({
    client: client([], true, { read: { data: null, error: { message: "down" } } }),
  });
  assert.deepEqual(result, { markedStale: 0, deleted: 0, skipped: true, reason: "error" });
});