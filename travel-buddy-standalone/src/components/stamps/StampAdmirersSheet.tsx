/**
 * StampAdmirersSheet — bottom sheet listing users who admired a stamp.
 *
 * Each row shows avatar, display name (real name if opted-in, @handle otherwise),
 * and @handle. Tapping a row closes the sheet and navigates to that user's
 * public passport page.
 */
import React, { useState } from 'react';
import {
  Modal, View, Text, Pressable, FlatList, Image, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { closeThenNavigate } from '../../lib/deferredNavigate.ts';
import { X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { VerifiedStamp } from '../ui/VerifiedStamp.tsx';
import type { StampAdmirer } from '../../services/stampAdmire.ts';
import {
  primaryIdentityText,
  secondaryIdentityText,
} from '../../lib/displayIdentity.ts';

interface Props {
  visible: boolean;
  admirers: StampAdmirer[];
  onClose: () => void;
}

interface RowProps {
  item: StampAdmirer;
  onClose: () => void;
}

function AdmirerRow({ item, onClose }: RowProps) {
  const [imgErr, setImgErr] = useState(false);

  const identity = { displayName: item.displayName, username: item.username };
  const primary = primaryIdentityText(identity);
  const secondary = secondaryIdentityText(identity);

  function handlePress() {
    if (!item.username) return;
    // BUG CC/CD fix: close first, then navigate after the sheet animation
    // finishes to avoid the back-button-dead race.
    closeThenNavigate(onClose, `/passport/${item.username}`);
  }

  const initials = primary.replace(/^@/, '').split(' ').map((w) => w[0] ?? '').slice(0, 2).join('').toUpperCase();

  return (
    <Pressable style={s.row} onPress={handlePress} android_ripple={{ color: color.haze }}>
      {item.avatarUrl && !imgErr ? (
        <Image
          source={{ uri: item.avatarUrl }}
          style={s.avatar}
          onError={() => setImgErr(true)}
        />
      ) : (
        <View style={[s.avatar, s.avatarFallback]}>
          <Text style={s.avatarInitials}>{initials || '?'}</Text>
        </View>
      )}

      <View style={s.info}>
        <View style={s.nameRow}>
          <Text style={s.name} numberOfLines={1}>{primary}</Text>
          {item.verified ? <VerifiedStamp size="sm" /> : null}
        </View>
        {secondary ? <Text style={s.handle} numberOfLines={1}>{secondary}</Text> : null}
      </View>
    </Pressable>
  );
}

export function StampAdmirersSheet({ visible, admirers, onClose }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, space.xl) }]}>
        {/* Grab bar */}
        <View style={s.grabBar} />

        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>Admirers</Text>
          <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {admirers.length === 0 ? (
          <View style={s.empty}>
            <Text style={s.emptyText}>No admirers yet</Text>
          </View>
        ) : (
          <FlatList
            data={admirers}
            keyExtractor={(item) => item.userId}
            renderItem={({ item }) => <AdmirerRow item={item} onClose={onClose} />}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: space.md }}
          />
        )}
      </View>
    </Modal>
  );
}

const AVATAR_SIZE = 44;

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    backgroundColor: color.paperRaised ?? color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '72%',
    paddingTop: space.sm,
  },
  nameRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 3 },
  grabBar: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xl,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: { ...t.bodyStrong, color: color.ink, fontWeight: '700' },
  closeBtn: { padding: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm + 2,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    borderRadius: AVATAR_SIZE / 2,
  },
  avatarFallback: {
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: { ...t.small, color: color.mute, fontWeight: '700' },
  info: { flex: 1, gap: 2 },
  name: { ...t.bodyStrong, color: color.ink },
  handle: { ...t.small, color: color.mute },
  empty: { padding: space.xl, alignItems: 'center' },
  emptyText: { ...t.body, color: color.mute },
});
