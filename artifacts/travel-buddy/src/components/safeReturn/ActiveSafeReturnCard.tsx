/**
 * ActiveSafeReturnCard
 *
 * Persistent banner showing the active Safe Return session countdown,
 * status, and action buttons. Render on the plan detail screen.
 * Tapping it expands to a full-screen modal.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, Alert, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Shield, CheckCircle, Clock, X, PhoneCall, MapPin, ChevronRight, Share2, MessageCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  confirmSafe,
  cancelSession,
  extendTimer,
  startLiveShare,
  getSessionContacts,
  type SafeReturnSession,
} from '../../services/safeReturn.ts';
import { EmergencyHelpSheet } from './EmergencyHelpSheet.tsx';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  session: SafeReturnSession;
  onSessionEnded?: () => void;
  onSessionUpdated?: (session: SafeReturnSession) => void;
  compact?: boolean;
}

// ── Countdown hook ────────────────────────────────────────────────────────────

function useCountdown(timerEndAt: string | null): string {
  const [display, setDisplay] = useState('');

  useEffect(() => {
    function tick() {
      if (!timerEndAt) { setDisplay(''); return; }
      const ms = new Date(timerEndAt).getTime() - Date.now();
      if (ms <= 0) { setDisplay('Expired'); return; }
      const totalSec = Math.floor(ms / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      if (h > 0) setDisplay(`${h}h ${String(m).padStart(2, '0')}m`);
      else setDisplay(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timerEndAt]);

  return display;
}

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  pending: '#F5A623',
  active:  color.deep,
  missed:  color.signal,
  safe:    color.success,
  cancelled: color.mute,
};

const STATUS_LABEL: Record<string, string> = {
  pending:   'Setting up',
  active:    'Active',
  missed:    'Check-in missed',
  safe:      'Safe ✓',
  cancelled: 'Cancelled',
};

// ── Component ─────────────────────────────────────────────────────────────────

export function ActiveSafeReturnCard({ session, onSessionEnded, onSessionUpdated, compact = false }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [showEmergency, setShowEmergency] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const countdown = useCountdown(session.timerEndAt);

  const handleConfirmSafe = useCallback(async () => {
    setLoading(true);
    const r = await confirmSafe(session.id);
    setLoading(false);
    if (r.ok) {
      setExpanded(false);
      onSessionEnded?.();
    } else {
      Alert.alert('Error', 'Could not confirm. Please try again.');
    }
  }, [session.id, onSessionEnded]);

  const handleExtend = useCallback(async () => {
    setLoading(true);
    const r = await extendTimer(session.id, 15);
    setLoading(false);
    if (r.ok && r.session) {
      onSessionUpdated?.(r.session);
    } else {
      Alert.alert('Error', 'Could not extend timer.');
    }
  }, [session.id, onSessionUpdated]);

  const handleShareLocation = useCallback(async () => {
    if (!session.liveShareEnabled) {
      Alert.alert('Not configured', 'Enable "Share my approximate area" in Safe Return settings to use this feature.');
      return;
    }
    setShareLoading(true);
    const contacts = await getSessionContacts(session.id);
    const eligible = contacts.filter((c) => c.canReceiveLiveLocation);
    setShareLoading(false);

    if (eligible.length === 0) {
      Alert.alert('No contacts', 'No contacts in this session have location sharing enabled.');
      return;
    }

    if (eligible.length === 1) {
      const contact = eligible[0]!;
      const r = await startLiveShare(session.id, { recipientContactId: contact.id });
      if (r.ok) {
        Alert.alert('Sharing started', `Your approximate area is now visible to ${contact.contactName ?? 'your contact'} for 1 hour.`);
      } else {
        Alert.alert('Error', 'Could not start location share. Please try again.');
      }
      return;
    }

    // Multiple contacts — let user pick
    Alert.alert(
      'Share with…',
      'Choose a contact to share your approximate area with.',
      [
        ...eligible.map((c) => ({
          text: c.contactName ?? 'Contact',
          onPress: async () => {
            const r = await startLiveShare(session.id, { recipientContactId: c.id });
            if (!r.ok) Alert.alert('Error', 'Could not start location share.');
          },
        })),
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  }, [session.id, session.liveShareEnabled]);

  const handleMessageCircle = useCallback(() => {
    router.push('/(tabs)/messages' as any);
  }, [router]);

  const handleCancel = useCallback(() => {
    Alert.alert(
      'Cancel Safe Return?',
      'Your trusted contacts will not be notified and the session will end.',
      [
        { text: 'Keep active', style: 'cancel' },
        {
          text: 'Cancel session', style: 'destructive',
          onPress: async () => {
            setLoading(true);
            const r = await cancelSession(session.id);
            setLoading(false);
            if (r.ok) { setExpanded(false); onSessionEnded?.(); }
          },
        },
      ],
    );
  }, [session.id, onSessionEnded]);

  const statusColor = STATUS_COLOR[session.status] ?? color.mute;
  const statusLabel = STATUS_LABEL[session.status] ?? session.status;

  // ── Compact banner ────────────────────────────────────────────────────────

  if (compact) {
    return (
      <>
        <Pressable style={[styles.banner, { borderLeftColor: statusColor }]} onPress={() => setExpanded(true)}>
          <Shield size={16} color={statusColor} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.bannerStatus, { color: statusColor }]}>{statusLabel}</Text>
            {countdown ? <Text style={styles.bannerCountdown}>{countdown} remaining</Text> : null}
          </View>
          <ChevronRight size={16} color={color.mute} />
        </Pressable>
        {expanded && (
          <SafeReturnModal
            session={session}
            countdown={countdown}
            statusLabel={statusLabel}
            statusColor={statusColor}
            loading={loading}
            shareLoading={shareLoading}
            onClose={() => setExpanded(false)}
            onConfirmSafe={handleConfirmSafe}
            onExtend={handleExtend}
            onCancel={handleCancel}
            onEmergency={() => setShowEmergency(true)}
            onShareLocation={handleShareLocation}
            onMessageCircle={handleMessageCircle}
          />
        )}
        <EmergencyHelpSheet visible={showEmergency} onClose={() => setShowEmergency(false)} />
      </>
    );
  }

  // ── Full card ─────────────────────────────────────────────────────────────

  return (
    <>
      <View style={[styles.card, { borderColor: statusColor }]}>
        <View style={styles.cardHeader}>
          <Shield size={18} color={statusColor} />
          <Text style={[styles.cardStatus, { color: statusColor }]}>{statusLabel}</Text>
          {countdown ? (
            <View style={styles.countdownBadge}>
              <Clock size={12} color={color.mute} />
              <Text style={styles.countdownText}>{countdown}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.actions}>
          <Pressable style={styles.primaryBtn} onPress={handleConfirmSafe} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" size="small" /> : (
              <>
                <CheckCircle size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>I'm Safe</Text>
              </>
            )}
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={handleExtend} disabled={loading}>
            <Text style={styles.secondaryBtnText}>+15 min</Text>
          </Pressable>
          <Pressable style={styles.emergencyBtn} onPress={() => setShowEmergency(true)}>
            <PhoneCall size={14} color={color.signal} />
          </Pressable>
        </View>

        {/* Quick-action row */}
        <View style={styles.quickActions}>
          <Pressable style={styles.quickBtn} onPress={handleShareLocation} disabled={shareLoading}>
            {shareLoading
              ? <ActivityIndicator size="small" color={color.deep} />
              : <>
                  <Share2 size={13} color={color.deep} />
                  <Text style={styles.quickBtnText}>Share Location</Text>
                </>
            }
          </Pressable>
          <Pressable style={styles.quickBtn} onPress={handleMessageCircle}>
            <MessageCircle size={13} color={color.deep} />
            <Text style={styles.quickBtnText}>Message Circle</Text>
          </Pressable>
        </View>

        <Pressable style={styles.cancelLink} onPress={handleCancel}>
          <Text style={styles.cancelLinkText}>Cancel Safe Return</Text>
        </Pressable>
      </View>
      <EmergencyHelpSheet visible={showEmergency} onClose={() => setShowEmergency(false)} />
    </>
  );
}

// ── Full-screen expand modal ──────────────────────────────────────────────────

function SafeReturnModal({ session, countdown, statusLabel, statusColor, loading, shareLoading, onClose, onConfirmSafe, onExtend, onCancel, onEmergency, onShareLocation, onMessageCircle }: {
  session: SafeReturnSession;
  countdown: string;
  statusLabel: string;
  statusColor: string;
  loading: boolean;
  shareLoading: boolean;
  onClose: () => void;
  onConfirmSafe: () => void;
  onExtend: () => void;
  onCancel: () => void;
  onEmergency: () => void;
  onShareLocation: () => void;
  onMessageCircle: () => void;
}) {
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.modalHeader}>
          <Shield size={20} color={statusColor} />
          <Text style={styles.modalTitle}>Safe Return</Text>
          <Pressable onPress={onClose} hitSlop={12}><X size={22} color={color.mute} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.modalBody}>
          <View style={[styles.statusBox, { borderColor: statusColor }]}>
            <Text style={[styles.statusBoxLabel, { color: statusColor }]}>{statusLabel}</Text>
            {countdown ? <Text style={styles.statusBoxCountdown}>{countdown}</Text> : null}
          </View>

          <View style={styles.infoRow}>
            <MapPin size={14} color={color.mute} />
            <Text style={styles.infoText}>
              {session.trustedCircleEnabled ? 'Trusted contacts will be alerted if you miss check-in' : 'Only you will be notified'}
            </Text>
          </View>
          {session.liveShareEnabled && (
            <View style={styles.infoRow}>
              <MapPin size={14} color={color.deep} />
              <Text style={styles.infoText}>Approximate area sharing enabled</Text>
            </View>
          )}

          <Pressable style={styles.modalPrimaryBtn} onPress={onConfirmSafe} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : (
              <>
                <CheckCircle size={18} color="#fff" />
                <Text style={styles.modalPrimaryBtnText}>I'm Safe</Text>
              </>
            )}
          </Pressable>
          <Pressable style={styles.modalSecondaryBtn} onPress={onExtend} disabled={loading}>
            <Text style={styles.modalSecondaryBtnText}>Extend 15 minutes</Text>
          </Pressable>
          <Pressable style={[styles.modalSecondaryBtn, styles.modalActionBtn]} onPress={onShareLocation} disabled={shareLoading}>
            {shareLoading
              ? <ActivityIndicator size="small" color={color.deep} />
              : <>
                  <Share2 size={16} color={color.deep} />
                  <Text style={[styles.modalSecondaryBtnText, { color: color.deep }]}>Share Location Now</Text>
                </>
            }
          </Pressable>
          <Pressable style={[styles.modalSecondaryBtn, styles.modalActionBtn]} onPress={onMessageCircle}>
            <MessageCircle size={16} color={color.deep} />
            <Text style={[styles.modalSecondaryBtnText, { color: color.deep }]}>Message Trusted Circle</Text>
          </Pressable>
          <Pressable style={styles.modalSecondaryBtn} onPress={onEmergency}>
            <Text style={[styles.modalSecondaryBtnText, { color: color.signal }]}>Emergency Help</Text>
          </Pressable>
          <Pressable style={styles.modalCancelLink} onPress={onCancel}>
            <Text style={styles.cancelLinkText}>Cancel Safe Return</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderLeftWidth: 3, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    marginVertical: space.sm,
  },
  bannerStatus: { ...t.bodyStrong, fontSize: 13 },
  bannerCountdown: { ...t.small, color: color.mute, fontSize: 11 },
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, padding: space.md, marginVertical: space.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md },
  cardStatus: { ...t.bodyStrong, fontSize: 14, flex: 1 },
  countdownBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: color.haze, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3,
  },
  countdownText: { ...t.small, color: color.mute, fontSize: 12 },
  actions: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  primaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, backgroundColor: color.deep, borderRadius: radius.md, padding: space.md,
  },
  primaryBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 14 },
  secondaryBtn: {
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, padding: space.md, alignItems: 'center', justifyContent: 'center',
  },
  secondaryBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  emergencyBtn: {
    borderRadius: radius.md, borderWidth: 1, borderColor: color.signal,
    backgroundColor: '#FFF0EE', padding: space.md, alignItems: 'center', justifyContent: 'center',
    width: 44,
  },
  cancelLink: { alignItems: 'center', paddingVertical: space.sm },
  cancelLinkText: { ...t.small, color: color.mute, fontSize: 12 },
  modalRoot: { flex: 1, backgroundColor: color.paper },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    justifyContent: 'space-between', padding: space.lg,
    borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised,
  },
  modalTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17, flex: 1 },
  modalBody: { padding: space.lg, gap: space.md },
  statusBox: {
    borderWidth: 2, borderRadius: radius.lg, padding: space.xl, alignItems: 'center',
    backgroundColor: color.paperRaised,
  },
  statusBoxLabel: { ...t.bodyStrong, fontSize: 16 },
  statusBoxCountdown: { ...t.stamp, fontSize: 32, color: color.ink, marginTop: space.sm },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  infoText: { ...t.small, color: color.mute, fontSize: 12, flex: 1 },
  modalPrimaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, backgroundColor: color.deep, borderRadius: radius.md, padding: space.lg,
  },
  modalPrimaryBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 16 },
  modalSecondaryBtn: {
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, padding: space.md, alignItems: 'center',
  },
  modalSecondaryBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  modalCancelLink: { alignItems: 'center', paddingVertical: space.md },
  modalActionBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  quickActions: { flexDirection: 'row', gap: space.sm, marginBottom: space.xs },
  quickBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 4, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, paddingVertical: space.sm,
  },
  quickBtnText: { ...t.small, color: color.deep, fontSize: 12 },
});
