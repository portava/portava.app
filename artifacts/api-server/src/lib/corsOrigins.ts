/**
 * The Replit workspace-preview origins, allowed OUTSIDE PRODUCTION only
 * (sec/public-surface, 2026-11-04; docs/security/cors-dev-domain-allowlist-in-production.md).
 *
 * app.ts used to allow every sibling of REPLIT_DEV_DOMAIN's parent whenever the
 * variable was set, on the belief that it is "only present in the Replit
 * workspace". It is not: production has it, measured 2026-08-15, when invented
 * subdomains of the shared, multi-tenant kirk.replit.dev were echoed back with
 * `credentials: true`. The variable says nothing about which environment this
 * is, so it no longer decides that alone.
 *
 * PRODUCTION is the rule lib/paymentsMode.ts mockIdentityPermitted already
 * applies: NODE_ENV === "production", OR REPLIT_DEPLOYMENT is present (Replit
 * sets it in every published deployment; an empty value counts, for the reason
 * given at the foot of paymentsMode.ts). NODE_ENV alone would not do: the
 * deployment's start script does not set it. A beta fork is a deployment too, so
 * it is production here as well.
 *
 * Read from `env` on every call, not captured at import, so one process can be
 * shown both answers and nothing depends on import order.
 */

/** True on any published deployment, or wherever NODE_ENV says production. */
export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NODE_ENV"] === "production" || env["REPLIT_DEPLOYMENT"] !== undefined;
}

/**
 * Outside production, the Replit workspace domain and its previews: the dev
 * domain itself, the dev domain with an explicit :port (a non-artifact dev
 * server on an extra exposed port, e.g. the travel-buddy-standalone web preview
 * on :3000), and any subdomain of its parent (port-mapped artifact previews such
 * as <repl-id>.expo.kirk.replit.dev). In production: never.
 *
 * REPLIT_DEV_DOMAIN has the form "<repl-id>.kirk.replit.dev"; the parent is
 * everything after the first label.
 */
export function replitDevOriginAllowed(origin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProductionRuntime(env)) return false;
  const devDomain = (env["REPLIT_DEV_DOMAIN"] ?? "").trim();
  if (!devDomain) return false;
  const parent = devDomain.split(".").slice(1).join(".");
  if (!parent) return false;
  return (
    origin === `https://${devDomain}` ||
    origin.startsWith(`https://${devDomain}:`) ||
    origin.endsWith(`.${parent}`)
  );
}
