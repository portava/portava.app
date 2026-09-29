/**
 * TripGeofenceCard — mounts the plan geofence components on the trip page
 * (TRIP-F26, WP-10; census-trips §77).
 *
 * GeofenceSettingsSheet, PlanCheckInView and HostAttendanceDashboard were
 * built with their service (services/geofence.ts) and imported by no screen.
 * The geofence is the trip's meetup point (one `plan_geofences` row per trip,
 * routes/geofence.ts). This card reads it and routes the viewer:
 *
 *   owner   set up / edit the check-in point, and open attendance
 *   member  check in at the meetup (GPS stays on the device; the server
 *           answers a status, never coordinates)
 *
 * `plan_geofence_enabled` off: the server says `featureEnabled: false` and
 * the card renders nothing. A read that fails is shown with a retry, never
 * as "no check-in set".
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { MapPinned, CloudOff, Users } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { isConfigured } from '../shared/auth.ts';
import type { GeofenceResponse } from '../../../services/geofence.ts';
import { GeofenceSettingsSheet } from '../../../components/itinerary/GeofenceSettingsSheet.tsx';
import { PlanCheckInView } from '../../../components/itinerary/PlanCheckInView.tsx';
import { HostAttendanceDashboard } from '../../../components/itinerary/HostAttendanceDashboard.tsx';

type Read = { state: 'ok'; data: GeofenceResponse } | { state: 'unavailable'; detail: string };

async function readGeofence(tripId: string): Promise<Read> {
  try {
    const { getGeofence } = await import('../../../services/geofence.ts');
    const data = await getGeofence(tripId);
    if (!data || typeof data.featureEnabled !== 'boolean') return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', data };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

interface Props {
  tripId: string;
  isOwner: boolean;
  /** An accepted crew member (the owner included). */
  isMember: boolean;
  /** Test seam. */
  load?: (tripId: string) => Promise<Read>;
}

export function TripGeofenceCard({ tripId, isOwner, isMember, load = readGeofence }: Props) {
  const [read, setRead] = useState<Read | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attendanceOpen, setAttendanceOpen] = useState(false);

  const run = useCallback(async () => {
    setRead(undefined);
    setRead(await load(tripId));
  }, [tripId, load]);
  useEffect(() => { if (isConfigured()) void run(); }, [run]);

  if (!isConfigured()) return null;
  if (read === undefined) {
    return <View style={s.wrap} testID="trip-geofence-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-geofence-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Meetup check-in unavailable</Text>
            <Text style={s.detail}>We couldn&apos;t read this trip&apos;s check-in point ({read.detail}).</Text>
            <Pressable onPress={() => void run()} style={s.button} testID="trip-geofence-retry" accessibilityRole="button"><Text style={s.buttonText}>Try again</Text></Pressable>
          </View>
        </View>
      </View>
    );
  }
  const { featureEnabled, geofence } = read.data;
  if (!featureEnabled) return null;
  if (!geofence && !isOwner) return null;

  return (
    <View style={s.wrap} testID="trip-geofence-card">
      <View style={s.row}>
        <MapPinned size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Meetup check-in</Text>
          <Text style={s.detail}>
            {geofence
              ? `${geofence.locationLabel ?? geofence.venueName ?? geofence.neighborhood ?? geofence.city ?? 'Meetup point set'}${geofence.hostEnabled ? '' : ' · check-in is paused'}`
              : 'No check-in point yet. Set one so the crew can check in when they arrive.'}
          </Text>
          {isOwner ? (
            <View style={s.buttons}>
              <Pressable onPress={() => setSettingsOpen(true)} style={s.button} testID="trip-geofence-settings" accessibilityRole="button">
                <Text style={s.buttonText}>{geofence ? 'Edit check-in point' : 'Set up check-in'}</Text>
              </Pressable>
              {geofence ? (
                <Pressable onPress={() => setAttendanceOpen(true)} style={[s.button, s.inline]} testID="trip-geofence-attendance" accessibilityRole="button">
                  <Users size={12} color={color.ink} />
                  <Text style={s.buttonText}>Attendance</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
      {geofence && geofence.hostEnabled && !isOwner ? (
        <PlanCheckInView tripId={tripId} geofence={geofence} isAcceptedMember={isMember} />
      ) : null}
      {settingsOpen ? (
        <GeofenceSettingsSheet
          tripId={tripId}
          isOwner={isOwner}
          featureEnabled={featureEnabled}
          existing={geofence}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => { setSettingsOpen(false); void run(); }}
        />
      ) : null}
      <HostAttendanceDashboard tripId={tripId} visible={attendanceOpen} onClose={() => setAttendanceOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonText: { ...t.small, color: color.ink },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
