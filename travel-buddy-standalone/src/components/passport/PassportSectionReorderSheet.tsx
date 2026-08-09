/**
 * PassportSectionReorderSheet — drag-to-reorder the owner's passport sections,
 * with per-section visibility toggles (eye / eye-off).
 *
 * Five fixed-height rows; long-press-free pan drag on the grip handle.
 * Saves via PATCH /me/profile (passportSectionOrder + passportHiddenSections).
 * "Reset" restores canonical order and clears all hidden sections (persists null).
 *
 * The 'identity' row never shows an eye icon — it cannot be hidden.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Animated, PanResponder, ActivityIndicator, Alert,
} from 'react-native';
import { GripVertical, RotateCcw, Eye, EyeOff } from 'lucide-react-native';
import { updateMyProfile } from '../../services/profile.ts';
import {
  CANONICAL_SECTION_ORDER, SECTION_LABELS, isCanonicalOrder, resolveSectionOrder,
  NON_HIDEABLE_SECTIONS, resolveHiddenSections,
  type PassportSectionKey,
} from './passportSections.ts';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { space, radius, type as t, icon } from '../../theme/tokens.ts';

const ROW_HEIGHT = 56;

interface Props {
  visible: boolean;
  initialOrder: string[] | null | undefined;
  /** Current hidden sections so the sheet opens in the right state. */
  initialHidden?: string[] | null;
  onClose: () => void;
  /** Called with the saved order and hidden set after a successful save. */
  onSaved: (order: PassportSectionKey[], hidden: PassportSectionKey[]) => void;
}

export function PassportSectionReorderSheet({ visible, initialOrder, initialHidden, onClose, onSaved }: Props) {
  const [order, setOrder] = useState<PassportSectionKey[]>(() => resolveSectionOrder(initialOrder));
  const [hidden, setHidden] = useState<Set<PassportSectionKey>>(() => resolveHiddenSections(initialHidden));
  const [dragKey, setDragKey] = useState<PassportSectionKey | null>(null);
  const [saving, setSaving] = useState(false);
  const dragY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      setOrder(resolveSectionOrder(initialOrder));
      setHidden(resolveHiddenSections(initialHidden));
    }
  }, [visible, initialOrder, initialHidden]);

  // Refs so the PanResponder always sees fresh state.
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragKeyRef = useRef(dragKey);
  dragKeyRef.current = dragKey;
  const startIndexRef = useRef(0);

  const beginDrag = useCallback((key: PassportSectionKey) => {
    startIndexRef.current = orderRef.current.indexOf(key);
    dragY.setValue(0);
    setDragKey(key);
  }, [dragY]);

  const endDrag = useCallback(() => {
    setDragKey(null);
    dragY.setValue(0);
  }, [dragY]);

  // Rebase handling: PanResponder gives cumulative dy, so track an offset.
  const dyOffsetRef = useRef(0);

  const makeResponder = useCallback((key: PassportSectionKey) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        dyOffsetRef.current = 0;
        beginDrag(key);
      },
      onPanResponderMove: (_e, g) => {
        const key2 = dragKeyRef.current;
        if (!key2) return;
        const dy = g.dy - dyOffsetRef.current;
        dragY.setValue(dy);
        const current = orderRef.current;
        const fromIndex = current.indexOf(key2);
        const targetIndex = Math.min(
          current.length - 1,
          Math.max(0, fromIndex + Math.round(dy / ROW_HEIGHT)),
        );
        if (targetIndex !== fromIndex) {
          const next = current.filter((k) => k !== key2);
          next.splice(targetIndex, 0, key2);
          setOrder(next);
          dyOffsetRef.current += (targetIndex - fromIndex) * ROW_HEIGHT;
          dragY.setValue(g.dy - dyOffsetRef.current);
        }
      },
      onPanResponderRelease: endDrag,
      onPanResponderTerminate: endDrag,
    }), [beginDrag, endDrag, dragY]);

  const toggleHidden = useCallback((key: PassportSectionKey) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setOrder([...CANONICAL_SECTION_ORDER]);
    setHidden(new Set());
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const canonical = isCanonicalOrder(order);
    const hiddenArr = Array.from(hidden) as PassportSectionKey[];
    const res = await updateMyProfile({
      passportSectionOrder: canonical ? null : order,
      passportHiddenSections: hiddenArr.length === 0 ? null : hiddenArr,
    });
    setSaving(false);
    if (!res.ok) {
      Alert.alert('Could not save layout', res.message ?? 'Please try again.');
      return;
    }
    onSaved(order, hiddenArr);
    onClose();
  }, [order, hidden, onSaved, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={rs.overlay} onPress={onClose} />
      <View style={rs.sheet}>
        <View style={rs.handle} />
        <Text style={rs.title}>Arrange your passport</Text>
        <Text style={rs.subtitle}>
          Drag sections into the order that tells your travel story. Tap the eye to show or hide a section. Visitors always see the classic layout.
        </Text>

        <View style={{ height: ROW_HEIGHT * order.length, marginTop: space.md }}>
          {order.map((key, index) => {
            const isDragging = dragKey === key;
            const isHidden = hidden.has(key);
            const canHide = !NON_HIDEABLE_SECTIONS.includes(key);
            return (
              <Animated.View
                key={key}
                style={[
                  rs.row,
                  { top: index * ROW_HEIGHT },
                  isHidden && rs.rowHidden,
                  isDragging && {
                    transform: [{ translateY: dragY }],
                    zIndex: 10, elevation: 6,
                    shadowColor: PP.ink, shadowOpacity: 0.18, shadowRadius: 10,
                    backgroundColor: PP.paper,
                  },
                ]}
              >
                <View style={rs.rowIndex}>
                  <Text style={rs.rowIndexText}>{index + 1}</Text>
                </View>
                <Text style={[rs.rowLabel, isHidden && rs.rowLabelHidden]}>
                  {SECTION_LABELS[key]}{isHidden ? ' (Hidden)' : ''}
                </Text>
                {canHide ? (
                  <Pressable
                    style={rs.eyeBtn}
                    onPress={() => toggleHidden(key)}
                    accessibilityLabel={isHidden ? `Show ${SECTION_LABELS[key]}` : `Hide ${SECTION_LABELS[key]}`}
                    accessibilityRole="button"
                    hitSlop={8}
                  >
                    {isHidden
                      ? <EyeOff size={18} color={PP.inkMuted} />
                      : <Eye size={18} color={PP.inkMuted} />}
                  </Pressable>
                ) : (
                  <View style={rs.eyeBtn} />
                )}
                <View
                  {...makeResponder(key).panHandlers}
                  style={rs.grip}
                  accessibilityLabel={`Reorder ${SECTION_LABELS[key]}`}
                >
                  <GripVertical size={20} color={PP.inkMuted} />
                </View>
              </Animated.View>
            );
          })}
        </View>

        <View style={rs.footer}>
          <Pressable style={rs.resetBtn} onPress={handleReset} disabled={saving}>
            <RotateCcw size={14} color={PP.inkMuted} />
            <Text style={rs.resetText}>Reset</Text>
          </Pressable>
          <Pressable
            style={[rs.saveBtn, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save section order"
          >
            {saving
              ? <ActivityIndicator size="small" color={PP.paper} />
              : <Text style={rs.saveText}>Save layout</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const rs = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' },
  sheet: {
    backgroundColor: PP.paper,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 36,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: PP.borderLight, alignSelf: 'center', marginBottom: space.md,
  },
  title: { ...t.bodyStrong, color: PP.ink, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  subtitle: {
    ...t.small, color: PP.inkMuted, textAlign: 'center',
    marginTop: 4, lineHeight: 17, paddingHorizontal: space.md,
  },
  row: {
    position: 'absolute', left: 0, right: 0, height: ROW_HEIGHT,
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: PP.borderLight,
    backgroundColor: PP.paper,
  },
  rowHidden: { opacity: 0.45 },
  rowIndex: {
    width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2,
    backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center',
  },
  rowIndexText: { ...PP_LABEL, fontSize: 11, color: PP.inkMuted },
  rowLabel: { ...t.bodyStrong, color: PP.ink, fontSize: 15, flex: 1 },
  rowLabelHidden: { color: PP.inkMuted },
  eyeBtn: { paddingVertical: 10, paddingHorizontal: 6, width: 34, alignItems: 'center' },
  grip: { paddingVertical: 14, paddingLeft: 8, paddingRight: 4 },
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg,
  },
  resetBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.md, paddingVertical: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: PP.borderLight,
  },
  resetText: { ...t.small, color: PP.inkMuted, fontWeight: '600' },
  saveBtn: {
    flex: 1, backgroundColor: PP.ink, borderRadius: radius.pill,
    paddingVertical: 13, alignItems: 'center',
  },
  saveText: { ...t.bodyStrong, color: PP.paper, fontWeight: '700' },
});
