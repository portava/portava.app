/**
 * verificationDisclosure — what the identity check keeps, what it never keeps,
 * and what to tell a person whose check failed (census-trust §31, TV-2b/TV-2d).
 *
 * TV-2b. docs/trust/verified-foundation-plan.md V-2 specifies the screen's intro
 * as "what / why / **what we never store**". The screen had a benefits list and
 * no privacy disclosure, so a person was asked for a government ID on an
 * unstated basis. The lists below are that disclosure. They are FACTS about the
 * schema, not policy written here: `identity_verifications` has no column that
 * can hold a document image, a document number, a selfie or a date of birth
 * (privacy invariant 1, census-trust TV-P1), and the provider's age answer is
 * stored as one yes/no. `src/lib/__tests__/verificationDisclosure.test.ts` reads
 * the schema of record and fails if either list stops being true of it.
 *
 * Scope, stated so it is not over-read: this is what the IDENTITY CHECK keeps.
 * A date of birth a person types into their own profile is a separate field
 * with its own open owner decision (D-DOB, census-trust TV-P2), and nothing
 * here says otherwise.
 *
 * TV-2d. A failure used to read as the raw enum with underscores replaced
 * ("document invalid", "underage"), and every failure re-offered the check —
 * including `underage`, which the plan says must route to an age-policy screen
 * and must NOT invite retry spam. A provider result of under 18 is already a
 * refusal on the server (lib/gateAge.ts); the copy here states the requirement
 * and does not disclose what the document said.
 *
 * Import-free so it runs under node:test.
 */

export type DisclosedFailureReason =
  | 'document_invalid'
  | 'selfie_mismatch'
  | 'underage'
  | 'abandoned'
  | 'provider_error'
  /**
   * The verification service does not cover this market. Mirrors
   * `NormalizedFailureReason` on the server, where the argument for keeping it
   * separate from `other` is written out in full
   * (artifacts/api-server/src/services/identityVerification/types.ts).
   *
   * The reason this member exists on the CLIENT is the copy below: "the check
   * didn't go through, please try again" is false here. Nothing the person does
   * with their camera changes the answer, and inviting a retry spends one of
   * their three daily attempts on a check that cannot pass.
   */
  | 'coverage_unsupported'
  | 'other';

/** One thing the identity check never stores, and the column shape that would betray it. */
export interface NeverStoredItem {
  label: string;
  /** A column name matching this would hold the item — the schema test refuses it. */
  forbiddenColumn: RegExp;
}

export const VERIFICATION_NEVER_STORED: readonly NeverStoredItem[] = [
  { label: 'An image or scan of your ID document', forbiddenColumn: /(document|id)_?(image|photo|scan|front|back|file|url)/ },
  { label: 'Your document number', forbiddenColumn: /(document|passport|license|licence|id)_?(number|no|num)\b/ },
  { label: 'Your selfie image', forbiddenColumn: /selfie_?(image|photo|url|file|video)/ },
  { label: 'The date of birth on your document', forbiddenColumn: /(date_of_birth|birth_?date|\bdob\b|birthday)/ },
];

/** One thing the identity check DOES keep, and the column(s) it lives in. */
export interface KeptItem {
  label: string;
  columns: readonly string[];
}

export const VERIFICATION_KEPT: readonly KeptItem[] = [
  { label: 'Whether the check passed, and if not, the general reason', columns: ['status', 'failure_reason'] },
  { label: 'Whether you are over 18 — a yes or no, not your birthday', columns: ['is_over_18'] },
  { label: 'Whether your selfie matched your document — a yes or no', columns: ['selfie_match'] },
  { label: 'The country that issued your document', columns: ['document_country'] },
  { label: "A reference number from the verification service, so we can ask them to delete their copy", columns: ['provider_verification_ref'] },
];

/** The registered app route that explains the age requirement (app/profile/age-policy.tsx). */
export const AGE_POLICY_ROUTE = '/profile/age-policy';

const FAILURE_COPY: Record<DisclosedFailureReason, string> = {
  document_invalid:
    "We couldn't read your document. Make sure all of it is in the frame, in good light and without glare, then try again.",
  selfie_mismatch:
    "Your selfie didn't match the photo on your document. Try again facing the camera in good light, without glasses or a hat.",
  underage:
    "Your identity check didn't confirm that you're 18 or over. Features that need a verified adult aren't available to you.",
  abandoned:
    "The check wasn't finished, so nothing was verified. You can start again whenever you're ready.",
  provider_error:
    "The verification service had a problem on its side, so the check didn't complete. Please try again.",
  coverage_unsupported:
    "We can't verify identity documents from your country yet, so this check couldn't be completed. " +
    "This isn't about your document — it's a gap in the service we use.",
  other:
    "The check didn't go through. Please try again.",
};

/** Human copy for a failed check. Unknown or missing reasons fall back to the generic sentence. */
export function verificationFailureCopy(reason: DisclosedFailureReason | null | undefined): string {
  if (reason && Object.prototype.hasOwnProperty.call(FAILURE_COPY, reason)) {
    return FAILURE_COPY[reason as DisclosedFailureReason];
  }
  return FAILURE_COPY.other;
}

/**
 * May the screen offer the check again? Every outcome except a FAILED check
 * whose reason is `underage`: that is a statement about the person, not a
 * transient failure, and re-offering it is the retry spam the plan forbids.
 * (The server still rate-limits session creation to 3 a day either way.)
 */
export function verificationRetryAllowed(
  row: { status: string; failureReason: string | null } | null | undefined,
): boolean {
  if (!row) return true;
  return !(row.status === 'failed' && row.failureReason === 'underage');
}
