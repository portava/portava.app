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
import { applyPolicySync, flagKindOf, planPolicySync, serializePolicy } from "./beta-flag-policy-sync.js";
import { PROFILES_CLIENT_GRANT_SQL, PROFILES_NEVER_READ, profilesGrantProblems } from "./beta-config-core.js";

const BETA_URL = `https://${BETA_PROJECT_REF}.supabase.co`;
const CI_URL = "https://hwokxgbmezheskbzskfr.supabase.co";
const PROD_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;

// ─────────────────────────────────────────────────────────────────────────────
// THE REAL POLICY AGAINST THE REAL MIGRATIONS
// ─────────────────────────────────────────────────────────────────────────────

const population = seededFlagPopulation();
const policy = loadFlagPolicy();
const byFlag = new Map(policy.flags.map((e) => [e.flag, e]));

const LEAD_RULINGS = readFileSync(join(REPO_ROOT, "docs/ops/lead-rulings-20261006.md"), "utf8");
const OWNER_DECISIONS = readFileSync(join(REPO_ROOT, "docs/ops/owner-decisions-20261004.md"), "utf8");

const SNAPSHOT_DIR = join(REPO_ROOT, "artifacts/api-server/src/lib/capability/snapshots");
const PRODUCTION_SNAPSHOT = "20260922-production-schema.json";
const PRODUCTION_FLAGS = (JSON.parse(readFileSync(join(SNAPSHOT_DIR, PRODUCTION_SNAPSHOT), "utf8")) as { flags: Record<string, boolean> }).flags;
const RENT_A_BUDDY = /^(rent_buddy|RENT_BUDDY|wall_rab|discovery_buddy)/;
/**
 * Flags a migration NEWER than the production snapshot turns on (seeds TRUE or UPDATEs to TRUE) — absent from the
 * snapshot, so "mirror production" cannot decide them. Each needs an explicit decision here; a new one turns the
 * test below red until it is added (verifier F6).
 */
const POST_SNAPSHOT_SEEDED_TRUE = new Map<string, { on: boolean; why: string }>([
  ["layover_crowd_reports_enabled", { on: true, why: "3513 seeds it TRUE as production's default; lead decision 2026-10-06" }],
  ["discovery_serve_log_retention_enabled", { on: false, why: "3501 seeds it TRUE, but its 30-day period (Q11(a)) awaits legal review; held OFF, so beta's serve log is unbounded" }],
]);
const DECISION_GATED = [
  "layover_presence_intents_enabled", "discovery_dwell_telemetry_enabled", "discovery_trending_api_enabled",
  "discovery_trend_lists_enabled", "creator_attribution_enabled", "account_deletion_worker_enabled",
];
const MIGRATIONS = join(REPO_ROOT, "artifacts/api-server/src/migrations");

/** The text of a census section: from its heading (`## §AB …` or `## 4. …`) to the next heading of that level or higher. */
function censusSection(text: string, section: string): string | null {
  const lines = text.split("\n");
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^(#{1,6}) (§${esc}\\b|${esc}\\. )`).test(l));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start])![0].length;
  let end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && /^#+/.exec(l)![0].length <= level);
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n");
}

/** Does `text` name `flag`, literally or through a `prefix_*` wildcard such as `shared_moments_*`? */
function names(text: string, flag: string): boolean {
  if (text.includes(flag)) return true;
  return [...text.matchAll(/`([A-Za-z0-9_]+_)\*`/g)].some((m) => flag.startsWith(m[1]));
}

/**
 * null when an evidence id resolves to a record in the repo FOR THIS ENTRY; otherwise why not.
 *   OD-*                     a heading in docs/ops/owner-decisions-20261004.md
 *   D-nn[a-d]                a ruling in docs/ops/lead-rulings-20261006.md
 *   census-<name>:<ROW>      a table row `| ROW |` in that census
 *   census-<name>:§<S>       a section of that census that NAMES the flag
 *   migration:<file>         a canonical migration that SEEDS the flag TRUE (the policy's own seed matcher)
 *   snapshot:<file>          a production snapshot recording the flag with the entry's own value
 *   test:<repo path>         a test file that exists
 */
function evidenceProblem(id: string, entry: { flag: string; enabled: boolean } = { flag: "", enabled: true }): string | null {
  if (/^OD-[A-Z]+-\d+$/.test(id)) return OWNER_DECISIONS.includes(`**${id} `) ? null : `${id} is not in docs/ops/owner-decisions-20261004.md`;
  if (/^D-\d+[a-d]?$/.test(id)) {
    return new RegExp(`^(## |- \\*\\*)${id}:`, "m").test(LEAD_RULINGS) ? null : `${id} is not in docs/ops/lead-rulings-20261006.md`;
  }
  const sec = /^census-([a-z-]+):§([A-Za-z0-9.-]+)$/.exec(id);
  if (sec) {
    const path = join(REPO_ROOT, "docs/architecture", `census-${sec[1]}.md`);
    if (!existsSync(path)) return `${id}: no such census`;
    const body = censusSection(readFileSync(path, "utf8"), sec[2]);
    if (body === null) return `${id}: no such section`;
    return names(body, entry.flag) ? null : `${id}: the section does not name ${entry.flag}`;
  }
  const m = /^census-([a-z-]+):([A-Za-z0-9.-]+)$/.exec(id);
  if (m) {
    const path = join(REPO_ROOT, "docs/architecture", `census-${m[1]}.md`);
    if (!existsSync(path)) return `${id}: no such census`;
    return new RegExp(`^\\| ${m[2].replace(/[.]/g, "\\.")} \\|`, "m").test(readFileSync(path, "utf8")) ? null : `${id}: no such row`;
  }
  const mig = /^migration:([A-Za-z0-9_.-]+\.sql)$/.exec(id);
  if (mig) {
    const path = join(MIGRATIONS, mig[1]);
    if (!existsSync(path)) return `${id}: no such canonical migration`;
    const seeded = seededFlagPopulation([mig[1]], () => readFileSync(path, "utf8")).get(entry.flag);
    return seeded?.seededValue === true ? null : `${id} does not seed ${entry.flag} TRUE`;
  }
  const snap = /^snapshot:([A-Za-z0-9_.-]+\.json)$/.exec(id);
  if (snap) {
    const path = join(SNAPSHOT_DIR, snap[1]);
    if (!existsSync(path)) return `${id}: no such snapshot`;
    const json = JSON.parse(readFileSync(path, "utf8")) as { projectRef?: string; flags?: Record<string, unknown> };
    if (json.projectRef !== PRODUCTION_PROJECT_REF) return `${id} is not a production snapshot`;
    if (!json.flags || !(entry.flag in json.flags)) return `${id} does not record ${entry.flag}`;
    return json.flags[entry.flag] === entry.enabled ? null : `${id} records ${entry.flag}=${String(json.flags[entry.flag])}, the policy says ${entry.enabled}`;
  }
  const t = /^test:([A-Za-z0-9_./-]+\.test\.tsx?)$/.exec(id);
  if (t) return existsSync(join(REPO_ROOT, t[1])) ? null : `${id}: no such test file`;
  return `${id} is not an evidence id (census-<name>:<ROW>|§<S>, OD-*, D-nn, migration:, snapshot:, test:)`;
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
      for (const id of e.evidence) assert.equal(evidenceProblem(id, e), null, `${e.flag}: ${id}`);
    }
  });

  it("every evidence id anywhere in the policy resolves", () => {
    for (const e of policy.flags) for (const id of e.evidence) assert.equal(evidenceProblem(id, e), null, `${e.flag}: ${id}`);
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

  it("the decision-gated flags stay OFF; a retention purge is ON only where production runs it", () => {
    for (const f of DECISION_GATED) assert.equal(byFlag.get(f)?.enabled, false, `${f} is decision-gated`);
    // Lead decision 2026-10-06 (mirror production): a purge production runs is mirrored; every other purge,
    // whose legal period is undecided, stays OFF as the brief required.
    for (const e of policy.flags) {
      if (/retention|purge/i.test(e.flag) && e.enabled) {
        assert.equal(PRODUCTION_FLAGS[e.flag], true, `${e.flag} is ON but production does not run it`);
      }
    }
    assert.equal(byFlag.get("discovery_serve_log_retention_enabled")?.enabled, false, "Q11(a): 30 days pending legal review");
  });

  it("every flag a post-snapshot migration turns on is decided explicitly, and the policy follows that decision", () => {
    const found = [...population.values()].filter((x) => x.everSetTrue && !(x.flag in PRODUCTION_FLAGS)).map((x) => x.flag).sort();
    assert.deepEqual(found, [...POST_SNAPSHOT_SEEDED_TRUE.keys()].sort(),
      "a migration newer than the 2026-09-22 snapshot turns a flag on: decide it in POST_SNAPSHOT_SEEDED_TRUE (and the policy) explicitly");
    for (const [flag, d] of POST_SNAPSHOT_SEEDED_TRUE) assert.equal(byFlag.get(flag)?.enabled, d.on, `${flag}: ${d.why}`);
  });

  it("STOP parity: every stop production has engaged is engaged on beta", () => {
    const stopsRecorded = Object.keys(PRODUCTION_FLAGS).filter((f) => byFlag.get(f)?.kind === "STOP");
    // Not vacuous: the snapshot records every STOP (17 on 2026-09-22, none engaged). A later snapshot that records
    // one engaged makes this demand it here too.
    assert.ok(stopsRecorded.length >= 17, `only ${stopsRecorded.length} STOP flags in the snapshot`);
    for (const flag of stopsRecorded) {
      if (PRODUCTION_FLAGS[flag] === true) assert.equal(byFlag.get(flag)?.enabled, true, flag);
    }
  });

  it("kinds follow the repo's convention: disable_* / *_disabled are STOP, lower-case *_enabled CAPABILITY", () => {
    for (const e of policy.flags) {
      if (/^disable_|_disabled$/.test(e.flag)) assert.equal(e.kind, "STOP", e.flag);
      if (/^[a-z0-9_]+_enabled$/.test(e.flag)) assert.equal(e.kind, "CAPABILITY", e.flag);
    }
  });

  it("the ON set is exactly the reviewed one: the safety controls, plus production's TRUE flags minus the named exceptions", () => {
    // Lead decision 2026-10-06: mirror production fully — every flag the committed 2026-09-22 production snapshot
    // records TRUE is ON, except the exceptions below; plus the beta safety controls; plus the flags migrations
    // seed TRUE that are newer than the snapshot. Changing any of these sets is a review decision, not a refresh.
    const SAFETY = [
      "RENT_BUDDY_ADMIN_ONLY_MODE", "disable_intel_live_labels", "disable_rab_bookings", "disable_rent_buddy_booking",
      "disable_signups", "invite_only_beta",
    ];
    const SEEDED_TRUE_NEWER_THAN_SNAPSHOT = [...POST_SNAPSHOT_SEEDED_TRUE].filter(([, d]) => d.on).map(([f]) => f);
    const EXCEPTIONS = new Map<string, string>([
      ...policy.flags.filter((e) => RENT_A_BUDDY.test(e.flag) && e.kind === "CAPABILITY").map((e) => [e.flag, "(1) Rent-a-Buddy blocked by design"] as [string, string]),
      ["push_notifications_enabled", "(2) no Expo push credentials for the beta build yet"],
      ...DECISION_GATED.map((f) => [f, "(3) decision-gated"] as [string, string]),
      ["COMPASS_ACTIVE_REWARDS_ENABLED", "(4) N-6's surface, open on main"],
    ]);
    const expected = new Set<string>(SAFETY);
    for (const f of SEEDED_TRUE_NEWER_THAN_SNAPSHOT) { assert.ok(!(f in PRODUCTION_FLAGS), f); expected.add(f); }
    for (const [flag, value] of Object.entries(PRODUCTION_FLAGS)) {
      if (value === true && population.has(flag) && !EXCEPTIONS.has(flag)) expected.add(flag);
    }
    const on = policy.flags.filter((e) => e.enabled).map((e) => e.flag).sort();
    assert.deepEqual(on, [...expected].sort(), "the ON set changed: re-read the rationale and the lead's review before updating this rule");
    assert.equal(on.length, 108, "pinned count (lead decision 2026-10-06): 6 safety controls + 101 production-TRUE flags + 1 newer seeded-TRUE flag");
    for (const f of EXCEPTIONS.keys()) assert.equal(byFlag.get(f)?.enabled ?? false, false, `${f}: ${EXCEPTIONS.get(f)}`);
    assert.equal(byFlag.get("COMPASS_FALLBACK_MODE_ENABLED")?.enabled, false, "production reads FALSE");
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
    const q = seededFlagPopulation(["a.sql", "b.sql"], (f) => ({
      "a.sql": "INSERT INTO public.feature_flags (flag, enabled) VALUES ('z_enabled', false), ('w_enabled', false);",
      "b.sql": "UPDATE public.feature_flags SET enabled = true WHERE flag = 'z_enabled';\n-- UPDATE feature_flags SET enabled = true WHERE flag = 'w_enabled';\nUPDATE feature_flags SET enabled = false WHERE flag = 'w_enabled';",
    } as Record<string, string>)[f]);
    assert.equal(q.get("z_enabled")?.everSetTrue, true, "an UPDATE … SET enabled = true turns it on");
    assert.equal(q.get("w_enabled")?.everSetTrue, false, "a commented or a FALSE update does not");
    // verifier N6: `enabled = true` later in the SET list, and `WHERE flag LIKE`.
    const r = seededFlagPopulation(["a.sql", "b.sql"], (f) => ({
      "a.sql": "INSERT INTO feature_flags (flag, enabled) VALUES ('m_enabled', false), ('wall_a_enabled', false), ('wall_b_enabled', false), ('wallx_enabled', false), ('n_enabled', false), ('o_enabled', false);",
      "b.sql": [
        "UPDATE public.feature_flags SET metadata = '{\"rollout\":1}', updated_at = now(), enabled = true WHERE flag = 'm_enabled';",
        "UPDATE feature_flags SET enabled = true WHERE flag LIKE 'wall\\_%';",
        "UPDATE feature_flags SET description = 'foo, enabled = true' WHERE flag = 'n_enabled';",
        "UPDATE feature_flags SET enabled = true, metadata = '{}' WHERE flag ILIKE 'O\\_ENABLED';",
      ].join("\n"),
    } as Record<string, string>)[f]);
    assert.equal(r.get("m_enabled")?.everSetTrue, true, "SET …, enabled = true");
    assert.equal(r.get("wall_a_enabled")?.everSetTrue, true, "WHERE flag LIKE 'wall\\_%'");
    assert.equal(r.get("wall_b_enabled")?.everSetTrue, true);
    assert.equal(r.get("wallx_enabled")?.everSetTrue, false, "the escaped underscore is literal");
    assert.equal(r.get("n_enabled")?.everSetTrue, false, "'enabled = true' inside a string literal is not a SET");
    assert.equal(r.get("o_enabled")?.everSetTrue, true, "ILIKE is case-insensitive");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE STEP, AGAINST A STUBBED MANAGEMENT API
// ─────────────────────────────────────────────────────────────────────────────

const TINY_POPULATION: ReadonlyMap<string, SeededFlag> = new Map(
  ["disable_signups", "invite_only_beta", "rent_buddy_enabled", "stories_enabled"].map((f) => [f, { flag: f, seededIn: "x.sql:1", seededValue: false, everSetTrue: false }]),
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
  /** What the profiles client-grant read (3740) answers. Default: the boundary holds. */
  profilesGrant?: Record<string, unknown>;
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
      if (q.startsWith("SELECT to_regclass('public.profiles') IS NOT NULL AS profiles_exists")) {
        return reply([opts.profilesGrant ?? { profiles_exists: true, findings: [] }]);
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
  it("reads and plans the flags FIRST, then PATCHes auth (three fields), reads it back, applies the flags in one statement, reads back", async () => {
    const api = stubApi({});
    const { code, errors } = await run(api);
    assert.equal(code, 0, errors.join("\n"));
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [
      "POST /database/query",
      "PATCH /config/auth",
      "GET /config/auth",
      "POST /database/query",
      "POST /database/query",
      "POST /database/query",
    ]);
    assert.match(api.calls[5].body.query, /^SELECT to_regclass\('public\.profiles'\) IS NOT NULL AS profiles_exists/, "the 3740 grant read is last");
    assert.match(api.calls[0].body.query, /^SELECT flag, enabled FROM public\.feature_flags/, "the first request is the read, before any write");
    assert.match(api.calls[3].body.query, /^WITH changed AS \(/);
    assert.deepEqual(api.calls[1].body, BETA_AUTH_CONFIG);
    assert.deepEqual(Object.keys(api.calls[1].body).sort(), ["disable_signup", "site_url", "uri_allow_list"]);
    assert.equal(api.calls[1].body.disable_signup, true);
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
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["POST /database/query", "GET /config/auth", "POST /database/query"]);
    assert.ok(!api.calls.some((c) => c.method === "PATCH"), "a dry run never PATCHes");
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
  it("auth read-back differs (disable_signup did not stick) → exit 1, and no flag is written", async () => {
    const api = stubApi({ authAfterPatch: (b) => ({ ...b, disable_signup: false }) });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /disable_signup/);
    assert.ok(!api.calls.some((c) => c.body?.query?.startsWith("WITH changed AS (")), "flags must not be written after a failed auth read-back");
    assert.deepEqual(api.audit, []);
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

  it("a policy flag missing from the database → exit 1 with NOTHING written: zero PATCH, zero flag writes (verifier F2)", async () => {
    const api = stubApi({ flags: { disable_signups: false, rent_buddy_enabled: false, stories_enabled: false } });
    const authBefore = { ...api.auth };
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /invite_only_beta/);
    assert.match(errors.join("\n"), /Nothing was written — neither Auth nor any flag/);
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["POST /database/query"], "only the read happened");
    assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 0, "Auth must not be PATCHed before the plan is known");
    assert.ok(!api.calls.some((c) => c.body?.query?.startsWith("WITH changed AS (")), "no apply after a missing row");
    assert.deepEqual(api.auth, authBefore, "Auth config unchanged");
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

// ─────────────────────────────────────────────────────────────────────────────
// beta-flag-policy-sync.ts (lane BETA2, 2026-10-07): the merge-time helper that
// keeps the policy complete without ever deciding a flag ON.
// ─────────────────────────────────────────────────────────────────────────────
describe("beta-flag-policy-sync — new flags OFF, retired flags out, anything turned ON refused", () => {
  const seeded = (flag: string, value = false, everSetTrue = value, seededIn = "9999_x.sql:1"): SeededFlag => ({ flag, seededIn, seededValue: value, everSetTrue });
  const withPop = (extra: SeededFlag[], drop: string[] = []) => {
    const m = new Map(population);
    for (const f of drop) m.delete(f);
    for (const s of extra) m.set(s.flag, s);
    return m;
  };

  it("on this tree the policy is in sync, and its committed bytes are exactly the serializer's form", () => {
    const plan = planPolicySync(policy, population);
    assert.deepEqual(plan, { add: [], remove: [], refuse: [] });
    const committed = readFileSync(join(REPO_ROOT, "scripts/src/beta-flag-policy.json"), "utf8");
    assert.equal(serializePolicy(policy), committed, "a write would re-encode untouched entries");
  });

  it("a merged lane's FALSE-seeded flags are added OFF with a reason and no evidence, a retired flag is removed (lane B's shape)", () => {
    // origin/claude/mission-b-payments-identity-trust-20261005: 3823 seeds payment_ledger_reads_enabled FALSE,
    // 3932 retires rent_buddy_allow_bookings_without_kyc.
    const pop = withPop([seeded("payment_ledger_reads_enabled", false, false, "3823_payment_attribution_and_scoped_reads.sql:512")], ["rent_buddy_allow_bookings_without_kyc"]);
    const plan = planPolicySync(policy, pop);
    assert.deepEqual(plan.refuse, []);
    assert.deepEqual(plan.remove, ["rent_buddy_allow_bookings_without_kyc"]);
    assert.equal(plan.add.length, 1);
    const e = plan.add[0];
    assert.deepEqual([e.flag, e.kind, e.enabled, e.evidence], ["payment_ledger_reads_enabled", "CAPABILITY", false, []]);
    assert.match(e.reason, /^OFF: seeded FALSE by 3823_payment_attribution_and_scoped_reads\.sql:512/);
    const next = applyPolicySync(policy, plan);
    // the result satisfies the same structural rules the real policy is held to, against the new population
    assert.deepEqual(flagPolicyProblems(next, pop), []);
    assert.equal(next.flags.filter((x) => x.enabled).length, policy.flags.filter((x) => x.enabled).length, "nothing turned ON");
    const names = next.flags.map((x) => x.flag);
    assert.deepEqual(names, [...names].sort(), "sorted by name, as committed");
    // a write changes only the added and removed entries
    const before = serializePolicy(policy).split("\n");
    const after = serializePolicy(next).split("\n");
    assert.ok(Math.abs(after.length - before.length) <= 7 + 7, `${before.length} -> ${after.length} lines`);
  });

  it("a STOP-named new flag is added as a disengaged STOP", () => {
    const plan = planPolicySync(policy, withPop([seeded("disable_new_thing")]));
    assert.deepEqual(plan.add.map((e) => [e.flag, e.kind, e.enabled]), [["disable_new_thing", "STOP", false]]);
  });

  it("REFUSED, nothing written: a new flag any migration turns ON (TRUE seed, or an UPDATE … SET enabled = true)", () => {
    for (const s of [seeded("shiny_enabled", true, true), seeded("sneaky_enabled", false, true)]) {
      const plan = planPolicySync(policy, withPop([s]));
      assert.deepEqual(plan.add, []);
      assert.equal(plan.refuse.length, 1);
      assert.match(plan.refuse[0].why, /POST_SNAPSHOT_SEEDED_TRUE/);
      assert.throws(() => applyPolicySync(policy, plan), /refusing to write/);
    }
  });

  it("REFUSED: a new flag whose kind is unreadable; the polarity file's CLASSIFIED decides kinds outside the conventions", () => {
    const plan = planPolicySync(policy, withPop([seeded("SOME_MODE")]), () => null);
    assert.equal(plan.refuse.length, 1);
    assert.equal(flagKindOf("RENT_BUDDY_ADMIN_ONLY_MODE"), "STOP");
    assert.equal(flagKindOf("invite_only_beta"), "CAPABILITY");
    assert.equal(flagKindOf("NOT_A_FLAG_ANYWHERE"), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The profiles client grant (migration 3740, PR #647; lane BETA2, 2026-10-07)
// ─────────────────────────────────────────────────────────────────────────────
describe("beta-configure step f — no tester account on a database where the anon key reaches profiles' personal columns", () => {
  it("the boundary holds: PASSED, and the read is read-only SQL (no write verb)", async () => {
    const api = stubApi({});
    const { code, errors } = await run(api);
    assert.equal(code, 0, errors.join("\n"));
    const q = api.calls[5].body.query as string;
    const code_ = q.replace(/'(?:[^']|'')*'/g, "''"); // string literals ('SELECT', 'UPDATE' privilege names) masked
    assert.match(code_, /^SELECT /);
    assert.ok(!code_.includes(";"), "one statement");
    assert.doesNotMatch(code_, /\b(INSERT|UPDATE|DELETE|GRANT|REVOKE|ALTER|DROP|CREATE|TRUNCATE)\b/i, "step f only reads");
  });

  it("FAILS (exit 1) while anon holds TABLE-level SELECT on profiles — after sign-up was closed and the flags were set", async () => {
    const api = stubApi({ profilesGrant: { profiles_exists: true, findings: ["anon holds TABLE-level SELECT", "anon can SELECT date_of_birth"] } });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    const msg = errors.join("\n");
    assert.match(msg, /NOT ready for tester accounts/);
    assert.match(msg, /anon holds TABLE-level SELECT/);
    assert.match(msg, /3740 \(PR #647\)/);
    // the protective writes still landed: sign-up closed and the policy applied
    assert.equal(api.auth.disable_signup, true);
    assert.equal(api.flags.invite_only_beta, true);
  });

  it("FAILS when the read answers as a JSON string too (the query endpoint's other shape), and when profiles is absent", async () => {
    const asString = stubApi({ profilesGrant: { profiles_exists: "t", findings: JSON.stringify(["authenticated holds TABLE-level UPDATE"]) } });
    assert.equal((await run(asString)).code, 1);
    const absent = stubApi({ profilesGrant: { profiles_exists: false, findings: [] } });
    const r = await run(absent);
    assert.equal(r.code, 1);
    assert.match(r.errors.join("\n"), /does not exist/);
  });

  it("--dry-run reports the finding and still writes nothing", async () => {
    const api = stubApi({ profilesGrant: { profiles_exists: true, findings: ["anon holds TABLE-level SELECT"] } });
    const lines: string[] = [];
    const code = await runBetaConfigure({
      argv: ["--confirm=CONFIGURE-BETA", "--dry-run"], env: { SUPABASE_URL: BETA_URL, SUPABASE_PROJECT_TOKEN: "t" }, fetch: api.fetch,
      policy: TINY_POLICY, population: TINY_POPULATION, log: (l) => lines.push(l), error: () => {},
    });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /step f would FAIL .*anon holds TABLE-level SELECT/);
    assert.ok(!api.calls.some((c) => c.method === "PATCH"));
  });

  it("the SQL names every personal column 3740 forbids, and asks both client roles for table-level SELECT and UPDATE", () => {
    for (const c of PROFILES_NEVER_READ) assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(`'${c}'`), c);
    for (const c of ["date_of_birth", "phone_e164", "expo_push_token", "full_name"]) assert.ok((PROFILES_NEVER_READ as readonly string[]).includes(c), c);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /ARRAY\['anon', 'authenticated'\]::name\[\]/);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /has_table_privilege\(r, to_regclass\('public\.profiles'\), p\)/);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /ARRAY\['SELECT', 'UPDATE'\]/);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /has_column_privilege\(r, a\.attrelid, a\.attnum, 'SELECT'\)/);
    assert.deepEqual(profilesGrantProblems([{ profiles_exists: true, findings: [] }]), []);
    assert.equal(profilesGrantProblems([]).length, 1, "no row is not a pass");
  });
});
