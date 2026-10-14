/**
 * activeLocation.types — the plain location value types shared by the app-root
 * location hook (`useActiveLocation.ts`) and the READ-ONLY location context
 * (`src/context/locationContextValue.ts`).
 *
 * WHY THESE LIVE IN THEIR OWN MODULE (census-layover L164, §70)
 * ============================================================
 * A screen that only READS the resolved location must be able to name these
 * types without importing the hook: the hook reaches the OS location prompt
 * through `services/location.ts`, and the L164 guard
 * (`src/lib/__tests__/layoverSensingCadence.test.ts`) walks TYPE imports as
 * well as value imports when it computes what the layover surface reaches.
 * `useActiveLocation.ts` re-exports all three unchanged, so every existing
 * type import of them from the hook still resolves. (No import specifier is
 * quoted in this comment: the guard reads raw text, and a quoted relative
 * specifier after the word "from" is an import edge to it.)
 *
 * TYPES ONLY. This file imports nothing and must keep importing nothing; the
 * guard pins that the read-only path reaches no location request API.
 */

export type LocationSource =
  | 'gps'          // legacy — kept for backward-compat with persisted API payloads
  | 'gps_fresh'    // a live fix this device took
  | 'gps_cached'   // fallback to the platform's last known fix
  | 'last_known'   // server-persisted location from a previous session
  | 'home'         // profile home city — lowest-priority fallback
  | 'manual_city'
  | 'trip_context'
  | 'post_tag'
  | 'none';
export type LocationFreshness = 'live' | 'recent' | 'stale' | 'unavailable';

export interface LocationCoords {
  lat: number;
  lng: number;
  accuracyMeters: number | null;
}
