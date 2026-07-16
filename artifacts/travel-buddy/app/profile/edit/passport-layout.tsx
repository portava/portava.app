/**
 * Passport Layout — Edit Profile & Settings sub-page.
 *
 * Inline (non-modal) drag-to-reorder of the owner's passport sections. Row /
 * PanResponder logic is duplicated from PassportSectionReorderSheet (that sheet
 * is untouched and keeps working). Saves via updateMyProfile({ passportSectionOrder }):
 * canonical order persists null. All five sections are draggable — passportSections.ts
 * marks none as required/fixed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Animated, PanResponder, ActivityIndicator,
} from 'react-native';
import { GripVertical, RotateCcw } from 'lucide-react-native';
import {
  SettingsScreen, SettingsSection, SaveBar, useUnsavedGuard, useSavedThenBack, type SaveState,
} from '../../../src/components/settings/SettingsUI';
import { PP, PP_LABEL } from '../../../src/theme/passportTokens';
import { space, radius, type as t } from '../../../src/theme/tokens';
import { getMyProfile, updateMyProfile } from '../../../src/services/profile';
import { resolveProfileSaveOutcome } from '../../../src/services/profileSaveFlow';
import {
  CANONICAL_SECTION_ORDER, SECTION_LABELS, isCanonicalOrder, resolveSectionOrder,
  type PassportSectionKey,
} from '../../../src/components/passport/passportSections';

const ROW_HEIGHT = 56;

function ordersEqual(a: PassportSectionKey[], b: PassportSectionKey[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

export default function PassportLayoutScreen() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<PassportSectionKey[]>(() => [...CANONICAL_SECTION_ORDER]);
  const [order, setOrder] = useState<PassportSectionKey[]>(() => [...CANONICAL_SECTION_ORDER]);
  const [dragKey, setDragKey] = useState<PassportSectionKey | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const savedThenBack = useSavedThenBack(setSaveState);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dragY = useRef(new Animated.Value(0)).current;

  const dirty = !ordersEqual(order, baseline);
  useUnsavedGuard(dirty);

  // Load initial order via getMyProfile.
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await getMyProfile();
      if (!alive) return;
      setLoading(false);
      if (res.ok && res.data) {
        const resolved = resolveSectionOrder(res.data.passportSectionOrder);
        setBaseline(resolved);
        setOrder(resolved);
      } else {
        setLoadError(res.message ?? 'Could not load your passport layout');
      }
    })();
    return () => { alive = false; };
  }, []);

  // Refs so PanResponder always sees fresh state (duplicated from the sheet).
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragKeyRef = useRef(dragKey);
  dragKeyRef.current = dragKey;
  const startIndexRef = useRef(0);
  const dyOffsetRef = useRef(0);

  const beginDrag = useCallback((key: PassportSectionKey) => {
    startIndexRef.current = orderRef.current.indexOf(key);
    dragY.setValue(0);
    setDragKey(key);
  }, [dragY]);

  const endDrag = useCallback(() => {
    setDragKey(null);
    dragY.setValue(0);
  }, [dragY]);

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

  const handleReset = useCallback(() => {
    setOrder([...CANONICAL_SECTION_ORDER]);
    if (saveState !== 'idle') setSaveState('idle');
  }, [saveState]);

  const handleSave = useCallback(async () => {
    setSaveState('saving');
    setSaveError(null);
    const canonical = isCanonicalOrder(order);
    const res = await updateMyProfile({ passportSectionOrder: canonical ? null : order });
    const outcome = resolveProfileSaveOutcome(res, 'Please try again.');
    if (outcome.kind === 'error') {
      setSaveState('error');
      setSaveError(outcome.message);
      return;
    }
    // Reset dirty baseline; show 'saved' briefly, then auto-return to the
    // previous screen (universal post-save behavior).
    setBaseline(order);
    savedThenBack();
  }, [order]);

  if (loading) {
    return (
      <SettingsScreen title="Passport Layout" subtitle="Arrange your passport sections">
        <View style={sx.loading}><ActivityIndicator color={PP.ink} /></View>
      </SettingsScreen>
    );
  }

  if (loadError) {
    return (
      <SettingsScreen title="Passport Layout" subtitle="Arrange your passport sections">
        <View style={sx.loading}><Text style={sx.errorText}>{loadError}</Text></View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title="Passport Layout" subtitle="Arrange your passport sections">
      <SettingsSection
        title="Section Order"
        subtitle="Drag sections into the order that tells your travel story. Visitors always see the classic layout."
      >
        <View style={{ height: ROW_HEIGHT * order.length }}>
          {order.map((key, index) => {
            const isDragging = dragKey === key;
            return (
              <Animated.View
                key={key}
                style={[
                  sx.row,
                  { top: index * ROW_HEIGHT },
                  isDragging && {
                    transform: [{ translateY: dragY }],
                    zIndex: 10, elevation: 6,
                    shadowColor: PP.ink, shadowOpacity: 0.18, shadowRadius: 10,
                    backgroundColor: '#FFFDF7',
                  },
                ]}
              >
                <View style={sx.rowIndex}>
                  <Text style={sx.rowIndexText}>{index + 1}</Text>
                </View>
                <Text style={sx.rowLabel}>{SECTION_LABELS[key]}</Text>
                <View
                  {...makeResponder(key).panHandlers}
                  style={sx.grip}
                  accessibilityLabel={`Reorder ${SECTION_LABELS[key]}`}
                >
                  <GripVertical size={20} color={PP.inkMuted} />
                </View>
              </Animated.View>
            );
          })}
        </View>
      </SettingsSection>

      {/* Preview strip */}
      <View style={sx.previewBlock}>
        <Text style={sx.previewLabel}>Preview</Text>
        <View style={sx.previewStrip}>
          {order.map((key, index) => (
            <View key={key} style={sx.pill}>
              <View style={sx.pillNum}><Text style={sx.pillNumText}>{index + 1}</Text></View>
              <Text style={sx.pillText} numberOfLines={1}>{SECTION_LABELS[key]}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Reset */}
      <Pressable
        style={sx.resetBtn}
        onPress={handleReset}
        disabled={saveState === 'saving' || isCanonicalOrder(order)}
        accessibilityRole="button"
        accessibilityLabel="Reset to classic layout"
      >
        <RotateCcw size={14} color={PP.inkMuted} />
        <Text style={sx.resetText}>Reset to classic layout</Text>
      </Pressable>

      <SaveBar
        state={saveState}
        onPress={handleSave}
        disabled={!dirty}
        error={saveError}
        label="Save layout"
      />
    </SettingsScreen>
  );
}

const sx = StyleSheet.create({
  loading: { paddingVertical: space.xxxl, alignItems: 'center' },
  errorText: { ...t.body, color: PP.inkMuted, textAlign: 'center' },

  row: {
    position: 'absolute', left: 0, right: 0, height: ROW_HEIGHT,
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: PP.borderLight,
    backgroundColor: '#FFFDF7',
  },
  rowIndex: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: PP.paperDeep, alignItems: 'center', justifyContent: 'center',
  },
  rowIndexText: { ...PP_LABEL, fontSize: 11, color: PP.inkMuted },
  rowLabel: { ...t.bodyStrong, color: PP.ink, fontSize: 15, flex: 1 },
  grip: { paddingVertical: 14, paddingLeft: 16, paddingRight: 4 },

  previewBlock: { gap: space.sm },
  previewLabel: {
    fontFamily: 'Courier', fontSize: 11, fontWeight: '700',
    color: PP.inkMuted, letterSpacing: 1.4, textTransform: 'uppercase',
  },
  previewStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: PP.paperDeep, borderRadius: radius.pill,
    borderWidth: 1, borderColor: PP.borderLight,
    paddingLeft: 5, paddingRight: space.md, paddingVertical: 4,
  },
  pillNum: {
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: PP.ink, alignItems: 'center', justifyContent: 'center',
  },
  pillNumText: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: PP.paper },
  pillText: { ...t.small, color: PP.ink, fontSize: 12, fontWeight: '600' },

  resetBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 12, minHeight: 44,
    borderRadius: radius.pill, borderWidth: 1, borderColor: PP.borderLight,
  },
  resetText: { ...t.small, color: PP.inkMuted, fontWeight: '600' },
});
