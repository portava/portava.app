/**
 * deploymentEnvironmentGuard.ts — side-effect module: refuse to start a beta
 * deployment that could reach production. See lib/deploymentEnvironment.ts.
 *
 * Imported by src/index.ts directly after Sentry and BEFORE `./app`, so it is
 * evaluated before any module that could open a Supabase client or start a
 * scheduler. It depends on nothing but deploymentEnvironment.ts (no logger, no
 * client), so evaluating it cannot itself reach a database.
 *
 * Exit 1 with one line naming PORTAVA_DEPLOYMENT_ENV and the variables at
 * fault. Values are never printed.
 */
import { DEPLOYMENT_ENV_VAR, deploymentEnvironmentRefusal } from "./deploymentEnvironment.js";

const refusal = deploymentEnvironmentRefusal(process.env);
if (refusal !== null) {
  console.error(`[deployment-environment] REFUSING TO START (${DEPLOYMENT_ENV_VAR}): ${refusal}`);
  process.exit(1);
}
