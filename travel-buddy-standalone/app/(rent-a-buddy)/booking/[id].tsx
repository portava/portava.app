import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Alert, Modal,
  TextInput,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, MessageCircle, Clock, MapPin, Shield,
  CheckCircle, AlertTriangle, Star, Flag, ChevronDown, ChevronUp,
  X, Users, Calendar, Plus, Route, Info,
} from 'lucide-react-native';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import { color, space, radius, type as t, shadow, layout, avatar, dot, icon } from '../../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState, TravelCard } from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import { getBooking, cancelBooking, getOrCreateBookingThread, addExtraTime, optInStayConnected, reportBooking, rebookBooking, getBuddyBlockedDates, openDispute, isBookingUnavailable, bookingErrorCopy, type BuddyBooking, type BuddyBlockedRange, type DisputeReason } from '../../../src/services/rentABuddy';
import { disputeErrorMessage } from '../../../src/lib/disputeErrorMessage';
import { GlobalCalendarPicker } from '../../../src/components/selectors/GlobalCalendarPicker';
import { GlobalTimePicker } from '../../../src/components/selectors/GlobalTimePicker';
import { formatDisplayDate, fromISODate, fromHHmm, formatDisplayTime, toISODate } from '../../../src/lib/dateTime/formatters';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlainBottomInset } from '../../../src/hooks/useBottomInset';

type BookingStatus = BuddyBooking['status'];

const STATUS_LABELS: Record<BookingStatus, string> = {
  requested: 'Requested',
  scheduled: 'Confirmed',
  in_progress: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
  disputed: 'Disputed',
  expired: 'Expired',
  no_show_pending: 'No-Show Review',
};

const STATUS_COLORS: Record<BookingStatus, string> = {
  requested: color.warn,
  scheduled: color.deep,
  in_progress: color.success,
  completed: color.mute,
  cancelled: color.haze,
  disputed: color.signal,
  expired: color.haze,
  no_show_pending: color.signal,
};

/**
 * Statuses for which the backend permits thread creation/retrieval.
 * Mirrors the server's `threadAllowedStatuses` in rentABuddy.ts route handler.
 * Any status NOT in this list must not call getOrCreateBookingThread — the API
 * returns an error and the UI would show a confusing dead-end alert.
 */
const THREAD_ELIGIBLE_STATUSES: BookingStatus[] = [
  'scheduled',
  'in_progress',
  'completed',
  'disputed',
];

function StatusBadge({ status }: { status: BookingStatus }) {
  const col = STATUS_COLORS[status];
  return (
    <View style={[sb.pill, { borderColor: col }]}>
      <View style={[sb.dot, { backgroundColor: col }]} />
      <Text style={[sb.text, { color: col }]}>{STATUS_LABELS[status]}</Text>
    </View>
  );
}

function BuddySummaryRow({ buddyId, city }: { buddyId: string; city: string }) {
  return (
    <Pressable
      style={buddy.row}
      onPress={() => router.push(`/(rent-a-buddy)/buddy/${buddyId}` as any)}
    >
      <View style={buddy.avatar}>
        <Text style={buddy.initial}>B</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={buddy.name}>Your Buddy</Text>
        <Text style={buddy.city}>{city}</Text>
      </View>
      <View style={buddy.ratingPill}>
        <Star size={11} color={color.warn} fill={color.warn} />
        <Text style={buddy.ratingText}>View profile</Text>
      </View>
    </Pressable>
  );
}

function MeetupBlock({ city }: { city: string }) {
  return (
    <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
      <Text style={styles.sectionHeading}>Meetup plan</Text>

      {/* Honest map coming-soon state — MapLibre requires native runtime */}
      <View style={map.comingSoon}>
        <MapPin size={20} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={map.comingSoonLabel}>Map — coming soon</Text>
          <Text style={map.comingSoonCity}>{city} · Public meetup zone</Text>
          <Text style={map.comingSoonHint}>
            Interactive map is on the roadmap. Your Buddy will confirm the exact public meeting spot after booking.
          </Text>
        </View>
      </View>

      {/* Route plan */}
      <Text style={[styles.sectionHeading, { marginTop: space.lg }]}>Route & plan</Text>
      {[
        { step: 1, label: 'Meet at public zone', note: 'Confirmed with your Buddy' },
        { step: 2, label: 'Review plan together', note: 'Set boundaries & expectations' },
        { step: 3, label: 'Experience begins', note: 'Enjoy with safety features active' },
        { step: 4, label: 'Check out via app', note: 'Rate your Buddy & end session' },
      ].map(item => (
        <View key={item.step} style={route.item}>
          <View style={route.stepBadge}>
            <Text style={route.stepNum}>{item.step}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={route.stepLabel}>{item.label}</Text>
            <Text style={route.stepNote}>{item.note}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

function SafetyPanel({ open, onToggle, onReport }: { open: boolean; onToggle: () => void; onReport: () => void }) {
  return (
    <View style={safety.wrap}>
      <Pressable style={safety.header} onPress={onToggle}>
        <Shield size={16} color={color.success} />
        <Text style={safety.title}>Safety panel</Text>
        {open ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
      </Pressable>
      {open && (
        <View style={safety.body}>
          <View style={safety.item}>
            <CheckCircle size={13} color={color.success} />
            <Text style={safety.itemText}>Share location with Trusted Circle</Text>
          </View>
          <View style={safety.item}>
            <CheckCircle size={13} color={color.success} />
            <Text style={safety.itemText}>Meetup starts at a public location</Text>
          </View>
          <View style={safety.item}>
            <AlertTriangle size={13} color={color.warn} />
            <Text style={safety.itemText}>Never pay cash before the meetup starts</Text>
          </View>
          <Pressable style={safety.reportBtn} onPress={onReport}>
            <Flag size={12} color={color.signal} />
            <Text style={safety.reportText}>Report an issue</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function AddTimeModal({ visible, onClose, onAdd }: { visible: boolean; onClose: () => void; onAdd: (h: number) => void }) {
  const [hours, setHours] = useState(1);
  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardSafeScrollView>
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <Text style={modal.title}>Add more time?</Text>
          <Text style={modal.sub}>Extend your session with this Buddy.</Text>
          <View style={modal.stepper}>
            <Pressable style={modal.stepBtn} onPress={() => setHours(h => Math.max(1, h - 1))}>
              <Text style={modal.stepBtnText}>−</Text>
            </Pressable>
            <Text style={modal.stepValue}>{hours} hour{hours !== 1 ? 's' : ''}</Text>
            <Pressable style={modal.stepBtn} onPress={() => setHours(h => Math.min(8, h + 1))}>
              <Text style={modal.stepBtnText}>+</Text>
            </Pressable>
          </View>
          <View style={modal.actions}>
            <Pressable style={modal.cancelBtn} onPress={onClose}>
              <Text style={modal.cancelBtnText}>Never mind</Text>
            </Pressable>
            <Pressable style={modal.confirmBtn} onPress={() => { onAdd(hours); onClose(); }}>
              <Text style={modal.confirmBtnText}>Add {hours}h</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

/** Expand blocked ranges into individual ISO dates (capped at 366 days per range). */
function expandBlockedRanges(ranges: BuddyBlockedRange[]): string[] {
  const out: string[] = [];
  for (const r of ranges) {
    const start = fromISODate(r.startDate);
    const end = fromISODate(r.endDate) ?? start;
    if (!start || !end) continue;
    const d = new Date(start);
    for (let i = 0; i <= 366 && d <= end; i++) {
      out.push(toISODate(d));
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

function RebookModal({ visible, onClose, onRebook, disabledDates }: { visible: boolean; onClose: () => void; onRebook: (date: string, time: string) => void; disabledDates?: string[] }) {
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const dateValid = date.length > 0;
  const timeValid = time.length > 0;
  const dateLabel = date ? (() => { const d = fromISODate(date); return d ? formatDisplayDate(d) : date; })() : null;
  const timeLabel = time ? (() => { const d = fromHHmm(time); return d ? formatDisplayTime(d) : time; })() : null;
  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardSafeScrollView>
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <Text style={modal.title}>Book again?</Text>
          <Text style={modal.sub}>Same Buddy, same service. Choose a new date and start time.</Text>
          <Pressable style={modal.input} onPress={() => setShowDatePicker(true)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Calendar size={14} color={date ? color.ink : color.haze} />
              <Text style={{ color: date ? color.ink : color.haze }}>
                {dateLabel ?? 'Select date'}
              </Text>
            </View>
          </Pressable>
          <Pressable style={[modal.input, { marginTop: 8 }]} onPress={() => setShowTimePicker(true)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Clock size={14} color={time ? color.ink : color.haze} />
              <Text style={{ color: time ? color.ink : color.haze }}>
                {timeLabel ?? 'Select start time'}
              </Text>
            </View>
          </Pressable>
          <GlobalCalendarPicker
            visible={showDatePicker}
            mode="single"
            value={date || null}
            minDate={today}
            title="New booking date"
            disabledDates={disabledDates}
            disabledDatesNote="Crossed-out dates are unavailable — this Buddy is away or fully blocked."
            onConfirm={(v) => { setDate(v ?? ''); setShowDatePicker(false); }}
            onCancel={() => setShowDatePicker(false)}
          />
          <GlobalTimePicker
            visible={showTimePicker}
            value={time || null}
            title="Start time"
            onChange={(v) => setTime(v ?? '')}
            onClose={() => setShowTimePicker(false)}
          />
          <View style={modal.actions}>
            <Pressable style={modal.cancelBtn} onPress={onClose}>
              <Text style={modal.cancelBtnText}>Never mind</Text>
            </Pressable>
            <Pressable
              style={[modal.confirmBtn, !(dateValid && timeValid) && { opacity: 0.4 }]}
              onPress={() => {
                if (dateValid && timeValid) { onRebook(date, time); onClose(); }
              }}
            >
              <Text style={modal.confirmBtnText}>Book</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

function CancelModal({ visible, onClose, onConfirm }: { visible: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardSafeScrollView>
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <Text style={modal.title}>Cancel booking?</Text>
          <Text style={modal.sub}>This cannot be undone. Cancellation fees may apply per policy.</Text>
          <TextInput
            style={modal.input}
            value={reason}
            onChangeText={setReason}
            placeholder="Reason for cancellation (optional)"
            placeholderTextColor={color.haze}
            multiline
          />
          <View style={modal.actions}>
            <Pressable style={modal.cancelBtn} onPress={onClose}>
              <Text style={modal.cancelBtnText}>Keep booking</Text>
            </Pressable>
            <Pressable style={modal.confirmBtn} onPress={() => onConfirm(reason)}>
              <Text style={modal.confirmBtnText}>Cancel booking</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

const DISPUTE_REASONS: { value: DisputeReason; label: string }[] = [
  { value: 'cash_balance_disagreement', label: 'Cash balance disagreement' },
  { value: 'no_show', label: 'Buddy did not show up' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'policy_violation', label: 'Policy violation' },
  { value: 'route_violation', label: 'Route violation' },
  { value: 'other', label: 'Other' },
];

function DisputeModal({ visible, submitting, onClose, onConfirm }: {
  visible: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (reason: DisputeReason) => void;
}) {
  const [reason, setReason] = useState<DisputeReason | null>(null);
  return (
    <Modal visible={visible} transparent animationType="slide">
      <KeyboardSafeScrollView>
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <Text style={modal.title}>Open a dispute?</Text>
          <Text style={modal.sub}>Our team will review the booking. Pick the reason that fits best.</Text>
          {DISPUTE_REASONS.map(opt => (
            <Pressable
              key={opt.value}
              style={[disputeStyles.reasonRow, reason === opt.value && disputeStyles.reasonRowActive]}
              onPress={() => setReason(opt.value)}
            >
              <View style={[disputeStyles.radio, reason === opt.value && disputeStyles.radioActive]} />
              <Text style={disputeStyles.reasonLabel}>{opt.label}</Text>
            </Pressable>
          ))}
          <View style={modal.actions}>
            <Pressable style={modal.cancelBtn} onPress={onClose} disabled={submitting}>
              <Text style={modal.cancelBtnText}>Never mind</Text>
            </Pressable>
            <Pressable
              style={[modal.confirmBtn, (!reason || submitting) && { opacity: 0.4 }]}
              disabled={!reason || submitting}
              onPress={() => { if (reason) onConfirm(reason); }}
            >
              <Text style={modal.confirmBtnText}>{submitting ? 'Submitting…' : 'Open dispute'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

const disputeStyles = StyleSheet.create({
  reasonRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingVertical: space.sm, paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  reasonRowActive: { backgroundColor: color.paper },
  radio: {
    width: icon.s16, height: icon.s16, borderRadius: icon.s16 / 2,
    borderWidth: 2, borderColor: color.haze,
  },
  radioActive: { borderColor: color.signal, backgroundColor: color.signal },
  reasonLabel: { ...t.body, color: color.ink },
});

export default function BookingDetail() {
  const insets = useSafeAreaInsets();
  const plainInset = usePlainBottomInset();
  const { id, fromCheckout } = useLocalSearchParams<{ id: string; fromCheckout?: string }>();
  const [booking, setBooking] = useState<BuddyBooking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmBannerVisible, setConfirmBannerVisible] = useState(fromCheckout === '1');
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [cancelVisible, setCancelVisible] = useState(false);
  const [addTimeVisible, setAddTimeVisible] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rebookVisible, setRebookVisible] = useState(false);
  const [disputeVisible, setDisputeVisible] = useState(false);
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  const [blockedRanges, setBlockedRanges] = useState<BuddyBlockedRange[]>([]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const res = await getBooking(id);
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setBooking(res.data.booking);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Auto-dismiss the post-checkout confirmation banner after 4 seconds.
  useEffect(() => {
    if (!confirmBannerVisible) return;
    bannerTimerRef.current = setTimeout(() => setConfirmBannerVisible(false), 4000);
    return () => { if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current); };
  }, [confirmBannerVisible]);

  // Load the buddy's blocked/vacation dates so reschedule pickers grey them out.
  useEffect(() => {
    const buddyId = booking?.buddyId;
    if (!buddyId) return;
    let alive = true;
    getBuddyBlockedDates(buddyId).then((res) => {
      if (alive && res.ok) setBlockedRanges(res.data.blocked ?? []);
    });
    return () => { alive = false; };
  }, [booking?.buddyId]);

  const blockedDates = React.useMemo(() => expandBlockedRanges(blockedRanges), [blockedRanges]);

  const handleCancel = async (reason: string) => {
    if (!booking) return;
    setCancelling(true);
    const res = await cancelBooking(booking.id, reason);
    setCancelling(false);
    setCancelVisible(false);
    if (res.ok) {
      setBooking(prev => prev ? { ...prev, status: 'cancelled' } : prev);
      Alert.alert('Booking cancelled', 'Your booking has been cancelled.');
    } else {
      Alert.alert('Error', res.error);
    }
  };

  const handleDispute = async (reason: DisputeReason) => {
    if (!booking) return;
    setDisputeSubmitting(true);
    const res = await openDispute(booking.id, reason);
    setDisputeSubmitting(false);
    setDisputeVisible(false);
    if (res.ok) {
      setBooking(prev => prev ? { ...prev, status: 'disputed' } : prev);
      Alert.alert('Dispute opened', 'Our team will review this booking and follow up with you.');
    } else if (res.error === 'no_show_in_progress') {
      Alert.alert(
        'No-show report already open',
        'A no-show report is already open — it will escalate to a dispute automatically.',
      );
    } else {
      Alert.alert('Could not open dispute', disputeErrorMessage(res.error));
    }
  };

  if (loading) return <TravelLoadingState label="Loading booking…" />;
  if (error || !booking) return <TravelErrorState title="Couldn't load booking" sub={error ?? undefined} onRetry={load} />;

  const isActive = booking.status === 'in_progress';
  const isCompleted = booking.status === 'completed';
  const isCancellable = booking.status === 'requested' || booking.status === 'scheduled';
  const cashBalance = Math.round(booking.totalUsd * 0.7);
  const deposit = Math.round(booking.totalUsd * 0.3);
  const serviceFee = Math.round(booking.totalUsd * 0.12);

  return (
    <View style={styles.page}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable style={styles.backBtn} onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}>
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Booking</Text>
        <StatusBadge status={booking.status} />
      </View>

      {confirmBannerVisible && (
        <View style={styles.confirmBanner}>
          <CheckCircle size={16} color={color.success} />
          <Text style={styles.confirmBannerText}>Request sent! Waiting for your Buddy to confirm.</Text>
          <Pressable onPress={() => setConfirmBannerVisible(false)} hitSlop={8}>
            <X size={14} color={color.success} />
          </Pressable>
        </View>
      )}

      <ScrollView
        contentContainerStyle={{ paddingBottom: plainInset }}
        showsVerticalScrollIndicator={false}
        onScrollBeginDrag={() => { if (confirmBannerVisible) setConfirmBannerVisible(false); }}
      >
        {/* Buddy profile summary */}
        <BuddySummaryRow buddyId={booking.buddyId} city={booking.city} />

        {/* Date / duration / group grid */}
        <View style={styles.infoGrid}>
          <View style={styles.infoCell}>
            <Calendar size={16} color={color.deep} />
            <Text style={styles.infoCellLabel}>Date</Text>
            <Text style={styles.infoCellVal}>{booking.bookingDate}</Text>
          </View>
          <View style={styles.infoCellDivider} />
          <View style={styles.infoCell}>
            <Clock size={16} color={color.deep} />
            <Text style={styles.infoCellLabel}>Duration</Text>
            <Text style={styles.infoCellVal}>{booking.durationH}h</Text>
          </View>
          <View style={styles.infoCellDivider} />
          <View style={styles.infoCell}>
            <Users size={16} color={color.deep} />
            <Text style={styles.infoCellLabel}>Group</Text>
            <Text style={styles.infoCellVal}>{booking.groupSize}</Text>
          </View>
        </View>

        {/* Category */}
        <View style={{ paddingHorizontal: space.lg, marginTop: space.md }}>
          <Stamp label={booking.category} tone="deep" rotate={0} />
        </View>

        {/* Meetup plan: map placeholder + route steps */}
        <MeetupBlock city={booking.city} />

        {/* Cash balance reminder */}
        {cashBalance > 0 && booking.status !== 'cancelled' && (
          <View style={[styles.cashBanner, { marginHorizontal: space.lg, marginTop: space.md }]}>
            <AlertTriangle size={16} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cashTitle}>Cash balance reminder</Text>
              <Text style={styles.cashSub}>
                ${cashBalance} is due in cash to your Buddy at the end of the meetup. Keep exact change if possible.
              </Text>
            </View>
          </View>
        )}

        {/* Payment summary */}
        <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
          <Text style={styles.sectionHeading}>Payment summary</Text>
          <TravelCard style={{ marginTop: space.sm }}>
            <View style={styles.priceRow}>
              <Text style={styles.priceKey}>Subtotal</Text>
              <Text style={styles.priceVal}>${booking.totalUsd}</Text>
            </View>
            <View style={styles.priceRow}>
              <Text style={styles.priceKey}>Deposit</Text>
              <Text style={styles.priceVal}>${deposit}</Text>
            </View>
            <View style={styles.priceRow}>
              <Text style={styles.priceKey}>Service fee</Text>
              <Text style={styles.priceVal}>${serviceFee}</Text>
            </View>
            {cashBalance > 0 && (
              <View style={styles.priceRow}>
                <Text style={[styles.priceKey, { color: color.warn }]}>Cash to Buddy</Text>
                <Text style={[styles.priceVal, { color: color.warn }]}>${cashBalance}</Text>
              </View>
            )}
          </TravelCard>
          <View style={styles.paymentDisclosure}>
            <Info size={12} color={color.deep} />
            <Text style={styles.paymentDisclosureText}>
              No payment is charged through the app. Payment is agreed directly with your Buddy after booking confirmation.
            </Text>
          </View>
        </View>

        {/* Safety panel */}
        {(isActive || booking.status === 'scheduled') && (
          <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
            <SafetyPanel
              open={safetyOpen || isActive}
              onToggle={() => setSafetyOpen(o => !o)}
              onReport={() => {
                Alert.alert(
                  'Report an issue',
                  'Flag this booking for a safety review?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Report',
                      style: 'destructive',
                      onPress: async () => {
                        const res = await reportBooking(id as string, { reason: 'safety_concern' });
                        if (res.ok) {
                          Alert.alert('Report submitted', 'Our safety team will review this booking.');
                        } else {
                          Alert.alert('Error', 'Could not submit report. Please try again.');
                        }
                      },
                    },
                  ],
                );
              }}
            />
          </View>
        )}

        {/* Notes */}
        {booking.notes && (
          <View style={{ paddingHorizontal: space.lg, marginTop: space.lg }}>
            <Text style={styles.sectionHeading}>Notes</Text>
            <Text style={[styles.priceKey, { marginTop: space.sm }]}>{booking.notes}</Text>
          </View>
        )}

        {/* Actions */}
        <View style={{ paddingHorizontal: space.lg, marginTop: space.xl, gap: space.md }}>
          {isActive && (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, styles.actionBtnPrimary, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => router.push({ pathname: '/(rent-a-buddy)/active' as any, params: { bookingId: id } })}
            >
              <Text style={styles.actionBtnTextPrimary}>Open Active Session</Text>
            </Pressable>
          )}

          {(isActive || booking.status === 'scheduled') && (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => setAddTimeVisible(true)}
            >
              <Plus size={16} color={color.deep} />
              <Text style={styles.actionBtnText}>Add time</Text>
            </Pressable>
          )}

          {/* Message button — the backend only allows thread creation for the statuses in
              THREAD_ELIGIBLE_STATUSES (mirrors the server's threadAllowedStatuses list).
              Statuses outside that set never reach the API to avoid dead-end error alerts. */}
          {THREAD_ELIGIBLE_STATUSES.includes(booking.status) ? (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={async () => {
                const threadRes = await getOrCreateBookingThread(id as string);
                if (threadRes.ok && threadRes.data?.threadId) {
                  router.push({
                    pathname: '/messages/[id]' as any,
                    params: {
                      id: threadRes.data.threadId,
                      threadType: 'rent_buddy_booking',
                      contextId: id,
                      title: `Booking with ${booking.city}`,
                    },
                  });
                } else {
                  // Never push a user id into /messages/[id] (it expects a THREAD id).
                  Alert.alert('Could not open chat', 'Please try again in a moment.');
                }
              }}
            >
              <MessageCircle size={16} color={color.ink} />
              <Text style={styles.actionBtnText}>Message your Buddy</Text>
            </Pressable>
          ) : booking.status === 'requested' ? (
            // Thread is created server-side only after Buddy accepts — show a clear pending state.
            <View style={[styles.actionBtn, styles.actionBtnPending]}>
              <MessageCircle size={16} color={color.mute} />
              <Text style={styles.actionBtnTextMuted}>Chat available after Buddy accepts</Text>
            </View>
          ) : null}

          {isCompleted && (
            <>
              <Pressable
                style={({ pressed }) => [styles.actionBtn, styles.actionBtnSignal, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => router.push({ pathname: '/(rent-a-buddy)/review' as any, params: { bookingId: id } })}
              >
                <Star size={16} color={color.onInk} />
                <Text style={styles.actionBtnTextPrimary}>Leave a review</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
                onPress={() => setRebookVisible(true)}
              >
                <Calendar size={16} color={color.deep} />
                <Text style={styles.actionBtnText}>Book again</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
                onPress={async () => {
                  const res = await optInStayConnected(id as string);
                  Alert.alert(
                    res.ok ? 'Stay Connected opted in' : 'Error',
                    res.ok
                      ? 'You\'ve opted to keep the chat open. If your Buddy also opts in, the thread will stay active.'
                      : (res.error ?? 'Could not opt in'),
                  );
                }}
              >
                <MessageCircle size={16} color={color.deep} />
                <Text style={styles.actionBtnText}>Stay connected</Text>
              </Pressable>
            </>
          )}

          {(isActive || booking.status === 'no_show_pending') && (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => setDisputeVisible(true)}
            >
              <Flag size={16} color={color.signal} />
              <Text style={[styles.actionBtnText, { color: color.signal }]}>Open a dispute</Text>
            </Pressable>
          )}

          {isCancellable && (
            <Pressable
              style={({ pressed }) => [styles.actionBtn, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => setCancelVisible(true)}
            >
              <X size={16} color={color.signal} />
              <Text style={[styles.actionBtnText, { color: color.signal }]}>Cancel booking</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      <AddTimeModal
        visible={addTimeVisible}
        onClose={() => setAddTimeVisible(false)}
        onAdd={async (h) => {
          const res = await addExtraTime(id as string, h);
          if (res.ok) {
            setBooking(prev => prev ? { ...prev, durationH: res.data?.newDurationH ?? prev.durationH + h } : prev);
            Alert.alert('Time added', `${h} hour${h !== 1 ? 's' : ''} added to your session.`);
          } else {
            Alert.alert('Error', res.error ?? 'Could not add time');
          }
        }}
      />

      <DisputeModal
        visible={disputeVisible}
        submitting={disputeSubmitting}
        onClose={() => setDisputeVisible(false)}
        onConfirm={handleDispute}
      />

      <CancelModal
        visible={cancelVisible}
        onClose={() => setCancelVisible(false)}
        onConfirm={handleCancel}
      />

      <RebookModal
        visible={rebookVisible}
        disabledDates={blockedDates}
        onClose={() => setRebookVisible(false)}
        onRebook={async (date, time) => {
          const res = await rebookBooking(id as string, { bookingDate: date, startTime: time });
          if (!res.ok) {
            // /api/buddy-bookings/:id/rebook is rewritten to the KYC-gated
            // /rent-a-buddy/bookings/:id/rebook, so this path can answer 503
            // verification_unavailable while Rent a Buddy is closed. An Alert
            // is fine here — there is no long form behind it — but the copy
            // must never be the raw code.
            Alert.alert(
              isBookingUnavailable(res.error) ? 'Not available yet' : 'Could not rebook',
              bookingErrorCopy(res.error),
            );
          } else if (res.data?.bookingId) {
            const newId = res.data.bookingId;
            Alert.alert('Booking requested!', 'Your new booking has been sent to the Buddy for confirmation.', [
              { text: 'View booking', onPress: () => router.push({ pathname: '/(rent-a-buddy)/booking/[id]' as any, params: { id: newId } }) },
              { text: 'OK' },
            ]);
          } else {
            Alert.alert('Could not rebook', 'Please try again.');
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.heading, color: color.ink, flex: 1 },
  infoGrid: {
    flexDirection: 'row', backgroundColor: color.paperRaised,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  infoCell: { flex: 1, alignItems: 'center', paddingVertical: space.lg, gap: 4 },
  infoCellDivider: { width: 1, backgroundColor: color.haze },
  infoCellLabel: { ...t.small, color: color.mute },
  infoCellVal: { ...t.bodyStrong, color: color.ink },
  cashBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    backgroundColor: '#FFF8ED', borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.warn,
  },
  cashTitle: { ...t.small, fontWeight: '700', color: color.warn },
  cashSub: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 16 },
  sectionHeading: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  priceRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  priceKey: { ...t.body, color: color.mute },
  priceVal: { ...t.body, fontWeight: '600', color: color.ink },
  paymentDisclosure: { flexDirection: 'row', alignItems: 'flex-start', gap: space.xs, marginTop: space.sm },
  paymentDisclosureText: { ...t.small, color: color.deep, flex: 1, lineHeight: 16 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, paddingVertical: space.md,
  },
  actionBtnPrimary: { backgroundColor: color.ink, borderColor: color.ink },
  actionBtnSignal: { backgroundColor: color.signal, borderColor: color.signal },
  actionBtnText: { ...t.bodyStrong, color: color.ink },
  actionBtnTextPrimary: { ...t.bodyStrong, color: color.onInk },
  actionBtnPending: { backgroundColor: color.haze, borderColor: color.haze, opacity: 0.7 },
  actionBtnTextMuted: { ...t.bodyStrong, color: color.mute },
  confirmBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#EDF7F0', borderBottomWidth: 1, borderBottomColor: color.success,
    paddingHorizontal: space.lg, paddingVertical: space.md,
  },
  confirmBannerText: { ...t.body, color: color.success, flex: 1, fontWeight: '600' },
});

const buddy = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, backgroundColor: color.paperRaised,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  avatar: {
    width: avatar.s44, height: avatar.s44, borderRadius: avatar.s44 / 2,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  initial: { fontSize: 18, fontWeight: '700', color: color.onInk },
  name: { ...t.bodyStrong, color: color.ink },
  city: { ...t.small, color: color.mute },
  ratingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#FFF8ED', borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 4,
  },
  ratingText: { fontSize: 10, fontWeight: '700', color: color.warn, fontFamily: 'Courier' },
});

const map = StyleSheet.create({
  comingSoon: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.md,
  },
  comingSoonLabel: { ...t.bodyStrong, color: color.ink },
  comingSoonCity: { ...t.small, color: color.deep, marginTop: 2 },
  comingSoonHint: { ...t.small, color: color.mute, marginTop: 4, lineHeight: 16 },
});

const route = StyleSheet.create({
  item: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  stepBadge: {
    width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  stepNum: { fontSize: 11, fontWeight: '800', color: color.onInk, fontFamily: 'Courier' },
  stepLabel: { ...t.bodyStrong, color: color.ink },
  stepNote: { ...t.small, color: color.mute, marginTop: 2 },
});

const sb = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 999, borderWidth: 1, paddingHorizontal: space.sm, paddingVertical: 4 },
  dot: { width: dot.s6, height: dot.s6, borderRadius: dot.s6 / 2 },
  text: { fontSize: 11, fontWeight: '700', fontFamily: 'Courier', letterSpacing: 0.3 },
});

const safety = StyleSheet.create({
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.success, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  title: { ...t.bodyStrong, color: color.ink, flex: 1 },
  body: { padding: space.md, borderTopWidth: 1, borderTopColor: color.haze, gap: space.sm },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  itemText: { ...t.body, color: color.ink },
  reportBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  reportText: { ...t.small, color: color.signal, fontWeight: '600' },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: color.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: space.xl, gap: space.md },
  title: { ...t.title, color: color.ink },
  sub: { ...t.body, color: color.mute },
  input: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, ...t.body, color: color.ink, height: 80, textAlignVertical: 'top' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.lg, justifyContent: 'center', paddingVertical: space.sm },
  stepBtn: { width: avatar.s44, height: avatar.s44, borderRadius: avatar.s44 / 2, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised },
  stepBtnText: { fontSize: 22, color: color.ink, fontWeight: '600' },
  stepValue: { ...t.bodyStrong, color: color.ink, minWidth: 100, textAlign: 'center', fontSize: 18 },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  cancelBtn: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, alignItems: 'center' },
  cancelBtnText: { ...t.bodyStrong, color: color.ink },
  confirmBtn: { flex: 1, borderRadius: radius.md, backgroundColor: color.signal, padding: space.md, alignItems: 'center' },
  confirmBtnText: { ...t.bodyStrong, color: color.onInk },
});
