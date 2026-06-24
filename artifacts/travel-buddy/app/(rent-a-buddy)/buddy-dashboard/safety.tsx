import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Pressable, Alert, Modal, TextInput,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, AlertTriangle, PhoneCall, Flag, UserX,
  StopCircle, DollarSign, Users, X,
} from 'lucide-react-native';
import { TravelButton, TravelCard } from '../../../src/components/primitives';
import { color, space, radius, type as t } from '../../../src/theme/tokens';

const REPORT_REASONS = [
  'Harassment or disrespectful behaviour',
  'Requested adult or romantic services',
  'Brought unapproved extra guests',
  'Refused to pay agreed amount',
  'Made me feel unsafe',
  'Did not follow agreed plan',
  'Other',
];

const END_REASONS = [
  'I feel unsafe',
  'Traveller is being disrespectful',
  'Traveller requested inappropriate services',
  'Health or personal emergency',
  'Traveller no-showed',
  'Other',
];

function ReasonSheet({
  visible,
  title,
  sub,
  reasons,
  confirmLabel,
  confirmVariant,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  sub: string;
  reasons: string[];
  confirmLabel: string;
  confirmVariant: 'primary' | 'secondary';
  onClose: () => void;
  onConfirm: (reason: string, detail: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[modal.wrap, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={modal.header}>
          <Text style={modal.title}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <X size={20} color={color.mute} />
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false}>
          <Text style={modal.sub}>{sub}</Text>
          {reasons.map((r) => (
            <Pressable
              key={r}
              style={[modal.option, reason === r && modal.optionActive]}
              onPress={() => setReason(r)}
            >
              <View style={[modal.radio, reason === r && modal.radioOn]}>
                {reason === r && <View style={modal.radioDot} />}
              </View>
              <Text style={[modal.optionText, reason === r && modal.optionTextActive]}>{r}</Text>
            </Pressable>
          ))}
          <TextInput
            style={modal.input}
            value={detail}
            onChangeText={setDetail}
            placeholder="Add any additional details (optional)…"
            placeholderTextColor={color.faint}
            multiline
          />
          <TravelButton
            label={confirmLabel}
            variant={reason ? confirmVariant : 'ghost'}
            onPress={() => reason && onConfirm(reason, detail)}
            full
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

function SafetyActionButton({
  icon: Icon,
  label,
  sub,
  accent,
  onPress,
  large,
}: {
  icon: any;
  label: string;
  sub: string;
  accent?: string;
  onPress: () => void;
  large?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [sab.wrap, large && sab.large, pressed && { opacity: 0.85 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={[sab.iconWrap, large && sab.iconLarge, { backgroundColor: (accent ?? color.signal) + '22' }]}>
        <Icon size={large ? 26 : 20} color={accent ?? color.signal} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[sab.label, large && sab.labelLarge]}>{label}</Text>
        <Text style={sab.sub}>{sub}</Text>
      </View>
    </Pressable>
  );
}

export default function BuddySafetyTools() {
  const insets = useSafeAreaInsets();
  const [reportOpen, setReportOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  function handleReport(reason: string, detail: string) {
    setReportOpen(false);
    Alert.alert(
      'Report submitted',
      'Thank you for reporting. Our safety team will review this within 24 hours. The booking is now flagged.',
      [{ text: 'OK' }],
    );
  }

  function handleEndBooking(reason: string, detail: string) {
    setEndOpen(false);
    Alert.alert(
      'Booking ended early',
      'The booking has been marked as ended early. Your safety team note has been recorded. No penalties apply when safety is the reason.',
      [{ text: 'OK', onPress: () => router.back() }],
    );
  }

  function handleFlagUnpaidCash() {
    Alert.alert(
      'Flag unpaid cash balance',
      'This will notify the traveller that their cash payment is outstanding. A support ticket will be created if unresolved within 24 hours.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Flag it',
          style: 'destructive',
          onPress: () => Alert.alert('Flagged', 'The unpaid balance has been flagged. You\'ll receive an update within 24 hours.'),
        },
      ],
    );
  }

  function handleFlagExtraGuest() {
    Alert.alert(
      'Flag unapproved extra guest',
      'This will record that an unapproved guest was present. The traveller will be notified and asked to pay for the extra person.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Flag it',
          onPress: () => Alert.alert('Flagged', 'The unapproved guest has been flagged. The traveller will be notified.'),
        },
      ],
    );
  }

  function handleContactSupport() {
    Alert.alert(
      'Contact Support',
      'Our support team is available 24/7. Would you like to open a support ticket?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open ticket',
          onPress: () => Alert.alert('Ticket created', 'A support ticket has been created. You\'ll hear back within 2 hours.'),
        },
      ],
    );
  }

  function handleEmergency() {
    Alert.alert(
      '🆘 Emergency',
      'If you are in immediate danger, call local emergency services now.\n\nDo you also want to notify our safety team?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Notify safety team',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Safety team notified',
              'Our safety team has been alerted with your last known location from this session. Stay safe.',
            ),
        },
      ],
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={[s.header, { paddingTop: insets.top + space.md }]}>
        <Pressable onPress={() => router.back()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <ArrowLeft size={20} color={color.onInk} />
        </Pressable>
        <Text style={s.headerTitle}>Safety Tools</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 48 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Context note */}
        <TravelCard style={{ padding: space.lg, marginBottom: space.xl }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.md }}>
            <AlertTriangle size={20} color={color.warn} />
            <View style={{ flex: 1 }}>
              <Text style={s.noteTitle}>During active bookings</Text>
              <Text style={s.noteBody}>
                These tools are here to protect you. Use them without hesitation if you feel unsafe.
                No penalties apply when safety is the reason for ending a booking early.
              </Text>
            </View>
          </View>
        </TravelCard>

        {/* Emergency button — always visible, most prominent */}
        <Pressable
          style={({ pressed }) => [emg.btn, pressed && { opacity: 0.85 }]}
          onPress={handleEmergency}
          accessibilityRole="button"
          accessibilityLabel="Emergency button"
        >
          <PhoneCall size={24} color={color.onInk} />
          <View>
            <Text style={emg.label}>Emergency</Text>
            <Text style={emg.sub}>Tap if you are in immediate danger</Text>
          </View>
        </Pressable>

        {/* Primary safety actions */}
        <Text style={s.sectionTitle}>Booking safety</Text>
        <View style={s.actionList}>
          <SafetyActionButton
            icon={StopCircle}
            label="End booking early"
            sub="Stop the current booking immediately. No penalty when safety-related."
            accent={color.signal}
            onPress={() => setEndOpen(true)}
          />
          <SafetyActionButton
            icon={Flag}
            label="Report traveller"
            sub="Report inappropriate behaviour, policy violations, or safety concerns."
            accent={color.signal}
            onPress={() => setReportOpen(true)}
          />
        </View>

        {/* Financial safety */}
        <Text style={[s.sectionTitle, { marginTop: space.xl }]}>Financial issues</Text>
        <View style={s.actionList}>
          <SafetyActionButton
            icon={DollarSign}
            label="Flag unpaid cash balance"
            sub="Traveller hasn't paid the agreed cash amount. Creates a support ticket."
            accent={color.warn}
            onPress={handleFlagUnpaidCash}
          />
          <SafetyActionButton
            icon={Users}
            label="Flag unapproved extra guest"
            sub="Traveller brought an extra person not agreed to in the booking."
            accent={color.warn}
            onPress={handleFlagExtraGuest}
          />
        </View>

        {/* Support */}
        <Text style={[s.sectionTitle, { marginTop: space.xl }]}>Get help</Text>
        <View style={s.actionList}>
          <SafetyActionButton
            icon={PhoneCall}
            label="Contact support"
            sub="Open a support ticket. Our team is available 24/7."
            accent={color.deep}
            onPress={handleContactSupport}
          />
        </View>

        {/* Policy reminder */}
        <TravelCard style={{ padding: space.lg, marginTop: space.xl }}>
          <Text style={s.policyTitle}>Buddy safety policy</Text>
          <Text style={s.policyBody}>
            {'• You have the right to end any booking that makes you feel unsafe.\n'}
            {'• Reporting a traveller does not affect your Buddy rating.\n'}
            {'• Unapproved adult or romantic service requests must be reported immediately.\n'}
            {'• All safety reports are reviewed by our team within 24 hours.'}
          </Text>
        </TravelCard>
      </ScrollView>

      <ReasonSheet
        visible={reportOpen}
        title="Report traveller"
        sub="Tell us what happened. This report is confidential and reviewed by our safety team."
        reasons={REPORT_REASONS}
        confirmLabel="Submit report"
        confirmVariant="secondary"
        onClose={() => setReportOpen(false)}
        onConfirm={handleReport}
      />

      <ReasonSheet
        visible={endOpen}
        title="End booking early"
        sub="Please tell us why you're ending this booking. No penalties apply for safety reasons."
        reasons={END_REASONS}
        confirmLabel="End booking now"
        confirmVariant="secondary"
        onClose={() => setEndOpen(false)}
        onConfirm={handleEndBooking}
      />
    </View>
  );
}

const s = StyleSheet.create({
  header: {
    backgroundColor: color.ink, flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingBottom: space.lg,
  },
  headerTitle: { ...t.heading, color: color.onInk, flex: 1 },
  noteTitle: { ...t.bodyStrong, color: color.ink, marginBottom: 4 },
  noteBody: { ...t.small, color: color.mute, lineHeight: 18 },
  sectionTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  actionList: { gap: space.sm },
  policyTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  policyBody: { ...t.small, color: color.mute, lineHeight: 19 },
});

const emg = StyleSheet.create({
  btn: {
    flexDirection: 'row', alignItems: 'center', gap: space.lg,
    backgroundColor: '#C0392B', borderRadius: radius.md,
    padding: space.xl, marginBottom: space.xl,
  },
  label: { ...t.heading, color: color.onInk },
  sub: { ...t.small, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
});

const sab = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    padding: space.lg, borderWidth: 1, borderColor: color.haze,
  },
  large: { padding: space.xl },
  iconWrap: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  iconLarge: { width: 52, height: 52, borderRadius: 26 },
  label: { ...t.bodyStrong, color: color.ink },
  labelLarge: { fontSize: 17 },
  sub: { ...t.small, color: color.mute, lineHeight: 17, marginTop: 2 },
});

const modal = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: color.paper, padding: space.xl },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: space.md,
  },
  title: { ...t.heading, color: color.ink },
  sub: { ...t.body, color: color.mute, marginBottom: space.lg, lineHeight: 22 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  optionActive: {},
  optionText: { ...t.body, color: color.ink, flex: 1 },
  optionTextActive: { color: color.signal, fontWeight: '600' },
  radio: {
    width: 20, height: 20, borderRadius: 10, borderWidth: 1.5,
    borderColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { borderColor: color.signal },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.signal },
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, ...t.body, color: color.ink,
    height: 80, textAlignVertical: 'top', marginTop: space.lg, marginBottom: space.lg,
  },
});
