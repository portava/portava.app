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
 *                    no environment variable may carry production's project ref
 *                    (a pooler/DB URL, a second Supabase URL, an EXPO_PUBLIC_*).
 *                    Variables are NAMED in the refusal; values never printed.
 *   anything else  → refused, naming the accepted values.
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
 * scripts/deployment-env-guard.sh; scripts/src/beta-deployment-guard.test.ts
 * runs both over one case table so the two cannot drift.
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

/** The names (never the values) of environment variables whose value contains production's ref. */
export function variablesNamingProduction(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((k) => typeof env[k] === "string" && (env[k] as string).includes(PRODUCTION_SUPABASE_REF))
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
        `${DEPLOYMENT_ENV_VAR}=beta but these variables carry production's project ref: ${naming.join(", ")}. ` +
        "Replace each with its portava-beta value (values are not printed)."
      );
    }
    return null;
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
