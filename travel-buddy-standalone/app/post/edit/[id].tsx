/**
 * Post edit screen — /post/edit/[id]
 *
 * Fixes the beta-audit P0 where PostCard's "Edit" action navigated to a
 * nonexistent route. Owners can edit the post's caption and visibility via
 * the existing updatePost service (content + visibility are the fields the
 * API contract supports; media editing is out of scope here).
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ArrowLeft, Globe, Lock, Luggage } from 'lucide-react-native';
import { getPostById, updatePost, type PostRow, type PostVisibility } from '../../../src/services/posts';
import { useSession } from '../../../src/context/SessionContext';
import { color, space, radius, type as t } from '../../../src/theme/tokens';

const CONTENT_MAX = 2000;

const VISIBILITY_OPTIONS: { value: PostVisibility; label: string; Icon: React.ComponentType<any> }[] = [
  { value: 'public', label: 'Public', Icon: Globe },
  { value: 'trip_only', label: 'Trip only', Icon: Luggage },
  { value: 'private', label: 'Private', Icon: Lock },
];

export default function EditPostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();

  const [post, setPost] = useState<PostRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [visibility, setVisibility] = useState<PostVisibility>('public');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    const res = await getPostById(id);
    setLoading(false);
    if (!res.ok || !res.data) {
      setLoadError(res.message ?? 'Could not load this post.');
      return;
    }
    setPost(res.data);
    setContent(res.data.content ?? '');
    setVisibility(res.data.visibility);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const isOwner = post != null && userId != null && post.authorId === userId;
  const dirty = post != null && (content !== (post.content ?? '') || visibility !== post.visibility);

  const handleSave = useCallback(async () => {
    if (!post || saving) return;
    const trimmed = content.trim();
    if (!trimmed) {
      Alert.alert('Empty caption', 'Write something before saving, or go back to leave the post unchanged.');
      return;
    }
    setSaving(true);
    const res = await updatePost(post.id, { content: trimmed, visibility });
    setSaving(false);
    if (!res.ok) {
      Alert.alert('Could not save', res.message ?? 'Something went wrong. Please try again.');
      return;
    }
    router.back();
  }, [post, content, visibility, saving]);

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={s.header}>
        <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="Back">
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>Edit Post</Text>
        <Pressable
          onPress={handleSave}
          disabled={!isOwner || !dirty || saving}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Save changes"
        >
          {saving
            ? <ActivityIndicator size="small" color={color.signal} />
            : <Text style={[s.saveText, (!isOwner || !dirty) && s.saveTextDisabled]}>Save</Text>}
        </Pressable>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={color.signal} /></View>
      ) : loadError ? (
        <View style={s.center}>
          <Text style={s.errTitle}>Could not load this post</Text>
          <Text style={s.errSub}>{loadError}</Text>
          <Pressable style={s.retryBtn} onPress={load} accessibilityRole="button">
            <Text style={s.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : !post ? (
        <View style={s.center}>
          <Text style={s.errTitle}>Post not found</Text>
          <Text style={s.errSub}>It may have been deleted.</Text>
        </View>
      ) : !isOwner ? (
        <View style={s.center}>
          <Text style={s.errTitle}>Only the author can edit this post</Text>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>CAPTION</Text>
          <TextInput
            style={s.input}
            value={content}
            onChangeText={setContent}
            multiline
            maxLength={CONTENT_MAX}
            placeholder="Share your travel moment…"
            placeholderTextColor={color.faint}
            textAlignVertical="top"
            autoFocus
          />
          <Text style={s.count}>{content.length}/{CONTENT_MAX}</Text>

          <Text style={s.label}>VISIBILITY</Text>
          <View style={s.visRow}>
            {VISIBILITY_OPTIONS.map(({ value, label, Icon }) => {
              const on = visibility === value;
              return (
                <Pressable
                  key={value}
                  style={[s.visChip, on && s.visChipOn]}
                  onPress={() => setVisibility(value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`Visibility: ${label}`}
                >
                  <Icon size={14} color={on ? color.onInk : color.ink} />
                  <Text style={[s.visText, on && s.visTextOn]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={s.hint}>
            Photos and videos can't be changed after posting — to swap media, delete this post and create a new one.
          </Text>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: 56, paddingBottom: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  headerTitle: { ...t.heading, color: color.ink },
  saveText: { ...t.bodyStrong, color: color.signal },
  saveTextDisabled: { color: color.faint },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  errTitle: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  errSub: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: {
    marginTop: space.sm, paddingHorizontal: space.xl, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal,
  },
  retryText: { ...t.bodyStrong, color: color.signal },

  body: { padding: space.lg, gap: space.sm },
  label: {
    fontSize: 11, fontWeight: '700', letterSpacing: 1.2,
    color: color.mute, marginTop: space.md,
  },
  input: {
    minHeight: 140, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  count: { ...t.small, color: color.faint, alignSelf: 'flex-end', fontSize: 11 },

  visRow: { flexDirection: 'row', gap: space.sm },
  visChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill,
    borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  visChipOn: { backgroundColor: color.signal, borderColor: color.signal },
  visText: { ...t.small, fontWeight: '600', color: color.ink },
  visTextOn: { color: color.onInk },

  hint: { ...t.small, color: color.mute, marginTop: space.md, lineHeight: 18 },
});
