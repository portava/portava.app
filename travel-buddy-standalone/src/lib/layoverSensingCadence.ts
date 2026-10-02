/**
 * layoverSensingCadence — census §16 L157, the CLIENT half.
 *
 * ── WHAT L157 ASKS, AND WHAT THIS SURFACE ACTUALLY HAS ───────────────────────
 * "Adaptive sensing: low frequency when safe/stationary, moderate near decision
 * boundaries, navigation-appropriate during RETURNING; avoid continuous GPS."
 *
 * The server settled the LOCATION half of that table already
 * (`LayoverDegradedService.sensingPolicy`), and it is not published on any
 * route — `grep sensingPolicy routes/` is empty — so nothing here consumes it.
 * It would also govern nothing if it were: this client performs NO location
 * sensing on the layover surface, in any state, and `__tests__` now guards that
 * absence rather than leaving it to habit. `locationSensing` below is
 * permanently `'none'` for exactly that reason, and it is a field rather than a
 * comment so a future surface has to change a tested value to start sensing.
 *
 * What this surface does have is ONE periodic loop: the dashboard re-reads
 * `GET /overview` so the certified numbers cannot drift while a traveller acts
 * on them. It ran every 60 seconds whether they had four hours or four minutes.
 * That is the cadence L157 is about on this client, and it is what this module
 * makes state-dependent.
 *
 * ── THE RUNG IS THE SERVER'S ─────────────────────────────────────────────────
 * The input is the CERTIFIED `returnState` and nothing else. No minutes, no
 * clock, no threshold of this module's own: a second escalation rule on the
 * client is the same defect L115 forbids of the map, and the server already
 * publishes the rung on every overview (`safeReturn.returnState`).
 *
 * An unknown or absent rung keeps the 60 seconds this screen has always used.
 * A server that states nothing must not make the screen go quiet, and must not
 * have a rung invented for it either.
 *
 * ── WHY TIGHTER AND NOT LOOSER ───────────────────────────────────────────────
 * Only the sharp end changes: NORMAL is untouched at 60 s, so the case that has
 * always shipped keeps its exact behaviour, and the extra reads happen in the
 * window where the numbers move fastest and matter most.
 */
import type { LayoverReturnState } from '../services/layover.ts';

/** Coarser than the server's table because this is polling, not positioning. */
export type LayoverCadence = 'idle' | 'low' | 'moderate' | 'returning';

export const LAYOVER_REFRESH_INTERVAL_MS = {
  /** Far from the deadline — the cadence this screen has always used. */
  low: 60_000,
  /** Near the decision boundary. */
  moderate: 30_000,
  /** Heading back: the numbers that matter are moving. */
  returning: 15_000,
} as const;

export interface LayoverCadenceDecision {
  cadence: LayoverCadence;
  /** Milliseconds between overview re-reads. `null` means do not poll. */
  intervalMs: number | null;
  /**
   * Permanently `'none'`. This surface holds no location grant to spend, in any
   * state including the emergency one — an emergency does not grant a
   * permission nobody gave (which is the rule the server's own table applies at
   * `LayoverDegradedService.sensingPolicy`, `locationGranted: false`).
   */
  locationSensing: 'none';
  /** Why, in one phrase. For diagnostics; never rendered as a claim. */
  reason: string;
}

export function layoverSensingCadence(input: {
  sessionStatus: string | null | undefined;
  returnState: LayoverReturnState | null | undefined;
}): LayoverCadenceDecision {
  if (input.sessionStatus !== 'active') {
    return {
      cadence: 'idle',
      intervalMs: null,
      locationSensing: 'none',
      reason: 'session is not active — nothing left to re-read',
    };
  }
  switch (input.returnState) {
    case 'RETURN_NOW':
    case 'CONNECTION_AT_RISK':
      return {
        cadence: 'returning',
        intervalMs: LAYOVER_REFRESH_INTERVAL_MS.returning,
        locationSensing: 'none',
        reason: 'returning to the airport — the certified numbers move fastest here',
      };
    case 'RETURN_SOON':
      return {
        cadence: 'moderate',
        intervalMs: LAYOVER_REFRESH_INTERVAL_MS.moderate,
        locationSensing: 'none',
        reason: 'near the decision boundary',
      };
    default:
      return {
        cadence: 'low',
        intervalMs: LAYOVER_REFRESH_INTERVAL_MS.low,
        locationSensing: 'none',
        reason: 'well before the deadline, or no rung stated',
      };
  }
}
