import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MessageCircle, Bookmark } from 'lucide-react-native';
import { color, space, type as t } from '../theme/tokens.ts';
import { StampButton } from './stamps/StampButton.tsx';
import { PortavaShareIcon } from './icons/PortavaShareIcon.tsx';

function compact(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

export function ActionBar({
  entityType,
  entityId,
  initialStampCount = 0,
  initialIsStamped = false,
  saved,
  commentCount,
  saveCount,
  onComment,
  onSave,
  onShare,
  renderSave,
  tint = color.ink,
}: {
  /** Entity type for stamp (e.g. 'post', 'event', 'trip'). */
  entityType: string;
  /** Entity ID for stamp. */
  entityId: string;
  initialStampCount?: number;
  initialIsStamped?: boolean;
  saved?: boolean;
  commentCount: number;
  saveCount: number;
  onComment?: () => void;
  onSave?: () => void;
  onShare?: () => void;
  renderSave?: React.ReactNode;
  tint?: string;
}) {
  return (
    <View style={styles.row}>
      <StampButton
        entityType={entityType}
        entityId={entityId}
        initialCount={initialStampCount}
        initialIsStamped={initialIsStamped}
        iconSize={20}
      />
      <Action icon={<MessageCircle size={20} color={tint} />}
        label={compact(commentCount)} onPress={onComment} tint={tint} />
      {renderSave ? (
        <View style={styles.action}>
          {renderSave}
          <Text style={[styles.count, { color: tint }]}>{compact(saveCount)}</Text>
        </View>
      ) : (
        <Action icon={<Bookmark size={20} color={tint} fill={saved ? tint : 'transparent'} />}
          label={compact(saveCount)} onPress={onSave} tint={tint} />
      )}
      <View style={{ flex: 1 }} />
      <Pressable onPress={onShare} hitSlop={8} accessibilityRole="button" accessibilityLabel="Share">
        <PortavaShareIcon size={20} color={tint} />
      </Pressable>
    </View>
  );
}

function Action({ icon, label, onPress, tint }: { icon: React.ReactNode; label: string; onPress?: () => void; tint: string }) {
  return (
    <Pressable onPress={onPress} style={styles.action} hitSlop={8} accessibilityRole="button">
      {icon}
      <Text style={[styles.count, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xl },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  count: { ...t.small, fontWeight: '600' },
});
