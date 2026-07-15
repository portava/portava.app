/**
 * PlanCheckInView — check-in UI for accepted members at a geofenced meetup.
 * Shows location label, check-in button, distance/nearby text, and arrival status.
 * Never displays exact GPS coordinates.
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { MapPin, CheckCircle2, Clock, Navigation, Info } from 'lucide-react-native';
import * as Location from 'expo-location';
import { color, space, radius, type as t } from '../../theme/tokens';
import { checkIn, type GeofenceData, type AttendanceStatus } from '../../services/geofence';

// ── Status display ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<AttendanceStatus, { label: string; color: string; bg: string }> = {
  not_checked_in: { label: 'Not checked in',      color: color.mute,    bg: color.haze },
  on_the_way:     { label: 'On the way',           color: '#B07000',     bg: '#FFF8E7' },
  nearby:         { label: 'Nearby',               color: color.deep,    bg: '#E2EDF0' },
  arrived:        { label: 'Arrived ✓',            color: color.success, bg: '#E3F1EA' },
  late:           { label: 'Arrived (late)',        color: '#B07000',     bg: '#FFF8E7' },
  no_show:        { label: 'No-show',              color: color.signal,  bg: '#FDEAEA' },
  left:           { label: 'Left',                 color: color.mute,    bg: color.haze },
};

// ── Props ─────────────────────────────────────────────────────────────────────

export interface PlanCheckInViewProps {
  tripId: string;
  geofence: GeofenceData;
  /** Whether this component is rendered for an accepted member. */
  isAcceptedMember: boolean;
  onStatusChange?: (newStatus: AttendanceStatus) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PlanCheckInView({
  tripId, geofence, isAcceptedMember, onStatusChange,
}: PlanCheckInViewProps) {
  const [loading, setLoading] = useState(false);
  const [localStatus, setLocalStatus] = useState<AttendanceStatus>(
    (geofence.myCheckInStatus as AttendanceStatus) ?? 'not_checked_in',
  );

  const hasCheckedIn = localStatus === 'arrived' || localStatus === 'late';

  const handleCheckIn = async () => {
    setLoading(true);
    try {
      const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
      if (permStatus !== 'granted') {
        Alert.alert(
          'Location access needed',
          'Please allow location access so we can verify you are at the meetup.',
        );
        return;
      }

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const result = await checkIn(tripId, loc.coords.latitude, loc.coords.longitude);

      if (result.ok && result.status) {
        const newStatus = result.status as AttendanceStatus;
        setLocalStatus(newStatus);
        onStatusChange?.(newStatus);
        Alert.alert('Checked in!', result.message);
      } else {
        Alert.alert(
          result.reason === 'outside_radius' ? 'Not close enough' :
          result.reason === 'window_not_open' ? 'Too early' :
          result.reason === 'window_closed'   ? 'Check-in closed' :
          result.reason === 'suspicious_gps'  ? 'Location issue' : 'Check-in failed',
          result.message,
        );
      }
    } catch (e: any) {
      Alert.alert('Error', e.message ?? 'Check-in failed');
    } finally {
      setLoading(false);
    }
  };

  // Non-members see only the public preview card
  if (!isAcceptedMember) {
    return <PublicPreviewCard geofence={geofence} />;
  }

  const cfg = STATUS_CONFIG[localStatus] ?? STATUS_CONFIG.not_checked_in;

  // Window info
  const now = new Date();
  const windowOpen   = !geofence.checkInWindowStart || new Date(geofence.checkInWindowStart) <= now;
  const windowClosed = geofence.checkInWindowEnd   && new Date(geofence.checkInWindowEnd) < now;
  const canCheckIn = geofence.checkInRequired && !hasCheckedIn && windowOpen && !windowClosed;

  return (
    <View style={s.wrap}>
      {/* Location label */}
      {geofence.exactLocationRevealed ? (
        <View style={s.locationCard}>
          <MapPin size={16} color={color.deep} />
          <View style={{ flex: 1 }}>
            <Text style={s.locationLabel}>Meetup location</Text>
            <Text style={s.locationValue}>{geofence.locationLabel ?? geofence.locationName ?? 'Location shared'}</Text>
            {geofence.city && <Text style={s.locationSub}>{geofence.neighborhood ? `${geofence.neighborhood}, ` : ''}{geofence.city}</Text>}
          </View>
        </View>
      ) : (
        <View style={s.hiddenCard}>
          <Info size={15} color={color.mute} />
          <Text style={s.hiddenText}>{geofence.locationLabel ?? 'Exact meetup revealed after acceptance'}</Text>
        </View>
      )}

      {/* My arrival status */}
      <View style={s.statusRow}>
        <Text style={s.statusHeading}>Your status</Text>
        <View style={[s.statusChip, { backgroundColor: cfg.bg }]}>
          <Text style={[s.statusText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
      </View>

      {/* Check-in window info */}
      {geofence.checkInRequired && (
        <View style={s.windowRow}>
          <Clock size={13} color={color.mute} />
          {windowClosed ? (
            <Text style={s.windowText}>Check-in window has closed</Text>
          ) : !windowOpen ? (
            <Text style={s.windowText}>
              Check-in opens {geofence.checkInWindowStart ? new Date(geofence.checkInWindowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'soon'}
            </Text>
          ) : geofence.checkInWindowEnd ? (
            <Text style={s.windowText}>
              Check-in closes at {new Date(geofence.checkInWindowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          ) : (
            <Text style={s.windowText}>Check-in is open</Text>
          )}
        </View>
      )}

      {/* Check-in button */}
      {geofence.checkInRequired && !hasCheckedIn && (
        <Pressable
          style={[s.checkInBtn, (!canCheckIn || loading) && s.checkInBtnDim]}
          onPress={canCheckIn ? handleCheckIn : undefined}
          disabled={!canCheckIn || loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Navigation size={16} color="#fff" />
              <Text style={s.checkInBtnText}>
                {windowClosed ? 'Check-in closed' : !windowOpen ? 'Check-in not open yet' : 'Check in now'}
              </Text>
            </>
          )}
        </Pressable>
      )}

      {hasCheckedIn && (
        <View style={s.arrivedRow}>
          <CheckCircle2 size={18} color={color.success} />
          <Text style={s.arrivedText}>You're checked in! See you there.</Text>
        </View>
      )}

      {/* Peer arrival status (if host allows it) */}
      {geofence.arrivalStatusVisible && (
        <Text style={s.peerNote}>Arrival statuses are visible to all accepted members (no map pins).</Text>
      )}
    </View>
  );
}

// ── Public preview card ───────────────────────────────────────────────────────

function PublicPreviewCard({ geofence }: { geofence: GeofenceData }) {
  const previewText =
    geofence.publicPreviewLevel === 'city_only'   ? geofence.city ?? 'City not disclosed' :
    geofence.publicPreviewLevel === 'venue_tagged' ? (geofence.venueName ?? geofence.neighborhood ?? geofence.city ?? 'General area') :
    geofence.neighborhood ? `${geofence.neighborhood}${geofence.city ? `, ${geofence.city}` : ''}` :
    geofence.city ?? 'General area';

  return (
    <View style={s.publicCard}>
      <MapPin size={16} color={color.mute} />
      <View style={{ flex: 1 }}>
        <Text style={s.publicLabel}>{previewText}</Text>
        <Text style={s.publicSub}>{geofence.exactRevealLabel ?? 'Exact meetup revealed after acceptance'}</Text>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  wrap:          { gap: 10, padding: space.md, backgroundColor: '#F8F7F4', borderRadius: radius.md },
  locationCard:  { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#E2EDF0', borderRadius: radius.sm, padding: 12 },
  locationLabel: { ...t.small, color: color.deep, fontWeight: '700' },
  locationValue: { ...t.body, color: color.ink, fontWeight: '600', marginTop: 2 },
  locationSub:   { ...t.small, color: color.mute, marginTop: 1 },
  hiddenCard:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.haze, borderRadius: radius.sm, padding: 12 },
  hiddenText:    { ...t.small, color: color.mute, flex: 1, lineHeight: 18 },
  statusRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  statusHeading: { ...t.small, color: color.mute, fontWeight: '600' },
  statusChip:    { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  statusText:    { ...t.small, fontWeight: '700' },
  windowRow:     { flexDirection: 'row', alignItems: 'center', gap: 6 },
  windowText:    { ...t.small, color: color.mute },
  checkInBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: color.deep, borderRadius: radius.md, padding: 13 },
  checkInBtnDim: { opacity: 0.5 },
  checkInBtnText:{ ...t.body, color: '#fff', fontWeight: '700' },
  arrivedRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  arrivedText:   { ...t.body, color: color.success, fontWeight: '600' },
  peerNote:      { ...t.small, color: color.faint, lineHeight: 16 },
  publicCard:    { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: color.haze, borderRadius: radius.sm, padding: 12 },
  publicLabel:   { ...t.body, color: color.ink, fontWeight: '600' },
  publicSub:     { ...t.small, color: color.mute, marginTop: 2 },
});
