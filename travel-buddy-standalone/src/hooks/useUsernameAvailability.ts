/**
 * useUsernameAvailability — Phase 4 (Social Identity) shared username check.
 *
 * The non-blocking, debounced availability + min-length check for a username
 * field (§23). It wires the app's existing `checkUsername` service to the SINGLE
 * canonical rule set in `platform/input-assistance/social/usernameValidation.ts`
 * (sanitize + min-length + availability interpretation), so onboarding gets the
 * EXACT validation the identity screen already enforces — no second rule set.
 *
 * Behavior mirrors the identity screen's inline handler: 500ms debounce, a
 * synchronous "At least 3 characters required" state below the minimum, and a
 * server availability check above it. The handle is treated as OPTIONAL — an
 * empty (or unchanged) value is `idle`, never invalid.
 *
 * This hook imports the Supabase-backed `checkUsername`, so it must not be
 * imported by node:test files; the pure rules it delegates to are tested
 * directly under node:test.
 */
import { useEffect, useRef, useState } from 'react';
import { checkUsername } from '../services/profile.ts';
import {
  usernameSyntaxError,
  isUsernameCheckable,
  interpretAvailability,
} from '../platform/input-assistance/social/usernameValidation.ts';

export type UsernameAvailabilityStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'taken'
  | 'invalid';

export interface UseUsernameAvailabilityOpts {
  /** A handle to treat as already-owned/known-good — never re-checked (e.g. the
   *  value the profile loaded with). */
  skipValue?: string;
  /** Debounce before hitting the availability endpoint. */
  debounceMs?: number;
  /** Master switch — false parks the hook at `idle`. */
  enabled?: boolean;
}

export interface UseUsernameAvailabilityResult {
  status: UsernameAvailabilityStatus;
  message: string | null;
  /** True when the field is safe to submit: idle (empty/unchanged) or available.
   *  Never blocks on a transient `checking` — callers gate that separately. */
  ok: boolean;
}

/**
 * @param handle the ALREADY-SANITIZED handle (the screen sanitizes on input via
 *               `sanitizeUsername`); this hook does not re-sanitize.
 */
export function useUsernameAvailability(
  handle: string,
  opts: UseUsernameAvailabilityOpts = {},
): UseUsernameAvailabilityResult {
  const { skipValue, debounceMs = 500, enabled = true } = opts;

  const [status, setStatus] = useState<UsernameAvailabilityStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic sequence guard: only the latest check may commit (§33).
  const seqRef = useRef(0);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const mySeq = ++seqRef.current;

    // Empty or unchanged → nothing to validate (optional field).
    if (!enabled || handle.length === 0 || handle === (skipValue ?? '')) {
      setStatus('idle');
      setMessage(null);
      return;
    }

    // Synchronous min-length rule (shared with the identity screen).
    const syntaxError = usernameSyntaxError(handle);
    if (syntaxError) {
      setStatus('invalid');
      setMessage(syntaxError);
      return;
    }
    if (!isUsernameCheckable(handle)) {
      setStatus('idle');
      setMessage(null);
      return;
    }

    setStatus('checking');
    setMessage(null);
    timerRef.current = setTimeout(async () => {
      const res = await checkUsername(handle);
      if (mySeq !== seqRef.current) return; // superseded by a newer keystroke
      const interpreted = interpretAvailability(res);
      setStatus(interpreted.status);
      setMessage(interpreted.message);
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [handle, skipValue, debounceMs, enabled]);

  const ok = status === 'idle' || status === 'available';
  return { status, message, ok };
}
