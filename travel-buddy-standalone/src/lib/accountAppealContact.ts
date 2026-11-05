import { publicOwnerLink } from './publicOwnerLink.ts';
/** A public, owner-operated helpdesk. Never attach tokens, reporter data or a user ID. */
export function accountAppealContact(raw = process.env.EXPO_PUBLIC_ACCOUNT_APPEAL_URL): string | null {
  return publicOwnerLink(raw);
}
