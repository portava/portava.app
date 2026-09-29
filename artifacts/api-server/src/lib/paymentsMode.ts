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

export type KeyedProvider = "stripe" | "persona";
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
};

/** The env var holding each identity provider's secret key. */
export const IDENTITY_KEY_ENV: Record<KeyedProvider, string> = {
  stripe: "STRIPE_IDENTITY_SECRET_KEY",
  persona: "PERSONA_API_KEY",
};

export function isKeyedProvider(name: string): name is KeyedProvider {
  return name === "stripe" || name === "persona";
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
 * sessions self-approve. The rule is now fail-closed and needs POSITIVE
 * evidence of a local run:
 *
 *   refused  NODE_ENV === "production"
 *   refused  REPLIT_DEPLOYMENT is set (Replit sets it in every Deployment)
 *   allowed  NODE_ENV === "development" (the `dev` script exports it) or "test"
 *   allowed  NODE_TEST_CONTEXT is set (node --test sets it in each test file's
 *            process)
 *   refused  anything else — including a bare `start` with no NODE_ENV
 */
export function mockIdentityPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["NODE_ENV"] === "production") return false;
  const deployment = env["REPLIT_DEPLOYMENT"];
  if (typeof deployment === "string" && deployment.length > 0) return false;
  if (env["NODE_ENV"] === "development" || env["NODE_ENV"] === "test") return true;
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
      "unsigned mock identity webhook refused: needs IDENTITY_PROVIDER=mock set explicitly and a local run " +
        "(NODE_ENV=development|test, or node --test), never production or a Replit deployment",
    );
    this.name = "MockWebhookRefusedError";
  }
}
