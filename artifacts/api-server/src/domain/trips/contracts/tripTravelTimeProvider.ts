/**
 * THE provider the Trips seams bind (routes/tripFeasibility.ts,
 * domain/trips/projections/TripFreedomProjection.ts,
 * domain/trips/projections/TripRouteChainProjection.ts).
 *
 * Wiring it is the reviewed code change GoogleRoutesTravelTimeProvider.ts asked
 * for, made after the owner's decision of 2026-10-04. It costs nothing until
 * the owner configures it: with `trip_routes_api_enabled` off (its seed), or any
 * of the quota / budget / price / key unset, every estimate is the
 * straight-line bound it was before, plus a `routes-api-fallback:off` source
 * reference saying why.
 */
import { getServiceClient } from "../../../lib/supabase.js";
import { straightLineTravelTimeProvider, type TravelTimeProvider } from "./TravelTimeProvider.js";
import { createGoogleRoutesTravelTimeProvider } from "./GoogleRoutesTravelTimeProvider.js";
import { createGatedRoutedTravelTimeProvider } from "./GatedRoutedTravelTimeProvider.js";
import { dbRoutesSpendGate } from "./RoutesSpendGate.js";

export const TRIP_TRAVEL_TIME_PROVIDER: TravelTimeProvider = createGatedRoutedTravelTimeProvider({
  routed: createGoogleRoutesTravelTimeProvider(),
  fallback: straightLineTravelTimeProvider,
  gate: dbRoutesSpendGate({ client: () => getServiceClient() }),
});
