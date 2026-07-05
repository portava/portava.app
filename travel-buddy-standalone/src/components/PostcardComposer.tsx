/**
 * PostcardComposer — full-screen modal for creating a video/photo Postcard.
 *
 * Upload flow:
 *   pick → details → uploading (XHR progress) → success → onSuccess()
 *
 * Phases:
 *   'pick'     — media picker + preview + caption/location/visibility form
 *   'uploading' — progress bar, cancel button
 */
import React, { useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, TextInput,
  ActivityIndicator, Alert, Image, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, ImageIcon, PlayCircle, ChevronDown } from 'lucide-react-native';
import {
  createPostcard,
  getUploadUrl,
  uploadToSignedUrl,
  completeUpload,
  validatePostcardMedia,
  type PostcardVisibility,
  type UploadCancelRef,
} from '../services/postcards';
import { color, space, radius, type as t, shadow } from '../theme/tokens';

type Phase = 'pick' | 'uploading';

interface PickedAsset {
  uri: string;
  mimeType: string;
  fileName: string;
  fileSizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  isVideo: boolean;
}

const VISIBILITIES: { key: PostcardVisibility; label: string }[] = [
  { key: 'public',   label: 'Public' },
  { key: 'trip_only', label: 'Trip crew only' },
  { key: 'private',  label: 'Only me' },
];

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function PostcardComposer({ visible, onClose, onSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<Phase>('pick');
  const [asset, setAsset] = useState<PickedAsset | null>(null);
  const [caption, setCaption] = useState('');
  const [city, setCity] = useState('');
  const [visibility, setVisibility] = useState<PostcardVisibility>('public');
  const [showVis, setShowVis] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<UploadCancelRef>({});
  const abortedRef = useRef(false);

  function reset() {
    setPhase('pick');
    setAsset(null);
    setCaption('');
    setCity('');
    setVisibility('public');
    setShowVis(false);
    setProgress(0);
    setError(null);
    abortedRef.current = false;
  }

  function handleClose() {
    if (phase === 'uploading') {
      Alert.alert('Cancel upload?', 'Your upload is in progress. Cancel it?', [
        { text: 'Keep uploading', style: 'cancel' },
        {
          text: 'Cancel upload',
          style: 'destructive',
          onPress: () => {
            abortedRef.current = true;
            cancelRef.current.cancel?.();
            reset();
            onClose();
          },
        },
      ]);
      return;
    }
    reset();
    onClose();
  }

  async function pickFromLibrary() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow photo library access to pick media.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsEditing: false,
      quality: 0.92,
    });
    if (result.canceled || !result.assets?.[0]) return;
    applyAsset(result.assets[0]);
  }

  async function pickFromCamera() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Permission required', 'Allow camera access to take a photo or video.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.92,
    });
    if (result.canceled || !result.assets?.[0]) return;
    applyAsset(result.assets[0]);
  }

  function applyAsset(picked: ImagePicker.ImagePickerAsset) {
    const mimeType =
      picked.mimeType ??
      (picked.type === 'video' ? 'video/mp4' : 'image/jpeg');

    const fileSizeBytes = picked.fileSize ?? 0;

    if (fileSizeBytes > 0) {
      const validation = validatePostcardMedia(mimeType, fileSizeBytes);
      if (!validation.ok) {
        Alert.alert('Cannot use this file', validation.message);
        return;
      }
    }

    const durationSeconds =
      picked.type === 'video' && picked.duration != null
        ? Math.round(picked.duration / 1000)
        : undefined;

    setAsset({
      uri: picked.uri,
      mimeType,
      fileName: picked.fileName ?? `postcard.${mimeType.split('/')[1] ?? 'jpg'}`,
      fileSizeBytes,
      width: picked.width ?? undefined,
      height: picked.height ?? undefined,
      durationSeconds,
      isVideo: picked.type === 'video',
    });
    setError(null);
  }

  async function handlePost() {
    if (!asset) return;
    setError(null);
    setPhase('uploading');
    setProgress(0);
    abortedRef.current = false;

    const postRes = await createPostcard({
      caption: caption.trim() || undefined,
      visibility,
      locationCity: city.trim() || undefined,
      addToPassport: true,
    });

    if (!postRes.ok || abortedRef.current) {
      if (!abortedRef.current) {
        setError(postRes.ok ? 'Upload cancelled' : postRes.message);
        setPhase('pick');
      }
      return;
    }

    const postId = postRes.data.id;

    const urlRes = await getUploadUrl(postId, {
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes > 0 ? asset.fileSizeBytes : 1,
    });

    if (!urlRes.ok || abortedRef.current) {
      if (!abortedRef.current) {
        setError(urlRes.ok ? 'Upload cancelled' : urlRes.message);
        setPhase('pick');
      }
      return;
    }

    const { mediaId, uploadUrl } = urlRes.data;

    const uploadRes = await uploadToSignedUrl(
      uploadUrl,
      asset.uri,
      asset.mimeType,
      (p) => setProgress(p),
      cancelRef.current,
    );

    if (!uploadRes.ok || abortedRef.current) {
      if (!abortedRef.current) {
        setError(uploadRes.message ?? 'Upload failed');
        setPhase('pick');
      }
      return;
    }

    const completeRes = await completeUpload(postId, mediaId, {
      mimeType: asset.mimeType,
      fileSizeBytes: asset.fileSizeBytes > 0 ? asset.fileSizeBytes : 1,
      durationSeconds: asset.durationSeconds,
      width: asset.width,
      height: asset.height,
    });

    if (!completeRes.ok) {
      setError(completeRes.message);
      setPhase('pick');
      return;
    }

    reset();
    onSuccess();
  }

  const visLabel = VISIBILITIES.find((v) => v.key === visibility)?.label ?? 'Public';
  const progressPct = Math.round(progress * 100);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <View style={[s.root, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={s.header}>
          <Pressable style={s.headerBtn} onPress={handleClose} hitSlop={8}>
            <X size={22} color={color.ink} />
          </Pressable>
          <Text style={s.headerTitle}>New Postcard</Text>
          {phase === 'pick' && asset ? (
            <Pressable
              style={s.postBtn}
              onPress={handlePost}
              disabled={!asset}
            >
              <Text style={s.postBtnText}>Post</Text>
            </Pressable>
          ) : (
            <View style={{ width: 60 }} />
          )}
        </View>

        {phase === 'pick' && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={s.scrollContent} keyboardShouldPersistTaps="handled">
            {/* Error */}
            {error && (
              <View style={s.errorBanner}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}

            {/* Preview or picker */}
            {asset ? (
              <View style={s.previewWrap}>
                <Image
                  source={{ uri: asset.uri }}
                  style={s.preview}
                  resizeMode="cover"
                />
                {asset.isVideo && (
                  <View style={s.playOverlay}>
                    <PlayCircle size={48} color="#fff" />
                  </View>
                )}
                <Pressable style={s.changeBtn} onPress={pickFromLibrary} hitSlop={8}>
                  <Text style={s.changeBtnText}>Change</Text>
                </Pressable>
              </View>
            ) : (
              <View style={s.pickerArea}>
                <Text style={s.pickerHint}>Photo or video (up to 100 MB)</Text>
                <View style={s.pickerBtns}>
                  <Pressable style={s.pickerBtn} onPress={pickFromCamera}>
                    <Camera size={28} color={color.signal} />
                    <Text style={s.pickerBtnText}>Camera</Text>
                  </Pressable>
                  <Pressable style={s.pickerBtn} onPress={pickFromLibrary}>
                    <ImageIcon size={28} color={color.signal} />
                    <Text style={s.pickerBtnText}>Library</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Form — only shown after picking */}
            {asset && (
              <View style={s.form}>
                {/* Caption */}
                <Text style={s.label}>Caption</Text>
                <TextInput
                  style={s.captionInput}
                  value={caption}
                  onChangeText={setCaption}
                  placeholder="Where did you go? What did you do?"
                  placeholderTextColor={color.faint}
                  multiline
                  maxLength={2000}
                />

                {/* City */}
                <Text style={s.label}>City</Text>
                <TextInput
                  style={s.textInput}
                  value={city}
                  onChangeText={setCity}
                  placeholder="e.g. Tokyo, Japan"
                  placeholderTextColor={color.faint}
                  returnKeyType="done"
                  maxLength={100}
                />

                {/* Visibility */}
                <Text style={s.label}>Visibility</Text>
                <Pressable
                  style={s.visSelector}
                  onPress={() => setShowVis((v) => !v)}
                >
                  <Text style={s.visSelectorText}>{visLabel}</Text>
                  <ChevronDown size={16} color={color.mute} />
                </Pressable>
                {showVis && (
                  <View style={s.visDropdown}>
                    {VISIBILITIES.map((v) => (
                      <Pressable
                        key={v.key}
                        style={[s.visOption, visibility === v.key && s.visOptionActive]}
                        onPress={() => { setVisibility(v.key); setShowVis(false); }}
                      >
                        <Text style={[s.visOptionText, visibility === v.key && s.visOptionTextActive]}>
                          {v.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          </ScrollView>
        )}

        {phase === 'uploading' && (
          <View style={s.uploadingWrap}>
            <ActivityIndicator size="large" color={color.signal} />
            <Text style={s.uploadingTitle}>
              {progressPct < 5 ? 'Preparing upload…' : `Uploading ${progressPct}%`}
            </Text>

            {/* Progress bar */}
            <View style={s.progressTrack}>
              <View style={[s.progressFill, { width: `${progressPct}%` }]} />
            </View>

            <Pressable
              style={s.cancelUploadBtn}
              onPress={() => {
                abortedRef.current = true;
                cancelRef.current.cancel?.();
                reset();
              }}
            >
              <Text style={s.cancelUploadText}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  headerBtn: { width: 60, alignItems: 'flex-start' },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 17 },
  postBtn: {
    width: 60, backgroundColor: color.signal,
    borderRadius: radius.pill, paddingVertical: 8, alignItems: 'center',
  },
  postBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 14 },
  scrollContent: { paddingBottom: 40 },
  errorBanner: {
    backgroundColor: '#FEE2E2', marginHorizontal: space.lg, marginTop: space.md,
    borderRadius: radius.md, padding: space.md,
  },
  errorText: { ...t.small, color: '#B91C1C' },
  previewWrap: {
    marginHorizontal: space.lg, marginTop: space.md,
    borderRadius: radius.lg, overflow: 'hidden',
    height: 280, backgroundColor: color.haze,
  },
  preview: { ...StyleSheet.absoluteFillObject },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  changeBtn: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6,
  },
  changeBtnText: { ...t.small, color: '#fff', fontWeight: '600' },
  pickerArea: {
    marginHorizontal: space.lg, marginTop: space.lg,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze,
    borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 48, gap: space.xl,
  },
  pickerHint: { ...t.small, color: color.mute },
  pickerBtns: { flexDirection: 'row', gap: space.xl },
  pickerBtn: { alignItems: 'center', gap: space.sm, paddingHorizontal: space.xl, paddingVertical: space.md },
  pickerBtnText: { ...t.bodyStrong, color: color.ink },
  form: { paddingHorizontal: space.lg, paddingTop: space.lg, gap: space.md },
  label: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 2 },
  captionInput: {
    ...t.body, color: color.ink,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, minHeight: 96, textAlignVertical: 'top',
  },
  textInput: {
    ...t.body, color: color.ink,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, height: 48,
  },
  visSelector: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    padding: space.md, height: 48,
  },
  visSelectorText: { ...t.body, color: color.ink },
  visDropdown: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    overflow: 'hidden', ...shadow.card,
  },
  visOption: { paddingVertical: 14, paddingHorizontal: space.md, backgroundColor: color.paper },
  visOptionActive: { backgroundColor: color.haze },
  visOptionText: { ...t.body, color: color.ink },
  visOptionTextActive: { fontWeight: '700', color: color.signal },
  uploadingWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.xl,
  },
  uploadingTitle: { ...t.heading, color: color.ink, textAlign: 'center' },
  progressTrack: {
    width: '100%', height: 6, backgroundColor: color.haze,
    borderRadius: 3, overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: color.signal, borderRadius: 3 },
  cancelUploadBtn: {
    paddingHorizontal: space.xl, paddingVertical: space.md,
    borderRadius: radius.pill, borderWidth: 1.5, borderColor: color.mute,
  },
  cancelUploadText: { ...t.bodyStrong, color: color.ink },
});
