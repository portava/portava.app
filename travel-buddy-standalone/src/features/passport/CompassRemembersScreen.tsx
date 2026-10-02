/**
 * CompassRemembersScreen — "Compass remembers" (§12 What Portava Remembers),
 * the owner's private view of what Portava holds about them, with Forget and
 * Correct (testing-mode WP-12, flow COMP-F16).
 *
 * Reads GET /compass/me/passport/remembers. Owner-only: the server scopes it
 * to the session, and this surface is never part of the public Passport.
 *
 * HONEST STATES. Loading; a failed request is an error with Try again (never
 * an empty list); a group the server could not read is marked "Couldn't load"
 * — it is not empty; a group that answered with nothing says so plainly.
 * Forget and Correct report the server's own message on success and an alert
 * on failure; the list changes only after the server accepted the change.
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, TextInput, Alert, StyleSheet } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Brain, History } from 'lucide-react-native';
import { color, space, radius, type as t, icon } from '../../theme/tokens.ts';
import {
  fetchRemembered, forgetRemembered, correctRemembered,
  type RememberedSurface, type RememberedItem, type MemorySurfaceError,
} from '../../services/compassMemorySurfaces.ts';
import { MemoryHeader, MemoryLoading, MemoryError, UnavailableNotice, errorCopy, ms } from './memorySurfaceParts.tsx';

type Load =
  | { state: 'loading' }
  | { state: 'error'; error: MemorySurfaceError; message?: string }
  | { state: 'ready'; surface: RememberedSurface };

export function CompassRemembersScreen() {
  const insets = useSafeAreaInsets();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoad({ state: 'loading' });
    const r = await fetchRemembered();
    if (mine !== seq.current) return;
    setLoad(r.ok ? { state: 'ready', surface: r.data } : { state: 'error', error: r.error, message: r.message });
  }, []);

  useFocusEffect(useCallback(() => { void reload(); return () => { seq.current += 1; }; }, [reload]));

  const dropItem = (id: string) => setLoad((prev) => (prev.state !== 'ready' ? prev : {
    state: 'ready',
    surface: { ...prev.surface, groups: prev.surface.groups.map((g) => ({ ...g, items: g.items.filter((i) => i.id !== id) })) },
  }));

  const forget = (item: RememberedItem) => {
    Alert.alert('Forget this?', item.group === 'derived_memory'
      ? 'Portava will stop showing this and will not work it out again.'
      : 'This hides it from this view. The original you created is not deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Forget', style: 'destructive', onPress: async () => {
          setBusy(item.id);
          const r = await forgetRemembered(item);
          setBusy(null);
          if (!r.ok) { Alert.alert('Could not forget this', errorCopy(r.error, r.message)); return; }
          dropItem(item.id);
          setConfirmation(r.data.message);
        },
      },
    ]);
  };

  const saveCorrection = async (item: RememberedItem) => {
    const value = draft.trim();
    if (!value) return;
    setBusy(item.id);
    const r = await correctRemembered(item, value);
    setBusy(null);
    if (!r.ok) { Alert.alert('Could not save your correction', errorCopy(r.error, r.message)); return; }
    setEditing(null);
    setDraft('');
    // The server suppresses the wrong value, so it leaves this view.
    dropItem(item.id);
    setConfirmation(r.data.message);
  };

  let body: React.ReactNode;
  if (load.state === 'loading') {
    body = <MemoryLoading label="Loading what Portava remembers" />;
  } else if (load.state === 'error') {
    body = <MemoryError testID="remembers-error" title="Couldn't load what Portava remembers" message={errorCopy(load.error, load.message)} onRetry={reload} />;
  } else if (load.surface.groups.length > 0 && load.surface.groups.every((g) => g.availability === 'unavailable')) {
    body = <MemoryError testID="remembers-error" title="Couldn't load what Portava remembers" message="None of it could be read right now. Nothing has been deleted." onRetry={reload} />;
  } else {
    const { surface } = load;
    body = (
      <>
        {surface.unavailable.length > 0 ? (
          <UnavailableNotice testID="remembers-partial" text="Some sections couldn't be loaded right now. They're marked below — they are not empty." onRetry={reload} />
        ) : null}
        {confirmation ? <Text style={s.confirmation} testID="remembers-confirmation">{confirmation}</Text> : null}
        {surface.groups.map((g) => (
          <View key={g.group} style={ms.card} testID={`remembers-group-${g.group}`}>
            <Text style={ms.sectionTitle}>{g.label}</Text>
            {g.description ? <Text style={ms.sectionText}>{g.description}</Text> : null}
            {g.availability === 'unavailable' ? (
              <Text style={s.unavailable} testID={`remembers-unavailable-${g.group}`}>Couldn&apos;t load this section right now.</Text>
            ) : g.items.length === 0 ? (
              <Text style={ms.note}>Nothing here.</Text>
            ) : g.items.map((item) => (
              <View key={item.id} style={s.item} testID={`remembers-item-${item.id}`}>
                <Text style={s.itemTitle}>{item.title}</Text>
                {item.detail ? <Text style={ms.sectionText}>{item.detail}</Text> : null}
                {item.isInferred ? <Text style={s.inferred}>{item.inferredNote ?? 'Inferred — Portava worked this out; you did not tell it.'}</Text> : null}
                {editing === item.id ? (
                  <View style={s.editor}>
                    <TextInput
                      value={draft}
                      onChangeText={setDraft}
                      placeholder="What is right?"
                      placeholderTextColor={color.faint}
                      style={s.input}
                      maxLength={400}
                      accessibilityLabel="Corrected value"
                      testID="remembers-correct-input"
                    />
                    <View style={s.actions}>
                      <Pressable onPress={() => { setEditing(null); setDraft(''); }} accessibilityRole="button"><Text style={s.action}>Cancel</Text></Pressable>
                      <Pressable onPress={() => void saveCorrection(item)} disabled={busy === item.id || !draft.trim()} accessibilityRole="button" testID="remembers-correct-save">
                        <Text style={[s.action, (busy === item.id || !draft.trim()) && s.disabled]}>Save correction</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={s.actions}>
                    {item.canCorrect ? (
                      <Pressable onPress={() => { setEditing(item.id); setDraft(''); }} disabled={busy === item.id} accessibilityRole="button" testID={`remembers-correct-${item.id}`}>
                        <Text style={s.action}>Correct</Text>
                      </Pressable>
                    ) : item.correctNote ? <Text style={s.hint}>{item.correctNote}</Text> : null}
                    {item.canForget ? (
                      <Pressable onPress={() => forget(item)} disabled={busy === item.id} accessibilityRole="button" testID={`remembers-forget-${item.id}`}>
                        <Text style={[s.action, s.destructive]}>Forget</Text>
                      </Pressable>
                    ) : null}
                  </View>
                )}
              </View>
            ))}
          </View>
        ))}
        <Pressable style={[ms.card, s.link]} onPress={() => router.push('/passport/recaps' as never)} accessibilityRole="button" testID="remembers-open-recaps">
          <History size={icon.s18} color={color.deep} />
          <Text style={ms.sectionTitle}>Recaps & On this day</Text>
        </Pressable>
        {surface.notes.map((n) => <Text key={n} style={ms.note}>{n}</Text>)}
      </>
    );
  }

  return (
    <View style={[ms.root, { paddingTop: insets.top }]}>
      <MemoryHeader title="Compass remembers" Icon={Brain} />
      <ScrollView contentContainerStyle={[ms.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}>
        <Text style={ms.subtitle}>What Portava remembers about you. Private to you — never on your public Passport.</Text>
        {body}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  item: { gap: space.xs, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.haze },
  itemTitle: { ...t.body, color: color.ink },
  inferred: { ...t.small, color: color.deep, fontStyle: 'italic' },
  unavailable: { ...t.small, color: color.warn },
  confirmation: { ...t.small, color: color.success },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.lg, flexWrap: 'wrap' },
  action: { ...t.bodyStrong, color: color.signal, fontSize: 14 },
  destructive: { color: color.warn },
  disabled: { opacity: 0.4 },
  hint: { ...t.small, color: color.mute, flex: 1 },
  editor: { gap: space.sm },
  input: { ...t.body, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  link: { flexDirection: 'row', alignItems: 'center' },
});

export default CompassRemembersScreen;
