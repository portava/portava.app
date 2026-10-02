/**
 * Pure helpers for meetup invite-more and the meetup invites inbox (PLAT-F31).
 *
 * POST /api/meetups/:id/invites (artifacts/api-server/src/routes/meetups.ts)
 * accepts only in-scope invitees — trip members for a trip meetup, circle
 * members for a circle meetup, mutual friends otherwise — and answers with
 * { invited, skipped, ineligible, ageIneligible }. The organiser is told each
 * outcome, so nobody who was not invited is counted as invited.
 */

export interface InviteResultLike {
  invited?: string[] | null;
  skipped?: string[] | null;
  ineligible?: string[] | null;
  ageIneligible?: string[] | null;
}

export function summarizeInviteResult(r: InviteResultLike): string {
  const n = (a?: string[] | null) => (Array.isArray(a) ? a.length : 0);
  const parts: string[] = [];
  parts.push(n(r.invited) > 0 ? `${n(r.invited)} invited` : 'Nobody new was invited');
  if (n(r.skipped) > 0) parts.push(`${n(r.skipped)} already invited`);
  if (n(r.ineligible) > 0) parts.push(`${n(r.ineligible)} can't be invited to this meetup`);
  if (n(r.ageIneligible) > 0) parts.push(`${n(r.ageIneligible)} outside the age limit`);
  return parts.join(' · ');
}

export type InviteCandidateSource = 'trip' | 'circle' | 'friends';

export function inviteCandidateSource(m: { tripId: string | null; circleOwnerId: string | null }): InviteCandidateSource {
  if (m.tripId) return 'trip';
  if (m.circleOwnerId) return 'circle';
  return 'friends';
}

/** The server lets only the creator invite, and never to a cancelled meetup. */
export function canInviteMore(m: { isCreator: boolean; status: string }): boolean {
  return m.isCreator && m.status !== 'cancelled';
}

/**
 * GET /api/me/meetup-invites returns pending invites (kind 'invite') and, for
 * invites already answered going/maybe, a notice once the time is confirmed
 * (kind 'confirmation'). The inbox shows them as two lists.
 */
export function splitMeetupInbox<T extends { kind: 'invite' | 'confirmation' }>(
  invites: T[],
): { pending: T[]; confirmations: T[] } {
  return {
    pending: invites.filter((i) => i.kind === 'invite'),
    confirmations: invites.filter((i) => i.kind === 'confirmation'),
  };
}
