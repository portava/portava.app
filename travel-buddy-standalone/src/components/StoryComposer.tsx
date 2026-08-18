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
import React, { useState, useRef } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, TextInput,
  Image, Alert, ActivityIndicator, ScrollView,
} from 'react-native';
import { X, ChevronDown, Lock, Users, Globe, Heart, UserCheck } from 'lucide-react-native';
import { useMediaComposer } from '../hooks/useMediaComposer.ts';
import { MediaPickerButton } from './ui/MediaPickerButton.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, avatar, icon, aspect, dot} from '../theme/tokens.ts';
import { KeyboardSafeView } from './ui/KeyboardSafeView.tsx';
import type { StoryVisibility } from '../services/stories.ts';
import { createStory, uploadStoryMedia } from '../services/stories.ts';

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
  const postLockRef = useRef(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [visibilityOpen, setVisibilityOpen] = useState(false);

  const mediaComposer = useMediaComposer('story');

  function handleMediaResult(asset: import('expo-image-picker').ImagePickerAsset) {
    setMediaUri(asset.uri);
    setMediaType(
      asset.type === 'video' || (asset.mimeType ?? '').startsWith('video/')
        ? 'video/mp4'
        : 'image/jpeg',
    );
  }

  async function handlePost() {
    if (!mediaUri) { Alert.alert('Pick media first'); return; }
    if (postLockRef.current) return;
    postLockRef.current = true;
    setPosting(true);
    try {
      // Upload the local file through the server pipeline, which returns the
      // storage path POST /stories will accept.
      //
      // A branch here used to forward mediaUri unchanged when it already looked
      // like an http(s) URL, commented "already a remote URL (e.g. re-share from
      // another source)". Re-share was evidently intended, but the branch was
      // unreachable: setMediaUri is only ever called with ImagePickerAsset.uri
      // (a file:// or content:// local URI) or null. It is removed rather than
      // left dormant because POST /stories now rejects any mediaUrl that is not
      // an app-storage object this user uploaded — so the branch would have
      // turned into a silent 400 the moment someone revived it, and they would
      // have had no reason to suspect the server. Reviving re-share needs a
      // server-side upload-and-copy into the sharer's own object, not a URL
      // passthrough.
      setUploadProgress('Uploading media...');
      const uploaded = await uploadStoryMedia(mediaUri, mediaType);
      setUploadProgress(null);
      if (!uploaded) {
        Alert.alert('Upload failed', 'Could not upload your media. Please check your connection and try again.');
        return;
      }
      const publicUrl = uploaded;

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
      postLockRef.current = false;
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

        <KeyboardSafeView
          offset={insets.top}
          scrollViewProps={{ style: { flex: 1 } }}
          contentContainerStyle={{ padding: space.lg, gap: space.lg }}
        >
          {/* Media picker */}
          {mediaUri ? (
            <View style={s.previewContainer}>
              {/* mediaUri is always a local device file URI (file:// or content://)
                  set by the media picker — never a stored bucket URL — so no
                  signed-URL hydration is needed here. */}
              <Image source={{ uri: mediaUri }} style={s.preview} resizeMode="cover" />
              <Pressable onPress={() => setMediaUri(null)} style={s.clearMedia}>
                <X size={16} color="#fff" />
              </Pressable>
            </View>
          ) : (
            <MediaPickerButton
              composer={{ ...mediaComposer, onPickResult: handleMediaResult }}
              variant="area"
              label="Add photo or video"
              sheetTitle="New Story"
            />
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
        </KeyboardSafeView>

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
  previewContainer: { borderRadius: radius.md, overflow: 'hidden', aspectRatio: aspect.story, maxHeight: 320, alignSelf: 'center', width: '60%' },
  preview: { flex: 1, backgroundColor: color.haze },
  clearMedia: { position: 'absolute', top: 8, right: 8, width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
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
  toggleKnob: { width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2, backgroundColor: '#fff' },
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
  visCheck: { width: dot.s10, height: dot.s10, borderRadius: dot.s10 / 2, backgroundColor: color.deep },
});
