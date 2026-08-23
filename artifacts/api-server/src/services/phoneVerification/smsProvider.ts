/**
 * SMS provider — factory, stubs, and a non-throwing readiness probe.
 *
 * Deliberately mirrors services/identityVerification (providers.ts +
 * readiness.ts) in both shape and policy, because the two answer the same
 * question for different signals: "can this check actually be completed today?"
 * The identity module is split across five files; this is consolidated into one
 * because the SMS surface is a single `send` call rather than a session +
 * webhook lifecycle.
 *
 * THE POLICY, RESTATED HERE BECAUSE IT IS EASY TO GET WRONG:
 * a provider that cannot send is not a provider. `smsProviderStatus()` reports
 * operational=false unless a real adapter is both implemented and configured,
 * and `PhoneVerificationService` refuses to issue challenges in that state
 * rather than minting codes nobody can receive. The mock counts as operational
 * OUTSIDE production only — same rule the identity module applies, and for the
 * same reason: a mock that "verifies" in production is worse than no
 * verification, because downstream gates would treat it as real evidence.
 *
 * Wiring a real provider is a two-line change: implement the adapter, add its
 * name to IMPLEMENTED_PROVIDERS, set its env var. Nothing else needs to change
 * — the phone routes and the traveller gate open on their own.
 */

import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "SmsProvider" });

// ── Provider contract ─────────────────────────────────────────────────────────

export interface SmsMessage {
  /** E.164 destination. */
  to: string;
  /** Message body. Contains the verification code — never log it. */
  body: string;
}

export interface SmsSendResult {
  /** Provider-side message id, when the provider returns one. */
  messageId?: string;
}

export interface SmsProvider {
  name: string;
  send(msg: SmsMessage): Promise<SmsSendResult>;
}

// ── Mock (non-production only) ────────────────────────────────────────────────

/**
 * Records sends in memory so tests and local development can assert on them.
 * NEVER registered in production — getSmsProvider() refuses it there.
 */
const _mockOutbox: Array<{ to: string; body: string; at: string }> = [];

export function _mockSentMessages(): ReadonlyArray<{ to: string; body: string; at: string }> {
  return [..._mockOutbox];
}

export function _resetMockOutbox(): void {
  _mockOutbox.length = 0;
}

const mockProvider: SmsProvider = {
  name: "mock",
  async send(msg: SmsMessage): Promise<SmsSendResult> {
    _mockOutbox.push({ to: msg.to, body: msg.body, at: new Date().toISOString() });
    // The body carries a live credential, so only the destination is logged.
    logger.info({ to: msg.to }, "mock SMS queued (no message actually sent)");
    return { messageId: `mock-${_mockOutbox.length}` };
  },
};

// ── Real adapters (stubs) ─────────────────────────────────────────────────────
//
// Env needed later: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
// Docs: https://www.twilio.com/docs/messaging
// Mapping:
//   send -> POST /2010-04-01/Accounts/{sid}/Messages.json
//           ({ To, From: TWILIO_FROM_NUMBER, Body }), basic auth sid:token
//   Treat HTTP 2xx as sent; surface 4xx as a permanent failure (bad number)
//   and 5xx as retryable. Do NOT log Body — it contains the code.
const twilioProvider: SmsProvider = {
  name: "twilio",
  async send(_msg: SmsMessage): Promise<SmsSendResult> {
    throw new Error(
      "Twilio SMS adapter not configured. Set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / " +
      "TWILIO_FROM_NUMBER and implement smsProvider.ts (see comments).",
    );
  },
};

// Env needed later: MESSAGEBIRD_API_KEY, MESSAGEBIRD_ORIGINATOR
// Docs: https://developers.messagebird.com/api/sms-messaging/
const messagebirdProvider: SmsProvider = {
  name: "messagebird",
  async send(_msg: SmsMessage): Promise<SmsSendResult> {
    throw new Error("MessageBird SMS adapter not configured.");
  },
};

// ── Readiness ─────────────────────────────────────────────────────────────────

/**
 * Providers whose adapter above is actually implemented.
 *
 * ── ADD YOUR PROVIDER HERE WHEN YOU IMPLEMENT IT ────────────────────────────
 * This set is the single switch that tells the rest of the server that phone
 * verification works. Leaving a stub out of it is what keeps the phone gate
 * honest about a capability the product does not yet have.
 */
const IMPLEMENTED_PROVIDERS = new Set<string>(["mock"]);

/** Env var that must be present for each real provider to be considered live. */
const REQUIRED_ENV: Record<string, string> = {
  twilio: "TWILIO_ACCOUNT_SID",
  messagebird: "MESSAGEBIRD_API_KEY",
};

export interface SmsProviderStatus {
  /** True only when a verification code can actually be delivered today. */
  operational: boolean;
  provider: string;
  /** Explanation for server logs. Never returned to users verbatim. */
  reason: string;
}

/** Probe the configured SMS provider. Never throws. */
export function smsProviderStatus(
  env: NodeJS.ProcessEnv = process.env,
): SmsProviderStatus {
  const provider = (env["SMS_PROVIDER"] ?? "mock").toLowerCase();
  const isProduction = env["NODE_ENV"] === "production";

  if (!IMPLEMENTED_PROVIDERS.has(provider)) {
    const known = provider === "twilio" || provider === "messagebird";
    return {
      operational: false,
      provider,
      reason: known
        ? `SMS_PROVIDER=${provider} but that adapter in services/phoneVerification/smsProvider.ts ` +
          `is still a stub (send throws). Implement it and add it to IMPLEMENTED_PROVIDERS.`
        : `Unknown SMS_PROVIDER=${provider}.`,
    };
  }

  if (provider === "mock") {
    return isProduction
      ? {
          operational: false,
          provider,
          reason:
            "SMS_PROVIDER=mock is refused in production by getSmsProvider(); no code can actually be delivered.",
        }
      : { operational: true, provider, reason: "mock provider (non-production)" };
  }

  const requiredEnv = REQUIRED_ENV[provider];
  if (requiredEnv && !env[requiredEnv]) {
    return { operational: false, provider, reason: `SMS_PROVIDER=${provider} but ${requiredEnv} is not set.` };
  }

  return { operational: true, provider, reason: `${provider} adapter configured` };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Resolve the configured provider. THROWS when it cannot be used. */
export function getSmsProvider(): SmsProvider {
  const name = (process.env["SMS_PROVIDER"] ?? "mock").toLowerCase();

  if (name === "mock") {
    if (process.env["NODE_ENV"] === "production") {
      throw new Error("SMS_PROVIDER=mock is not allowed in production. Configure twilio or messagebird.");
    }
    return mockProvider;
  }
  if (name === "twilio") return twilioProvider;
  if (name === "messagebird") return messagebirdProvider;
  throw new Error(`Unknown SMS_PROVIDER: ${name}`);
}
