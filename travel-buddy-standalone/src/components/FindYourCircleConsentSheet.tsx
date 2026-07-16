/**
 * FindYourCircleConsentSheet
 *
 * Modal bottom sheet shown the first time a user tries to enable
 * Find Your Circle (no prior consentedAt).
 *
 * Props:
 *   visible       — controls visibility
 *   consentVersion — current consent version string from the backend
 *   onAccept(consentVersion) — user accepted; caller should PATCH settings
 *   onDismiss     — user tapped "Not now"; caller should revert toggle
 */
import React from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Users, Eye, EyeOff, ToggleLeft } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';

interface Props {
  visible: boolean;
  consentVersion: string;
  onAccept: (consentVersion: string) => void;
  onDismiss: () => void;
}

interface BulletProps {
  icon: React.ReactNode;
  title: string;
  body: string;
}

function Bullet({ icon, title, body }: BulletProps) {
  return (
    <View style={s.bullet}>
      <View style={s.bulletIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={s.bulletTitle}>{title}</Text>
        <Text style={s.bulletBody}>{body}</Text>
      </View>
    </View>
  );
}

export function FindYourCircleConsentSheet({ visible, consentVersion, onAccept, onDismiss }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onDismiss}
    >
      <View style={[s.root, { paddingBottom: insets.bottom + space.lg }]}>
        <View style={s.handle} />

        <ScrollView
          contentContainerStyle={s.scroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={s.icon}>
            <Users size={36} color={color.deep} />
          </View>

          <Text style={s.title}>Find Your Circle</Text>
          <Text style={s.subtitle}>
            Coordinate with the people you're already traveling with — no strangers, no public tracking.
          </Text>

          <View style={s.bullets}>
            <Bullet
              icon={<Users size={20} color={color.deep} />}
              title="Co-travelers only"
              body="Only people in the same trip or event as you can ever see your status. Followers and strangers cannot."
            />
            <Bullet
              icon={<Eye size={20} color={color.deep} />}
              title="You choose what's shared"
              body="Status only (e.g. Active), approximate area (e.g. Makati CBD), or venue check-in — never live GPS by default."
            />
            <Bullet
              icon={<EyeOff size={20} color={color.deep} />}
              title="You can stop anytime"
              body="Pause sharing instantly, turn off for a specific trip or event, or disable Find Your Circle entirely from Settings."
            />
            <Bullet
              icon={<ToggleLeft size={20} color={color.deep} />}
              title="Off by default per trip"
              body="Sharing is off until you actively publish your status for a trip or event. Opening settings does not start sharing."
            />
          </View>

          <View style={s.privacyNote}>
            <Text style={s.privacyText}>
              Your exact GPS coordinates are never shared. All location labels are set by you.
            </Text>
          </View>
        </ScrollView>

        <View style={s.actions}>
          <Pressable
            style={({ pressed }) => [s.btnPrimary, pressed && { opacity: 0.85 }]}
            onPress={() => onAccept(consentVersion)}
          >
            <Text style={s.btnPrimaryText}>Enable Find Your Circle</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [s.btnSecondary, pressed && { opacity: 0.7 }]}
            onPress={onDismiss}
          >
            <Text style={s.btnSecondaryText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.haze,
    marginTop: space.md,
    marginBottom: space.lg,
  },
  scroll: {
    paddingHorizontal: space.xl,
    paddingBottom: space.lg,
  },
  icon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: '#EAF2F4',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.lg,
  },
  title: {
    ...t.title,
    color: color.ink,
    marginBottom: space.sm,
  },
  subtitle: {
    ...t.body,
    color: color.mute,
    marginBottom: space.xl,
    lineHeight: 22,
  },
  bullets: {
    gap: space.lg,
    marginBottom: space.xl,
  },
  bullet: {
    flexDirection: 'row',
    gap: space.md,
  },
  bulletIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: '#EAF2F4',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  bulletTitle: {
    ...t.bodyStrong,
    color: color.ink,
    marginBottom: 2,
  },
  bulletBody: {
    ...t.small,
    color: color.mute,
    lineHeight: 18,
  },
  privacyNote: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    padding: space.md,
    borderWidth: 1,
    borderColor: color.haze,
  },
  privacyText: {
    ...t.small,
    color: color.faint,
    textAlign: 'center',
    lineHeight: 17,
  },
  actions: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    gap: space.sm,
  },
  btnPrimary: {
    backgroundColor: color.deep,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    alignItems: 'center',
  },
  btnPrimaryText: {
    ...t.bodyStrong,
    color: color.onInk,
    fontSize: 16,
  },
  btnSecondary: {
    paddingVertical: space.md,
    alignItems: 'center',
  },
  btnSecondaryText: {
    ...t.body,
    color: color.mute,
  },
});
