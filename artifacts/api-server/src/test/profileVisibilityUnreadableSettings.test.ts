/**
 * resolveProfileVisibility — an UNREADABLE profile_privacy_settings table is
 * not an unconfigured user.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. `profile_privacy_settings` holds
 * the opt-OUTS, and every consumer reads them as `privacySettings?.show_X ===
 * false`, so `null` means "nothing restricted". A failed read produced exactly
 * that `null`: the effective tier fell back to the `profiles` row (commonly
 * public → "full") and every `show_*` opt-out was skipped. One unreadable table
 * published profiles their owners had restricted.
 *
 * ── THE PAIRING THIS FILE IS BUILT AROUND ───────────────────────────────────
 * A test that seeds NO privacy row and a test that FAILS the read of the
 * privacy row can pass for the same reason, and a "fix" that simply withheld
 * from everyone would satisfy either one alone. So every failure case here has
 * a healthy twin that differs in exactly one thing — whether the read
 * succeeds — and asserts the OPPOSITE outcome:
 *
 *   no row, readable      → "full", privacySettings null      (unchanged)
 *   row unreadable        → "limited_preview", RESTRICTED_…   (the fix)
 *   row readable + strict → "limited_preview", the real row   (unchanged)
 *
 * The double (helpers/failClosedSupabase.ts) injects a RESOLVED
 * `{ data: null, error }`, never a rejection: a test whose fake threw would be
 * exercising a `try/catch` production never enters.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/profileVisibilityUnreadableSettings.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import {
  resolveProfileVisibility,
  RESTRICTED_PRIVACY_SETTINGS,
} from "../lib/profileVisibility.js";

const OWNER  = "aaaaaaaa-0000-4000-a000-000000000001";
const VIEWER = "bbbbbbbb-0000-4000-a000-000000000002";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

/** A profiles row that is PUBLIC by every profile-level field. */
const PUBLIC_ROW = { is_private: false, passport_visibility: "public", account_status: "active" };

/** The settings row a user who restricted themselves actually has. */
const STRICT_SETTINGS = {
  user_id: OWNER,
  profile_visibility: "private",
  show_posts: false,
  show_stamps: false,
  show_followers: false,
};

/** Sorted friendship pair, the shape resolveProfileVisibility queries. */
const FRIENDSHIP = {
  user_a: OWNER < VIEWER ? OWNER : VIEWER,
  user_b: OWNER < VIEWER ? VIEWER : OWNER,
};

function client(opts: {
  settings?: Record<string, any>[];
  friendships?: Record<string, any>[];
  failSettings?: { message: string; code?: string } | null;
}) {
  return makeFailClosedClient({
    rows: {
      profile_privacy_settings: opts.settings ?? [],
      user_friendships: opts.friendships ?? [],
      blocks: [],
      user_account_states: [],
      user_follows: [],
    },
    failOn: (ctx) =>
      ctx.table === "profile_privacy_settings" && opts.failSettings ? opts.failSettings : null,
  });
}

/** Count of assertions' worth of scenarios exercised — vacuity guard. */
let scenarios = 0;

describe("resolveProfileVisibility — non-owner, privacy settings unreadable", () => {
  it("HEALTHY TWIN: no privacy row at all on a public profile still yields 'full'", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(client({}), VIEWER, OWNER, PUBLIC_ROW);
    assert.equal(r.visibility, "full");
    assert.equal(r.privacySettings, null);
    assert.notEqual(r.privacySettingsUnavailable, true);
  });

  it("HEALTHY TWIN: a readable strict row is honoured — 'limited_preview' and the REAL row", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ settings: [STRICT_SETTINGS] }), VIEWER, OWNER, PUBLIC_ROW,
    );
    assert.equal(r.visibility, "limited_preview");
    assert.equal(r.privacySettings?.profile_visibility, "private");
    // The real row, not the substitute: `show_real_name` is absent from the seed.
    assert.notEqual(r.privacySettings, RESTRICTED_PRIVACY_SETTINGS);
    assert.notEqual(r.privacySettingsUnavailable, true);
  });

  it("FAILURE: an unreadable settings table withholds instead of publishing", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ failSettings: READ_FAIL }), VIEWER, OWNER, PUBLIC_ROW,
    );
    // Before the fix this was "full" with privacySettings null — the profiles
    // row said public and nothing contradicted it.
    assert.equal(r.visibility, "limited_preview");
    assert.equal(r.privacySettings, RESTRICTED_PRIVACY_SETTINGS);
    assert.equal(r.privacySettingsUnavailable, true);
  });

  it("FAILURE: every show_* opt-out downstream reads as withheld", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ failSettings: READ_FAIL }), VIEWER, OWNER, PUBLIC_ROW,
    );
    // These are the exact expressions routes/follows.ts, routes/profileTabs.ts
    // and routes/passport.ts evaluate. Each must now be `false`.
    const ps = r.privacySettings;
    assert.equal(ps?.show_followers, false);
    assert.equal(ps?.show_friends, false);
    assert.equal(ps?.show_posts, false);
    assert.equal(ps?.show_stamps, false);
    assert.equal(ps?.show_past_trips, false);
    assert.equal(ps?.show_upcoming_trips, false);
    assert.equal(ps?.show_real_name, false);
    assert.equal(ps?.precise_location_visible, false);
    assert.equal(ps?.allow_profile_discovery, false);
  });

  it("FAILURE does not cut off an APPROVED friend — still 'followers_only'", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ failSettings: READ_FAIL, friendships: [FRIENDSHIP] }), VIEWER, OWNER, PUBLIC_ROW,
    );
    // Withholding must cost the viewer visibility, not fail the request, and an
    // owner-approved friendship grants access at every non-public tier.
    assert.equal(r.visibility, "followers_only");
    assert.equal(r.privacySettingsUnavailable, true);
  });

  it("a MISSING TABLE (42P01) is not a failed read — 'no settings' is then the truth", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ failSettings: { message: 'relation "profile_privacy_settings" does not exist', code: "42P01" } }),
      VIEWER, OWNER, PUBLIC_ROW,
    );
    assert.equal(r.visibility, "full");
    assert.equal(r.privacySettings, null);
    assert.notEqual(r.privacySettingsUnavailable, true);
  });

  it("the substitute is frozen — a caller cannot poison the next request", () => {
    scenarios++;
    assert.equal(Object.isFrozen(RESTRICTED_PRIVACY_SETTINGS), true);
    assert.throws(() => { (RESTRICTED_PRIVACY_SETTINGS as any).show_posts = true; });
    assert.equal(RESTRICTED_PRIVACY_SETTINGS.show_posts, false);
  });
});

describe("resolveProfileVisibility — owner self-view", () => {
  it("HEALTHY TWIN: a readable row is returned to its owner as-is", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ settings: [STRICT_SETTINGS] }), OWNER, OWNER, PUBLIC_ROW,
    );
    assert.equal(r.visibility, "full");
    assert.equal(r.privacySettings?.profile_visibility, "private");
    assert.notEqual(r.privacySettingsUnavailable, true);
  });

  it("FAILURE: the owner is told the read failed, NOT handed an all-off row", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(
      client({ settings: [STRICT_SETTINGS], failSettings: READ_FAIL }), OWNER, OWNER, PUBLIC_ROW,
    );
    assert.equal(r.visibility, "full");
    assert.equal(r.privacySettingsUnavailable, true);
    // The substitute would render an owner's own settings screen as "everything
    // off" — a lie they could save back over their real settings.
    assert.equal(r.privacySettings, null);
    assert.notEqual(r.privacySettings, RESTRICTED_PRIVACY_SETTINGS);
  });

  it("HEALTHY TWIN: an owner with no row is 'unconfigured', not 'unavailable'", async () => {
    scenarios++;
    const r = await resolveProfileVisibility(client({}), OWNER, OWNER, PUBLIC_ROW);
    assert.equal(r.visibility, "full");
    assert.equal(r.privacySettings, null);
    assert.notEqual(r.privacySettingsUnavailable, true);
  });
});

describe("vacuity", () => {
  it("exercised a non-zero number of scenarios", () => {
    assert.ok(scenarios >= 10, `expected >= 10 scenarios, ran ${scenarios}`);
  });
});
