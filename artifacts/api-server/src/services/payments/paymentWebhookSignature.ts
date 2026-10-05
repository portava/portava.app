/**
 * Payment-webhook signature verification, as a tagged result.
 *
 * The scheme is the one `services/identityVerification/webhookSignature.ts`
 * already implements and proves (`t=<unix-seconds>,v1=<hex>` over
 * `${t}.${rawBody}`, HMAC-SHA256, constant-time compare, replay window) — it is
 * the scheme Stripe uses for every webhook, payments included. This module does
 * not re-implement it: it calls that verifier and translates its throw into the
 * payment contract's answer, so a payment adapter cannot get the four classic
 * mistakes wrong differently from the identity adapters.
 *
 *   secret missing                -> unavailable / webhook_secret_not_configured
 *   header missing or malformed,
 *   digest mismatch, stale stamp  -> failed / signature_invalid
 *
 * The detail names the verifier's stable code and nothing else: never the
 * secret, the digest or the body.
 */

import {
  verifyTimestampedHmacSignature,
  WebhookSignatureError,
} from "../identityVerification/webhookSignature.js";
import { paymentFailed, paymentUnavailable, type PaymentRefusal, type WebhookDelivery } from "./PaymentProvider.js";

export interface VerifyPaymentWebhookInput {
  provider: string;
  delivery: WebhookDelivery;
  /** The header carrying the signature, e.g. `stripe-signature`. */
  headerName: string;
  /** The endpoint signing secret. Absent or empty is a refusal, never a bypass. */
  secret: string | undefined;
  /** Injectable clock; tests pin the replay window without sleeping. */
  nowMs?: number;
  toleranceSeconds?: number;
}

/** Null when the delivery is proven to come from the provider; otherwise the refusal to answer with. */
export function verifyPaymentWebhookSignature(input: VerifyPaymentWebhookInput): PaymentRefusal | null {
  try {
    verifyTimestampedHmacSignature({
      headers: input.delivery.headers,
      headerName: input.headerName,
      rawBody: input.delivery.rawBody,
      secret: input.secret,
      provider: input.provider,
      nowMs: input.nowMs,
      toleranceSeconds: input.toleranceSeconds,
    });
    return null;
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      if (err.code === "secret_not_configured") {
        return paymentUnavailable(input.provider, "webhook_secret_not_configured", "the webhook signing secret is not configured; no delivery can be verified");
      }
      return paymentFailed(input.provider, "signature_invalid", `webhook signature rejected: ${err.code}`);
    }
    return paymentFailed(input.provider, "signature_invalid", "webhook signature could not be verified");
  }
}
