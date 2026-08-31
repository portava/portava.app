/**
 * Compass Memory screen — Memory + Experience Intelligence management (§17).
 *
 * The user's window into the memory Compass derives from their activity:
 *   • View    — the projected memories currently in use (GET /me/memory)
 *   • Feedback — hide / not-interested / already-known / incorrect / forget a
 *                single memory (POST /me/memory/feedback); the row leaves the
 *                list immediately since every kind suppresses it from retrieval
 *   • Export  — everything derived, incl. suppressed/decayed rows, via the OS
 *                share sheet (GET /me/memory/export)
 *   • Reset   — rebuild personalization from scratch, with a destructive-action
 *                confirm (POST /me/memory/reset). Prior "forget" choices survive.
 *
 * Everything is empty until the server's `memory_projection` flag is on and the
 * projector has populated the tables — so the list's empty state reads as "no
 * memories yet", never an error.
 *
 * Accessible from: Compass Preferences → Memory → "Memory Intelligence".
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Alert, Pressable, SafeAreaView,
  ActivityIndicator, Share,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  ArrowLeft, Brain, EyeOff, ThumbsDown, Check, XCircle, Trash2,
  Download, RotateCcw,
} from 'lucide-react-native';
import { color, space, radius, type as t } from '../src/theme/tokens';
import {
  fetchProjectedMemories, postMemoryFeedback, fetchMemoryExport, postMemoryReset,
  type ProjectedMemory, type MemoryFeedbackKind,
} from '../src/services/compass';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

// The five feedback actions, in the order they read most naturally on a card.
// Every kind removes the memory from what Compass serves, so any of them drops
// the row from this list on success.
const FEEDBACK_ACTIONS: Array<{
  kind: MemoryFeedbackKind;
  label: string;
  Icon: React.ComponentType<{ size: number; color: string }>;
}> = [
  { kind: 'hide',           label: 'Hide',          Icon: EyeOff },
  { kind: 'not_interested', label: 'Not for me',    Icon: ThumbsDown },
  { kind: 'already_known',  label: 'I know this',    Icon: Check },
  { kind: 'incorrect',      label: 'Incorrect',      Icon: XCircle },
  { kind: 'forget',         label: 'Forget',         Icon: Trash2 },
];

const MEMORY_TYPE_LABELS: Record<string, string> = {
  episodic: 'Moment',
  semantic: 'Preference',
  social:   'Person',
  place:    'Place',
  intent:   'Intent',
};

export default function CompassMemoryScreen() {
  const [memories, setMemories] = useState<ProjectedMemory[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(false);
  const [exporting, setExporting] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Transient confirmation banner (e.g. "Reset — cleared 4 memories").
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSeq = useRef(0);

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(false);
    const r = await fetchProjectedMemories('compass');
    if (seq !== loadSeq.current) return;
    if (r.ok) {
      setMemories(r.data ?? []);
    } else {
      // Pre-launch / unconfigured states are simply "no memories", not errors.
      setError(r.error !== 'not_configured');
      setMemories([]);
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, [load]));

  async function handleFeedback(m: ProjectedMemory, kind: MemoryFeedbackKind) {
    // Optimistically drop the row — every feedback kind suppresses it.
    setMemories((prev) => prev.filter((x) => x.id !== m.id));
    const r = await postMemoryFeedback({ kind, projectionId: m.id });
    if (!r.ok) {
      // Put it back and tell the user; nothing was recorded.
      setMemories((prev) => [m, ...prev.filter((x) => x.id !== m.id)]);
      Alert.alert('Could not save', 'That feedback could not be recorded — try again shortly.');
      return;
    }
    flashNotice(kind === 'forget' ? 'Forgotten' : 'Thanks — Compass updated');
  }

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    const r = await fetchMemoryExport();
    setExporting(false);
    if (!r.ok) {
      Alert.alert('Export failed', 'Your memory data could not be exported right now — try again shortly.');
      return;
    }
    const rows = r.data ?? [];
    if (rows.length === 0) {
      Alert.alert('Nothing to export', 'Compass has not derived any memory about you yet.');
      return;
    }
    try {
      await Share.share({
        title: 'My Compass memory',
        message: JSON.stringify({ exportedAt: new Date().toISOString(), memories: rows }, null, 2),
      });
    } catch {
      // User dismissed the share sheet, or the platform declined — not an error.
    }
  }

  function handleReset() {
    Alert.alert(
      'Reset personalization?',
      'Compass will clear the memory it has derived and rebuild it from scratch. '
        + 'This cannot be undone. Memories you explicitly forgot stay forgotten.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            if (resetting) return;
            setResetting(true);
            const r = await postMemoryReset();
            setResetting(false);
            if (!r.ok || !r.data) {
              Alert.alert('Reset failed', 'Personalization could not be reset right now — try again shortly.');
              return;
            }
            setMemories([]);
            const n = r.data.projectionsCleared;
            flashNotice(
              n > 0
                ? `Reset — cleared ${n} ${n === 1 ? 'memory' : 'memories'}`
                : 'Reset — nothing to clear',
            );
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} testID="back-button">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Memory Intelligence</Text>
        <View style={{ width: 38 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <View style={styles.intro}>
          <View style={styles.introHead}>
            <Brain size={16} color={color.signal} />
            <Text style={styles.introTitle}>What Compass remembers</Text>
          </View>
          <Text style={styles.introBody}>
            These are the memories Compass has derived from your activity to
            personalize what it shows you. Review them, correct anything that's
            off, or clear them entirely — you're always in control.
          </Text>
        </View>

        {notice ? (
          <View style={styles.notice} testID="memory-notice">
            <Check size={13} color={color.success} />
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        {loading ? (
          <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.lg }} testID="memory-loading" />
        ) : error ? (
          <View style={styles.stateBlock} testID="memory-error">
            <Text style={styles.stateText}>Couldn't load your memories just now.</Text>
            <Pressable onPress={() => void load()} testID="memory-retry" hitSlop={8}>
              <Text style={styles.retry}>Try again</Text>
            </Pressable>
          </View>
        ) : memories.length === 0 ? (
          <Text style={styles.stateText} testID="memory-empty">
            No memories yet. As you explore, Compass will build a private memory
            here that you can review, correct, or clear at any time.
          </Text>
        ) : (
          memories.map((m) => (
            <View key={m.id} style={styles.memCard} testID={`memory-${m.id}`}>
              <Text style={styles.memMeta}>
                {(MEMORY_TYPE_LABELS[m.memory_type] ?? m.memory_type).toUpperCase()}
                {m.subject_type ? ` · ${m.subject_type.toUpperCase()}` : ''}
              </Text>
              <Text style={styles.memContent}>{m.content}</Text>
              <View style={styles.feedbackRow}>
                {FEEDBACK_ACTIONS.map((a) => {
                  const Icon = a.Icon;
                  return (
                    <Pressable
                      key={a.kind}
                      style={styles.feedbackPill}
                      testID={`memory-${m.id}-${a.kind}`}
                      onPress={() => handleFeedback(m, a.kind)}
                      hitSlop={4}
                    >
                      <Icon size={12} color={color.mute} />
                      <Text style={styles.feedbackLabel}>{a.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ))
        )}

        {/* ── Data controls ── */}
        <View style={styles.controls}>
          <Text style={styles.controlsTitle}>Your data</Text>
          <Pressable
            style={styles.controlRow}
            testID="memory-export"
            onPress={handleExport}
            disabled={exporting}
          >
            <Download size={16} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={styles.controlLabel}>Export my memory data</Text>
              <Text style={styles.controlSub}>Everything derived about you, including what's hidden.</Text>
            </View>
            {exporting ? <ActivityIndicator size="small" color={color.deep} /> : null}
          </Pressable>
          <Pressable
            style={styles.controlRow}
            testID="memory-reset"
            onPress={handleReset}
            disabled={resetting}
          >
            <RotateCcw size={16} color={color.signal} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.controlLabel, { color: color.signal }]}>Reset personalization</Text>
              <Text style={styles.controlSub}>Clear derived memory and rebuild from scratch.</Text>
            </View>
            {resetting ? <ActivityIndicator size="small" color={color.signal} /> : null}
          </Pressable>
        </View>

        <PlainBottomFiller />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: color.paper },
  header:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze },
  backBtn: { padding: 8 },
  title:   { ...t.heading, color: color.ink },
  intro:      { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  introHead:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  introTitle: { ...t.heading, color: color.ink },
  introBody:  { ...t.small, color: color.mute, lineHeight: 19 },
  notice:     { flexDirection: 'row', alignItems: 'center', gap: 5 },
  noticeText: { ...t.small, color: color.success, fontWeight: '700' },
  stateBlock: { gap: 4 },
  stateText:  { ...t.small, color: color.mute, lineHeight: 19 },
  retry:      { ...t.small, fontWeight: '700', color: color.signal },
  memCard:    { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 6 },
  memMeta:    { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  memContent: { ...t.body, color: color.ink },
  feedbackRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: 4 },
  feedbackPill:  { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paper },
  feedbackLabel: { ...t.small, color: color.mute },
  controls:      { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.lg, padding: space.md, gap: space.sm, marginTop: space.sm },
  controlsTitle: { ...t.stamp, fontFamily: 'Courier', color: color.faint },
  controlRow:    { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
  controlLabel:  { ...t.body, color: color.ink, fontWeight: '600' },
  controlSub:    { ...t.small, color: color.mute, fontSize: 11 },
});
