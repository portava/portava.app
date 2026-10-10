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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { BETA_PROJECT_REF, CHAIN_START_PREFIX, PRODUCTION_PROJECT_REF, REPO_ROOT } from "./beta-db-core.js";
import {
  BETA_AUTH_CONFIG,
  authConfigProblems,
  FLAG_REPAIR_SQL_PREFIX,
  buildFlagApplySql,
  buildFlagRepairSql,
  flagPolicyProblems,
  planPreBaselineFlagRepair,
  preBaselineFlagDefinitions,
  type PreBaselineFlagDefinition,
  loadFlagPolicy,
  planFlagApply,
  seededFlagPopulation,
  type FetchLike,
  type FlagPolicy,
  type FlagPolicyEntry,
  type SeededFlag,
} from "./beta-config-core.js";
import { runBetaConfigure } from "./beta-configure.js";
import { applyPolicySync, flagKindOf, planPolicySync, serializePolicy } from "./beta-flag-policy-sync.js";
import {
  PROFILES_AUTHORITY_FUNCTION,
  PROFILES_AUTHORITY_TRIGGER,
  PROFILES_BOUNDARY_MARKER,
  PROFILES_CLIENT_GRANT_SQL,
  PROFILES_NEVER_READ,
  PROFILES_ROLE_PREDICATE,
  PROFILES_SERVER_ONLY,
  PROFILES_TRIGGER_GUARDED,
  profilesGrantProblems,
} from "./beta-config-core.js";

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
    // N-1 (lane B, migration 3932 retires it): the identity-check override is in neither the policy nor the
    // migration population, so the beta database never holds the lever at all, on or off.
    assert.equal(byFlag.has("rent_buddy_allow_bookings_without_kyc"), false);
    assert.equal(population.has("rent_buddy_allow_bookings_without_kyc"), false);
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
      // Lead ruling D2-RES (2026-10-09): the reservation-import door sends a whole pasted confirmation to a model;
      // OFF until a redaction pass runs before the provider call (census-input-intelligence §42.37).
      ["reservation_import_enabled", "(5) D2-RES: no redaction before the provider call yet"],
    ]);
    const expected = new Set<string>(SAFETY);
    for (const f of SEEDED_TRUE_NEWER_THAN_SNAPSHOT) { assert.ok(!(f in PRODUCTION_FLAGS), f); expected.add(f); }
    for (const [flag, value] of Object.entries(PRODUCTION_FLAGS)) {
      if (value === true && population.has(flag) && !EXCEPTIONS.has(flag)) expected.add(flag);
    }
    const on = policy.flags.filter((e) => e.enabled).map((e) => e.flag).sort();
    assert.deepEqual(on, [...expected].sort(), "the ON set changed: re-read the rationale and the lead's review before updating this rule");
    assert.equal(on.length, 107, "pinned count (lead decision 2026-10-06; D2-RES 2026-10-09): 6 safety controls + 100 production-TRUE flags + 1 newer seeded-TRUE flag");
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
  /** Simulate a repair INSERT that creates nothing. */
  repairCreatesNothing?: boolean;
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
      if (q.startsWith(FLAG_REPAIR_SQL_PREFIX)) {
        // INSERT … ON CONFLICT (flag) DO NOTHING: an existing row is never touched.
        const created: Array<{ flag: string; enabled: boolean }> = [];
        for (const m of q.matchAll(/\('([A-Za-z0-9_]+)', (true|false), /g)) {
          if (opts.repairCreatesNothing || m[1] in flags) continue;
          flags[m[1]] = m[2] === "true";
          created.push({ flag: m[1], enabled: m[2] === "true" });
        }
        return reply(created);
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
function run(api: ReturnType<typeof stubApi>, over: { argv?: string[]; env?: NodeJS.ProcessEnv; definitions?: ReadonlyMap<string, PreBaselineFlagDefinition> } = {}) {
  const errors: string[] = [];
  return runBetaConfigure({
    argv: over.argv ?? ["--confirm=CONFIGURE-BETA"],
    env: over.env ?? { SUPABASE_URL: BETA_URL, SUPABASE_PROJECT_TOKEN: "sbp_test_token" },
    fetch: api.fetch,
    policy: TINY_POLICY,
    population: TINY_POPULATION,
    // No pre-baseline definitions unless a test supplies them: a missing flag is then a refusal, as before b2.
    definitions: over.definitions ?? new Map(),
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
    // Lane B (#640): 3823 seeds payment_ledger_reads_enabled FALSE, 3932 retires rent_buddy_allow_bookings_without_kyc.
    // #640 is on main and its policy edit is committed, so the fixture is the policy as it stood BEFORE #640 — the
    // committed policy without payment_ledger_reads_enabled and with the retired lever still listed OFF — run
    // against a population that holds the one and not the other (it does, on this tree; stated anyway).
    const retired: FlagPolicyEntry = {
      flag: "rent_buddy_allow_bookings_without_kyc", kind: "CAPABILITY", enabled: false,
      reason: "OFF: Rent-a-Buddy booking and payments stay off — identity must be live-mode and test-mode verifications never satisfy a booking.",
      evidence: ["OD-PAY-10", "OD-PAY-11"],
    };
    const preB: FlagPolicy = {
      ...policy,
      flags: [...policy.flags.filter((x) => x.flag !== "payment_ledger_reads_enabled"), retired].sort((a, b) => (a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0)),
    };
    assert.equal(preB.flags.length, policy.flags.length, "the fixture swaps one entry for another");
    const pop = withPop([seeded("payment_ledger_reads_enabled", false, false, "3823_payment_attribution_and_scoped_reads.sql:512")], ["rent_buddy_allow_bookings_without_kyc"]);
    const plan = planPolicySync(preB, pop);
    assert.deepEqual(plan.refuse, []);
    assert.deepEqual(plan.remove, ["rent_buddy_allow_bookings_without_kyc"]);
    assert.equal(plan.add.length, 1);
    const e = plan.add[0];
    assert.deepEqual([e.flag, e.kind, e.enabled, e.evidence], ["payment_ledger_reads_enabled", "CAPABILITY", false, []]);
    assert.match(e.reason, /^OFF: seeded FALSE by 3823_payment_attribution_and_scoped_reads\.sql:512/);
    const next = applyPolicySync(preB, plan);
    // the result satisfies the same structural rules the real policy is held to, against the new population
    assert.deepEqual(flagPolicyProblems(next, pop), []);
    assert.equal(next.flags.filter((x) => x.enabled).length, preB.flags.filter((x) => x.enabled).length, "nothing turned ON");
    const names = next.flags.map((x) => x.flag);
    assert.deepEqual(names, [...names].sort(), "sorted by name, as committed");
    // a write changes only the added and removed entries
    const before = serializePolicy(preB).split("\n");
    const after = serializePolicy(next).split("\n");
    assert.ok(Math.abs(after.length - before.length) <= 7 + 7, `${before.length} -> ${after.length} lines`);
    // and the entry it adds is the one lane B committed by hand, apart from the wording of the reason
    const committed = policy.flags.find((x) => x.flag === "payment_ledger_reads_enabled");
    assert.deepEqual(committed && [committed.kind, committed.enabled, committed.evidence], [e.kind, e.enabled, e.evidence]);
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
/** The ANY(ARRAY[...]) column list of the branch whose has_column_privilege(...) call ends with `tail`. */
function columnListBefore(tail: string): string[] {
  const at = PROFILES_CLIENT_GRANT_SQL.indexOf(`has_column_privilege(r, a.attrelid, a.attnum, ${tail}`);
  assert.ok(at > 0, `no has_column_privilege(..., ${tail} branch`);
  const head = PROFILES_CLIENT_GRANT_SQL.slice(0, at);
  const m = /a\.attname = ANY\(ARRAY\[([^\]]*)\]::name\[\]\)[^\[]*$/.exec(head);
  assert.ok(m, `no ANY(ARRAY[...]) list directly before the ${tail} branch`);
  return [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
}

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

  it("PROFILES_NEVER_READ is pinned: exactly 3740's ten never-read columns (verifier F1)", () => {
    assert.deepEqual([...PROFILES_NEVER_READ], [
      "date_of_birth", "full_name", "expo_push_token", "phone_e164", "phone_verified_at",
      "trust_score", "safety_flags_count", "id_verified_at", "selfie_verified_at", "verification_method",
    ]);
  });

  {
    // Once migration 3740 (PR #647) is in the tree, its own v_never_read is the authority. Until then this test is
    // SKIPPED, saying so; the lead re-checks after #647 merges (verifier F1).
    const migDir = join(REPO_ROOT, "artifacts/api-server/src/migrations");
    const file = readdirSync(migDir).find((f) => /^3740_.*\.sql$/.test(f));
    it(
      "PROFILES_NEVER_READ equals migration 3740's v_never_read, parsed from the file",
      { skip: file ? false : "migration 3740 (PR #647) is not in this tree yet — re-check after #647 merges" },
      () => {
        const sql = readFileSync(join(migDir, file as string), "utf8");
        const m = /v_never_read\s+constant\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(sql);
        assert.ok(m, "v_never_read not found in 3740");
        assert.deepEqual([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]).sort(), [...PROFILES_NEVER_READ].sort());
      },
    );
  }

  it("the SQL also refuses column-level UPDATE on profiles.role (2078; verifier F2) — role is one of 3742's authority columns", () => {
    assert.ok((PROFILES_SERVER_ONLY as readonly string[]).includes("role"));
    assert.deepEqual(columnListBefore("'UPDATE')"), [...PROFILES_SERVER_ONLY]);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /' can UPDATE ' \|\| a\.attname::text/);
  });

  it("FAILS (exit 1) on the role-UPDATE finding alone", async () => {
    const api = stubApi({ profilesGrant: { profiles_exists: true, findings: ["authenticated can UPDATE role"] } });
    const { code, errors } = await run(api);
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /authenticated can UPDATE role/);
  });

  it("the SQL names every personal column 3740 forbids, and asks both client roles for table-level SELECT and UPDATE", () => {
    assert.deepEqual(columnListBefore("'SELECT')"), [...PROFILES_NEVER_READ], "the SELECT branch asks exactly the never-read list");
    for (const c of ["date_of_birth", "phone_e164", "expo_push_token", "full_name"]) assert.ok((PROFILES_NEVER_READ as readonly string[]).includes(c), c);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /ARRAY\['anon', 'authenticated'\]::name\[\]/);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /has_table_privilege\(r, to_regclass\('public\.profiles'\), p\)/);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /ARRAY\['SELECT', 'UPDATE'\]/);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /has_column_privilege\(r, a\.attrelid, a\.attnum, 'SELECT'\)/);
    assert.deepEqual(profilesGrantProblems([{ profiles_exists: true, findings: [] }]), []);
    assert.equal(profilesGrantProblems([]).length, 1, "no row is not a pass");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The authority columns (migration 3742, PR #653; lead rulings G3-1/G3-2, BETA-6 extended 2026-10-07)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The regexes (SQL text, exactly as written in both places) that step f shares with 3742's own $post$ block at PR #653
 * head 9b7d0af29b: comment stripping, the refusal, its SQLSTATE, the first RETURN, and the predicate's two reads.
 */
const STEP_F_POST_REGEXES = [
  "'--[^\\n]*'",
  "'IF\\s+NOT\\s+public\\.caller_may_write_profile_role\\(\\)\\s+THEN\\s+RAISE\\s+EXCEPTION'",
  "'ERRCODE\\s*=\\s*''42501'''",
  "'\\mRETURN\\M'",
  "'public\\.caller_may_write_profile_role\\(\\)'",
  "'current_setting\\(\\s*''role'''",
  "'\\msession_user\\M'",
  "'\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.'",
] as const;
describe("beta-configure step f — no tester account while a client role can write profiles' authority columns or 3742's trigger is absent", () => {
  const migDir = join(REPO_ROOT, "artifacts/api-server/src/migrations");

  it("PROFILES_SERVER_ONLY is pinned: exactly 3742's nineteen authority columns, in 3742's order", () => {
    assert.deepEqual([...PROFILES_SERVER_ONLY], [
      "verified", "verified_at", "trust_score", "trust_label",
      "verification_method", "featured_count", "created_at", "account_status",
      "role", "is_official", "verification_status", "verification_level",
      "verified_since", "id_verified_at", "selfie_verified_at",
      "home_country_verified_at", "host_verified_at", "buddy_verified_at",
      "safety_flags_count",
    ]);
    assert.equal(new Set(PROFILES_SERVER_ONLY).size, 19);
    assert.equal(PROFILES_AUTHORITY_TRIGGER, "trg_profiles_authority_privileged");
    assert.equal(PROFILES_AUTHORITY_FUNCTION, "public.enforce_profile_authority_privileged()");
  });

  it("it contains every column 2163's trigger guards (on main) and 2078's role", () => {
    const file = readdirSync(migDir).find((f) => /^2163_.*\.sql$/.test(f));
    assert.ok(file, "2163 is on main");
    const sql = readFileSync(join(migDir, file as string), "utf8");
    const guarded = [...sql.matchAll(/NEW\.([a-z0-9_]+)\s+IS DISTINCT FROM OLD\.\1\b/g)].map((x) => x[1]);
    assert.equal(new Set(guarded).size, 9, `2163 guards nine columns: ${guarded.join(", ")}`);
    for (const c of guarded) assert.ok((PROFILES_SERVER_ONLY as readonly string[]).includes(c), c);
    assert.ok((PROFILES_SERVER_ONLY as readonly string[]).includes("role"));
  });

  {
    // Once migration 3742 (PR #653) is in the tree, its own v_revoked, trigger and function are the authority. Until
    // then these tests are SKIPPED, saying so; the lead re-checks after #653 merges.
    const file = readdirSync(migDir).find((f) => /^3742_.*\.sql$/.test(f));
    const skip = file ? false : "migration 3742 (PR #653) is not in this tree yet — re-check after #653 merges";
    const sql = () => readFileSync(join(migDir, file as string), "utf8");
    it("PROFILES_SERVER_ONLY equals migration 3742's v_revoked, parsed from the file", { skip }, () => {
      const m = /v_revoked\s+constant\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(sql());
      assert.ok(m, "v_revoked not found in 3742");
      assert.deepEqual([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]), [...PROFILES_SERVER_ONLY]);
    });
    it("the trigger and function step f looks for are the ones 3742 creates", { skip }, () => {
      const m = /CREATE TRIGGER ([a-z0-9_]+)\s+BEFORE INSERT OR UPDATE ON public\.profiles\s+FOR EACH ROW EXECUTE FUNCTION (public\.[a-z0-9_]+\(\));/.exec(sql());
      assert.ok(m, "3742's CREATE TRIGGER not found");
      assert.deepEqual([m[1], m[2]], [PROFILES_AUTHORITY_TRIGGER, PROFILES_AUTHORITY_FUNCTION]);
    });
    it("PROFILES_TRIGGER_GUARDED equals migration 3742's v_guarded, parsed from the file", { skip }, () => {
      const m = /v_guarded\s+constant\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/.exec(sql());
      assert.ok(m, "v_guarded not found in 3742");
      assert.deepEqual([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]), [...PROFILES_TRIGGER_GUARDED]);
    });
    it("every textual check step f makes is one 3742's own $post$ makes, with the same regex (verifier BETA2b F3)", { skip }, () => {
      const post = sql().slice(sql().indexOf("DO $post$"));
      assert.match(post, /t\.tgqual IS NOT NULL/, "3742 refuses a conditional trigger");
      assert.match(post, /tgattr/, "3742's $post$ refuses a column-list trigger (verifier BETA2c F6; #653 is adding it), as step f already does");
      for (const fragment of STEP_F_POST_REGEXES) assert.ok(post.includes(fragment), `3742's $post$ no longer uses ${fragment}`);
      assert.match(post, /to_regprocedure\('public\.caller_may_write_profile_role\(\)'\)/);
    });
  }

  it("the SQL asks both client roles for UPDATE on exactly those columns, and for 3742's trigger in the shape 3742's postcondition asserts — unconditional (no WHEN) included", () => {
    assert.deepEqual(columnListBefore("'UPDATE')"), [...PROFILES_SERVER_ONLY]);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_trigger AS t WHERE t\.tgrelid = to_regclass\('public\.profiles'\) AND NOT t\.tgisinternal/);
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(`t.tgname = '${PROFILES_AUTHORITY_TRIGGER}' AND t.tgfoid = to_regprocedure('${PROFILES_AUTHORITY_FUNCTION}')`));
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes("t.tgenabled = 'O' AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 16) = 16 AND t.tgqual IS NULL AND t.tgattr = '')"), "no WHEN, and no column list (verifier BETA2c F6)");
    // a missing table is reported once, by profiles_exists, not also as a missing trigger
    assert.match(PROFILES_CLIENT_GRANT_SQL, /WHERE to_regclass\('public\.profiles'\) IS NOT NULL AND NOT EXISTS/);
  });

  it("PROFILES_TRIGGER_GUARDED is pinned: exactly 3742's seven trigger-compared columns, all among the nineteen", () => {
    assert.deepEqual([...PROFILES_TRIGGER_GUARDED], ["verified", "verified_at", "trust_score", "trust_label", "verification_method", "featured_count", "created_at"]);
    for (const c of PROFILES_TRIGGER_GUARDED) assert.ok((PROFILES_SERVER_ONLY as readonly string[]).includes(c), c);
    assert.equal(PROFILES_ROLE_PREDICATE, "public.caller_may_write_profile_role()");
  });

  it("the SQL reads the trigger function: every present guarded column compared NEW against OLD, and the 42501 refusal through the predicate before the first RETURN", () => {
    const m = /FROM unnest\(ARRAY\[([^\]]*)\]::name\[\]\) AS c WHERE to_regprocedure\('public\.enforce_profile_authority_privileged\(\)'\) IS NOT NULL/.exec(PROFILES_CLIENT_GRANT_SQL);
    assert.ok(m, "no compare branch over the guarded columns");
    assert.deepEqual([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]), [...PROFILES_TRIGGER_GUARDED]);
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes("pg_get_functiondef(to_regprocedure('public.enforce_profile_authority_privileged()')) !~* ('NEW\\.' || c::text || '\\s+IS\\s+DISTINCT\\s+FROM\\s+OLD\\.' || c::text || '\\M')"));
    for (const fragment of STEP_F_POST_REGEXES) assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(fragment), fragment);
    assert.match(PROFILES_CLIENT_GRANT_SQL, /regexp_instr\(fn\.src, '\\mRETURN\\M', 1, 1, 0, 'i'\) < regexp_instr\(fn\.src, 'IF\\s\+NOT/);
    // the branch is live whenever the table exists (the function's absence is the trigger branch's finding)
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(") AS fn WHERE to_regclass('public.profiles') IS NOT NULL AND (fn.def !~* "), "the refusal branch's condition");
  });

  it("the SQL reads the predicate the trigger trusts: missing, or no longer deciding on current_setting('role') and session_user (2078)", () => {
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(` WHERE to_regclass('public.profiles') IS NOT NULL AND (to_regprocedure('${PROFILES_ROLE_PREDICATE}') IS NULL OR pg_get_functiondef(`), "the predicate branch's condition");
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(`pg_get_functiondef(to_regprocedure('${PROFILES_ROLE_PREDICATE}')) !~* 'current_setting\\(\\s*''role'''`));
    assert.ok(PROFILES_CLIENT_GRANT_SQL.includes(`pg_get_functiondef(to_regprocedure('${PROFILES_ROLE_PREDICATE}')) !~* '\\msession_user\\M'`));
    // the predicate the SQL looks for reads exactly those two things in 2078 on main
    const f2078 = readdirSync(migDir).find((f) => /^2078_.*\.sql$/.test(f));
    assert.ok(f2078, "2078 is on main");
    const def = /CREATE OR REPLACE FUNCTION public\.caller_may_write_profile_role\(\)[\s\S]*?\$function\$;/.exec(readFileSync(join(migDir, f2078 as string), "utf8"))?.[0] ?? "";
    assert.match(def, /current_setting\(\s*'role'/i);
    assert.match(def, /\bsession_user\b/i);
  });

  it("the boundary marker changed with the boundary (v3): a run made by an earlier step f does not open gate 3c", () => {
    assert.equal(PROFILES_BOUNDARY_MARKER, "profiles boundary 3740+3742 v3");
    for (const older of ["profiles boundary 3740+3742", "profiles boundary 3740+3742 v2"]) {
      assert.ok(!`beta-config · CONFIGURE-BETA · apply · ${older}`.includes(PROFILES_BOUNDARY_MARKER), older);
    }
  });

  for (const finding of [
    "authenticated can UPDATE verified",
    "authenticated can UPDATE created_at",
    "anon can UPDATE trust_score",
    `${"trg_profiles_authority_privileged"} (3742) is missing, disabled, conditional (WHEN), limited to listed columns (UPDATE OF …), or not a BEFORE INSERT OR UPDATE row trigger running public.enforce_profile_authority_privileged()`,
    "public.enforce_profile_authority_privileged() (3742) no longer compares created_at",
    "public.enforce_profile_authority_privileged() (3742) does not refuse through public.caller_may_write_profile_role() (IF NOT … THEN RAISE EXCEPTION … ERRCODE = '42501') before its first RETURN",
    "public.caller_may_write_profile_role() (2078), the predicate the 3742 trigger trusts, is missing",
    "public.caller_may_write_profile_role() (2078), the predicate the 3742 trigger trusts, no longer decides on current_setting('role') and session_user",
  ]) {
    it(`FAILS (exit 1) on one 3742 finding alone: ${finding.slice(0, 48)}…`, async () => {
      const api = stubApi({ profilesGrant: { profiles_exists: true, findings: [finding] } });
      const { code, errors } = await run(api);
      assert.equal(code, 1);
      const msg = errors.join("\n");
      assert.ok(msg.includes(finding), msg);
      assert.match(msg, /NOT ready for tester accounts/);
      assert.match(msg, /3742 \(PR #653\)/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// b2 — PRE-BASELINE FLAG ROWS (beta-config run 38078328219, 2026-10-10)
// ─────────────────────────────────────────────────────────────────────────────

/** The 128 policy flags run 38078328219 (main e6d9b5613) found absent from portava-beta. */
const RUN_38078328219_MISSING = (
  "COMPASS_ACTIVE_REWARDS_ENABLED COMPASS_DIVERSITY_ENABLED COMPASS_ENABLED COMPASS_FAIR_EXPOSURE_ENABLED COMPASS_FALLBACK_MODE_ENABLED " +
  "COMPASS_FEED_ENABLED COMPASS_V1_RULE_BASED_ENABLED MEDIA_ADMIN_REVIEW_ENABLED MEDIA_AI_PROVENANCE_LABELS_ENABLED MEDIA_ANALYTICS_ENABLED " +
  "MEDIA_COMMENTS_ENABLED MEDIA_DEFAULT_VIEW_MODE MEDIA_FOLLOWING_ENABLED MEDIA_FOR_YOU_ENABLED MEDIA_GEMS_ADD_TO_TRIP_ENABLED " +
  "MEDIA_GEMS_DIRECTIONS_ENABLED MEDIA_GEMS_RANKING_ENABLED MEDIA_GEMS_SUBMIT_ENABLED MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED " +
  "MEDIA_GRID_RANKING_ENABLED MEDIA_LIKES_ENABLED MEDIA_PROCESSING_PIPELINE_ENABLED MEDIA_RANKING_ENABLED MEDIA_SAVES_ENABLED " +
  "MEDIA_SHARES_ENABLED MEDIA_TAB_ENABLED MEDIA_UPLOAD_ENABLED MEDIA_UPLOAD_PHOTO_ENABLED MEDIA_UPLOAD_VIDEO_ENABLED " +
  "MEDIA_VIEW_MODE_FULLSCREEN_ENABLED MEDIA_VIEW_MODE_GRID_ENABLED MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED RENT_BUDDY_ADMIN_ONLY_MODE " +
  "RENT_BUDDY_BETA_ONLY_MODE RENT_BUDDY_GROUP_BOOKINGS_ENABLED RENT_BUDDY_MVP_MODE RENT_BUDDY_NIGHTLIFE_ENABLED RENT_BUDDY_OFFERS_ENABLED " +
  "account_deletion_worker_enabled ai_event_auto_suggest_enabled ai_event_headers_enabled ai_place_headers_enabled ai_trip_covers_enabled " +
  "ai_visual_admin_review_enabled ai_visual_provider_enabled ai_visual_regeneration_enabled airport_mode_enabled airport_pulse_enabled " +
  "budget_fx_conversion_enabled budget_intelligence_enabled compass_ai_enabled compass_location_context_enabled country_essentials_enabled " +
  "disable_location_sharing disable_media_uploads disable_messaging disable_new_event_creation disable_posting disable_profile_search " +
  "disable_rab_bookings disable_rent_buddy_booking disable_signups disable_tagging disable_unknown_message_requests discovery_serve_log_enabled " +
  "events_chat_enabled events_cohosts_enabled events_enabled events_invites_enabled events_join_leave_enabled events_reminders_enabled " +
  "events_reports_enabled events_share_links_enabled events_trust_gates_enabled events_waitlist_enabled external_places_enabled " +
  "find_your_circle_disabled find_your_circle_enabled fsq_places_enabled hidden_gem_verification_enabled hidden_gems_compass_enabled " +
  "hidden_gems_enabled hidden_gems_layover_enabled hidden_gems_passport_enabled hidden_gems_pulse_enabled invite_only_beta " +
  "layover_compass_enabled layover_plans_enabled layover_safety_engine_enabled live_places_enabled local_guides_enabled " +
  "map_compass_commands_enabled map_search_enabled media_canonical_enabled media_private_buckets_enabled moment_recaps_enabled " +
  "neighborhood_match_enabled nl_trip_creation_enabled passport_contribution_enabled passport_entry_intelligence_enabled passport_map_enabled " +
  "passport_memories_enabled passport_stamps_enabled place_days_enabled place_recaps_enabled plan_geofence_enabled plan_geofence_full_enabled " +
  "reservation_import_enabled safe_return_admin_logs_enabled safe_return_enabled safe_return_live_share_enabled " +
  "safe_return_trusted_circle_alerts_enabled shared_moments_clustering_enabled shared_moments_compass_suggestions_enabled " +
  "shared_moments_enabled stamp_admire_enabled stamp_auto_approve_artwork stamp_criteria_engine_enabled stamp_premium_rendering_enabled " +
  "stamp_showcase_enabled stamp_unified_view_enabled stories_enabled trip_crew_ghost_mode_enabled trip_crew_live_share_enabled " +
  "trip_crew_map_enabled trip_readiness_enabled trust_engine_enabled trust_gaming_detection_enabled"
).split(" ");

describe("b2 · pre-baseline flag rows — created from their migration definitions, fail-closed, never overwriting", () => {
  const defs = preBaselineFlagDefinitions();

  it("every one of run 38078328219's 128 missing flags is creatable from an exact pre-baseline definition (none refused)", () => {
    assert.equal(RUN_38078328219_MISSING.length, 128);
    const plan = planPreBaselineFlagRepair(RUN_38078328219_MISSING, policy, defs);
    assert.deepEqual(plan.refused, []);
    assert.equal(plan.create.length, 128);
    for (const r of plan.create) {
      assert.ok(r.seededIn.split(":")[0] < CHAIN_START_PREFIX, `${r.flag} is defined at ${r.seededIn}, before the chain`);
      assert.ok(population.has(r.flag), `${r.flag} is in the migration population`);
    }
  });

  it("no definition is guessed: the tree's pre-baseline definitions all parse exactly, and none is a flag the chain seeds", () => {
    assert.deepEqual([...defs.values()].filter((d) => d.problem).map((d) => `${d.flag}: ${d.problem}`), []);
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    const chain = seededFlagPopulation(files.filter((f) => f >= CHAIN_START_PREFIX));
    for (const f of defs.keys()) assert.ok(!chain.has(f), `${f} is seeded by the chain; its absence must refuse, not repair`);
  });

  it("created values are fail-closed: every STOP ENGAGED (disable_signups among them), every other flag OFF — even a TRUE seed", () => {
    const plan = planPreBaselineFlagRepair(RUN_38078328219_MISSING, policy, defs);
    const by = new Map(plan.create.map((r) => [r.flag, r]));
    for (const r of plan.create) assert.equal(r.enabled, byFlag.get(r.flag)?.kind === "STOP", r.flag);
    assert.equal(by.get("disable_signups")?.enabled, true, "sign-up never reads open, not even before the policy apply");
    assert.equal(by.get("invite_only_beta")?.enabled, false, "a capability is created OFF; the policy apply turns it ON, audited");
    assert.equal(by.get("COMPASS_ENABLED")?.seededValue, true);
    assert.equal(by.get("COMPASS_ENABLED")?.enabled, false, "a TRUE seed is not copied: ON comes only from the audited apply");
  });

  it("definitions carry the migrations' description and metadata, later pre-baseline UPDATEs included", () => {
    assert.equal(defs.get("disable_signups")?.description, "Kill switch — blocks new account registrations; checked by GET /auth/signup-status");
    assert.deepEqual(JSON.parse(defs.get("live_places_enabled")?.metadata ?? "null"), { requires: ["external_places_enabled"], rollout: "phase4" });
    // 2063 seeds place_days_enabled; 2068's UPDATE … SET metadata names it.
    assert.deepEqual(JSON.parse(defs.get("place_days_enabled")?.metadata ?? "null").requires, ["external_places_enabled", "live_places_enabled"]);
    // 0051 seeds COMPASS_ENABLED with ON CONFLICT DO UPDATE SET description = EXCLUDED.description.
    assert.equal(defs.get("COMPASS_ENABLED")?.description, "Master switch — enables the Compass intelligence system");
  });

  it("the reader: ON CONFLICT DO UPDATE rewrites, DO NOTHING keeps, UPDATE SET metadata applies, DELETE retires, chain-seeded and unparseable are excluded or flagged", () => {
    const files = ["0001_a.sql", "0002_b.sql", "2093_c.sql"];
    const d = preBaselineFlagDefinitions(files, (f) => ({
      "0001_a.sql": [
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('a_enabled', true, 'first a'), ('b_enabled', false, 'first b') ON CONFLICT (flag) DO NOTHING;",
        "INSERT INTO public.feature_flags (flag, enabled, description, metadata) VALUES ('m_enabled', false, 'it''s m', '{\"x\":1}');",
        "INSERT INTO feature_flags SELECT * FROM (VALUES ('odd_enabled', false, 'x')) v;",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('odd2_enabled', false, 'x' || current_user);",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('gone_enabled', false, 'retired');",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('chain_enabled', false, 'pre');",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('chain_del_enabled', false, 'pre');",
      ].join("\n"),
      "0002_b.sql": [
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('a_enabled', false, 'second a') ON CONFLICT (flag) DO UPDATE SET description = EXCLUDED.description;",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('b_enabled', true, 'second b') ON CONFLICT (flag) DO NOTHING;",
        "UPDATE feature_flags SET metadata = '{\"requires\":[\"a_enabled\"]}' WHERE flag IN ('b_enabled', 'm_enabled');",
        "-- DELETE FROM feature_flags WHERE flag = 'a_enabled';",
        "DELETE FROM feature_flags WHERE flag = 'gone_enabled';",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('r_enabled', true, 'before retirement');",
        "DELETE FROM feature_flags WHERE flag = 'r_enabled';",
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('r_enabled', false, 'after re-seed') ON CONFLICT (flag) DO NOTHING;",
      ].join("\n"),
      "2093_c.sql": [
        "INSERT INTO feature_flags (flag, enabled, description) VALUES ('chain_enabled', false, 'chain') ON CONFLICT (flag) DO NOTHING;",
        "DELETE FROM feature_flags WHERE flag = 'chain_del_enabled';",
      ].join("\n"),
    } as Record<string, string>)[f]);
    assert.equal(d.get("a_enabled")?.description, "second a", "DO UPDATE SET description = EXCLUDED.description rewrites");
    assert.equal(d.get("a_enabled")?.seededValue, true, "the FIRST seed defines the seeded value");
    assert.equal(d.get("a_enabled")?.seededIn, "0001_a.sql:1");
    assert.equal(d.get("b_enabled")?.description, "first b", "DO NOTHING keeps the first definition");
    assert.equal(d.get("b_enabled")?.metadata, '{"requires":["a_enabled"]}');
    assert.equal(d.get("m_enabled")?.description, "it's m");
    assert.equal(d.get("m_enabled")?.metadata, '{"requires":["a_enabled"]}', "the later UPDATE wins");
    assert.ok(d.has("a_enabled"), "a commented-out DELETE retires nothing");
    assert.ok(!d.has("gone_enabled"), "a DELETE retires");
    assert.equal(d.get("r_enabled")?.description, "after re-seed", "a re-seed after a retirement is the definition");
    assert.equal(d.get("r_enabled")?.seededIn, "0002_b.sql:8");
    assert.ok(!d.has("chain_enabled"), "the chain seeds it: its absence must refuse, never repair");
    assert.ok(!d.has("chain_del_enabled"), "the chain retires it: it must not be created");
    assert.match(d.get("odd_enabled")?.problem ?? "", /cannot parse/, "an INSERT … SELECT the seed scanner sees is flagged, not guessed");
    assert.match(d.get("odd2_enabled")?.problem ?? "", /description is not a literal/, "a computed description is flagged, not guessed");
    const plan = planPreBaselineFlagRepair(["a_enabled", "odd_enabled", "chain_enabled"], {
      ...TINY_POLICY,
      flags: ["a_enabled", "odd_enabled", "chain_enabled"].map((flag) => ({ flag, enabled: false, kind: "CAPABILITY" as const, reason: "x", evidence: [] })),
    }, d);
    assert.deepEqual(plan.create.map((r) => r.flag), ["a_enabled"]);
    assert.deepEqual(plan.refused.map((r) => r.flag), ["chain_enabled", "odd_enabled"]);
  });

  it("the reader refuses what it cannot emulate: an expression or conditional DO UPDATE, non-JSON metadata, an UPDATE whose WHERE is not purely on flag", () => {
    const one = (sql: string[], flag: string) =>
      preBaselineFlagDefinitions(["0001_a.sql"], () => sql.join("\n")).get(flag)?.problem ?? "";
    const seed = "INSERT INTO feature_flags (flag, enabled, description) VALUES ('p_enabled', false, 'first') ON CONFLICT (flag) DO NOTHING;";
    assert.match(one([seed,
      "INSERT INTO feature_flags (flag, enabled, description) VALUES ('p_enabled', false, 'x') ON CONFLICT (flag) DO UPDATE SET description = 'fixed ' || EXCLUDED.description;",
    ], "p_enabled"), /ON CONFLICT rewrites description with an expression/, "V6");
    assert.match(one([
      "INSERT INTO feature_flags (flag, enabled, description, metadata) VALUES ('p_enabled', false, 'd', '{not json');",
    ], "p_enabled"), /metadata is not JSON/, "V4");
    assert.match(one([seed,
      "INSERT INTO feature_flags (flag, enabled, description) VALUES ('p_enabled', false, 'x') ON CONFLICT (flag) DO UPDATE SET description = EXCLUDED.description WHERE feature_flags.description IS NULL;",
    ], "p_enabled"), /rewrites description under a WHERE/, "G1: a conditional DO UPDATE is not treated as unconditional");
    assert.equal(one([seed,
      "INSERT INTO feature_flags (flag, enabled, description) VALUES ('p_enabled', false, 'x where y') ON CONFLICT (flag) DO UPDATE SET description = EXCLUDED.description;",
    ], "p_enabled"), "", "WHERE inside a literal is not a condition");
    assert.match(one([seed,
      "UPDATE feature_flags SET description = 'changed' WHERE description = 'first';",
    ], "p_enabled"), /WHERE not purely on flag/, "G2: an UPDATE keyed on something else is refused, not skipped");
    assert.match(one([seed,
      "UPDATE feature_flags SET metadata = '{}' WHERE flag = 'p_enabled' AND enabled;",
    ], "p_enabled"), /WHERE not purely on flag/, "G2: a flag test plus another condition is refused");
    const lit = preBaselineFlagDefinitions(["0001_a.sql"], () => [seed, "UPDATE feature_flags SET description = 'x where y' WHERE flag = 'p_enabled';"].join("\n")).get("p_enabled");
    assert.equal(lit?.problem, undefined, "WHERE inside an UPDATE's literal is not the WHERE clause");
    assert.equal(lit?.description, "x where y");
    for (const w of ["flag = 'p_enabled'", "flag IN ('q_enabled', 'p_enabled')", "flag = ANY(ARRAY['p_enabled'])", "flag LIKE 'p\\_%'"]) {
      const d = preBaselineFlagDefinitions(["0001_a.sql"], () => [seed, `UPDATE feature_flags SET description = 'changed' WHERE ${w};`].join("\n")).get("p_enabled");
      assert.equal(d?.problem, undefined, w);
      assert.equal(d?.description, "changed", w);
    }
  });

  it("buildFlagRepairSql: one INSERT, ON CONFLICT (flag) DO NOTHING, no UPDATE or DELETE, unsafe names and non-JSON metadata refused", () => {
    const row = { flag: "x_enabled", enabled: false, description: "it's", metadata: '{"a":1}', seededIn: "0001_a.sql:1", seededValue: true };
    const sql = buildFlagRepairSql([row, { ...row, flag: "disable_x", enabled: true, metadata: null, description: null }]);
    assert.ok(sql.startsWith(FLAG_REPAIR_SQL_PREFIX));
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING RETURNING flag, enabled$/);
    assert.doesNotMatch(sql, /\bUPDATE\b|\bDELETE\b|DO UPDATE/i);
    assert.match(sql, /\('x_enabled', false, 'it''s', '\{"a":1\}'::jsonb\)/);
    assert.match(sql, /\('disable_x', true, NULL, NULL\)/);
    assert.throws(() => buildFlagRepairSql([{ ...row, flag: "x'; DROP TABLE y; --" }]), /refusing to splice/);
    assert.throws(() => buildFlagRepairSql([{ ...row, metadata: "{nope" }]));
    assert.throws(() => buildFlagRepairSql([]), /nothing to repair/);
  });
});

describe("b2 · the step against the stub", () => {
  const DEFS: ReadonlyMap<string, PreBaselineFlagDefinition> = new Map([
    ["disable_signups", { flag: "disable_signups", seededIn: "0117_beta_feature_flags.sql:40", seededValue: false, description: "Kill switch", metadata: null }],
    ["invite_only_beta", { flag: "invite_only_beta", seededIn: "0117_beta_feature_flags.sql:45", seededValue: false, description: "Invite only", metadata: null }],
    ["stories_enabled", { flag: "stories_enabled", seededIn: "0068_stories.sql:165", seededValue: true, description: "Stories", metadata: null }],
  ]);

  it("creates the missing pre-baseline rows (STOP engaged, capability OFF), re-reads, then configures; ON arrives only through the audited apply", async () => {
    const api = stubApi({ flags: { rent_buddy_enabled: true } });
    const { code, errors } = await run(api, { definitions: DEFS });
    assert.equal(code, 0, errors.join("\n"));
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [
      "POST /database/query", // read
      "POST /database/query", // b2 insert
      "POST /database/query", // re-read
      "PATCH /config/auth",
      "GET /config/auth",
      "POST /database/query", // audited apply
      "POST /database/query", // read-back
      "POST /database/query", // profiles boundary
    ]);
    assert.ok(api.calls[1].body.query.startsWith(FLAG_REPAIR_SQL_PREFIX));
    assert.match(api.calls[1].body.query, /\('disable_signups', true, /);
    assert.match(api.calls[1].body.query, /\('invite_only_beta', false, /);
    assert.match(api.calls[1].body.query, /\('stories_enabled', false, /, "a TRUE seed is created OFF");
    assert.doesNotMatch(api.calls[1].body.query, /rent_buddy_enabled/, "an existing row is not in the insert");
    assert.match(api.calls[2].body.query, /^SELECT flag, enabled FROM public\.feature_flags/);
    assert.deepEqual(api.flags, { disable_signups: true, invite_only_beta: true, rent_buddy_enabled: false, stories_enabled: false });
    assert.deepEqual([...api.audit].sort((a, b) => (a.flag < b.flag ? -1 : 1)), [
      { flag: "invite_only_beta", old: false, new: true },
      { flag: "rent_buddy_enabled", old: true, new: false },
    ], "every flip audited; the engaged STOP was created engaged, so it never flipped");
  });

  it("one missing flag without a pre-baseline definition refuses EVERYTHING: only the read happened", async () => {
    const api = stubApi({ flags: { rent_buddy_enabled: false } });
    const defs = new Map(DEFS);
    defs.delete("stories_enabled");
    const { code, errors } = await run(api, { definitions: defs });
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /Nothing was written — neither Auth nor any flag/);
    assert.match(errors.join("\n"), /stories_enabled \(no pre-baseline definition/);
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["POST /database/query"]);
    assert.deepEqual(api.flags, { rent_buddy_enabled: false });
  });

  it("a definition that could not be read exactly refuses, nothing written", async () => {
    const api = stubApi({ flags: { disable_signups: false, invite_only_beta: false, rent_buddy_enabled: false } });
    const defs = new Map(DEFS);
    defs.set("stories_enabled", { ...DEFS.get("stories_enabled")!, problem: "0068_stories.sql:165: an INSERT this reader cannot parse" });
    const { code, errors } = await run(api, { definitions: defs });
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /cannot be read exactly/);
    assert.equal(api.calls.length, 1);
  });

  it("the check is repeated on the re-read: an insert that created nothing exits 1 before Auth", async () => {
    const api = stubApi({ flags: { rent_buddy_enabled: false }, repairCreatesNothing: true });
    const { code, errors } = await run(api, { definitions: DEFS });
    assert.equal(code, 1);
    assert.match(errors.join("\n"), /still not in public\.feature_flags after the pre-baseline repair/);
    assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 0);
    assert.ok(!api.calls.some((c) => c.body?.query?.startsWith("WITH changed AS (")));
  });

  it("--dry-run prints the repair, sends no INSERT, and plans on top of it", async () => {
    const api = stubApi({ flags: { rent_buddy_enabled: true } });
    const lines: string[] = [];
    const code = await runBetaConfigure({
      argv: ["--confirm=CONFIGURE-BETA", "--dry-run"], env: { SUPABASE_URL: BETA_URL, SUPABASE_PROJECT_TOKEN: "t" }, fetch: api.fetch,
      policy: TINY_POLICY, population: TINY_POPULATION, definitions: DEFS, log: (l) => lines.push(l), error: (l) => lines.push(l),
    });
    assert.equal(code, 0, lines.join("\n"));
    assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), ["POST /database/query", "GET /config/auth", "POST /database/query"]);
    assert.ok(!api.calls.some((c) => c.body?.query?.startsWith(FLAG_REPAIR_SQL_PREFIX)), "a dry run never inserts");
    assert.deepEqual(api.flags, { rent_buddy_enabled: true });
    const out = lines.join("\n");
    assert.match(out, /would create 3 row\(s\)/);
    assert.match(out, /disable_signups := true \(STOP, engaged\)/);
    assert.match(out, /invite_only_beta false→true/, "the plan shows the audited flip that will turn it ON");
  });
});
