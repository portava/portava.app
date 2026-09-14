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
 * ── SPEC §13, THE ELEMENTS THAT HAD NO PRODUCER (census L116/L117/L119/L121/
 * L122/L125/L126) ──────────────────────────────────────────────────────────
 * Six rows, and the reason all six read `N` was the same one: the SERVER had
 * already published the answer and no client type had a field for it. The
 * certified envelope has been on `GET /overview` as `safeEnvelope` since
 * census L63, and `offlineBundle.certifiedAt` / `staleAfter` since the
 * degraded-mode pass. This card now consumes both, and CONSUMES is the exact
 * word — L115 forbids the map recalculating feasibility, so every band here
 * arrives on a prop and nothing in this file measures a distance.
 *
 *  SAFE ENVELOPE (L121, L116). Drawn to scale as its own diagram beside the
 *  map, with BOTH edges: the PROVED edge, outside which nothing fits at any
 *  speed, and the CONTRACTED planning edge left after the confidence haircut.
 *  It is a diagram and not a basemap overlay because `DiscoveryMapView` takes
 *  places and a camera and nothing else — a circle absolutely positioned over
 *  a camera this card does not control would claim a registration it does not
 *  have. It CONTRACTS: the drawn diameter is the server's metres at a fixed,
 *  printed scale, so a window eaten by a delayed inbound is a visibly smaller
 *  ring, not just a smaller number.
 *
 *  CANDIDATE PIN (L122, L117). Each stop pin takes its band from the
 *  RECOMMENDATION CONTRACT, joined on `recommendationId`. A `BLOCKED` pin is
 *  kept off the map AND listed with its reason — L117 offers "hidden or
 *  visibly blocked" and doing only the first leaves a traveller wondering
 *  where their stop went. A pin nobody banded says so rather than borrowing a
 *  neighbour's band.
 *
 *  BLOCKED AREA (L125). The reason is the server's own prose, which states the
 *  distance and the round-trip bound against the usable window. Nothing here
 *  ever renders a band as "safe": no band this tree emits certifies a fit
 *  (`impliesFit` is false for all of them), and the inward caveat says so.
 *
 *  ROUTE (L119). There is no routed provider, so no line is drawn and none is
 *  implied. What is guaranteed is the half the requirement is actually about:
 *  the route ALWAYS ends with the return leg and the return deadline, whether
 *  the plan has two stops or none, and when no return has been certified the
 *  leg is still drawn and says the deadline is missing.
 *
 *  OFFLINE STATE (L126). The last-certified instant and a stale badge once
 *  `staleAfter` has passed, both from the server's own bundle.
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
import { AlertTriangle, Clock, Map as MapIcon, Plane } from 'lucide-react-native';
import { DiscoveryMapView } from '../discovery/DiscoveryMapView';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { PlaceDetailSheet } from '../discovery/PlaceDetailSheet.tsx';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import type {
  CandidateFeasibility,
  LayoverSafeEnvelope,
  PlanStop,
  PublicAirport,
} from '../../services/layover.ts';
import { fmtClock, fmtDur } from './layoverFormat.ts';
// §16 — the ONE staleness rule on this client, mirroring the server's own
// (`LayoverDegradedService.bundleFreshness`) including the `>=` boundary and
// the fail-closed `known: false`. A second rule here (`Date.parse(staleAfter)
// <= now`) answers FRESH for an unparseable instant, because `NaN <= now` is
// false — wrong in the direction that shows an undateable deadline as live.
import { bundleFreshness } from './layoverReturnFacts.ts';

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
  /**
   * §8/§13 — the certified envelope geometry, straight off `GET /overview`.
   * `null`/absent for an airport with no usable coordinate, which is rendered
   * as an explicit "no envelope" state and never as an unbounded one.
   */
  envelope?: LayoverSafeEnvelope | null;
  /**
   * §13 L122 — the feasibility state per RECOMMENDATION id, from the
   * recommendation contract. A stop is joined to it by `recommendationId`;
   * a stop a traveller typed in themselves has no entry and is rendered as
   * unmeasured rather than as unblocked.
   */
  candidateFeasibility?: Record<string, CandidateFeasibility> | null;
  /**
   * §16/§13 L126 — the certification instants off `overview.offlineBundle`.
   * Deliberately the bundle's own field names and types, so the card can hand
   * it straight to `bundleFreshness` rather than re-shaping (and re-deciding)
   * what "stale" means.
   */
  offline?: { certifiedAt: string; staleAfter: string } | null;
  /** Injected so the stale badge is testable without a fake clock. */
  nowMs?: number;
}

// ── The envelope diagram's scale ─────────────────────────────────────────────
//
// FIXED metres-per-pixel, not fit-to-content, and that is the whole of L121's
// "contracts as conditions worsen": at a fitted scale every envelope draws the
// same size and only the label changes, which is a picture that never moves
// while the thing it depicts halves. The scale is printed on the diagram so the
// drawing is checkable, and an envelope too large for the box is reported as
// off-scale rather than silently clamped into a lie.
const ENVELOPE_PLOT_PX = 128;
const ENVELOPE_METRES_PER_PX = 1000; // 128 px across ⇒ a 64 km radius fills the box

/**
 * The metres-per-pixel this render actually used.
 *
 * Normally the constant above — so an envelope that halves is a ring that
 * halves. An envelope too large for the box is COMPRESSED PROPORTIONALLY and
 * the new scale is printed, rather than clamped at the box edge. The first
 * draft clamped, and a 40 km proved edge and a 30 km planning edge both came
 * out at 128 px: two different distances, one drawing, with the inner edge
 * shown as far out as the outer one. The test that compares the two ring widths
 * is what found it.
 */
function envelopeMetresPerPx(radiusMetres: number): number {
  const naturalPx = (2 * radiusMetres) / ENVELOPE_METRES_PER_PX;
  if (naturalPx <= ENVELOPE_PLOT_PX) return ENVELOPE_METRES_PER_PX;
  return (2 * radiusMetres) / ENVELOPE_PLOT_PX;
}

/** Diameter in px for a radius, at the scale this render is using. */
function ringPx(metres: number, metresPerPx: number): number {
  return Math.max(3, Math.round((2 * metres) / metresPerPx));
}

function km(metres: number): string {
  return metres >= 10_000
    ? `${Math.round(metres / 1000)} km`
    : `${Math.round(metres / 100) / 10} km`;
}

/**
 * The feasibility a PIN renders, for a stop that may or may not have come from
 * a recommendation. Never measures anything: an absent entry is the explicit
 * unmeasured state, which is a different thing from an unblocked one.
 */
function pinFeasibility(
  stop: PlanStop,
  byRecId: Record<string, CandidateFeasibility> | null | undefined,
): CandidateFeasibility | null {
  if (!stop.recommendationId || !byRecId) return null;
  return byRecId[stop.recommendationId] ?? null;
}

function toPlace(partial: Partial<DiscoveryPlace> & { id: string; name: string; category: string }): DiscoveryPlace {
  return {
    type: null, description: null, distanceKm: null, lat: null, lng: null,
    tags: [], address: null, website: null, phone: null, openingHours: null,
    rating: null, isOpenNow: null,
    ...partial,
  };
}

export function LayoverMapCard({
  airport, stops, airportReturn, envelope, candidateFeasibility, offline, nowMs,
}: Props) {
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

  // §13 L117 — the partition, done ONCE so the map, the blocked list and the
  // route strip cannot disagree about which stop is which. `blocked` is the
  // band the server proved; everything else stands.
  const banded = useMemo(
    () => stops.map((s) => ({ stop: s, feasibility: pinFeasibility(s, candidateFeasibility) })),
    [stops, candidateFeasibility],
  );
  const blockedStops = useMemo(
    () => banded.filter((b) => b.feasibility?.band === 'BLOCKED'),
    [banded],
  );
  const blockedIds = useMemo(
    () => new Set(blockedStops.map((b) => b.stop.id)),
    [blockedStops],
  );

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
      // A pin the certified envelope proved unreachable is NOT drawn. It is not
      // silently dropped either — it is listed below with the server's reason.
      if (blockedIds.has(s.id)) continue;
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
  }, [airport, stops, hasAirportCoords, airportPlaceId, blockedIds]);

  // The scale THIS render draws at. Derived from the proved edge so both rings
  // share one scale and their ratio is the certified one.
  const envelopeScale = envelope ? envelopeMetresPerPx(envelope.radiusMetres) : ENVELOPE_METRES_PER_PX;
  // §16 L126 — asked, never derived here. `known: false` (an instant that does
  // not parse) comes back STALE, which is the fail-closed answer.
  const freshness = offline ? bundleFreshness(offline, nowMs ?? Date.now()) : null;

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

      {/* ── §13 SAFE ENVELOPE (L121, L116) ───────────────────────────────
          Two edges, drawn to a printed scale. The server certified both; this
          card only sizes them. */}
      {envelope ? (
        <View style={styles.envelope} testID="layover-map-safe-envelope">
          <Text style={styles.sheetLabel}>SAFE ENVELOPE</Text>
          <View style={styles.envelopeRow}>
            <View style={styles.envelopePlot}>
              <View
                testID="layover-map-envelope-proved-ring"
                style={[
                  styles.ringProved,
                  {
                    width: ringPx(envelope.radiusMetres, envelopeScale),
                    height: ringPx(envelope.radiusMetres, envelopeScale),
                    borderRadius: ringPx(envelope.radiusMetres, envelopeScale) / 2,
                  },
                ]}
              />
              <View
                testID="layover-map-envelope-planned-ring"
                style={[
                  styles.ringPlanned,
                  {
                    width: ringPx(envelope.plannedRadiusMetres, envelopeScale),
                    height: ringPx(envelope.plannedRadiusMetres, envelopeScale),
                    borderRadius: ringPx(envelope.plannedRadiusMetres, envelopeScale) / 2,
                  },
                ]}
              />
              <View style={styles.ringCentre} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.envelopeProved} testID="layover-map-envelope-proved-label">
                {'Proved edge '}{km(envelope.radiusMetres)}
              </Text>
              <Text style={styles.envelopeSub}>
                Past it, {envelope.maxOneWayMinutes * 2} min there and back is already more than your{' '}
                {envelope.usableMinutes} usable minutes — at any speed.
              </Text>
              <Text style={styles.envelopePlanned} testID="layover-map-envelope-planned-label">
                {'We plan inside '}{km(envelope.plannedRadiusMetres)}
              </Text>
              <Text style={styles.envelopeSub}>
                {envelope.uncertaintyBudgetMinutes} min of the {envelope.usableMinutes} are held back
                {envelope.confidence ? ` on ${envelope.confidence} confidence` : ''}.
              </Text>
            </View>
          </View>
          <Text style={styles.envelopeScale} testID="layover-map-envelope-scale">
            Diagram to scale — {km(envelopeScale * 10)} per 10 px
            {envelopeScale !== ENVELOPE_METRES_PER_PX ? ' (compressed to fit)' : ''}.
          </Text>
          {/* L125 / L122 — the inward edge is NOT a certification, and saying so
              is the difference between a map and a promise. */}
          <Text style={styles.envelopeCaveat} testID="layover-map-envelope-inward-caveat">
            Inside the ring is not a guarantee. Nobody has measured a route here, so
            this shows where you certainly cannot get back from — not where you certainly can.
          </Text>
          {offline?.certifiedAt ? (
            <Text style={styles.envelopeSub} testID="layover-map-envelope-certified-at">
              Last certified {freshness?.known
                ? fmtClock(offline.certifiedAt, airport.timezone)
                : 'at an instant we could not read'}
            </Text>
          ) : null}
          {freshness?.stale ? (
            <View style={styles.staleBadge} testID="layover-map-envelope-stale">
              <AlertTriangle size={12} color={color.ink} />
              <Text style={styles.staleText}>
                {freshness.known
                  ? `STALE — last certified ${freshness.ageMinutes} min ago; this is the last envelope we could cut, not a live one.`
                  : 'STALE — we cannot tell how old this envelope is, so it is not a live one.'}
              </Text>
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.envelope} testID="layover-map-envelope-unavailable">
          <Text style={styles.envelopeSub}>
            No safe envelope has been certified for this layover, so nothing on this map is
            marked reachable or blocked.
          </Text>
        </View>
      )}

      {/* ── §13 CANDIDATE PIN BANDS (L122) and BLOCKED AREAS (L117, L125) ── */}
      {banded.length > 0 ? (
        <View style={styles.bands}>
          {banded.map(({ stop: st, feasibility }) => {
            const isBlocked = feasibility?.band === 'BLOCKED';
            return (
              <View
                key={st.id}
                testID={isBlocked ? `layover-map-blocked-${st.id}` : `layover-map-pin-band-${st.id}`}
                style={[styles.bandRow, isBlocked && styles.bandRowBlocked]}
              >
                <Text style={styles.bandTitle} numberOfLines={1}>{st.title}</Text>
                <Text style={styles.bandBody}>
                  {isBlocked
                    ? (feasibility?.reason
                        ?? 'This is outside your certified safe envelope, so it is not on the map.')
                    : feasibility?.withinPlannedEdge === false
                      ? (feasibility.plannedEdgeReason
                          ?? 'Beyond the edge we would plan on at this confidence.')
                      : feasibility?.certified
                        ? `At least ${feasibility.lowerBoundOneWayMin} min each way — inside the edge we plan on, which is not a promise it fits.`
                        : (feasibility?.reason
                            ?? 'This stop has not been measured against your safe envelope.')}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {/* ── §13 PRIMARY ROUTE (L119) ────────────────────────────────────────
          No line is drawn — there is no routed provider and inventing one is
          census L293's defect. What the requirement is actually about is the
          LAST leg, and it is unconditional: the return is always in the route
          and always carries the deadline. */}
      <View style={styles.route} testID="layover-map-route">
        <Text style={styles.sheetLabel}>YOUR ROUTE</Text>
        {stops
          .filter((st) => !st.insideAirport)
          .map((st, i) => (
            <Text key={st.id} style={styles.routeLeg} testID={`layover-map-route-leg-${st.id}`}>
              {i + 1}. {st.title}
              {blockedIds.has(st.id) ? ' — blocked, not on the map' : ''}
            </Text>
          ))}
        <View style={styles.routeReturn} testID="layover-map-route-return-leg">
          <Plane size={13} color={color.signalDim} />
          {airportReturn ? (
            <Text style={styles.routeReturnText} testID="layover-map-route-return-deadline">
              Back at {airport.iataCode} by {fmtClock(airportReturn.hardReturnTime, airport.timezone)}
              {returnLabel ? ` · ${returnLabel}` : ''}
            </Text>
          ) : (
            <Text style={styles.routeReturnText} testID="layover-map-route-return-uncertified">
              Back at {airport.iataCode} — no return deadline has been certified yet.
            </Text>
          )}
        </View>
      </View>

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
  envelope: { borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper, padding: space.md, gap: 6 },
  envelopeRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  envelopePlot: { width: ENVELOPE_PLOT_PX, height: ENVELOPE_PLOT_PX, alignItems: 'center', justifyContent: 'center' },
  ringProved:  { position: 'absolute', borderWidth: 1, borderColor: color.signalDim, borderStyle: 'dashed' },
  ringPlanned: { position: 'absolute', borderWidth: 1.5, borderColor: color.signal, backgroundColor: 'rgba(255,77,46,0.08)' },
  ringCentre:  { width: 7, height: 7, borderRadius: 4, backgroundColor: color.ink },
  envelopeProved:  { ...t.bodyStrong, color: color.ink },
  envelopePlanned: { ...t.bodyStrong, color: color.signal },
  envelopeSub:     { ...t.small, color: color.mute },
  envelopeScale:   { ...t.small, color: color.faint },
  envelopeCaveat:  { ...t.small, color: color.mute },
  staleBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.haze, borderRadius: radius.sm, paddingVertical: 4, paddingHorizontal: space.sm },
  staleText:  { ...t.small, color: color.ink },
  bands:      { gap: 6 },
  bandRow:    { borderRadius: radius.sm, borderWidth: 1, borderColor: color.haze, padding: space.sm, gap: 2 },
  bandRowBlocked: { borderColor: color.signalDim, backgroundColor: 'rgba(255,77,46,0.06)' },
  bandTitle:  { ...t.bodyStrong, color: color.ink },
  bandBody:   { ...t.small, color: color.mute },
  route:      { borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, gap: 4 },
  routeLeg:   { ...t.small, color: color.ink },
  routeReturn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 2 },
  routeReturnText: { ...t.bodyStrong, color: color.ink, flex: 1 },
});
