/**
 * MemorySocialBar — like, save and share on a Memory (HM-F09, HM-F13).
 *
 *   Like  — StampButton, controlled by `useMemoryLike`, so the stamp gesture
 *           writes `memory_likes` (the table the count is read from) instead of
 *           an entity stamp the Memory's count never sees.
 *   Save  — non-owners only; `POST|DELETE /memories/:id/save`. The saved shelf
 *           is `/memory/saved`. A refused save rolls back and says so.
 *   Share — opens MemoryShareSheet (the server gate, then a Telegraph reference).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Bookmark, BookmarkCheck, Share2 } from 'lucide-react-native';
import { color, space, type as t } from '../../../theme/tokens.ts';
import { StampButton } from '../../../components/stamps/StampButton.tsx';
import { useMemoryLike } from '../../../hooks/useMemoryLike.ts';
import { saveMemory, unsaveMemory } from '../../../services/memorySocial.ts';
import type { Memory } from '../../../services/memories.ts';
import { MemoryShareSheet } from './MemoryShareSheet.tsx';

export function MemorySocialBar({ memory, isOwner }: { memory: Memory; isOwner: boolean }) {
  const like = useMemoryLike(memory.id, memory.likeCount ?? 0, memory.likedByMe ?? false);
  const [saved, setSaved] = useState(memory.savedByMe ?? false);
  const [saving, setSaving] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => { setSaved(memory.savedByMe ?? false); }, [memory.id, memory.savedByMe]);

  const toggleSave = useCallback(async () => {
    if (saving) return;
    const was = saved;
    setSaving(true);
    setSaved(!was);
    const res = was ? await unsaveMemory(memory.id) : await saveMemory(memory.id);
    setSaving(false);
    if (res.ok) { setSaved(res.savedByMe); return; }
    setSaved(was);
    Alert.alert(was ? 'Could not remove from saved' : 'Could not save', res.message);
  }, [saving, saved, memory.id]);

  return (
    <View style={s.row}>
      <StampButton
        entityType="memory"
        entityId={memory.id}
        controlledStamp={like}
        iconSize={20}
      />
      {!isOwner ? (
        <Pressable
          testID="memory-save-toggle"
          onPress={toggleSave}
          disabled={saving}
          style={s.action}
          accessibilityRole="button"
          accessibilityState={{ selected: saved, busy: saving }}
          accessibilityLabel={saved ? 'Remove from saved memories' : 'Save this memory'}
          hitSlop={6}
        >
          {saving ? <ActivityIndicator size="small" color={color.signal} />
            : saved ? <BookmarkCheck size={20} color={color.signal} /> : <Bookmark size={20} color={color.ink} />}
          <Text style={s.label}>{saved ? 'Saved' : 'Save'}</Text>
        </Pressable>
      ) : null}
      <Pressable
        testID="memory-share-open"
        onPress={() => setShareOpen(true)}
        style={s.action}
        accessibilityRole="button"
        accessibilityLabel="Share this memory"
        hitSlop={6}
      >
        <Share2 size={20} color={color.ink} />
        <Text style={s.label}>Share</Text>
      </Pressable>
      <MemoryShareSheet visible={shareOpen} memoryId={memory.id} onClose={() => setShareOpen(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.sm },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  label: { ...(t.small as object), color: color.ink, fontWeight: '600' },
});
