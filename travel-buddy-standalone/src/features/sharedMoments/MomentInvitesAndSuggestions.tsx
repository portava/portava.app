/**
 * Your invitations to Moments at this place, and Moment suggestions (HM-F17, HM-F18).
 *
 * Invitations: `GET /me/shared-moment-invites`, narrowed to this place. Each
 * opens the Moment, where the invitation is accepted or declined.
 *
 * Suggestions: `GET /shared-moments/suggestions/mine`. The server labels every
 * one "Suggestion — no one is joined or added automatically." and the label is
 * shown as given. Open goes to the Moment (the preview admits the holder of an
 * offered suggestion, and asking to join is still a separate press); Dismiss
 * is `POST /shared-moments/suggestions/:id/dismiss`. With both suggestion
 * capabilities off the server answers an empty list and nothing is shown.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { color, radius, space, type as t, typography } from '../../theme/tokens.ts';
import {
  dismissSharedMomentSuggestion, listMySharedMomentInvites, listSharedMomentSuggestions,
  type SharedMomentInvite, type SharedMomentSuggestion,
} from '../../services/sharedMoments.ts';

type Loaded<T> = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; items: T[] };

export function MomentInvitesAndSuggestions({ placeId }: { placeId: string | undefined }) {
  const [invites, setInvites] = useState<Loaded<SharedMomentInvite>>({ kind: 'loading' });
  const [suggestions, setSuggestions] = useState<Loaded<SharedMomentSuggestion>>({ kind: 'loading' });

  const load = useCallback(async () => {
    setInvites({ kind: 'loading' });
    setSuggestions({ kind: 'loading' });
    const [inv, sug] = await Promise.all([listMySharedMomentInvites(), listSharedMomentSuggestions()]);
    setInvites(inv.ok ? { kind: 'ready', items: inv.data.filter((i) => !placeId || i.moment.placeId === placeId) } : { kind: 'error', message: inv.message });
    setSuggestions(sug.ok ? { kind: 'ready', items: sug.data } : { kind: 'error', message: sug.message });
  }, [placeId]);

  useEffect(() => { void load(); }, [load]);

  const dismiss = async (s: SharedMomentSuggestion) => {
    const res = await dismissSharedMomentSuggestion(s.id);
    if (!res.ok) { Alert.alert('Couldn’t dismiss the suggestion', res.message); return; }
    setSuggestions((prev) => (prev.kind === 'ready' ? { kind: 'ready', items: prev.items.filter((x) => x.id !== s.id) } : prev));
  };

  return (
    <View style={st.wrap}>
      {invites.kind === 'error' ? (
        <View style={st.card} testID="moment-invites-error">
          <Text style={st.body}>{invites.message}</Text>
          <Pressable onPress={load} accessibilityRole="button"><Text style={st.link}>Try again</Text></Pressable>
        </View>
      ) : invites.kind === 'ready' && invites.items.length > 0 ? (
        <View style={st.group}>
          <Text style={st.title}>Your invitations</Text>
          {invites.items.map((i) => (
            <Pressable key={i.moment.id} style={st.card} onPress={() => router.push(`/shared-moments/${i.moment.id}` as never)} accessibilityRole="button" testID={`moment-invite-${i.moment.id}`}>
              <Text style={st.title}>{i.moment.title}</Text>
              <Text style={st.meta}>Open to accept or decline</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {suggestions.kind === 'error' ? (
        <View style={st.card} testID="moment-suggestions-error">
          <Text style={st.body}>Suggestions could not be loaded. {suggestions.message}</Text>
          <Pressable onPress={load} accessibilityRole="button"><Text style={st.link}>Try again</Text></Pressable>
        </View>
      ) : suggestions.kind === 'ready' ? suggestions.items.map((s) => (
        <View key={s.id} style={[st.card, st.suggestion]} testID={`moment-suggestion-${s.id}`}>
          <Text style={st.meta}>{s.label}</Text>
          {s.reason ? <Text style={st.body}>{s.reason}</Text> : null}
          <View style={st.row}>
            <Pressable testID={`moment-suggestion-open-${s.id}`} onPress={() => router.push(`/shared-moments/${s.momentId}` as never)} style={st.primary} accessibilityRole="button">
              <Text style={st.primaryText}>Open</Text>
            </Pressable>
            <Pressable testID={`moment-suggestion-dismiss-${s.id}`} onPress={() => dismiss(s)} style={st.secondary} accessibilityRole="button">
              <Text style={st.secondaryText}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      )) : null}
    </View>
  );
}

const st = StyleSheet.create({
  wrap: { gap: space.md },
  group: { gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink },
  body: { ...typography.body, color: color.mute },
  meta: { ...typography.caption, color: color.deep },
  link: { ...t.bodyStrong, color: color.deep, marginTop: space.xs },
  card: { backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.xs },
  suggestion: { borderStyle: 'dashed' },
  row: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  primary: { backgroundColor: color.signal, borderRadius: radius.md, paddingVertical: space.xs, paddingHorizontal: space.md },
  primaryText: { ...t.bodyStrong, color: color.paper },
  secondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.xs, paddingHorizontal: space.md },
  secondaryText: { ...t.bodyStrong, color: color.ink },
});
