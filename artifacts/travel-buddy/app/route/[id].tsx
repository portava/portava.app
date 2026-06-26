/**
 * Active Route Screen — app/route/[id].tsx
 *
 * Full-screen route view:
 *  - RouteMinimapView at top (tapping expand opens full-screen RouteFullMapModal)
 *  - Scrollable leg cards (from → to, estimated walk time, distance, mode chip)
 *  - Checkpoint status pills per stop
 *  - "Start route" / "Arrived" / "Skip stop" / "End session" action bar
 *  - Compass explanation (collapsible "Why this order?" card)
 *  - Safe Return integration (pre-fill return time)
 *  - Final-stop distance-to-end-location warning (> 1.5 km)
 *  - GPS auto-checkpoint driven by useActiveLocation coords (reactive, no poll loop)
 *  - Manual fallback if GPS is denied
 *  - Group member progress (trip-linked routes)
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, Pressable, Modal, StyleSheet,
  ActivityIndicator, Alert, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import RNMapView, { Marker, Polyline, Circle } from 'react-native-maps';
import {
  Route, CheckCircle, SkipForward, StopCircle, ChevronDown, ChevronUp,
  MapPin, Shield, Compass, Maximize2, Minimize2, Users, AlertTriangle,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { useRoutePlan } from '../../src/hooks/useRoutePlan';
import { useRouteCheckpointMonitor } from '../../src/hooks/useRouteCheckpointMonitor';
import { RouteMinimapView } from '../../src/components/RouteMinimapView';
import { SafeReturnSetupSheet } from '../../src/components/safeReturn/SafeReturnSetupSheet';
import { useActiveLocation } from '../../src/hooks/useActiveLocation';
import type { RouteStop, RouteLeg } from '../../src/services/routePlan';

// ── Constants ─────────────────────────────────────────────────────────────────

const FINAL_STOP_WARN_THRESHOLD = 1_500; // metres

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<string, string> = {
  walk:      '🚶 Walk',
  rideshare: '🚗 Rideshare',
  transit:   '🚌 Transit',
  bike:      '🚴 Bike',
  drive:     '🚙 Drive',
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `~${m} min`;
  const h   = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `~${h}h ${rem}m` : `~${h}h`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R     = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLng  = toRad(lng2 - lng1);
  const a     =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Full-screen map modal ─────────────────────────────────────────────────────

interface FullMapModalProps {
  visible: boolean;
  onClose: () => void;
  stops: RouteStop[];
  legs: RouteLeg[];
  userLat?: number | null;
  userLng?: number | null;
}

function computeRegionFromStops(stops: RouteStop[]) {
  const pts = stops
    .map((s) => ({ lat: s.structuredLocation?.lat, lng: s.structuredLocation?.lng }))
    .filter((p): p is { lat: number; lng: number } => p.lat != null && p.lng != null);
  if (pts.length === 0) return null;
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  return {
    latitude:      (minLat + maxLat) / 2,
    longitude:     (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.5, 0.015),
    longitudeDelta: Math.max((maxLng - minLng) * 1.5, 0.015),
  };
}

function RouteFullMapModal({ visible, onClose, stops, legs: _legs, userLat, userLng }: FullMapModalProps) {
  void _legs;
  const region = computeRegionFromStops(stops);
  const nextStopId = stops.find((s) => s.checkpointStatus === 'pending')?.id ?? null;

  const polylineCoords = stops
    .filter((s) => s.structuredLocation?.lat != null && s.structuredLocation?.lng != null)
    .map((s) => ({ latitude: s.structuredLocation.lat, longitude: s.structuredLocation.lng }));

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {region ? (
          <RNMapView
            style={{ flex: 1 }}
            initialRegion={region}
            showsUserLocation={false}
            showsMyLocationButton={false}
            showsCompass
            toolbarEnabled={false}
          >
            {polylineCoords.length >= 2 && (
              <Polyline
                coordinates={polylineCoords}
                strokeColor={color.deep}
                strokeWidth={3}
                lineDashPattern={[8, 4]}
              />
            )}
            {stops.map((stop, idx) => {
              const loc = stop.structuredLocation;
              if (!loc?.lat || !loc?.lng) return null;
              const isNext   = stop.id === nextStopId;
              const isDone   = stop.checkpointStatus === 'arrived';
              const isSkipped = stop.checkpointStatus === 'skipped';
              return (
                <Marker key={stop.id} coordinate={{ latitude: loc.lat, longitude: loc.lng }} anchor={{ x: 0.5, y: 0.5 }}>
                  <View style={[
                    fmStyles.pin,
                    isDone && fmStyles.pinDone,
                    isSkipped && fmStyles.pinSkipped,
                    isNext && fmStyles.pinNext,
                  ]}>
                    <Text style={fmStyles.pinLabel}>{idx + 1}</Text>
                  </View>
                </Marker>
              );
            })}
            {userLat != null && userLng != null && (
              <Circle
                center={{ latitude: userLat, longitude: userLng }}
                radius={15}
                fillColor={color.deep + 'CC'}
                strokeColor={color.deep}
                strokeWidth={2}
              />
            )}
          </RNMapView>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff' }}>No location data</Text>
          </View>
        )}

        {/* Close button */}
        <Pressable style={fmStyles.closeBtn} onPress={onClose} hitSlop={12}>
          <Minimize2 size={18} color={color.ink} />
          <Text style={fmStyles.closeBtnText}>Close map</Text>
        </Pressable>

        {/* Legend */}
        <View style={fmStyles.legend}>
          {stops.map((s, idx) => (
            <View key={s.id} style={fmStyles.legendRow}>
              <View style={[fmStyles.legendDot, s.checkpointStatus === 'arrived' && fmStyles.legendDotDone, s.id === nextStopId && fmStyles.legendDotNext]}>
                <Text style={fmStyles.legendDotLabel}>{idx + 1}</Text>
              </View>
              <Text style={fmStyles.legendTitle} numberOfLines={1}>{s.title}</Text>
            </View>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const fmStyles = StyleSheet.create({
  pin: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#E76F51', alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: '#fff',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
    elevation: 4,
  },
  pinDone:    { backgroundColor: '#999', borderColor: '#ddd' },
  pinSkipped: { backgroundColor: '#ccc', borderColor: '#eee' },
  pinNext:    { backgroundColor: color.deep, borderColor: '#fff', shadowColor: color.deep, shadowOpacity: 0.5, shadowRadius: 6, elevation: 6 },
  pinLabel: { color: '#fff', fontSize: 12, fontWeight: '700' },
  closeBtn: {
    position: 'absolute', top: 54, right: 16,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, elevation: 4,
  },
  closeBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  legend: {
    position: 'absolute', bottom: 40, left: 16,
    backgroundColor: 'rgba(255,255,255,0.95)', borderRadius: radius.md,
    paddingVertical: space.sm, paddingHorizontal: space.md,
    maxHeight: 200,
    shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 4, elevation: 4,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 3 },
  legendDot: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#E76F51', alignItems: 'center', justifyContent: 'center',
  },
  legendDotDone: { backgroundColor: '#999' },
  legendDotNext: { backgroundColor: color.deep },
  legendDotLabel: { color: '#fff', fontSize: 10, fontWeight: '700' },
  legendTitle: { ...t.small, color: color.ink, fontSize: 12, maxWidth: 140 },
});

// ── Component ─────────────────────────────────────────────────────────────────

export default function ActiveRouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const {
    plan: fullPlan, loading, error,
    markArrived, skipStop,
    completedCount, totalCount, progressFraction, nextStop,
    memberProgress,
  } = useRoutePlan({ planId: id ?? null });

  const { locationState, requestLocation } = useActiveLocation();
  const [compassExpanded, setCompassExpanded]   = useState(false);
  const [safeReturnVisible, setSafeReturnVisible] = useState(false);
  const [routeStarted, setRouteStarted]         = useState(false);
  const [fullMapVisible, setFullMapVisible]     = useState(false);
  const [membersExpanded, setMembersExpanded]   = useState(false);

  const userLat = locationState.coords?.lat ?? null;
  const userLng = locationState.coords?.lng ?? null;

  // Background geofence + foreground fallback checkpoint monitor.
  // Fires CHECKPOINT_ARRIVAL_TASK on enter, drains queue on foreground resume.
  // Flatten structuredLocation → lat/lng to satisfy CheckpointStopInput.
  const checkpointStops = React.useMemo(
    () =>
      (fullPlan?.stops ?? [])
        .filter((s) => s.structuredLocation?.lat != null && s.structuredLocation?.lng != null)
        .map((s) => ({
          id:  s.id,
          lat: s.structuredLocation!.lat as number,
          lng: s.structuredLocation!.lng as number,
        })),
    [fullPlan?.stops],
  );

  useRouteCheckpointMonitor({
    stops:     checkpointStops,
    enabled:   routeStarted,
    onArrived: markArrived,
  });

  // Final-stop distance warning: prefer trip accommodation (hotel/stay) over
  // plain endLocation so the warning reflects where the user is actually sleeping.
  const lastStopDistanceToHome = React.useMemo(() => {
    if (!fullPlan) return null;
    const homeLoc =
      fullPlan.plan.tripAccommodationLocation ??
      fullPlan.plan.endLocation;
    if (!homeLoc?.lat || !homeLoc?.lng) return null;
    const lastStop = fullPlan.stops[fullPlan.stops.length - 1];
    if (!lastStop?.structuredLocation?.lat || !lastStop?.structuredLocation?.lng) return null;
    return haversineMeters(
      lastStop.structuredLocation.lat, lastStop.structuredLocation.lng,
      homeLoc.lat, homeLoc.lng,
    );
  }, [fullPlan]);

  const showFinalStopWarning = lastStopDistanceToHome != null
    && lastStopDistanceToHome > FINAL_STOP_WARN_THRESHOLD;

  const handleStartRoute = useCallback(async () => {
    if (locationState.permissionStatus !== 'denied') {
      requestLocation().catch(() => {});
    }
    setRouteStarted(true);
  }, [locationState.permissionStatus, requestLocation]);

  const handleEndSession = useCallback(() => {
    Alert.alert(
      'End route?',
      'This will close the active session.',
      [
        { text: 'Keep going', style: 'cancel' },
        { text: 'End route', style: 'destructive', onPress: () => router.back() },
      ],
    );
  }, [router]);

  const estimatedReturnMinutes = fullPlan
    ? Math.ceil((fullPlan.legs?.reduce((sum, l) => sum + l.durationSeconds, 0) ?? 0) / 60) + 15
    : 30;

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={color.deep} />
        <Text style={styles.loadingText}>Loading route…</Text>
      </View>
    );
  }

  if (error || !fullPlan) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Route not found'}</Text>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const { plan, stops, legs } = fullPlan;
  const legByFromStop = new Map(legs.map((l) => [l.fromStopId, l]));

  return (
    <>
      <Stack.Screen options={{ title: plan.title, headerBackTitle: 'Back' }} />

      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {/* Mini-map — expand opens full-screen modal */}
          <View style={styles.mapWrapper}>
            <RouteMinimapView
              routePlan={fullPlan}
              userLat={userLat}
              userLng={userLng}
              onExpand={() => setFullMapVisible(true)}
              height={220}
            />
          </View>

          {/* Progress bar */}
          <View style={styles.progressRow}>
            <View style={styles.progressBg}>
              <View style={[styles.progressFill, { width: `${progressFraction * 100}%` }]} />
            </View>
            <Text style={styles.progressLabel}>{completedCount}/{totalCount} stops</Text>
          </View>

          {/* Approximation notice */}
          <View style={styles.approxBanner}>
            <Text style={styles.approxText}>
              ℹ️ Distances and times are approximate (straight-line). No live routing provider.
            </Text>
          </View>

          {/* Final-stop distance-to-end warning */}
          {showFinalStopWarning && (
            <View style={styles.finalStopWarning}>
              <AlertTriangle size={13} color="#C62828" />
              <Text style={styles.finalStopWarningText}>
                Your last stop is{' '}
                <Text style={{ fontWeight: '700' }}>{formatDistance(Math.round(lastStopDistanceToHome!))}</Text>
                {' '}from your accommodation — consider arranging a rideshare back.
              </Text>
            </View>
          )}

          {/* GPS status when route is active */}
          {routeStarted && locationState.permissionStatus === 'denied' && (
            <View style={styles.gpsWarning}>
              <Text style={styles.gpsWarningText}>
                📍 GPS is off — mark stops manually using the "Arrived" button.
              </Text>
            </View>
          )}

          {/* Compass explanation */}
          {plan.compassExplanation ? (
            <View style={styles.compassCard}>
              <Pressable style={styles.compassHeader} onPress={() => setCompassExpanded((v) => !v)}>
                <Compass size={15} color={color.deep} />
                <Text style={styles.compassTitle}>Why this order?</Text>
                {compassExpanded ? <ChevronUp size={14} color={color.mute} /> : <ChevronDown size={14} color={color.mute} />}
              </Pressable>
              {compassExpanded ? (
                <Text style={styles.compassBody}>{plan.compassExplanation}</Text>
              ) : null}
            </View>
          ) : null}

          {/* Group member progress (trip-linked) */}
          {plan.tripId && memberProgress && memberProgress.members.length > 0 && (
            <View style={styles.membersCard}>
              <Pressable style={styles.membersHeader} onPress={() => setMembersExpanded((v) => !v)}>
                <Users size={14} color={color.deep} />
                <Text style={styles.membersTitle}>
                  {memberProgress.members.length} trip member{memberProgress.members.length !== 1 ? 's' : ''}
                </Text>
                {membersExpanded ? <ChevronUp size={13} color={color.mute} /> : <ChevronDown size={13} color={color.mute} />}
              </Pressable>
              {membersExpanded && (
                <View style={styles.membersList}>
                  {memberProgress.members.map((m) => (
                    <View key={m.userId} style={styles.memberRow}>
                      <View style={styles.memberAvatar}>
                        <Text style={styles.memberAvatarText}>
                          {(m.displayName ?? 'T')[0]?.toUpperCase()}
                        </Text>
                      </View>
                      <Text style={styles.memberName} numberOfLines={1}>{m.displayName}</Text>
                      {m.isOwner && <View style={styles.ownerBadge}><Text style={styles.ownerBadgeText}>owner</Text></View>}
                    </View>
                  ))}
                  <Text style={styles.memberProgressNote}>
                    {memberProgress.arrivedCount}/{memberProgress.totalStops} checkpoints completed
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Stop + leg cards */}
          {stops.map((stop: RouteStop, idx: number) => {
            const nextLeg  = legByFromStop.get(stop.id);
            const isNext   = nextStop?.id === stop.id;
            const isDone   = stop.checkpointStatus === 'arrived';
            const isSkipped = stop.checkpointStatus === 'skipped';
            const loc      = stop.structuredLocation;

            return (
              <View key={stop.id}>
                <View style={[
                  styles.stopCard,
                  isNext && styles.stopCardNext,
                  isDone && styles.stopCardDone,
                ]}>
                  <View style={styles.stopCardLeft}>
                    <View style={[
                      styles.stopBadge,
                      isDone && styles.stopBadgeDone,
                      isSkipped && styles.stopBadgeSkipped,
                      isNext && styles.stopBadgeNext,
                    ]}>
                      {isDone ? (
                        <CheckCircle size={14} color="#fff" />
                      ) : (
                        <Text style={styles.stopBadgeText}>{idx + 1}</Text>
                      )}
                    </View>
                  </View>
                  <View style={styles.stopCardBody}>
                    <Text style={[styles.stopTitle, isDone && styles.stopTitleDone]}>{stop.title}</Text>
                    {isSkipped ? <Text style={styles.skippedLabel}>Skipped</Text> : null}
                    {loc?.lat != null && loc?.lng != null ? (
                      <Pressable
                        onPress={() => Linking.openURL(`https://maps.google.com/?q=${loc.lat},${loc.lng}`)}
                        style={styles.openMapsBtn}
                      >
                        <MapPin size={11} color={color.deep} />
                        <Text style={styles.openMapsBtnText}>Open in Maps</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {!isDone && !isSkipped && routeStarted ? (
                    <View style={styles.stopCardActions}>
                      <Pressable style={styles.arrivedBtn} onPress={() => markArrived(stop.id)}>
                        <Text style={styles.arrivedBtnText}>Arrived</Text>
                      </Pressable>
                      <Pressable style={styles.skipBtn} onPress={() => skipStop(stop.id)} hitSlop={8}>
                        <SkipForward size={13} color={color.mute} />
                      </Pressable>
                    </View>
                  ) : null}
                </View>

                {nextLeg ? (
                  <View style={styles.legRow}>
                    <View style={styles.legLine} />
                    <View style={styles.legInfo}>
                      <Text style={styles.legModeText}>{MODE_LABEL[nextLeg.mode] ?? nextLeg.mode}</Text>
                      <Text style={styles.legMetaText}>
                        {formatDistance(nextLeg.distanceMeters)} · {formatDuration(nextLeg.durationSeconds)}
                      </Text>
                      {nextLeg.isApproximated ? (
                        <Text style={styles.legApproxText}>approx.</Text>
                      ) : null}
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        {/* Action bar */}
        <View style={styles.actionBar}>
          {!routeStarted ? (
            <Pressable style={styles.startBtn} onPress={handleStartRoute}>
              <Route size={16} color="#fff" />
              <Text style={styles.startBtnText}>Start Route</Text>
            </Pressable>
          ) : (
            <View style={styles.activeActions}>
              <Pressable style={styles.safeReturnBtn} onPress={() => setSafeReturnVisible(true)}>
                <Shield size={15} color={color.deep} />
                <Text style={styles.safeReturnBtnText}>Safe Return</Text>
              </Pressable>
              <Pressable style={styles.endBtn} onPress={handleEndSession}>
                <StopCircle size={15} color={color.signal} />
                <Text style={styles.endBtnText}>End</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>

      <SafeReturnSetupSheet
        visible={safeReturnVisible}
        onClose={() => setSafeReturnVisible(false)}
        onStarted={() => setSafeReturnVisible(false)}
        tripId={plan.tripId ?? undefined}
        planEndsAt={
          estimatedReturnMinutes > 0
            ? new Date(Date.now() + estimatedReturnMinutes * 60_000).toISOString()
            : null
        }
        suggestionReason={`Your route has ${totalCount} stops — estimated ~${estimatedReturnMinutes} min total.`}
      />

      <RouteFullMapModal
        visible={fullMapVisible}
        onClose={() => setFullMapVisible(false)}
        stops={stops}
        legs={legs}
        userLat={userLat}
        userLng={userLng}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  loadingText: { ...t.small, color: color.mute, marginTop: space.md },
  errorText: { ...t.body, color: color.signal, textAlign: 'center' },
  backBtn: { marginTop: space.lg },
  backBtnText: { ...t.bodyStrong, color: color.deep },
  content: { paddingBottom: 120 },
  mapWrapper: { margin: space.md },
  progressRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, marginBottom: space.sm,
  },
  progressBg: { flex: 1, height: 6, backgroundColor: color.haze, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: color.deep },
  progressLabel: { ...t.small, color: color.mute, fontSize: 12 },
  approxBanner: {
    marginHorizontal: space.lg, marginBottom: space.sm,
    backgroundColor: '#FFF8E1', borderRadius: radius.sm, padding: space.sm,
  },
  approxText: { ...t.small, color: '#7B5E00', fontSize: 11 },
  finalStopWarning: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.xs,
    marginHorizontal: space.lg, marginBottom: space.sm,
    backgroundColor: '#FFEBEE', borderRadius: radius.sm, padding: space.sm,
  },
  finalStopWarningText: { ...t.small, color: '#C62828', fontSize: 11, flex: 1, lineHeight: 16 },
  gpsWarning: {
    marginHorizontal: space.lg, marginBottom: space.sm,
    backgroundColor: '#FFF3E0', borderRadius: radius.sm, padding: space.sm,
  },
  gpsWarningText: { ...t.small, color: '#E65100', fontSize: 11 },
  compassCard: {
    marginHorizontal: space.lg, marginBottom: space.md,
    backgroundColor: '#EAF2F4', borderRadius: radius.md, padding: space.md,
  },
  compassHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  compassTitle: { ...t.bodyStrong, color: color.deep, fontSize: 13, flex: 1 },
  compassBody: { ...t.small, color: color.ink, fontSize: 12, lineHeight: 18, marginTop: space.sm },
  membersCard: {
    marginHorizontal: space.lg, marginBottom: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  membersHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  membersTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13, flex: 1 },
  membersList: { marginTop: space.sm, gap: space.xs },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  memberAvatar: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  memberAvatarText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  memberName: { ...t.small, color: color.ink, fontSize: 12, flex: 1 },
  ownerBadge: { backgroundColor: '#EAF2F4', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  ownerBadgeText: { ...t.small, color: color.deep, fontSize: 10, fontWeight: '600' },
  memberProgressNote: { ...t.small, color: color.mute, fontSize: 11, marginTop: 4 },
  stopCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    marginHorizontal: space.lg, marginBottom: 2,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  stopCardNext: { borderColor: color.deep, backgroundColor: '#EAF2F4' },
  stopCardDone: { opacity: 0.6 },
  stopCardLeft: {},
  stopBadge: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#E76F51', alignItems: 'center', justifyContent: 'center',
  },
  stopBadgeDone:    { backgroundColor: '#999' },
  stopBadgeSkipped: { backgroundColor: '#ccc' },
  stopBadgeNext:    { backgroundColor: color.deep },
  stopBadgeText: { ...t.small, color: '#fff', fontSize: 12, fontWeight: '700' },
  stopCardBody: { flex: 1 },
  stopTitle: { ...t.body, color: color.ink, fontSize: 14 },
  stopTitleDone: { textDecorationLine: 'line-through', color: color.mute },
  skippedLabel: { ...t.small, color: color.mute, fontSize: 11 },
  openMapsBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  openMapsBtnText: { ...t.small, color: color.deep, fontSize: 11 },
  stopCardActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  arrivedBtn: {
    backgroundColor: color.deep, borderRadius: radius.sm,
    paddingHorizontal: space.sm, paddingVertical: 5,
  },
  arrivedBtnText: { ...t.small, color: '#fff', fontSize: 12, fontWeight: '600' },
  skipBtn: { padding: 4 },
  legRow: {
    flexDirection: 'row', alignItems: 'center',
    marginLeft: space.lg + 14, marginRight: space.lg, marginVertical: 2,
  },
  legLine: { width: 2, height: 24, backgroundColor: color.haze, marginHorizontal: 12 },
  legInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  legModeText: { ...t.small, color: color.ink, fontSize: 12, fontWeight: '500' },
  legMetaText: { ...t.small, color: color.mute, fontSize: 12 },
  legApproxText: { ...t.small, color: color.mute, fontSize: 10, fontStyle: 'italic' },
  actionBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze,
    padding: space.lg, paddingBottom: 32,
  },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, backgroundColor: color.deep, borderRadius: radius.md, padding: space.lg,
  },
  startBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 15 },
  activeActions: { flexDirection: 'row', gap: space.sm },
  safeReturnBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.deep,
    backgroundColor: '#EAF2F4', padding: space.md,
  },
  safeReturnBtnText: { ...t.bodyStrong, color: color.deep, fontSize: 14 },
  endBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.signal,
    backgroundColor: '#FFF0EE', padding: space.md, paddingHorizontal: space.lg,
  },
  endBtnText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
});
