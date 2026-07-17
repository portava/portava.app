/**
 * SaveToCollectionSheet — bottom sheet for picking or creating a collection.
 *
 * Shows the user's collections. Tapping one saves the item there.
 * "New collection" shows an inline name field and creates on confirm.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView,
  StyleSheet, TextInput, ActivityIndicator,
} from 'react-native';
import { Bookmark, FolderPlus, Check, X } from 'lucide-react-native';
import type { EntityType, Collection } from '../services/collections.ts';
import {
  getCollections, createCollection, saveItem,
} from '../services/collections.ts';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';

interface SaveToCollectionSheetProps {
  visible: boolean;
  entityType: EntityType;
  entityId: string;
  onClose: () => void;
  onSaved: (collectionId: string) => void;
}

const SUGGESTED_NAMES = ['Food', 'Nightlife', 'Beaches', 'Hidden Gems', 'Future Trips'];

export function SaveToCollectionSheet({
  visible,
  entityType,
  entityId,
  onClose,
  onSaved,
}: SaveToCollectionSheetProps) {
  const [collections, setCollections]   = useState<Collection[]>([]);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState<string | null>(null);
  const [creating, setCreating]         = useState(false);
  const [newName, setNewName]           = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const cols = await getCollections();
      setCollections(cols);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) { void load(); }
  }, [visible, load]);

  const handlePick = async (col: Collection) => {
    setSaving(col.id);
    await saveItem(entityType, entityId, col.id);
    setSaving(null);
    onSaved(col.id);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreateLoading(true);
    const col = await createCollection(name);
    if (col) {
      await saveItem(entityType, entityId, col.id);
      setCreating(false);
      setNewName('');
      onSaved(col.id);
    }
    setCreateLoading(false);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={s.sheet}>
        <View style={s.handle} />

        <View style={s.header}>
          <Text style={s.title}>Save to</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={20} color={color.ink} />
          </Pressable>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator color={color.signal} /></View>
        ) : (
          <ScrollView
            contentContainerStyle={s.list}
            keyboardShouldPersistTaps="handled"
          >
            {collections.map((col) => (
              <Pressable
                key={col.id}
                style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
                onPress={() => handlePick(col)}
              >
                <View style={s.rowIcon}>
                  <Bookmark size={16} color={color.signal} />
                </View>
                <View style={s.rowBody}>
                  <Text style={s.rowName}>{col.name}</Text>
                  <Text style={s.rowMeta}>{col.itemCount} {col.itemCount === 1 ? 'item' : 'items'}</Text>
                </View>
                {saving === col.id ? (
                  <ActivityIndicator size="small" color={color.signal} />
                ) : (
                  <Check size={16} color={color.haze} />
                )}
              </Pressable>
            ))}

            {/* New collection */}
            {creating ? (
              <View style={s.createBox}>
                <TextInput
                  style={s.createInput}
                  value={newName}
                  onChangeText={setNewName}
                  placeholder="Collection name"
                  placeholderTextColor={color.faint}
                  autoFocus
                  maxLength={120}
                  returnKeyType="done"
                  onSubmitEditing={handleCreate}
                />
                <View style={s.suggestRow}>
                  {SUGGESTED_NAMES.filter((n) => !collections.some((c) => c.name === n)).map((n) => (
                    <Pressable key={n} style={s.suggestChip} onPress={() => setNewName(n)}>
                      <Text style={s.suggestLabel}>{n}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={s.createActions}>
                  <Pressable
                    style={s.cancelBtn}
                    onPress={() => { setCreating(false); setNewName(''); }}
                  >
                    <Text style={s.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[s.confirmBtn, (!newName.trim() || createLoading) && s.btnDisabled]}
                    onPress={handleCreate}
                    disabled={!newName.trim() || createLoading}
                  >
                    {createLoading
                      ? <ActivityIndicator size="small" color={color.onInk} />
                      : <Text style={s.confirmText}>Create & Save</Text>
                    }
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={({ pressed }) => [s.newRow, pressed && { opacity: 0.7 }]}
                onPress={() => setCreating(true)}
              >
                <FolderPlus size={18} color={color.deep} />
                <Text style={s.newText}>New collection</Text>
              </Pressable>
            )}
          </ScrollView>
        )}
      </View>
      </KeyboardSafeScrollView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    ...shadow.float,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginTop: space.md,
    marginBottom: space.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  title: {
    ...t.heading,
    fontSize: 16,
    color: color.ink,
  },
  center: {
    paddingVertical: space.xxxl,
    alignItems: 'center',
  },
  list: {
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    gap: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze + '60',
  },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: `${color.signal}15`,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, gap: 2 },
  rowName: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowMeta: { ...t.small, color: color.mute, fontSize: 11 },
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.lg,
  },
  newText: { ...t.bodyStrong, color: color.deep, fontSize: 14 },
  createBox: { gap: space.md, paddingVertical: space.md },
  createInput: {
    borderWidth: 1.5,
    borderColor: color.signal,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 14,
    color: color.ink,
  },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  suggestChip: {
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  suggestLabel: { ...t.small, color: color.mute, fontSize: 12 },
  createActions: { flexDirection: 'row', gap: space.md },
  cancelBtn: {
    flex: 1,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.haze,
    alignItems: 'center',
  },
  cancelText: { ...t.bodyStrong, color: color.mute, fontWeight: '600' },
  confirmBtn: {
    flex: 2,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.signal,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  confirmText: { ...t.bodyStrong, color: color.onInk, fontWeight: '700' },
});
