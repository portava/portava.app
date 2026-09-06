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
  View, Text, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, Alert, Linking, Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import {
  Route, CheckCircle, SkipForward, StopCircle, ChevronDown, ChevronUp,
  MapPin, Shield, Compass, Maximize2, Users, AlertTriangle,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../src/theme/tokens';
import { useSession } from '../../src/context/SessionContext';
import { joinRoutePlan, leaveRoutePlan, acceptRoutePlan, completeRoutePlan } from '../../src/services/routePlan';
import { postCompassAsk, type CompassQuickAction } from '../../src/services/compass';
import { useRoutePlan } from '../../src/hooks/useRoutePlan';
import { RouteMinimapView } from '../../src/components/RouteMinimapView';
import { RouteFullMapModal } from '../../src/components/RouteFullMapModal';
import { SafeReturnSetupSheet } from '../../src/components/safeReturn/SafeReturnSetupSheet';
import { useLocationContext } from '../../src/context/LocationContext';
import type { RouteStop, RouteLeg } from '../../src/services/routePlan';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { useStickyBarInset } from '../../src/hooks/useBottomInset';

// ── Constants ─────────────────────────────────────────────────────────────────

const FINAL_STOP_WARN_THRESHOLD = 1_500; // metres

/**
 * Static fallback chips shown until the Compass pipeline responds.
 * Matches CompassAskRecommendation['nextActions'] shape so the same
 * renderer handles both Compass-driven and fallback chips.
 */
const STATIC_COMPASS_FALLBACK: Array<{ label: string; kind: string }> = [
  { label: '⏭ Skip stop',           kind: 'skip'      },
  { label: '🚗 Long leg: rideshare?', kind: 'rideshare' },
  { label: '🗺️ About stop order',     kind: 'reorder'   },
];

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

  const { userId: currentUserId } = useSession();
  const navBarScrollHandler = useNavBarScrollHandler();
  const { inset: barInset, onBarLayout } = useStickyBarInset();

  const { locationState, requestLocation, resolvedLocation } = useLocationContext();
  const [compassExpanded, setCompassExpanded]   = useState(false);
  const [safeReturnVisible, setSafeReturnVisible] = useState(false);
  const [safeReturnChecking, setSafeReturnChecking] = useState(false);
  const handleSafeReturnClose = useCallback(() => setSafeReturnVisible(false), []);
  const handleSafeReturnStarted = useCallback(() => setSafeReturnVisible(false), []);
  const [routeStarted, setRouteStarted]         = useState(false);
  const [fullMapVisible, setFullMapVisible]     = useState(false);
  const [membersExpanded, setMembersExpanded]   = useState(false);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [compassActions, setCompassActions]     = useState<Array<{ label: string; kind: string }> | null>(null);

  const userLat = resolvedLocation.coords?.lat ?? null;
  const userLng = resolvedLocation.coords?.lng ?? null;

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

  // Checkpoint proximity — reuses the existing useActiveLocation stream rather
  // than a separate geofence/background monitor.  When the user's GPS coords
  // update and a pending stop is within 80 m, markArrived is called once (the
  // notifiedRef prevents duplicate calls for the same stop across re-renders).
  const checkpointNotifiedRef = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!routeStarted || userLat == null || userLng == null) return;
    for (const stop of checkpointStops) {
      if (checkpointNotifiedRef.current.has(stop.id)) continue;
      if (stop.lat == null || stop.lng == null) continue;
      const dist = haversineMeters(userLat, userLng, stop.lat, stop.lng);
      if (dist <= 80) {
        checkpointNotifiedRef.current.add(stop.id);
        markArrived(stop.id).catch(() => checkpointNotifiedRef.current.delete(stop.id));
      }
    }
  }, [userLat, userLng, routeStarted, checkpointStops, markArrived]);

  // Final-stop distance warning: prefer trip accommodation (hotel/stay) over
  // plain endLocation so the warning reflects where the user is actually sleeping.
  const lastStopDistanceToHome = React.useMemo(() => {
    if (!fullPlan) return null;
    const homeLoc =
      fullPlan.plan.tripAccommodationLocation ??
      fullPlan.plan.endLocation;
    if (homeLoc?.lat == null || homeLoc?.lng == null) return null;
    const lastStop = fullPlan.stops[fullPlan.stops.length - 1];
    if (lastStop?.structuredLocation?.lat == null || lastStop?.structuredLocation?.lng == null) return null;
    return haversineMeters(
      lastStop.structuredLocation.lat, lastStop.structuredLocation.lng,
      homeLoc.lat, homeLoc.lng,
    );
  }, [fullPlan]);

  const showFinalStopWarning = lastStopDistanceToHome != null
    && lastStopDistanceToHome > FINAL_STOP_WARN_THRESHOLD;

  // ── Compass pipeline — fetch route suggestions when plan first loads ──────────
  useEffect(() => {
    if (!fullPlan || fullPlan.stops.length < 2) return;
    const stopTitles = fullPlan.stops.map((s) => s.title).join(', ');
    const city = fullPlan.plan.startLocation?.label ?? '';
    postCompassAsk(
      `Suggest route adjustments for these stops in order: ${stopTitles}`,
      { city: city || undefined },
    )
      .then((res) => {
        if (res.ok && res.data?.quickActions && res.data.quickActions.length > 0) {
          setCompassActions(res.data.quickActions.map((a: CompassQuickAction) => ({ label: a.label, kind: a.actionType })));
        }
      })
      .catch(() => { /* non-fatal — chips fall back to static */ });
    // Only run once per plan load (plan id stable after fetch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullPlan?.plan.id]);

  // ── Compass chip action dispatcher ───────────────────────────────────────────
  const handleCompassAction = useCallback((kind: string, label: string) => {
    switch (kind) {
      case 'skip':
        if (nextStop && nextStop.checkpointStatus !== 'arrived') {
          Alert.alert(
            'Skip stop?',
            `Skip "${nextStop.title}"?`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Skip', style: 'destructive', onPress: () => { void skipStop(nextStop.id); } },
            ],
          );
        }
        break;
      case 'rideshare':
        Alert.alert('Rideshare tip', 'One or more legs are over 20 min walk. Consider a rideshare for those segments.');
        break;
      case 'reorder':
        Alert.alert(
          'Stop order',
          'Stops are ordered to minimise total walking distance. To rearrange, edit the route and rebuild.',
        );
        break;
      default:
        Alert.alert('Route tip', label);
    }
  }, [nextStop, skipStop]);

  // Join/leave for trip members who are not the plan owner
  const handleJoinRoute = useCallback(async () => {
    if (!id) return;
    setMembershipLoading(true);
    try {
      await joinRoutePlan(id);
    } catch (e) {
      Alert.alert('Could not join route', (e as Error).message ?? 'Please try again.');
    } finally {
      setMembershipLoading(false);
    }
  }, [id]);

  const handleLeaveRoute = useCallback(async () => {
    if (!id) return;
    Alert.alert('Leave Route', 'Remove yourself from this route?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          setMembershipLoading(true);
          try {
            await leaveRoutePlan(id);
          } catch (e) {
            Alert.alert('Could not leave route', (e as Error).message ?? 'Please try again.');
          } finally {
            setMembershipLoading(false);
          }
        },
      },
    ]);
  }, [id]);

  const [startingRoute, setStartingRoute] = useState(false);

  // STARTING A ROUTE IS THE ACCEPTANCE ACT, and acceptance is authoritative only
  // on the server. This used to be `setRouteStarted(true)` and nothing else: the
  // canonical endpoint (POST /api/route-plans/:id/accept) had zero callers, so
  // no plan ever reached status='active' and both Map layers that read only
  // active plans were starved by the missing call.
  //
  // The server mutation is AWAITED and its failure is surfaced. A route must
  // never render as started when the server refused — a client-only "started"
  // is precisely the defect being fixed here.
  const handleStartRoute = useCallback(async () => {
    if (startingRoute) return; // double-tap guard; the endpoint is idempotent anyway
    setStartingRoute(true);
    try {
      await acceptRoutePlan(id);
      if (locationState.permissionStatus !== 'denied') {
        requestLocation().catch(() => {});
      }
      setRouteStarted(true);
    } catch (e) {
      Alert.alert(
        "Couldn't start this route",
        e instanceof Error ? e.message : 'Please try again.',
      );
    } finally {
      setStartingRoute(false);
    }
  }, [id, startingRoute, locationState.permissionStatus, requestLocation]);

  // ENDING A ROUTE IS TERMINAL, and it must reach the server. routeHopSignal
  // counts only status='active' plans, so a walk that ended without this call
  // kept contributing route-flow intelligence for the whole freshness window
  // after the traveller went home.
  //
  // Navigating back is deliberately NOT gated on the mutation: the traveller has
  // finished, and trapping them on the screen because a request failed would be
  // worse than a retry. The failure is surfaced instead, and the endpoint is
  // idempotent so retrying is safe.
  const handleEndSession = useCallback(() => {
    Alert.alert(
      'End route?',
      'This will close the active session.',
      [
        { text: 'Keep going', style: 'cancel' },
        {
          text: 'End route',
          style: 'destructive',
          onPress: () => {
            completeRoutePlan(id)
              .catch((e) => {
                Alert.alert(
                  "Couldn't end this route",
                  e instanceof Error ? e.message : 'It may still show as active.',
                );
              })
              .finally(() => router.back());
          },
        },
      ],
    );
  }, [id, router]);

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
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: barInset }]} showsVerticalScrollIndicator={false} onScroll={navBarScrollHandler} scrollEventThrottle={16}>
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

          {/* Compass explanation + actionable chips */}
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
              {/* Actionable Compass chips — driven by Compass pipeline response */}
              <View style={styles.compassChips}>
                {(compassActions ?? STATIC_COMPASS_FALLBACK).map((action) => (
                  <Pressable
                    key={action.kind + action.label}
                    style={styles.compassChip}
                    onPress={() => handleCompassAction(action.kind, action.label)}
                  >
                    <Text style={styles.compassChipText}>{action.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {/* Group member progress (trip-linked) */}
          {/* Show group card whenever the plan is trip-linked, even with 0 members,
              so the Join button is always visible to trip members on a fresh route. */}
          {plan.tripId != null && memberProgress != null && (() => {
            const selfMember = memberProgress.members.find((m) => m.userId === currentUserId);
            const isOwner    = selfMember?.isOwner ?? false;
            const isJoined   = selfMember != null;
            return (
              <View style={styles.membersCard}>
                <Pressable style={styles.membersHeader} onPress={() => setMembersExpanded((v) => !v)}>
                  <Users size={14} color={color.deep} />
                  <Text style={styles.membersTitle}>
                    {memberProgress.members.length > 0
                      ? `${memberProgress.members.length} trip member${memberProgress.members.length !== 1 ? 's' : ''}`
                      : 'Trip route'}
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
                {/* Join / Leave toggle for non-owner trip members */}
                {!isOwner && currentUserId && (
                  <Pressable
                    style={[styles.memberToggleBtn, isJoined && styles.memberToggleBtnLeave]}
                    onPress={isJoined ? handleLeaveRoute : handleJoinRoute}
                    disabled={membershipLoading}
                  >
                    {membershipLoading
                      ? <ActivityIndicator size="small" color={isJoined ? color.signal : color.deep} />
                      : <Text style={[styles.memberToggleBtnText, isJoined && styles.memberToggleBtnTextLeave]}>
                          {isJoined ? 'Leave Route' : 'Join Route'}
                        </Text>
                    }
                  </Pressable>
                )}
              </View>
            );
          })()}

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
        <View style={styles.actionBar} onLayout={onBarLayout}>
          {!routeStarted ? (
            <Pressable style={styles.startBtn} onPress={handleStartRoute}>
              <Route size={16} color="#fff" />
              <Text style={styles.startBtnText}>Start Route</Text>
            </Pressable>
          ) : (
            <View style={styles.activeActions}>
              <Pressable
                style={[styles.safeReturnBtn, safeReturnChecking && { opacity: 0.7 }]}
                onPress={() => setSafeReturnVisible(true)}
                disabled={safeReturnChecking}
              >
                {safeReturnChecking
                  ? <ActivityIndicator size="small" color={color.deep} />
                  : <Shield size={15} color={color.deep} />}
                <Text style={styles.safeReturnBtnText}>
                  {safeReturnChecking ? 'Checking…' : 'Safe Return'}
                </Text>
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
        onClose={handleSafeReturnClose}
        onStarted={handleSafeReturnStarted}
        tripId={plan.tripId ?? undefined}
        planEndsAt={
          estimatedReturnMinutes > 0
            ? new Date(Date.now() + estimatedReturnMinutes * 60_000).toISOString()
            : null
        }
        suggestionReason={`Your route has ${totalCount} stops — estimated ~${estimatedReturnMinutes} min total.`}
        onCheckingChange={setSafeReturnChecking}
      />
      <Modal visible={safeReturnChecking} transparent animationType="fade" statusBarTranslucent>
        <View style={srStyles.overlay}>
          <View style={srStyles.card}>
            <ActivityIndicator color={color.deep} />
            <Text style={srStyles.label}>Checking Safe Return…</Text>
          </View>
        </View>
      </Modal>

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
  content: {},
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
  compassChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.sm },
  compassChip: {
    borderRadius: radius.sm, borderWidth: 1, borderColor: color.deep,
    paddingHorizontal: space.sm, paddingVertical: 4,
  },
  compassChipText: { ...t.small, color: color.deep, fontSize: 11 },
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
    width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  memberAvatarText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  memberName: { ...t.small, color: color.ink, fontSize: 12, flex: 1 },
  ownerBadge: { backgroundColor: '#EAF2F4', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  ownerBadgeText: { ...t.small, color: color.deep, fontSize: 10, fontWeight: '600' },
  memberProgressNote: { ...t.small, color: color.mute, fontSize: 11, marginTop: 4 },
  memberToggleBtn: {
    marginTop: space.md, paddingVertical: space.sm, borderRadius: radius.sm,
    backgroundColor: '#EAF2F4', alignItems: 'center',
  },
  memberToggleBtnLeave: { backgroundColor: '#FEF2F2' },
  memberToggleBtnText: { ...t.bodyStrong, color: color.deep, fontSize: 13 },
  memberToggleBtnTextLeave: { color: color.signal },
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
    width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2,
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

const srStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paper,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 8,
  },
  label: { ...t.body, color: color.ink, fontSize: 14 },
});
