/**
 * LayoverMapCard — the layover at a glance on the Discovery map: airport
 * element plus any plan stops that carry coordinates.
 *
 * ── SPEC §13, MAP ELEMENT "AIRPORT": *always visible; return CTA anchor* ─────
 * Census L123 said neither half held, and both are closed here.
 *
 * ALWAYS VISIBLE. The card used to `return null` when the airport had no
 * coordinates, or coordinates of exactly `(0, 0)` — which is what
 * `buildFallbackProfile` writes for every airport that is not in
 * `airport_profiles` (`lat: opts.lat ?? 0`). A traveller on a fallback airport
 * therefore got no map, no airport, and no explanation. There is no map WITHOUT
 * coordinates — a pin needs somewhere to be — but the airport ELEMENT does not
 * need a map to exist, so the card now always renders it and says, in place of
 * the map, that this airport has no coordinates yet. That is §2.1's "degrade
 * visibly", not a blank.
 *
 * RETURN CTA ANCHOR. Tapping the airport used to open the generic
 * `PlaceDetailSheet` — the same sheet a café gets, offering "add to plan" for
 * the airport the traveller must return to. It now opens the AIRPORT sheet:
 * the certified return deadline, how long is left, and the one-tap return. The
 * action is the screen's own `useSafeReturnAbort` controller, so this is a
 * second ENTRY POINT to the existing abort and not a second abort: the RETURN
 * CONTRACT it hands back is still rendered in exactly one place,
 * `LayoverSafeReturnCard`, which is what §13.4 required of any second control.
 * Stop pins are unchanged and still open `PlaceDetailSheet`.
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, View, Text, StyleSheet, Pressable } from 'react-native';
import { Clock, Map as MapIcon, Plane } from 'lucide-react-native';
import { DiscoveryMapView } from '../discovery/DiscoveryMapView';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { PlaceDetailSheet } from '../discovery/PlaceDetailSheet.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type { PlanStop, PublicAirport } from '../../services/layover.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';

/**
 * What the airport element needs in order to BE a return CTA anchor. Every
 * field is server-certified and passed down; nothing here re-derives a return
 * state from a clock.
 */
export interface AirportReturnAnchor {
  /** The certified hard return instant, ISO. */
  hardReturnTime: string;
  /** Minutes to it — negative once it has passed. */
  minutesToHardReturn: number | null;
  /** The certified §15 state, for the sheet's headline. */
  returnState: string | null;
  /** Only an ACTIVE session can be aborted. */
  canReturn: boolean;
  /** In flight — the control must not fire twice. */
  busy: boolean;
  /** The screen's one abort. */
  onReturnNow: () => void;
}

interface Props {
  airport: PublicAirport;
  stops: PlanStop[];
  /** Absent only where no return has been certified yet. */
  airportReturn?: AirportReturnAnchor;
}

function toPlace(partial: Partial<DiscoveryPlace> & { id: string; name: string; category: string }): DiscoveryPlace {
  return {
    type: null, description: null, distanceKm: null, lat: null, lng: null,
    tags: [], address: null, website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null,
    ...partial,
  };
}

export function LayoverMapCard({ airport, stops, airportReturn }: Props) {
  const hasAirportCoords =
    airport.lat != null && airport.lng != null && !(airport.lat === 0 && airport.lng === 0);
  const airportPlaceId = `airport-${airport.iataCode}`;

  // Place detail sheet — opened when the user taps a STOP pin.
  const [selectedPlace, setSelectedPlace] = useState<DiscoveryPlace | null>(null);
  const [placeSheetVisible, setPlaceSheetVisible] = useState(false);
  // The airport sheet — opened when the user taps the airport, wherever it is.
  const [airportSheetOpen, setAirportSheetOpen] = useState(false);

  const handleSelectPlace = (place: DiscoveryPlace) => {
    // The airport is not a place you add to a plan; it is the place you have to
    // be. Routing its tap to the generic sheet is the L123 defect.
    if (place.id === airportPlaceId) { setAirportSheetOpen(true); return; }
    setSelectedPlace(place);
    setPlaceSheetVisible(true);
  };

  const places = useMemo(() => {
    const list: DiscoveryPlace[] = [];
    if (hasAirportCoords) {
      list.push(toPlace({
        id: airportPlaceId,
        name: `${airport.iataCode} — ${airport.name}`,
        category: 'transport',
        lat: airport.lat, lng: airport.lng,
        address: airport.city,
      }));
    }
    for (const s of stops) {
      if (s.lat != null && s.lng != null && !s.insideAirport) {
        list.push(toPlace({
          id: `stop-${s.id}`,
          name: s.title,
          category: 'activity',
          lat: s.lat, lng: s.lng,
          address: s.locationLabel,
        }));
      }
    }
    return list;
  }, [airport, stops, hasAirportCoords, airportPlaceId]);

  const returnLabel = airportReturn
    ? (airportReturn.minutesToHardReturn != null && airportReturn.minutesToHardReturn > 0
        ? `${fmtDur(airportReturn.minutesToHardReturn)} left`
        : airportReturn.minutesToHardReturn != null
          ? `${fmtDur(Math.abs(airportReturn.minutesToHardReturn))} past your return time`
          : null)
    : null;

  return (
    <View style={styles.card} testID="layover-map-card">
      <View style={styles.headRow}>
        <MapIcon size={18} color={color.ink} />
        <Text style={styles.heading}>
          {airport.city && airport.city !== 'Unknown' ? `Around ${airport.city}` : `Around ${airport.iataCode}`}
        </Text>
      </View>

      {hasAirportCoords ? (
        <View style={styles.mapWrap}>
          <DiscoveryMapView
            places={places}
            onSelectPlace={handleSelectPlace}
            fallbackLat={airport.lat}
            fallbackLng={airport.lng}
            fallbackZoom={11}
          />
        </View>
      ) : (
        <View style={styles.noMap} testID="layover-map-no-coordinates">
          <Text style={styles.noMapText}>
            We don't have coordinates for {airport.iataCode} yet, so there is no map to draw.
            Your airport and your return time are below.
          </Text>
        </View>
      )}

      {/* The airport element. ALWAYS rendered — with a map it is also a pin, and
          without one this row is the whole of it. Either way it is the tap
          target the return CTA is anchored on. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${airport.iataCode} — return options`}
        testID="layover-map-airport"
        style={styles.airportRow}
        onPress={() => setAirportSheetOpen(true)}
      >
        <Plane size={15} color={color.signalDim} />
        <View style={{ flex: 1 }}>
          <Text style={styles.airportName} numberOfLines={1}>
            {airport.iataCode} — {airport.name}
          </Text>
          {airportReturn ? (
            <Text style={styles.airportSub} testID="layover-map-airport-deadline">
              Be back by {fmtClock(airportReturn.hardReturnTime, airport.timezone)}
              {returnLabel ? ` · ${returnLabel}` : ''}
            </Text>
          ) : null}
        </View>
      </Pressable>

      <Text style={styles.note}>Airport and any plan stops with a location.</Text>

      {/* The airport sheet — the return CTA, anchored on the airport element. */}
      {airportSheetOpen ? (
        <View style={styles.airportSheet} testID="layover-map-airport-sheet">
          <View style={styles.headRow}>
            <Clock size={14} color={color.mute} />
            <Text style={styles.sheetLabel}>
              {airportReturn?.returnState
                ? airportReturn.returnState.replace(/_/g, ' ')
                : 'Your return'}
            </Text>
          </View>
          {airportReturn ? (
            <>
              <Text style={styles.sheetTime} testID="layover-map-airport-sheet-time">
                {fmtClock(airportReturn.hardReturnTime, airport.timezone)}
              </Text>
              {returnLabel ? <Text style={styles.sheetSub}>{returnLabel}</Text> : null}
              {airportReturn.canReturn ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Return to airport now"
                  accessibilityState={{ disabled: airportReturn.busy }}
                  testID="layover-map-airport-return-btn"
                  style={[styles.sheetBtn, airportReturn.busy && styles.sheetBtnBusy]}
                  onPress={airportReturn.onReturnNow}
                  disabled={airportReturn.busy}
                >
                  {airportReturn.busy
                    ? <ActivityIndicator size="small" color={color.onInk} />
                    : <Text style={styles.sheetBtnText}>RETURN TO AIRPORT NOW</Text>}
                </Pressable>
              ) : (
                <Text style={styles.sheetSub} testID="layover-map-airport-inactive">
                  This layover is no longer active — there is nothing left to cancel.
                </Text>
              )}
              <Text style={styles.sheetFoot}>
                Cancelling shows what it changes in the Safe Return card above.
              </Text>
            </>
          ) : (
            <Text style={styles.sheetSub} testID="layover-map-airport-no-deadline">
              No return time has been certified for this layover yet.
            </Text>
          )}
          <Pressable
            testID="layover-map-airport-sheet-close"
            style={styles.sheetClose}
            onPress={() => setAirportSheetOpen(false)}
          >
            <Text style={styles.sheetCloseText}>Close</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Place detail sheet — shown when a STOP pin is tapped */}
      <PlaceDetailSheet
        place={selectedPlace}
        visible={placeSheetVisible}
        onClose={() => setPlaceSheetVisible(false)}
        onAddToPlan={() => setPlaceSheetVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card:    { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading: { ...t.heading, color: color.ink },
  mapWrap: { height: 220, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.haze },
  noMap:   { borderRadius: radius.md, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, padding: space.md },
  noMapText: { ...t.small, color: color.mute },
  airportRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: 'rgba(255,77,46,0.08)', borderRadius: radius.md, padding: space.md },
  airportName: { ...t.bodyStrong, color: color.ink },
  airportSub:  { ...t.small, color: color.mute, marginTop: 2 },
  airportSheet: { borderRadius: radius.md, borderWidth: 1, borderColor: color.signalDim, backgroundColor: color.paper, padding: space.md, gap: 6 },
  sheetLabel: { ...t.stamp, color: color.mute },
  sheetTime:  { ...t.heading, color: color.ink },
  sheetSub:   { ...t.small, color: color.mute },
  sheetFoot:  { ...t.small, color: color.faint },
  sheetBtn:   { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center', marginTop: 4 },
  sheetBtnBusy: { opacity: 0.7 },
  sheetBtnText: { ...t.bodyStrong, color: color.onInk, letterSpacing: 0.5 },
  sheetClose: { alignSelf: 'flex-start', paddingVertical: space.sm },
  sheetCloseText: { ...t.small, color: color.mute, textDecorationLine: 'underline' },
  note:    { ...t.small, color: color.faint },
});
