/**
 * rentBuddyIdentityEligibility — who may be on either side of a Rent-a-Buddy
 * booking, decided per PERSON on every booking-creation path.
 *
 * ── THE OWNER'S RULINGS (2026-10-04) ─────────────────────────────────────────
 *   "Identity requirement for Rent-a-Buddy: No unverified bookings. Require
 *    identity and payment-provider verification before someone can offer or
 *    book the service." — and, from the mission text, "real identity
 *    verification. No tester bypass or sandbox verification key. Keep booking
 *    paths fail-closed."
 *   "Buddy payment eligibility: Allow only adults who pass identity
 *    verification, provider onboarding, and safety checks … No payments for
 *    minors."
 *   "Reach of Trust restrictions: Enforce restrictions on the server across all
 *    relevant APIs and surfaces … Limit each restriction to the actions and
 *    duration needed."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * `lib/rentBuddyKycGate.ts` closes bookings while identity verification is not
 * operational — a DEPLOYMENT fact. Nothing checked the PEOPLE: the traveller's
 * ID was required only where an admin-editable launch control said so
 * (`requireIdVerification`), the buddy's only for two high-risk categories, and
 * both accepted labels (`verification_status = 'verified'`, any non-'none'
 * `verification_level`, the buddy table's `id_verified`) that an admin action
 * or a seed can set without any check having run. The day a provider became
 * operational, an unverified traveller could book an unverified buddy in every
 * ordinary category.
 *
 * ── WHAT THIS REQUIRES, OF BOTH PEOPLE, ON EVERY CREATION PATH ──────────────
 *   1. a current REAL identity verification
 *      (services/identityVerification/currentVerification.ts — live mode, not
 *      sandbox, not revoked, most recent finished attempt approved);
 *   2. adult on that verification (`is_over_18` exactly true);
 *   3. no Trust restriction covering the action: the buddy must not be under a
 *      `hosting` restriction (an in-person service is hosted by the buddy), the
 *      traveller not under `private_plan_access` (a booking is a private
 *      in-person plan). This mapping of the four existing restriction types
 *      onto booking is THIS module's reading of "limit each restriction to the
 *      actions needed"; it is recorded as such, not as an owner ruling.
 *   4. the BUDDY's payment-provider verification (OD-PAY-10, second half): a
 *      recipient row with onboarding 'verified' and charges enabled
 *      (services/payments/bookingPayments/recipientReadiness.ts; foot of file).
 *
 * ── FAIL-CLOSED ──────────────────────────────────────────────────────────────
 * An unreadable verification or restriction state answers 503 and refuses THIS
 * booking. It never answers "not verified" (that would be a false accusation)
 * and never lets the booking through.
 *
 * ── PRIVACY ──────────────────────────────────────────────────────────────────
 * The traveller is told what THEY must do. About the buddy they learn only that
 * this buddy cannot take bookings right now — never that the buddy is
 * unverified, a minor, or restricted.
 */
import { readCurrentIdentityVerification, type CurrentIdentityVerification } from "../services/identityVerification/currentVerification.js";
import { getRestrictionState, type RestrictionState } from "../services/trust/TrustRestrictionService.js";

export type BookingPartyRefusal = {
  readonly allowed: false;
  readonly httpStatus: 403 | 503;
  readonly code:
    | "identity_verification_required"
    | "age_requirement"
    | "account_restricted"
    | "buddy_unavailable"
    | "verification_unavailable" | "payment_verification_unavailable";
  /** Which side the refusal is about. The buddy side is never explained further to the traveller. */
  readonly side: "traveler" | "buddy" | "both" | null;
  readonly message: string;
};

export type BookingPartyEligibility = { readonly allowed: true } | BookingPartyRefusal;

const UNAVAILABLE: BookingPartyRefusal = {
  allowed: false,
  httpStatus: 503,
  code: "verification_unavailable",
  side: null,
  message: "We couldn't confirm identity checks right now, so this booking was not made. Please try again shortly.",
};

const BUDDY_UNAVAILABLE: BookingPartyRefusal = {
  allowed: false,
  httpStatus: 403,
  code: "buddy_unavailable",
  side: "buddy",
  message: "This Buddy can't take bookings right now.",
};

export interface BookingPartiesInput {
  readonly travelerId: string;
  readonly buddyUserId: string | null | undefined;
}

export interface BookingPartiesDeps {
  readVerification?: (db: any, userId: string) => Promise<CurrentIdentityVerification>;
  readRestrictions?: (db: any, userId: string) => Promise<RestrictionState>; readPaymentReadiness?: (db: any, buddyUserId: string) => Promise<BuddyPaymentReadiness>;
}

/** Decide, without writing a response. Never throws. */
export async function checkBookingParties(
  db: any,
  input: BookingPartiesInput,
  deps: BookingPartiesDeps = {},
): Promise<BookingPartyEligibility> {
  const readVerification = deps.readVerification ?? ((d: any, u: string) => readCurrentIdentityVerification(d, u));
  const readRestrictions = deps.readRestrictions ?? ((d: any, u: string) => getRestrictionState(d, u)); const readPaymentReadiness = deps.readPaymentReadiness ?? buddyPaymentReadiness;
  const buddyUserId = input.buddyUserId;
  // A buddy profile with no user behind it cannot be verified, so it cannot be booked.
  if (typeof buddyUserId !== "string" || buddyUserId.length === 0) return BUDDY_UNAVAILABLE;

  let traveler: CurrentIdentityVerification;
  let buddy: CurrentIdentityVerification;
  let travelerRestrictions: RestrictionState;
  let buddyRestrictions: RestrictionState; let buddyPayments: BuddyPaymentReadiness;
  try {
    [traveler, buddy, travelerRestrictions, buddyRestrictions, buddyPayments] = await Promise.all([
      readVerification(db, input.travelerId),
      readVerification(db, buddyUserId),
      readRestrictions(db, input.travelerId),
      readRestrictions(db, buddyUserId), readPaymentReadiness(db, buddyUserId),
    ]);
  } catch {
    return UNAVAILABLE;
  }

  if (traveler.state === "unreadable" || buddy.state === "unreadable") return UNAVAILABLE;
  // fail_closed = the restriction table could not be read: the check did not run. Never a restriction message.
  if (travelerRestrictions.degradedReason === "fail_closed" || buddyRestrictions.degradedReason === "fail_closed") return UNAVAILABLE; if (buddyPayments.state === "unreadable") return PAYMENTS_UNAVAILABLE; // the payment check did not run

  if (traveler.state !== "verified") {
    return {
      allowed: false,
      httpStatus: 403,
      code: "identity_verification_required",
      side: "traveler",
      message:
        traveler.reason === "sandbox_verification" || traveler.reason === "mode_unrecorded"
          ? "Your earlier identity check can't be used for bookings. Please verify your identity again to continue."
          : "Rent a Buddy bookings require a verified identity. Please verify your identity to continue.",
    };
  }
  if (!traveler.adult) {
    return {
      allowed: false,
      httpStatus: 403,
      code: "age_requirement",
      side: "traveler",
      message: "Rent a Buddy bookings are only available to verified adults (18 and over).",
    };
  }
  if (!travelerRestrictions.canJoinPrivatePlans) {
    return {
      allowed: false,
      httpStatus: 403,
      code: "account_restricted",
      side: "traveler",
      message: // D-24 (2026-10-06): the restriction's own sentence (TrustPrivacyGuard), never a reason the person was not told
        restrictionSentence("private_plan_access") + " " +
        "You can ask for a review in Appeals.",
    };
  }

  if (buddy.state !== "verified" || !buddy.adult || !buddyRestrictions.canHost || buddyPayments.state !== "ready") return BUDDY_UNAVAILABLE;

  return { allowed: true };
}

/**
 * Express helper in the house convention (`requireBookingKyc`): writes the
 * refusal and returns false, or returns true when both people may proceed.
 */
export async function requireVerifiedBookingParties(
  db: any,
  res: any,
  input: BookingPartiesInput,
  deps: BookingPartiesDeps = {},
): Promise<boolean> {
  const r = await checkBookingParties(db, input, deps);
  if (r.allowed) return true;
  res.status(r.httpStatus).json({ error: r.code, side: r.side, message: r.message });
  return false;
}

// ── OD-PAY-10, second half: the buddy's payment-provider verification ─────────
// Appended at the foot so every cited line above keeps its number. Read with
// the identity reads, decided last: the traveller learns what THEY must do
// first, and about the buddy only that this Buddy can't take bookings right now.
import { buddyPaymentReadiness, type BuddyPaymentReadiness } from "../services/payments/bookingPayments/recipientReadiness.js";

/** The buddy's payout status could not be read: the check did not run. Says nothing about the buddy. */
const PAYMENTS_UNAVAILABLE: BookingPartyRefusal = {
  allowed: false,
  httpStatus: 503,
  code: "payment_verification_unavailable",
  side: null,
  message: "We couldn't complete this booking's checks right now, so it was not made. Please try again shortly.",
};

// D-24 (2026-10-06): the refusal text is the restriction's own sentence. Appended so no cited line moves.
import { restrictionSentence } from "../services/trust/TrustPrivacyGuard.js";
