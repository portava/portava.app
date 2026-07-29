import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { router } from 'expo-router';
import { closeThenNavigate } from '../lib/deferredNavigate.ts';
import { View, Text, Pressable, Modal, ScrollView, ActivityIndicator, StyleSheet, Animated } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, Plus, Search, MapPin } from 'lucide-react-native';
import type { AttachSource, AttachTarget, AttachTargetType } from '../types/models.ts';
import { useAttachments } from '../context/AttachmentStore.tsx';
import { attachTripTargets, attachPlanTargets, TRIP_GROUP_LABEL, PLAN_GROUP_LABEL } from '../data/attachTargets.ts';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens.ts';

/**
 * Attach controller. Wrap the app once; any card calls useAttach().open(source, kind)
 * to launch the bottom-sheet selector. Handles attach → toast → close. One shared
 * sheet across Discovery / Pulse / Trip / Saved.
 */
type OpenFn = (source: AttachSource, kind: AttachTargetType) => void;
const AttachContext = createContext<{ open: OpenFn } | null>(null);

export function AttachControllerProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const { createAttachment, isAttached } = useAttachments();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<AttachSource | null>(null);
  const [kind, setKind] = useState<AttachTargetType>('trip');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // toast
  const [toast, setToast] = useState<string | null>(null);
  const toastY = useRef(new Animated.Value(80)).current;
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    Animated.spring(toastY, { toValue: 0, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(toastY, { toValue: 80, duration: 220, useNativeDriver: true }).start(() => setToast(null));
    }, 2200);
  }, [toastY]);

  const openSheet: OpenFn = useCallback((src, k) => {
    setSource(src); setKind(k); setQuery(''); setError(null); setOpen(true);
  }, []);

  const targets = kind === 'trip' ? attachTripTargets : attachPlanTargets;
  const groupLabel = kind === 'trip' ? TRIP_GROUP_LABEL : PLAN_GROUP_LABEL;
  const filtered = query
    ? targets.filter((tg) => tg.title.toLowerCase().includes(query.toLowerCase()))
    : targets;
  const groups = Array.from(new Set(filtered.map((tg) => tg.group)));

  async function attachTo(target: AttachTarget) {
    if (!source) return;
    if (isAttached(source.id, target.id)) { showToast('Already added to ' + target.title); setOpen(false); return; }
    setBusyId(target.id); setError(null);
    try {
      await createAttachment(source, target);
      setOpen(false);
      showToast(`Added to ${target.title}`);
    } catch {
      setError('Couldn’t add — please try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AttachContext.Provider value={{ open: openSheet }}>
      {children}

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={s.grab} />
          <View style={s.head}>
            <Text style={s.title}>{kind === 'trip' ? 'Add to Trip' : 'Add to Plan'}</Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setOpen(false)} hitSlop={layout.hitSlop} style={s.x}><X size={18} color={color.ink} /></Pressable>
          </View>

          {/* item preview */}
          {source ? (
            <View style={s.preview}>
              <View style={s.previewThumb} />
              <View style={{ flex: 1 }}>
                <Text style={s.previewTitle} numberOfLines={1}>{source.title}</Text>
                <Text style={s.previewMeta} numberOfLines={1}>
                  {[source.category, source.city].filter(Boolean).join(' · ') || 'Item'}
                </Text>
              </View>
            </View>
          ) : null}

          {/* search */}
          {targets.length > 4 ? (
            <View style={s.search}>
              <Search size={16} color={color.faint} />
              <Text style={s.searchPlaceholder}>{query || `Search ${kind === 'trip' ? 'trips' : 'plans'}…`}</Text>
            </View>
          ) : null}

          {error ? <Text style={s.error}>{error}</Text> : null}

          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: space.sm }}>
            {groups.map((grp) => (
              <View key={grp} style={{ gap: space.xs }}>
                <Text style={s.groupLabel}>{groupLabel[grp] ?? grp}</Text>
                {filtered.filter((tg) => tg.group === grp).map((target) => {
                  const already = source ? isAttached(source.id, target.id) : false;
                  const busy = busyId === target.id;
                  return (
                    <Pressable key={target.id} style={({ pressed }) => [s.row, pressed && { opacity: layout.pressedOpacity }]} onPress={() => attachTo(target)} disabled={busy}>
                      <View style={s.rowIcon}><MapPin size={16} color={color.deep} /></View>
                      <View style={{ flex: 1 }}>
                        <Text style={s.rowTitle} numberOfLines={1}>{target.title}</Text>
                        {target.subtitle ? <Text style={s.rowSub} numberOfLines={1}>{target.subtitle}</Text> : null}
                      </View>
                      {busy ? <ActivityIndicator size="small" color={color.signal} />
                        : already ? <View style={s.added}><Check size={13} color={color.success} /><Text style={s.addedText}>Added</Text></View>
                        : <Plus size={18} color={color.signal} />}
                    </Pressable>
                  );
                })}
              </View>
            ))}

            {/* create new */}
            <Pressable style={({ pressed }) => [s.createRow, pressed && { opacity: layout.pressedOpacity }]} onPress={() => closeThenNavigate(() => setOpen(false), '/trip/new')}>
              <View style={s.createIcon}><Plus size={18} color={color.onInk} /></View>
              <Text style={s.createText}>{kind === 'trip' ? 'Create New Trip' : 'Create New Plan'}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* toast */}
      {toast ? (
        <Animated.View style={[s.toast, { transform: [{ translateY: toastY }], bottom: insets.bottom + 84 }]} pointerEvents="none">
          <Check size={16} color={color.onInk} />
          <Text style={s.toastText}>{toast}</Text>
        </Animated.View>
      ) : null}
    </AttachContext.Provider>
  );
}

export function useAttach() {
  const ctx = useContext(AttachContext);
  return ctx ?? { open: () => {} }; // safe no-op if provider missing
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, gap: space.md, ...shadow.float },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze },
  head: { flexDirection: 'row', alignItems: 'center' },
  title: { ...t.title, color: color.ink, fontSize: 19 },
  x: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  preview: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.sm },
  previewThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: color.deep },
  previewTitle: { ...t.bodyStrong, color: color.ink },
  previewMeta: { ...t.small, color: color.mute, fontSize: 11 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, backgroundColor: color.paperRaised },
  searchPlaceholder: { ...t.small, color: color.faint },
  error: { ...t.small, color: color.signal, fontWeight: '600' },
  groupLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 1, marginTop: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.md },
  rowIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#E2EDF0', alignItems: 'center', justifyContent: 'center' },
  rowTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  rowSub: { ...t.small, color: color.mute, fontSize: 11 },
  added: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  addedText: { ...t.small, color: color.success, fontWeight: '700', fontSize: 12 },
  createRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.signal, marginTop: space.xs },
  createIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center' },
  createText: { ...t.bodyStrong, color: color.signal },
  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.ink, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.pill, ...shadow.float },
  toastText: { ...t.bodyStrong, color: color.onInk },
});
