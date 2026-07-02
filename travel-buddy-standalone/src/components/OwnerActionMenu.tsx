import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Share, ScrollView } from 'react-native';
import { router } from 'expo-router';
import {
  Edit3, Eye, Share2, Settings, MessageCircle,
  Bookmark, Shield, Lock, Info, X,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import type { OwnProfile } from '../types/models';

interface Props {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  onEditProfile: () => void;
  onSettings: () => void;
  onViewAsPublic: () => void;
}

interface MenuSection {
  items: MenuItem[];
}

interface MenuItem {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  onPress: () => void;
  danger?: boolean;
}

export function OwnerActionMenu({
  visible, onClose, username, onEditProfile, onSettings, onViewAsPublic,
}: Props) {
  const handleShare = async () => {
    onClose();
    try {
      const url = username ? `https://travelbuddy.app/u/${username}` : 'https://travelbuddy.app';
      await Share.share({ message: `Check out my Travel Buddy Passport: ${url}`, url });
    } catch {
      // user cancelled
    }
  };

  const sections: MenuSection[] = [
    {
      items: [
        { label: 'Edit profile', icon: Edit3, onPress: () => { onClose(); onEditProfile(); } },
        { label: 'View as public', icon: Eye, onPress: () => { onClose(); onViewAsPublic(); } },
        { label: 'Share Passport', icon: Share2, onPress: handleShare },
      ],
    },
    {
      items: [
        { label: 'Messages', icon: MessageCircle, onPress: () => { onClose(); router.push('/(tabs)/messages' as any); } },
        { label: 'Saved & Collections', icon: Bookmark, onPress: () => { onClose(); router.push('/saved' as any); } },
        { label: 'About me', icon: Info, onPress: () => { onClose(); router.push('/profile/about' as any); } },
      ],
    },
    {
      items: [
        { label: 'Privacy & Safety', icon: Shield, onPress: () => { onClose(); router.push('/settings/privacy' as any); } },
        { label: 'Passport settings', icon: Settings, onPress: () => { onClose(); onSettings(); } },
      ],
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={om.overlay} onPress={onClose} />
      <View style={om.sheet}>
        <View style={om.handle} />
        <View style={om.titleRow}>
          <Text style={om.title}>Profile menu</Text>
          <Pressable onPress={onClose} hitSlop={8} style={om.closeBtn}>
            <X size={18} color={color.mute} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {sections.map((section, si) => (
            <View key={si} style={[om.section, si > 0 && om.sectionBorder]}>
              {section.items.map((item, ii) => {
                const Icon = item.icon;
                return (
                  <Pressable
                    key={item.label}
                    style={[om.item, ii < section.items.length - 1 && om.itemBorder]}
                    onPress={item.onPress}
                  >
                    <View style={om.iconWrap}>
                      <Icon size={18} color={item.danger ? color.signal : color.ink} />
                    </View>
                    <Text style={[om.itemText, item.danger && om.dangerText]}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}

          <Pressable style={om.cancelRow} onPress={onClose}>
            <Text style={om.cancelText}>Cancel</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

const om = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: space.lg, paddingBottom: 40, paddingTop: space.md,
    maxHeight: '80%',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md,
  },
  titleRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', marginBottom: space.md,
  },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700', fontSize: 15 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center',
  },
  section: { paddingVertical: space.xs },
  sectionBorder: { borderTopWidth: 1, borderTopColor: color.haze, marginTop: space.xs, paddingTop: space.md },
  item: {
    flexDirection: 'row', alignItems: 'center',
    gap: space.md, paddingVertical: 13,
  },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: color.haze },
  iconWrap: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: color.paperRaised,
    borderWidth: 1, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
  },
  itemText: { ...t.body, color: color.ink, fontWeight: '600', fontSize: 15, flex: 1 },
  dangerText: { color: color.signal },
  cancelRow: { paddingVertical: 14, marginTop: space.sm },
  cancelText: { ...t.body, color: color.mute, textAlign: 'center', fontWeight: '600', fontSize: 15 },
});
