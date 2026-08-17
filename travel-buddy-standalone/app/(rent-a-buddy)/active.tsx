import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Alert, Modal, Switch, Linking, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ArrowLeft, Shield, AlertTriangle, MapPin, Phone,
  Flag, CheckCircle, Plus, X, Zap, Users,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow, layout, avatar } from '../../src/theme/tokens';
import { TravelLoadingState, TravelErrorState } from '../../src/components/primitives';
import { getBooking, addExtraTime, reportBooking, safetyCheckin, feelUnsafe, endBookingEarly, type BuddyBooking, bookingErrorCopy } from '../../src/services/rentABuddy';
import {
  getActiveSession,
  startLiveShare,
  stopLiveShare,
  getSessionContacts,
  type SessionContact,
} from '../../src/services/safeReturn';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStickyBarInset } from '../../src/hooks/useBottomInset';

function pad(n: number) { return String(n).padStart(2, '0'); }

function formatElapsed(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function ContactPickerModal({
  visible, contacts, onClose, onSelect, loading,
}: {
  visible: boolean;
  contacts: SessionContact[];
  onClose: () => void;
  onSelect: (contact: SessionContact) => void;
  loading: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
            <Users size={18} color={color.success} />
            <Text style={modal.title}>Share with…</Text>
          </View>
          <Text style={modal.sub}>Select a trusted contact to receive your live location.</Text>
          {loading ? (
            <ActivityIndicator color={color.success} style={{ marginVertical: space.lg }} />
          ) : contacts.length === 0 ? (
            <Text style={[modal.sub, { color: color.mute, marginTop: space.md }]}>
              No eligible contacts found. Add trusted contacts with live location access to your Safe Return session.
            </Text>
          ) : (
            <View style={{ gap: space.sm, marginTop: space.sm }}>
              {contacts.map((c) => (
                <Pressable
                  key={c.id}
                  style={({ pressed }) => [picker.contactRow, pressed && { opacity: layout.pressedOpacity }]}
                  onPress={() => onSelect(c)}
                >
                  <View style={picker.avatar}>
                    <Text style={picker.avatarText}>{(c.contactName ?? 'C')[0].toUpperCase()}</Text>
                  </View>
                  <Text style={picker.contactName}>{c.contactName ?? 'Trusted contact'}</Text>
                  <View style={picker.livePill}>
                    <Text style={picker.livePillText}>LIVE</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          )}
          <Pressable style={[modal.cancelBtn, { marginTop: space.md }]} onPress={onClose}>
            <Text style={modal.cancelBtnText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function AddTimeModal({ visible, onClose, onAdd }: { visible: boolean; onClose: () => void; onAdd: (h: number) => void }) {
  const [hours, setHours] = useState(1);
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <Text style={modal.title}>Add time</Text>
          <Text style={modal.sub}>Extend your session with your Buddy. Rate: same as booked.</Text>
          <View style={modal.stepper}>
            <Pressable style={modal.stepBtn} onPress={() => setHours(h => Math.max(1, h - 1))}>
              <Text style={modal.stepBtnText}>−</Text>
            </Pressable>
            <Text style={modal.stepVal}>{hours} hour{hours !== 1 ? 's' : ''}</Text>
            <Pressable style={modal.stepBtn} onPress={() => setHours(h => Math.min(6, h + 1))}>
              <Text style={modal.stepBtnText}>+</Text>
            </Pressable>
          </View>
          <View style={modal.actions}>
            <Pressable style={modal.cancelBtn} onPress={onClose}>
              <Text style={modal.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable style={modal.addBtn} onPress={() => { onAdd(hours); onClose(); }}>
              <Text style={modal.addBtnText}>Add {hours}h</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function EndModal({ visible, onClose, onEnd }: { visible: boolean; onClose: () => void; onEnd: () => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <Text style={modal.title}>End session?</Text>
          <Text style={modal.sub}>Are you sure you want to end your meetup with your Buddy? Make sure any cash balance has been settled.</Text>
          <View style={modal.actions}>
            <Pressable style={modal.cancelBtn} onPress={onClose}>
              <Text style={modal.cancelBtnText}>Keep going</Text>
            </Pressable>
            <Pressable style={[modal.addBtn, { backgroundColor: color.signal }]} onPress={onEnd}>
              <Text style={modal.addBtnText}>End session</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function RentABuddyActive() {
  const insets = useSafeAreaInsets();
  const { inset: barInset, onBarLayout } = useStickyBarInset();
  const params = useLocalSearchParams<{ bookingId?: string }>();
  const bookingId = params.bookingId ?? '';

  const [booking, setBooking] = useState<BuddyBooking | null>(null);
  const [loading, setLoading] = useState(!!bookingId);
  const [error, setError] = useState<string | null>(null);

  const [elapsed, setElapsed] = useState(0);
  const [addedH, setAddedH] = useState(0);
  const [safeReturn, setSafeReturn] = useState(false);
  const [circleShare, setCircleShare] = useState(false);
  const [circleShareLoading, setCircleShareLoading] = useState(false);
  const [shareId, setShareId] = useState<string | null>(null);
  const [shareRecipientName, setShareRecipientName] = useState<string | null>(null);
  const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [safeReturnSessionId, setSafeReturnSessionId] = useState<string | null>(null);
  const [contactPickerVisible, setContactPickerVisible] = useState(false);
  const [contactPickerLoading, setContactPickerLoading] = useState(false);
  const [sessionContacts, setSessionContacts] = useState<SessionContact[]>([]);
  const [addTimeVisible, setAddTimeVisible] = useState(false);
  const [endVisible, setEndVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!bookingId) return;
    setLoading(true);
    const res = await getBooking(bookingId);
    setLoading(false);
    if (!res.ok) { setError(res.error); return; }
    setBooking(res.data.booking);
  }, [bookingId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Minute tick so the share-expiry countdown updates live while a share is active.
  useEffect(() => {
    if (!shareExpiresAt) return;
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [shareExpiresAt]);

  // Fetch the active safe-return session so we can wire live-share to it.
  useEffect(() => {
    getActiveSession().then(({ session }) => {
      if (session && session.liveShareEnabled) {
        setSafeReturnSessionId(session.id);
      }
    }).catch(() => {});
  }, []);

  const handleCircleShareToggle = useCallback(async (value: boolean) => {
    if (value) {
      // Toggle ON ─ require an active Safe Return session with live share enabled.
      if (!safeReturnSessionId) {
        Alert.alert(
          'Safe Return required',
          'Start a Safe Return session with live share enabled first, then you can share your location with a trusted contact.',
        );
        return; // Leave toggle OFF.
      }
      setCircleShareLoading(true);
      setContactPickerLoading(true);
      setContactPickerVisible(true);
      try {
        const contacts = await getSessionContacts(safeReturnSessionId);
        setSessionContacts(contacts.filter(c => c.canReceiveLiveLocation));
      } catch {
        setSessionContacts([]);
      } finally {
        setContactPickerLoading(false);
        setCircleShareLoading(false);
      }
    } else {
      // Toggle OFF ─ stop the active share.
      if (!shareId || !safeReturnSessionId) {
        setCircleShare(false);
        setShareId(null);
        setShareRecipientName(null);
        setShareExpiresAt(null);
        return;
      }
      setCircleShareLoading(true);
      const res = await stopLiveShare(safeReturnSessionId, shareId);
      setCircleShareLoading(false);
      if (res.ok) {
        setShareId(null);
        setCircleShare(false);
        setShareRecipientName(null);
        setShareExpiresAt(null);
      } else {
        Alert.alert('Error', bookingErrorCopy(res.error, 'Could not stop live share. Please try again.'));
        // Revert: keep toggle ON since the share is still active.
      }
    }
  }, [safeReturnSessionId, shareId]);

  const handleContactSelected = useCallback(async (contact: SessionContact) => {
    setContactPickerVisible(false);
    if (!safeReturnSessionId) return;
    setCircleShareLoading(true);
    const res = await startLiveShare(safeReturnSessionId, { recipientContactId: contact.id, durationMinutes: 60 });
    setCircleShareLoading(false);
    if (res.ok && res.share) {
      setShareId(res.share.id);
      setShareRecipientName(contact.contactName ?? 'Trusted contact');
      setShareExpiresAt(res.share.expiresAt ?? null);
      setNowTick(Date.now());
      setCircleShare(true);
    } else {
      // Show error and leave toggle OFF.
      Alert.alert(
        'Could not start live share',
        res.error ?? 'Please check your Safe Return session settings and try again.',
      );
    }
  }, [safeReturnSessionId]);

  const shareBadgeText = (() => {
    if (!circleShare || !shareId) return null;
    const name = shareRecipientName ?? 'Trusted contact';
    if (!shareExpiresAt) return `Shared with ${name}`;
    const msLeft = new Date(shareExpiresAt).getTime() - nowTick;
    if (Number.isNaN(msLeft)) return `Shared with ${name}`;
    const minLeft = Math.max(0, Math.ceil(msLeft / 60_000));
    return `Shared with ${name} · expires in ${minLeft} min`;
  })();

  const totalDurationS = ((booking?.durationH ?? 1) + addedH) * 3600;
  const remaining = Math.max(0, totalDurationS - elapsed);
  const cashBalance = booking ? Math.round(booking.totalUsd * 0.7) : 0;

  const handleEnd = () => {
    setEndVisible(false);
    if (booking) {
      router.replace({ pathname: '/(rent-a-buddy)/review' as any, params: { bookingId: booking.id } });
    }
  };

  if (loading) return <TravelLoadingState label="Loading session…" />;
  if (error) return <TravelErrorState title="Couldn't load session" sub={error} onRetry={load} />;

  return (
    <View style={styles.page}>
      {/* Header — dark for immersive feel */}
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => router.canGoBack() ? router.back() : router.push('/(rent-a-buddy)/' as any)}
        >
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <View style={styles.headerCenter}>
          <View style={styles.liveBadge}>
            <Zap size={10} color={color.success} fill={color.success} />
            <Text style={styles.liveText}>LIVE SESSION</Text>
          </View>
          <Text style={styles.headerTitle}>{booking?.category?.toUpperCase() ?? 'MEETUP'}</Text>
        </View>
        <Pressable style={styles.emergencyBtn} onPress={() => {
          Alert.alert('Emergency Services', 'Open your phone dialer to call emergency services (112 / 911)?', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Call emergency services', style: 'destructive', onPress: () => Linking.openURL('tel:112') },
          ]);
        }}>
          <Phone size={14} color={color.signal} />
          <Text style={styles.emergencyText}>SOS</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: barInset }}
        showsVerticalScrollIndicator={false}
      >
        {/* Buddy card */}
        <View style={styles.buddyCard}>
          <View style={styles.buddyAvatar}>
            <Text style={styles.buddyInitial}>B</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.buddyName}>Your Buddy</Text>
            <Text style={styles.buddyCity}>{booking?.city ?? '—'}</Text>
          </View>
          <View style={styles.verifiedPill}>
            <CheckCircle size={12} color={color.success} />
            <Text style={styles.verifiedText}>Verified</Text>
          </View>
        </View>

        {/* Timer */}
        <View style={styles.timerBlock}>
          <Text style={styles.timerLabel}>TIME ELAPSED</Text>
          <Text style={styles.timerElapsed}>{formatElapsed(elapsed)}</Text>
          <View style={styles.timerRow}>
            <Text style={styles.timerRemainingLabel}>Remaining</Text>
            <Text style={styles.timerRemaining}>{formatElapsed(remaining)}</Text>
          </View>
          <View style={styles.timerBarBg}>
            <View style={[styles.timerBarFill, { width: `${Math.min(100, (elapsed / totalDurationS) * 100)}%` as any }]} />
          </View>
        </View>

        {/* Cash reminder */}
        {cashBalance > 0 && (
          <View style={[styles.cashBanner, { marginHorizontal: space.lg }]}>
            <AlertTriangle size={16} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={styles.cashTitle}>Cash balance: ${cashBalance}</Text>
              <Text style={styles.cashSub}>Pay your Buddy in cash at the end of the session. Never pay upfront.</Text>
            </View>
          </View>
        )}

        {/* Meetup location */}
        <View style={[styles.locationCard, { marginHorizontal: space.lg, marginTop: space.md }]}>
          <MapPin size={16} color={color.signal} />
          <View style={{ flex: 1 }}>
            <Text style={styles.locationLabel}>Meetup location</Text>
            <Text style={styles.locationVal}>{booking?.city ?? 'Public location'}</Text>
          </View>
        </View>

        {/* Safety Panel — open by default */}
        <View style={[styles.safetyPanel, { marginHorizontal: space.lg, marginTop: space.lg }]}>
          <View style={styles.safetyHeader}>
            <Shield size={16} color={color.success} />
            <Text style={styles.safetyTitle}>Safety panel</Text>
          </View>
          <View style={styles.safetyBody}>
            <View style={styles.safetyToggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.safetyToggleLabel}>Safe Return check-in</Text>
                <Text style={styles.safetyToggleSub}>Get a check-in prompt when the session ends</Text>
              </View>
              <Switch
                value={safeReturn}
                onValueChange={async (v) => {
                  setSafeReturn(v);
                  if (v && bookingId) {
                    // Broad-area check-in (city only, no GPS) so safety team knows you are OK
                    await safetyCheckin(bookingId, {
                      checkinType: 'safe_return_enabled',
                      response: 'ok',
                    }).catch(() => {});
                  }
                }}
                trackColor={{ true: color.success, false: color.haze }}
                thumbColor={color.paperRaised}
              />
            </View>
            <View style={[styles.safetyToggleRow, { borderTopWidth: 1, borderTopColor: color.haze }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.safetyToggleLabel}>Share location with Trusted Circle</Text>
                <Text style={styles.safetyToggleSub}>
                  {shareBadgeText ?? 'Share real-time location with a trusted contact during this session'}
                </Text>
              </View>
              {circleShareLoading ? (
                <ActivityIndicator color={color.success} size="small" />
              ) : (
                <Switch
                  value={circleShare}
                  onValueChange={handleCircleShareToggle}
                  trackColor={{ true: color.success, false: color.haze }}
                  thumbColor={color.paperRaised}
                />
              )}
            </View>
            <Pressable
              style={styles.unsafeBtn}
              onPress={() => {
                Alert.alert(
                  'Are you feeling unsafe?',
                  'Our safety team will be notified immediately. If you are in immediate danger, use the SOS button.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Notify safety team',
                      style: 'destructive',
                      onPress: async () => {
                        const [unsafeRes] = await Promise.allSettled([
                          feelUnsafe(bookingId),
                          endBookingEarly(bookingId, 'unsafe_behavior'),
                        ]);
                        const notified =
                          unsafeRes.status === 'fulfilled' &&
                          (unsafeRes.value as { ok: boolean }).ok === true;
                        Alert.alert(
                          notified ? 'Safety team notified' : 'Alert may not have sent',
                          notified
                            ? 'Our team has been alerted and this session has been flagged for review. If in immediate danger, use the SOS button to call emergency services.'
                            : 'We could not confirm your alert reached our safety team. Please call emergency services immediately.',
                          [
                            { text: 'OK' },
                            {
                              text: 'Call emergency services',
                              style: 'destructive',
                              onPress: () => Linking.openURL('tel:112'),
                            },
                          ],
                        );
                      },
                    },
                  ],
                );
              }}
            >
              <AlertTriangle size={13} color={color.signal} />
              <Text style={styles.unsafeBtnText}>I feel unsafe</Text>
            </Pressable>
            <Pressable
              style={[styles.reportBtn, { borderTopWidth: 1, borderTopColor: color.haze }]}
              onPress={() => {
                Alert.alert(
                  'Report an issue',
                  'Flag this session for a safety review?',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Report',
                      style: 'destructive',
                      onPress: async () => {
                        const res = await reportBooking(bookingId, { reason: 'safety_concern' });
                        if (res.ok) {
                          Alert.alert('Report submitted', 'Our safety team will review this session.');
                        } else {
                          Alert.alert('Error', 'Could not submit report. Please try again.');
                        }
                      },
                    },
                  ],
                );
              }}
            >
              <Flag size={13} color={color.signal} />
              <Text style={styles.reportText}>Report an issue</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {/* Bottom actions */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + space.sm }]} onLayout={onBarLayout}>
        <Pressable
          style={({ pressed }) => [styles.addTimeBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => setAddTimeVisible(true)}
        >
          <Plus size={16} color={color.ink} />
          <Text style={styles.addTimeBtnText}>Add time</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.endBtn, pressed && { opacity: layout.pressedOpacity }]}
          onPress={() => setEndVisible(true)}
        >
          <X size={16} color={color.onInk} />
          <Text style={styles.endBtnText}>End session</Text>
        </Pressable>
      </View>

      <AddTimeModal visible={addTimeVisible} onClose={() => setAddTimeVisible(false)} onAdd={async h => {
        const res = await addExtraTime(bookingId, h);
        if (res.ok) setAddedH(a => a + h);
        else Alert.alert('Error', bookingErrorCopy(res.error, 'Could not add time'));
      }} />
      <EndModal visible={endVisible} onClose={() => setEndVisible(false)} onEnd={handleEnd} />
      <ContactPickerModal
        visible={contactPickerVisible}
        contacts={sessionContacts}
        loading={contactPickerLoading}
        onClose={() => {
          setContactPickerVisible(false);
          setCircleShareLoading(false);
        }}
        onSelect={handleContactSelected}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.ink },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.md,
    backgroundColor: color.ink,
  },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center' },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  liveText: { fontSize: 9, fontWeight: '800', color: color.success, fontFamily: 'Courier', letterSpacing: 1 },
  headerTitle: { fontSize: 13, fontWeight: '700', color: color.onInk, letterSpacing: 1 },
  emergencyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,77,46,0.15)', borderRadius: radius.sm,
    borderWidth: 1, borderColor: color.signal,
    paddingHorizontal: space.sm, paddingVertical: space.xs,
  },
  emergencyText: { fontSize: 11, fontWeight: '800', color: color.signal, fontFamily: 'Courier' },
  scroll: { flex: 1, backgroundColor: color.paper },
  buddyCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, padding: space.lg,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  buddyAvatar: { width: avatar.s48, height: avatar.s48, borderRadius: avatar.s48 / 2, backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center' },
  buddyInitial: { fontSize: 20, fontWeight: '700', color: color.onInk },
  buddyName: { ...t.bodyStrong, color: color.ink },
  buddyCity: { ...t.small, color: color.mute },
  verifiedPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#EEF8F3', borderRadius: 999, paddingHorizontal: space.sm, paddingVertical: 4 },
  verifiedText: { fontSize: 10, fontWeight: '700', color: color.success, fontFamily: 'Courier' },
  timerBlock: {
    backgroundColor: color.ink, padding: space.xl,
    alignItems: 'center', gap: space.sm,
  },
  timerLabel: { fontSize: 10, fontWeight: '700', color: color.onInkMute, fontFamily: 'Courier', letterSpacing: 2 },
  timerElapsed: { fontSize: 56, fontWeight: '800', color: color.onInk, fontFamily: 'Courier', letterSpacing: -2 },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  timerRemainingLabel: { ...t.small, color: color.onInkMute },
  timerRemaining: { ...t.bodyStrong, color: color.onInk, fontFamily: 'Courier' },
  timerBarBg: { width: '100%', height: 4, backgroundColor: 'rgba(250,249,246,0.15)', borderRadius: 2, overflow: 'hidden', marginTop: space.sm },
  timerBarFill: { height: '100%', backgroundColor: color.signal, borderRadius: 2 },
  cashBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.sm,
    backgroundColor: '#FFF8ED', borderRadius: radius.md, padding: space.md,
    borderWidth: 1, borderColor: color.warn, marginTop: space.lg,
  },
  cashTitle: { ...t.small, fontWeight: '700', color: color.warn },
  cashSub: { ...t.small, color: color.mute, marginTop: 2, lineHeight: 16 },
  locationCard: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  locationLabel: { ...t.small, color: color.mute },
  locationVal: { ...t.bodyStrong, color: color.ink },
  safetyPanel: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.success, overflow: 'hidden',
  },
  safetyHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  safetyTitle: { ...t.bodyStrong, color: color.ink, flex: 1 },
  safetyBody: { borderTopWidth: 1, borderTopColor: color.haze },
  safetyToggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  safetyToggleLabel: { ...t.bodyStrong, color: color.ink },
  safetyToggleSub: { ...t.small, color: color.mute, marginTop: 2 },
  unsafeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md,
    backgroundColor: '#FFF0EE', borderTopWidth: 1, borderTopColor: color.haze,
  },
  unsafeBtnText: { ...t.small, color: color.signal, fontWeight: '700' },
  reportBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.md },
  reportText: { ...t.small, color: color.signal, fontWeight: '600' },
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', gap: space.md,
    backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze,
    paddingHorizontal: space.lg, paddingTop: space.md,
    ...shadow.float,
  },
  addTimeBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.md, borderWidth: 1.5, borderColor: color.ink,
    paddingVertical: space.md,
  },
  addTimeBtnText: { ...t.bodyStrong, color: color.ink },
  endBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: radius.md, backgroundColor: color.signal, paddingVertical: space.md,
  },
  endBtnText: { ...t.bodyStrong, color: color.onInk },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: color.paper, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: space.xl, gap: space.md },
  title: { ...t.title, color: color.ink },
  sub: { ...t.body, color: color.mute },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl, paddingVertical: space.md },
  stepBtn: { width: avatar.s44, height: avatar.s44, borderRadius: avatar.s44 / 2, borderWidth: 1.5, borderColor: color.haze, backgroundColor: color.paperRaised, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: 22, color: color.ink, fontWeight: '600' },
  stepVal: { ...t.title, color: color.ink, minWidth: 100, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: space.md, marginTop: space.sm },
  cancelBtn: { flex: 1, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md, alignItems: 'center' },
  cancelBtnText: { ...t.bodyStrong, color: color.ink },
  addBtn: { flex: 1, borderRadius: radius.md, backgroundColor: color.ink, padding: space.md, alignItems: 'center' },
  addBtnText: { ...t.bodyStrong, color: color.onInk },
});

const picker = StyleSheet.create({
  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    padding: space.md,
  },
  avatar: {
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2,
    backgroundColor: color.deep, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 15, fontWeight: '700', color: color.onInk },
  contactName: { ...t.bodyStrong, color: color.ink, flex: 1 },
  livePill: {
    backgroundColor: '#EEF8F3', borderRadius: 999,
    paddingHorizontal: space.sm, paddingVertical: 3,
  },
  livePillText: { fontSize: 9, fontWeight: '800', color: color.success, fontFamily: 'Courier', letterSpacing: 1 },
});
