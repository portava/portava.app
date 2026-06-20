import React from 'react';
import { View, Text, Pressable, Modal, StyleSheet, Share } from 'react-native';
import { router } from 'expo-router';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  onEditProfile: () => void;
  onSettings: () => void;
  onViewAsPublic: () => void;
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

  const items = [
    { label: 'Edit profile', onPress: () => { onClose(); onEditProfile(); } },
    { label: 'Share Passport', onPress: handleShare },
    { label: 'View as public', onPress: () => { onClose(); onViewAsPublic(); } },
    { label: 'Passport settings', onPress: () => { onClose(); onSettings(); } },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={om.overlay} onPress={onClose} />
      <View style={om.sheet}>
        <View style={om.handle} />
        {items.map((item, i) => (
          <Pressable
            key={item.label}
            style={[om.item, i < items.length - 1 && om.itemBorder]}
            onPress={item.onPress}
          >
            <Text style={om.itemText}>{item.label}</Text>
          </Pressable>
        ))}
        <Pressable style={[om.item, om.cancelItem]} onPress={onClose}>
          <Text style={om.cancelText}>Cancel</Text>
        </Pressable>
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
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md },
  item: { paddingVertical: 15 },
  itemBorder: { borderBottomWidth: 1, borderBottomColor: color.haze },
  itemText: { ...t.body, color: color.ink, textAlign: 'center', fontWeight: '600', fontSize: 16 },
  cancelItem: { marginTop: space.sm },
  cancelText: { ...t.body, color: color.mute, textAlign: 'center', fontWeight: '600', fontSize: 16 },
});
