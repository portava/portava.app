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

// ─────────────────────────────────────────────────────────────────────────────
// §16 L157 — ADAPTIVE LOCATION SENSING for live return assistance
// (LAYOVER 165, lane B2-CREW; appended so no cited line above moves)
// ─────────────────────────────────────────────────────────────────────────────
//
// "Battery strategy should use adaptive sensing: low frequency when safe/stationary, moderate near decision
// boundaries, and navigation-appropriate updates during RETURNING. Avoid continuous GPS when semantic checkpoints or
// significant-location changes are sufficient." (spec §16)
//
// `layoverSensingCadence` above is the OVERVIEW poll and still senses nothing (`locationSensing: 'none'`). This is the
// LOCATION half, and it senses only inside the L164 boundary: after the traveller turned LIVE RETURN ASSISTANCE on
// with a press (the one prompt, through `locationRequestDoor`), with the permission already GRANTED, while the app is
// in the FOREGROUND, on a LIVE layover. Every other case is `off`.
//
// THE RUNG IS STILL THE SERVER'S: the certified `returnState` (and the session's `returning` status after a one-tap
// abort) picks the band; nothing here re-derives a deadline. Within a band: a STATIONARY traveller (the last two fixes
// within `LAYOVER_STATIONARY_METERS`) is sampled less often, and a phone in LOW POWER MODE or at/under
// `LAYOVER_LOW_BATTERY` is sampled less often and less precisely. NEVER CONTINUOUS: every decision is a one-shot fix on
// a timer of at least `LAYOVER_MIN_SAMPLE_MS` — there is no watch, no background task, no significant-change service.
//
// BATTERY: useLayoverPowerState reads Expo Battery on the opted-in, foreground live-return path, subscribes to power
// changes, and refreshes after every sample. The module's -1 battery sentinel becomes null (UNKNOWN); unsupported
// devices and older native binaries remain unknown. Low battery or low-power mode lowers cadence and accuracy.
// A native build including expo-battery is required for installed apps; actual permission, battery and GPS behavior
// still require device validation. No device validation is claimed by the component or policy tests.

export type LiveSensingMode = 'off' | 'low' | 'moderate' | 'navigation';
export type LiveSensingAccuracy = 'low' | 'balanced' | 'high';

/** No sample is ever closer than this to the previous one: there is no continuous mode. */
export const LAYOVER_MIN_SAMPLE_MS = 30_000;
/** Two fixes closer than this are "stationary". */
export const LAYOVER_STATIONARY_METERS = 100;
/** At or under this battery fraction the phone is treated as low on power. */
export const LAYOVER_LOW_BATTERY = 0.2;

export const LAYOVER_SENSING_BANDS = {
  /** Well before the deadline, moving. */
  low: { intervalMs: 10 * 60_000, accuracy: 'low' },
  /** Well before the deadline, not moving. */
  lowStationary: { intervalMs: 20 * 60_000, accuracy: 'low' },
  /** Near the decision boundary (RETURN_SOON). */
  moderate: { intervalMs: 3 * 60_000, accuracy: 'balanced' },
  /** Heading back (RETURN_NOW / CONNECTION_AT_RISK / a session marked returning). */
  navigation: { intervalMs: 30_000, accuracy: 'high' },
} as const satisfies Record<string, { intervalMs: number; accuracy: LiveSensingAccuracy }>;

export interface LiveSensingInput {
  /** The traveller turned live return assistance on, with a press. */
  enabled: boolean;
  /** The OS permission as last READ (never asked for here). */
  permission: 'granted' | 'denied' | 'undetermined';
  sessionStatus: string | null | undefined;
  returnState: LayoverReturnState | null | undefined;
  /** The last two fixes were within LAYOVER_STATIONARY_METERS; null = unknown (fewer than two fixes). */
  stationary: boolean | null;
  power: { lowPowerMode: boolean | null; batteryLevel: number | null };
  /** The app is in the foreground. */
  appActive: boolean;
}

export interface LiveSensingDecision {
  mode: LiveSensingMode;
  /** Milliseconds until the next one-shot fix; null = take none. */
  intervalMs: number | null;
  accuracy: LiveSensingAccuracy | null;
  /** Always false: this module has no continuous mode. A literal type, so a caller cannot ask for one. */
  continuous: false;
  /** Why, in one phrase. For diagnostics and the card's own line. */
  reason: string;
}

function lowPower(p: LiveSensingInput['power']): boolean {
  return p.lowPowerMode === true || (typeof p.batteryLevel === 'number' && p.batteryLevel >= 0 && p.batteryLevel <= LAYOVER_LOW_BATTERY);
}

export function layoverLiveSensing(input: LiveSensingInput): LiveSensingDecision {
  const off = (reason: string): LiveSensingDecision => ({ mode: 'off', intervalMs: null, accuracy: null, continuous: false, reason });
  if (!input.enabled) return off('live return assistance is off — nothing is sensed');
  if (input.permission !== 'granted') return off('location permission is not granted — nothing is asked from here');
  if (input.sessionStatus !== 'active' && input.sessionStatus !== 'returning') return off('the layover is not live');
  if (!input.appActive) return off('the app is in the background — foreground only');
  const saving = lowPower(input.power);
  const at = (mode: LiveSensingMode, band: { intervalMs: number; accuracy: LiveSensingAccuracy }, reason: string): LiveSensingDecision => ({
    mode,
    intervalMs: Math.max(LAYOVER_MIN_SAMPLE_MS, saving ? band.intervalMs * 2 : band.intervalMs),
    accuracy: saving ? (band.accuracy === 'high' ? 'balanced' : 'low') : band.accuracy,
    continuous: false,
    reason: saving ? `${reason}; low power — less often, less precise` : reason,
  });
  if (input.sessionStatus === 'returning' || input.returnState === 'RETURN_NOW' || input.returnState === 'CONNECTION_AT_RISK') {
    return at('navigation', LAYOVER_SENSING_BANDS.navigation, 'heading back — navigation-appropriate updates');
  }
  if (input.returnState === 'RETURN_SOON') return at('moderate', LAYOVER_SENSING_BANDS.moderate, 'near the decision boundary');
  if (input.stationary === true) return at('low', LAYOVER_SENSING_BANDS.lowStationary, 'well before the deadline and not moving');
  return at('low', LAYOVER_SENSING_BANDS.low, 'well before the deadline');
}

/** Great-circle metres between two fixes. Local only: a fix never leaves the phone. */
export function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
