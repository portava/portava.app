/**
 * useTelegraphRecipients — Phase 4 (Social Identity) recipient-picker wiring.
 *
 * Sources the "start a new Telegraph conversation" recipient list from the P1
 * gateway (`telegraph_recipient` InputContext via `useInputAssistance`) and maps
 * the canonical projection into compact recipient rows (§8 → RecipientRow). It
 * is the reversible seam the new-conversation picker consumes.
 *
 * DEGRADE GRACEFULLY (§38): the recipient-search endpoint ships in a PARALLEL
 * backend PR and may not be deployed yet. When it is absent (404/offline) the
 * gateway reports `unavailable`; this hook surfaces that so the picker screen
 * can fall back to the current behavior (route to Discover to find people) —
 * it NEVER throws and never shows an error banner.
 *
 * PRIVACY (§29, §47): the backend resolves eligibility (blocked/private, account
 * enumeration) before projection; this hook trusts that list and does no
 * client-side re-filtering.
 */
import { useMemo } from 'react';
import { useInputAssistance } from '../platform/input-assistance/hooks/useInputAssistance.ts';
import {
  mapRecipientSuggestions,
  type RecipientRow,
} from '../platform/input-assistance/social/telegraphRecipients.ts';
import {
  registerSocialFields,
  SOCIAL_FIELD_IDS,
} from '../platform/input-assistance/social/socialFields.ts';
import type { InputSessionContext } from '../platform/input-assistance/types/inputSuggestion.ts';

// Register the social fields' policies once at module load (idempotent).
registerSocialFields();

export interface UseTelegraphRecipientsOpts {
  /** Coarse location for proximity-biased ranking (§15), when permitted. */
  lat?: number;
  lng?: number;
  /** Current app surface, for context-aware zero-state (§14). */
  surface?: string;
  /** Master switch — false clears results and stops all fetching. */
  enabled?: boolean;
}

export interface TelegraphRecipientsResult {
  recipients: RecipientRow[];
  loading: boolean;
  /** True when the recipient-search endpoint is unavailable (404/offline) —
   *  the picker should degrade to the Discover fallback, not show an error. */
  unavailable: boolean;
}

export function useTelegraphRecipients(
  query: string,
  opts: UseTelegraphRecipientsOpts = {},
): TelegraphRecipientsResult {
  const { lat, lng, surface = 'telegraph', enabled = true } = opts;

  const sessionContext = useMemo<InputSessionContext>(() => {
    const s: InputSessionContext = { surface };
    if (lat != null) s.lat = lat;
    if (lng != null) s.lng = lng;
    return s;
  }, [lat, lng, surface]);

  const gateway = useInputAssistance({
    fieldId: SOCIAL_FIELD_IDS.telegraphRecipient,
    context: 'telegraph_recipient',
    text: query,
    sessionContext,
    enabled,
  });

  const recipients = useMemo(
    () => mapRecipientSuggestions(gateway.suggestions),
    [gateway.suggestions],
  );

  return {
    recipients,
    loading: gateway.loading,
    unavailable: gateway.unavailable,
  };
}
