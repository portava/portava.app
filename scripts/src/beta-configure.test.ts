/**
 * beta-configure.test.ts — the portava-beta configuration step and its flag
 * policy, with a STUBBED Management API. No network, no credentials, no
 * database.
 *
 * The stub records every request, so the assertions are about the requests
 * the step makes (which endpoint, which body, in which order, and — on every
 * refusal — that NOTHING was sent or written) and about the state the stub's
 * "database" ends in.
 *
 * Run: pnpm --dir scripts run test:beta-configure
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { BETA_PROJECT_REF, PRODUCTION_PROJECT_REF, REPO_ROOT } from "./beta-db-core.js";
import {
  BETA_AUTH_CONFIG,
  authConfigProblems,
  buildFlagApplySql,
  flagPolicyProblems,
  loadFlagPolicy,
  planFlagApply,
  seededFlagPopulation,
  type FetchLike,
  type FlagPolicy,
  type SeededFlag,
} from "./beta-config-core.js";
import { runBetaConfigure } from "./beta-configure.js";

const BETA_URL = `https://${BETA_PROJECT_REF}.supabase.co`;
const CI_URL = "https://hwokxgbmezheskbzskfr.supabase.co";
const PROD_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;

// ─────────────────────────────────────────────────────────────────────────────
// THE REAL POLICY AGAINST THE REAL MIGRATIONS
// ─────────────────────────────────────────────────────────────────────────────

const population = seededFlagPopulation();
const policy = loadFlagPolicy();
const byFlag = new Map(policy.flags.map((e) => [e.flag, e]));

/** Lead rulings of 2026-10-06 (repo copy: docs/ops/lead-rulings-20261006.md, added by the lead). */
const LEAD_RULINGS = new Set(["D-24", "D-24a", "D-24b", "D-24c", "D-24d", "D-65", "D-66", "D-67", "D-103"]);
const OWNER_DECISIONS = readFileSync(join(REPO_ROOT, "docs/ops/owner-decisions-20261004.md"), "utf8");

/** null when an evidence id resolves to a record in the repo; otherwise why not. */
function evidenceProblem(id: string): string | null {
  if (/^OD-[A-Z]+-\d+$/.test(id)) return OWNER_DECISIONS.includes(`**${id} `) ? null : `${id} is not in docs/ops/owner-decisions-20261004.md`;
  if (/^D-\d+[a-d]?$/.test(id)) return LEAD_RULINGS.has(id) ? null : `${id} is not a lead ruling of 2026-10-06`;
  const m = /^census-([a-z-]+):([A-Za-z0-9.-]+)$/.exec(id);
  if (m) {
    const path = join(REPO_ROOT, "docs/architecture", `census-${m[1]}.md`);
    if (!existsSync(path)) return `${id}: no such census`;
    return new RegExp(`^\\| ${m[2].replace(/[.]/g, "\\.")} \\|`, "m").test(readFileSync(path, "utf8")) ? null : `${id}: no such row`;
  }
  return `${id} is not an evidence id (census-<name>:<ROW>, OD-*, D-nn)`;
}

describe("beta-flag-policy.json — every flag the beta database will hold, decided once", () => {
  it("the migration population is real (not vacuous) and includes the flags this policy exists for", () => {
    assert.ok(population.size > 250, `only ${population.size} seeded flags found — the scan broke`);
    for (const f of ["invite_only_beta", "disable_signups", "disable_rent_buddy_booking", "layover_presence_intents_enabled"]) {
      assert.ok(population.has(f), f);
    }
    // Retired by 2962 (a DELETE in the chain): must not be expected on beta.
    assert.ok(!population.has("intel_sensing_credentials_enabled"));
  });

  it("every seeded flag is listed exactly once, and no listed flag is unknown", () => {
    assert.deepEqual(flagPolicyProblems(policy, population), []);
  });

  it("every ON entry has a one-line reason and evidence that resolves to a record", () => {
    for (const e of policy.flags.filter((x) => x.enabled)) {
      assert.ok(e.reason.trim() && !e.reason.includes("\n"), e.flag);
      assert.ok(e.evidence.length > 0, `${e.flag}: ON without evidence`);
      for (const id of e.evidence) assert.equal(evidenceProblem(id), null, `${e.flag}: ${id}`);
    }
  });

  it("every evidence id anywhere in the policy resolves", () => {
    for (const e of policy.flags) for (const id of e.evidence) assert.equal(evidenceProblem(id), null, `${e.flag}: ${id}`);
  });

  it("closes sign-up: invite_only_beta ON and the disable_signups stop ENGAGED", () => {
    assert.equal(byFlag.get("invite_only_beta")?.enabled, true);
    assert.equal(byFlag.get("disable_signups")?.enabled, true);
    assert.equal(byFlag.get("disable_signups")?.kind, "STOP");
  });

  it("Rent-a-Buddy booking and payments are OFF: every booking stop engaged, every capability off", () => {
    assert.equal(byFlag.get("disable_rent_buddy_booking")?.enabled, true);
    assert.equal(byFlag.get("disable_rab_bookings")?.enabled, true);
    assert.equal(byFlag.get("RENT_BUDDY_ADMIN_ONLY_MODE")?.enabled, true);
    for (const e of policy.flags) {
      if (/rent_buddy|RENT_BUDDY|wall_rab|discovery_buddy/.test(e.flag) && e.kind === "CAPABILITY") {
        assert.equal(e.enabled, false, `${e.flag} must be OFF`);
      }
    }
    assert.equal(byFlag.get("rent_buddy_allow_bookings_without_kyc")?.enabled, false);
  });

  it("layover presence intents OFF (min-k prerequisite); every retention purge OFF", () => {
    assert.equal(byFlag.get("layover_presence_intents_enabled")?.enabled, false);
    for (const e of policy.flags) {
      if (/retention|purge/i.test(e.flag)) assert.equal(e.enabled, false, e.flag);
    }
  });

  it("kinds follow the repo's convention: disable_* / *_disabled are STOP, lower-case *_enabled CAPABILITY", () => {
    for (const e of policy.flags) {
      if (/^disable_|_disabled$/.test(e.flag)) assert.equal(e.kind, "STOP", e.flag);
      if (/^[a-z0-9_]+_enabled$/.test(e.flag)) assert.equal(e.kind, "CAPABILITY", e.flag);
    }
  });

  it("no flag is ON for a reason the policy cannot name: every ON flag is a safety control, a protection, or evidenced", () => {
    const on = policy.flags.filter((e) => e.enabled).map((e) => e.flag).sort();
    assert.deepEqual(on, [
      "RENT_BUDDY_ADMIN_ONLY_MODE",
      "disable_intel_live_labels",
      "disable_rab_bookings",
      "disable_rent_buddy_booking",
      "disable_signups",
      "invite_only_beta",
      "media_private_buckets_enabled",
    ], "the ON set changed: re-read docs in the PR and the lead's review of the rationale before updating this list");
  });

  it("population scan: a DELETE retires, a later re-seed brings back", () => {
    const files: Record<string, string> = {
      "0001_a.sql": "INSERT INTO public.feature_flags (flag, enabled, description) VALUES ('x_enabled', false, 'a; b'), ('y_enabled', true, 'c');",
      "0002_b.sql": "-- DELETE FROM feature_flags WHERE flag = 'y_enabled';\nDELETE FROM public.feature_flags WHERE flag IN ('x_enabled');",
      "0003_c.sql": "INSERT INTO feature_flags (flag, enabled) VALUES ('x_enabled', true) ON CONFLICT DO NOTHING;",
    };
    const p = seededFlagPopulation(Object.keys(files), (f) => files[f]);
    assert.deepEqual([...p.keys()].sort(), ["x_enabled", "y_enabled"]);
    assert.equal(p.get("x_enabled")?.seededIn, "0003_c.sql:1");
    assert.equal(p.get("y_enabled")?.seededValue, true, "a commented DELETE retires nothing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STEP, AGAINST A STUBBED MANAGEMENT API
// ─────────────────────────────────────────────────────────────────────────────

const TINY_POPULATION: ReadonlyMap<string, SeededFlag> = new Map(
  ["disable_signups", "invite_only_beta", "rent_buddy_enabled", "stories_enabled"].map((f) => [f, { flag: f, seededIn: "x.sql:1", seededValue: false }]),
);
const TINY_POLICY: FlagPolicy = {
  format: "portava-beta-flag-policy/1",
  project_ref: BETA_PROJECT_REF,
  flags: [
    { flag: "disable_signups", enabled: true, kind: "STOP", reason: "engaged", evidence: ["OD-PAY-11"] },
    { flag: "invite_only_beta", enabled: true, kind: "CAPABILITY", reason: "on", evidence: ["OD-PAY-11"] },
    { flag: "rent_buddy_enabled", enabled: false, kind: "CAPABILITY", reason: "off", evidence: [] },
    { flag: "stories_enabled", enabled: false, kind: "CAPABILITY", reason: "off", evidence: [] },
  ],
};

interface Call { method: string; path: string; body: any }

/** A Management API double with a tiny feature_flags table and an auth config. */
function stubApi(opts: {
  flags?: Record<string, boolean>;
  auth?: Record<string, unknown>;
  /** What GET /config/auth returns after a PATCH (default: what was patched). */
  authAfterPatch?: (patched: any) => Record<string, unknown>;
  /** Mutate the flags just after the apply (to simulate a read-back mismatch). */
  afterApply?: (flags: Record<string, boolean>) => void;
}) {
  const calls: Call[] = [];
  const flags = { ...(opts.flags ?? { disable_signups: false, invite_only_beta: false, rent_buddy_enabled: true, stories_enabled: false }) };
  let auth: Record<string, unknown> = { ...(opts.auth ?? { disable_signup: false, site_url: "http://localhost:3000", uri_allow_list: "" }) };
  const audit: Array<{ flag: string; old: boolean; new: boolean }> = [];
  const fetch: FetchLike = async (url, init) => {
    const path = url.replace(`https://api.supabase.com/v1/projects/${BETA_PROJECT_REF}`, "");
    assert.ok(url.startsWith(`https://api.supabase.com/v1/projects/${BETA_PROJECT_REF}/`), `request to ${url}`);
    assert.match(init.headers.Authorization, /^Bearer /);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, body });
    const reply = (x: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
    if (path === "/config/auth" && init.method === "PATCH") {
      auth = opts.authAfterPatch ? opts.authAfterPatch(body) : { ...auth, ...body };
      return reply(auth);
    }
    if (path === "/config/auth" && init.method === "GET") return reply(auth);
    if (path === "/database/query") {
      const q: string = body.query;
      if (q.startsWith("SELECT flag, enabled FROM public.feature_flags")) {
        return reply(Object.entries(flags).sort().map(([flag, enabled]) => ({ flag, enabled })));
      }
      if (q.startsWith("WITH changed AS (")) {
        const on = new Set([...q.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
        const flipped: string[] = [];
        for (const f of Object.keys(flags)) {
          const to = on.has(f);
          if (flags[f] !== to) { audit.push({ flag: f, old: flags[f], new: to }); flags[f] = to; flipped.push(f); }
        }
        opts.afterApply?.(flags);
        return reply(flipped.sort().map((flag) => ({ flag })));
      }
    }
    return { ok: false, status: 404, text: async () => `no stub for ${init.method} ${path}` };
  };
  return { fetch, calls, flags, audit, get auth() { return auth; } };
}

const quiet = { log: () => {}, error: () => {} };
function run(api: ReturnType<typeof stubApi>, over: { argv?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const errors: string[] = [];
  return runBetaConfigure({
    argv: over.argv ?? ["--confirm=CONFIGURE-BETA"],
    env: over.env ?? { SUPABASE_URL: BETA_URL, SUPABASE_PROJECT_TOKEN: "sbp_test_token" },
    fetch: api.fetch,
    policy: TINY_POLICY,
    population: TINY_POPULATION,
    log: quiet.log,
    error: (l) => errors.push(l),
  }).then((code) => ({ code, errors }));
}

describe("beta-configure — the right calls, in order", () => {
  it("PATCHes auth with exactly the three fields, reads it back, sets every flag in one statement, reads back", async () => {
    const api = stubApi({});
    const { code, errors } = await run(api);
    assert.equal(code, 0, errors.join("\n"));
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [
      "PATCH /config/auth",
      "GET /config/auth",
      "POST /database/query",
      "POST /database/query",
      "POST /database/query",
    ]);
    assert.deepEqual(api.calls[0].body, BETA_AUTH_CONFIG);
    assert.deepEqual(Object.keys(api.calls[0].body).sort(), ["disable_signup", "site_url", "uri_allow_list"]);
    assert.equal(api.calls[0].body.disable_signup, true);
    // the resulting state
    assert.deepEqual(api.flags, { disable_signups: true, invite_only_beta: true, rent_buddy_enabled: false, stories_enabled: false });
    assert.deepEqual(api.audit.map((a) => a.flag).sort(), ["disable_signups", "invite_only_beta", "rent_buddy_enabled"]);
    assert.equal(api.auth.disable_signup, true);
  });

  it("a database flag the policy does not name is forced OFF and the read-back expects it off", async () => {
    const api = stubApi({ flags: { disable_signups: false, invite_only_beta: false, rent_buddy_enabled: false, stories_enabled: false, hand_inserted_enabled: true } });
    const { code } = await run(api);
    assert.equal(code, 0);
    assert.equal(api.flags.hand_inserted_enabled, false);
  });

  it("--dry-run reads, plans, and writes nothing", async () => {
    const api = stubApi({});
    const { code } = await run(api, { argv: ["--confirm=CONFIGURE-BETA", "--dry-run"] });
    assert.equal(code, 0);
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["GET /config/auth", "POST /database/query"]);
    assert.equal(api.flags.invite_only_beta, false);
  });
});

describe("beta-configure — refusals send nothing", () => {
  for (const [name, url] of [["portava-ci", CI_URL], ["production", PROD_URL], ["no URL", undefined]] as const) {
    it(`a non-beta target (${name}) exits 2 with zero requests`, async () => {
      const api = stubApi({});
      const { code, errors } = await run(api, { env: { SUPABASE_URL: url, SUPABASE_PROJECT_TOKEN: "sbp_test_token" } });
      assert.equal(code, 2);
      assert.equal(api.calls.length, 0);
      assert.match(errors.join("\n"), /REFUSED/);
    });
  }

  it("no token → exit 2, zero requests", async () => {
    const api = stubApi({});
    const { code } = await run(api, { env: { SUPABASE_URL: BETA_URL } });
    assert.equal(code, 2);
    assert.equal(api.calls.length, 0);
  });

  it("no or wrong typed confirmation → exit 2, zero requests", async () => {
    for (const argv of [[], ["--confirm=configure-beta"], ["--confirm"]]) {
      const api = stubApi({});
      const { code } = await run(api, { argv });
      assert.equal(code, 2, JSON.stringify(argv));
      assert.equal(api.calls.length, 0);
    }
  });

  it("a policy that does not match the migrations → exit 2, zero requests", async () => {
    const api = stubApi({});
    const code = await runBetaConfigure({
      argv: ["--confirm=CONFIGURE-BETA"], env: { SUPABASE_URL: BETA_URL, SUPABASE_PROJECT_TOKEN: "t" }, fetch: api.fetch,
      policy: { ...TINY_POLICY, flags: TINY_POLICY.flags.slice(1) }, population: TINY_POPULATION, ...quiet,
    });
    assert.equal(code, 2);
    assert.equal(api.calls.length, 0);
  });
});

describe("beta-configure — read-backs that differ fail", () => {
  it("auth read-back differs (disable_signup did not stick) → exit 1, and no flag is touched", async () => {
    const api = stubApi({ authAfterPatch: (b) => ({ ...b, disable_signup: false }) });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /disable_signup/);
    assert.ok(!api.calls.some((c) => c.path === "/database/query"), "flags must not be written after a failed auth read-back");
  });

  it("auth read-back with a missing redirect → exit 1", async () => {
    const api = stubApi({ authAfterPatch: (b) => ({ ...b, uri_allow_list: "travelbuddy://**" }) });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /uri_allow_list/);
  });

  it("flag read-back differs → exit 1", async () => {
    const api = stubApi({ afterApply: (f) => { f.invite_only_beta = false; } });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /invite_only_beta: reads false, policy says true/);
  });

  it("a policy flag missing from the database → exit 1 with NOTHING written", async () => {
    const api = stubApi({ flags: { disable_signups: false, rent_buddy_enabled: false, stories_enabled: false } });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /invite_only_beta/);
    assert.ok(!api.calls.some((c) => c.body?.query?.startsWith("WITH changed AS (")), "no apply after a missing row");
  });

  it("a 403 from the Management API names the token and exits 1", async () => {
    const api = stubApi({});
    const forbidden: FetchLike = async () => ({ ok: false, status: 403, text: async () => '{"message":"forbidden"}' });
    const code = await runBetaConfigure({
      argv: ["--confirm=CONFIGURE-BETA"], env: { SUPABASE_URL: BETA_URL, SUPABASE_PROJECT_TOKEN: "t" }, fetch: forbidden,
      policy: TINY_POLICY, population: TINY_POPULATION, log: () => {}, error: (l) => assert.match(l, /BETA_SUPABASE_PROJECT_TOKEN/),
    });
    assert.equal(code, 1);
    assert.equal(api.calls.length, 0);
  });
});

describe("pure pieces", () => {
  it("buildFlagApplySql refuses an unsafe flag name and audits inside the same statement", () => {
    assert.throws(() => buildFlagApplySql(["x'; DROP TABLE y; --"]));
    const sql = buildFlagApplySql(["a_enabled"]);
    assert.match(sql, /UPDATE public\.feature_flags SET enabled = \(flag = ANY\(ARRAY\['a_enabled'\]::text\[\]\)\)/);
    assert.match(sql, /INSERT INTO public\.feature_flag_audit_log/);
  });

  it("authConfigProblems compares the allow list as a set", () => {
    assert.deepEqual(authConfigProblems({ ...BETA_AUTH_CONFIG, uri_allow_list: BETA_AUTH_CONFIG.uri_allow_list.split(",").reverse().join(", ") }), []);
    assert.equal(authConfigProblems({ ...BETA_AUTH_CONFIG, uri_allow_list: `${BETA_AUTH_CONFIG.uri_allow_list},https://evil.example/**` }).length, 1);
  });

  it("planFlagApply: missing, unknown and changes", () => {
    const p = planFlagApply([{ flag: "invite_only_beta", enabled: false }, { flag: "zzz", enabled: true }], TINY_POLICY);
    assert.deepEqual(p.missing, ["disable_signups", "rent_buddy_enabled", "stories_enabled"]);
    assert.deepEqual(p.unknown, ["zzz"]);
    assert.deepEqual(p.changes, [{ flag: "invite_only_beta", from: false, to: true }, { flag: "zzz", from: true, to: false }]);
  });
});
