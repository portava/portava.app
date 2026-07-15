export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected' | 'expired';

export function isTravelBuddyVerified(profile?: {
  verified?: boolean;
  verificationStatus?: string | null;
} | null): boolean {
  if (!profile) return false;
  if (profile.verificationStatus === 'verified') return true;
  if (profile.verificationStatus == null && profile.verified === true) return true;
  return false;
}

export function getVerificationLabel(status?: string | null): string {
  switch (status) {
    case 'verified': return 'Travel Buddy Verified';
    case 'pending':  return 'Verification pending';
    case 'rejected': return 'Verification needs attention';
    case 'expired':  return 'Verification expired';
    default:         return 'Not verified';
  }
}

export function getVerificationOwnerPrompt(status?: string | null): string | null {
  switch (status) {
    case 'verified':  return null;
    case 'pending':   return 'Verification pending';
    case 'rejected':  return 'Verification needs attention';
    case 'expired':   return 'Verification expired';
    default:          return 'Verify your Passport';
  }
}
