/**
 * Three files whose NAMES are a promise, all of which used to break it under a
 * database failure.
 *
 * node:test + node:assert (NOT vitest). Judge by EXIT CODE.
 *
 * supabase-js RESOLVES on a database error rather than throwing, so every read
 * below returned `data: null` (or `[]`) in two different situations, and the
 * empty reading was the PERMISSIVE one:
 *
 *   lib/messagingPermissions.ts    an unreadable `blocks` table meant nobody was
 *                                  blocked, so a blocked sender could message.
 *                                  An unreadable `user_message_settings` fell
 *                                  back to DEFAULT_SETTINGS, whose
 *                                  message_privacy is 'everyone' -- so a
 *                                  recipient who had RESTRICTED their DMs became
 *                                  messageable by anyone.
 *   NotificationPrivacyGuard.ts    an unreadable ghost-mode preference meant
 *                                  "not ghost", so a location-bearing
 *                                  notification went out about a user who had
 *                                  hidden their location.
 *   lib/circleAccessGuard.ts       in the BATCH path, unreadable `blocks` and
 *                                  `user_account_states` meant nobody was
 *                                  blocked or banned, and an unreadable
 *                                  per-context row meant a trip or event the
 *                                  target had PAUSED was shown anyway.
 *
 * Each is now unknown-is-not-permission. A suppressed notification and a
 * refused message are recoverable; a leaked location and a delivered message
 * from a blocked sender are not.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/authorizationGuardsFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canMessage } from "../lib/messagingPermissions.js";
import { canBeSeenByViewersBatch } from "../lib/circleAccessGuard.js";
import { NotificationPrivacyGuard } from "../services/notifications/NotificationPrivacyGuard.js";

const DB_ERROR = { message: "connection reset by peer", code: "08006" };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** `errorTables` resolve with an error, exactly as PostgREST failures surface. */
function db(opts: { errorTables?: string[]; rows?: Record<string, any[]> } = {}) {
  const failing = new Set(opts.errorTables ?? []);
  const rows = opts.rows ?? {};
  function builder(table: string) {
    const isErr = failing.has(table);
    const settle = (single: boolean) =>
      isErr
        ? Promise.resolve({ data: null, error: DB_ERROR, count: null })
        : Promise.resolve(
            single
              ? { data: (rows[table] ?? [])[0] ?? null, error: null }
              : { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length },
          );
    const b: any = {
      select: () => b, eq: () => b, in: () => b, or: () => b, is: () => b,
      neq: () => b, gte: () => b, lte: () => b, order: () => b, limit: () => b,
      maybeSingle: () => settle(true),
      single: () => settle(true),
      then: (r: any) => settle(false).then(r),
    };
    return b;
  }
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

describe("messaging permissions: unknown is not permission", () => {
  it("an unreadable blocks table denies rather than assuming nobody is blocked", async () => {
    const v = await canMessage(db({ errorTables: ["blocks"] }), A, B);
    assert.equal(v.allowed, false, "a failed blocks read must not let the message through");
    assert.equal(v.reason, "unavailable", "and must not claim 'blocked', which would be a fabrication");
  });

  it("an unreadable user_message_settings does NOT fall back to message_privacy=everyone", async () => {
    const v = await canMessage(db({ errorTables: ["user_message_settings"] }), A, B);
    assert.equal(v.allowed, false, "a recipient who restricted DMs must not become messageable by a read failure");
    assert.equal(v.reason, "unavailable");
  });

  it("a healthy database with no block and no settings row still uses the real default", async () => {
    // The DEFAULT is safe for someone who never set a preference. That is the
    // case this must keep working -- the fix must not become a blanket denial.
    const v = await canMessage(db({ rows: {} }), A, B);
    assert.notEqual(v.reason, "unavailable", "no read failed, so the verdict must be a real one");
  });
});

describe("notification privacy guard suppresses when it cannot tell", () => {
  it("an unreadable ghost-mode preference blocks a location notification", async () => {
    const guard = new NotificationPrivacyGuard(db({ errorTables: ["location_preferences"] }));
    const out = await guard.sanitise("Near you", "Someone is nearby", {
      recipientId: B, senderId: A, category: "location",
    } as any);
    assert.equal(out.blocked, true, "unknown ghost state must suppress, not deliver");
    assert.equal(out.blockReason, "ghost_mode");
  });

  it("a readable preference that is not ghost still delivers", async () => {
    const guard = new NotificationPrivacyGuard(db({ rows: { location_preferences: [{ location_mode: "precise" }] } }));
    const out = await guard.sanitise("Near you", "Someone is nearby", {
      recipientId: B, senderId: A, category: "location",
    } as any);
    assert.equal(out.blocked, false, "the guard must not become a blanket suppressor");
  });
});

describe("circle access batch fails closed for every viewer", () => {
  const VIEWERS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

  it("an unreadable blocks table denies every viewer", async () => {
    const out = await canBeSeenByViewersBatch(
      db({
        errorTables: ["blocks"],
        rows: {
          trip_members: VIEWERS.concat([A]).map((id) => ({ user_id: id, role: "member" })),
          circle_visibility_settings: [{ global_enabled: true, consented_at: "2026-01-01", consent_version: "v1", is_paused: false }],
        },
      }),
      A, VIEWERS, "trip", "trip-1",
    );
    for (const v of VIEWERS) {
      assert.equal(out.get(v)?.allowed, false, `viewer ${v} must be denied when exclusions are unknown`);
    }
  });

  it("an unreadable per-context row denies rather than falling back to the global default", async () => {
    const out = await canBeSeenByViewersBatch(
      db({
        errorTables: ["circle_context_settings"],
        rows: {
          trip_members: VIEWERS.concat([A]).map((id) => ({ user_id: id, role: "member" })),
          circle_visibility_settings: [{ global_enabled: true, consented_at: "2026-01-01", consent_version: "v1", is_paused: false }],
        },
      }),
      A, VIEWERS, "trip", "trip-1",
    );
    for (const v of VIEWERS) {
      assert.equal(
        out.get(v)?.allowed, false,
        "a context the target may have PAUSED must not be shown because its row was unreadable",
      );
    }
  });
});

describe("the fixes are in the source, not only in these expectations", () => {
  it("each guard binds and consults its read error", async () => {
    const { readFileSync } = await import("node:fs");
    const mp = readFileSync(new URL("../lib/messagingPermissions.ts", import.meta.url), "utf8");
    assert.match(mp, /error: blockError/, "canMessage must bind the blocks error");
    assert.match(mp, /settingsRes as any\)\.error/, "canMessage must consult the settings error");
    const cg = readFileSync(new URL("../lib/circleAccessGuard.ts", import.meta.url), "utf8");
    assert.match(cg, /failedTargetReads/, "the batch path must check its five target-side reads");
    const ng = readFileSync(new URL("../services/notifications/NotificationPrivacyGuard.ts", import.meta.url), "utf8");
    assert.match(ng, /treating as GHOST and suppressing/, "ghost-mode must suppress on an unreadable preference");
  });
});
