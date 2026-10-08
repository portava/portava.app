/**
 * Sandbox-only guard for every real payment / identity provider call.
 *
 * ── THE REQUIREMENT ──────────────────────────────────────────────────────────
 * Payment and identity flows must be testable end to end with SANDBOX
 * credentials, and no real charge, payout or billable live provider call may
 * ever execute in the testing environment. The one outbound billable path that
 * exists today is Stripe Identity (and, if selected, Persona): a live key there
 * creates per-verification charges and processes real government IDs.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * A provider key is classified by its documented PREFIX and nothing else:
 *
 *   Stripe   sk_test_ / rk_test_            -> test
 *            sk_live_ / rk_live_            -> live
 *   Persona  persona_sandbox_               -> test
 *            persona_production_            -> live
 *                                              (docs.withpersona.com/api-keys:
 *                                              "production keys start with
 *                                              persona_production and sandbox
 *                                              keys start with persona_sandbox")
 *   Sumsub   sbx:                           -> test
 *            prd:                           -> live
 *                                              (app-token environment prefix;
 *                                              see the note on PREFIXES — an
 *                                              unmatched prefix is `unknown`
 *                                              and `unknown` is always refused)
 *   anything else                           -> unknown
 *
 * `test` is always allowed. `live` is refused unless PAYMENTS_ALLOW_LIVE is the
 * exact string "true" (not "1", not "TRUE"). `unknown` is ALWAYS refused — a key
 * whose mode cannot be read is not a key this code can promise is a sandbox key,
 * and PAYMENTS_ALLOW_LIVE does not rescue it.
 *
 * ── WHAT NEVER LEAVES THIS MODULE ────────────────────────────────────────────
 * The key. Every export returns or throws a typed decision made of the
 * provider name, booleans and the mode enum. Nothing here logs.
 *
 * Callers enforce BEFORE any fetch: stripeIdentity.ts secretKey(),
 * persona.ts apiKey(), the Stripe webhook normaliser (livemode), readiness.ts,
 * POST /api/verification/session and the GET /api/verification/status refresh.
 * Any future payment code (services/payments/*, a registered PayoutProvider)
 * must call `assertProviderKeyAllowed` the same way.
 */

export type KeyedProvider = "stripe" | "persona" | "sumsub";
export type ProviderKeyMode = "test" | "live" | "unknown";
export type ProviderKeyRefusal = "key_absent" | "live_key_not_allowed" | "unknown_key_prefix";

export interface ProviderKeyDecision {
  provider: KeyedProvider;
  keyPresent: boolean;
  mode: ProviderKeyMode;
  liveAllowed: boolean;
  allowed: boolean;
  refusal: ProviderKeyRefusal | null;
}

const PREFIXES: Record<KeyedProvider, { test: readonly string[]; live: readonly string[] }> = {
  stripe: { test: ["sk_test_", "rk_test_"], live: ["sk_live_", "rk_live_"] },
  persona: { test: ["persona_sandbox_"], live: ["persona_production_"] },
  // Sumsub app tokens carry an environment prefix: `sbx:` for the sandbox app,
  // `prd:` for the production app (docs.sumsub.com, "App Tokens"). This mapping
  // is the one part of the Sumsub integration that was read off the vendor's
  // documentation and could not be checked against a real token, because no
  // credential was added by the change that wrote the adapter.
  //
  // THE FAILURE DIRECTION IS THEREFORE THE POINT. If the real format differs,
  // the prefix matches neither list, `classifyProviderKey` answers `unknown`,
  // and `unknown` is ALWAYS refused — PAYMENTS_ALLOW_LIVE does not rescue it.
  // Being wrong here costs a refused call and a clear error, never a live
  // government-ID check billed against a production app.
  sumsub: { test: ["sbx:"], live: ["prd:"] },
};

/** The env var holding each identity provider's secret key. */
export const IDENTITY_KEY_ENV: Record<KeyedProvider, string> = {
  stripe: "STRIPE_IDENTITY_SECRET_KEY",
  persona: "PERSONA_API_KEY",
  // Sumsub splits the credential in two: the APP TOKEN identifies the app and
  // carries the environment prefix this module classifies, and SUMSUB_SECRET_KEY
  // is the HMAC key that signs each request. The token is what gets classified
  // because it is the half that says which environment is being addressed.
  sumsub: "SUMSUB_APP_TOKEN",
};

export function isKeyedProvider(name: string): name is KeyedProvider {
  return name === "stripe" || name === "persona" || name === "sumsub";
}

/** Classify a key by prefix. Case-sensitive and whitespace-sensitive on purpose. */
export function classifyProviderKey(provider: KeyedProvider, key: string | null | undefined): ProviderKeyMode {
  if (typeof key !== "string" || key.length === 0) return "unknown";
  const p = PREFIXES[provider];
  if (p.test.some((x) => key.startsWith(x))) return "test";
  if (p.live.some((x) => key.startsWith(x))) return "live";
  return "unknown";
}

/** Live mode is permitted only by the exact string "true". Unset by default. */
export function liveAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["PAYMENTS_ALLOW_LIVE"] === "true";
}

export function evaluateProviderKey(
  provider: KeyedProvider,
  key: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProviderKeyDecision {
  const keyPresent = typeof key === "string" && key.trim().length > 0;
  const mode = keyPresent ? classifyProviderKey(provider, key) : "unknown";
  const allowLive = liveAllowed(env);
  let refusal: ProviderKeyRefusal | null = null;
  if (!keyPresent) refusal = "key_absent";
  else if (mode === "unknown") refusal = "unknown_key_prefix";
  else if (mode === "live" && !allowLive) refusal = "live_key_not_allowed";
  return { provider, keyPresent, mode, liveAllowed: allowLive, allowed: refusal === null, refusal };
}

const REFUSAL_TEXT: Record<ProviderKeyRefusal | "live_event_not_allowed", string> = {
  key_absent: "no key configured",
  live_key_not_allowed: "live key not allowed (PAYMENTS_ALLOW_LIVE is not \"true\")",
  unknown_key_prefix: "unrecognised key prefix; only documented test/live prefixes are accepted",
  live_event_not_allowed: "livemode event not allowed (PAYMENTS_ALLOW_LIVE is not \"true\")",
};

/** Human text for a refusal. Never contains the key. */
export function describeRefusal(refusal: ProviderKeyRefusal | "live_event_not_allowed"): string {
  return REFUSAL_TEXT[refusal];
}

/**
 * Thrown by every guarded call site. `code` is stable; `decision` carries
 * booleans and enums only.
 */
export class PaymentsLiveModeRefusedError extends Error {
  readonly code = "payments_live_mode_refused" as const;
  readonly retriable = true as const;
  constructor(
    readonly decision: ProviderKeyDecision | {
      provider: KeyedProvider;
      refusal: "live_event_not_allowed";
      liveAllowed: false;
    },
  ) {
    super(`${decision.provider}: ${describeRefusal(decision.refusal ?? "key_absent")} — provider call refused before any request was sent`);
    this.name = "PaymentsLiveModeRefusedError";
  }
}

export function isPaymentsLiveModeRefusal(err: unknown): err is PaymentsLiveModeRefusedError {
  return err instanceof PaymentsLiveModeRefusedError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "payments_live_mode_refused");
}

/**
 * Throw unless the key is a test key, or a live key with live explicitly
 * allowed. An ABSENT key is left to the caller's own "not set" error, which
 * already names the variable.
 */
export function assertProviderKeyAllowed(
  provider: KeyedProvider,
  key: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const d = evaluateProviderKey(provider, key, env);
  if (d.allowed || d.refusal === "key_absent") return;
  throw new PaymentsLiveModeRefusedError(d);
}

/**
 * Refuse a signature-verified webhook whose envelope says `livemode: true`
 * unless live is allowed. Only the boolean `true` counts: Stripe sends a JSON
 * boolean, and anything else is not a live-mode claim.
 */
export function assertWebhookLivemodeAllowed(
  provider: KeyedProvider,
  livemode: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (livemode !== true || liveAllowed(env)) return;
  throw new PaymentsLiveModeRefusedError({ provider, refusal: "live_event_not_allowed", liveAllowed: false });
}

/** Configured identity provider name, as the factory reads it. */
export function configuredIdentityProvider(env: NodeJS.ProcessEnv = process.env): string {
  return (env["IDENTITY_PROVIDER"] ?? "mock").toLowerCase();
}

/**
 * The key decision for the CONFIGURED identity provider, or null when the
 * configured provider holds no key (mock, unknown names).
 */
export function identityKeyDecision(env: NodeJS.ProcessEnv = process.env): ProviderKeyDecision | null {
  const provider = configuredIdentityProvider(env);
  if (!isKeyedProvider(provider)) return null;
  return evaluateProviderKey(provider, env[IDENTITY_KEY_ENV[provider]], env);
}

/** Stable reason codes the session route puts on its 503. */
export function refusalReasonCode(decision: ProviderKeyDecision): "payments_live_key_refused" | "payments_unknown_key_refused" | null {
  if (decision.refusal === "live_key_not_allowed") return "payments_live_key_refused";
  if (decision.refusal === "unknown_key_prefix") return "payments_unknown_key_refused";
  return null;
}

export interface PaymentsStartupSummary {
  identityProvider: string;
  keyPresent: boolean;
  keyMode: ProviderKeyMode | "none";
  liveAllowed: boolean;
  keyRefused: boolean;
}

/** The one startup log line: provider name, booleans and the mode enum only. */
export function paymentsStartupSummary(env: NodeJS.ProcessEnv = process.env): PaymentsStartupSummary {
  const identityProvider = configuredIdentityProvider(env);
  const d = identityKeyDecision(env);
  if (!d) {
    return { identityProvider, keyPresent: false, keyMode: "none", liveAllowed: liveAllowed(env), keyRefused: false };
  }
  return {
    identityProvider,
    keyPresent: d.keyPresent,
    keyMode: d.keyPresent ? d.mode : "none",
    liveAllowed: d.liveAllowed,
    keyRefused: d.keyPresent && !d.allowed,
  };
}

/**
 * May the UNSIGNED mock identity provider run in this process?
 *
 * The deployment's `start` script does not set NODE_ENV (package.json "start";
 * `.replit` [deployment] run), so "NODE_ENV !== 'production'" — the old rule —
 * let a hosted deployment run the mock, whose webhook is unsigned and whose
 * sessions self-approve. The rule is fail-closed and needs POSITIVE evidence
 * of the TEST RUNNER (lane B wave 3, N-2):
 *
 *   refused  NODE_ENV === "production"
 *   refused  REPLIT_DEPLOYMENT is set (Replit sets it in every Deployment)
 *   refused  NODE_ENV "development"/"test" ALONE: `pnpm dev` here points at production
 *   allowed  NODE_TEST_CONTEXT is set (node --test sets it in each test file's
 *            process)
 *   refused  anything else — including a bare `start` with no NODE_ENV
 */
export function mockIdentityPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["NODE_ENV"] === "production") return false;
  const deployment = env["REPLIT_DEPLOYMENT"]; // PRESENT counts, even empty — see "REPLIT_DEPLOYMENT, present but empty" at the foot
  if (deployment !== undefined) return false;
  // NODE_ENV=development|test is NOT evidence of a sandbox (N-2): only the test runner below is.
  const testContext = env["NODE_TEST_CONTEXT"];
  return typeof testContext === "string" && testContext.length > 0;
}

/** The unsigned mock WEBHOOK additionally needs IDENTITY_PROVIDER=mock set explicitly. */
export function unsignedMockWebhookPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env["IDENTITY_PROVIDER"];
  return typeof explicit === "string" && explicit.toLowerCase() === "mock" && mockIdentityPermitted(env);
}

/** Thrown by the mock's webhook when the unsigned path is not permitted. */
export class MockWebhookRefusedError extends Error {
  readonly code = "mock_webhook_not_allowed" as const;
  constructor() {
    super(
      "unsigned mock identity webhook refused: needs IDENTITY_PROVIDER=mock set explicitly and the test " +
        "runner (node --test), never a dev host, production or a Replit deployment",
    );
    this.name = "MockWebhookRefusedError";
  }
}

// ── PAYMENT provider keys (appended at the foot so every line above keeps its number) ──
//
// The header's last sentence — "any future payment code must call
// `assertProviderKeyAllowed` the same way" — is carried out here. A payment
// secret key is classified by the SAME function, with the SAME prefixes, as the
// identity key: nothing below re-states a prefix or re-decides what "live
// allowed" means. `evaluateProviderKey` is the only decision; these exports say
// which variable holds the key and which process may run the fake.
//
//   PAYMENT_PROVIDER      none (default) | fake | <a registered adapter's name>
//   STRIPE_SECRET_KEY     sk_test_/rk_test_ -> test · sk_live_/rk_live_ -> live ·
//                         anything else -> unknown (always refused)
//   PAYMENTS_ALLOW_LIVE   the exact string "true" lets a LIVE key or a
//                         livemode event through. It never rescues an unknown key.
//
// Consumers: services/payments/providerRegistry.ts (before a provider is handed
// out and again before every operation), services/payments/readiness.ts, and
// every adapter's own key reader (assertProviderKeyAllowed, before any fetch).

/** Payment providers whose secret key carries a documented mode prefix. */
export type KeyedPaymentProvider = "stripe";

/** The env var naming the payment provider. Absent or empty means `none`. */
export const PAYMENT_PROVIDER_ENV = "PAYMENT_PROVIDER" as const;

/** The env var holding each payment provider's SECRET key. */
export const PAYMENT_KEY_ENV: Record<KeyedPaymentProvider, string> = {
  stripe: "STRIPE_SECRET_KEY",
};

/** The env var holding the signing secret of each payment provider's PLATFORM webhook endpoint. */
export const PAYMENT_WEBHOOK_SECRET_ENV: Record<KeyedPaymentProvider, string> = {
  stripe: "STRIPE_WEBHOOK_SECRET",
};

/**
 * The env var holding the signing secret of each payment provider's CONNECT
 * webhook endpoint — the one that receives events about recipients' (connected)
 * accounts. It is a different endpoint with a different secret; under direct
 * charges it is where a payment's own events arrive.
 */
export const PAYMENT_CONNECT_WEBHOOK_SECRET_ENV: Record<KeyedPaymentProvider, string> = {
  stripe: "STRIPE_CONNECT_WEBHOOK_SECRET",
};

export function isKeyedPaymentProvider(name: string): name is KeyedPaymentProvider {
  return name === "stripe";
}

/** Configured payment provider name, trimmed and lowercased. Default `none`. */
export function configuredPaymentProvider(env: NodeJS.ProcessEnv = process.env): string {
  const name = (env[PAYMENT_PROVIDER_ENV] ?? "").trim().toLowerCase();
  return name === "" ? "none" : name;
}

/**
 * The key decision for one keyed payment provider, read from its env var.
 * This IS `evaluateProviderKey`: same prefixes, same live rule, same refusals.
 */
export function evaluatePaymentKey(
  provider: KeyedPaymentProvider,
  env: NodeJS.ProcessEnv = process.env,
): ProviderKeyDecision {
  return evaluateProviderKey(provider, env[PAYMENT_KEY_ENV[provider]], env);
}

/**
 * The key decision for the CONFIGURED payment provider, or null when the
 * configured provider holds no key (`none`, `fake`, an unknown name).
 */
export function paymentKeyDecision(env: NodeJS.ProcessEnv = process.env): ProviderKeyDecision | null {
  const provider = configuredPaymentProvider(env);
  if (!isKeyedPaymentProvider(provider)) return null;
  return evaluatePaymentKey(provider, env);
}

/**
 * Is a webhook envelope's `livemode` a live claim this process must refuse?
 * The boolean form of `assertWebhookLivemodeAllowed`, for callers that answer
 * with a tagged result instead of a throw. Only the boolean `true` is a live
 * claim, and only `liveAllowed` lets it through.
 */
export function webhookLivemodeRefused(livemode: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return livemode === true && !liveAllowed(env);
}

/**
 * May the FAKE payment provider (and the fake tax provider) run in this process?
 * Exactly the mock identity provider's rule — one function, not a copy of it:
 * refused in production, refused whenever REPLIT_DEPLOYMENT is set, and refused
 * without positive evidence of the test runner (a dev host is refused too, N-2).
 */
export function fakePaymentProviderPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  return mockIdentityPermitted(env);
}

// ── REPLIT_DEPLOYMENT, present but empty ─────────────────────────────────────
//
// `mockIdentityPermitted` used to treat REPLIT_DEPLOYMENT="" as unset. It now
// treats ANY defined value, the empty string included, as a hosted deployment.
//
// Replit's own convention is set-versus-unset: "Set to 1 if the code is running
// in a published project, unset otherwise" (docs.replit.com, Secrets → predefined
// environment variables). Replit therefore never produces an empty value; one
// can only come from configuration someone wrote (`REPLIT_DEPLOYMENT=` in an
// env file, a blanked Secret). The rule above is fail-closed and asks for
// POSITIVE evidence of a local run, and a deployment marker that has been
// blanked is not that: reading it as "not a deployment" would let one blank
// line re-admit the unsigned mock identity provider and the fake payment
// provider on a hosted app. A local machine does not define the variable at
// all, so nothing local changes; the fix for a local run that does define it is
// to remove the line.
//
// One function decides this for identity (mock provider, unsigned webhook) and
// payments (fake payment and tax providers) alike.

// ── Is a MOCK identity approval booking-grade? (lane B wave 2, Step 5(d)) ─────
// Appended at the foot so every cited line above keeps its number.
//
// `mockIdentityPermitted` answers "may the unsigned mock RUN in this process?"
// It allowed `pnpm dev` (NODE_ENV=development) until wave 3; since N-2 it does
// not, so the two answers coincide. Why COUNTING was narrowed first: the workspace environment
// points at the production Supabase project, so a dev server could write
// self-approved `local_mock` rows into the table real users' rows land in, and
// the same process would then treat them as booking-grade. So a mock approval
// counts for bookings only under `node --test` (NODE_TEST_CONTEXT, set in each
// test file's process), and never where the mock may not run at all.
// NODE_ENV alone never makes it count.
export function mockVerificationIsBookingGrade(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!mockIdentityPermitted(env)) return false;
  const testContext = env["NODE_TEST_CONTEXT"];
  return typeof testContext === "string" && testContext.length > 0;
}
