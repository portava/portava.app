/**
 * The two transport helpers every Discovery feature service uses, shared with
 * the Trips features (`../../trips/shared/tripApi.ts`): a typed read that tells
 * `off` (feature_disabled) from `unavailable` from a shape it cannot read, and a
 * write that tells `done` from `refused` from `unavailable`. Neither ever turns
 * a failure into an empty answer. Re-exported under Discovery names so a
 * Discovery file does not read as if it belonged to Trips.
 */
export {
  readTripJson as readDiscoveryJson,
  sendTripWrite as sendDiscoveryWrite,
  writeFailureText,
  type ApiRead,
  type ApiWrite,
} from '../../trips/shared/tripApi.ts';
