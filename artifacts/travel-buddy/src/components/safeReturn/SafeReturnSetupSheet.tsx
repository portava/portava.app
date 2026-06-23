/**
 * SafeReturnSetupSheet
 *
 * Bottom sheet / modal for configuring and starting a Safe Return session.
 * Shown when the user taps "Set up Safe Return" from a plan item or settings.
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Modal, ScrollView, Pressable, Switch,
  TextInput, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { X, Shield, ChevronDown, ChevronUp, Info } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import {
  createSession,
  startSession,
  getTrustedContacts,
  type TrustedContact,
  type SafeReturnContactInput,
} from '../../services/safeReturn';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  onStarted?: (sessionId: string) => void;
  planItemId?: string;
  tripId?: string;
  suggestionReason?: string | null;
}

// ── Timer options ─────────────────────────────────────────────────────────────

const TIMER_OPTIONS: Array<{ label: string; minutes: number | null }> = [
  { label: '15 minutes', minutes: 15 },
  { label: '30 minutes', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: 'Until I confirm', minutes: null },
];

const ESCALATION_OPTIONS: Array<{ level: 0 | 1 | 2 | 3; label: string; desc: string }> = [
  { level: 0, label: 'Notify me only', desc: 'Only you will be reminded. No alerts are sent to anyone else.' },
  { level: 1, label: 'Alert Trusted Circle', desc: 'Your selected contacts are notified if you miss the check-in.' },
  { level: 2, label: 'Alert + Share location', desc: 'Contacts are alerted and can see your approximate area.' },
  { level: 3, label: 'Full escalation', desc: 'Contacts alerted, trip host and crew notified, live area shared.' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function SafeReturnSetupSheet({ visible, onClose, onStarted, planItemId, tripId, suggestionReason }: Props) {
  const [timerMinutes, setTimerMinutes] = useState<number | null>(30);
  const [escalationLevel, setEscalationLevel] = useState<0 | 1 | 2 | 3>(0);
  const [trustedCircleEnabled, setTrustedCircleEnabled] = useState(false);
  const [liveShareEnabled, setLiveShareEnabled] = useState(false);
  const [notifyHostEnabled, setNotifyHostEnabled] = useState(false);
  const [notifyTripCrewEnabled, setNotifyTripCrewEnabled] = useState(false);
  const [emergencyNote, setEmergencyNote] = useState('');
  const [trustedContacts, setTrustedContacts] = useState<TrustedContact[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [contactsLoading, setContactsLoading] = useState(false);
  const [showWhyExpanded, setShowWhyExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setContactsLoading(true);
      getTrustedContacts().then((c) => {
        setTrustedContacts(c);
        setContactsLoading(false);
      });
    }
  }, [visible]);

  // Auto-enable TC when escalation >= 1
  useEffect(() => {
    if (escalationLevel >= 1) setTrustedCircleEnabled(true);
    if (escalationLevel >= 2) setLiveShareEnabled(true);
    if (escalationLevel >= 3) { setNotifyHostEnabled(true); setNotifyTripCrewEnabled(true); }
  }, [escalationLevel]);

  function toggleContact(userId: string) {
    setSelectedContacts((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  async function handleStart() {
    setSaving(true);
    const contacts: SafeReturnContactInput[] = trustedContacts
      .filter((c) => selectedContacts.has(c.userId))
      .map((c) => ({
        contactUserId: c.userId,
        contactName: c.displayName,
        contactMethod: 'in_app' as const,
        canReceiveLiveLocation: liveShareEnabled,
      }));

    const created = await createSession({
      timerMinutes: timerMinutes ?? undefined,
      escalationLevel,
      trustedCircleEnabled,
      liveShareEnabled,
      notifyHostEnabled,
      notifyTripCrewEnabled,
      emergencyNote: emergencyNote.trim() || undefined,
      planItemId,
      tripId,
      contacts,
    });

    if (!created.ok || !created.session) {
      setSaving(false);
      Alert.alert('Error', 'Could not set up Safe Return. Please try again.');
      return;
    }

    // Immediately start the timer
    const started = await startSession(created.session.id);
    setSaving(false);

    if (started.ok && started.session) {
      onStarted?.(started.session.id);
      onClose();
    } else {
      Alert.alert('Error', 'Session created but could not be started.');
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Shield size={20} color={color.deep} />
            <Text style={styles.title}>Safe Return</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12}>
            <X size={22} color={color.mute} />
          </Pressable>
        </View>

        <ScrollView style={styles.body} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
          {/* Suggestion reason */}
          {suggestionReason ? (
            <View style={styles.reasonBanner}>
              <Info size={14} color={color.deep} />
              <Text style={styles.reasonText}>{suggestionReason}</Text>
            </View>
          ) : null}

          {/* Why Safe Return */}
          <Pressable style={styles.whyRow} onPress={() => setShowWhyExpanded((v) => !v)}>
            <Text style={styles.whyLabel}>Why Safe Return?</Text>
            {showWhyExpanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
          </Pressable>
          {showWhyExpanded && (
            <Text style={styles.whyBody}>
              Safe Return lets you set a timer for when you expect to be back. If you miss the check-in, we'll prompt you
              and — based on your settings — can quietly alert your trusted contacts. No emergency services are contacted
              automatically; all actions are your choice.
            </Text>
          )}

          {/* Timer picker */}
          <Text style={styles.sectionLabel}>Check-in timer</Text>
          <View style={styles.optionRow}>
            {TIMER_OPTIONS.map((opt) => (
              <Pressable
                key={opt.label}
                style={[styles.chip, timerMinutes === opt.minutes && styles.chipActive]}
                onPress={() => setTimerMinutes(opt.minutes)}
              >
                <Text style={[styles.chipText, timerMinutes === opt.minutes && styles.chipTextActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Escalation level */}
          <Text style={styles.sectionLabel}>If I miss the check-in…</Text>
          {ESCALATION_OPTIONS.map((opt) => (
            <Pressable
              key={opt.level}
              style={[styles.escalationRow, escalationLevel === opt.level && styles.escalationRowActive]}
              onPress={() => setEscalationLevel(opt.level)}
            >
              <View style={[styles.radio, escalationLevel === opt.level && styles.radioActive]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.escalationLabel}>{opt.label}</Text>
                <Text style={styles.escalationDesc}>{opt.desc}</Text>
              </View>
            </Pressable>
          ))}

          {/* Trusted contacts (shown when escalation >= 1) */}
          {escalationLevel >= 1 && (
            <>
              <Text style={styles.sectionLabel}>Trusted contacts to alert</Text>
              {contactsLoading
                ? <ActivityIndicator color={color.deep} style={{ marginVertical: space.md }} />
                : trustedContacts.length === 0
                  ? <Text style={styles.emptyMsg}>No contacts found. Follow people to add them as trusted contacts.</Text>
                  : trustedContacts.map((c) => (
                    <Pressable
                      key={c.userId}
                      style={[styles.contactRow, selectedContacts.has(c.userId) && styles.contactRowActive]}
                      onPress={() => toggleContact(c.userId)}
                    >
                      <View style={[styles.checkBox, selectedContacts.has(c.userId) && styles.checkBoxActive]}>
                        {selectedContacts.has(c.userId) && <Text style={styles.checkMark}>✓</Text>}
                      </View>
                      <View>
                        <Text style={styles.contactName}>{c.displayName ?? c.handle ?? 'Traveler'}</Text>
                        {c.handle ? <Text style={styles.contactHandle}>@{c.handle}</Text> : null}
                      </View>
                    </Pressable>
                  ))
              }
            </>
          )}

          {/* Toggles */}
          <Text style={styles.sectionLabel}>Options</Text>

          {escalationLevel >= 2 && (
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleLabel}>Share my approximate area</Text>
                <Text style={styles.toggleSub}>Contacts see city/district only, never exact GPS</Text>
              </View>
              <Switch
                value={liveShareEnabled}
                onValueChange={setLiveShareEnabled}
                trackColor={{ true: color.deep }}
              />
            </View>
          )}

          {tripId && (
            <>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Notify trip host</Text>
                  <Text style={styles.toggleSub}>Host gets a calm heads-up if you miss check-in</Text>
                </View>
                <Switch
                  value={notifyHostEnabled}
                  onValueChange={setNotifyHostEnabled}
                  trackColor={{ true: color.deep }}
                />
              </View>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.toggleLabel}>Notify trip crew</Text>
                  <Text style={styles.toggleSub}>Fellow trip members get a calm notification</Text>
                </View>
                <Switch
                  value={notifyTripCrewEnabled}
                  onValueChange={setNotifyTripCrewEnabled}
                  trackColor={{ true: color.deep }}
                />
              </View>
            </>
          )}

          {/* Emergency note */}
          <Text style={styles.sectionLabel}>Emergency note (optional)</Text>
          <TextInput
            style={styles.noteInput}
            value={emergencyNote}
            onChangeText={setEmergencyNote}
            placeholder="e.g. I'll be at the night market near Khao San Rd"
            placeholderTextColor={color.mute}
            multiline
            maxLength={500}
          />

          {/* Privacy callout */}
          <View style={styles.privacyBox}>
            <Text style={styles.privacyText}>
              🔒 Only contacts you select are notified. Exact GPS is never shared.
              All actions (including emergency help) require your explicit tap — nothing is automatic.
            </Text>
          </View>

          {/* Start button */}
          <Pressable
            style={[styles.startBtn, saving && { opacity: 0.6 }]}
            onPress={handleStart}
            disabled={saving}
          >
            {saving
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.startBtnText}>Start Safe Return</Text>
            }
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  body: { flex: 1, paddingHorizontal: space.lg },
  reasonBanner: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: '#EAF2F4', borderRadius: radius.md,
    padding: space.md, marginTop: space.lg,
  },
  reasonText: { ...t.small, color: color.deep, flex: 1, fontSize: 13 },
  whyRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: space.md, marginTop: space.sm,
  },
  whyLabel: { ...t.bodyStrong, color: color.deep, fontSize: 13 },
  whyBody: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 18, marginBottom: space.md },
  sectionLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13, marginTop: space.lg, marginBottom: space.sm },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  chipActive: { backgroundColor: color.deep, borderColor: color.deep },
  chipText: { ...t.small, color: color.ink, fontSize: 12, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  escalationRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md, marginBottom: space.sm,
  },
  escalationRowActive: { borderColor: color.deep, backgroundColor: '#EAF2F4' },
  radio: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: color.haze, marginTop: 2,
  },
  radioActive: { borderColor: color.deep, backgroundColor: color.deep },
  escalationLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  escalationDesc: { ...t.small, color: color.mute, fontSize: 11, lineHeight: 16 },
  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md, marginBottom: space.sm,
  },
  contactRowActive: { borderColor: color.deep },
  checkBox: {
    width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxActive: { backgroundColor: color.deep, borderColor: color.deep },
  checkMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
  contactName: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  contactHandle: { ...t.small, color: color.mute, fontSize: 11 },
  emptyMsg: { ...t.small, color: color.mute, fontSize: 12 },
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md, marginBottom: space.sm,
  },
  toggleLabel: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  toggleSub: { ...t.small, color: color.mute, fontSize: 11 },
  noteInput: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
    ...t.body, color: color.ink, fontSize: 13, minHeight: 80, textAlignVertical: 'top',
  },
  privacyBox: {
    backgroundColor: '#F0F7F4', borderRadius: radius.md, padding: space.md, marginTop: space.lg,
  },
  privacyText: { ...t.small, color: '#2D6A4F', fontSize: 12, lineHeight: 18 },
  startBtn: {
    backgroundColor: color.deep, borderRadius: radius.md, padding: space.lg,
    alignItems: 'center', marginTop: space.xl,
  },
  startBtnText: { ...t.bodyStrong, color: '#fff', fontSize: 15 },
});
