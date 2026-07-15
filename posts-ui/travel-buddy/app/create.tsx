import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { X, Image as ImageIcon } from 'lucide-react-native';
import { Stamp, Chip } from '../src/components/ui';
import type { PostCategory } from '../src/types/models';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { usePostActions } from '../src/hooks/usePosts';
import type { PostVisibility } from '../src/services/posts';

const CATS: PostCategory[] = ['hotel','food','nightlife','beach','activity','transport','airport','visa','safety','tip','question'];

// UI visibility labels -> backend visibility. There is no "friends" visibility
// in the posts model yet (public/trip_only/private); a standalone post can't be
// trip_only, so "Friends" maps to private for now. (Future: circle/followers.)
const VIS_OPTIONS: { label: string; value: PostVisibility }[] = [
  { label: 'Public', value: 'public' },
  { label: 'Private', value: 'private' },
];

export default function Create() {
  const [cat, setCat] = useState<PostCategory>('beach');
  const [vis, setVis] = useState<PostVisibility>('public');
  const [caption, setCaption] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { create, submitting } = usePostActions();

  const canShare = caption.trim().length > 0 && !submitting;

  async function onShare() {
    if (!canShare) return;
    setError(null);
    // Category isn't a column in the posts table yet; prepend as a light tag so
    // the information isn't lost. (Future: dedicated category column.)
    const content = `[${cat}] ${caption.trim()}`;
    const res = await create({ content, visibility: vis });
    if (res.ok) {
      router.back();
      return;
    }
    // Map typed error kinds to friendly messages.
    const messages: Record<string, string> = {
      unauthenticated: 'Please sign in to post.',
      network_unreachable: 'Network unavailable. Check your connection and try again.',
      invalid_payload: 'Please add some text before sharing.',
      config_error: 'Posting is not available right now.',
      forbidden: "You can't post here.",
      not_member: 'You need to be a member to post here.',
    };
    setError(messages[res.errorKind ?? ''] ?? res.message ?? 'Could not share your post.');
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={8}><X size={24} color={color.ink} /></Pressable>
        <Text style={styles.title}>New post</Text>
        <View style={{ flex: 1 }} />
        <Pressable
          style={[styles.post, !canShare && styles.postDisabled]}
          onPress={onShare}
          disabled={!canShare}
        >
          {submitting
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Text style={styles.postText}>Share</Text>}
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {error ? (
          <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>
        ) : null}
        <Pressable style={styles.media}><ImageIcon size={28} color={color.mute} /><Text style={styles.mediaText}>Add photo or video</Text></Pressable>
        <TextInput
          style={styles.caption}
          placeholder="Share a tip, review, question, or moment…"
          placeholderTextColor={color.faint}
          multiline
          value={caption}
          onChangeText={setCaption}
          editable={!submitting}
        />
        <View>
          <Text style={styles.label}>Category</Text>
          <View style={styles.wrap}>{CATS.map((c) => <Chip key={c} label={c} active={c===cat} onPress={() => setCat(c)} />)}</View>
        </View>
        <View>
          <Text style={styles.label}>Destination</Text>
          <View style={styles.wrap}><Stamp label="Cebu, Philippines" tone="deep" /></View>
        </View>
        <View>
          <Text style={styles.label}>Visibility</Text>
          <View style={styles.wrap}>{VIS_OPTIONS.map((v) => <Chip key={v.value} label={v.label} active={v.value===vis} onPress={() => setVis(v.value)} />)}</View>
        </View>
      </ScrollView>
    </View>
  );
}
const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg, paddingTop: space.xxl, borderBottomWidth: 1, borderBottomColor: color.haze },
  title: { ...t.heading, color: color.ink },
  post: { backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, minWidth: 64, alignItems: 'center' },
  postDisabled: { opacity: 0.5 },
  postText: { ...t.small, fontWeight: '800', color: color.onInk },
  media: { height: 180, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: color.paperRaised },
  mediaText: { ...t.body, color: color.mute },
  caption: { ...t.body, color: color.ink, minHeight: 90, textAlignVertical: 'top' },
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  errorBox: { backgroundColor: '#FDECEC', borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: '#F5B5B5' },
  errorText: { ...t.small, color: '#B23B3B', fontWeight: '600' },
});
