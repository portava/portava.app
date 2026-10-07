/**
 * beta-smoke.ts — READ-ONLY smoke check of a running BETA API.
 *
 *   pnpm -C scripts beta:smoke --base https://portava-beta.replit.app
 *
 * Every request is a GET without a user token (check 6 sends only the beta
 * PUBLISHABLE key, which is public by design). Nothing is written: the check
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
 *   4. booking stops     GET /api/feature-flags (the app's own unauthenticated flag
 *      engaged          read) → 200 with disable_rent_buddy_booking, disable_rab_bookings
 *                       and RENT_BUDDY_ADMIN_ONLY_MODE all true and rent_buddy_enabled
 *                       false — the three engaged stops OBSERVED, not inferred from a
 *                       capability. A missing service client answers 503 here, so
 *                       this check cannot pass vacuously.
 *   5. flags = policy    the same response, judged against scripts/src/beta-flag-policy.json
 *                        AT THIS COMMIT: every flag the policy turns ON is served true; every
 *                        served flag the policy knows reads the policy's value (the API's
 *                        live-places derivation applied, LIVE_PLACES_REQUIREMENTS); a flag
 *                        the policy does not know may only be served false. This proves
 *                        beta-config.yml applied THIS policy to the database this API reads
 *                        (re-dispatch it after any policy edit, or this check fails).
 *   6. Auth sign-up      GET https://emfpckykpzfturllshly.supabase.co/auth/v1/settings with
 *      closed            the beta PUBLISHABLE key from travel-buddy-standalone/eas.json (public
 *                        by design; the endpoint is public GoTrue settings) → 200 with
 *                        disable_signup === true. This is what closes the APP's own sign-up
 *                        path (supabase.auth.signUp, Apple/Google), which checks 2 and 5 cannot
 *                        see. A 401 means eas.json's key is not portava-beta's.
 *   7. profiles' personal for each column 3740 forbids a client to read (date_of_birth, full_name,
 *      columns closed    expo_push_token, phone_e164 …): GET portava-beta's PostgREST
 *                        /rest/v1/profiles?select=<column>&limit=0 with the same publishable key.
 *                        PASS only if every one is refused with 42501 (permission denied) or the
 *                        column does not exist (42703). A 200 means the anon key can read it — the
 *                        TABLE-level grant a baseline replay inherits (migration 3740, PR #647) —
 *                        and no tester account may be created. limit=0: the privilege check runs
 *                        before execution, so no row is ever returned.
 *
 * REPORTED, NOT CHECKED — the API exposes no unauthenticated read of either,
 * and this lane does not add an endpoint that would publish configuration:
 *   • identity-verification readiness ("not operational for real bookings"):
 *     read the `payments/identity provider mode` startup line (booleans only,
 *     lib/paymentsStartupLog.ts) in the beta deployment's logs. Check 4 is the
 *     observable consequence: the booking stops are engaged.
 *   • production runtime mode (NODE_ENV=production): not observable from outside, but
 *     ENFORCED: a PORTAVA_DEPLOYMENT_ENV=beta API refuses to start unless NODE_ENV=production
 *     (artifacts/api-server/src/lib/deploymentEnvironment.ts), and only a beta-labelled process
 *     may use the beta database, which checks 2 and 5 show this API reads.
 *
 * EXIT 0 every check passed · 1 a check failed · 2 bad arguments (no --base, or
 *      a base that is production's origin)
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BETA_PROJECT_REF, REPO_ROOT, argValue } from "./beta-db-core.js";
import { PROFILES_NEVER_READ, loadFlagPolicy, type FlagPolicy } from "./beta-config-core.js";

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

async function getJson(fetchImpl: SmokeFetch, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  let body: unknown = raw;
  try { body = JSON.parse(raw); } catch { /* keep raw text; the check reports it */ }
  return { status: res.status, body, raw };
}

/** A response body for a one-line report: whitespace collapsed (an HTML error page is many lines), truncated. */
function snippet(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The API's live-places derivation (artifacts/api-server/src/lib/featureFlags.ts LIVE_PLACES_REQUIREMENTS):
 * GET /api/feature-flags serves such a flag true only when its row AND every parent row are true.
 * scripts/src/beta-smoke.test.ts fails if this copy and the API's ever differ.
 */
export const LIVE_PLACES_REQUIREMENTS: Record<string, readonly string[]> = {
  live_places_enabled: ["external_places_enabled"],
  place_days_enabled: ["external_places_enabled", "live_places_enabled"],
  shared_moments_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled"],
  shared_moments_compass_suggestions_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
  shared_moments_clustering_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
  place_recaps_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled"],
  moment_recaps_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
  shared_moments_chat_enabled: ["external_places_enabled", "live_places_enabled", "place_days_enabled", "shared_moments_enabled"],
};

/** What GET /api/feature-flags must serve for each policy flag, once the policy is applied. */
export function expectedServedFlags(policy: FlagPolicy): Map<string, boolean> {
  const raw = new Map(policy.flags.map((e) => [e.flag, e.enabled]));
  const out = new Map<string, boolean>();
  for (const [flag, on] of raw) {
    const parents = LIVE_PLACES_REQUIREMENTS[flag];
    out.set(flag, on && (parents ?? []).every((p) => raw.get(p) === true));
  }
  return out;
}

/** null when the served flag map is the policy's; otherwise what differs (flag names only). */
export function flagPolicyMismatch(served: Record<string, unknown>, policy: FlagPolicy): string | null {
  const want = expectedServedFlags(policy);
  const wrong: string[] = [];
  for (const [flag, on] of want) {
    if (!(flag in served)) { if (on) wrong.push(`${flag} not served (policy ON)`); continue; }
    if (served[flag] !== on) wrong.push(`${flag}=${JSON.stringify(served[flag])} (policy ${on})`);
  }
  for (const [flag, value] of Object.entries(served)) {
    if (!want.has(flag) && value !== false) wrong.push(`${flag}=${JSON.stringify(value)} (not in the policy; only false is acceptable)`);
  }
  if (wrong.length === 0) return null;
  const shown = wrong.slice(0, 12).join(", ");
  return `${wrong.length} flag(s) differ from scripts/src/beta-flag-policy.json — re-dispatch beta-config.yml after any policy edit: ${shown}${wrong.length > 12 ? ", …" : ""}`;
}

/** The beta project's public Auth settings endpoint (GoTrue GET /settings). */
export const BETA_AUTH_SETTINGS_URL = `https://${BETA_PROJECT_REF}.supabase.co/auth/v1/settings`;

/** A zero-row PostgREST probe of one profiles column, as the anon (publishable) key. */
export function profilesColumnProbeUrl(column: string): string {
  return `https://${BETA_PROJECT_REF}.supabase.co/rest/v1/profiles?select=${encodeURIComponent(column)}&limit=0`;
}

/** "closed" when the anon key may not read the column, "open" when it may, otherwise why it cannot be judged. */
export function judgeProfilesProbe(status: number, body: unknown): "closed" | "open" | string {
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  if ((status === 401 || status === 403) && code === "42501") return "closed";
  if (status === 400 && code === "42703") return "closed"; // the column does not exist here: nothing to read
  if (status === 200) return "open";
  return `cannot judge (${status}${code ? ` ${String(code)}` : ""})`;
}

/** The beta PUBLISHABLE key the beta app build carries (travel-buddy-standalone/eas.json, profile `beta`). */
export function betaPublishableKey(): string {
  const eas = JSON.parse(readFileSync(join(REPO_ROOT, "travel-buddy-standalone", "eas.json"), "utf8")) as {
    build?: { beta?: { env?: Record<string, string> } };
  };
  const key = eas.build?.beta?.env?.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) throw new Error("eas.json build.beta carries no publishable key");
  return key;
}

export interface SmokeOptions {
  /** Defaults to scripts/src/beta-flag-policy.json. */
  policy?: FlagPolicy;
  /** Defaults to the eas.json beta profile's publishable key. */
  publishableKey?: string;
}

export async function runBetaSmoke(base: string, fetchImpl: SmokeFetch, opts: SmokeOptions = {}): Promise<SmokeResult[]> {
  const root = base.replace(/\/+$/, "");
  const results: SmokeResult[] = [];
  const seen = new Map<string, Promise<{ status: number; body: unknown; raw: string }>>();
  /** One GET per URL: checks 4 and 5 judge the same /api/feature-flags response. */
  function get(url: string, headers?: Record<string, string>) {
    if (!seen.has(url)) seen.set(url, getJson(fetchImpl, url, headers));
    return seen.get(url)!;
  }
  async function check(name: string, path: string, judge: (r: { status: number; body: unknown; raw: string }) => string | null, url = `${root}${path}`, headers?: Record<string, string>) {
    try {
      const r = await get(url, headers);
      const problem = judge(r);
      results.push({ name, ok: problem === null, detail: problem ?? `GET ${path} → ${r.status}` });
    } catch (err) {
      results.push({ name, ok: false, detail: `GET ${path} did not complete: ${(err as Error).message}` });
    }
  }
  await check("health", "/api/healthz", (r) =>
    r.status === 200 && same(r.body, { status: "ok" }) ? null : `expected 200 {"status":"ok"}, got ${r.status} ${snippet(r.raw)}`);
  await check("sign-up closed (invite-only)", "/api/auth/signup-status", (r) =>
    r.status === 200 && same(r.body, { signupsEnabled: false, inviteOnly: true })
      ? null
      : `expected 200 {"signupsEnabled":false,"inviteOnly":true}, got ${r.status} ${snippet(r.raw)}`);
  await check("auth required", "/api/verification/status", (r) =>
    r.status === 401 ? null
      : r.status === 503 ? `got 503 — the service-role key is missing on the beta deployment (${snippet(r.raw)})`
      : `expected 401 without a token, got ${r.status} ${snippet(r.raw)}`);
  await check("Rent-a-Buddy booking stops engaged", "/api/feature-flags", (r) => {
    const flags = typeof r.body === "object" && r.body !== null ? (r.body as { flags?: Record<string, unknown> }).flags : undefined;
    if (r.status !== 200 || !flags) return `expected 200 {flags:{…}}, got ${r.status} ${snippet(r.raw)}`;
    const wrong = [
      ...BOOKING_STOPS.filter((f) => flags[f] !== true).map((f) => `${f}=${JSON.stringify(flags[f])} (want true)`),
      ...(flags.rent_buddy_enabled !== false ? [`rent_buddy_enabled=${JSON.stringify(flags.rent_buddy_enabled)} (want false)`] : []),
    ];
    return wrong.length ? `booking stops not as the beta policy sets them: ${wrong.join(", ")}` : null;
  });
  await check("feature flags match the beta policy", "/api/feature-flags", (r) => {
    const flags = typeof r.body === "object" && r.body !== null ? (r.body as { flags?: Record<string, unknown> }).flags : undefined;
    if (r.status !== 200 || !flags) return `expected 200 {flags:{…}}, got ${r.status} ${snippet(r.raw)}`;
    return flagPolicyMismatch(flags, opts.policy ?? loadFlagPolicy());
  });
  let key: string;
  try {
    key = opts.publishableKey ?? betaPublishableKey();
  } catch (err) {
    results.push({ name: "Supabase Auth sign-up closed", ok: false, detail: (err as Error).message });
    return results;
  }
  await check("Supabase Auth sign-up closed", "/auth/v1/settings (portava-beta)", (r) => {
    if (r.status === 401) return "401 — the publishable key in travel-buddy-standalone/eas.json (beta) is not accepted by portava-beta";
    const body = typeof r.body === "object" && r.body !== null ? (r.body as { disable_signup?: unknown; external?: Record<string, unknown> }) : null;
    if (r.status !== 200 || !body) return `expected 200 {disable_signup:true,…}, got ${r.status} ${snippet(r.raw)}`;
    if (body.disable_signup !== true) {
      return `disable_signup=${JSON.stringify(body.disable_signup)} — Supabase Auth still accepts new users (the app's own sign-up path); dispatch beta-config.yml`;
    }
    return null;
  }, BETA_AUTH_SETTINGS_URL, { apikey: key });

  // 7 — profiles' personal columns, through PostgREST as the anon key (3740).
  const name7 = "profiles personal columns closed to the anon key";
  try {
    const verdicts = await Promise.all(PROFILES_NEVER_READ.map(async (column) => {
      const r = await get(profilesColumnProbeUrl(column), { apikey: key });
      return { column, verdict: judgeProfilesProbe(r.status, r.body) };
    }));
    const open = verdicts.filter((v) => v.verdict === "open").map((v) => v.column);
    const unjudged = verdicts.filter((v) => v.verdict !== "open" && v.verdict !== "closed").map((v) => `${v.column}: ${v.verdict}`);
    results.push(
      open.length === 0 && unjudged.length === 0
        ? { name: name7, ok: true, detail: `${verdicts.length} personal columns refused to the anon key (42501/absent)` }
        : {
            name: name7, ok: false,
            detail: [
              open.length ? `READABLE by the anon key: ${open.join(", ")} — apply migration 3740 (PR #647) before any tester account exists` : "",
              unjudged.length ? `not judged: ${unjudged.join("; ")}` : "",
            ].filter(Boolean).join("; "),
          },
    );
  } catch (err) {
    results.push({ name: name7, ok: false, detail: `a probe did not complete: ${(err as Error).message}` });
  }
  return results;
}

/** The three STOP flags that keep Rent-a-Buddy bookings shut on beta (scripts/src/beta-flag-policy.json). */
export const BOOKING_STOPS = ["disable_rent_buddy_booking", "disable_rab_bookings", "RENT_BUDDY_ADMIN_ONLY_MODE"] as const;

export const NOT_CHECKED = [
  "identity-verification readiness: no unauthenticated read exists; read the `payments/identity provider mode` startup line in the beta deployment logs (it must not report identity operational for real bookings).",
  "production runtime mode (NODE_ENV=production): not observable from outside; ENFORCED at startup (a PORTAVA_DEPLOYMENT_ENV=beta API refuses to start without it, lib/deploymentEnvironment.ts), and only a beta-labelled process may use the beta database, which checks 2 and 5 show this API reads.",
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
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(37)} ${r.detail}`);
  for (const n of NOT_CHECKED) console.log(`NOT CHECKED  ${n}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\nbeta-smoke FAILED — ${failed} of ${results.length} check(s).` : `\nbeta-smoke PASSED — ${results.length} check(s).`);
  process.exit(failed ? 1 : 0);
}
