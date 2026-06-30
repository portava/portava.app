/**
 * StoryComposer — modal story creation flow.
 *
 * Lets the user:
 *   - Pick a photo/video from the library (or camera)
 *   - Add a caption (max 1000 chars)
 *   - Choose privacy (public / friends only / close friends / trip crew / circle / custom)
 *   - Link a trip (optional)
 *   - Toggle "hide viewer list"
 *   - Post — uploads media to Supabase Storage, then calls POST /api/stories
 */
import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, TextInput,
  Image, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, ChevronDown, Lock, Users, Globe, Heart, UserCheck } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t } from '../theme/tokens';
import type { StoryVisibility } from '../services/stories';
import { createStory, uploadStoryMedia } from '../services/stories';

interface Props {
  visible: boolean;
  onClose: () => void;
  onPosted?: () => void;
  defaultTripId?: string | null;
}

const VISIBILITY_OPTIONS: Array<{ value: StoryVisibility; label: string; sub: string; Icon: any }> = [
  { value: 'public',        label: 'Public',        sub: 'Anyone can see this story',           Icon: Globe },
  { value: 'friends_only',  label: 'Friends',        sub: 'Mutual follows only',                  Icon: Users },
  { value: 'close_friends', label: 'Close Friends',  sub: 'Only your Trusted Crew list',          Icon: Heart },
  { value: 'trip_crew',     label: 'Trip Crew',      sub: 'Members of the linked trip',           Icon: UserCheck },
  { value: 'circle_only',   label: 'Circle',         sub: 'Your circle members only',             Icon: Lock },
];

export function StoryComposer({ visible, onClose, onPosted, defaultTripId }: Props) {
  const insets = useSafeAreaInsets();
  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<string>('image/jpeg');
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<StoryVisibility>('public');
  const [hideViewerList, setHideViewerList] = useState(false);
  const [tripId] = useState<string | null>(defaultTripId ?? null);
  const [posting, setPosting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [visibilityOpen, setVisibilityOpen] = useState(false);

  async function pickMedia() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow photo library access to pick media.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.9,
      allowsEditing: true,
      aspect: [9, 16],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setMediaUri(asset.uri);
      setMediaType(asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
    }
  }

  async function pickCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow camera access to take a photo.'); return; }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.All,
      quality: 0.9,
      allowsEditing: true,
      aspect: [9, 16],
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setMediaUri(asset.uri);
      setMediaType(asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
    }
  }

  async function handlePost() {
    if (!mediaUri) { Alert.alert('Pick media first'); return; }
    setPosting(true);
    try {
      // Upload local file to Supabase Storage to get a shareable public URL
      let publicUrl: string;
      if (mediaUri.startsWith('http://') || mediaUri.startsWith('https://')) {
        // Already a remote URL (e.g. re-share from another source)
        publicUrl = mediaUri;
      } else {
        setUploadProgress('Uploading media...');
        const uploaded = await uploadStoryMedia(mediaUri, mediaType);
        setUploadProgress(null);
        if (!uploaded) {
          Alert.alert('Upload failed', 'Could not upload your media. Please check your connection and try again.');
          return;
        }
        publicUrl = uploaded;
      }

      const result = await createStory({
        mediaUrl: publicUrl,
        mediaType,
        caption: caption.trim() || null,
        visibility,
        closeFriendsOnly: visibility === 'close_friends',
        tripId: (visibility === 'trip_crew' ? tripId : null) ?? null,
        hideViewerList,
      });
      if (result.ok) {
        onPosted?.();
        handleReset();
        onClose();
      } else {
        Alert.alert('Could not post story', result.message ?? 'Please try again.');
      }
    } finally {
      setPosting(false);
      setUploadProgress(null);
    }
  }

  function handleReset() {
    setMediaUri(null);
    setCaption('');
    setVisibility('public');
    setHideViewerList(false);
  }

  function handleClose() {
    if (mediaUri) {
      Alert.alert('Discard story?', 'Your story draft will be lost.', [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Discard', style: 'destructive', onPress: () => { handleReset(); onClose(); } },
      ]);
    } else {
      onClose();
    }
  }

  const selectedVis = VISIBILITY_OPTIONS.find((o) => o.value === visibility) ?? VISIBILITY_OPTIONS[0];

  if (!visible) return null;

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={handleClose}>
      <View style={[s.root, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={s.header}>
          <Pressable onPress={handleClose} hitSlop={8}>
            <X size={22} color={color.ink} />
          </Pressable>
          <Text style={s.title}>New Story</Text>
          <Pressable
            onPress={handlePost}
            disabled={!mediaUri || posting}
            style={[s.postBtn, (!mediaUri || posting) && s.postBtnDisabled]}
          >
            {posting
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={s.postBtnText}>Share</Text>
            }
          </Pressable>
        </View>

        {uploadProgress ? (
          <View style={s.uploadBanner}>
            <ActivityIndicator size="small" color={color.deep} />
            <Text style={s.uploadText}>{uploadProgress}</Text>
          </View>
        ) : null}

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
          {/* Media picker */}
          {mediaUri ? (
            <View style={s.previewContainer}>
              <Image source={{ uri: mediaUri }} style={s.preview} resizeMode="cover" />
              <Pressable onPress={() => setMediaUri(null)} style={s.clearMedia}>
                <X size={16} color="#fff" />
              </Pressable>
            </View>
          ) : (
            <View style={s.mediaPicker}>
              <Pressable style={s.mediaBtn} onPress={pickMedia}>
                <Camera size={28} color={color.mute} />
                <Text style={s.mediaBtnText}>Photo Library</Text>
              </Pressable>
              <Pressable style={s.mediaBtn} onPress={pickCamera}>
                <Camera size={28} color={color.deep} />
                <Text style={[s.mediaBtnText, { color: color.deep }]}>Camera</Text>
              </Pressable>
            </View>
          )}

          {/* Caption */}
          <TextInput
            style={s.captionInput}
            placeholder="Add a caption... (optional)"
            placeholderTextColor={color.faint}
            value={caption}
            onChangeText={setCaption}
            maxLength={1000}
            multiline
            returnKeyType="default"
          />
          <Text style={s.charCount}>{caption.length}/1000</Text>

          {/* Visibility selector */}
          <Pressable style={s.visRow} onPress={() => setVisibilityOpen(true)}>
            <selectedVis.Icon size={16} color={color.deep} />
            <View style={{ flex: 1 }}>
              <Text style={s.visLabel}>{selectedVis.label}</Text>
              <Text style={s.visSub}>{selectedVis.sub}</Text>
            </View>
            <ChevronDown size={16} color={color.mute} />
          </Pressable>

          {/* Hide viewer list toggle */}
          <Pressable style={s.toggleRow} onPress={() => setHideViewerList((v) => !v)}>
            <View style={{ flex: 1 }}>
              <Text style={s.toggleLabel}>Hide viewer list</Text>
              <Text style={s.toggleSub}>Only you can see who viewed this story</Text>
            </View>
            <View style={[s.toggle, hideViewerList && s.toggleOn]}>
              <View style={[s.toggleKnob, hideViewerList && s.toggleKnobOn]} />
            </View>
          </Pressable>

          {visibility === 'close_friends' && (
            <View style={s.infoBanner}>
              <Heart size={14} color={color.signal} fill={color.signal} />
              <Text style={s.infoText}>Only people on your Close Friends list will see this story.</Text>
            </View>
          )}
        </ScrollView>

        {/* Visibility picker sheet */}
        {visibilityOpen && (
          <Modal visible={visibilityOpen} transparent animationType="slide" onRequestClose={() => setVisibilityOpen(false)}>
            <Pressable style={s.sheetOverlay} onPress={() => setVisibilityOpen(false)} />
            <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <View style={s.sheetHandle} />
              <Text style={s.sheetTitle}>Who can see this story?</Text>
              {VISIBILITY_OPTIONS.map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[s.visOption, visibility === opt.value && s.visOptionActive]}
                  onPress={() => { setVisibility(opt.value); setVisibilityOpen(false); }}
                >
                  <opt.Icon size={18} color={visibility === opt.value ? color.deep : color.mute} />
                  <View style={{ flex: 1 }}>
                    <Text style={[s.visOptionLabel, visibility === opt.value && s.visOptionLabelActive]}>{opt.label}</Text>
                    <Text style={s.visOptionSub}>{opt.sub}</Text>
                  </View>
                  {visibility === opt.value && <View style={s.visCheck} />}
                </Pressable>
              ))}
            </View>
          </Modal>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.md },
  title: { flex: 1, ...t.heading, color: color.ink, textAlign: 'center' },
  postBtn: { backgroundColor: color.signal, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.pill, minWidth: 60, alignItems: 'center' },
  postBtnDisabled: { opacity: 0.4 },
  postBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  uploadBanner: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: '#EAF2F4' },
  uploadText: { ...t.small, color: color.deep },
  mediaPicker: { flexDirection: 'row', gap: space.md },
  mediaBtn: { flex: 1, borderWidth: 2, borderColor: color.haze, borderStyle: 'dashed', borderRadius: radius.md, paddingVertical: space.xl, alignItems: 'center', gap: space.sm },
  mediaBtnText: { ...t.small, color: color.mute, fontWeight: '600' },
  previewContainer: { borderRadius: radius.md, overflow: 'hidden', aspectRatio: 9 / 16, maxHeight: 320, alignSelf: 'center', width: '60%' },
  preview: { flex: 1, backgroundColor: color.haze },
  clearMedia: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  captionInput: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, ...t.body, color: color.ink, minHeight: 80, textAlignVertical: 'top' },
  charCount: { ...t.small, color: color.faint, textAlign: 'right' },
  visRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md },
  visLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  visSub: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md },
  toggleLabel: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  toggleSub: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: color.haze, padding: 2 },
  toggleOn: { backgroundColor: color.signal },
  toggleKnob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff' },
  toggleKnobOn: { transform: [{ translateX: 20 }] },
  infoBanner: { flexDirection: 'row', alignItems: 'center', gap: space.sm, backgroundColor: '#FFF0EE', borderRadius: radius.md, padding: space.md },
  infoText: { flex: 1, ...t.small, color: color.signal, fontSize: 12 },
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { backgroundColor: color.paper, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: space.lg },
  sheetHandle: { width: 36, height: 4, backgroundColor: color.haze, borderRadius: 2, alignSelf: 'center', marginBottom: space.lg },
  sheetTitle: { ...t.heading, color: color.ink, marginBottom: space.md },
  visOption: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md },
  visOptionActive: { backgroundColor: '#EAF2F4' },
  visOptionLabel: { ...t.bodyStrong, color: color.ink },
  visOptionLabelActive: { color: color.deep },
  visOptionSub: { ...t.small, color: color.mute, fontSize: 12, marginTop: 1 },
  visCheck: { width: 10, height: 10, borderRadius: 5, backgroundColor: color.deep },
});
