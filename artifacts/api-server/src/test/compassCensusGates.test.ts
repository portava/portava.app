/**
 * compassCensusGates — the four BUILT-BUT-WRONG items closed by the Compass
 * census (docs/architecture/census-compass.md, 2026-09-07). Each block names
 * the obligation it pins and the defect it replaces.
 *
 *   A. get_travel_compatibility trust floor — an UNREADABLE trust_profiles no
 *      longer surfaces the person (supabase-js resolves on a DB error; the
 *      discarded `error` read as "no profile"). An ABSENT row is still
 *      admitted — that is the owner's call, unchanged.
 *   B. refreshHiddenUsers with NO snapshot — a failed blocks/mutes read no
 *      longer answers with an EMPTY hidden set (which un-hides every blocked
 *      user); the tool call fails closed instead. With a snapshot the
 *      snapshot is kept, as before.
 *   C. CompassNotificationEngine sender suspension — reads
 *      user_account_states (the table that can actually hold "suspended")
 *      instead of trust_profiles.public_level, whose CHECK forbids the value
 *      the old code compared against (a dead check, census-trust A17).
 *   D. CompassLiveConstraints — a Live `unsafe_density` crowd claim is a hard
 *      EXCLUSION for every viewer (Sensing spec :129 "a dangerous place must
 *      never simultaneously be promoted as 'best move now'"), not a demotion
 *      that fired only for a viewer who asked for somewhere quiet.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { executeCompassTool } from "../compass/CompassTools.js";
import { evaluateNotification, type NotificationPayload } from "../compass/CompassNotificationEngine.js";
import {
  evaluateLiveConstraints,
  LIVE_DEMOTE_PENALTY,
} from "../compass/CompassLiveConstraints.js";
import type { CompassProfile } from "../compass/types.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";

// Spelled as a literal on purpose: the module also exports UNSAFE_CROWD_LEVEL,
// but importing it would make a hand-revert of the fix fail at module load
// instead of at the assertions that name the behaviour.
const UNSAFE_CROWD_LEVEL = "unsafe_density";

// ── Fake Supabase client with per-table error injection ──────────────────────
//
// Same builder shape as compass-social.test.ts / compass-tools.test.ts, plus
// `errors`: a table listed there RESOLVES with `{ data: null, error }` — which
// is exactly what supabase-js does on a rejected query, and exactly the case
// the gates under test used to discard.

type Db = Record<string, any[]>;
type Errors = Record<string, { message: string; code?: string }>;

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const TRIP_ID  = "d4d4d4d4-dddd-dddd-dddd-000000000004";

function makeClient(db: Db, errors: Errors = {}) {
  function builder(table: string) {
    const rows = db[table] ?? [];
    const err = errors[table] ?? null;
    let filtered = [...rows];
    const likeFilter = (col: string, pat: string) => {
      const re = new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
      filtered = filtered.filter((r) => re.test(String(r[col] ?? "")));
    };
    const b: any = {
      select: () => b,
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      is:  (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      ilike: (col: string, pat: string) => { likeFilter(col, pat); return b; },
      like:  (col: string, pat: string) => { likeFilter(col, pat); return b; },
      or: () => b, not: () => b, order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve(err ? { data: null, error: err } : { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(err ? { data: null, error: err } : { data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } }),
      then: (resolve: any, reject?: any) =>
        Promise.resolve(err ? { data: null, error: err } : { data: filtered, error: null }).then(resolve, reject),
      insert: (payload: any) => { (db[table] ??= []).push(Array.isArray(payload) ? payload[0] : payload); return b; },
      upsert: (payload: any) => { (db[table] ??= []).push(Array.isArray(payload) ? payload[0] : payload); return b; },
      update: () => b,
      delete: () => b,
    };
    return b;
  }
  return {
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as any;
}

function profileFor(overrides: Partial<CompassProfile> = {}): CompassProfile {
  return {
    userId: ALICE_ID,
    blockedUserIds: [],
    blockerUserIds: [],
    mutedUserIds: [],
    ...overrides,
  } as unknown as CompassProfile;
}

/** Alice and Bob share an accepted trip, so sharesSocialContext is true. */
function socialDb(): Db {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    trips: [{ id: TRIP_ID, title: "Cebu Trip", destination_city: "Cebu", status: "active", owner_id: ALICE_ID, start_date: "2026-07-18", end_date: "2026-07-28" }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member", status: "accepted" },
    ],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice Real", interests: ["food", "diving"], travel_styles: ["backpacker"], budget_style: "budget", travel_pace: "balanced", spoken_languages: ["en"], verified: true, date_of_birth: "1996-01-15" },
      { id: BOB_ID,   handle: "bob",   name: "Bob Real",   interests: ["food", "hiking"], travel_styles: ["backpacker"], budget_style: "luxury", travel_pace: "balanced", spoken_languages: ["en", "fr"], verified: true, date_of_birth: "1994-05-02" },
    ],
    circle_memberships: [],
    blocks: [],
    user_mutes: [],
    user_account_states: [],
    profile_privacy_settings: [],
    trust_profiles: [],
    availability_windows: [],
  };
}

// ── A. Trust floor fails CLOSED on an unreadable trust_profiles ──────────────

describe("A. get_travel_compatibility trust floor — unreadable trust_profiles closes the gate", () => {
  it("baseline: with NO trust row the person is still surfaced (absent != unreadable; owner decision unchanged)", async () => {
    const result: any = await executeCompassTool(makeClient(socialDb()), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" });
    assert.ok(result.compatibility, "absent trust row must still be admitted");
    assert.equal(result.compatibility.handle, "@bob");
  });

  it("baseline: a below-floor score is not surfaced (existing contract, pinned again here)", async () => {
    const db = socialDb();
    db.trust_profiles = [{ user_id: BOB_ID, overall_score: 5 }];
    const result: any = await executeCompassTool(makeClient(db), ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" });
    assert.equal(result.compatibility, null);
  });

  it("an UNREADABLE trust_profiles (query resolves with error) answers 'not available' — never a score", async () => {
    const db = socialDb();
    db.trust_profiles = [{ user_id: BOB_ID, overall_score: 5 }]; // below floor, but the read fails
    const sc = makeClient(db, { trust_profiles: { message: "permission denied for table trust_profiles", code: "42501" } });
    const result: any = await executeCompassTool(sc, ALICE_ID, profileFor(), "get_travel_compatibility", { handle: "bob" });
    assert.equal(result.compatibility, null, "an unreadable gate must be a closed gate");
    assert.equal(result.info, "Compatibility is not available for that person.", "uniform answer — never says WHY");
  });
});

// ── B. refreshHiddenUsers without a snapshot fails CLOSED ────────────────────

describe("B. social tools with NO profile snapshot — a failed hidden-user read closes the tool, never empties the set", () => {
  it("profile null + blocks unreadable → the tool call fails (no empty hidden set is ever used)", async () => {
    const sc = makeClient(socialDb(), { blocks: { message: "connection reset" } });
    const result: any = await executeCompassTool(sc, ALICE_ID, null, "get_whos_around", {});
    assert.equal(result.error, "Tool execution failed.");
  });

  it("profile null + reads fine → the tool proceeds (nothing to fall back to, nothing failed)", async () => {
    const result: any = await executeCompassTool(makeClient(socialDb()), ALICE_ID, null, "get_whos_around", {});
    assert.notEqual(result.error, "Tool execution failed.");
  });

  it("profile snapshot + blocks unreadable → the snapshot's hidden ids are kept (unchanged behaviour)", async () => {
    // Bob is hidden in the snapshot; the live re-read fails; Bob must stay hidden.
    const sc = makeClient(socialDb(), { blocks: { message: "connection reset" } });
    const result: any = await executeCompassTool(sc, ALICE_ID, profileFor({ blockedUserIds: [BOB_ID] }), "get_travel_compatibility", { handle: "bob" });
    assert.equal(result.compatibility, null, "a user hidden in the snapshot stays hidden when the refresh fails");
  });
});

// ── C. Sender suspension read from the table that can hold it ────────────────

describe("C. evaluateNotification — sender suspension comes from user_account_states", () => {
  const RECIPIENT = "u-recipient";
  const SENDER    = "u-sender";
  function payload(): NotificationPayload {
    return { type: "message_normal", title: "Hi", body: "Hello", data: { senderId: SENDER } };
  }
  function notifDb(extra: Db = {}): Db {
    return {
      blocks: [],
      compass_user_preferences: [],
      notification_preferences: [],
      compass_notification_decisions: [],
      feature_flags: [],
      trust_profiles: [],
      user_account_states: [],
      ...extra,
    };
  }

  it("an active (open-ended) suspension suppresses the push via the safety filter", async () => {
    const db = notifDb({ user_account_states: [{ user_id: SENDER, state: "suspended", expires_at: null }] });
    const d = await evaluateNotification(makeClient(db), RECIPIENT, payload(), { nowMinutes: 12 * 60 });
    assert.equal(d.outcome, "suppressed_safety_filter");
  });

  it("a banned state counts too", async () => {
    const db = notifDb({ user_account_states: [{ user_id: SENDER, state: "banned", expires_at: null }] });
    const d = await evaluateNotification(makeClient(db), RECIPIENT, payload(), { nowMinutes: 12 * 60 });
    assert.equal(d.outcome, "suppressed_safety_filter");
  });

  it("an EXPIRED suspension does not suppress", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const db = notifDb({ user_account_states: [{ user_id: SENDER, state: "suspended", expires_at: past }] });
    const d = await evaluateNotification(makeClient(db), RECIPIENT, payload(), { nowMinutes: 12 * 60 });
    assert.equal(d.outcome, "sent");
  });

  it("the OLD dead signal — trust_profiles.public_level = 'suspended' — is not what decides (a value the CHECK forbids)", async () => {
    const db = notifDb({ trust_profiles: [{ user_id: SENDER, public_level: "suspended" }] });
    const d = await evaluateNotification(makeClient(db), RECIPIENT, payload(), { nowMinutes: 12 * 60 });
    assert.equal(d.outcome, "sent");
  });

  it("an unreadable user_account_states is logged and the push is still evaluated (posture matches the blocked-sender step)", async () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(String(args[0])); };
    try {
      const db = notifDb();
      const sc = makeClient(db, { user_account_states: { message: "relation does not exist", code: "42P01" } });
      const d = await evaluateNotification(sc, RECIPIENT, payload(), { nowMinutes: 12 * 60 });
      assert.equal(d.outcome, "sent");
      assert.ok(warned.some((w) => w.includes("account-state check failed")), "the failed read must leave a trace");
    } finally {
      console.warn = orig;
    }
  });
});

// ── D. unsafe_density is a hard exclusion, whatever the intent ───────────────

describe("D. evaluateLiveConstraints — a Live unsafe_density claim excludes for every viewer", () => {
  const NOW_MS = new Date("2026-09-04T20:00:00.000Z").getTime();
  const minutes = (n: number) => n * 60_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  function envelope(over: Partial<LiveClaimEnvelope> & { claimType: string; value: unknown }): LiveClaimEnvelope {
    const band = over.band ?? "live";
    return {
      id: over.id ?? `snap-${over.claimType}`,
      claimType: over.claimType,
      value: over.value,
      confidence: over.confidence ?? 0.8,
      band,
      sourceClass: over.sourceClass ?? "firsthand_unverified",
      sourceCountBucket: over.sourceCountBucket === undefined ? "few" : over.sourceCountBucket,
      observedAt: over.observedAt ?? iso(NOW_MS - minutes(5)),
      validUntil: over.validUntil ?? iso(NOW_MS + minutes(25)),
      state: over.state ?? (band === "live" || band === "strong" ? "live" : "emerging"),
      conflictState: over.conflictState ?? "none",
      conflict: over.conflict ?? null,
    } as LiveClaimEnvelope;
  }

  it("excludes with intent null (previously: no constraint at all)", () => {
    const ev = evaluateLiveConstraints([envelope({ claimType: "crowd.level", value: { level: UNSAFE_CROWD_LEVEL } })], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
    assert.equal(ev.exclusion?.reasonCode, "unsafe_density_safety");
    assert.equal(ev.exclusion?.kind, "exclude");
    assert.equal(ev.penalty, 0);
  });

  it("excludes with a quiet intent too (previously: a mere demotion)", () => {
    const ev = evaluateLiveConstraints([envelope({ claimType: "crowd.level", value: { level: UNSAFE_CROWD_LEVEL } })], { maxQueueWaitMinutes: 30, intent: "quiet" }, NOW_MS);
    assert.equal(ev.exclusion?.reasonCode, "unsafe_density_safety");
    assert.deepEqual(ev.demotions, []);
  });

  it("'packed' is unchanged — a busyness reading, demoted only against a quiet intent", () => {
    const packed = envelope({ claimType: "crowd.level", value: { level: "packed" } });
    const quiet = evaluateLiveConstraints([packed], { maxQueueWaitMinutes: 30, intent: "quiet" }, NOW_MS);
    assert.equal(quiet.exclusion, null);
    assert.equal(quiet.demotions[0]?.reasonCode, "packed_vs_quiet_intent");
    assert.equal(quiet.penalty, LIVE_DEMOTE_PENALTY);
    const lively = evaluateLiveConstraints([packed], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
    assert.equal(lively.exclusion, null);
    assert.deepEqual(lively.demotions, []);
  });

  it("truth boundary still holds: an 'emerging' unsafe_density is NOT a hard fact and cannot exclude", () => {
    const ev = evaluateLiveConstraints([envelope({ claimType: "crowd.level", value: { level: UNSAFE_CROWD_LEVEL }, band: "likely_current" })], { maxQueueWaitMinutes: 30, intent: null }, NOW_MS);
    assert.equal(ev.exclusion, null);
  });
});
