/**
 * EmergencyHelpSheet
 *
 * A calm bottom sheet with emergency options.
 * IMPORTANT: No action is automatic. Every action requires an explicit tap.
 * The app never auto-dials or auto-contacts anyone.
 */
import React from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Linking, ScrollView,
} from 'react-native';
import { X, Phone, MessageCircle, MapPin, Car, Users, Shield } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  onMessageTrustedCircle?: () => void;
  onContactHost?: () => void;
}

const EMERGENCY_OPTIONS = [
  {
    id: 'call_emergency',
    icon: Phone,
    label: 'Call local emergency number',
    sub: 'Opens your dialer — you make the call.',
    color: color.signal,
    bg: '#FFF0EE',
  },
  {
    id: 'message_tc',
    icon: MessageCircle,
    label: 'Message Trusted Circle',
    sub: 'Send a message to your selected contacts.',
    color: color.deep,
    bg: '#EAF2F4',
  },
  {
    id: 'share_location',
    icon: MapPin,
    label: 'Share your location',
    sub: 'Opens Maps so you can send your pin.',
    color: '#7A4DBF',
    bg: '#F0EBF9',
  },
  {
    id: 'rideshare',
    icon: Car,
    label: 'Open Maps / Rideshare',
    sub: 'Find a safe route home.',
    color: '#2D7D46',
    bg: '#E6F4EA',
  },
  {
    id: 'contact_host',
    icon: Users,
    label: 'Contact trip host',
    sub: 'Message your trip host.',
    color: '#8B6914',
    bg: '#FBF5E6',
  },
];

export function EmergencyHelpSheet({ visible, onClose, onMessageTrustedCircle, onContactHost }: Props) {
  function handleOption(id: string) {
    switch (id) {
      case 'call_emergency':
        // Opens the dialer — user must tap to call. Never auto-dials.
        Linking.openURL('tel:112').catch(() => {});
        break;
      case 'message_tc':
        onMessageTrustedCircle?.();
        break;
      case 'share_location':
        Linking.openURL('https://maps.google.com').catch(() => {});
        break;
      case 'rideshare':
        Linking.openURL('https://maps.google.com').catch(() => {});
        break;
      case 'contact_host':
        onContactHost?.();
        break;
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <Shield size={20} color={color.signal} />
              <Text style={styles.title}>Emergency Help</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={12}><X size={22} color={color.mute} /></Pressable>
          </View>

          <Text style={styles.sub}>
            You're in control. Nothing happens automatically — every action below requires your tap.
          </Text>

          <ScrollView showsVerticalScrollIndicator={false}>
            {EMERGENCY_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              return (
                <Pressable
                  key={opt.id}
                  style={[styles.option, { backgroundColor: opt.bg, borderColor: opt.color + '40' }]}
                  onPress={() => handleOption(opt.id)}
                >
                  <View style={[styles.optionIcon, { backgroundColor: opt.color + '20' }]}>
                    <Icon size={20} color={opt.color} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.optionLabel, { color: opt.color }]}>{opt.label}</Text>
                    <Text style={styles.optionSub}>{opt.sub}</Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <Pressable style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>I'm okay — close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: space.xl, paddingBottom: 40, maxHeight: '85%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: space.md,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  sub: { ...t.small, color: color.mute, fontSize: 12, lineHeight: 18, marginBottom: space.lg },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    borderRadius: radius.md, borderWidth: 1, padding: space.md, marginBottom: space.sm,
  },
  optionIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  optionLabel: { ...t.bodyStrong, fontSize: 14 },
  optionSub: { ...t.small, color: color.mute, fontSize: 11 },
  closeBtn: {
    backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md,
    alignItems: 'center', marginTop: space.md, borderWidth: 1, borderColor: color.haze,
  },
  closeBtnText: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
});
