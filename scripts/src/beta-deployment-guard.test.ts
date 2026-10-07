/**
 * beta-deployment-guard.test.ts — scripts/build-production.sh refuses to build a
 * BETA deployment whose web bundle would talk to PRODUCTION, and production's
 * own build is unchanged.
 *
 * Three layers:
 *   1. scripts/deployment-env-guard.sh over a case table, by exit code.
 *   2. The SAME table through the API's rule
 *      (artifacts/api-server/src/lib/deploymentEnvironment.ts), each case stating
 *      both verdicts — the API needs SUPABASE_URL only, the build needs the
 *      inlined EXPO_PUBLIC_SUPABASE_URL too — so the two implementations cannot
 *      drift apart unnoticed.
 *   3. scripts/build-production.sh END TO END with `pnpm` and `node` replaced on
 *      PATH by recorders: a refused beta build never reaches step 1 (neither is
 *      invoked); production's environment and a correct beta environment reach
 *      both steps, in order.
 *
 * No network, no build, no credentials.
 *
 * Run: pnpm --dir scripts run test:beta-deployment-guard
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = join(REPO_ROOT, "scripts", "deployment-env-guard.sh");
const BUILD = join(REPO_ROOT, "scripts", "build-production.sh");
const API_RULE = join(REPO_ROOT, "artifacts", "api-server", "src", "lib", "deploymentEnvironment.ts");

const BETA = "https://emfpckykpzfturllshly.supabase.co";
const PROD = "https://ajrurzioarfkagpuxfnb.supabase.co";
const OTHER = "https://zzzzzzzzzzzzzzzzzzzz.supabase.co";
/** Production's publishable key as .replit [userenv.shared] commits it (asserted against the file below). */
const PROD_PUBLISHABLE_KEY = "sb_publishable_xp3JiB50mBYHn1S_XjzOAg_rIoEqZKS";
/** A Sentry DSN that is not on the beta allowlist (the shape of production's; the real one is a Secret). */
const SOME_DSN = "https://0123456789abcdef0123456789abcdef@o4500000000000000.ingest.us.sentry.io/4500000000000001";
/** A beta environment both rules accept for the BUILD (the API additionally needs NODE_ENV=production). */
const BETA_OK_BUILD: Record<string, string> = { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA };
/** A beta environment both rules accept. */
const BETA_OK: Record<string, string> = { ...BETA_OK_BUILD, NODE_ENV: "production" };

/** A clean child env: PATH and HOME only, plus the case's variables. */
function env(extra: Record<string, string>, path = process.env.PATH ?? "/usr/bin:/bin"): NodeJS.ProcessEnv {
  return { PATH: path, HOME: process.env.HOME ?? "/tmp", ...extra };
}

interface Case {
  name: string;
  vars: Record<string, string>;
  /** may the API start? */
  api: boolean;
  /** may the build proceed? */
  build: boolean;
}

const CASES: Case[] = [
  { name: "production today: no label, production URLs", vars: { SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  { name: "explicit production label", vars: { PORTAVA_DEPLOYMENT_ENV: "production", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  { name: "beta, both URLs beta", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", NODE_ENV: "production", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: `${BETA}/` }, api: true, build: true },
  { name: "beta inheriting .replit's production values", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "beta API URL fixed, web URL still production", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "beta web URL fixed, API URL another project", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: OTHER, EXPO_PUBLIC_SUPABASE_URL: BETA }, api: false, build: false },
  { name: "beta, web URL missing (API alone is fine; the build is not)", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", NODE_ENV: "production", SUPABASE_URL: BETA }, api: true, build: false },
  { name: "beta, a pooler URL still on production", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, DATABASE_URL: "postgresql://postgres.ajrurzioarfkagpuxfnb:pw@pooler.example:6543/postgres" }, api: false, build: false },
  { name: "verifier M3: beta with production's API origin, web origin and CORS list", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, EXPO_PUBLIC_API_BASE_URL: "https://portava.replit.app", EXPO_PUBLIC_WEB_ORIGIN: "https://portava.replit.app", ALLOWED_ORIGINS: "https://portava.replit.app" }, api: false, build: false },
  { name: "beta with production's API origin in upper case, one variable only", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, EXPO_PUBLIC_API_BASE_URL: "https://PORTAVA.REPLIT.APP" }, api: false, build: false },
  { name: "beta with the beta origins everywhere", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", NODE_ENV: "production", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, EXPO_PUBLIC_API_BASE_URL: "https://portava-beta.replit.app", EXPO_PUBLIC_WEB_ORIGIN: "https://portava-beta.replit.app", ALLOWED_ORIGINS: "https://portava-beta.replit.app" }, api: true, build: true },
  { name: "verifier M1: beta with an upper-case production ref in a pooler URL", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, DATABASE_URL: "postgresql://postgres.AJRURZIOARFKAGPUXFNB:pw@pooler.example:6543/postgres" }, api: false, build: false },
  { name: "verifier M2: beta with an upper-case production Supabase URL in another variable", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, SUPABASE_PUBLIC_URL: "https://AJRURZIOARFKAGPUXFNB.supabase.co" }, api: false, build: false },
  { name: "typo in the label", vars: { PORTAVA_DEPLOYMENT_ENV: "Beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA }, api: false, build: false },
  { name: "beta project without the beta label", vars: { SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA }, api: false, build: false },
  // ── lane BETA2 (2026-10-07). Appended, so the index-based test below keeps its case. ──
  // A beta API runs in production mode only (development/test admit the unsigned mock identity provider and the
  // fake payment provider: lib/paymentsMode.ts mockIdentityPermitted). The API rule; the build does not judge it.
  { name: "beta, NODE_ENV unset (API refused; the build does not judge it)", vars: { ...BETA_OK_BUILD }, api: false, build: true },
  { name: "beta, NODE_ENV=development (API refused)", vars: { ...BETA_OK_BUILD, NODE_ENV: "development" }, api: false, build: true },
  { name: "beta, NODE_ENV=test (API refused)", vars: { ...BETA_OK_BUILD, NODE_ENV: "test" }, api: false, build: true },
  // .replit's production PUBLISHABLE key, inherited by a fork, names production too.
  { name: "beta keeping .replit's production publishable key", vars: { ...BETA_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: PROD_PUBLISHABLE_KEY }, api: false, build: false },
  { name: "beta with beta's own publishable key", vars: { ...BETA_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_7yEaIX8v9uM34PbbPOHM6Q_YeoIBLZC" }, api: true, build: true },
  // Live-mode provider credentials are refused on beta; sandbox/test keys pass (https://docs.stripe.com/keys).
  { name: "beta with a Stripe LIVE secret key", vars: { ...BETA_OK, STRIPE_SECRET_KEY: "sk_live_51Abc" }, api: false, build: false },
  { name: "beta with a Stripe LIVE restricted identity key", vars: { ...BETA_OK, STRIPE_IDENTITY_SECRET_KEY: "rk_live_51Abc" }, api: false, build: false },
  { name: "beta with a Stripe LIVE publishable key the web bundle would inline", vars: { ...BETA_OK, EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_51Abc" }, api: false, build: false },
  { name: "beta with Stripe TEST keys", vars: { ...BETA_OK, STRIPE_SECRET_KEY: "sk_test_51Abc", STRIPE_IDENTITY_SECRET_KEY: "rk_test_51Abc", EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_51Abc" }, api: true, build: true },
  { name: "beta with a Persona PRODUCTION key", vars: { ...BETA_OK, PERSONA_API_KEY: "persona_production_abc" }, api: false, build: false },
  { name: "beta with a Persona SANDBOX key", vars: { ...BETA_OK, PERSONA_API_KEY: "persona_sandbox_abc" }, api: true, build: true },
  { name: "beta with a Sumsub PRODUCTION app token", vars: { ...BETA_OK, SUMSUB_APP_TOKEN: "prd:AbC123" }, api: false, build: false },
  { name: "beta with a Sumsub SANDBOX app token", vars: { ...BETA_OK, SUMSUB_APP_TOKEN: "sbx:AbC123" }, api: true, build: true },
  { name: "beta with a prd: value outside SUMSUB_* (not a provider token; not judged)", vars: { ...BETA_OK, BUILD_CHANNEL: "prd:x" }, api: true, build: true },
  { name: "beta with PAYMENTS_ALLOW_LIVE=true", vars: { ...BETA_OK, PAYMENTS_ALLOW_LIVE: "true" }, api: false, build: false },
  { name: "beta with PAYMENTS_ALLOW_LIVE=TRUE (any value but empty/false is refused)", vars: { ...BETA_OK, PAYMENTS_ALLOW_LIVE: "TRUE" }, api: false, build: false },
  { name: "beta with PAYMENTS_ALLOW_LIVE=false", vars: { ...BETA_OK, PAYMENTS_ALLOW_LIVE: "false" }, api: true, build: true },
  // The beta FORK must be labelled: Replit's REPLIT_DOMAINS names the host, so an unlabelled fork cannot serve
  // production's data at the beta address. Production's own REPLIT_DOMAINS is unaffected.
  { name: "unlabelled fork at portava-beta.replit.app with .replit's production URLs", vars: { REPLIT_DOMAINS: "portava-beta.replit.app", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "production-labelled process at portava-beta.replit.app", vars: { PORTAVA_DEPLOYMENT_ENV: "production", REPLIT_DOMAINS: "abc.kirk.replit.dev,PORTAVA-BETA.replit.app", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "production at portava.replit.app (REPLIT_DOMAINS unchanged behaviour)", vars: { REPLIT_DOMAINS: "portava.replit.app", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  { name: "a host that merely contains the beta name is not the beta host", vars: { REPLIT_DOMAINS: "myportava-beta.replit.app", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  { name: "the labelled beta fork at portava-beta.replit.app", vars: { ...BETA_OK, REPLIT_DOMAINS: "portava-beta.replit.app" }, api: true, build: true },
  // Fail closed (lead, 2026-10-07): a Replit DEPLOYMENT with no REPLIT_DOMAINS must declare itself.
  { name: "unlabelled deployment, REPLIT_DOMAINS absent", vars: { REPLIT_DEPLOYMENT: "1", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "unlabelled deployment, REPLIT_DOMAINS blank", vars: { REPLIT_DEPLOYMENT: "1", REPLIT_DOMAINS: " ", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "unlabelled deployment, REPLIT_DEPLOYMENT present but empty, REPLIT_DOMAINS absent", vars: { REPLIT_DEPLOYMENT: "", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "production deployment WITH REPLIT_DOMAINS (unchanged)", vars: { REPLIT_DEPLOYMENT: "1", REPLIT_DOMAINS: "portava.replit.app", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  { name: "production deployment declared PORTAVA_DEPLOYMENT_ENV=production, REPLIT_DOMAINS absent", vars: { REPLIT_DEPLOYMENT: "1", PORTAVA_DEPLOYMENT_ENV: "production", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  { name: "the labelled beta deployment, REPLIT_DOMAINS absent", vars: { ...BETA_OK, REPLIT_DEPLOYMENT: "1" }, api: true, build: true },
  { name: "local / CI run (no REPLIT_DEPLOYMENT), no REPLIT_DOMAINS (unchanged)", vars: { SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: true, build: true },
  // Sentry (lead, 2026-10-07): beta reports only to an allowlisted beta project — production's DSN (a Secret, not in
  // this repo) is refused because it is not on the list.
  { name: "beta with an inherited server SENTRY_DSN", vars: { ...BETA_OK, SENTRY_DSN: SOME_DSN }, api: false, build: false },
  { name: "beta with an inherited web-bundle EXPO_PUBLIC_SENTRY_DSN", vars: { ...BETA_OK, EXPO_PUBLIC_SENTRY_DSN: SOME_DSN }, api: false, build: false },
  { name: "beta with both DSNs empty", vars: { ...BETA_OK, SENTRY_DSN: "", EXPO_PUBLIC_SENTRY_DSN: " " }, api: true, build: true },
  { name: "production with its DSN (unchanged)", vars: { SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD, SENTRY_DSN: SOME_DSN, EXPO_PUBLIC_SENTRY_DSN: SOME_DSN }, api: true, build: true },
];

function runGuard(vars: Record<string, string>) {
  const r = spawnSync("bash", [GUARD], { env: env(vars), encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("deployment-env-guard.sh — the build-time rule", () => {
  for (const c of CASES) {
    it(`${c.build ? "builds" : "REFUSES"}: ${c.name}`, () => {
      const r = runGuard(c.vars);
      assert.equal(r.status, c.build ? 0 : 1, r.out);
      if (!c.build) assert.match(r.out, /REFUSING TO BUILD \(PORTAVA_DEPLOYMENT_ENV\)/);
    });
  }

  it("names offending variables but never prints their values", () => {
    const r = runGuard(CASES[7].vars);
    assert.match(r.out, /DATABASE_URL/);
    assert.doesNotMatch(r.out, /pooler\.example|:pw@/);
  });
});

describe("the API rule agrees with the table", () => {
  let refusal: (env: NodeJS.ProcessEnv) => string | null;
  before(async () => {
    const mod = (await import(pathToFileURL(API_RULE).href)) as { deploymentEnvironmentRefusal: typeof refusal };
    refusal = mod.deploymentEnvironmentRefusal;
  });
  for (const c of CASES) {
    it(`${c.api ? "starts" : "REFUSES"}: ${c.name}`, () => {
      assert.equal(refusal(c.vars) === null, c.api, String(refusal(c.vars)));
    });
  }

  it("the beta Sentry allowlist is ONE list: API rule, build guard and the app agree (empty until the owner creates the beta project)", () => {
    const ts = readFileSync(API_RULE, "utf8");
    const sh = readFileSync(GUARD, "utf8");
    const app = readFileSync(join(REPO_ROOT, "travel-buddy-standalone", "src", "lib", "deploymentConsistency.ts"), "utf8");
    const listOf = (src: string) => {
      const m = /BETA_SENTRY_DSNS: readonly string\[\] = \[([^\]]*)\]/.exec(src);
      assert.ok(m, "BETA_SENTRY_DSNS not found");
      return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();
    };
    const shm = /^BETA_SENTRY_DSNS="([^"]*)"$/m.exec(sh);
    assert.ok(shm, "BETA_SENTRY_DSNS not found in the shell guard");
    const shellList = shm[1].split(/\s+/).filter(Boolean).sort();
    assert.deepEqual(listOf(ts), listOf(app));
    assert.deepEqual(listOf(ts), shellList);
  });

  it("both implementations carry the same two refs", () => {
    const sh = readFileSync(GUARD, "utf8");
    const ts = readFileSync(API_RULE, "utf8");
    for (const ref of ["emfpckykpzfturllshly", "ajrurzioarfkagpuxfnb"]) {
      assert.ok(sh.includes(`"${ref}"`) && ts.includes(`"${ref}"`), ref);
    }
  });
});

/**
 * `.replit` [userenv.*] as the fork inherits it: KEY = "value" lines of the shared and production sections. Only
 * the simple `KEY = "value"` shape exists in the file; anything else in those sections fails the parse loudly.
 */
function replitUserenv(): Map<string, string> {
  const out = new Map<string, string>();
  let section = "";
  for (const raw of readFileSync(join(REPO_ROOT, ".replit"), "utf8").split("\n")) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    if (section !== "userenv.shared" && section !== "userenv.production") continue;
    if (!line || line.startsWith("#")) continue;
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"$/.exec(line);
    assert.ok(kv, `.replit [${section}] has a line this test cannot read: ${line}`);
    out.set(kv[1], kv[2]);
  }
  return out;
}

describe("the .replit a beta fork inherits — every production value in it is caught by BOTH rules", () => {
  const replit = replitUserenv();
  let api: { refusal: (env: NodeJS.ProcessEnv) => string | null; namesProduction: (v: string) => boolean; key: string };
  before(async () => {
    const mod = (await import(pathToFileURL(API_RULE).href)) as {
      deploymentEnvironmentRefusal: (env: NodeJS.ProcessEnv) => string | null;
      namesProduction: (v: string) => boolean;
      PRODUCTION_PUBLISHABLE_KEY: string;
    };
    api = { refusal: mod.deploymentEnvironmentRefusal, namesProduction: mod.namesProduction, key: mod.PRODUCTION_PUBLISHABLE_KEY };
  });
  /** The .replit keys whose value names production — the hazard the fork inherits. */
  const productionKeys = () => [...replit].filter(([, v]) => api.namesProduction(v)).map(([k]) => k).sort();

  it("both rules carry .replit's production publishable key (a rotation in .replit turns this red)", () => {
    const committed = replit.get("EXPO_PUBLIC_SUPABASE_ANON_KEY");
    assert.ok(committed?.startsWith("sb_publishable_"), "could not read the publishable key from .replit");
    assert.equal(api.key, committed, "lib/deploymentEnvironment.ts PRODUCTION_PUBLISHABLE_KEY");
    assert.ok(readFileSync(GUARD, "utf8").includes(`PROD_PUBLISHABLE_KEY="${committed}"`), "scripts/deployment-env-guard.sh");
    assert.equal(PROD_PUBLISHABLE_KEY, committed, "this test's own constant");
  });

  it("the inherited production values are the ones the runbook names (not vacuous)", () => {
    // Pinned so a parse that silently finds nothing cannot pass the per-key test below.
    for (const k of ["SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_ANON_KEY", "ALLOWED_ORIGINS"]) {
      assert.ok(productionKeys().includes(k), `${k} is not detected as a production value in .replit`);
    }
  });

  it("each production value, kept alone in an otherwise-correct beta environment, is refused by the API AND the build, naming the key", () => {
    for (const k of productionKeys()) {
      const vars = { ...BETA_OK, [k]: replit.get(k) as string };
      const r = api.refusal(vars);
      assert.ok(r && r.includes(k), `API rule with inherited ${k}: ${r}`);
      const g = runGuard(vars);
      assert.equal(g.status, 1, `build guard with inherited ${k}: ${g.out}`);
      assert.match(g.out, new RegExp(k), g.out);
      assert.ok(!g.out.includes(replit.get(k) as string), `the guard printed ${k}'s value`);
    }
  });

  it("a fork labelled beta that kept .replit exactly as inherited does not start or build", () => {
    const vars = { ...Object.fromEntries(replit), PORTAVA_DEPLOYMENT_ENV: "beta", NODE_ENV: "production" };
    assert.ok(api.refusal(vars));
    assert.equal(runGuard(vars).status, 1);
  });

  it("an UNLABELLED fork serving at portava-beta.replit.app with .replit as inherited does not start or build", () => {
    const vars = { ...Object.fromEntries(replit), REPLIT_DOMAINS: "portava-beta.replit.app" };
    assert.match(String(api.refusal(vars)), /REPLIT_DOMAINS names the beta origin/);
    const g = runGuard(vars);
    assert.equal(g.status, 1, g.out);
    assert.match(g.out, /REPLIT_DOMAINS names the beta origin/);
  });

  it("production itself, with .replit as committed, still starts and builds (behaviour unchanged)", () => {
    const vars = { ...Object.fromEntries(replit), REPLIT_DOMAINS: "portava.replit.app" };
    assert.equal(api.refusal(vars), null);
    assert.equal(runGuard(vars).status, 0);
  });

  it("the runbook's step 5 names every .replit key that carries a production value", () => {
    const runbook = readFileSync(join(REPO_ROOT, "docs", "ops", "beta-runtime-runbook.md"), "utf8");
    for (const k of productionKeys()) assert.ok(runbook.includes(`\`${k}\``), `docs/ops/beta-runtime-runbook.md does not name ${k}`);
  });
});

describe("build-production.sh end to end (pnpm and node replaced by recorders)", () => {
  let bin = "";
  let log = "";
  before(() => {
    bin = mkdtempSync(join(tmpdir(), "beta-build-guard-"));
    log = join(bin, "calls.log");
    for (const tool of ["pnpm", "node"]) {
      const p = join(bin, tool);
      writeFileSync(p, `#!/bin/sh\necho "${tool} $*" >> "${log}"\nexit 0\n`);
      chmodSync(p, 0o755);
    }
  });
  after(() => rmSync(bin, { recursive: true, force: true }));

  function build(vars: Record<string, string>) {
    writeFileSync(log, "");
    const r = spawnSync("bash", [BUILD], {
      cwd: REPO_ROOT,
      env: env(vars, `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`),
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  }

  it("REFUSED beta build: exit non-zero, neither build step is invoked", () => {
    const r = build({ PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD });
    assert.notEqual(r.status, 0, r.out);
    assert.deepEqual(r.calls, [], "nothing may be built once the guard refuses");
    assert.doesNotMatch(r.out, /\[1\/2\]/);
  });

  it("production's environment: both steps run, in order (behaviour unchanged)", () => {
    const r = build({ SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, [
      "pnpm --filter @workspace/api-server run build",
      "node travel-buddy-standalone/scripts/build.js",
    ]);
  });

  it("a correct beta environment: both steps run", () => {
    const r = build({ PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.length, 2, r.out);
  });
});
