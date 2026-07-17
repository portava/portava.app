// Maps dispute-endpoint error codes (POST /api/rent-a-buddy/bookings/:id/dispute)
// to user-facing messages. The server returns dedicated 409 codes so the client
// can distinguish "already in process" from "wrong state".

export const DISPUTE_ERROR_MESSAGES: Record<string, string> = {
  no_show_in_progress:
    'A no-show report is already open — it will escalate to a dispute automatically.',
  already_disputed: 'This booking is already under dispute.',
  invalid_transition: "This booking can't be disputed in its current state.",
  dispute_window_expired:
    'The dispute window has closed. The booking has been automatically completed.',
};

const GENERIC_DISPUTE_ERROR = 'Could not open a dispute. Please try again.';

export function disputeErrorMessage(code: string | null | undefined): string {
  if (code && DISPUTE_ERROR_MESSAGES[code]) return DISPUTE_ERROR_MESSAGES[code];
  return GENERIC_DISPUTE_ERROR;
}
