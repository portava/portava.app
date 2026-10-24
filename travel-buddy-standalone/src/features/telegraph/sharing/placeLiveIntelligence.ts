/**
 * Telegraph §20 Places — "current intelligence" on a shared place card (census-telegraph T265).
 *
 * The server's PLACE projection carries `liveIntelligence` — Discovery's own grounded why-now for this
 * one place, in the live claims' own vocabulary, and how long from the read it stays true
 * (`whyNowValidForMs`). It is absent unless Discovery would serve it (both Discovery flags on, the live
 * gates clear, something observed). This module only decides how to SAY it:
 *
 *   - nothing to say (absent, empty, no stated validity) → nothing is drawn. A claim with no validity
 *     is never shown: nothing says it is current (the Discovery card's rule, DSV2-04's first branch).
 *   - inside its validity, on THIS device's clock from when the card received it → "Now: …".
 *   - past it → the claims are kept and said to be no longer current, in words (DSV2-04's second
 *     branch): silently dropping them would hide that anything was ever observed.
 *
 * It composes nothing: each claim is the server's token with underscores read as spaces.
 */
import { useEffect, useRef, useState } from 'react';

export interface PlaceLiveIntelligenceWire {
  whyNow: string[] | null;
  whyNowValidForMs: number | null;
}

export interface PlaceLiveLine {
  text: string;
  stale: boolean;
  /** When the line stops being current, on this device's clock; null once stale. */
  expiresAtMs: number | null;
}

/** setTimeout's ceiling (~24.8 days); a longer wait is re-armed rather than overflowing to 0. */
const MAX_TIMER_MS = 2_147_483_647;

function humanise(token: string): string {
  return token.replace(/_/g, ' ').trim();
}

/** Pure: the line for one projection, judged at `nowMs`, for a projection received at `receivedAtMs`. */
export function placeLiveLine(
  live: PlaceLiveIntelligenceWire | null | undefined,
  receivedAtMs: number,
  nowMs: number,
): PlaceLiveLine | null {
  if (!live || !Array.isArray(live.whyNow)) return null;
  const claims = live.whyNow.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map(humanise);
  if (claims.length === 0) return null;
  const validFor = live.whyNowValidForMs;
  if (typeof validFor !== 'number' || !Number.isFinite(validFor) || validFor <= 0) return null;
  const expiresAtMs = receivedAtMs + validFor;
  const joined = claims.join(' · ');
  if (nowMs >= expiresAtMs) return { text: `${joined} — no longer current`, stale: true, expiresAtMs: null };
  return { text: `Now: ${joined}`, stale: false, expiresAtMs };
}

/**
 * The line for a card on screen. The receipt time is taken when THIS projection first reaches the
 * card, and the hook re-renders itself at the expiry instant, so a card left open does not go on
 * asserting a claim past it.
 */
export function usePlaceLiveLine(live: PlaceLiveIntelligenceWire | null | undefined): PlaceLiveLine | null {
  const seen = useRef<{ live: PlaceLiveIntelligenceWire | null | undefined; at: number } | null>(null);
  if (!seen.current || seen.current.live !== live) seen.current = { live, at: Date.now() };
  const [, setTick] = useState(0);
  const line = placeLiveLine(live, seen.current.at, Date.now());
  const expiresAtMs = line?.expiresAtMs ?? null;
  useEffect(() => {
    if (expiresAtMs === null) return;
    const wait = Math.min(Math.max(0, expiresAtMs - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => setTick((n) => n + 1), wait + 1);
    return () => clearTimeout(timer);
  }, [expiresAtMs]);
  return line;
}
