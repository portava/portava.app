/**
 * Memory composer — /memory/create
 *
 * Pick photos/videos from the library or camera, add a title + caption,
 * choose visibility, then publish. Media uploads to Supabase Storage
 * (memories bucket) before the memory row is created.
 */
import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, Pressable, TextInput,
  StyleSheet, ActivityIndicator, Alert, Image,
  Platform, KeyboardAvoidingView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, ImageIcon, Globe, Users, Lock, Eye, Trash2 } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens';
import { createMemory, addMemoryItem, type MemoryVisibility } from '../../src/services/memories';
import { NavBarFiller, useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';

// ── Visibility options ────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS: {
  value: MemoryVisibility;
  label: string;
  desc: string;
  icon: React.ReactNode;
}[] = [
  { value: 'public',       label: 'Public',      desc: 'Everyone',        icon: <Globe  size={15} color={color.success} /> },
  { value: 'friends_only', label: 'Friends',     desc: 'Mutual follows',  icon: <Users  size={15} color={color.signal} /> },
  { value: 'trip_crew',    label: 'Trip crew',   desc: 'Trip members',    icon: <Eye    size={15} color={color.deep} /> },
  { value: 'only_me',      label: 'Only me',     desc: 'Private draft',   icon: <Lock   size={15} color={color.mute} /> },
];

// ── Local asset type ──────────────────────────────────────────────────────────

interface LocalAsset {
  uri: string;
  mediaType: string;
  caption: string;
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function CreateMemoryScreen() {
  const insets = useSafeAreaInsets();
  const navBarScrollHandler = useNavBarScrollHandler();

  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<MemoryVisibility>('friends_only');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  // Synchronous guard: prevents re-entry on a rapid double-tap before the
  // setUploading(true) state update has caused a re-render and updated the
  // Pressable's `disabled` prop. Unlike the React state flag, a ref update
  // is immediate and visible within the same JS turn.
  const publishLock = useRef(false);

  // ── Media picker ────────────────────────────────────────────────────────────

  const pickFromLibrary = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow access to your photo library to attach media.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      quality: 0.85,
      selectionLimit: 10,
    });

    if (result.canceled) return;

    const newAssets: LocalAsset[] = result.assets.map((a) => ({
      uri: a.uri,
      mediaType: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
      caption: '',
    }));

    setAssets((prev) => {
      const combined = [...prev, ...newAssets];
      return combined.slice(0, 10);
    });
  }, []);

  const pickFromCamera = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow camera access to take a photo.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
    });

    if (result.canceled) return;

    const a = result.assets[0];
    if (!a) return;

    setAssets((prev) => {
      if (prev.length >= 10) return prev;
      return [...prev, {
        uri: a.uri,
        mediaType: a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
        caption: '',
      }];
    });
  }, []);

  const showPickerOptions = useCallback(() => {
    Alert.alert('Add media', undefined, [
      { text: 'Choose from library', onPress: pickFromLibrary },
      { text: 'Take a photo / video', onPress: pickFromCamera },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [pickFromLibrary, pickFromCamera]);

  const removeAsset = useCallback((index: number) => {
    setAssets((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateAssetCaption = useCallback((index: number, text: string) => {
    setAssets((prev) => prev.map((a, i) => i === index ? { ...a, caption: text } : a));
  }, []);

  // ── Submit ──────────────────────────────────────────────────────────────────

  const handlePublish = useCallback(async () => {
    // Synchronous guard — checked before any async work or React state update.
    // setUploading(true) below is async (deferred until next render), so a rapid
    // double-tap could bypass the `disabled={!canPublish}` check and re-enter
    // this handler before the button has re-rendered as disabled.
    if (publishLock.current) return;
    publishLock.current = true;

    setError('');
    setUploading(true);

    try {
      const createResult = await createMemory({
        title: title.trim() || null,
        caption: caption.trim() || null,
        visibility,
        state: 'published',
      });

      if (!createResult.ok) {
        setError(createResult.message);
        return;
      }

      const memoryId = createResult.memory.id;

      if (assets.length > 0) {
        const results = await Promise.allSettled(
          assets.map((asset, i) =>
            addMemoryItem(memoryId, asset.uri, asset.mediaType, asset.caption.trim() || null, i),
          ),
        );

        const failures = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
        if (failures.length > 0) {
          setError(`Memory created but ${failures.length} photo(s) failed to upload. View the memory to retry.`);
          router.replace({ pathname: '/memory/[id]' as any, params: { id: memoryId } });
          return;
        }
      }

      router.replace({ pathname: '/memory/[id]' as any, params: { id: memoryId } });
    } finally {
      setUploading(false);
      publishLock.current = false;
    }
  }, [assets, title, caption, visibility]);

  // ── Render ──────────────────────────────────────────────────────────────────

  const canPublish = !uploading;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: color.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Header */}
      <View style={[s.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={s.headerClose}>
          <X size={22} color={color.ink} />
        </Pressable>
        <Text style={s.headerTitle}>New Memory</Text>
        <Pressable
          onPress={handlePublish}
          disabled={!canPublish}
          style={[s.publishBtn, !canPublish && s.publishBtnDisabled]}
        >
          {uploading
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={s.publishBtnText}>Publish</Text>}
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[s.body, { paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
        onScroll={navBarScrollHandler}
        scrollEventThrottle={16}
      >

        {/* Media section */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Photos & Videos</Text>
          <Text style={s.sectionSub}>Up to 10 items</Text>

          {/* Asset grid */}
          {assets.length > 0 && (
            <View style={s.assetGrid}>
              {assets.map((asset, i) => (
                <View key={`${asset.uri}-${i}`} style={s.assetCard}>
                  <Image source={{ uri: asset.uri }} style={s.assetThumb} resizeMode="cover" />
                  <Pressable style={s.assetRemove} onPress={() => removeAsset(i)} hitSlop={4}>
                    <Trash2 size={14} color="#fff" />
                  </Pressable>
                  <TextInput
                    style={s.assetCaption}
                    placeholder="Caption…"
                    placeholderTextColor={color.faint}
                    value={asset.caption}
                    onChangeText={(text) => updateAssetCaption(i, text)}
                    maxLength={200}
                  />
                </View>
              ))}
            </View>
          )}

          {/* Add media button */}
          {assets.length < 10 && (
            <Pressable style={s.addMediaBtn} onPress={showPickerOptions}>
              <View style={s.addMediaIconRow}>
                <ImageIcon size={20} color={color.signal} />
                <Camera size={20} color={color.signal} />
              </View>
              <Text style={s.addMediaText}>
                {assets.length === 0 ? 'Add photos or videos' : 'Add more'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Title */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Title</Text>
          <TextInput
            style={s.input}
            placeholder="Give this memory a name…"
            placeholderTextColor={color.faint}
            value={title}
            onChangeText={setTitle}
            maxLength={300}
            returnKeyType="next"
          />
        </View>

        {/* Caption */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Caption</Text>
          <TextInput
            style={[s.input, s.inputMultiline]}
            placeholder="What made this moment special?"
            placeholderTextColor={color.faint}
            value={caption}
            onChangeText={setCaption}
            maxLength={2000}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>

        {/* Visibility */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>Who can see this?</Text>
          <View style={s.visGrid}>
            {VISIBILITY_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                style={[s.visOption, visibility === opt.value && s.visOptionActive]}
                onPress={() => setVisibility(opt.value)}
              >
                {opt.icon}
                <Text style={[s.visLabel, visibility === opt.value && s.visLabelActive]}>
                  {opt.label}
                </Text>
                <Text style={s.visDesc}>{opt.desc}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {error ? <Text style={s.error}>{error}</Text> : null}

        <NavBarFiller />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  headerClose: { width: 36, alignItems: 'flex-start' },
  headerTitle: { ...(t.bodyStrong as object), color: color.ink },
  publishBtn: {
    backgroundColor: color.signal,
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    minWidth: 72,
    alignItems: 'center',
  },
  publishBtnDisabled: { opacity: 0.5 },
  publishBtnText: { ...(t.small as object), color: '#fff', fontWeight: '700' },

  body: { padding: space.lg, gap: space.xl },

  section: { gap: space.sm },
  sectionLabel: { ...(t.bodyStrong as object), color: color.ink },
  sectionSub: { ...(t.small as object), color: color.mute, marginTop: -space.xs },

  assetGrid: { gap: space.md },
  assetCard: {
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.haze,
  },
  assetThumb: { width: '100%', height: 200 },
  assetRemove: {
    position: 'absolute', top: space.sm, right: space.sm,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: radius.pill,
    padding: 6,
  },
  assetCaption: {
    padding: space.md,
    ...(t.small as object),
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderTopWidth: 1,
    borderColor: color.haze,
  },

  addMediaBtn: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.haze,
    borderRadius: radius.lg,
    paddingVertical: space.xl,
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paperRaised,
  },
  addMediaIconRow: { flexDirection: 'row', gap: space.md },
  addMediaText: { ...(t.body as object), color: color.signal, fontWeight: '600' },

  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    ...(t.body as object),
    color: color.ink,
    backgroundColor: color.paperRaised,
  },
  inputMultiline: { minHeight: 100 },

  visGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  visOption: {
    flex: 1,
    minWidth: '45%',
    alignItems: 'center',
    gap: 4,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  visOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visLabel: { ...(t.small as object), color: color.ink, fontWeight: '700' },
  visLabelActive: { color: color.signal },
  visDesc: { fontSize: 10, color: color.mute, textAlign: 'center' },

  error: { ...(t.small as object), color: color.signal, textAlign: 'center' },
});
