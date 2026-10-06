/**
 * beta-smoke.ts — READ-ONLY smoke check of a running BETA API.
 *
 *   pnpm -C scripts beta:smoke --base https://portava-beta.replit.app
 *
 * Every request is an unauthenticated GET. Nothing is written: the check
 * never calls POST /auth/signup (a misconfigured beta would CREATE an account
 * for it), never starts a verification session, never books.
 *
 * CHECKS (each PASS or FAIL; any FAIL exits 1)
 *   1. health            GET /api/healthz → 200 {status:"ok"}
 *   2. sign-up closed    GET /api/auth/signup-status → 200 exactly
 *                        {signupsEnabled:false, inviteOnly:true}
 *                        (disable_signups engaged + invite_only_beta on, read
 *                        through the live database — so this also proves the
 *                        API reaches a database holding the beta flag policy)
 *   3. auth required     GET /api/verification/status with no token → 401
 *                        (a 503 server_not_configured here means the
 *                        service-role key is missing)
 *   4. no bookings       GET /api/rent-a-buddy/launch-status → {enabled:false}
 *
 * REPORTED, NOT CHECKED — the API exposes no unauthenticated read of either,
 * and this lane does not add an endpoint that would publish configuration:
 *   • identity-verification readiness ("not operational for real bookings"):
 *     read the `payments/identity provider mode` startup line (booleans only,
 *     lib/paymentsStartupLog.ts) in the beta deployment's logs. Check 4 is the
 *     observable consequence: the booking surface is off.
 *   • production runtime mode (NODE_ENV=production): observable only as the
 *     generic 5xx message in lib/errorEnvelope.ts, which this check will not
 *     provoke. Confirm it in the deployment's Secrets.
 *
 * EXIT 0 every check passed · 1 a check failed · 2 bad arguments (no --base, or
 *      a base that is production's origin)
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue } from "./beta-db-core.js";

export type SmokeFetch = (url: string, init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Production's API origin — this smoke is for the beta and refuses it. */
const PRODUCTION_ORIGIN_HOST = "portava.replit.app";

export function smokeBaseRefusal(base: string | null): string | null {
  if (!base) return "--base <url> is required, e.g. --base https://portava-beta.replit.app";
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `--base is not a URL: ${base}`;
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return "--base must be https (or localhost)";
  }
  if (url.hostname === PRODUCTION_ORIGIN_HOST) return `${base} is PRODUCTION's origin. This smoke checks the beta only.`;
  return null;
}

async function getJson(fetchImpl: SmokeFetch, url: string): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  let body: unknown = raw;
  try { body = JSON.parse(raw); } catch { /* keep raw text; the check reports it */ }
  return { status: res.status, body, raw };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function runBetaSmoke(base: string, fetchImpl: SmokeFetch): Promise<SmokeResult[]> {
  const root = base.replace(/\/+$/, "");
  const results: SmokeResult[] = [];
  async function check(name: string, path: string, judge: (r: { status: number; body: unknown; raw: string }) => string | null) {
    try {
      const r = await getJson(fetchImpl, `${root}${path}`);
      const problem = judge(r);
      results.push({ name, ok: problem === null, detail: problem ?? `GET ${path} → ${r.status}` });
    } catch (err) {
      results.push({ name, ok: false, detail: `GET ${path} did not complete: ${(err as Error).message}` });
    }
  }
  await check("health", "/api/healthz", (r) =>
    r.status === 200 && same(r.body, { status: "ok" }) ? null : `expected 200 {"status":"ok"}, got ${r.status} ${r.raw.slice(0, 200)}`);
  await check("sign-up closed (invite-only)", "/api/auth/signup-status", (r) =>
    r.status === 200 && same(r.body, { signupsEnabled: false, inviteOnly: true })
      ? null
      : `expected 200 {"signupsEnabled":false,"inviteOnly":true}, got ${r.status} ${r.raw.slice(0, 200)}`);
  await check("auth required", "/api/verification/status", (r) =>
    r.status === 401 ? null
      : r.status === 503 ? `got 503 — the service-role key is missing on the beta deployment (${r.raw.slice(0, 160)})`
      : `expected 401 without a token, got ${r.status} ${r.raw.slice(0, 200)}`);
  await check("no Rent-a-Buddy bookings", "/api/rent-a-buddy/launch-status", (r) =>
    r.status === 200 && typeof r.body === "object" && r.body !== null && (r.body as Record<string, unknown>).enabled === false
      ? null
      : `expected 200 with enabled:false, got ${r.status} ${r.raw.slice(0, 200)}`);
  return results;
}

export const NOT_CHECKED = [
  "identity-verification readiness: no unauthenticated read exists; read the `payments/identity provider mode` startup line in the beta deployment logs (it must not report identity operational for real bookings).",
  "production runtime mode (NODE_ENV=production): not observable without provoking a 5xx; confirm it in the beta deployment's Secrets.",
];

const RUN_DIRECTLY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  const base = argValue(process.argv.slice(2), "--base");
  const refusal = smokeBaseRefusal(base);
  if (refusal) {
    console.error(`::error::beta-smoke REFUSED: ${refusal}`);
    process.exit(2);
  }
  const results = await runBetaSmoke(base as string, fetch as unknown as SmokeFetch);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(30)} ${r.detail}`);
  for (const n of NOT_CHECKED) console.log(`NOT CHECKED  ${n}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nbeta-smoke FAILED — ${failed} of ${results.length} check(s).` : `\nbeta-smoke PASSED — ${results.length} check(s).`);
  process.exit(failed ? 1 : 0);
}
