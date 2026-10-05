/**
 * The shape every Input Intelligence opt-in shares (OD-INPUT-1, OD-INPUT-3).
 *
 * Each purpose has its OWN table — one switch per purpose, so a grant for one
 * can never be read as a grant for another (purpose limitation is structural,
 * not a column someone forgets to filter on). The rules are the same for all,
 * and live here once:
 *
 *   - the SERVER stamps the disclosure version and the timestamps; the client
 *     only says "on" or "off" (and, for "on", which version of the words it
 *     displayed — checked by the caller against the stamped one);
 *   - an absent row is OFF;
 *   - VALID means enabled, not withdrawn, and stamped with a version;
 *   - a failed read is `{ ok: false }` ("unreadable"), never "not consented":
 *     supabase-js RESOLVES `{ data, error }`, so the error is checked, not caught.
 *
 * Tables using it: input_outcome_consent (3780), input_memory_context_consent (3782).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type InputConsentTable = 'input_outcome_consent' | 'input_memory_context_consent';

export interface InputConsentState {
  enabled: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
}

export type InputConsentRead = { ok: true; state: InputConsentState | null } | { ok: false };

export function hasValidInputConsent(state: InputConsentState | null | undefined): boolean {
  return !!state && state.enabled === true && !state.withdrawnAt && !!state.consentVersion;
}

export async function readInputConsent(
  db: SupabaseClient,
  table: InputConsentTable,
  userId: string,
): Promise<InputConsentRead> {
  if (!userId) return { ok: false };
  try {
    const { data, error } = await db
      .from(table)
      .select('enabled, consent_version, consented_at, withdrawn_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return { ok: false };
    if (!data) return { ok: true, state: null };
    const r = data as Record<string, unknown>;
    return {
      ok: true,
      state: {
        enabled: r.enabled === true,
        consentVersion: typeof r.consent_version === 'string' ? r.consent_version : null,
        consentedAt: typeof r.consented_at === 'string' ? r.consented_at : null,
        withdrawnAt: typeof r.withdrawn_at === 'string' ? r.withdrawn_at : null,
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Record a grant (stamped with `version`) or a withdrawal. A withdrawal keeps
 * the record of which disclosure was once agreed to and when; it switches the
 * consent off and stamps the withdrawal. Returns the state as re-read, or the
 * state just written when the re-read fails.
 */
export async function writeInputConsent(
  db: SupabaseClient,
  table: InputConsentTable,
  version: string,
  userId: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<{ ok: true; state: InputConsentState } | { ok: false }> {
  if (!userId) return { ok: false };
  const at = now.toISOString();
  try {
    const { error } = enabled
      ? await db.from(table).upsert(
          { user_id: userId, enabled: true, consent_version: version, consented_at: at, withdrawn_at: null, updated_at: at },
          { onConflict: 'user_id' },
        )
      : await db.from(table).upsert(
          { user_id: userId, enabled: false, withdrawn_at: at, updated_at: at },
          { onConflict: 'user_id' },
        );
    if (error) return { ok: false };
  } catch {
    return { ok: false };
  }
  const read = await readInputConsent(db, table, userId);
  const state: InputConsentState =
    read.ok && read.state
      ? read.state
      : enabled
        ? { enabled: true, consentVersion: version, consentedAt: at, withdrawnAt: null }
        : { enabled: false, consentVersion: null, consentedAt: null, withdrawnAt: at };
  return { ok: true, state };
}
