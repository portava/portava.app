/**
 * CompassRemembers — Phase 6 memory-control surface.
 *
 * Pure presentational component: shows the user's layered Compass memories
 * (view / edit / forget) plus a "Teach My Compass" input. All mutations go
 * through the callbacks — nothing here talks to the network directly, which
 * keeps it component-testable.
 */
import React, { useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Brain, GraduationCap, Pencil, Trash2, Check, X } from 'lucide-react-native';
import type { CompassMemory } from '../../services/compass.ts';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

const SCOPE_LABELS: Record<string, string> = {
  long_term: 'Long-term preference',
  trip:      'This trip',
  session:   'This session',
  circle:    'Circle memory',
};

const SOURCE_LABELS: Record<string, string> = {
  taught:     'You taught this',
  compressed: 'Learned from your chats',
  inferred:   'Inferred from activity',
};

export interface CompassRemembersProps {
  memories:  CompassMemory[];
  loading?:  boolean;
  teaching?: boolean;
  onTeach:   (statement: string) => void;
  onEdit:    (memoryId: string, content: string) => void;
  onForget:  (memoryId: string) => void;
}

export function CompassRemembers({
  memories, loading, teaching, onTeach, onEdit, onForget,
}: CompassRemembersProps) {
  const [teachText, setTeachTextState] = useState('');
  // Ref mirror so the submit handler always sees the latest draft even if a
  // stale closure fires (also required by the RNTL React-19 renderer budget).
  const teachDraft = useRef('');
  const setTeachText = (v: string) => { teachDraft.current = v; setTeachTextState(v); };
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [editText, setEditText]     = useState('');

  function submitTeach() {
    const statement = teachDraft.current.trim();
    if (!statement || teaching) return;
    setTeachText('');
    onTeach(statement);
  }

  function startEdit(m: CompassMemory) {
    setEditingId(m.id);
    setEditText(m.content);
  }

  function submitEdit() {
    const content = editText.trim();
    if (editingId && content) onEdit(editingId, content);
    setEditingId(null);
  }

  return (
    <View style={{ gap: space.md }}>
      {/* Teach My Compass */}
      <View style={styles.teachCard} testID="teach-my-compass">
        <View style={styles.head}>
          <GraduationCap size={16} color={color.signal} />
          <Text style={styles.headText}>Teach My Compass</Text>
        </View>
        <Text style={styles.teachHint}>
          Tell Compass a preference in plain words — it becomes a structured memory you control.
        </Text>
        <View style={styles.teachRow}>
          <TextInput
            style={styles.teachInput}
            testID="teach-input"
            placeholder='e.g. "I\u2019m vegetarian" or "I prefer quiet places"'
            placeholderTextColor={color.faint}
            value={teachText}
            onChangeText={setTeachText}
            onSubmitEditing={submitTeach}
            editable={!teaching}
            returnKeyType="done"
          />
          <Pressable
            style={[styles.teachBtn, (teaching || !teachText.trim()) && styles.btnDisabled]}
            testID="teach-submit"
            disabled={!!teaching}
            onPress={submitTeach}
          >
            {teaching ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={styles.teachBtnText}>Remember</Text>}
          </Pressable>
        </View>
      </View>

      {/* Memory list */}
      <View style={styles.head}>
        <Brain size={16} color={color.signal} />
        <Text style={styles.headText}>Compass Remembers</Text>
      </View>

      {loading ? (
        <ActivityIndicator size="small" color={color.signal} style={{ marginVertical: space.lg }} />
      ) : memories.length === 0 ? (
        <Text style={styles.empty} testID="memories-empty">
          Nothing remembered yet. Teach Compass above, or just chat — durable preferences are distilled automatically.
        </Text>
      ) : (
        memories.map((m) => (
          <View key={m.id} style={styles.memCard} testID={`memory-${m.id}`}>
            <Text style={styles.memMeta}>
              {(SCOPE_LABELS[m.scope] ?? m.scope).toUpperCase()}
              {m.category && m.category !== 'general' ? ` · ${m.category.toUpperCase()}` : ''}
            </Text>
            {editingId === m.id ? (
              <View style={styles.editRow}>
                <TextInput
                  style={styles.editInput}
                  testID={`edit-input-${m.id}`}
                  value={editText}
                  onChangeText={setEditText}
                  autoFocus
                  multiline
                />
                <Pressable style={styles.iconBtn} testID={`edit-save-${m.id}`} onPress={submitEdit}>
                  <Check size={16} color={color.signal} />
                </Pressable>
                <Pressable style={styles.iconBtn} testID={`edit-cancel-${m.id}`} onPress={() => setEditingId(null)}>
                  <X size={16} color={color.mute} />
                </Pressable>
              </View>
            ) : (
              <Text style={styles.memContent}>{m.content}</Text>
            )}
            <View style={styles.memFoot}>
              <Text style={styles.memSource}>{SOURCE_LABELS[m.source] ?? m.source}</Text>
              {editingId !== m.id ? (
                <View style={{ flexDirection: 'row', gap: space.sm }}>
                  <Pressable style={styles.iconBtn} testID={`memory-edit-${m.id}`} onPress={() => startEdit(m)}>
                    <Pencil size={15} color={color.mute} />
                  </Pressable>
                  <Pressable style={styles.iconBtn} testID={`memory-forget-${m.id}`} onPress={() => onForget(m.id)}>
                    <Trash2 size={15} color={color.mute} />
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  head:         { flexDirection: 'row', alignItems: 'center', gap: 6 },
  headText:     { ...t.heading, color: color.ink },
  teachCard:    { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  teachHint:    { ...t.small, color: color.mute },
  teachRow:     { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  teachInput:   { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  teachBtn:     { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, backgroundColor: color.signal },
  teachBtnText: { ...t.small, fontWeight: '700', color: color.onInk },
  btnDisabled:  { opacity: 0.45 },
  empty:        { ...t.small, color: color.mute, lineHeight: 19 },
  memCard:      { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 6 },
  memMeta:      { ...t.stamp, fontFamily: 'Courier', color: color.signal },
  memContent:   { ...t.body, color: color.ink },
  memFoot:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  memSource:    { ...t.stamp, color: color.faint },
  editRow:      { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  editInput:    { flex: 1, ...t.body, color: color.ink, backgroundColor: color.paper, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  iconBtn:      { padding: 6 },
});
