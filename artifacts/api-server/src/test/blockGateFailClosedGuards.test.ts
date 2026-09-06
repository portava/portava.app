/**
 * Block-state reads must fail CLOSED in the non-route guards.
 *
 * Each guard below resolved an unreadable `blocks` (or post-block cooldown) read
 * into the SAME value as "there is no block", because supabase-js RESOLVES with
 * `{ data: null, error }` on a PostgREST failure rather than throwing:
 *
 *   lib/circleAccessGuard.ts   `blocksRes.data ?? []`  → a blocked viewer was
 *                              served live circle presence (status, venue label,
 *                              approximate location) by BOTH batch paths, while
 *                              the single-shot canViewCirclePresence — which
 *                              already uses the fail-closed isBlockedBetween —
 *                              denied the very same pair. The two guards
 *                              disagreed about one relationship.
 *   compass/CompassNotificationEngine.ts  logged "push is being delivered
 *                              WITHOUT block suppression" and then DELIVERED it.
 *   services/interactionPermissions.ts  `isActiveCooldown` returned false on any
 *                              read error, so the 90-day cooldown written when
 *                              one user BLOCKS another evaporated during a blip
 *                              and re-opened follow / friend-request / messaging.
 *
 * Every test pairs the error case with a clean-read negative control, so a guard
 * that simply denies everything would not pass this file.
 *
 * Run: node --import tsx/esm --test src/test/blockGateFailClosedGuards.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canBeSeenByViewersBatch,
  canViewCirclePresenceBatch,
  CURRENT_CONSENT_VERSION,
} from "../lib/circleAccessGuard.js";
import { evaluateNotification } from "../compass/CompassNotificationEngine.js";
import { resolveInteractionPermissions } from "../services/interactionPermissions.js";
import { executeCompassTool } from "../compass/CompassTools.js";

const TARGET = "cag-target-1";
const VIEWER = "cag-viewer-1";
const TRIP = "cag-trip-1";

const BLOCKS_ERROR = { code: "57014", message: "simulated blocks read failure" };

/**
 * Fake client for circleAccessGuard: every table answers "clean and permissive"
 * so the ONLY thing under test is what the guard does with the blocks read.
 */
function makeCircleClient(opts: { blocksError: boolean }) {
  function chain(table: string) {
    const obj: any = {
      _single: false,
      select() { return obj; },
      eq() { return obj; },
      in() { return obj; },
      or() { return obj; },
      limit() { return obj; },
      order() { return obj; },
      maybeSingle() { obj._single = true; return obj; },
      single() { obj._single = true; return obj; },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };
    async function resolve(): Promise<any> {
      if (table === "blocks") {
        return opts.blocksError
          ? { data: null, error: BLOCKS_ERROR }
          : { data: [], error: null };
      }
      if (table === "feature_flags") {
        // find_your_circle_disabled — absent row = not engaged.
        return { data: null, error: null };
      }
      if (table === "trip_members") {
        const row = { user_id: obj._single ? VIEWER : undefined, role: "member", status: "accepted" };
        return obj._single
          ? { data: { user_id: VIEWER, role: "member", status: "accepted" }, error: null }
          : { data: [
              { user_id: VIEWER, role: "member", status: "accepted" },
              { user_id: TARGET, role: "member", status: "accepted" },
            ], error: null, _row: row };
      }
      if (table === "circle_visibility_settings") {
        const s = {
          user_id: TARGET, global_enabled: true, visibility_mode: "status_only",
          trip_sharing_default: null, event_sharing_default: null, is_paused: false,
          consent_version: CURRENT_CONSENT_VERSION, consented_at: "2026-01-01T00:00:00.000Z",
        };
        return obj._single ? { data: s, error: null } : { data: [s], error: null };
      }
      if (table === "circle_presence") {
        const p = {
          user_id: TARGET, id: "pres-1", status: "here", status_label: "At the bar",
          approximate_label: "Sukhumvit", venue_label: "The Bar", checked_in: true,
          last_seen_at: new Date().toISOString(), expires_at: null,
          stale_after_secs: 3600, is_stale: false, needs_help: false,
          updated_at: new Date().toISOString(),
        };
        return obj._single ? { data: p, error: null } : { data: [p], error: null };
      }
      // circle_context_settings, user_account_states, event_* — empty/benign.
      return obj._single ? { data: null, error: null } : { data: [], error: null };
    }
    return obj;
  }
  return { from: (t: string) => chain(t) };
}

// ── circleAccessGuard — MANY viewers, ONE target ─────────────────────────────

describe("canBeSeenByViewersBatch — blocks read fails closed", () => {
  it("denies the viewer with reason 'blocked' when the blocks read ERRORS", async () => {
    const sc = makeCircleClient({ blocksError: true });
    const out = await canBeSeenByViewersBatch(sc as any, TARGET, [VIEWER], "trip", TRIP);
    const r = out.get(VIEWER);
    assert.ok(r, "the viewer must be evaluated");
    assert.equal(r!.allowed, false, "unknown block state must not expose presence");
    assert.equal((r as any).reason, "blocked",
      "must give the SAME reason the single-shot guard gives via isBlockedBetween");
  });

  it("NEGATIVE CONTROL: allows the viewer when the blocks read is clean", async () => {
    const sc = makeCircleClient({ blocksError: false });
    const out = await canBeSeenByViewersBatch(sc as any, TARGET, [VIEWER], "trip", TRIP);
    const r = out.get(VIEWER);
    assert.ok(r, "the viewer must be evaluated");
    assert.equal(r!.allowed, true,
      `fixture must be permissive on a clean read, got ${JSON.stringify(r)}`);
  });
});

// ── circleAccessGuard — ONE viewer, MANY targets ─────────────────────────────

describe("canViewCirclePresenceBatch — blocks read fails closed", () => {
  it("denies the target with reason 'blocked' when the blocks read ERRORS", async () => {
    const sc = makeCircleClient({ blocksError: true });
    const out = await canViewCirclePresenceBatch(sc as any, VIEWER, [TARGET], "trip", TRIP);
    const r = out.get(TARGET);
    assert.ok(r, "the target must be evaluated");
    assert.equal(r!.allowed, false);
    assert.equal((r as any).reason, "blocked");
  });

  it("NEGATIVE CONTROL: allows the target when the blocks read is clean", async () => {
    const sc = makeCircleClient({ blocksError: false });
    const out = await canViewCirclePresenceBatch(sc as any, VIEWER, [TARGET], "trip", TRIP);
    const r = out.get(TARGET);
    assert.ok(r, "the target must be evaluated");
    assert.equal(r!.allowed, true, `fixture must be permissive on a clean read, got ${JSON.stringify(r)}`);
  });
});

// ── Compass push notifications ───────────────────────────────────────────────

function makeNotifClient(opts: { blocksError: boolean }) {
  function chain(table: string) {
    const obj: any = {
      select() { return obj; },
      eq() { return obj; },
      or() { return obj; },
      in() { return obj; },
      limit() { return obj; },
      insert() { return obj; },
      maybeSingle() { return resolve(); },
      single() { return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };
    async function resolve(): Promise<any> {
      if (table === "blocks") {
        return opts.blocksError
          ? { data: null, error: BLOCKS_ERROR }
          : { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return obj;
  }
  return { from: (t: string) => chain(t) };
}

describe("evaluateNotification — blocked-sender check fails closed", () => {
  const payload = {
    type: "social" as const,
    title: "New message",
    body: "Someone messaged you",
    data: { senderId: "notif-sender-1" },
  };

  it("SUPPRESSES the push when the blocks read ERRORS", async () => {
    const db = makeNotifClient({ blocksError: true });
    const d = await evaluateNotification(db as any, "notif-recipient-1", payload as any, { nowMinutes: 12 * 60 });
    assert.equal(d.outcome, "suppressed_blocked_sender",
      "an unverifiable sender must not reach the recipient by push");
  });

  it("NEGATIVE CONTROL: sends the push when the blocks read is clean", async () => {
    const db = makeNotifClient({ blocksError: false });
    const d = await evaluateNotification(db as any, "notif-recipient-1", payload as any, { nowMinutes: 12 * 60 });
    assert.notEqual(d.outcome, "suppressed_blocked_sender",
      `a clean read must not suppress as blocked-sender, got ${d.outcome}`);
  });
});

// ── Post-block interaction cooldowns ─────────────────────────────────────────

/**
 * `user_interaction_cooldowns` rows are written when one user BLOCKS another
 * (the follow cooldown is 90 days). An unreadable table must not read as "the
 * cooldown expired". A missing TABLE is a different thing — a deployment shape,
 * documented as optional — and must still read as "no cooldown".
 */
function makePermClient(opts: { cooldownError: null | { code: string; message: string } }) {
  function chain(table: string) {
    const obj: any = {
      select() { return obj; },
      eq() { return obj; },
      or() { return obj; },
      in() { return obj; },
      is() { return obj; },
      not() { return obj; },
      neq() { return obj; },
      gt() { return obj; }, gte() { return obj; }, lt() { return obj; }, lte() { return obj; },
      order() { return obj; },
      limit() { return obj; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };
    async function resolve(single: boolean): Promise<any> {
      if (table === "user_interaction_cooldowns" && opts.cooldownError) {
        return { data: null, error: opts.cooldownError };
      }
      if (table === "profiles") {
        return {
          data: single
            ? { id: "perm-target-1", is_private: false, tag_permission: "anyone", account_status: "active" }
            : [],
          error: null,
        };
      }
      return { data: single ? null : [], error: null };
    }
    return obj;
  }
  return { from: (t: string) => chain(t) };
}

describe("resolveInteractionPermissions — post-block cooldown fails closed", () => {
  it("keeps the follow cooldown ACTIVE when the cooldown read ERRORS", async () => {
    const sc = makePermClient({ cooldownError: { code: "57014", message: "simulated read failure" } });
    const p = await resolveInteractionPermissions(sc as any, "perm-viewer-1", "perm-target-1");
    assert.equal(p.canFollow, false,
      "an unreadable cooldown table must not re-open follows after a block");
  });

  it("treats a MISSING TABLE as no cooldown (undefined table is not an outage)", async () => {
    const sc = makePermClient({ cooldownError: { code: "42P01", message: 'relation "user_interaction_cooldowns" does not exist' } });
    const p = await resolveInteractionPermissions(sc as any, "perm-viewer-1", "perm-target-1");
    assert.equal(p.canFollow, true,
      "the optional Phase 2 table being absent must not lock every follow");
  });

  it("NEGATIVE CONTROL: allows the follow when the cooldown read is clean and empty", async () => {
    const sc = makePermClient({ cooldownError: null });
    const p = await resolveInteractionPermissions(sc as any, "perm-viewer-1", "perm-target-1");
    assert.equal(p.canFollow, true);
  });
});

// ── Compass group recommendation ─────────────────────────────────────────────

/**
 * `groupBlockUnion` discarded BOTH `error` values and its catch never fired
 * (supabase-js resolves on a PostgREST error), so an unreadable blocks table
 * returned `[]` — the same value as "this group has blocked nobody" — and the
 * group recommendation excluded nobody. It now returns null and the tool
 * recommends nothing.
 */
function makeToolsClient(opts: { blocksError: boolean }) {
  const TRIP_ROW = {
    id: "ct-trip-1", title: "Bangkok run", destination_city: "Bangkok",
    destination_country: "Thailand", start_date: "2026-01-01", end_date: "2026-01-10",
    status: "active",
  };
  function chain(table: string) {
    const obj: any = {
      _single: false,
      select() { return obj; },
      eq() { return obj; },
      in() { return obj; },
      or() { return obj; },
      is() { return obj; }, not() { return obj; }, neq() { return obj; },
      gt() { return obj; }, gte() { return obj; }, lt() { return obj; }, lte() { return obj; },
      ilike() { return obj; }, contains() { return obj; },
      order() { return obj; }, limit() { return obj; },
      maybeSingle() { obj._single = true; return resolve(); },
      single() { obj._single = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };
    async function resolve(): Promise<any> {
      if (table === "blocks") {
        return opts.blocksError
          ? { data: null, error: BLOCKS_ERROR }
          : { data: [], error: null };
      }
      if (table === "trip_members") {
        return {
          data: [
            { trip_id: TRIP_ROW.id, user_id: "ct-user-1", role: "owner", status: "accepted" },
            { trip_id: TRIP_ROW.id, user_id: "ct-user-2", role: "member", status: "accepted" },
          ],
          error: null,
        };
      }
      if (table === "trips") {
        return obj._single ? { data: TRIP_ROW, error: null } : { data: [TRIP_ROW], error: null };
      }
      if (table === "profiles") {
        const p = (id: string) => ({
          id, travel_styles: ["food"], travel_pace: "balanced", budget_style: "mid",
          travel_group_style: "small", looking_for: ["food"], comfort_level: "moderate",
          planning_style: "flexible", current_city: "Bangkok",
        });
        return obj._single ? { data: p("ct-user-1"), error: null } : { data: [p("ct-user-1"), p("ct-user-2")], error: null };
      }
      return obj._single ? { data: null, error: null } : { data: [], error: null };
    }
    return obj;
  }
  return { from: (t: string) => chain(t) };
}

describe("executeCompassTool get_group_recommendation — group block union fails closed", () => {
  it("recommends NOTHING when the group block-union read ERRORS", async () => {
    const sc = makeToolsClient({ blocksError: true });
    const out: any = await executeCompassTool(sc as any, "ct-user-1", null, "get_group_recommendation", {});
    assert.deepEqual(out?.candidates, [],
      "an unreadable block union must not produce a group recommendation");
    assert.match(String(out?.info ?? ""), /block state is unavailable/i,
      `the tool must say why, got ${JSON.stringify(out)}`);
  });

  it("NEGATIVE CONTROL: does not report a block-state failure on a clean read", async () => {
    const sc = makeToolsClient({ blocksError: false });
    const out: any = await executeCompassTool(sc as any, "ct-user-1", null, "get_group_recommendation", {});
    assert.doesNotMatch(String(out?.info ?? ""), /block state is unavailable/i,
      `a clean read must not report a block-state failure, got ${JSON.stringify(out)}`);
  });
});

// ── telegraph mention suggestions (source guard) ─────────────────────────────

/**
 * The telegraph block filter sits inside POST /telegraph/recommend, downstream
 * of a live OpenAI completion, so there is no way to drive it from a test
 * without stubbing the model. This is therefore a SOURCE guard, in the same
 * spirit as test/discoveryBlockedSubmitter.test.ts: it pins the fail-closed
 * shape so the branch cannot silently revert to "log and continue".
 *
 * The bug: `blockErr` was bound and logged, then the loop over `blockRows` ran
 * anyway — leaving blockedSet empty on error, exactly as when nobody is blocked,
 * so every candidate handle stayed mentionable.
 */
describe("routes/telegraph.ts — mention block filter fails closed (source guard)", () => {
  it("adds every candidate to blockedSet when the block read errors", async () => {
    const src = await readFile(
      new URL("../routes/telegraph.ts", import.meta.url),
      "utf8",
    );
    const idx = src.indexOf("telegraph: block-state read failed");
    assert.notEqual(idx, -1, "the block-read failure branch must still exist");
    const window = src.slice(idx, idx + 400);
    assert.match(
      window,
      /for \(const id of profileIds\) blockedSet\.add\(id\);/,
      "on a failed block read every candidate must be treated as blocked",
    );
    assert.match(window, /\}\s*else\s*\{/,
      "the success-path loop must be in an else branch, not run unconditionally");
  });
});
