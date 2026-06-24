/**
 * RentABuddyThreadHeader
 *
 * Shown at the top of a Telegraph thread when threadType === 'rent_buddy_booking'.
 * Displays booking status, start time, meetup location, and quick-action buttons.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Shield, ExternalLink, Clock, MapPin, Plus, Languages } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { getBooking, type BuddyBooking } from '../../services/rentABuddy';

const STATUS_COLORS: Record<string, string> = {
  pending: '#F59E0B',
  confirmed: '#3B82F6',
  in_progress: '#8B5CF6',
  completed: '#10B981',
  cancelled: '#9CA3AF',
  disputed: '#EF4444',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  disputed: 'Disputed',
};

interface Props {
  bookingId: string;
  /** Current translation on/off state from the parent thread */
  autoTranslate?: boolean;
  /** Callback to flip the translation toggle */
  onTranslateToggle?: (value: boolean) => void;
}

export function RentABuddyThreadHeader({ bookingId, autoTranslate = true, onTranslateToggle }: Props) {
  const [booking, setBooking] = useState<BuddyBooking | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getBooking(bookingId).then((res) => {
      if (res.ok) setBooking(res.data.booking);
    }).finally(() => setLoading(false));
  }, [bookingId]);

  if (loading) {
    return (
      <View style={styles.wrap}>
        <ActivityIndicator size="small" color={color.signal} />
      </View>
    );
  }

  if (!booking) return null;

  const statusColor = STATUS_COLORS[booking.status] ?? color.mute;
  const statusLabel = STATUS_LABELS[booking.status] ?? booking.status;
  const isActive = booking.status === 'in_progress';
  // Safety is relevant for both confirmed (about to meet) and in-progress (currently active)
  const showSafety = booking.status === 'confirmed' || isActive;

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.top}>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + '22', borderColor: statusColor }]}>
          <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
          <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
        </View>

        {booking.bookingDate && (
          <View style={styles.metaItem}>
            <Clock size={11} color={color.mute} />
            <Text style={styles.metaText}>
              {fmtDate(booking.bookingDate)}
              {booking.startTime ? ` · ${booking.startTime.slice(0, 5)}` : ''}
            </Text>
          </View>
        )}

        {(booking.routePlan?.[0]?.location || booking.city) && (
          <View style={styles.metaItem}>
            <MapPin size={11} color={color.mute} />
            <Text style={styles.metaText}>
              {booking.routePlan?.[0]?.location ?? booking.city}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.actions}>
        {showSafety && (
          <Pressable
            style={[styles.btn, styles.btnSafety]}
            onPress={() => router.push({ pathname: '/(rent-a-buddy)/active' as any, params: { bookingId } })}
          >
            <Shield size={13} color={color.onInk} />
            <Text style={styles.btnSafetyText}>Safety</Text>
          </Pressable>
        )}

        <Pressable
          style={styles.btn}
          onPress={() => router.push({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: bookingId } })}
        >
          <ExternalLink size={13} color={color.ink} />
          <Text style={styles.btnText}>View Booking</Text>
        </Pressable>

        {showSafety && (
          <Pressable
            style={styles.btn}
            onPress={() => router.push({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: bookingId, action: 'add-time' } })}
          >
            <Plus size={13} color={color.ink} />
            <Text style={styles.btnText}>Add Time</Text>
          </Pressable>
        )}

        {onTranslateToggle && (
          <Pressable
            style={[styles.btn, autoTranslate && styles.btnTranslateOn]}
            onPress={() => onTranslateToggle(!autoTranslate)}
            accessibilityLabel={autoTranslate ? 'Turn off translation' : 'Turn on translation'}
          >
            <Languages size={13} color={autoTranslate ? color.onInk : color.mute} />
            <Text style={[styles.btnText, autoTranslate && styles.btnTranslateOnText]}>
              {autoTranslate ? 'Translating' : 'Translate'}
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: color.paperRaised,
    borderBottomWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontFamily: 'Courier',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaText: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 5,
  },
  btnSafety: {
    backgroundColor: color.signal,
  },
  btnTranslateOn: {
    backgroundColor: '#3B82F6',
  },
  btnText: {
    ...t.small,
    fontWeight: '700',
    color: color.ink,
    fontSize: 12,
  },
  btnSafetyText: {
    ...t.small,
    fontWeight: '700',
    color: color.onInk,
    fontSize: 12,
  },
  btnTranslateOnText: {
    color: '#FFFFFF',
  },
});
