/**
 * EditHistorySheet — owner-only bottom sheet showing the edit history of a post.
 *
 * Lists content changes in reverse-chronological order.
 * Only the post owner can view this; the backend enforces it.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Clock } from 'lucide-react-native';
import { color, space, radius, shadow } from '../theme/tokens';
import { getEditHistory, type EditHistoryEntry } from '../services/postEngagement';

interface Props {
  visible: boolean;
  postId: string;
  onClose: () => void;
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function EditItem({ entry }: { entry: EditHistoryEntry }) {
  return (
    <View style={s.entry}>
      <View style={s.entryHeader}>
        <Clock size={13} color={color.faint} />
        <Text style={s.entryTime}>{timeLabel(entry.editedAt)}</Text>
      </View>
      {entry.oldContent != null && (
        <View style={s.block}>
          <Text style={s.blockLabel}>Before</Text>
          <Text style={s.blockText} numberOfLines={4}>{entry.oldContent}</Text>
        </View>
      )}
      {entry.newContent != null && (
        <View style={[s.block, s.blockNew]}>
          <Text style={s.blockLabel}>After</Text>
          <Text style={s.blockText} numberOfLines={4}>{entry.newContent}</Text>
        </View>
      )}
    </View>
  );
}

export function EditHistorySheet({ visible, postId, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState<EditHistoryEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getEditHistory(postId);
    setEdits(data);
    setLoading(false);
  }, [postId]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + space.md }]}>
        <View style={s.header}>
          <Text style={s.title}>Edit History</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.center}>
            <ActivityIndicator color={color.signal} />
          </View>
        ) : edits.length === 0 ? (
          <View style={s.center}>
            <Text style={s.empty}>No edits recorded yet.</Text>
          </View>
        ) : (
          <FlatList
            data={edits}
            keyExtractor={(e) => e.id}
            renderItem={({ item }) => <EditItem entry={item} />}
            contentContainerStyle={s.list}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(17,17,15,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: space.md,
    maxHeight: '80%',
    ...shadow.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    marginBottom: space.xs,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: color.ink,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
  },
  empty: {
    fontSize: 14,
    color: color.faint,
  },
  list: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: space.lg,
  },
  entry: {
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    paddingBottom: space.lg,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  entryTime: {
    fontSize: 12,
    color: color.faint,
    fontWeight: '500',
  },
  block: {
    backgroundColor: color.paper,
    borderRadius: radius.sm,
    padding: space.sm,
    gap: 4,
  },
  blockNew: {
    borderLeftWidth: 3,
    borderLeftColor: color.success,
  },
  blockLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: color.faint,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockText: {
    fontSize: 13,
    color: color.ink,
    lineHeight: 19,
  },
});
