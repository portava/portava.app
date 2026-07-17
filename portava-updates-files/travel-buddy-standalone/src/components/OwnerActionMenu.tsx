import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Share } from 'react-native';
import { router } from 'expo-router';
import {
  Edit3, Eye, Share2, MessageCircle,
  Bookmark, Shield, Settings, Info,
} from 'lucide-react-native';
import { makeWebFallback } from '../services/passportShareUtils';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  onEditProfile: () => void;
  onSettings: () => void;
  onViewAsPublic: () => void;
}

const ACTIONS = [
  {
    label: 'Edit Profile',
    icon: Edit3,
    bg: '#EBF2FF',
    iconColor: '#3B7DED',
    onPress: (handlers: Props) => { handlers.onClose(); handlers.onEditProfile(); },
  },
  {
    label: 'View Public',
    icon: Eye,
    bg: '#F0EAFF',
    iconColor: '#7B5CE5',
    onPress: (handlers: Props) => { handlers.onClose(); handlers.onViewAsPublic(); },
  },
  {
    label: 'Share',
    icon: Share2,
    bg: '#E8F8F0',
    iconColor: '#27AE71',
    onPress: async (handlers: Props) => {
      handlers.onClose();
      try {
        const url = handlers.username ? makeWebFallback(handlers.username) : 'https://travelbuddy.app';
        await Share.share({ message: `Check out my Portava Passport: ${url}`, url });
      } catch {}
    },
  },
  {
    label: 'Messages',
    icon: MessageCircle,
    bg: '#FFF3E8',
    iconColor: '#E8872A',
    onPress: (handlers: Props) => { handlers.onClose(); router.push('/(tabs)/messages' as any); },
  },
  {
    label: 'Saved',
    icon: Bookmark,
    bg: '#FFFBEA',
    iconColor: '#D4A017',
    onPress: (handlers: Props) => { handlers.onClose(); router.push('/saved' as any); },
  },
  {
    label: 'About Me',
    icon: Info,
    bg: '#E8F8FB',
    iconColor: '#1A9CB0',
    onPress: (handlers: Props) => { handlers.onClose(); router.push('/profile/about' as any); },
  },
  {
    label: 'Safety',
    icon: Shield,
    bg: '#FEECEC',
    iconColor: '#D94040',
    onPress: (handlers: Props) => { handlers.onClose(); router.push('/settings/privacy' as any); },
  },
  {
    label: 'Settings',
    icon: Settings,
    bg: '#F2F2F2',
    iconColor: '#666',
    onPress: (handlers: Props) => { handlers.onClose(); handlers.onSettings(); },
  },
] as const;

export function OwnerActionMenu({
  visible, onClose, username, onEditProfile, onSettings, onViewAsPublic,
}: Props) {
  const handlers: Props = { visible, onClose, username, onEditProfile, onSettings, onViewAsPublic };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={om.overlay} onPress={onClose} />
      <View style={om.sheet}>
        <View style={om.handle} />
        <Text style={om.title}>Profile</Text>

        {/* 4-column icon grid */}
        <View style={om.grid}>
          {ACTIONS.map((action) => {
            const Icon = action.icon;
            return (
              <Pressable
                key={action.label}
                style={({ pressed }) => [om.cell, pressed && om.cellPressed]}
                onPress={() => action.onPress(handlers)}
                accessibilityRole="button"
                accessibilityLabel={action.label}
              >
                <View style={[om.iconBox, { backgroundColor: action.bg }]}>
                  <Icon size={22} color={action.iconColor} />
                </View>
                <Text style={om.cellLabel}>{action.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable style={om.cancelBtn} onPress={onClose}>
          <Text style={om.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const om = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: space.lg,
    paddingBottom: 36,
    paddingTop: space.md,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.lg,
  },
  title: {
    ...t.bodyStrong, color: color.ink, fontWeight: '700',
    fontSize: 16, textAlign: 'center', marginBottom: space.lg,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  cell: {
    width: '22%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 7,
    paddingVertical: space.sm,
  },
  cellPressed: { opacity: 0.7 },
  iconBox: {
    width: 56, height: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellLabel: {
    fontSize: 11, fontWeight: '600',
    color: color.ink, textAlign: 'center', lineHeight: 14,
  },
  cancelBtn: {
    marginTop: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.haze,
  },
  cancelText: { ...t.body, color: color.ink, fontWeight: '700', fontSize: 15 },
});
