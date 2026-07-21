/**
 * Compass Remembers screen — Phase 6 layered memory control.
 *
 * View, edit, and forget the structured memories Compass keeps about you,
 * and teach it new preferences explicitly. Wired to real memory records via
 * /api/compass/me/memories. Scope tabs (All / Long-term / This trip / Circles)
 * use the server-side ?scope= filter; circle memories show the circle's name
 * and Teach My Compass can target a circle the user belongs to.
 *
 * Accessible from: Compass Preferences → "Compass Remembers".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, Pressable, SafeAreaView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, type as t } from '../src/theme/tokens';
import {
  fetchCompassMemories, teachCompassMemory, updateCompassMemory, forgetCompassMemory,
  type CompassMemory, type CompassMemoryScope,
} from '../src/services/compass';
import { getMyCircles } from '../src/services/circles';
import { CompassRemembers, type CompassCircleOption } from '../src/components/compass/CompassRemembers';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

export default function CompassMemoriesScreen() {
  const [memories, setMemories] = useState<CompassMemory[]>([]);
  const [loading, setLoading]   = useState(true);
  const [teaching, setTeaching] = useState(false);
  const [scope, setScope]       = useState<CompassMemoryScope | null>(null);
  const [circles, setCircles]   = useState<CompassCircleOption[]>([]);
  // Guards against a slow fetch for a previous scope overwriting the current one.
  const loadSeq = useRef(0);
  // Transient "Remembered for …" confirmation after a successful teach.
  const [teachConfirmation, setTeachConfirmation] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const load = useCallback(async (s: CompassMemoryScope | null) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    const r = await fetchCompassMemories(s ?? undefined);
    if (seq !== loadSeq.current) return;
    if (r.ok) setMemories(r.data ?? []);
    setLoading(false);
  }, []);

  const loadCircles = useCallback(async () => {
    const rows = await getMyCircles();
    setCircles(rows.map((c) => ({ ownerId: c.ownerId, name: c.name })));
  }, []);

  useFocusEffect(useCallback(() => { load(scope); loadCircles(); }, [load, loadCircles, scope]));

  function handleScopeChange(next: CompassMemoryScope | null) {
    if (next === scope) return;
    setScope(next);
    load(next);
  }

  async function handleTeach(statement: string, circleOwnerId?: string) {
    setTeaching(true);
    const r = await teachCompassMemory(statement, circleOwnerId ? { circleOwnerId } : {});
    setTeaching(false);
    if (!r.ok || !r.data) {
      Alert.alert('Could not save', 'Compass could not remember that right now — try again shortly.');
      return;
    }
    // Only show the new memory in the list if it matches the active scope filter.
    if (scope === null || r.data.scope === scope) {
      setMemories((prev) => [r.data!, ...prev.filter((m) => m.id !== r.data!.id)]);
    }
    // Confirm where the memory landed — circle name for group teaches.
    const circleName = circleOwnerId
      ? circles.find((c) => c.ownerId === circleOwnerId)?.name
      : undefined;
    setTeachConfirmation(
      circleOwnerId ? `Remembered for ${circleName ?? 'your circle'}` : 'Remembered for you',
    );
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setTeachConfirmation(null), 4000);
  }

  async function handleEdit(memoryId: string, content: string) {
    const r = await updateCompassMemory(memoryId, { content });
    if (!r.ok || !r.data) {
      Alert.alert('Could not update', 'That memory could not be updated — try again shortly.');
      return;
    }
    setMemories((prev) => prev.map((m) => (m.id === memoryId ? r.data! : m)));
  }

  function handleForget(memoryId: string) {
    Alert.alert('Forget this memory?', 'Compass will stop using it immediately.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget',
        style: 'destructive',
        onPress: async () => {
          const r = await forgetCompassMemory(memoryId);
          if (!r.ok) {
            Alert.alert('Could not forget', 'Try again shortly.');
            return;
          }
          setMemories((prev) => prev.filter((m) => m.id !== memoryId));
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn} testID="back-button">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.title}>Compass Remembers</Text>
        <View style={{ width: 38 }} />
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
        <CompassRemembers
          memories={memories}
          loading={loading}
          teaching={teaching}
          scope={scope}
          onScopeChange={handleScopeChange}
          circles={circles}
          teachConfirmation={teachConfirmation}
          onTeach={handleTeach}
          onEdit={handleEdit}
          onForget={handleForget}
        />
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
});
