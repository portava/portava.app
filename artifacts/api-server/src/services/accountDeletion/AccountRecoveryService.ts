import type { SupabaseClient } from '@supabase/supabase-js';

export type AccountRecoveryResult =
  | { kind: 'restored'; alreadyRecovered: boolean; accountStatus: 'active' | 'deactivated' }
  | { kind: 'refused'; reason: string }
  | { kind: 'unavailable' };

/** Owner and admin surfaces share the same audited database transition. */
export async function recoverDeletedAccount(
  sc: SupabaseClient,
  input: { actorId: string; userId: string; generation: string; reason: string },
): Promise<AccountRecoveryResult> {
  try {
    const { data, error } = await sc.rpc('recover_deleted_account', {
      p_actor: input.actorId, p_user: input.userId, p_generation: input.generation, p_reason: input.reason,
    });
    if (error || !data || typeof data !== 'object') return { kind: 'unavailable' };
    if (data.ok === false && typeof data.error === 'string') return { kind: 'refused', reason: data.error };
    if (data.ok !== true || typeof data.alreadyRecovered !== 'boolean' || !['active', 'deactivated'].includes(data.accountStatus)) return { kind: 'unavailable' };
    return { kind: 'restored', alreadyRecovered: data.alreadyRecovered, accountStatus: data.accountStatus };
  } catch { return { kind: 'unavailable' }; }
}

export function recoveryRefusalMessage(reason: string): string {
  switch (reason) {
    case 'deactivation_changed': return 'This deactivation changed. Refresh the account before trying again.';
    case 'self_reactivation_expired': return 'Your one-year self-reactivation window has ended. Contact support for help.';
    case 'self_deactivation_unverified': return 'This account was not confirmed as personally deactivated. Contact support for help.';
    case 'profile_requires_recovery': return 'This profile has a deletion request. Use profile recovery instead of reactivation.';
    case 'self_recovery_expired': return 'Your 90-day recovery window has ended. An admin can still help unless your profile has been permanently deleted.';
    case 'permanent_deletion_started': return 'Permanent deletion has started. This profile cannot be recovered.';
    case 'legacy_recovery_unverified': return 'This older deletion needs an integrity review before recovery.';
    case 'profile_unavailable': return 'The original profile or sign-in is no longer available for recovery.';
    case 'recovery_forbidden': return 'You are not authorized to recover this profile.';
    default: return 'The deletion changed. Refresh its current state before trying again.';
  }
}
