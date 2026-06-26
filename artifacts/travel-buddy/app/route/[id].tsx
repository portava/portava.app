/**
 * Active Route Screen — app/route/[id].tsx
 *
 * Full-screen route view:
 *  - RouteMinimapView at top
 *  - Scrollable leg cards (from → to, estimated walk time, distance, mode chip)
 *  - Checkpoint status pills per stop
 *  - "Start route" / "Arrived" / "Skip stop" / "End session" action bar
 *  - Compass explanation (collapsible "Why this order?" card)
 *  - Safe Return integration (pre-fill return time)
 *  - GPS auto-checkpoint driven by existing useActiveLocation (no parallel location subsystem)
 *  - Manual fallback if GPS is denied
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator, Alert, Linking,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  Route, CheckCircle, SkipForward, StopCircle, ChevronDown, ChevronUp,
  MapPin, Shield, Compass,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { useRoutePlan } from '../../src/hooks/useRoutePlan';
import { RouteMinimapView } from '../../src/components/RouteMinimapView';
import { SafeReturnSetupSheet } from '../../src/components/safeReturn/SafeReturnSetupSheet';
import { useActiveLocation } from '../../src/hooks/useActiveLocation';
import type { RouteStop } from '../../src/services/routePlan';

// ── Constants ─────────────────────────────────────────────────────────────────

const ARRIVAL_RADIUS_M = 80;

// ── Helpers ───────────────────────────────────────────────────────────────────

const MODE_LABEL: Record<string, string> = {
  walk: '🚶 Walk',
  rideshare: '🚗 Rideshare',
  transit: '🚌 Transit',
  bike: '🚴 Bike',
  drive: '🚙 Drive',
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `~${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `~${h}h ${rem}m` : `~${h}h`;
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ActiveRouteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const {
    plan: fullPlan, loading, error,
    markArrived, skipStop,
    completedCount, totalCount, progressFraction, nextStop,
  } = useRoutePlan({ planId: id ?? null });

  // Use the existing location infrastructure — no parallel expo-location subsystem.
  const { locationState, requestLocation } = useActiveLocation();
  const [compassExpanded, setCompassExpanded] = useState(false);
  const [safeReturnVisible, setSafeReturnVisible] = useState(false);
  const [routeStarted, setRouteStarted] = useState(false);
  const [mapExpanded, setMapExpanded] = useState(false);

  // Track stops we've already auto-checked to avoid duplicate PATCH calls.
  const notifiedStops = useRef(new Set<string>());

  const userLat = locationState.coords?.lat ?? null;
  const userLng = locationState.coords?.lng ?? null;

  // Auto-checkpoint: react to coordinate changes from the existing location system.
  // This reuses the location subsystem rather than introducing a parallel poll loop.
  useEffect(() => {
    if (!routeStarted || !fullPlan) return;
    if (userLat == null || userLng == null) return;

    for (const stop of fullPlan.stops) {
      if (stop.checkpointStatus !== 'pending') continue;
      if (notifiedStops.current.has(stop.id)) continue;
      const loc = stop.structuredLocation;
      if (!loc?.lat || !loc?.lng) continue;

      const dist = haversineMeters(userLat, userLng, loc.lat, loc.lng);
      if (dist <= ARRIVAL_RADIUS_M) {
        notifiedStops.current.add(stop.id);
        markArrived(stop.id).catch(() => {
          notifiedStops.current.delete(stop.id);
        });
      }
    }
  }, [routeStarted, fullPlan, userLat, userLng, markArrived]);

  const handleStartRoute = useCallback(async () => {
    // Request a location refresh when the route starts so proximity checks fire promptly.
    // Falls back to manual checkpoints if permission is denied.
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
          {/* Mini-map */}
          <View style={styles.mapWrapper}>
            <RouteMinimapView
              routePlan={fullPlan}
              userLat={userLat}
              userLng={userLng}
              onExpand={() => setMapExpanded((v) => !v)}
              height={mapExpanded ? 360 : 220}
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

          {/* Stop + leg cards */}
          {stops.map((stop: RouteStop, idx: number) => {
            const nextLeg = legByFromStop.get(stop.id);
            const isNext = nextStop?.id === stop.id;
            const isDone = stop.checkpointStatus === 'arrived';
            const isSkipped = stop.checkpointStatus === 'skipped';
            const loc = stop.structuredLocation;

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
  progressBg: {
    flex: 1, height: 6, backgroundColor: color.haze, borderRadius: 3, overflow: 'hidden',
  },
  progressFill: { height: 6, backgroundColor: color.deep },
  progressLabel: { ...t.small, color: color.mute, fontSize: 12 },
  approxBanner: {
    marginHorizontal: space.lg, marginBottom: space.sm,
    backgroundColor: '#FFF8E1', borderRadius: radius.sm, padding: space.sm,
  },
  approxText: { ...t.small, color: '#7B5E00', fontSize: 11 },
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
  stopBadgeDone: { backgroundColor: '#999' },
  stopBadgeSkipped: { backgroundColor: '#ccc' },
  stopBadgeNext: { backgroundColor: color.deep },
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
