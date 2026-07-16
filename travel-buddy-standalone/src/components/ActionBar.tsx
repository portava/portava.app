import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Heart, MessageCircle, Bookmark, Share2 } from 'lucide-react-native';
import { color, space, type as t } from '../theme/tokens';

function compact(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

export function ActionBar({
  liked,
  saved,
  likeCount,
  commentCount,
  saveCount,
  onLike,
  onComment,
  onSave,
  onShare,
  renderSave,
  tint = color.ink,
}: {
  liked?: boolean;
  saved?: boolean;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  onLike?: () => void;
  onComment?: () => void;
  onSave?: () => void;
  onShare?: () => void;
  renderSave?: React.ReactNode;
  tint?: string;
}) {
  return (
    <View style={styles.row}>
      <Action icon={<Heart size={20} color={liked ? color.signal : tint} fill={liked ? color.signal : 'transparent'} />}
        label={compact(likeCount)} onPress={onLike} tint={tint} />
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
      <Pressable onPress={onShare} hitSlop={8} accessibilityRole="button">
        <Share2 size={20} color={tint} />
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
