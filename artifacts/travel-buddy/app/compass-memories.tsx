/**
 * Compass Remembers screen — Phase 6 layered memory control.
 *
 * View, edit, and forget the structured memories Compass keeps about you,
 * and teach it new preferences explicitly. Wired to real memory records via
 * /api/compass/me/memories.
 *
 * Accessible from: Compass Preferences → "Compass Remembers".
 */
import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Alert, Pressable, SafeAreaView } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { color, space, type as t } from '../src/theme/tokens';
import {
  fetchCompassMemories, teachCompassMemory, updateCompassMemory, forgetCompassMemory,
  type CompassMemory,
} from '../src/services/compass';
import { CompassRemembers } from '../src/components/compass/CompassRemembers';
import { PlainBottomFiller } from '../src/hooks/useBottomInset';

export default function CompassMemoriesScreen() {
  const [memories, setMemories] = useState<CompassMemory[]>([]);
  const [loading, setLoading]   = useState(true);
  const [teaching, setTeaching] = useState(false);

  const load = useCallback(async () => {
    const r = await fetchCompassMemories();
    if (r.ok) setMemories(r.data ?? []);
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function handleTeach(statement: string) {
    setTeaching(true);
    const r = await teachCompassMemory(statement);
    setTeaching(false);
    if (!r.ok || !r.data) {
      Alert.alert('Could not save', 'Compass could not remember that right now — try again shortly.');
      return;
    }
    setMemories((prev) => [r.data!, ...prev.filter((m) => m.id !== r.data!.id)]);
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
