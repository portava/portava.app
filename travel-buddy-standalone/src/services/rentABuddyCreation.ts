/**
 * Rent a Buddy — one Idempotency-Key per booking-creation ATTEMPT.
 *
 * THE DEFECT THIS CLOSES (payments PAY-T12, independent verification of PR
 * #603). A booking-creation request whose answer never arrived — the network
 * dropped it, or the server answered 5xx after the booking had in fact been
 * made — left the traveller looking at an error with a booking they could not
 * see. Tapping the button again made a SECOND booking, with a second earnings
 * ledger behind it. No creation path carried anything that tied the retry to
 * the first try.
 *
 * NOW every creation request carries `Idempotency-Key`. The server stores it on
 * the booking (unique per traveller and resource — migration 3824,
 * `rbb_creation_key_once`) and answers a retry with the ORIGINAL booking.
 *
 * WHAT "AN ATTEMPT" IS. The key is minted when a request is first sent for a
 * given scope and payload, and is KEPT until the server gives a DEFINITE answer:
 *
 *   success              the booking exists — the attempt is over;
 *   a 4xx refusal        the request was rejected and nothing was created —
 *                        the attempt is over; a corrected request is a new one;
 *   no answer, or a 5xx  UNKNOWN — the booking may exist. The key is kept, so
 *                        sending the same request again cannot make a second.
 *
 * A request for something else (another buddy, another date) has another
 * payload and therefore another key: two deliberate bookings stay two bookings.
 *
 * Kept free of imports (no react-native, no supabase) so it can be unit-tested
 * under node:test, like rentABuddyBookingErrors.ts.
 */

/** The result shape of the Rent-a-Buddy service layer's apiFetch. */
export type CreationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number; gate?: string };

/** What the server accepts: 8–120 characters of [A-Za-z0-9_.:-]. */
export const CREATION_KEY_RE = /^[A-Za-z0-9_.:-]{8,120}$/;

/**
 * A collision-resistant key. Prefers a real UUID where the runtime has one;
 * otherwise time + entropy — no crypto polyfill is needed on native (the same
 * approach as services/intelCapture.ts#makeIdempotencyKey).
 */
export function mintCreationKey(): string {
  const g: any = globalThis as any;
  const uuid: string | null = typeof g?.crypto?.randomUUID === 'function' ? g.crypto.randomUUID() : null;
  const body = uuid ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
  return `rab-${body}`.slice(0, 120);
}

/** Did the server give a definite answer — one after which nothing is in doubt? */
export function isDefiniteAnswer(result: CreationResult<unknown>): boolean {
  if (result.ok) return true;
  return typeof result.status === 'number' && result.status >= 400 && result.status < 500;
}

/**
 * The attempts in flight or in doubt, by fingerprint. A factory, so a test (or
 * a second surface) can hold its own; the service layer uses ONE for the app.
 */
export function createAttemptRegistry(mint: () => string = mintCreationKey) {
  const pending = new Map<string, string>();

  /** A stable fingerprint of what is being created. Key order does not matter. */
  function fingerprint(scope: string, payload: unknown): string {
    const stable = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(stable);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
          const value = (v as Record<string, unknown>)[k];
          if (value !== undefined) out[k] = stable(value);
        }
        return out;
      }
      return v;
    };
    return `${scope}|${JSON.stringify(stable(payload ?? null))}`;
  }

  return {
    /**
     * Send one creation request with the attempt's key. `send` receives the
     * headers to add; the registry forgets the attempt on a definite answer and
     * keeps it otherwise.
     */
    async send<T>(
      scope: string,
      payload: unknown,
      send: (headers: { 'Idempotency-Key': string }) => Promise<CreationResult<T>>,
    ): Promise<CreationResult<T>> {
      const fp = fingerprint(scope, payload);
      const key = pending.get(fp) ?? mint();
      pending.set(fp, key);
      let result: CreationResult<T>;
      try {
        result = await send({ 'Idempotency-Key': key });
      } catch (err: any) {
        // A thrown send is an unknown outcome: keep the key.
        return { ok: false, error: err?.message ?? 'network_error' };
      }
      if (isDefiniteAnswer(result)) pending.delete(fp);
      return result;
    },
    /** How many attempts are still in doubt (for tests). */
    size: () => pending.size,
  };
}
