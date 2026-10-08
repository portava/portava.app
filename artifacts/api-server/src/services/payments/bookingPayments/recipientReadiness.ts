/**
 * recipientReadiness: whether a buddy's payment-provider verification lets
 * them offer, or be booked for, a Rent-a-Buddy service right now.
 *
 * ── THE OWNER'S RULING (OD-PAY-10, 2026-10-04) ──────────────────────────────
 *   "No unverified bookings. Require identity and payment-provider verification
 *    before someone can offer or book the service."
 * Identity is decided per person by lib/rentBuddyIdentityEligibility.ts. This
 * module decides the PAYMENT-PROVIDER half for the buddy, from the buddy's
 * stored recipient row (migration 3931 `rent_buddy_payment_recipients`, which
 * the provider's onboarding webhooks keep current):
 *
 *   ready        a recipient row exists for the buddy's payment party, with
 *                onboarding = 'verified' AND charges_enabled = true
 *   not_ready    anything else: no payment party, no recipient row, onboarding
 *                still in progress, restricted or rejected, or charges disabled
 *   unreadable   either read failed (including "the table is not applied"):
 *                the check did not run, so the action is refused with a 503
 *                and nothing is said about the buddy
 *
 * The provider is NOT called here. A booking-creation or publish request reads
 * the stored row, as the identity gate reads stored verification rows. Checkout
 * asks the provider again (checkout.ts readyRecipient), because that is where
 * money moves.
 *
 * Until 3821 and 3931 are applied, every read is `unreadable`, so every booking
 * creation and every publish answers 503. That is the fail-closed reading of
 * "no unverified bookings", and bookings are already closed on this tree by
 * lib/rentBuddyKycGate.ts while identity verification is not operational.
 */
import type { BookingPaymentStore } from "./model.js";
import { supabaseBookingPaymentStore } from "./supabaseStore.js";

export type BuddyPaymentReadiness =
  | { readonly state: "ready" }
  | { readonly state: "not_ready"; readonly why: "no_party" | "no_recipient" | "onboarding_incomplete" | "charges_disabled" }
  | { readonly state: "unreadable" };

/** Decide from the two stored reads. Never throws. */
export async function readBuddyPaymentReadiness(
  store: Pick<BookingPaymentStore, "partyForProfile" | "getRecipient">,
  buddyUserId: string,
): Promise<BuddyPaymentReadiness> {
  try {
    const party = await store.partyForProfile(buddyUserId);
    if (!party.ok) return { state: "unreadable" };
    if (!party.value) return { state: "not_ready", why: "no_party" };
    const r = await store.getRecipient(party.value);
    if (!r.ok) return { state: "unreadable" };
    if (!r.value) return { state: "not_ready", why: "no_recipient" };
    if (r.value.onboarding !== "verified") return { state: "not_ready", why: "onboarding_incomplete" };
    if (r.value.chargesEnabled !== true) return { state: "not_ready", why: "charges_disabled" };
    return { state: "ready" };
  } catch {
    return { state: "unreadable" };
  }
}

/** The production reader over a service-role client. */
export function buddyPaymentReadiness(db: any, buddyUserId: string): Promise<BuddyPaymentReadiness> {
  return readBuddyPaymentReadiness(supabaseBookingPaymentStore(db), buddyUserId);
}

/**
 * The PUBLISH door, for the buddy themself: creating or activating something a
 * traveller can book (an offer on a request, a package, "available now").
 * Writes the refusal and returns false, or returns true. The buddy is told what
 * THEY must do; nothing here reaches a traveller.
 */
export async function requireBuddyPaymentReadyToPublish(
  db: any,
  res: any,
  buddyUserId: string,
  read: (db: any, buddyUserId: string) => Promise<BuddyPaymentReadiness> = buddyPaymentReadiness,
): Promise<boolean> {
  const r = await read(db, buddyUserId);
  if (r.state === "ready") return true;
  if (r.state === "unreadable") {
    res.status(503).json({
      error: "payout_status_unavailable",
      retryable: true,
      message: "We couldn't confirm your payout setup right now, so nothing was published. Please try again shortly.",
    });
    return false;
  }
  res.status(403).json({
    error: "payout_setup_required",
    message: "Finish setting up payouts before you publish. Travellers can book you once your payout account is verified.",
  });
  return false;
}
