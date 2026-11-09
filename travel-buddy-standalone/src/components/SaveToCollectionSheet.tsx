/**
 * SaveToCollectionSheet — bottom sheet for picking or creating a collection.
 *
 * Shows the user's collections. Tapping one saves the item there.
 * "New collection" shows an inline name field and creates on confirm.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView,
  StyleSheet, TextInput, ActivityIndicator,
} from 'react-native';
import { Bookmark, FolderPlus, Check, X } from 'lucide-react-native';
import type { EntityType, Collection } from '../services/collections.ts';
import {
  readCollections, checkSaved, createCollection, saveItem, unsaveItem,
} from '../services/collections.ts';
import { color, space, radius, type as t, shadow } from '../theme/tokens.ts';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { onDiscoveryScopeChange } from '../services/discoveryViewerScope.ts';

interface SaveToCollectionSheetProps {
  visible: boolean;
  entityType: EntityType;
  entityId: string;
  onClose: () => void;
  onSaved: (collectionId: string | null) => void;
  isSaved?: boolean;
  onUnsaved?: () => void;
  onStatusRead?: (saved: boolean) => void;
  /** Render in an existing native modal, avoiding two simultaneous iOS presenters. */
  embedded?: boolean;
  /** Existing wishlist/provider entries can be filed without a collection-item UUID. */
  savedPlace?: { collectionIds: string[]; fileInto: (collectionId: string) => Promise<boolean> };
}

const SUGGESTED_NAMES = ['Food', 'Nightlife', 'Beaches', 'Hidden Gems', 'Future Trips'];

export function SaveToCollectionSheet({
  visible,
  entityType,
  entityId,
  onClose,
  onSaved,
  isSaved = false,
  onUnsaved,
  onStatusRead,
  embedded = false,
  savedPlace,
}: SaveToCollectionSheetProps) {
  const statusCallback = useRef(onStatusRead);
  statusCallback.current = onStatusRead;
  const [collections, setCollections]   = useState<Collection[]>([]);
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState<string | null>(null);
  const [creating, setCreating]         = useState(false);
  const [newName, setNewName]           = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [loadFailed, setLoadFailed]     = useState(false);
  const [savedCollectionIds, setSavedCollectionIds] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [savedForLater, setSavedForLater] = useState(false);
  const [removing, setRemoving] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const owner = useRef<MessagingOwnerRequest | null>(null);
  const pending = saving !== null || createLoading || removing;
  const savedAnywhere = isSaved || savedForLater || savedCollectionIds.length > 0;

  const load = useCallback(async () => {
    const request = ++generation.current;
    owner.current = captureMessagingOwnerRequest();
    setLoading(true);
    try {
      const [read, savedState] = await Promise.all([
        readCollections(), savedPlace ? Promise.resolve({ok:true, saved:true, collectionIds:savedPlace.collectionIds}) : checkSaved(entityType, entityId),
      ]);
      if (request !== generation.current) return;
      if (!owner.current?.isCurrent()) { setLoadFailed(true); return; }
      setCollections(read.data);
      setSavedCollectionIds(savedState.collectionIds);
      setSavedForLater(savedState.ok !== false && savedState.saved);
      setLoadFailed(!read.ok || savedState.ok === false);
      if (savedState.ok !== false) statusCallback.current?.(savedState.saved);
    } catch {
      if (request === generation.current) setLoadFailed(true);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [entityType, entityId, savedPlace]);

  useEffect(() => {
    let mounted = true;
    const changed = () => {
      if (!mounted || !visible || !owner.current || owner.current.isCurrent()) return;
      generation.current += 1;
      owner.current = null;
      busy.current = false;
      setSaving(null); setCreateLoading(false); setRemoving(false);
      setCollections([]); setSavedCollectionIds([]); setSavedForLater(false);
      setLoading(false); setLoadFailed(true); setCreating(false);
      onClose();
    };
    const stop = onDiscoveryScopeChange(changed);
    const subscription = isSupabaseConfigured ? supabase.auth.onAuthStateChange(() => { queueMicrotask(changed); }).data.subscription : null;
    return () => { mounted = false; stop(); subscription?.unsubscribe(); };
  }, [visible, onClose]);

  useEffect(() => {
    if (visible) {
      busy.current = false;
      setSaving(null);
      setCreateLoading(false);
      setRemoving(false);
      setError(null);
      setConfirmation(null);
      setSavedForLater(false);
      setCreating(false);
      setNewName('');
      setCollections([]);
      setSavedCollectionIds([]);
      void load();
    }
    return () => { generation.current += 1; };
  }, [visible, load]);

  const finishSave = (col: Collection) => {
    setSavedCollectionIds((ids) => [...new Set([...ids, col.id])]);
    setCollections((cols) => cols.map((c) => c.id === col.id ? { ...c, itemCount: c.itemCount + 1 } : c));
    setConfirmation(`Saved to “${col.name}”.`);
    onSaved(col.id);
  };

  const handlePick = async (col: Collection | null) => {
    if (!owner.current?.isCurrent() || busy.current || (col ? savedCollectionIds.includes(col.id) : savedAnywhere)) return;
    busy.current = true;
    const request = generation.current;
    setSaving(col?.id ?? 'unfiled');
    setError(null);
    setConfirmation(null);
    try {
      const ok = savedPlace && col ? await savedPlace.fileInto(col.id) : await saveItem(entityType, entityId, col?.id);
      if (request !== generation.current || !owner.current?.isCurrent()) return;
      if (!ok) { setError(col ? `Couldn't save to “${col.name}”. Please try again.` : "Couldn't save this item. Please try again."); return; }
      if (col) finishSave(col);
      else {
        setSavedForLater(true);
        setConfirmation('Saved. You can add it to a collection anytime.');
        onSaved(null);
      }
    } catch {
      if (request === generation.current) setError(col ? `Couldn't save to “${col.name}”. Please try again.` : "Couldn't save this item. Please try again.");
    } finally {
      if (request === generation.current) { busy.current = false; setSaving(null); }
    }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || !owner.current?.isCurrent() || busy.current) return;
    busy.current = true;
    const request = generation.current;
    setCreateLoading(true);
    setError(null);
    setConfirmation(null);
    let created: Collection | null = null;
    try {
      const col = await createCollection(name);
      if (request !== generation.current || !owner.current?.isCurrent()) return;
      if (!col) { setError(`Couldn't create “${name}”. Please try again.`); return; }
      created = col;
      // Keep the created collection visible even if saving the item fails.
      setCollections((prev) => [...prev, col]);
      setCreating(false);
      setNewName('');
      const ok = savedPlace ? await savedPlace.fileInto(col.id) : await saveItem(entityType, entityId, col.id);
      if (request !== generation.current || !owner.current?.isCurrent()) return;
      if (!ok) { setError(`Created “${col.name}” but couldn't save to it. Please try again.`); return; }
      finishSave(col);
    } catch {
      if (request === generation.current) setError(created
        ? `Created “${created.name}” but couldn't save to it. Please try again.`
        : `Couldn't create “${name}”. Please try again.`);
    } finally {
      if (request === generation.current) { busy.current = false; setCreateLoading(false); }
    }
  };

  const handleRemove = async () => {
    if (!owner.current?.isCurrent() || busy.current) return;
    busy.current = true;
    const request = generation.current;
    setRemoving(true);
    setError(null);
    setConfirmation(null);
    try {
      const ok = await unsaveItem(entityType, entityId);
      if (request !== generation.current || !owner.current?.isCurrent()) return;
      if (!ok) { setError("Couldn't remove this saved item. Please try again."); return; }
      setSavedCollectionIds([]);
      setSavedForLater(false);
      onUnsaved?.();
    } catch {
      if (request === generation.current) setError("Couldn't remove this saved item. Please try again.");
    } finally {
      if (request === generation.current) { busy.current = false; setRemoving(false); }
    }
  };

  const close = () => { if (!busy.current) onClose(); };

  const contents = (
      <KeyboardSafeScrollView style={{ justifyContent: 'flex-end' }}>
      <Pressable style={s.backdrop} onPress={close} disabled={pending} />
      <View style={s.sheet}>
        <View style={s.handle} />

        <View style={s.header}>
          <Text style={s.title}>Save to collections</Text>
          <Pressable onPress={close} disabled={pending} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close collections">
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
            <Text style={s.helpText}>Choose a collection or create one. You can save to more than one.</Text>
            {confirmation ? <Text style={s.helpText} accessibilityLiveRegion="polite">{confirmation}</Text> : null}
            {error ? (
              <Text style={s.errorText} accessibilityRole="alert" testID="save-to-collection-error">{error}</Text>
            ) : null}
            {/* A failed read is not "you have no collections": say so, and keep the new-collection row. */}
            {loadFailed ? (
              <Pressable disabled={pending} onPress={() => void load()} accessibilityRole="button" accessibilityLabel="Try loading your collections again" testID="save-to-collection-load-error">
                <Text style={s.errorText}>Your collections could not be loaded. Tap to try again.</Text>
              </Pressable>
            ) : null}
            {!savedAnywhere && !loadFailed ? (
              <Pressable style={s.row} onPress={() => handlePick(null)} disabled={pending} accessibilityRole="button" accessibilityLabel="Save for later">
                <View style={s.rowIcon}><Bookmark size={16} color={color.signal} /></View>
                <View style={s.rowBody}>
                  <Text style={s.rowName}>Save for later</Text>
                  <Text style={s.rowMeta}>Choose a collection anytime</Text>
                </View>
                {saving === 'unfiled' ? <ActivityIndicator size="small" color={color.signal} /> : null}
              </Pressable>
            ) : null}
            {collections.map((col) => (
              <Pressable
                key={col.id}
                style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
                onPress={() => handlePick(col)}
                disabled={pending || loadFailed || savedCollectionIds.includes(col.id)}
                accessibilityRole="button"
                accessibilityLabel={`${savedCollectionIds.includes(col.id) ? 'Saved to' : 'Save to'} ${col.name}`}
                accessibilityState={{ selected: savedCollectionIds.includes(col.id), disabled: pending || loadFailed || savedCollectionIds.includes(col.id) }}
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
                ) : savedCollectionIds.includes(col.id) ? <Check size={16} color={color.signal} /> : null}
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
                  onSubmitEditing={() => { void handleCreate(); }}
                  editable={!pending}
                  accessibilityLabel="Collection name"
                />
                <View style={s.suggestRow}>
                  {SUGGESTED_NAMES.filter((n) => !collections.some((c) => c.name === n)).map((n) => (
                    <Pressable key={n} disabled={pending} style={s.suggestChip} onPress={() => setNewName(n)}>
                      <Text style={s.suggestLabel}>{n}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={s.createActions}>
                  <Pressable
                    style={s.cancelBtn}
                    onPress={() => { setCreating(false); setNewName(''); }}
                    disabled={pending}
                    accessibilityRole="button"
                  >
                    <Text style={s.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={[s.confirmBtn, (!newName.trim() || createLoading) && s.btnDisabled]}
                    onPress={() => { void handleCreate(); }}
                    disabled={!newName.trim() || pending}
                    accessibilityRole="button"
                    accessibilityLabel="Create and save"
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
                disabled={pending}
                accessibilityRole="button"
                accessibilityLabel="New collection"
              >
                <FolderPlus size={18} color={color.deep} />
                <Text style={s.newText}>New collection</Text>
              </Pressable>
            )}
            {savedAnywhere && onUnsaved ? (
              <Pressable style={s.newRow} onPress={handleRemove} disabled={pending} accessibilityRole="button" accessibilityLabel="Remove from saved and all collections">
                {removing ? <ActivityIndicator color={color.signal} /> : <Text style={s.newText}>Remove from saved and all collections</Text>}
              </Pressable>
            ) : null}
            <Pressable style={[s.confirmBtn, { flex: 0 }, pending && s.btnDisabled]} onPress={close} disabled={pending} accessibilityRole="button" accessibilityLabel="Done">
              <Text style={s.confirmText}>Done</Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
      </KeyboardSafeScrollView>
  );
  if (embedded) return visible ? contents : null;
  return <Modal visible={visible} animationType="slide" transparent statusBarTranslucent onRequestClose={close}>{contents}</Modal>;
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
    paddingBottom: space.xxxl,
  },
  helpText: { ...t.small, color: color.mute, paddingVertical: space.sm },
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
  errorText: { ...t.small, color: color.ink, fontWeight: '600', paddingTop: space.sm },
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
