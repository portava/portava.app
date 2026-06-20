import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, ActivityIndicator, Image, Alert } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { X, Image as ImageIcon, XCircle } from 'lucide-react-native';
import { Stamp, Chip } from '../src/components/ui';
import type { PostCategory } from '../src/types/models';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { usePostActions } from '../src/hooks/usePosts';
import { uploadPostMedia } from '../src/services/posts';
import type { PostVisibility } from '../src/services/posts';

const CATS: PostCategory[] = ['hotel','food','nightlife','beach','activity','transport','airport','visa','safety','tip','question'];

const VIS_OPTIONS: { label: string; value: PostVisibility }[] = [
  { label: 'Public', value: 'public' },
  { label: 'Private', value: 'private' },
];

interface PickedMedia {
  uri: string;
  mimeType: string;
}

export default function Create() {
  const [cat, setCat] = useState<PostCategory>('beach');
  const [vis, setVis] = useState<PostVisibility>('public');
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { create, submitting } = usePostActions();

  const busy = submitting || uploading;
  // Media is required; caption is optional (but nice to have)
  const canShare = media !== null && !busy;

  async function pickMedia() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to add media to your post.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setMedia({
        uri: asset.uri,
        mimeType: asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg'),
      });
      setError(null);
    }
  }

  async function onShare() {
    if (!canShare || !media) return;
    setError(null);

    // 1. Upload media
    setUploading(true);
    const uploadResult = await uploadPostMedia(media.uri, media.mimeType);
    setUploading(false);

    if (!uploadResult.ok) {
      const msgs: Record<string, string> = {
        upload_failed: 'Could not upload your photo. Try again.',
        network_unreachable: 'Network unavailable. Check your connection.',
        unauthenticated: 'Please sign in to post.',
        config_error: 'Posting is not available right now.',
      };
      setError(msgs[uploadResult.errorKind ?? ''] ?? uploadResult.message ?? 'Upload failed.');
      return;
    }

    // 2. Create post with the uploaded URL
    const content = caption.trim() ? `[${cat}] ${caption.trim()}` : `[${cat}]`;
    const res = await create({ content, mediaUrls: [uploadResult.data!], visibility: vis });

    if (res.ok) {
      router.back();
      return;
    }
    const messages: Record<string, string> = {
      unauthenticated: 'Please sign in to post.',
      network_unreachable: 'Network unavailable. Check your connection and try again.',
      invalid_payload: 'Something went wrong with your post. Try again.',
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
          {busy
            ? <ActivityIndicator size="small" color={color.onInk} />
            : <Text style={styles.postText}>Share</Text>}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        {error ? (
          <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>
        ) : null}

        {/* Media picker — required */}
        {media ? (
          <View style={styles.previewWrap}>
            <Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover" />
            <Pressable style={styles.removeMedia} onPress={() => setMedia(null)} hitSlop={8}>
              <XCircle size={22} color="#fff" fill={color.signal} />
            </Pressable>
          </View>
        ) : (
          <Pressable style={styles.mediaPicker} onPress={pickMedia}>
            <ImageIcon size={32} color={color.mute} />
            <Text style={styles.mediaLabel}>Add a photo or video</Text>
            <Text style={styles.mediaHint}>Required — tap to choose from your library</Text>
          </Pressable>
        )}

        <TextInput
          style={styles.caption}
          placeholder="Add a caption (optional)…"
          placeholderTextColor={color.faint}
          multiline
          value={caption}
          onChangeText={setCaption}
          editable={!busy}
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
  head: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, paddingTop: space.xxl,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  title: { ...t.heading, color: color.ink },
  post: {
    backgroundColor: color.signal, paddingHorizontal: space.lg,
    paddingVertical: space.sm, borderRadius: radius.pill,
    minWidth: 64, alignItems: 'center',
  },
  postDisabled: { opacity: 0.4 },
  postText: { ...t.small, fontWeight: '800', color: color.onInk },
  mediaPicker: {
    height: 220, borderRadius: radius.lg, borderWidth: 1.5,
    borderStyle: 'dashed', borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
    gap: space.sm, backgroundColor: color.paperRaised,
  },
  mediaLabel: { ...t.bodyStrong, color: color.mute },
  mediaHint: { ...t.small, color: color.faint },
  previewWrap: { position: 'relative', borderRadius: radius.lg, overflow: 'hidden' },
  preview: { width: '100%', height: 260, borderRadius: radius.lg },
  removeMedia: { position: 'absolute', top: space.sm, right: space.sm },
  caption: { ...t.body, color: color.ink, minHeight: 80, textAlignVertical: 'top' },
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  errorBox: {
    backgroundColor: '#FDECEC', borderRadius: radius.md,
    padding: space.md, borderWidth: 1, borderColor: '#F5B5B5',
  },
  errorText: { ...t.small, color: '#B23B3B', fontWeight: '600' },
});
