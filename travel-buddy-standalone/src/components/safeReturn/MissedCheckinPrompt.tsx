/**
 * MissedCheckinPrompt
 *
 * Shown when the Safe Return timer expires without confirmation.
 * Calm, non-alarming language with escalation-level-aware options.
 *
 * Level 0: Show only to user — confirm or extend.
 * Level 1: Offer TC alert button.
 * Level 2: Offer TC alert + live location share.
 * Level 3: Open Emergency Help sheet.
 */
import React, { useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Shield, Clock, AlertCircle } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { confirmSafe, extendTimer, type SafeReturnSession } from '../../services/safeReturn.ts';
import { EmergencyHelpSheet } from './EmergencyHelpSheet.tsx';

interface Props {
  visible: boolean;
  session: SafeReturnSession;
  onDismiss: () => void;
  onSafe?: () => void;
  onExtended?: (session: SafeReturnSession) => void;
  onShareLocation?: () => void;
  onAlertContacts?: () => void;
}

export function MissedCheckinPrompt({ visible, session, onDismiss, onSafe, onExtended, onShareLocation, onAlertContacts }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [showEmergency, setShowEmergency] = useState(false);

  async function handleSafe() {
    setLoading('safe');
    const r = await confirmSafe(session.id);
    setLoading(null);
    if (r.ok) { onSafe?.(); onDismiss(); }
  }

  async function handleExtend() {
    setLoading('extend');
    const r = await extendTimer(session.id, 15);
    setLoading(null);
    if (r.ok && r.session) { onExtended?.(r.session); onDismiss(); }
  }

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onDismiss}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            {/* Icon */}
            <View style={styles.iconWrap}>
              <AlertCircle size={36} color="#F5A623" />
            </View>

            <Text style={styles.headline}>We couldn't confirm you're safe</Text>
            <Text style={styles.sub}>
              Your Safe Return timer has expired. Please let us know you're okay,
              or use one of the options below.
            </Text>

            {/* Level 0+ actions */}
            <Pressable
              style={[styles.btn, styles.btnPrimary, loading === 'safe' && styles.btnDisabled]}
              onPress={handleSafe}
              disabled={!!loading}
            >
              {loading === 'safe'
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.btnPrimaryText}>✓  I'm Safe</Text>
              }
            </Pressable>

            <Pressable
              style={[styles.btn, styles.btnSecondary, loading === 'extend' && styles.btnDisabled]}
              onPress={handleExtend}
              disabled={!!loading}
            >
              {loading === 'extend'
                ? <ActivityIndicator color={color.ink} />
                : <>
                    <Clock size={15} color={color.ink} />
                    <Text style={styles.btnSecondaryText}>Extend 15 minutes</Text>
                  </>
              }
            </Pressable>

            {/* Level 1+: Alert Trusted Circle */}
            {session.escalationLevel >= 1 && session.trustedCircleEnabled && (
              <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => { onAlertContacts?.(); onDismiss(); }}>
                <Shield size={15} color={color.ink} />
                <Text style={styles.btnSecondaryText}>Alert my Trusted Circle</Text>
              </Pressable>
            )}

            {/* Level 2+: Share location */}
            {session.escalationLevel >= 2 && session.liveShareEnabled && (
              <Pressable style={[styles.btn, styles.btnSecondary]} onPress={() => { onShareLocation?.(); onDismiss(); }}>
                <Text style={styles.btnSecondaryText}>Share my approximate location</Text>
              </Pressable>
            )}

            {/* Level 3+: Emergency help */}
            {session.escalationLevel >= 3 && (
              <Pressable style={[styles.btn, styles.btnEmergency]} onPress={() => setShowEmergency(true)}>
                <Text style={styles.btnEmergencyText}>Emergency Help</Text>
              </Pressable>
            )}

            {/* Dismiss */}
            <Pressable style={styles.dismissLink} onPress={onDismiss}>
              <Text style={styles.dismissText}>Dismiss for now</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <EmergencyHelpSheet visible={showEmergency} onClose={() => setShowEmergency(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.xl, width: '100%', gap: space.sm, paddingBottom: 40,
  },
  iconWrap: { alignItems: 'center', marginBottom: space.sm },
  headline: { ...t.bodyStrong, color: color.ink, fontSize: 18, textAlign: 'center' },
  sub: { ...t.body, color: color.mute, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: space.sm, borderRadius: radius.md, padding: space.lg, marginTop: space.sm,
  },
  btnPrimary: { backgroundColor: color.success },
  btnPrimaryText: { ...t.bodyStrong, color: '#fff', fontSize: 16 },
  btnSecondary: {
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
  },
  btnSecondaryText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  btnEmergency: { backgroundColor: '#FFF0EE', borderWidth: 1, borderColor: color.signal },
  btnEmergencyText: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
  btnDisabled: { opacity: 0.5 },
  dismissLink: { alignItems: 'center', paddingVertical: space.md },
  dismissText: { ...t.small, color: color.mute, fontSize: 12 },
});
