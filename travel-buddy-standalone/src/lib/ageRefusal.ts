/**
 * ageRefusal — how the app names an age refusal the server produced
 * (census-trust §31, TV-5b).
 *
 * The server's age gates go through lib/gateAge.ts and answer a meetup RSVP or
 * a circle-invite acceptance with 403 `{ error: "age_not_eligible", reason,
 * message }`. `reason` is one of:
 *
 *   not_verified_adult  a provider result on file says this person is not 18+
 *                       (the verified-minor contradiction rule, IDF-25). The
 *                       typed date of birth is present and contradicted, so
 *                       "add your date of birth" would be false, and no retry
 *                       or screen changes the result.
 *   below_min_age /     outside the host's limit; the server's own sentence
 *   above_max_age       names the limit, so it is kept when it arrived.
 *   dob_missing         no date of birth on the profile — the one case the
 *                       person can clear, from their profile.
 *
 * An unreadable check is NOT here: the server answers it 503
 * `degraded_unavailable` with no `reason`, and callers already show that
 * message as a retryable failure.
 *
 * The copy never discloses what an identity document said.
 *
 * Import-free so it runs under node:test.
 */

export const AGE_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'not_verified_adult',
  'below_min_age',
  'above_max_age',
  'dob_missing',
]);

export interface AgeRefusalPresentation {
  title: string;
  body: string;
  /** Present only when the person can clear the refusal themselves. */
  action?: { label: string; route: string };
}

type Surface = 'meetup' | 'circle';

const NOUN: Record<Surface, string> = { meetup: 'meetup', circle: 'circle' };

/** True when `message` is a sentence written for a person rather than a code or an HTTP placeholder. */
function isHumanSentence(message: string | null | undefined): message is string {
  return typeof message === 'string' && message.trim().includes(' ') && !/^API \d{3}$/.test(message.trim());
}

/**
 * The title, body and (only when the person can act) route for an age
 * refusal — or null when `reason` is not one, so the caller keeps its own
 * handling for everything else.
 */
export function ageRefusalPresentation(
  reason: string | null | undefined,
  serverMessage: string | null | undefined,
  surface: Surface,
): AgeRefusalPresentation | null {
  if (!reason || !AGE_REFUSAL_REASONS.has(reason)) return null;
  const noun = NOUN[surface];
  switch (reason) {
    case 'not_verified_adult':
      return {
        title: 'Age requirement',
        body: `Your identity check didn't confirm that you're 18 or over, so you can't join this ${noun}.`,
      };
    case 'dob_missing':
      return {
        title: 'Date of birth required',
        body: `This ${noun} has an age limit. Add your date of birth to your profile to join.`,
        action: { label: 'Go to profile', route: '/profile/edit' },
      };
    default:
      return {
        title: 'Age limit',
        body: isHumanSentence(serverMessage) ? serverMessage : `You're outside this ${noun}'s age limit, so you can't join it.`,
      };
  }
}
