/**
 * What an intel write's refusal means to the person who tapped, in one place.
 *
 * Every capture surface used to answer every refusal it did not special-case
 * with "Could not … — try again". Three of the refusals the server sends are
 * ones a retry can NEVER fix, so that copy sent people round a loop:
 *
 *   - 403 `forbidden` carrying `consent_required` — no Intelligence
 *     Contributions consent (routes/intel.ts REASON_CODE; the confirm route
 *     sends the same reason under `invalid_payload`). The way out is Settings.
 *   - 403 `forbidden` on APPROVE — approval is the admin trust gate
 *     (routes/intel.ts handleApproveClaim → requireAdmin). The Moment screen
 *     handles that one itself, as "waiting for review"; here it is only named.
 *   - 400 `invalid_payload` — the server refused THIS write as shaped (a
 *     movement report is aggregate-only, moderated content cannot back a claim,
 *     an option that maps to no claim). Sending it again sends the same thing.
 *
 * Everything else — a db_error, a 5xx, a dropped connection — may succeed on a
 * retry, and says so.
 */
export interface IntelWriteFailure {
  code?: string;
  error?: string;
}

export interface IntelWriteErrorCopy {
  message: string;
  /** Would sending the same thing again plausibly succeed? */
  retryable: boolean;
}

export function isConsentRefusal(f: IntelWriteFailure): boolean {
  return (f.code === 'forbidden' || f.code === 'invalid_payload') && typeof f.error === 'string' && /consent_required/.test(f.error);
}

export type IntelWriteAction = 'send' | 'propose' | 'record' | 'submit';

const PAST: Record<IntelWriteAction, string> = { send: 'sent', propose: 'proposed', record: 'recorded', submit: 'submitted' };

export function intelWriteErrorCopy(f: IntelWriteFailure, action: IntelWriteAction): IntelWriteErrorCopy {
  if (f.code === 'feature_disabled') return { message: 'Capture is turned off right now.', retryable: false };
  if (f.error === 'not_configured') return { message: 'Not connected.', retryable: false };
  if (isConsentRefusal(f)) {
    return { message: 'Turn on Intelligence Contributions in Settings → Live intel prompts to share.', retryable: false };
  }
  if (f.code === 'forbidden') return { message: 'Only a Portava reviewer can do this.', retryable: false };
  if (f.code === 'invalid_payload') return { message: `This can’t be ${PAST[action]} as it is.`, retryable: false };
  if (f.code === 'not_found') return { message: 'We couldn’t find this any more.', retryable: false };
  return { message: `Couldn’t ${action} — tap to try again.`, retryable: true };
}
