/**
 * SafeReturnSetupSheet
 *
 * Bottom sheet / modal for configuring and starting a Safe Return session.
 * Shown when the user taps "Set up Safe Return" from a plan item or settings.
 */
import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, Modal, ScrollView, Pressable, Switch,
  TextInput, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { X, Shield, ChevronDown, ChevronUp, Info } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import {
  createSession,
  startSession,
  getActiveSession,
  getTrustedContacts,
  type TrustedContact,
  type SafeReturnContactInput,
} from '../../services/safeReturn.ts';
import { startCheckedOpenEffect } from './SafeReturnSetupSheet.openEffect';
import { runHandleStart } from './SafeReturnSetupSheet.handleStart';
import { runContactLoad } from './SafeReturnSetupSheet.contactLoad';
import {
  listEmergencyContacts,
  type EmergencyContact,
} from '../../services/emergencyContacts.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  onClose: () => void;
  onStarted?: (sessionId: string) => void;
  planItemId?: string;
  tripId?: string;
  /** ISO timestamp of when the linked plan item ends (enables "Until plan ends" timer chip). */
  planEndsAt?: string | null;
  suggestionReason?: string | null;
  /**
   * Called with `true` when the active-session pre-check starts and `false`
   * when it resolves. Callers can use this to show an inline spinner on the
   * trigger button so the user knows something is happening.
   */
  onCheckingChange?: (checking: boolean) => void;
  /**
   * Called when the session pre-check times out (slow connection). The
   * caller can use this to update its indicator label (e.g. "Still
   * checking…") before the form opens fail-open after a brief linger.
   */
  onSlowCheck?: () => void;
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

// How long to keep the "still checking…" overlay visible before opening the
// form fail-open when the session pre-check times out. Tune this constant
// (or expose as a prop) to adjust the feedback window.
const SLOW_CHECK_LINGER_MS = 1_500;

export function SafeReturnSetupSheet({ visible, onClose, onStarted, planItemId, tripId, planEndsAt, suggestionReason, onCheckingChange, onSlowCheck }: Props) {
  const [timerMinutes, setTimerMinutes] = useState<number | null>(30);
  const [escalationLevel, setEscalationLevel] = useState<0 | 1 | 2 | 3>(0);
  const [trustedCircleEnabled, setTrustedCircleEnabled] = useState(false);
  const [liveShareEnabled, setLiveShareEnabled] = useState(false);
  const [notifyHostEnabled, setNotifyHostEnabled] = useState(false);
  const [notifyTripCrewEnabled, setNotifyTripCrewEnabled] = useState(false);
  const [emergencyNote, setEmergencyNote] = useState('');
  const [trustedContacts, setTrustedContacts] = useState<TrustedContact[]>([]);
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [emergencyContacts, setEmergencyContacts] = useState<EmergencyContact[]>([]);
  const [selectedEmergencyContacts, setSelectedEmergencyContacts] = useState<Set<string>>(new Set());
  const [contactsLoading, setContactsLoading] = useState(false);
  const [showWhyExpanded, setShowWhyExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Tracks whether the Modal itself should be open. We only open it after the
  // active-session pre-check resolves with no session, so the user never sees
  // a modal that immediately dismisses itself on slower connections.
  const [modalVisible, setModalVisible] = useState(false);
  const startLock = useRef(false);
  // Tracks the currently active open-effect handle so rapid visible=true
  // re-triggers (before React cleanup has a chance to run the previous cancel)
  // are safely deduplicated. Second-wins: the new effect cancels the old one.
  const openEffectHandleRef = useRef<ReturnType<typeof startCheckedOpenEffect> | null>(null);
  // Timer that lingers the checking overlay after a timeout before opening
  // the form fail-open. Cleared by effect cleanup when visible goes false.
  const slowCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!visible) {
      setModalVisible(false);
      if (slowCheckTimerRef.current !== null) {
        clearTimeout(slowCheckTimerRef.current);
        slowCheckTimerRef.current = null;
      }
      return;
    }

    // Guard against concurrent open effects: cancel any in-flight handle before
    // starting a new one. React's useEffect cleanup normally handles this via the
    // returned cancel function, but explicit cancellation here defends against
    // rapid visible=true re-triggers that arrive in the same render batch before
    // the cleanup of the previous effect has run (second-wins policy).
    openEffectHandleRef.current?.cancel();
    if (slowCheckTimerRef.current !== null) {
      clearTimeout(slowCheckTimerRef.current);
      slowCheckTimerRef.current = null;
    }

    // startCheckedOpenEffect owns the safety-net 5 s timeout + onCheckingChange
    // signalling + live-flag guard. The handle returned here lets us (a) query
    // liveness from the contact-loading continuation and (b) cancel from the
    // cleanup function below.
    //
    // The safety-net timeout defaults to 5 000 ms. Pass a second argument to
    // startCheckedOpenEffect({ timeoutMs: N }) here if you need to tune it.
    const handle = startCheckedOpenEffect({
      onCheckingChange,
      onStarted,
      onClose,
      getActiveSession,
      onModalShouldOpen: () => {
        // No active session (or error) — open the form and load contacts.
        // handle.isLive() guards the async continuation below; by the time
        // this callback fires the pre-check is already resolved/live.
        setModalVisible(true);
        setContactsLoading(true);
        runContactLoad({ getTrustedContacts, listEmergencyContacts }).then((contactResult) => {
          if (handle.isLive()) {
            setTrustedContacts(contactResult.trustedContacts);
            setEmergencyContacts(contactResult.emergencyContacts);
            setContactsLoading(false);
          }
        });
      },
      onTimeout: () => {
        // Session pre-check timed out (slow connection). Instead of closing,
        // signal the parent to show "Still checking…" feedback, then open the
        // form fail-open after a brief linger so the user sees what happened.
        onSlowCheck?.();
        slowCheckTimerRef.current = setTimeout(() => {
          slowCheckTimerRef.current = null;
          if (!handle.isLive()) return; // cancelled while lingering — do nothing
          onCheckingChange?.(false); // hide the checking overlay
          setModalVisible(true);     // open the form (fail-open)
          setContactsLoading(true);
          runContactLoad({ getTrustedContacts, listEmergencyContacts }).then((contactResult) => {
            if (handle.isLive()) {
              setTrustedContacts(contactResult.trustedContacts);
              setEmergencyContacts(contactResult.emergencyContacts);
              setContactsLoading(false);
            }
          });
        }, SLOW_CHECK_LINGER_MS);
      },
    });
    openEffectHandleRef.current = handle;

    return () => {
      handle.cancel();
      openEffectHandleRef.current = null;
      if (slowCheckTimerRef.current !== null) {
        clearTimeout(slowCheckTimerRef.current);
        slowCheckTimerRef.current = null;
      }
    };
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

  function toggleEmergencyContact(id: string) {
    setSelectedEmergencyContacts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleStart() {
    if (startLock.current) return;
    startLock.current = true;
    setSaving(true);
    try {
      const contacts: SafeReturnContactInput[] = [
        ...trustedContacts
          .filter((c) => selectedContacts.has(c.userId))
          .map((c) => ({
            contactUserId: c.userId,
            contactName: c.displayName,
            contactMethod: 'in_app' as const,
            canReceiveLiveLocation: liveShareEnabled,
          })),
        ...emergencyContacts
          .filter((ec) => selectedEmergencyContacts.has(ec.id))
          .map((ec) => ({
            contactName: ec.name,
            contactPhone: ec.phone ?? undefined,
            contactEmail: ec.email ?? undefined,
            contactMethod: ec.notifyMethod,
            canReceiveLiveLocation: liveShareEnabled && ec.notifyMethod !== 'sms',
          })),
      ];

      const outcome = await runHandleStart({
        createSession: () => createSession({
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
        }),
        startSession,
        onStarted,
        onClose,
      });

      if (outcome === 'conflict') {
        Alert.alert(
          'Session already active',
          'You already have an active Safe Return session. Cancel or confirm that one before starting a new one.',
        );
      } else if (outcome === 'createFailed') {
        Alert.alert('Error', 'Could not set up Safe Return. Please try again.');
      } else if (outcome === 'startFailed') {
        Alert.alert('Error', 'Session created but could not be started.');
      }
      // 'started' → onStarted + onClose already fired inside runHandleStart
    } finally {
      startLock.current = false;
      setSaving(false);
    }
  }

  return (
    <Modal visible={modalVisible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
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

        <ScrollView
          style={styles.body}
          contentContainerStyle={{ paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
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
            {planEndsAt && new Date(planEndsAt) > new Date() ? (() => {
              const planEndMinutes = Math.max(5, Math.round((new Date(planEndsAt).getTime() - Date.now()) / 60_000));
              return (
                <Pressable
                  key="plan-ends"
                  style={[styles.chip, timerMinutes === planEndMinutes && styles.chipActive]}
                  onPress={() => setTimerMinutes(planEndMinutes)}
                >
                  <Text style={[styles.chipText, timerMinutes === planEndMinutes && styles.chipTextActive]}>
                    Until plan ends
                  </Text>
                </Pressable>
              );
            })() : null}
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
              <Text style={styles.sectionLabel}>Contacts to alert</Text>
              {contactsLoading ? (
                <ActivityIndicator color={color.deep} style={{ marginVertical: space.md }} />
              ) : (
                <>
                  {/* Profile-level emergency contacts */}
                  {emergencyContacts.length > 0 && (
                    <>
                      <Text style={styles.contactGroupLabel}>Saved emergency contacts</Text>
                      {emergencyContacts.map((ec) => (
                        <Pressable
                          key={ec.id}
                          style={[styles.contactRow, selectedEmergencyContacts.has(ec.id) && styles.contactRowActive]}
                          onPress={() => toggleEmergencyContact(ec.id)}
                        >
                          <View style={[styles.checkBox, selectedEmergencyContacts.has(ec.id) && styles.checkBoxActive]}>
                            {selectedEmergencyContacts.has(ec.id) && <Text style={styles.checkMark}>✓</Text>}
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.contactName}>{ec.name}</Text>
                            {ec.label ? <Text style={styles.contactHandle}>{ec.label}</Text> : null}
                          </View>
                          <View style={styles.methodBadge}>
                            <Text style={styles.methodBadgeText}>
                              {ec.notifyMethod === 'sms' ? 'SMS' : ec.notifyMethod === 'email' ? 'Email' : 'In-app'}
                            </Text>
                          </View>
                        </Pressable>
                      ))}
                    </>
                  )}

                  {/* In-app trusted contacts */}
                  {trustedContacts.length > 0 && (
                    <>
                      <Text style={styles.contactGroupLabel}>People on this app</Text>
                      {trustedContacts.map((c) => (
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
                      ))}
                    </>
                  )}

                  {emergencyContacts.length === 0 && trustedContacts.length === 0 && (
                    <Text style={styles.emptyMsg}>
                      No contacts saved yet. Add emergency contacts in Settings, or follow people on the app.
                    </Text>
                  )}
                </>
              )}
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
  contactGroupLabel: { ...t.small, color: color.mute, fontSize: 11, fontWeight: '600', marginTop: space.sm, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  methodBadge: { backgroundColor: color.haze, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  methodBadgeText: { ...t.small, color: color.ink, fontSize: 10, fontWeight: '600' },
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
