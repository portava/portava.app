/**
 * intelPrompts — the client caller of the server prompt-eligibility read model
 * (spec §6). GET /api/v1/intel/prompt-eligibility?subjectId=… returns the server's
 * throttle + fresh-qualifying-evidence decision for this actor and subject.
 *
 * useIntelPrompts folds this with its own local gates (pause, Safe Return, the
 * 45-minute client throttle in promptThrottleStorage). This service only fetches;
 * it never records a prompt.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export interface PromptEligibility {
  prompt: boolean;
  reason: 'ok' | 'paused' | 'safety_state' | 'throttled' | 'fresh_evidence_exists' | string;
  throttleWindowMs: number;
}

/**
 * Ask the server whether an unsolicited prompt is eligible for `subjectId`.
 * Returns null when the API is unconfigured, unauthenticated, or unreachable — the
 * caller then falls back to its LOCAL gates (fail-safe: no server "yes" is invented).
 */
export async function checkPromptEligibility(
  subjectId: string,
  opts: { followupRequired?: boolean } = {},
): Promise<PromptEligibility | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const token = await freshApiToken();
  if (!token) return null;
  const params = new URLSearchParams({ subjectId });
  if (opts.followupRequired) params.set('followupRequired', 'true');
  try {
    const res = await fetch(`${apiBase()}/api/v1/intel/prompt-eligibility?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      prompt: body.prompt === true,
      reason: typeof body.reason === 'string' ? body.reason : 'ok',
      throttleWindowMs: typeof body.throttle_window_ms === 'number' ? body.throttle_window_ms : 45 * 60_000,
    };
  } catch {
    return null;
  }
}
