/**
 * deploymentEnvironment.ts — a BETA deployment can never reach PRODUCTION.
 *
 * WHY THIS EXISTS
 * ===============
 * The private beta runs on a fork of the Replit app (`portava-beta`) against
 * its own Supabase project, portava-beta (ref emfpckykpzfturllshly). The fork
 * inherits `.replit`, whose `[userenv.shared]` HARD-CODES production:
 * `SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_URL` are
 * https://ajrurzioarfkagpuxfnb.supabase.co. Nothing used to stop a "beta"
 * deployment from booting against production and serving production data to
 * testers — a missed Secret, or a later `git pull` that restores the tracked
 * `.replit`, would do it silently.
 *
 * THE RULE
 * ========
 * PORTAVA_DEPLOYMENT_ENV names the deployment. It is a NEW variable on purpose:
 * the nearest existing one, APP_ENV, is read by exactly one seed script
 * (src/scripts/seed-test-media.ts, `=== "production"`) and its value in the
 * production Replit Secrets is unmeasurable from this repo. The rule below
 * refuses UNRECOGNISED values — a typo such as "Beta" or "beta " must not
 * silently switch the guard off — and imposing that on a variable whose
 * production value nobody can read would risk taking production down at boot.
 * A fresh name has no production value, so strictness costs production nothing.
 *
 *   unset / ""     → no label. Production today. Allowed, EXCEPT that the beta
 *                    project's URL is refused without the beta label: the label
 *                    is what keeps the guard armed on the beta host.
 *   "production"   → allowed with any SUPABASE_URL but the beta project's.
 *   "beta"         → SUPABASE_URL must be exactly the beta project's URL, and
 *                    no environment variable may name production: its project
 *                    ref (a pooler/DB URL, a second Supabase URL, an
 *                    EXPO_PUBLIC_*), its API origin portava.replit.app
 *                    (EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_WEB_ORIGIN,
 *                    ALLOWED_ORIGINS, …), case-insensitively, or production's
 *                    publishable key (the one .replit [userenv.shared] commits,
 *                    which a fork inherits).
 *                    No variable may hold a LIVE-mode provider credential
 *                    (Stripe sk_live_/rk_live_/pk_live_, Persona
 *                    persona_production_, a Sumsub prd: app token) and
 *                    PAYMENTS_ALLOW_LIVE must be unset, empty or "false": the
 *                    beta uses test/sandbox keys only.
 *                    SENTRY_DSN / EXPO_PUBLIC_SENTRY_DSN must be unset or an
 *                    allowlisted BETA DSN (BETA_SENTRY_DSNS): beta never
 *                    reports to production's Sentry project. (lib/sentry.ts
 *                    initialises before this guard runs; a refused process
 *                    exits before it serves a request.)
 *                    NODE_ENV must be "production": development and test modes
 *                    admit the unsigned mock identity provider and the fake
 *                    payment provider (lib/paymentsMode.ts mockIdentityPermitted),
 *                    which must never run against the beta database.
 *                    Variables are NAMED in the refusal; values never printed.
 *   anything else  → refused, naming the accepted values.
 *
 * And whatever the label: a process whose REPLIT_DOMAINS (set by Replit: "all
 * domains associated with your Replit project", docs.replit.com Secrets page,
 * read 2026-10-07) names the beta origin portava-beta.replit.app must be
 * labelled beta. A fork that inherited .replit's production URLs and was never
 * labelled would otherwise serve PRODUCTION's data at the beta address — the
 * label alone cannot arm a guard nobody set. Production's own REPLIT_DOMAINS
 * names portava.replit.app, which this does not match.
 *
 * FAIL CLOSED WHEN REPLIT_DOMAINS IS ABSENT IN A DEPLOYMENT (lead, 2026-10-07).
 * Replit's docs (Secrets page, read 2026-10-07) list REPLIT_DOMAINS among the
 * variables Replit sets, but do NOT say whether a published deployment carries
 * it; that has not been observed here. So an UNLABELLED process inside a Replit
 * deployment (REPLIT_DEPLOYMENT present, "Set to 1 if the code is running in a
 * published project") with no REPLIT_DOMAINS is refused: it cannot show that it
 * is not the beta fork. An explicit label lifts it — PORTAVA_DEPLOYMENT_ENV=production
 * on production, =beta on the fork. Local runs, tests and CI (no
 * REPLIT_DEPLOYMENT) are unaffected. RUNTIME ONLY (lead ruling BETA-8): this rule
 * refuses at SERVER START; the build guard (scripts/deployment-env-guard.sh) does
 * not apply it, because the build phase's environment is not verified and a
 * build refusal could stop production's build. PRODUCTION PRE-REQUISITE (owner
 * action B15): add PORTAVA_DEPLOYMENT_ENV=production to production's Secrets (or
 * confirm REPLIT_DOMAINS is present at runtime there), or the next deploy that
 * carries this rule builds but refuses to start.
 *
 * Production's behaviour is unchanged: with the variable unset and production's
 * own URL, deploymentEnvironmentRefusal() returns null.
 *
 * WHERE IT RUNS
 * =============
 * lib/deploymentEnvironmentGuard.ts imports this and exits 1 on a refusal. It is
 * imported by src/index.ts directly after Sentry and BEFORE `./app`, so it is
 * evaluated before any module that could open a Supabase client. The web build
 * (scripts/build-production.sh) applies the same rule through
 * scripts/deployment-env-guard.sh, except the REPLIT_DOMAINS-absent refusal
 * (runtime only, BETA-8); scripts/src/beta-deployment-guard.test.ts runs both
 * over one case table, each row stating both verdicts, so the two cannot drift.
 */

/** The variable that names the deployment. */
export const DEPLOYMENT_ENV_VAR = "PORTAVA_DEPLOYMENT_ENV";

/** portava-beta — the only project a beta deployment may use. */
export const BETA_SUPABASE_REF = "emfpckykpzfturllshly";
export const BETA_SUPABASE_URL = `https://${BETA_SUPABASE_REF}.supabase.co`;

/** Production. A beta deployment must not carry this ref anywhere in its environment. */
export const PRODUCTION_SUPABASE_REF = "ajrurzioarfkagpuxfnb";

export const ACCEPTED_DEPLOYMENT_ENVS = ["production", "beta"] as const;
export type DeploymentEnv = (typeof ACCEPTED_DEPLOYMENT_ENVS)[number];

/** https://<ref>.supabase.co (optional trailing slash) → ref; anything else → null. */
export function supabaseRefOf(url: string | undefined): string | null {
  if (!url) return null;
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/.exec(url);
  return m ? m[1] : null;
}

/** Production's API / web origin host. A beta process must not carry it anywhere in its environment either. */
export const PRODUCTION_API_HOST = "portava.replit.app";

/** The beta API / web origin host (the expected name of the Replit fork; docs/ops/beta-runtime-runbook.md). */
export const BETA_API_HOST = "portava-beta.replit.app";

/**
 * Production's Supabase PUBLISHABLE key — public by design, and committed in .replit [userenv.shared] as
 * EXPO_PUBLIC_SUPABASE_ANON_KEY, so a fork inherits it. It carries neither the ref nor the host, so without this a
 * beta environment that kept it passed the rule. scripts/src/beta-deployment-guard.test.ts fails if .replit's value
 * and this constant ever differ.
 */
export const PRODUCTION_PUBLISHABLE_KEY = "sb_publishable_xp3JiB50mBYHn1S_XjzOAg_rIoEqZKS";

/**
 * Does `value` hold a LIVE-mode provider credential? Documented prefixes only:
 * Stripe `sk_live_` / `rk_live_` / `pk_live_` (https://docs.stripe.com/keys, read 2026-10-07: "live mode keys, which
 * start with pk_live_, rk_live_, and sk_live_") and Persona `persona_production_` (lib/paymentsMode.ts), found
 * anywhere in the value after a non-alphanumeric boundary. Case-sensitive, as the providers' prefixes are.
 */
export function holdsLiveCredential(name: string, value: string): boolean {
  if (/(^|[^A-Za-z0-9])(sk_live_|rk_live_|pk_live_|persona_production_)/.test(value)) return true;
  // Sumsub app tokens: `sbx:` sandbox, `prd:` production (docs.sumsub.com "App Tokens", as read by PR #612).
  return /^SUMSUB_/.test(name) && /^\s*prd:/.test(value);
}

/** The names (never the values) of variables holding a live credential, plus PAYMENTS_ALLOW_LIVE when it is set. */
export function variablesPermittingLiveMode(env: NodeJS.ProcessEnv): string[] {
  const names = Object.keys(env).filter((k) => typeof env[k] === "string" && holdsLiveCredential(k, env[k] as string));
  const allowLive = env["PAYMENTS_ALLOW_LIVE"];
  if (allowLive !== undefined && allowLive !== "" && allowLive !== "false" && !names.includes("PAYMENTS_ALLOW_LIVE")) {
    names.push("PAYMENTS_ALLOW_LIVE");
  }
  return names.sort();
}

/**
 * Sentry DSNs a BETA process may report to (lead ruling, 2026-10-07). EMPTY until the owner creates the beta Sentry
 * project; until then a beta process reports to no Sentry project at all. Production's DSN is a Secret and is not in
 * this repository, so this is an ALLOWLIST: whatever DSN a fork's Secrets or an EAS environment carries is refused
 * unless it is listed here. Kept identical to scripts/deployment-env-guard.sh BETA_SENTRY_DSNS and
 * travel-buddy-standalone/src/lib/deploymentConsistency.ts BETA_SENTRY_DSNS (scripts/src/beta-deployment-guard.test.ts).
 */
export const BETA_SENTRY_DSNS: readonly string[] = [];

/** The variables that carry a Sentry DSN: the API's own, and the one the web bundle inlines. */
export const SENTRY_DSN_VARIABLES = ["SENTRY_DSN", "EXPO_PUBLIC_SENTRY_DSN"] as const;

/** Names (never values) of DSN variables that are set and are not an allowlisted beta DSN. */
export function variablesWithForeignSentryDsn(env: NodeJS.ProcessEnv): string[] {
  return SENTRY_DSN_VARIABLES.filter((k) => {
    const v = (env[k] ?? "").trim();
    return v !== "" && !BETA_SENTRY_DSNS.includes(v);
  });
}

/** Does REPLIT_DOMAINS (comma-separated, set by Replit) name the beta origin's host? */
export function replitDomainsNameBeta(env: NodeJS.ProcessEnv): boolean {
  const v = (env["REPLIT_DOMAINS"] ?? "").toLowerCase();
  return new RegExp(`(^|[^a-z0-9-])${BETA_API_HOST.replace(/\./g, "\\.")}(?![a-z0-9-])`).test(v);
}

/**
 * Does `value` name production — its Supabase project ref anywhere in the text, its publishable key anywhere in the
 * text, or its API origin's host as a host (preceded by start, `/`, `.`, `@` or any other non-hostname character, so
 * `portava-beta.replit.app` does not match)? Case-insensitive: hostnames and refs are case-insensitive in practice,
 * and an upper-cased copy reaches the same project.
 */
export function namesProduction(value: string): boolean {
  const v = value.toLowerCase();
  if (v.includes(PRODUCTION_SUPABASE_REF)) return true;
  if (v.includes(PRODUCTION_PUBLISHABLE_KEY.toLowerCase())) return true;
  return new RegExp(`(^|[^a-z0-9-])${PRODUCTION_API_HOST.replace(/\./g, "\\.")}(?![a-z0-9-])`).test(v);
}

/** The names (never the values) of environment variables whose value names production (see namesProduction). */
export function variablesNamingProduction(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => typeof env[k] === "string" && namesProduction(env[k] as string))
    .sort();
}

/**
 * null when this process may start; otherwise the reason it must not. Pure:
 * reads only the env object it is given and prints nothing.
 */
export function deploymentEnvironmentRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[DEPLOYMENT_ENV_VAR];
  const label = raw === undefined || raw === "" ? null : raw;
  const url = env["SUPABASE_URL"];
  const ref = supabaseRefOf(url);

  if (label !== null && !(ACCEPTED_DEPLOYMENT_ENVS as readonly string[]).includes(label)) {
    return (
      `${DEPLOYMENT_ENV_VAR} is set to an unrecognised value. Accepted: ${ACCEPTED_DEPLOYMENT_ENVS.join(", ")}, ` +
      "or unset. An unrecognised label is refused rather than ignored, because ignoring it would switch the " +
      "beta guard off."
    );
  }

  if (label === "beta") {
    if (ref !== BETA_SUPABASE_REF) {
      return (
        `${DEPLOYMENT_ENV_VAR}=beta but SUPABASE_URL is not the portava-beta project (${BETA_SUPABASE_URL})` +
        `${ref === PRODUCTION_SUPABASE_REF ? " — it names PRODUCTION" : ""}. A beta deployment never starts ` +
        "against any other project. Set SUPABASE_URL (and the service-role key) to portava-beta's."
      );
    }
    const naming = variablesNamingProduction(env);
    if (naming.length > 0) {
      return (
        `${DEPLOYMENT_ENV_VAR}=beta but these variables name production (its project ref, ${PRODUCTION_API_HOST} or its publishable key): ${naming.join(", ")}. ` +
        "Replace each with its portava-beta value (values are not printed)."
      );
    }
    const live = variablesPermittingLiveMode(env);
    if (live.length > 0) {
      return (
        `${DEPLOYMENT_ENV_VAR}=beta but these variables hold a LIVE-mode provider credential or permit live mode: ${live.join(", ")}. ` +
        "The beta uses provider test/sandbox keys only (Stripe sk_test_/rk_test_/pk_test_, Persona persona_sandbox_, " +
        "Sumsub sbx:) and never sets PAYMENTS_ALLOW_LIVE (values are not printed)."
      );
    }
    const sentry = variablesWithForeignSentryDsn(env);
    if (sentry.length > 0) {
      return (
        `${DEPLOYMENT_ENV_VAR}=beta but these variables carry a Sentry DSN that is not the beta project's: ${sentry.join(", ")}. ` +
        "A beta process reports only to an allowlisted beta Sentry project (BETA_SENTRY_DSNS; empty until the owner " +
        "creates one), never to production's. Unset them, or add the beta project's DSN to the allowlist in a reviewed PR."
      );
    }
    if (env["NODE_ENV"] !== "production") {
      return (
        `${DEPLOYMENT_ENV_VAR}=beta but NODE_ENV is not "production". A beta API runs in production mode only: ` +
        "development and test modes admit the unsigned mock identity provider and the fake payment provider, " +
        "which must never run against the beta database. Set NODE_ENV=production."
      );
    }
    return null;
  }

  if (label === null && env["REPLIT_DEPLOYMENT"] !== undefined && !(env["REPLIT_DOMAINS"] ?? "").trim()) {
    return (
      `this is a Replit deployment (REPLIT_DEPLOYMENT is set) with no REPLIT_DOMAINS and no ${DEPLOYMENT_ENV_VAR}, ` +
      "so it cannot show it is not the beta fork serving .replit's inherited production values. Declare it: " +
      `${DEPLOYMENT_ENV_VAR}=production on production, ${DEPLOYMENT_ENV_VAR}=beta on the beta fork (a Secret).`
    );
  }

  if (replitDomainsNameBeta(env)) {
    return (
      `REPLIT_DOMAINS names the beta origin ${BETA_API_HOST} but ${DEPLOYMENT_ENV_VAR} is ` +
      `${label === null ? "unset" : `"${label}"`}. The beta fork must declare ${DEPLOYMENT_ENV_VAR}=beta (as a Secret), ` +
      "or it would serve whatever .replit's inherited values point at — production."
    );
  }

  if (ref === BETA_SUPABASE_REF) {
    return (
      `SUPABASE_URL is the portava-beta project but ${DEPLOYMENT_ENV_VAR} is ` +
      `${label === null ? "unset" : `"${label}"`}. The beta project is used only by a deployment labelled ` +
      `${DEPLOYMENT_ENV_VAR}=beta, so the guard that keeps it off production stays armed.`
    );
  }
  return null;
}
