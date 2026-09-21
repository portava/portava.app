/**
 * census-compass CT-12 and CTG-08 — CompassSocialEngine.
 *
 * CT-12 (Trips §16 "friend nearby → meetup opportunity, subject to both
 * parties' privacy"). The census finding was that `get_whos_around` "is real
 * and privacy-correct … but produces presence, not an opportunity". The step
 * from presence to an OCCASION is built here: `getMeetupOpportunities` turns a
 * gated presence entry into a suggested meeting occasion carrying WHY and WHEN
 * — and it is subject to BOTH parties' privacy, exactly as TripSignals'
 * `friend_nearby` already required (`bothSharing`, dropped as
 * `TRIP_PRIVACY_SCOPE` when one-sided).
 *
 * The gate is NOT weakened to make the feature work:
 *   - viewer → target still goes through `canViewCirclePresenceBatch`,
 *     fail-closed per target. A target who cannot be viewed yields NO
 *     opportunity at all — not a redacted one, not a placeholder, no trace.
 *   - target → viewer is checked too, through `canBeSeenByViewersBatch`. A
 *     viewer who is not sharing back gets nothing about that person either.
 *   - a STALE presence row yields no opportunity: "they are there now" is not
 *     a fact a stale row carries.
 *
 * CTG-08 (§30A.1 "canonical relationship model; no independent inference").
 * The census finding was that `sharesSocialContext` "is a FOURTH relationship
 * resolver with its own vocabulary — correct and fail-closed, not canonical".
 * It now consumes `services/interactionPermissions.resolveInteractionPermissions`
 * — the file whose own header calls it "canonical permission engine for all
 * social actions" and which owns `RelationshipLabel` — and reports that label
 * rather than a private boolean vocabulary. CompassSocialEngine no longer reads
 * `circle_memberships` / `trip_members` to decide a relationship.
 *
 * TEST-FIRST. Written before `getMeetupOpportunities` existed and before
 * `sharesSocialContext` returned a verdict; the first run failed at module load
 * (`getMeetupOpportunities` is not exported by CompassSocialEngine), which is
 * the right reason — neither computation existed.
 *
 * Mutation log (each applied ALONE, suite run, source restored):
 *   M5 the viewer→target gate verdict discarded (every target viewable)     → red
 *   M6 the reciprocity check (canBeSeenByViewersBatch) removed              → red
 *   M7 a withheld target emitted as a REDACTED opportunity instead of none  → red
 *   M8 a STALE presence row allowed to become an opportunity                → red
 *   M9 the canonical verdict replaced by a local circle_memberships /
 *      trip_members inference — the fourth resolver, reinstated             → red
 *   M10 an unreadable canonical read reported as `stranger` (a claim about
 *      the pair) instead of `unavailable`                                   → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassMeetupOpportunity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getMeetupOpportunities,
  sharesSocialContext,
} from "../compass/CompassSocialEngine.js";
import { COMPASS_TOOL_DEFINITIONS, COMPASS_TOOL_NAMES, executeCompassTool } from "../compass/CompassTools.js";
import type { CompassProfile } from "../compass/types.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ALICE_ID = "a1a1a1a1-aaaa-aaaa-aaaa-000000000001";
const BOB_ID   = "b2b2b2b2-bbbb-bbbb-bbbb-000000000002";
const CARA_ID  = "c3c3c3c3-cccc-cccc-cccc-000000000003";
const TRIP_ID  = "eeee0000-eeee-eeee-eeee-000000000001";

// ── Fake Supabase client (same builder shape as compass-social.test.ts) ───────

type Db = Record<string, any[]>;
type Errors = Record<string, { message: string; code?: string }>;

function makeDb(overrides: Db = {}): Db {
  return {
    feature_flags: [{ flag: "COMPASS_ENABLED", enabled: true }],
    profiles: [
      { id: ALICE_ID, handle: "alice", name: "Alice Real" },
      { id: BOB_ID,   handle: "bob",   name: "Bob Real" },
      { id: CARA_ID,  handle: "cara",  name: "Cara Real" },
    ],
    trips: [{ id: TRIP_ID, title: "Cebu Trip", destination_city: "Cebu", status: "active", owner_id: ALICE_ID }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: BOB_ID,   role: "member", status: "accepted" },
      { trip_id: TRIP_ID, user_id: CARA_ID,  role: "member", status: "accepted" },
    ],
    events: [], event_rsvps: [], event_attendees: [],
    circles: [], circle_memberships: [],
    circle_visibility_settings: [], circle_context_settings: [], circle_presence: [],
    blocks: [], user_mutes: [], user_account_states: [], profile_privacy_settings: [],
    trust_profiles: [], user_friendships: [], user_follows: [], friend_requests: [],
    ...overrides,
  };
}

function makeClient(db: Db, errors: Errors = {}) {
  function builder(table: string) {
    const err = errors[table] ?? null;
    let filtered = [...(db[table] ?? [])];
    const b: any = {
      select: () => b,
      eq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      is:  (col: string, val: any) => { filtered = filtered.filter((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      gte: () => b, lte: () => b, gt: () => b, lt: () => b,
      ilike: () => b, like: () => b,
      or: () => b, not: () => b, order: () => b,
      limit: (n: number) => { filtered = filtered.slice(0, n); return b; },
      maybeSingle: () => Promise.resolve(err ? { data: null, error: err } : { data: filtered[0] ?? null, error: null }),
      single: () => Promise.resolve(err ? { data: null, error: err } : { data: filtered[0] ?? null, error: null }),
      then: (resolve_: any, reject?: any) =>
        Promise.resolve(err ? { data: null, error: err } : { data: filtered, error: null }).then(resolve_, reject),
      insert: () => b, upsert: () => b, update: () => b, delete: () => b,
    };
    return b;
  }
  return { from: (table: string) => builder(table), rpc: () => Promise.resolve({ data: null, error: null }) } as any;
}

function sharingOn(userId: string, mode = "approximate_area") {
  return {
    user_id: userId,
    global_enabled: true,
    visibility_mode: "status_only",
    trip_sharing_default: mode,
    event_sharing_default: "status_only",
    is_paused: false,
    consent_version: "v1",
    consented_at: "2026-07-01T00:00:00Z",
  };
}

const STALE_AFTER_SECS = 3600;

function presenceRow(userId: string, extra: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    context_type: "trip",
    context_id: TRIP_ID,
    status: "arrived",
    status_label: "Grabbing dinner",
    approximate_label: "Lahug area",
    venue_label: "Secret Exact Bar, 123 Real St",
    checked_in: false,
    stale_after_secs: STALE_AFTER_SECS,
    last_seen_at: new Date().toISOString(),
    expires_at: null,
    is_stale: false,
    needs_help: false,
    ...extra,
  };
}

/** Alice and Bob both sharing in the same trip — the reciprocal case. */
function bothSharingDb(): Db {
  return makeDb({
    circle_visibility_settings: [sharingOn(ALICE_ID), sharingOn(BOB_ID)],
    circle_presence: [presenceRow(ALICE_ID), presenceRow(BOB_ID)],
  });
}

function profileFor(over: Partial<CompassProfile> = {}): CompassProfile {
  return { userId: ALICE_ID, blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], ...over } as unknown as CompassProfile;
}

// ── CT-12 ────────────────────────────────────────────────────────────────────

describe("CT-12 — presence becomes a meetup OPPORTUNITY, carrying why and when", () => {
  it("a mutually-sharing friend nearby becomes one occasion with reasons and a window", async () => {
    const r = await getMeetupOpportunities(makeClient(bothSharingDb()), ALICE_ID, new Set<string>());
    assert.equal(r.opportunities.length, 1, JSON.stringify(r));
    const o: any = r.opportunities[0];
    assert.equal(o.handle, "@bob");
    assert.equal(o.label, "@bob", "@handle default — a real name only with opt-in");
    assert.equal(o.context.type, "trip");
    assert.ok(String(o.context.title).includes("Cebu Trip"));
    // WHY
    assert.ok(Array.isArray(o.why) && o.why.length > 0, "an opportunity carries its reasons");
    assert.ok(o.why.some((w: string) => w.includes("Lahug area")), "the reason repeats what they shared");
    assert.ok(o.reasonCodes.includes("BOTH_SHARING_PRESENCE"), "reciprocity is stated, not assumed");
    assert.ok(o.reasonCodes.includes("SHARED_CONTEXT"));
    // WHEN
    assert.equal(o.when.startsNow, true);
    assert.ok(
      Number(o.when.expiresInMinutes) > 0 && Number(o.when.expiresInMinutes) <= STALE_AFTER_SECS / 60,
      `the window comes from their own staleness setting, not a guess: ${JSON.stringify(o.when)}`,
    );
    assert.equal(typeof o.when.basis, "string");
    // Granularity is theirs, and no precise location ever appears.
    assert.equal(o.whereGranularity, "approximate_area");
    assert.ok(String(o.where).includes("Lahug area"));
    const json = JSON.stringify(r);
    assert.ok(!json.includes("Secret Exact Bar"), "a venue label outside venue_checkin mode must never leak");
    assert.ok(!json.includes("needs_help") && !json.includes("needsHelp"));
    assert.ok(!json.includes('"lat"') && !json.includes('"lng"'));
  });

  it("the occasion never names a place the person did not share (status-only ⇒ no location claim)", async () => {
    const db = makeDb({
      circle_visibility_settings: [sharingOn(ALICE_ID), sharingOn(BOB_ID, "status_only")],
      circle_presence: [presenceRow(ALICE_ID), presenceRow(BOB_ID)],
    });
    const r = await getMeetupOpportunities(makeClient(db), ALICE_ID, new Set<string>());
    assert.equal(r.opportunities.length, 1);
    const o: any = r.opportunities[0];
    assert.equal(o.where, null);
    assert.equal(o.whereGranularity, "none");
    assert.ok(!JSON.stringify(o).includes("Lahug area"), "an approximate label is not shared in status_only mode");
    assert.ok(!/\bat\s+the\b/i.test(String(o.occasion)) || !String(o.occasion).includes("Lahug"));
  });

  it("ADVERSARIAL — a target who cannot be VIEWED yields no opportunity AT ALL, not a redacted one", async () => {
    // Bob shares; Cara does not (no circle_visibility_settings row at all).
    const db = makeDb({
      circle_visibility_settings: [sharingOn(ALICE_ID), sharingOn(BOB_ID)],
      circle_presence: [presenceRow(ALICE_ID), presenceRow(BOB_ID), presenceRow(CARA_ID)],
    });
    const r = await getMeetupOpportunities(makeClient(db), ALICE_ID, new Set<string>());
    const json = JSON.stringify(r);
    assert.deepEqual(r.opportunities.map((o: any) => o.handle), ["@bob"]);
    assert.ok(!json.includes("@cara"), "no handle");
    assert.ok(!json.includes(CARA_ID), "no id");
    assert.ok(!json.toLowerCase().includes("cara"), "no trace of the person at all — not even redacted");
  });

  it("ADVERSARIAL — a blocked target yields no opportunity, and the guard's own block check catches it without the snapshot", async () => {
    const db = bothSharingDb();
    db.blocks = [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }];
    const r = await getMeetupOpportunities(makeClient(db), ALICE_ID, new Set<string>());
    assert.deepEqual(r.opportunities, []);
  });

  it("BOTH parties' privacy — the viewer not sharing back yields nothing, and names nobody", async () => {
    // Bob shares with Alice; Alice shares with nobody (no settings/presence of her own).
    const db = makeDb({
      circle_visibility_settings: [sharingOn(BOB_ID)],
      circle_presence: [presenceRow(BOB_ID)],
    });
    const r = await getMeetupOpportunities(makeClient(db), ALICE_ID, new Set<string>());
    assert.deepEqual(r.opportunities, [], "a one-sided case is not a meetup opportunity");
    assert.equal(r.withheldForPrivacy, 1, "the count is the only thing it says about them");
    assert.ok(!JSON.stringify(r).includes("@bob"), "the withheld person is never named");
  });

  it("a STALE presence row yields no opportunity — 'they are there now' is not a fact a stale row carries", async () => {
    const db = makeDb({
      circle_visibility_settings: [sharingOn(ALICE_ID), sharingOn(BOB_ID)],
      circle_presence: [
        presenceRow(ALICE_ID),
        presenceRow(BOB_ID, { is_stale: true, last_seen_at: new Date(Date.now() - 4 * 3600_000).toISOString() }),
      ],
    });
    const r = await getMeetupOpportunities(makeClient(db), ALICE_ID, new Set<string>());
    assert.deepEqual(r.opportunities, []);
  });

  it("no active context is an honest empty answer, not a silence", async () => {
    const db = makeDb({ trip_members: [], trips: [] });
    const r = await getMeetupOpportunities(makeClient(db), ALICE_ID, new Set<string>());
    assert.deepEqual(r.opportunities, []);
    assert.equal(r.contextsChecked, 0);
  });

  it("get_meetup_opportunities is declared, dispatchable, and answers honestly when there is nothing", async () => {
    assert.ok(COMPASS_TOOL_NAMES.has("get_meetup_opportunities"));
    const def = COMPASS_TOOL_DEFINITIONS.find((t) => t.function.name === "get_meetup_opportunities");
    assert.ok(def);
    assert.match(def!.function.description, /both/i, "the description states the two-sided privacy rule");
    const result: any = await executeCompassTool(
      makeClient(bothSharingDb()), ALICE_ID, profileFor(), "get_meetup_opportunities", {},
    );
    assert.equal(result.opportunities.length, 1);
    assert.equal(result.opportunities[0].handle, "@bob");
    assert.equal(typeof result.info, "string");
  });

  it("the engine still goes through the ONE presence gate — it does not read circle_presence itself", () => {
    const engine = strip(readFileSync(join(SRC, "compass", "CompassSocialEngine.ts"), "utf8"));
    assert.match(engine, /canViewCirclePresenceBatch/);
    assert.match(engine, /canBeSeenByViewersBatch/);
    assert.doesNotMatch(engine, /\.from\("circle_presence"\)/, "presence is read by the guard, never here");
  });
});

// ── CTG-08 ───────────────────────────────────────────────────────────────────

describe("CTG-08 — the canonical relationship model, consumed not re-invented", () => {
  it("a shared accepted trip is reported with the CANONICAL label, not a private vocabulary", async () => {
    const v: any = await sharesSocialContext(makeClient(makeDb()), ALICE_ID, BOB_ID);
    assert.equal(v.shares, true, JSON.stringify(v));
    assert.equal(v.relationship, "same_trip", "the label is interactionPermissions' RelationshipLabel");
    assert.equal(v.reason, "shared_trip");
  });

  it("a shared circle is the canonical `same_circle`", async () => {
    const db = makeDb({
      trip_members: [],
      circle_memberships: [{ user_id: ALICE_ID, other_id: BOB_ID, status: "accepted" }],
    });
    const v: any = await sharesSocialContext(makeClient(db), ALICE_ID, BOB_ID);
    assert.equal(v.shares, true, JSON.stringify(v));
    assert.equal(v.relationship, "same_circle");
    assert.equal(v.reason, "shared_circle");
  });

  it("no shared context is `stranger`, and shares nothing", async () => {
    const db = makeDb({ trip_members: [{ trip_id: TRIP_ID, user_id: ALICE_ID, role: "owner", status: "accepted" }] });
    const v: any = await sharesSocialContext(makeClient(db), ALICE_ID, BOB_ID);
    assert.equal(v.shares, false);
    assert.equal(v.relationship, "stranger");
  });

  it("a BLOCK is the canonical engine's priority-2 verdict, and it reaches Compass — the old resolver never asked", async () => {
    // The pair DO share an accepted trip. The fourth resolver said "true" for
    // exactly this input, because blocks were not part of its vocabulary.
    const db = makeDb({ blocks: [{ blocker_id: BOB_ID, blocked_id: ALICE_ID }] });
    const v: any = await sharesSocialContext(makeClient(db), ALICE_ID, BOB_ID);
    assert.equal(v.shares, false, "a blocked pair shares no social context");
    assert.ok(["blocks_you", "blocked", "mutual_block"].includes(String(v.relationship)), v.relationship);
  });

  it("FAIL-CLOSED: an unreadable canonical read shares nothing and says `unavailable` — never `stranger`", async () => {
    const sc = makeClient(makeDb(), { blocks: { message: "connection reset", code: "08006" } });
    const v: any = await sharesSocialContext(sc, ALICE_ID, BOB_ID);
    assert.equal(v.shares, false);
    assert.equal(v.reason, "unavailable");
    assert.equal(v.relationship, "unavailable", "an outage is not a statement about the pair");
  });

  it("CompassSocialEngine no longer infers a relationship of its own", () => {
    const engine = strip(readFileSync(join(SRC, "compass", "CompassSocialEngine.ts"), "utf8"));
    assert.match(engine, /import \{[\s\S]*?resolveInteractionPermissions[\s\S]*?\} from "\.\.\/services\/interactionPermissions\.js"/);
    const resolver = engine.slice(engine.indexOf("export async function sharesSocialContext"));
    assert.doesNotMatch(resolver, /\.from\("circle_memberships"\)/, "the circle read belongs to the canonical engine");
    assert.doesNotMatch(resolver, /\.from\("trip_members"\)/, "the trip read belongs to the canonical engine");
  });

  it("the compatibility tool consumes the verdict, not a bare boolean", () => {
    const tools = strip(readFileSync(join(SRC, "compass", "CompassTools.ts"), "utf8"));
    assert.match(tools, /if \(!related\.shares\) return notAvailable;/);
  });
});
