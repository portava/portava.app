/**
 * StampShowcaseCurationSheet — bottom sheet for selecting and reordering
 * up to MAX_SHOWCASE stamps on the user's showcase.
 *
 * Drag pattern mirrors PassportSectionReorderSheet (PanResponder / ROW_HEIGHT
 * swap), applied only to the selected-items section.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Animated, PanResponder,
  ScrollView, Image, ActivityIndicator,
} from 'react-native';
import { GripVertical, Check } from 'lucide-react-native';
import type { PassportStampNew } from '../../services/passportStamps.ts';
import { saveShowcase, MAX_SHOWCASE } from '../../services/stampShowcase.ts';
import { toLegacyStamp } from '../../services/passportStampMappers.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

import { RARITY_COLORS, normalizeRarity } from '../../lib/stampRarity.ts';

const ROW_HEIGHT = 60;

interface Props {
  visible: boolean;
  stamps: PassportStampNew[];
  /** The current showcase IDs (in display order). */
  currentIds: string[];
  onClose: () => void;
  /** Called with the updated ordered ID list after a successful save. */
  onSaved: (orderedIds: string[]) => void;
}

export function StampShowcaseCurationSheet({
  visible, stamps, currentIds, onClose, onSaved,
}: Props) {
  // Selected IDs in display order (draft state while sheet is open).
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // Drag state (for the selected list reorder section).
  const [dragId, setDragId] = useState<string | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;

  // Reset draft on open.
  useEffect(() => {
    if (visible) {
      setSelectedIds(currentIds.slice(0, MAX_SHOWCASE));
      setDragId(null);
      dragY.setValue(0);
    }
  }, [visible, currentIds, dragY]);

  // Refs for PanResponder (always sees fresh state).
  const selectedRef = useRef(selectedIds);
  selectedRef.current = selectedIds;
  const dragIdRef = useRef(dragId);
  dragIdRef.current = dragId;
  const dyOffsetRef = useRef(0);

  const beginDrag = useCallback((id: string) => {
    dyOffsetRef.current = 0;
    dragY.setValue(0);
    setDragId(id);
  }, [dragY]);

  const endDrag = useCallback(() => {
    setDragId(null);
    dragY.setValue(0);
  }, [dragY]);

  const makeResponder = useCallback((id: string) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderGrant: () => beginDrag(id),
      onPanResponderMove: (_e, g) => {
        const activeId = dragIdRef.current;
        if (!activeId) return;
        const dy = g.dy - dyOffsetRef.current;
        dragY.setValue(dy);
        const current = selectedRef.current;
        const fromIndex = current.indexOf(activeId);
        const targetIndex = Math.min(
          current.length - 1,
          Math.max(0, fromIndex + Math.round(dy / ROW_HEIGHT)),
        );
        if (targetIndex !== fromIndex) {
          const next = current.filter((k) => k !== activeId);
          next.splice(targetIndex, 0, activeId);
          setSelectedIds(next);
          dyOffsetRef.current += (targetIndex - fromIndex) * ROW_HEIGHT;
          dragY.setValue(g.dy - dyOffsetRef.current);
        }
      },
      onPanResponderRelease: endDrag,
      onPanResponderTerminate: endDrag,
    }), [beginDrag, endDrag, dragY]);

  const toggleStamp = useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= MAX_SHOWCASE) return prev; // cap reached
      return [...prev, id];
    });
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const ok = await saveShowcase(selectedIds);
    setSaving(false);
    if (ok) {
      onSaved(selectedIds);
      onClose();
    }
    // on failure: silently stay open so user can retry
  }, [selectedIds, onSaved, onClose]);

  // Derived: map stamp id → stamp for quick lookup.
  const stampById = React.useMemo(() => {
    const m: Record<string, PassportStampNew> = {};
    for (const s of stamps) m[s.id] = s;
    return m;
  }, [stamps]);

  // Stamps not yet in the selected list (picker section below).
  const unselected = stamps.filter((s) => !selectedIds.includes(s.id));

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={cs.overlay} onPress={onClose} />
      <View style={cs.sheet}>
        <View style={cs.handle} />
        <Text style={cs.title}>Feature your stamps</Text>
        <Text style={cs.subtitle}>
          Select up to {MAX_SHOWCASE} stamps — drag to reorder.
        </Text>

        <ScrollView
          style={cs.scrollArea}
          contentContainerStyle={cs.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ── Selected section (draggable) ───────────────────────────── */}
          {selectedIds.length > 0 && (
            <View style={cs.sectionHeader}>
              <Text style={cs.sectionLabel}>
                FEATURED ({selectedIds.length}/{MAX_SHOWCASE})
              </Text>
            </View>
          )}
          <View style={{ height: ROW_HEIGHT * selectedIds.length }}>
            {selectedIds.map((id, index) => {
              const stamp = stampById[id];
              if (!stamp) return null;
              const legacy = toLegacyStamp(stamp);
              const name = stamp.titleOverride ?? stamp.definition?.name ?? legacy.label;
              const rarity = stamp.definition?.rarity ?? 'common';
              const rarityColor = RARITY_COLORS[normalizeRarity(rarity)].ring;
              const artUrl = stamp.activeArtworkUrl;
              const isDragging = dragId === id;
              return (
                <Animated.View
                  key={id}
                  style={[
                    cs.selectedRow,
                    { top: index * ROW_HEIGHT },
                    isDragging && cs.draggingRow,
                    isDragging && { transform: [{ translateY: dragY }] },
                  ]}
                >
                  {/* Artwork */}
                  <View style={cs.artFrame}>
                    {artUrl ? (
                      <Image
                        source={{ uri: artUrl }}
                        style={cs.artImg}
                        resizeMode="cover"
                        accessibilityIgnoresInvertColors
                      />
                    ) : (
                      <View style={[cs.artImg, { backgroundColor: color.haze }]} />
                    )}
                    <View style={[cs.rarityDot, { backgroundColor: rarityColor }]} />
                  </View>

                  <View style={cs.rowInfo}>
                    <Text style={cs.rowName} numberOfLines={1}>{name}</Text>
                    {(stamp.city || stamp.country) && (
                      <Text style={cs.rowMeta} numberOfLines={1}>
                        {[stamp.city, stamp.country].filter(Boolean).join(', ')}
                      </Text>
                    )}
                  </View>

                  {/* Deselect */}
                  <Pressable
                    style={cs.checkBox}
                    onPress={() => toggleStamp(id)}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Remove ${name} from showcase`}
                    accessibilityState={{ checked: true }}
                  >
                    <Check size={14} color="#fff" strokeWidth={3} />
                  </Pressable>

                  {/* Drag grip */}
                  <View
                    {...makeResponder(id).panHandlers}
                    style={cs.grip}
                    accessibilityLabel={`Drag to reorder ${name}`}
                  >
                    <GripVertical size={20} color={color.faint} />
                  </View>
                </Animated.View>
              );
            })}
          </View>

          {/* ── Unselected section (picker) ────────────────────────────── */}
          {unselected.length > 0 && (
            <>
              <View style={cs.sectionHeader}>
                <Text style={cs.sectionLabel}>YOUR STAMPS</Text>
              </View>
              {unselected.map((stamp) => {
                const legacy = toLegacyStamp(stamp);
                const name = stamp.titleOverride ?? stamp.definition?.name ?? legacy.label;
                const rarity = stamp.definition?.rarity ?? 'common';
                const rarityColor = RARITY_COLORS[normalizeRarity(rarity)].ring;
                const artUrl = stamp.activeArtworkUrl;
                const atCap = selectedIds.length >= MAX_SHOWCASE;
                return (
                  <Pressable
                    key={stamp.id}
                    style={[cs.unselectedRow, atCap && cs.unselectedRowDimmed]}
                    onPress={() => toggleStamp(stamp.id)}
                    disabled={atCap}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Add ${name} to showcase`}
                    accessibilityState={{ checked: false }}
                  >
                    <View style={cs.artFrame}>
                      {artUrl ? (
                        <Image
                          source={{ uri: artUrl }}
                          style={cs.artImg}
                          resizeMode="cover"
                          accessibilityIgnoresInvertColors
                        />
                      ) : (
                        <View style={[cs.artImg, { backgroundColor: color.haze }]} />
                      )}
                      <View style={[cs.rarityDot, { backgroundColor: rarityColor }]} />
                    </View>
                    <View style={cs.rowInfo}>
                      <Text style={cs.rowName} numberOfLines={1}>{name}</Text>
                      {(stamp.city || stamp.country) && (
                        <Text style={cs.rowMeta} numberOfLines={1}>
                          {[stamp.city, stamp.country].filter(Boolean).join(', ')}
                        </Text>
                      )}
                    </View>
                    <View style={cs.emptyCheck} />
                  </Pressable>
                );
              })}
            </>
          )}
        </ScrollView>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <View style={cs.footer}>
          <Pressable style={cs.cancelBtn} onPress={onClose} disabled={saving}>
            <Text style={cs.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[cs.saveBtn, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save showcase"
          >
            {saving
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={cs.saveText}>Save</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const ART_SIZE = 44;

const cs = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' },
  sheet: {
    backgroundColor: color.paperRaised,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingTop: space.md, paddingBottom: 36,
    maxHeight: '85%',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: color.haze, alignSelf: 'center', marginBottom: space.md,
  },
  title: {
    ...t.bodyStrong, color: color.ink, fontSize: 17, fontWeight: '700',
    textAlign: 'center',
  },
  subtitle: {
    ...t.small, color: color.mute, textAlign: 'center',
    marginTop: 4, lineHeight: 17, paddingHorizontal: space.xl,
  },
  scrollArea: { marginTop: space.md },
  scrollContent: { paddingHorizontal: space.lg, paddingBottom: space.lg },

  sectionHeader: {
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.haze,
    marginBottom: 2,
  },
  sectionLabel: {
    fontSize: 9, fontWeight: '700', letterSpacing: 1.1,
    color: color.mute, fontFamily: 'Courier',
  },

  /* Draggable selected rows */
  selectedRow: {
    position: 'absolute', left: 0, right: 0, height: ROW_HEIGHT,
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  draggingRow: {
    zIndex: 10, elevation: 6,
    shadowColor: color.ink, shadowOpacity: 0.14, shadowRadius: 10,
  },

  /* Unselected picker rows */
  unselectedRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    height: ROW_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  unselectedRowDimmed: { opacity: 0.4 },

  artFrame: {
    width: ART_SIZE, height: ART_SIZE,
    borderRadius: ART_SIZE / 6, overflow: 'hidden',
    backgroundColor: color.haze, position: 'relative', flexShrink: 0,
  },
  artImg: { width: ART_SIZE, height: ART_SIZE },
  rarityDot: {
    position: 'absolute', bottom: 3, right: 3,
    width: 7, height: 7, borderRadius: 3.5,
    borderWidth: 1.5, borderColor: '#fff',
  },
  rowInfo: { flex: 1, minWidth: 0 },
  rowName: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowMeta: { ...t.small, color: color.mute, fontSize: 11, marginTop: 1 },

  checkBox: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: color.signal,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  emptyCheck: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 1.5, borderColor: color.haze,
    flexShrink: 0,
  },
  grip: { paddingVertical: 14, paddingLeft: 8, paddingRight: 4, flexShrink: 0 },

  footer: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze,
  },
  cancelBtn: {
    paddingHorizontal: space.lg, paddingVertical: 13,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
  },
  cancelText: { ...t.bodyStrong, color: color.mute, fontWeight: '600' },
  saveBtn: {
    flex: 1, backgroundColor: color.ink,
    borderRadius: radius.pill, paddingVertical: 13, alignItems: 'center',
  },
  saveText: { ...t.bodyStrong, color: color.paperRaised, fontWeight: '700' },
});
