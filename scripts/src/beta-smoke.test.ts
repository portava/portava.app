/**
 * beta-smoke.test.ts — the beta smoke check against a STUBBED fetch.
 *
 * A healthy beta passes all seven checks; each way a beta can be wrong fails
 * the check that names it; every request is a GET (the smoke never writes);
 * and the smoke refuses to run against production's origin.
 *
 * Run: pnpm --dir scripts run test:beta-smoke
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BETA_AUTH_SETTINGS_URL,
  judgeProfilesProbe,
  LIVE_PLACES_REQUIREMENTS,
  NOT_CHECKED,
  betaPublishableKey,
  flagPolicyMismatch,
  runBetaSmoke,
  smokeBaseRefusal,
  type SmokeFetch,
} from "./beta-smoke.js";
import { PROFILES_NEVER_READ, loadFlagPolicy, type FlagPolicy } from "./beta-config-core.js";
import { REPO_ROOT } from "./beta-db-core.js";

const BASE = "https://portava-beta.replit.app";
const AUTH = "/auth/v1/settings (portava-beta)";
const REST = "https://emfpckykpzfturllshly.supabase.co/rest/v1/profiles?select=";
/** PostgREST's answer for a column the anon key may not read (the 3740 boundary holds). */
const DENIED = { status: 401, body: { code: "42501", message: "permission denied for table profiles" } };

type Routes = Record<string, { status: number; body: unknown }>;

/** The served flag map of a beta whose database holds the policy: every policy flag at its RAW value. */
const POLICY = loadFlagPolicy();
const POLICY_FLAGS = Object.fromEntries(POLICY.flags.map((e) => [e.flag, e.enabled]));
const KEY = betaPublishableKey();

const HEALTHY: Routes = {
  "/api/healthz": { status: 200, body: { status: "ok" } },
  "/api/auth/signup-status": { status: 200, body: { signupsEnabled: false, inviteOnly: true } },
  "/api/verification/status": { status: 401, body: { error: "unauthenticated" } },
  "/api/feature-flags": { status: 200, body: { flags: POLICY_FLAGS } },
  [AUTH]: { status: 200, body: { disable_signup: true, external: { email: true, apple: false, google: false } } },
  ...Object.fromEntries(PROFILES_NEVER_READ.map((c) => [`PROFILES:${c}`, DENIED])),
};

function stub(routes: Routes) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const fetch: SmokeFetch = async (url, init) => {
    calls.push({ method: init.method, url, headers: init.headers });
    const path = url === BETA_AUTH_SETTINGS_URL ? AUTH
      : url.startsWith(REST) ? `PROFILES:${decodeURIComponent(url.slice(REST.length).replace(/&limit=0$/, ""))}`
      : url.replace(BASE, "");
    if (path.startsWith("PROFILES:")) assert.ok(url.endsWith("&limit=0"), "a profiles probe must never ask for rows");
    let r = routes[path] ?? { status: 404, body: { error: "not_found" } };
    // GoTrue and PostgREST answer 401 without the project's own publishable key.
    if ((path === AUTH || path.startsWith("PROFILES:")) && init.headers.apikey !== KEY) r = { status: 401, body: { message: "Invalid API key" } };
    return { status: r.status, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

describe("beta-smoke", () => {
  it("a correctly configured beta passes every check, with GETs only", async () => {
    const s = stub(HEALTHY);
    const results = await runBetaSmoke(`${BASE}/`, s.fetch);
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [
      ["health", true],
      ["sign-up closed (invite-only)", true],
      ["auth required", true],
      ["Rent-a-Buddy booking stops engaged", true],
      ["feature flags match the beta policy", true],
      ["Supabase Auth sign-up closed", true],
      ["profiles personal columns closed to the anon key", true],
    ], JSON.stringify(results));
    assert.ok(s.calls.every((c) => c.method === "GET"));
    // one GET per URL: checks 4 and 5 judge the same /api/feature-flags response
    assert.deepEqual(s.calls.map((c) => c.url), [
      `${BASE}/api/healthz`, `${BASE}/api/auth/signup-status`, `${BASE}/api/verification/status`, `${BASE}/api/feature-flags`,
      "https://emfpckykpzfturllshly.supabase.co/auth/v1/settings",
      ...PROFILES_NEVER_READ.map((c) => `${REST}${c}&limit=0`),
    ]);
    // the only credential ever sent is the beta PUBLISHABLE key, to the beta project only
    for (const c of s.calls) {
      assert.ok(!("authorization" in c.headers) && !("Authorization" in c.headers), c.url);
      if (c.url.includes("supabase.co")) assert.equal(c.headers.apikey, KEY);
      else assert.ok(!("apikey" in c.headers), c.url);
    }
  });

  const STOPS = "Rent-a-Buddy booking stops engaged";
  const MATCH = "feature flags match the beta policy";
  const AUTH_CLOSED = "Supabase Auth sign-up closed";
  const PROFILES_CLOSED = "profiles personal columns closed to the anon key";
  const flagsWith = (patch: Record<string, unknown>) => ({ status: 200, body: { flags: { ...POLICY_FLAGS, ...patch } } });
  const flagsWithout = (flag: string) => {
    const { [flag]: _gone, ...rest } = POLICY_FLAGS;
    return { status: 200, body: { flags: rest } };
  };
  const broken: Array<[string[], string, { status: number; body: unknown }]> = [
    [["health"], "/api/healthz", { status: 503, body: { status: "down" } }],
    [["sign-up closed (invite-only)"], "/api/auth/signup-status", { status: 200, body: { signupsEnabled: true, inviteOnly: true } }],
    [["sign-up closed (invite-only)"], "/api/auth/signup-status", { status: 200, body: { signupsEnabled: false, inviteOnly: false } }],
    [["sign-up closed (invite-only)"], "/api/auth/signup-status", { status: 503, body: { signupsEnabled: false, inviteOnly: false } }],
    [["auth required"], "/api/verification/status", { status: 200, body: {} }],
    [["auth required"], "/api/verification/status", { status: 503, body: { error: "server_not_configured" } }],
    // a stop wrong is ALSO a policy mismatch: both checks name it
    [[STOPS, MATCH], "/api/feature-flags", flagsWith({ RENT_BUDDY_ADMIN_ONLY_MODE: false })],
    [[STOPS, MATCH], "/api/feature-flags", flagsWithout("disable_rent_buddy_booking")],
    [[STOPS, MATCH], "/api/feature-flags", flagsWith({ rent_buddy_enabled: true })],
    [[STOPS, MATCH], "/api/feature-flags", { status: 503, body: { error: "server_not_configured" } }],
    // check 5 alone: the database does not hold THIS policy (config step not re-dispatched, or another database)
    [[MATCH], "/api/feature-flags", flagsWith({ push_notifications_enabled: true })],
    [[MATCH], "/api/feature-flags", flagsWith({ invite_only_beta: false })],
    [[MATCH], "/api/feature-flags", flagsWithout("invite_only_beta")],
    [[MATCH], "/api/feature-flags", flagsWith({ some_flag_the_policy_never_heard_of: true })],
    // check 6 alone: Supabase Auth still accepts new users (the app's own path)
    [[AUTH_CLOSED], AUTH, { status: 200, body: { disable_signup: false, external: { email: true } } }],
    [[AUTH_CLOSED], AUTH, { status: 200, body: { external: { email: true } } }],
    [[AUTH_CLOSED], AUTH, { status: 500, body: { message: "upstream" } }],
    // check 7 alone: the TABLE-level grant a baseline replay inherits (3740 not applied) makes a personal column readable
    [[PROFILES_CLOSED], "PROFILES:date_of_birth", { status: 200, body: [] }],
    [[PROFILES_CLOSED], "PROFILES:expo_push_token", { status: 200, body: [] }],
    // …and a probe that cannot be judged (no table: the schema is not built) is not a pass
    [[PROFILES_CLOSED], "PROFILES:full_name", { status: 404, body: { code: "PGRST205", message: "Could not find the table" } }],
  ];
  for (const [names, path, reply] of broken) {
    it(`FAILS ${names.map((n) => `"${n}"`).join(" + ")} when ${path} answers ${reply.status} ${JSON.stringify(reply.body).slice(0, 120)}`, async () => {
      const results = await runBetaSmoke(BASE, stub({ ...HEALTHY, [path]: reply }).fetch);
      const failed = results.filter((r) => !r.ok).map((r) => r.name);
      assert.deepEqual(failed, names, JSON.stringify(results.filter((r) => !r.ok)));
    });
  }

  it("an unknown flag served FALSE is acceptable (the config step forces flags it does not know OFF)", async () => {
    const results = await runBetaSmoke(BASE, stub({ ...HEALTHY, "/api/feature-flags": flagsWith({ retired_somewhere_enabled: false }) }).fetch);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  });

  it("FAILS check 6 when eas.json's key is not the beta project's (GoTrue answers 401)", async () => {
    const results = await runBetaSmoke(BASE, stub(HEALTHY).fetch, { publishableKey: "sb_publishable_not_portava_beta" });
    const r = results.find((x) => x.name === AUTH_CLOSED);
    assert.ok(r && !r.ok && /not accepted by portava-beta/.test(r.detail), JSON.stringify(r));
  });

  it("the live-places derivation: a child the policy turns ON is served false while a parent is OFF", () => {
    const tiny = (entries: Array<[string, boolean]>): FlagPolicy => ({
      format: "portava-beta-flag-policy/1",
      project_ref: "emfpckykpzfturllshly",
      flags: entries.map(([flag, enabled]) => ({ flag, enabled, kind: "CAPABILITY", reason: "t", evidence: enabled ? ["t"] : [] })),
    });
    const p = tiny([["external_places_enabled", false], ["live_places_enabled", true]]);
    assert.equal(flagPolicyMismatch({ external_places_enabled: false, live_places_enabled: false }, p), null);
    assert.match(String(flagPolicyMismatch({ external_places_enabled: false, live_places_enabled: true }, p)), /live_places_enabled=true \(policy false\)/);
  });

  it("the derivation copy equals the API's LIVE_PLACES_REQUIREMENTS (artifacts/api-server/src/lib/featureFlags.ts)", () => {
    const src = readFileSync(join(REPO_ROOT, "artifacts/api-server/src/lib/featureFlags.ts"), "utf8");
    const block = /export const LIVE_PLACES_REQUIREMENTS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
    assert.ok(block, "LIVE_PLACES_REQUIREMENTS not found in featureFlags.ts");
    const api: Record<string, string[]> = {};
    for (const m of block[1].matchAll(/([a-z_]+):\s*\[([^\]]*)\]/g)) api[m[1]] = [...m[2].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
    assert.ok(Object.keys(api).length >= 8, "parse found too few entries");
    assert.deepEqual(Object.fromEntries(Object.entries(LIVE_PLACES_REQUIREMENTS).map(([k, v]) => [k, [...v]])), api);
  });

  it("a request that does not complete is a FAIL, not a skip", async () => {
    const fetch: SmokeFetch = async () => { throw new Error("ECONNREFUSED"); };
    const results = await runBetaSmoke(BASE, fetch);
    assert.equal(results.length, 7);
    assert.ok(results.every((r) => !r.ok && /did not complete/.test(r.detail)));
  });

  it("refuses production's origin, a missing base and a non-URL", () => {
    assert.match(String(smokeBaseRefusal("https://portava.replit.app")), /PRODUCTION/);
    assert.ok(smokeBaseRefusal(null));
    assert.ok(smokeBaseRefusal("portava-beta"));
    assert.ok(smokeBaseRefusal("http://portava-beta.replit.app"));
    assert.equal(smokeBaseRefusal(BASE), null);
  });

  it("says plainly what it cannot check", () => {
    assert.equal(NOT_CHECKED.length, 2);
    assert.match(NOT_CHECKED.join(" "), /identity-verification readiness/);
    assert.match(NOT_CHECKED.join(" "), /NODE_ENV=production/);
  });
});

describe("beta-smoke check 7 — judging one PostgREST probe", () => {
  it("permission denied (42501) and an absent column (42703) are closed; 200 is open; anything else is not judged", () => {
    assert.equal(judgeProfilesProbe(401, { code: "42501" }), "closed");
    assert.equal(judgeProfilesProbe(403, { code: "42501" }), "closed");
    assert.equal(judgeProfilesProbe(400, { code: "42703" }), "closed");
    assert.equal(judgeProfilesProbe(200, []), "open");
    assert.match(judgeProfilesProbe(404, { code: "PGRST205" }), /cannot judge/);
    assert.match(judgeProfilesProbe(401, { message: "Invalid API key" }), /cannot judge/, "a refused KEY is not a refused COLUMN");
  });

  it("an absent phone column (2142 not applied) does not fail the check", async () => {
    const results = await runBetaSmoke(BASE, stub({ ...HEALTHY, "PROFILES:phone_e164": { status: 400, body: { code: "42703" } } }).fetch);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
  });
});
