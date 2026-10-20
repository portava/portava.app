/**
 * locationRequestDoor — the ONE way a surface reachable from Layover asks the
 * phone for a location fix (census-layover L164, §70).
 *
 * L164: "Location: request when enabling live return assistance / map context,
 * not solely because Layover exists." A request is the OS permission prompt
 * plus a fresh fix — the GPS function of `services/location.ts`. On the
 * layover surface's import graph that function is reachable through this
 * module and nowhere else, and this module is called only from controls the
 * user presses. Both halves are enforced by the guard in
 * `src/lib/__tests__/layoverSensingCadence.test.ts`, over the whole graph
 * (its name is written in this file exactly twice — the import and the one
 * call below — and the guard counts them):
 *
 *   - `services/location.ts` may be imported, on that graph, only by this file;
 *   - this file may be imported only by the callers that guard enumerates, and
 *     each may call it only inside the press handler it names.
 *
 * WHAT THE ARGUMENT IS FOR. The request names WHY it is made and THAT a person
 * pressed something. The type makes an unattributed call unwritable, and the
 * runtime check below refuses one that slips past the type (a JS caller, an
 * `as never`): it returns the same refusal shape the GPS function returns for
 * a denied permission, without asking the OS anything. It cannot prove a press
 * happened — the guard's enumeration of call sites is what does that.
 *
 * Behaviour on an accepted request is exactly the GPS function's: same
 * prompt, same timeout, same last-known fallback, same result object. The
 * place picker's "Use my current location" row is the one caller today, and
 * routing it through here changes nothing a user can see.
 */
import { getCurrentGps } from '../../services/location.ts';
import type { GpsResult } from '../../services/location.ts';

/**
 * Why a location fix is being requested. `map_context` is L164's "map
 * context": the user asked to place something (a stop, a search, a pin) where
 * they are. `live_return_assistance` is L157's sampler, which the traveller
 * turns on with a press; its card is on the guard's caller list too.
 */
export type LocationRequestPurpose = 'map_context' | 'live_return_assistance'; /* census L157 (LAYOVER 165, lane B2-CREW): L164's 'live return assistance', built — the traveller turns it on with a press */

export const LOCATION_REQUEST_PURPOSES: readonly LocationRequestPurpose[] = ['map_context', 'live_return_assistance'];

/** A location request a person started by pressing a labelled control. */
export interface UserLocationRequest {
  readonly trigger: 'user_press';
  readonly purpose: LocationRequestPurpose;
}

/** The request the place picker's "Use my current location" row makes. */
export const USER_PRESS_MAP_CONTEXT: UserLocationRequest = Object.freeze({
  trigger: 'user_press',
  purpose: 'map_context',
});

/** True only for a request that names a press and a known purpose. */
export function isUserLocationRequest(request: unknown): request is UserLocationRequest {
  if (typeof request !== 'object' || request === null) return false;
  const r = request as { trigger?: unknown; purpose?: unknown };
  return r.trigger === 'user_press'
    && (LOCATION_REQUEST_PURPOSES as readonly unknown[]).includes(r.purpose);
}

/** The refusal an unattributed request gets. Nothing was asked of the OS. */
export const NO_USER_ACTION_RESULT: Readonly<GpsResult> = Object.freeze({
  granted: false,
  lat: null,
  lng: null,
  accuracyMeters: null,
  error: 'no_user_action',
});

/**
 * Ask for a location fix because the user pressed a control that says so.
 * Anything else is refused before the OS is touched.
 */
export async function requestLocationForUserAction(request: UserLocationRequest): Promise<GpsResult> {
  if (!isUserLocationRequest(request)) return { ...NO_USER_ACTION_RESULT };
  return getCurrentGps();
}

/**
 * The request the "Turn on live return assistance" control makes (census L157, LAYOVER 165 lane B2-CREW): L164's
 * "request when enabling live return assistance". The one prompt; every later fix is taken WITHOUT asking, by
 * `layoverLiveReturnSampler`, and only while the permission this granted still stands.
 */
export const USER_PRESS_LIVE_RETURN: UserLocationRequest = Object.freeze({
  trigger: 'user_press',
  purpose: 'live_return_assistance',
});
