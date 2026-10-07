/**
 * A BETA deployment can never reach PRODUCTION — lib/deploymentEnvironment.ts,
 * lib/deploymentEnvironmentGuard.ts and their import at the top of src/index.ts.
 *
 * Three layers, each asserting the resulting STATE (an exit code and the line
 * an operator reads), never just a return value:
 *
 *   1. the pure rule over a case table (accepted and refused, both polarities);
 *   2. the guard module run as its own process — exit 1 with a message naming
 *      PORTAVA_DEPLOYMENT_ENV, or exit 0 for production's own environment;
 *   3. THE API ENTRY ITSELF (src/index.ts) run with PORTAVA_DEPLOYMENT_ENV=beta
 *      and a non-beta SUPABASE_URL: it exits 1 with the guard's line, BEFORE
 *      assertRequiredEnv runs. SUPABASE_SERVICE_ROLE_KEY and SESSION_SECRET are
 *      deliberately absent, so if the guard were not wired (or wired after
 *      ./app) the process would still exit 1 — on the required-env message —
 *      and never listen. The URL is a made-up ref, so no real project is ever
 *      contacted, even by the mutation proof.
 *
 * Run: node --import tsx/esm --test src/test/deploymentEnvironmentGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BETA_SENTRY_DSNS,
  BETA_SUPABASE_URL,
  DEPLOYMENT_ENV_VAR,
  PRODUCTION_PUBLISHABLE_KEY,
  PRODUCTION_SUPABASE_REF,
  deploymentEnvironmentRefusal,
} from "../lib/deploymentEnvironment.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const FAKE_URL = "https://zzzzzzzzzzzzzzzzzzzz.supabase.co";

describe("deploymentEnvironmentRefusal — the rule", () => {
  it("production as it is today (no label, production URL) starts", () => {
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL }), null);
  });

  it("an explicit production label with production's URL starts", () => {
    assert.equal(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "production", SUPABASE_URL: PROD_URL }), null);
  });

  it("beta with the beta project's URL, in production mode, starts", () => {
    assert.equal(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: BETA_SUPABASE_URL }), null);
    assert.equal(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: `${BETA_SUPABASE_URL}/` }), null);
  });

  it("REFUSED: beta pointed at production (the inherited .replit value)", () => {
    const r = deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: PROD_URL });
    assert.ok(r && r.includes(DEPLOYMENT_ENV_VAR) && r.includes("PRODUCTION"), String(r));
  });

  it("REFUSED: beta pointed at any other project, or with no URL", () => {
    assert.ok(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: FAKE_URL }));
    assert.ok(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta" }));
    assert.ok(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: `${BETA_SUPABASE_URL}.evil.example` }));
  });

  it("REFUSED: beta whose OTHER variables still carry production's ref — named, value not printed", () => {
    const secretish = `postgresql://postgres.${PRODUCTION_SUPABASE_REF}:hunter2@pooler.example:6543/postgres`;
    const r = deploymentEnvironmentRefusal({
      [DEPLOYMENT_ENV_VAR]: "beta",
      SUPABASE_URL: BETA_SUPABASE_URL,
      EXPO_PUBLIC_SUPABASE_URL: PROD_URL,
      DATABASE_URL: secretish,
    });
    assert.ok(r, "a beta process carrying production's ref must not start");
    assert.ok(r.includes("DATABASE_URL") && r.includes("EXPO_PUBLIC_SUPABASE_URL"), r);
    assert.ok(!r.includes("hunter2") && !r.includes("pooler.example"), "values are never printed");
  });

  it("REFUSED (verifier M3): beta whose API / web origin or CORS list still names production's API host", () => {
    const base = { [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: BETA_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_URL: BETA_SUPABASE_URL };
    for (const [name, value] of [
      ["EXPO_PUBLIC_API_BASE_URL", "https://portava.replit.app"],
      ["EXPO_PUBLIC_WEB_ORIGIN", "https://PORTAVA.Replit.App"],
      ["ALLOWED_ORIGINS", "https://portava-beta.replit.app,https://portava.replit.app"],
      ["API_BASE_URL", "https://api.portava.replit.app/v1"],
    ] as const) {
      const r = deploymentEnvironmentRefusal({ ...base, [name]: value });
      assert.ok(r && r.includes(name) && r.includes("portava.replit.app"), `${name}=${value} → ${r}`);
    }
    // the beta origin itself is not production's
    assert.equal(
      deploymentEnvironmentRefusal({ ...base, EXPO_PUBLIC_API_BASE_URL: "https://portava-beta.replit.app", ALLOWED_ORIGINS: "https://portava-beta.replit.app" }),
      null,
    );
  });

  it("REFUSED (verifier M1/M2): production's ref in UPPER case is still production", () => {
    const base = { [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: BETA_SUPABASE_URL };
    const m1 = deploymentEnvironmentRefusal({ ...base, DATABASE_URL: `postgresql://postgres.${PRODUCTION_SUPABASE_REF.toUpperCase()}:pw@pooler.example:6543/postgres` });
    assert.ok(m1 && m1.includes("DATABASE_URL"), String(m1));
    const m2 = deploymentEnvironmentRefusal({ ...base, SUPABASE_PUBLIC_URL: `https://${PRODUCTION_SUPABASE_REF.toUpperCase()}.supabase.co` });
    assert.ok(m2 && m2.includes("SUPABASE_PUBLIC_URL"), String(m2));
  });

  it("REFUSED: an unrecognised label, so a typo cannot switch the guard off", () => {
    for (const v of ["Beta", "beta ", "BETA", "staging", "prod"]) {
      const r = deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: v, SUPABASE_URL: PROD_URL });
      assert.ok(r && r.includes("unrecognised"), `${JSON.stringify(v)} → ${r}`);
    }
  });

  it("REFUSED: the beta project without the beta label (the label keeps the guard armed)", () => {
    assert.ok(deploymentEnvironmentRefusal({ SUPABASE_URL: BETA_SUPABASE_URL }));
    assert.ok(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "production", SUPABASE_URL: BETA_SUPABASE_URL }));
  });
});

describe("deploymentEnvironmentRefusal — beta runs test-mode providers, in production mode, under its own label (lane BETA2, 2026-10-07)", () => {
  const BETA_OK = { [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: BETA_SUPABASE_URL };

  it("REFUSED: a beta process outside production mode — unset, development or test", () => {
    for (const nodeEnv of [undefined, "", "development", "test", "Production"]) {
      const env: NodeJS.ProcessEnv = { [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: BETA_SUPABASE_URL };
      if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
      const r = deploymentEnvironmentRefusal(env);
      assert.ok(r && r.includes("NODE_ENV") && r.includes("mock identity provider"), `NODE_ENV=${JSON.stringify(nodeEnv)} → ${r}`);
    }
    assert.equal(deploymentEnvironmentRefusal(BETA_OK), null);
  });

  it("production mode is NOT demanded of production (behaviour unchanged)", () => {
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL }), null);
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, NODE_ENV: "development" }), null);
  });

  it("REFUSED: a LIVE-mode provider credential anywhere in a beta environment — named, value not printed", () => {
    for (const [name, value] of [
      ["STRIPE_SECRET_KEY", "sk_live_51SECRETvalue"],
      ["STRIPE_IDENTITY_SECRET_KEY", "rk_live_51SECRETvalue"],
      ["EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_live_51SECRETvalue"],
      ["PERSONA_API_KEY", "persona_production_SECRETvalue"],
      ["SUMSUB_APP_TOKEN", "prd:SECRETvalue"],
      ["SOME_JSON_BLOB", '{"key":"sk_live_51SECRETvalue"}'],
    ] as const) {
      const r = deploymentEnvironmentRefusal({ ...BETA_OK, [name]: value });
      assert.ok(r && r.includes(name) && r.includes("LIVE-mode"), `${name} → ${r}`);
      assert.ok(!r.includes("SECRETvalue"), "values are never printed");
    }
  });

  it("test/sandbox credentials start; a prd: value outside SUMSUB_* is not a provider token", () => {
    assert.equal(
      deploymentEnvironmentRefusal({
        ...BETA_OK,
        STRIPE_SECRET_KEY: "sk_test_51x",
        STRIPE_IDENTITY_SECRET_KEY: "rk_test_51x",
        EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_51x",
        PERSONA_API_KEY: "persona_sandbox_x",
        SUMSUB_APP_TOKEN: "sbx:x",
        RELEASE_CHANNEL: "prd:x",
        NOTE: "ask_live_support", // `sk_live_` must follow a boundary
      }),
      null,
    );
  });

  it("REFUSED: PAYMENTS_ALLOW_LIVE set to anything but empty or \"false\"", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) {
      const r = deploymentEnvironmentRefusal({ ...BETA_OK, PAYMENTS_ALLOW_LIVE: v });
      assert.ok(r && r.includes("PAYMENTS_ALLOW_LIVE"), `${v} → ${r}`);
    }
    for (const v of ["", "false"]) assert.equal(deploymentEnvironmentRefusal({ ...BETA_OK, PAYMENTS_ALLOW_LIVE: v }), null, v);
  });

  it("REFUSED: production's publishable key (the one .replit commits, so a fork inherits it)", () => {
    const r = deploymentEnvironmentRefusal({ ...BETA_OK, EXPO_PUBLIC_SUPABASE_ANON_KEY: PRODUCTION_PUBLISHABLE_KEY });
    assert.ok(r && r.includes("EXPO_PUBLIC_SUPABASE_ANON_KEY") && r.includes("publishable key"), String(r));
    assert.ok(!r.includes(PRODUCTION_PUBLISHABLE_KEY), "the key is not printed");
  });

  it("REFUSED: an unlabelled (or production-labelled) process that Replit says is serving the beta origin", () => {
    for (const label of [undefined, "production"]) {
      const env: NodeJS.ProcessEnv = { SUPABASE_URL: PROD_URL, REPLIT_DOMAINS: "x.kirk.replit.dev,portava-beta.replit.app" };
      if (label) env[DEPLOYMENT_ENV_VAR] = label;
      assert.match(String(deploymentEnvironmentRefusal(env)), /REPLIT_DOMAINS names the beta origin portava-beta\.replit\.app/);
    }
    // upper case is the same host (verifier F4: the API rule must fold case like the shell twin)
    assert.match(String(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, REPLIT_DOMAINS: "PORTAVA-BETA.REPLIT.APP" })), /REPLIT_DOMAINS names the beta origin/);
    // production's own domain, and a host that merely contains the name, are not the beta origin
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, REPLIT_DOMAINS: "portava.replit.app" }), null);
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, REPLIT_DOMAINS: "notportava-beta.replit.app" }), null);
    // the labelled beta fork at its own origin starts
    assert.equal(deploymentEnvironmentRefusal({ ...BETA_OK, REPLIT_DOMAINS: "portava-beta.replit.app" }), null);
  });
});

describe("deploymentEnvironmentRefusal — an unlabelled Replit deployment without REPLIT_DOMAINS fails closed (lead, 2026-10-07)", () => {
  it("REFUSED: REPLIT_DEPLOYMENT present (any value), no label, REPLIT_DOMAINS absent or blank", () => {
    for (const extra of [{ REPLIT_DEPLOYMENT: "1" }, { REPLIT_DEPLOYMENT: "" }, { REPLIT_DEPLOYMENT: "1", REPLIT_DOMAINS: "  " }]) {
      const r = deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, ...extra });
      assert.ok(r && r.includes("REPLIT_DOMAINS") && r.includes(`${DEPLOYMENT_ENV_VAR}=production`), `${JSON.stringify(extra)} → ${r}`);
    }
  });

  it("starts: production declared, production with REPLIT_DOMAINS, the labelled beta, and every non-deployment run", () => {
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, REPLIT_DEPLOYMENT: "1", [DEPLOYMENT_ENV_VAR]: "production" }), null);
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, REPLIT_DEPLOYMENT: "1", REPLIT_DOMAINS: "portava.replit.app" }), null);
    assert.equal(deploymentEnvironmentRefusal({ [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: BETA_SUPABASE_URL, REPLIT_DEPLOYMENT: "1" }), null);
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL }), null);
  });
});

describe("deploymentEnvironmentRefusal — beta never reports to a Sentry project that is not the beta's (lead, 2026-10-07)", () => {
  const BETA_OK = { [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: BETA_SUPABASE_URL };
  const DSN = "https://0123456789abcdef0123456789abcdef@o4500000000000000.ingest.us.sentry.io/4500000000000001";

  it("REFUSED: an inherited SENTRY_DSN or EXPO_PUBLIC_SENTRY_DSN — named, value not printed", () => {
    for (const name of ["SENTRY_DSN", "EXPO_PUBLIC_SENTRY_DSN"]) {
      const r = deploymentEnvironmentRefusal({ ...BETA_OK, [name]: DSN });
      assert.ok(r && r.includes(name) && r.includes("Sentry"), `${name} → ${r}`);
      assert.ok(!r.includes("ingest.us.sentry.io"), "the DSN is not printed");
    }
  });

  it("starts with no DSN (or blank), and production keeps its DSN (unchanged)", () => {
    assert.equal(deploymentEnvironmentRefusal({ ...BETA_OK, SENTRY_DSN: "", EXPO_PUBLIC_SENTRY_DSN: "  " }), null);
    assert.equal(deploymentEnvironmentRefusal({ SUPABASE_URL: PROD_URL, SENTRY_DSN: DSN }), null);
    assert.deepEqual(BETA_SENTRY_DSNS, [], "the allowlist is empty until the owner creates the beta Sentry project");
  });
});

/** A child environment with nothing Supabase-, Sentry- or deployment-shaped inherited from this runner. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(SUPABASE_|EXPO_PUBLIC_|SENTRY_|PORTAVA_|SESSION_SECRET$|PORT$|DATABASE_URL$)/.test(k)) continue;
    if (typeof v === "string" && v.includes(PRODUCTION_SUPABASE_REF)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function run(entry: string, extra: Record<string, string>, timeoutMs = 120_000) {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", entry], {
    cwd: PKG_ROOT,
    env: childEnv(extra),
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { status: r.status, signal: r.signal, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("deploymentEnvironmentGuard — the process", () => {
  it("exits 1 naming PORTAVA_DEPLOYMENT_ENV when a beta process points at production", () => {
    const r = run("src/lib/deploymentEnvironmentGuard.ts", { [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: PROD_URL });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /REFUSING TO START \(PORTAVA_DEPLOYMENT_ENV\)/);
  });

  it("exits 0 for production's own environment (behaviour unchanged)", () => {
    const r = run("src/lib/deploymentEnvironmentGuard.ts", { SUPABASE_URL: PROD_URL });
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /REFUSING/);
  });

  it("exits 0 for a correctly configured beta process", () => {
    const r = run("src/lib/deploymentEnvironmentGuard.ts", { [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "production", SUPABASE_URL: BETA_SUPABASE_URL });
    assert.equal(r.status, 0, r.out);
  });

  it("exits 1 for a beta process outside production mode (NODE_ENV=development admits the mock identity provider)", () => {
    const r = run("src/lib/deploymentEnvironmentGuard.ts", { [DEPLOYMENT_ENV_VAR]: "beta", NODE_ENV: "development", SUPABASE_URL: BETA_SUPABASE_URL });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /REFUSING TO START \(PORTAVA_DEPLOYMENT_ENV\).*NODE_ENV/);
  });
});

describe("src/index.ts — the API refuses to start before anything else runs", () => {
  it("PORTAVA_DEPLOYMENT_ENV=beta with a non-beta SUPABASE_URL: exit 1 on the guard's line, not the required-env one", () => {
    const r = run("src/index.ts", { [DEPLOYMENT_ENV_VAR]: "beta", SUPABASE_URL: FAKE_URL }, 170_000);
    assert.equal(r.signal, null, `the entry did not exit by itself:\n${r.out.slice(-2000)}`);
    assert.equal(r.status, 1, r.out.slice(-2000));
    assert.match(r.out, /REFUSING TO START \(PORTAVA_DEPLOYMENT_ENV\)/, r.out.slice(-2000));
    assert.doesNotMatch(r.out, /required variables missing/, "the guard must run BEFORE assertRequiredEnv and ./app");
    assert.doesNotMatch(r.out, /Server listening/);
  });
});
