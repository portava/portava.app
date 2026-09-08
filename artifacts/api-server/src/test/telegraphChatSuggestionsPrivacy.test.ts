/**
 * resolvePrivacyVerdict — an unreadable `profiles` row is not consent.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `show_telegraph_dm` / `_trip` / `_circle` are OPT-OUTS: the product default is
 * on, so the test is `!== false` and an absent column correctly means enabled.
 * supabase-js RESOLVES on a database error, so a FAILED read of the viewer's
 * profiles row arrived as `profile === null`, `undefined !== false` was true,
 * and a user who had turned Telegraph suggestions OFF had them generated into
 * their chat anyway — and persisted, since routes/telegraphChat.ts inserts the
 * shown cards into `telegraph_chat_suggestions`.
 *
 * ── THE PAIRING ─────────────────────────────────────────────────────────────
 * "no opt-out configured" and "the opt-out could not be read" produce the same
 * `profile?.[key]` — `undefined` — so an assertion on the boolean alone would
 * pass either way. Every failure case below is paired with the two healthy
 * reads it has to be told apart from (configured-on and configured-off), and
 * the failure case additionally asserts the `reason`, which is what makes an
 * outage legible to a log reader instead of looking like a user's choice.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/telegraphChatSuggestionsPrivacy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { resolvePrivacyVerdict, buildSuggestions } from "../services/telegraphChatSuggestions.js";
import { detectIntent } from "../services/telegraphIntent.js";

const USER   = "aaaaaaaa-0000-4000-a000-000000000001";
const THREAD = "bbbbbbbb-0000-4000-a000-000000000002";
const TRIP   = "cccccccc-0000-4000-a000-000000000003";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

function client(opts: {
  profiles?: Record<string, any>[];
  failProfiles?: boolean;
  threadType?: string;
}) {
  const threadType = opts.threadType ?? "direct";
  return makeFailClosedClient({
    rows: {
      message_threads: [{
        id: THREAD,
        thread_type: threadType,
        trip_id: threadType === "trip" ? TRIP : null,
        circle_owner_id: null,
      }],
      trip_members: threadType === "trip" ? [{ trip_id: TRIP, user_id: USER, role: "member" }] : [],
      trips: [{ id: TRIP, destination_city: "Lisbon", destination_country: "Portugal" }],
      profiles: opts.profiles ?? [],
    },
    failOn: (ctx) => (ctx.table === "profiles" && opts.failProfiles ? READ_FAIL : null),
  });
}

let scenarios = 0;

describe("resolvePrivacyVerdict — direct thread", () => {
  it("HEALTHY TWIN A: no opt-out row at all keeps the product default ON", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(client({}), USER, THREAD);
    assert.equal(v.canShowRecommendation, true);
    assert.equal(v.reason, "ok");
  });

  it("HEALTHY TWIN B: an explicit opt-out is honoured and says WHY", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(
      client({ profiles: [{ id: USER, show_telegraph_dm: false }] }), USER, THREAD,
    );
    assert.equal(v.canShowRecommendation, false);
    assert.equal(v.reason, "telegraph_disabled");
  });

  it("HEALTHY TWIN C: an explicit opt-IN is honoured", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(
      client({ profiles: [{ id: USER, show_telegraph_dm: true }] }), USER, THREAD,
    );
    assert.equal(v.canShowRecommendation, true);
    assert.equal(v.reason, "ok");
  });

  it("FAILURE: an unreadable profiles row suppresses rather than assuming consent", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(
      // The seed says this user OPTED OUT. Before the fix the failed read hid
      // that and the verdict came back `true`.
      client({ profiles: [{ id: USER, show_telegraph_dm: false }], failProfiles: true }),
      USER, THREAD,
    );
    assert.equal(v.canShowRecommendation, false);
  });

  it("FAILURE reads differently from a user's own choice", async () => {
    scenarios++;
    const failed = await resolvePrivacyVerdict(client({ failProfiles: true }), USER, THREAD);
    const chosen = await resolvePrivacyVerdict(
      client({ profiles: [{ id: USER, show_telegraph_dm: false }] }), USER, THREAD,
    );
    assert.equal(failed.reason, "telegraph_settings_unavailable");
    assert.equal(chosen.reason, "telegraph_disabled");
    assert.notEqual(failed.reason, chosen.reason);
  });

  it("FAILURE: no suggestion cards are built from the suppressed verdict", async () => {
    scenarios++;
    const intent = detectIntent("where should we get dinner tonight");
    assert.ok(intent, "fixture guard: the intent detector must recognise this text");
    const v = await resolvePrivacyVerdict(client({ failProfiles: true }), USER, THREAD);
    // routes/telegraphChat.ts only calls buildSuggestions inside
    // `if (verdict.canShowRecommendation)`; this pins the verdict it gates on.
    assert.equal(v.canShowRecommendation, false);
    const healthy = await resolvePrivacyVerdict(client({}), USER, THREAD);
    assert.equal(healthy.canShowRecommendation, true);
    assert.ok(
      buildSuggestions(USER, THREAD, intent!, healthy).length > 0,
      "fixture guard: the healthy verdict must actually produce cards, or the failure case proves nothing",
    );
  });
});

describe("resolvePrivacyVerdict — trip thread uses the trip-scoped opt-out", () => {
  it("HEALTHY TWIN: show_telegraph_trip=false is honoured for a trip thread", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(
      client({ threadType: "trip", profiles: [{ id: USER, show_telegraph_trip: false, show_telegraph_dm: true }] }),
      USER, THREAD,
    );
    assert.equal(v.threadType, "trip");
    assert.equal(v.canUseTripContext, true, "fixture guard: the seeded membership must resolve");
    assert.equal(v.canShowRecommendation, false);
    assert.equal(v.reason, "telegraph_disabled");
  });

  it("FAILURE: an unreadable profiles row suppresses on the trip path too", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(
      client({ threadType: "trip", profiles: [{ id: USER, show_telegraph_trip: false }], failProfiles: true }),
      USER, THREAD,
    );
    assert.equal(v.canUseTripContext, true, "fixture guard: only the profiles read fails");
    assert.equal(v.canShowRecommendation, false);
    assert.equal(v.reason, "telegraph_settings_unavailable");
  });

  it("HEALTHY TWIN: a trip thread with the opt-out untouched still works", async () => {
    scenarios++;
    const v = await resolvePrivacyVerdict(client({ threadType: "trip" }), USER, THREAD);
    assert.equal(v.canShowRecommendation, true);
    assert.equal(v.reason, "ok");
    assert.equal(v.tripDestination, "Lisbon");
  });
});

describe("vacuity", () => {
  it("exercised a non-zero number of scenarios", () => {
    assert.ok(scenarios >= 9, `expected >= 9 scenarios, ran ${scenarios}`);
  });
});
