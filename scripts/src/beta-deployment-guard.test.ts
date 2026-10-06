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
  { name: "beta, both URLs beta", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: `${BETA}/` }, api: true, build: true },
  { name: "beta inheriting .replit's production values", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: PROD, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "beta API URL fixed, web URL still production", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: PROD }, api: false, build: false },
  { name: "beta web URL fixed, API URL another project", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: OTHER, EXPO_PUBLIC_SUPABASE_URL: BETA }, api: false, build: false },
  { name: "beta, web URL missing (API alone is fine; the build is not)", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA }, api: true, build: false },
  { name: "beta, a pooler URL still on production", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, DATABASE_URL: "postgresql://postgres.ajrurzioarfkagpuxfnb:pw@pooler.example:6543/postgres" }, api: false, build: false },
  { name: "verifier M3: beta with production's API origin, web origin and CORS list", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, EXPO_PUBLIC_API_BASE_URL: "https://portava.replit.app", EXPO_PUBLIC_WEB_ORIGIN: "https://portava.replit.app", ALLOWED_ORIGINS: "https://portava.replit.app" }, api: false, build: false },
  { name: "beta with production's API origin in upper case, one variable only", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, EXPO_PUBLIC_API_BASE_URL: "https://PORTAVA.REPLIT.APP" }, api: false, build: false },
  { name: "beta with the beta origins everywhere", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, EXPO_PUBLIC_API_BASE_URL: "https://portava-beta.replit.app", EXPO_PUBLIC_WEB_ORIGIN: "https://portava-beta.replit.app", ALLOWED_ORIGINS: "https://portava-beta.replit.app" }, api: true, build: true },
  { name: "verifier M1: beta with an upper-case production ref in a pooler URL", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, DATABASE_URL: "postgresql://postgres.AJRURZIOARFKAGPUXFNB:pw@pooler.example:6543/postgres" }, api: false, build: false },
  { name: "verifier M2: beta with an upper-case production Supabase URL in another variable", vars: { PORTAVA_DEPLOYMENT_ENV: "beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA, SUPABASE_PUBLIC_URL: "https://AJRURZIOARFKAGPUXFNB.supabase.co" }, api: false, build: false },
  { name: "typo in the label", vars: { PORTAVA_DEPLOYMENT_ENV: "Beta", SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA }, api: false, build: false },
  { name: "beta project without the beta label", vars: { SUPABASE_URL: BETA, EXPO_PUBLIC_SUPABASE_URL: BETA }, api: false, build: false },
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

  it("both implementations carry the same two refs", () => {
    const sh = readFileSync(GUARD, "utf8");
    const ts = readFileSync(API_RULE, "utf8");
    for (const ref of ["emfpckykpzfturllshly", "ajrurzioarfkagpuxfnb"]) {
      assert.ok(sh.includes(`"${ref}"`) && ts.includes(`"${ref}"`), ref);
    }
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
