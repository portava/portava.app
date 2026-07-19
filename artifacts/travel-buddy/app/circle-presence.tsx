/**
 * circle-presence.tsx — Find Your Circle: Trip & Event Circle screen.
 *
 * Route params:
 *   contextType   'trip' | 'event'
 *   contextId     UUID of the trip or event
 *   contextLabel  display name (trip destination / event title)
 *   contextEndDate? ISO date string — if in the past, show "ended" state
 *   isHost?       'true' if viewer is the host (shows "Update meeting point" action)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  RefreshControl,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Settings, Radio, Users, Pause, WifiOff, AlertCircle, MapPin } from 'lucide-react-native';

import { ScreenHeader } from '../src/components/ScreenHeader';
import { SafeReturnSetupSheet } from '../src/components/safeReturn/SafeReturnSetupSheet';
import { CircleMemberRow } from '../src/components/circle/CircleMemberRow';
import { CheckInActions } from '../src/components/circle/CheckInActions';
import { MeetingPointCard } from '../src/components/circle/MeetingPointCard';
import {
  CircleMapSection,
  type MapMember,
  type MapMeetingPoint,
} from '../src/components/circle/CircleMapSection';

import * as Location from 'expo-location';

import {
  getCircleSettings,
  getCircleContextSettings,
  getCircleMembers,
  getMyPresence,
  getMeetingPoint,
  type CircleMember,
  type MeetingPoint,
} from '../src/services/circle';

import { useSession } from '../src/context/SessionContext';
import { color, radius, type as t } from '../src/theme/tokens';
import { usePlainBottomInset } from '../src/hooks/useBottomInset';

type ScreenState =
  | 'loading'
  | 'error'
  | 'feature_disabled'
  | 'not_member'
  | 'sharing_off'
  | 'ended'
  | 'ok';

export default function CirclePresenceScreen() {
  const bottomInset = usePlainBottomInset();
  const { userId } = useSession();
  const params = useLocalSearchParams<{
    contextType?: string;
    contextId?: string;
    contextLabel?: string;
    contextEndDate?: string;
    isHost?: string;
  }>();

  const contextType = params.contextType === 'event' ? ('event' as const) : ('trip' as const);
  const contextId = params.contextId ?? '';
  const contextLabel = params.contextLabel ?? (contextType === 'trip' ? 'Trip Circle' : 'Event Circle');
  const contextEndDate = params.contextEndDate ?? null;
  const isHostParam = params.isHost === 'true';

  const [screenState, setScreenState] = useState<ScreenState>('loading');
  const [members, setMembers] = useState<CircleMember[]>([]);
  const [viewerPresence, setViewerPresence] = useState<CircleMember | null>(null);
  const [meetingPoint, setMeetingPoint] = useState<MeetingPoint | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [contextPaused, setContextPaused] = useState(false);
  const [safeReturnOpen, setSafeReturnOpen] = useState(false);
  const [locationPermBanner, setLocationPermBanner] = useState(false);

  const loadingRef = useRef(false);

  const load = useCallback(
    async (silent = false) => {
      if (!contextId || loadingRef.current) return;
      loadingRef.current = true;
      if (!silent) setScreenState('loading');

      if (contextEndDate) {
        const end = new Date(contextEndDate);
        if (!Number.isNaN(end.getTime()) && end < new Date()) {
          setScreenState('ended');
          loadingRef.current = false;
          return;
        }
      }

      try {
        const [settingsRes, ctxSettingsRes, membersRes, myPresenceRes, mpRes, locPerm] =
          await Promise.all([
            getCircleSettings(),
            getCircleContextSettings(contextType, contextId),
            getCircleMembers(contextType, contextId, { limit: 100 }),
            getMyPresence(contextType, contextId),
            getMeetingPoint(contextType, contextId),
            Location.getForegroundPermissionsAsync().catch(() => ({ status: 'granted' as const })),
          ]);

        if (
          !membersRes.ok &&
          (membersRes.error === 'feature_disabled' || membersRes.status === 503)
        ) {
          setScreenState('feature_disabled');
          loadingRef.current = false;
          return;
        }

        if (!membersRes.ok && membersRes.status === 403) {
          setScreenState('not_member');
          loadingRef.current = false;
          return;
        }

        if (!membersRes.ok) {
          if (!silent) setScreenState('error');
          loadingRef.current = false;
          return;
        }

        if (settingsRes.ok && !settingsRes.data.globalEnabled) {
          setScreenState('sharing_off');
          loadingRef.current = false;
          return;
        }

        const isPaused = settingsRes.ok ? settingsRes.data.isPaused : false;
        const isCtxPaused = ctxSettingsRes.ok ? ctxSettingsRes.data.paused : false;

        setGlobalPaused(isPaused);
        setContextPaused(isCtxPaused);
        setMembers(membersRes.data.members ?? []);
        setViewerPresence(myPresenceRes.ok ? myPresenceRes.data : null);
        setMeetingPoint(mpRes.ok ? (mpRes.data.meetingPoint ?? null) : null);

        // Show banner when OS location permission is not granted
        setLocationPermBanner(locPerm.status !== 'granted');

        setScreenState('ok');
      } catch {
        if (!silent) setScreenState('error');
      } finally {
        loadingRef.current = false;
      }
    },
    [contextType, contextId, contextEndDate],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

  async function handleRefresh() {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }

  function handleCheckInComplete() {
    void load(true);
  }

  function handleMeetingPointUpdate(mp: MeetingPoint) {
    setMeetingPoint(mp);
  }

  function goToSettings() {
    router.push({
      pathname: '/circle-context-settings',
      params: { contextType, contextId, contextLabel },
    } as any);
  }

  // ── State screens ────────────────────────────────────────────────────────────

  if (screenState === 'loading') {
    return (
      <View style={g.screen}>
        <ScreenHeader title={contextLabel} />
        <View style={g.center}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      </View>
    );
  }

  if (screenState === 'error') {
    return (
      <View style={g.screen}>
        <ScreenHeader title={contextLabel} />
        <View style={g.center}>
          <AlertCircle size={40} color={color.faint} />
          <Text style={g.stateTitle}>Couldn't load Circle.</Text>
          <Text style={g.stateBody}>Check your connection and try again.</Text>
          <Pressable style={g.actionBtn} onPress={() => load()}>
            <Text style={g.actionText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (screenState === 'feature_disabled') {
    return (
      <View style={g.screen}>
        <ScreenHeader title={contextLabel} />
        <View style={g.center}>
          <Radio size={40} color={color.faint} />
          <Text style={g.stateTitle}>Find Your Circle disabled.</Text>
          <Text style={g.stateBody}>
            This feature isn't available yet. Check back later.
          </Text>
        </View>
      </View>
    );
  }

  if (screenState === 'not_member') {
    const msg =
      contextType === 'trip'
        ? 'You are not in this trip.'
        : 'Your RSVP must be confirmed to view Event Circle.';
    const body =
      contextType === 'trip'
        ? "You need to be an accepted trip member to see who's sharing."
        : 'Accept your invitation and RSVP going to join the Event Circle.';
    return (
      <View style={g.screen}>
        <ScreenHeader title={contextLabel} />
        <View style={g.center}>
          <Users size={40} color={color.faint} />
          <Text style={g.stateTitle}>{msg}</Text>
          <Text style={g.stateBody}>{body}</Text>
        </View>
      </View>
    );
  }

  if (screenState === 'ended') {
    const msg =
      contextType === 'trip' ? 'This trip has ended.' : 'This event has ended.';
    return (
      <View style={g.screen}>
        <ScreenHeader title={contextLabel} />
        <View style={g.center}>
          <Radio size={40} color={color.faint} />
          <Text style={g.stateTitle}>{msg}</Text>
          <Text style={g.stateBody}>Circle sharing is no longer active.</Text>
        </View>
      </View>
    );
  }

  if (screenState === 'sharing_off') {
    return (
      <View style={g.screen}>
        <ScreenHeader title={contextLabel} />
        <View style={g.center}>
          <WifiOff size={40} color={color.faint} />
          <Text style={g.stateTitle}>Find Your Circle is off.</Text>
          <Text style={g.stateBody}>
            Turn on Circle sharing in settings to see who's around.
          </Text>
          <Pressable style={g.actionBtn} onPress={goToSettings}>
            <Text style={g.actionText}>Open settings</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ── Main screen ──────────────────────────────────────────────────────────────

  // Viewer's own presence comes from a dedicated endpoint (self is excluded from /members)
  const viewerMember = viewerPresence;
  const otherMembers = members;
  const meetingPointLabel =
    meetingPoint?.venueLabel ?? meetingPoint?.approximateLabel ?? null;

  // Derive map pins from members/meeting-point that have coordinates.
  // V1: publicLat/publicLng are always null (no DB columns yet), so mapMembers
  // stays empty and the map banner renders. V2 will populate coordinates.
  const mapMembers: MapMember[] = members
    .filter((m): m is typeof m & { publicLat: number; publicLng: number } =>
      m.publicLat !== null && m.publicLng !== null,
    )
    .map((m) => ({
      userId: m.userId,
      lat: m.publicLat,
      lng: m.publicLng,
      isStale: m.isStale,
    }));

  const mapMeetingPoint: MapMeetingPoint | null =
    meetingPoint?.lat !== null && meetingPoint?.lng !== null && meetingPoint !== null
      ? {
          lat: meetingPoint.lat!,
          lng: meetingPoint.lng!,
          label:
            meetingPoint.venueLabel ?? meetingPoint.approximateLabel ?? 'Meeting point',
        }
      : null;

  // Event timing: show end time if known
  const eventEndDisplay =
    contextType === 'event' && contextEndDate
      ? (() => {
          const d = new Date(contextEndDate);
          if (Number.isNaN(d.getTime())) return null;
          return d.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
        })()
      : null;

  const listHeader = (
    <View style={g.headerArea}>
      <ScreenHeader title={contextLabel} />
      {globalPaused && (
        <View style={g.pauseBanner}>
          <Pause size={14} color={color.mute} />
          <Text style={g.pauseText}>
            Sharing paused. Others can't see your status.
          </Text>
          <Pressable onPress={goToSettings}>
            <Text style={g.pauseLink}>Resume</Text>
          </Pressable>
        </View>
      )}
      {contextPaused && !globalPaused && (
        <View style={g.pauseBanner}>
          <Pause size={14} color={color.mute} />
          <Text style={g.pauseText}>
            Sharing paused for this {contextType}.
          </Text>
          <Pressable onPress={goToSettings}>
            <Text style={g.pauseLink}>Resume</Text>
          </Pressable>
        </View>
      )}

      {locationPermBanner && (
        <View style={g.locBanner}>
          <MapPin size={14} color={color.mute} />
          <Text style={g.locBannerText}>
            Location permission is off — showing status only.
          </Text>
        </View>
      )}

      {(meetingPoint || isHostParam) && (
        <MeetingPointCard
          meetingPoint={meetingPoint}
          contextType={contextType}
          contextId={contextId}
          onUpdate={handleMeetingPointUpdate}
          showUpdateAction={isHostParam}
        />
      )}

      {eventEndDisplay && (
        <View style={g.eventTimingRow}>
          <MapPin size={13} color={color.mute} />
          <Text style={g.eventTimingText}>Event ends {eventEndDisplay}</Text>
        </View>
      )}

      {!locationPermBanner && (
        <CircleMapSection
          members={mapMembers}
          meetingPoint={mapMeetingPoint}
          meetingPointLabel={meetingPointLabel}
        />
      )}

      <View style={g.viewerSection}>
        {viewerMember ? (
          <CircleMemberRow member={viewerMember} isViewerRow />
        ) : (
          <View style={g.notSharingRow}>
            <Radio size={16} color={color.mute} />
            <Text style={g.notSharingText}>You aren't sharing yet.</Text>
            <Pressable onPress={goToSettings}>
              <Text style={g.pauseLink}>Settings</Text>
            </Pressable>
          </View>
        )}
        <CheckInActions
          contextType={contextType}
          contextId={contextId}
          disabled={globalPaused || contextPaused}
          onCheckInComplete={handleCheckInComplete}
          onNeedHelp={() => setSafeReturnOpen(true)}
        />
      </View>

      <View style={g.sectionHeader}>
        <Text style={g.sectionTitle}>Who's sharing</Text>
        <Pressable onPress={goToSettings} hitSlop={8}>
          <Settings size={16} color={color.mute} />
        </Pressable>
      </View>
    </View>
  );

  return (
    <View style={g.screen}>
      <FlatList
        data={otherMembers}
        keyExtractor={(m) => m.userId}
        renderItem={({ item }) => <CircleMemberRow member={item} />}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          <View style={g.emptySection}>
            <Users size={32} color={color.faint} />
            <Text style={g.emptyTitle}>No one is sharing right now.</Text>
            <Text style={g.emptyBody}>
              Circle members who have sharing on will appear here.
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
        }
        contentContainerStyle={{ paddingBottom: bottomInset }}
        ItemSeparatorComponent={() => <View style={g.separator} />}
      />

      <SafeReturnSetupSheet
        visible={safeReturnOpen}
        onClose={() => setSafeReturnOpen(false)}
      />
    </View>
  );
}

const g = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32 },
  stateTitle: { ...t.title, fontSize: 18, color: color.ink, textAlign: 'center' },
  stateBody: { ...t.body, color: color.mute, textAlign: 'center', maxWidth: 280 },
  actionBtn: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  actionText: { ...t.body, color: '#fff', fontWeight: '600' },

  headerArea: { gap: 12, paddingTop: 12, paddingBottom: 4 },

  pauseBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.haze,
    marginHorizontal: 16,
    borderRadius: radius.md,
    padding: 10,
  },
  pauseText: { ...t.small, color: color.mute, flex: 1 },
  pauseLink: { ...t.small, color: color.signal, fontWeight: '600' },

  locBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFF8E1',
    marginHorizontal: 16,
    borderRadius: radius.md,
    padding: 10,
  },
  locBannerText: { ...t.small, color: '#F57F17', flex: 1 },

  viewerSection: {
    gap: 0,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    paddingTop: 8,
    marginTop: 4,
  },

  notSharingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: color.haze,
    marginHorizontal: 16,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  notSharingText: { ...t.small, color: color.mute, flex: 1 },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: color.haze,
    marginTop: 4,
  },
  sectionTitle: {
    ...t.small,
    color: color.mute,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  emptySection: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 32,
    gap: 10,
  },
  emptyTitle: { ...t.body, fontWeight: '600', color: color.ink, textAlign: 'center' },
  emptyBody: { ...t.small, color: color.mute, textAlign: 'center', maxWidth: 260 },

  eventTimingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  eventTimingText: { ...t.small, color: color.mute },

  listContent: { paddingBottom: 40 },
  separator: { height: 1, backgroundColor: color.haze, marginHorizontal: 16 },
});
