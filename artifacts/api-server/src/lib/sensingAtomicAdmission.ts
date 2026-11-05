import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveSensingCredentialHash, type SensingContributionRow } from "./sensingAnonStore.js";
import { SENSING_ANON_POLICY_V1 } from "./sensingContributionPolicy.js";

type Refusal = 'unknown' | 'revoked' | 'not_started' | 'expired' | 'budget_exhausted' | 'disabled' | 'policy_changed' | 'unavailable';
const refusals = new Set<Refusal>(['unknown', 'revoked', 'not_started', 'expired', 'budget_exhausted', 'disabled', 'policy_changed']);

/** No separate insert/consume fallback: a missing migration must refuse the write. */
export async function recordSensingContributionAtomically(
  db: SupabaseClient, credential: string, row: SensingContributionRow, purposeScopes: string[],
): Promise<{ ok: true; duplicate: boolean } | { ok: false; reason: Refusal }> {
  try {
    const { data, error } = await db.rpc('sensing_admit_contribution', {
      p_credential_hash: deriveSensingCredentialHash(credential),
      p_policy_version: SENSING_ANON_POLICY_V1.policyVersion,
      p_purpose_scopes: purposeScopes,
      p_contribution: row,
    }).abortSignal(AbortSignal.timeout(6000));
    if (error) return { ok: false, reason: 'unavailable' };
    if (data === 'stored' || data === 'duplicate') return { ok: true, duplicate: data === 'duplicate' };
    return { ok: false, reason: refusals.has(data) ? data as Refusal : 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
