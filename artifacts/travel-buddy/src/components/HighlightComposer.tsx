/**
 * HighlightComposer — bottom sheet for creating a Highlight.
 * Media picker (photo + video ≤10s), caption, location tag,
 * visibility selector, duration selector, then POST /api/highlights.
 *
 * Videos are previewed as a static thumbnail (no native player needed).
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet,
  TextInput, Image, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { X, Camera, Video as VideoIcon, MapPin, Navigation, Check, PlayCircle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t, shadow } from '../theme/tokens';
import { uploadMedia, validateMedia } from '../services/media';
import { createHighlight, type HighlightVisibility } from '../services/highlights';
import { getCurrentGps, reverseGeocode } from '../services/location';
import { useSession } from '../context/SessionContext';
import { router } from 'expo-router';

const MAX_VIDEO_DURATION_SECONDS = 10;

const DURATIONS: { hours: number; label: string }[] = [
  { hours: 3,  label: '3h' },
  { hours: 6,  label: '6h' },
  { hours: 12, label: '12h' },
  { hours: 24, label: '24h' },
  { hours: 48, label: '48h' },
];

const VISIBILITIES: { value: HighlightVisibility; label: string }[] = [
  { value: 'public',           label: 'Everyone' },
  { value: 'travelers_nearby', label: 'Nearby travelers' },
  { value: 'circle_only',      label: 'My circle' },
  { value: 'trip_only',        label: 'Trip members' },
  { value: 'private',          label: 'Only me' },
];

type LocState =
  | { source: 'none' }
  | { source: 'gps'; lat: number; lng: number; name: string | null; city: string | null; country: string | null }
  | { source: 'manual'; name: string; city: string | null; country: string | null };

interface Props {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function HighlightComposer({ visible, onClose, onSuccess }: Props) {
  const insets = useSafeAreaInsets();
  const { signOut } = useSession();

  const [mediaUri, setMediaUri] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string>('image/jpeg');
  const [isVideo, setIsVideo] = useState(false);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);
  const [caption, setCaption] = useState('');
  const [vis, setVis] = useState<HighlightVisibility>('public');
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [loc, setLoc] = useState<LocState>({ source: 'none' });
  const [manualText, setManualText] = useState('');
  const [gpsBusy, setGpsBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setMediaUri(null);
      setMimeType('image/jpeg');
      setIsVideo(false);
      setVideoDuration(null);
      setFileSize(null);
      setCaption('');
      setVis('public');
      setExpiresInHours(24);
      setLoc({ source: 'none' });
      setManualText('');
      setError(null);
    }
  }, [visible]);

  async function pickFromLibrary() {
    setError(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError('Photo library permission required to add media.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
      videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
      allowsEditing: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    handlePickedAsset(res.assets[0]);
  }

  async function pickFromCamera() {
    setError(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError('Camera access denied. Enable it in Settings to capture media for Highlights.');
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.85,
      videoMaxDuration: MAX_VIDEO_DURATION_SECONDS,
      allowsEditing: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    handlePickedAsset(res.assets[0]);
  }

  function handlePickedAsset(a: ImagePicker.ImagePickerAsset) {
    const mime = a.mimeType ?? (a.type === 'video' ? 'video/mp4' : 'image/jpeg');
    const asVideo = mime.startsWith('video/') || a.type === 'video';
    const durationSec = a.duration ? a.duration / 1000 : null;

    if (asVideo && durationSec != null && durationSec > MAX_VIDEO_DURATION_SECONDS) {
      setError(`Highlights can be up to ${MAX_VIDEO_DURATION_SECONDS}s. Your video is ${durationSec.toFixed(1)}s.`);
      return;
    }

    const picked = {
      uri: a.uri,
      mimeType: mime,
      fileName: a.fileName ?? null,
      fileSize: a.fileSize ?? null,
      width: a.width,
      height: a.height,
      type: a.type,
    };
    const v = validateMedia(picked, { maxVideoDurationSeconds: 10 });
    if (!v.ok) { setError(v.message); return; }

    setMediaUri(a.uri);
    setMimeType(mime);
    setIsVideo(asVideo);
    setVideoDuration(durationSec);
    setFileSize(a.fileSize ?? null);
  }

  async function useGps() {
    setGpsBusy(true);
    setError(null);
    try {
      const gps = await getCurrentGps();
      if (!gps.granted || gps.lat == null || gps.lng == null) {
        setError('Location unavailable — type one manually below.');
        return;
      }
      const geo = await reverseGeocode(gps.lat, gps.lng);
      setLoc({ source: 'gps', lat: gps.lat, lng: gps.lng, name: geo.name, city: geo.city, country: geo.country });
    } finally {
      setGpsBusy(false);
    }
  }

  function applyManual() {
    const name = manualText.trim();
    setLoc(name ? { source: 'manual', name, city: null, country: null } : { source: 'none' });
  }

  async function handleSubmit() {
    if (!mediaUri || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const up = await uploadMedia({
        uri: mediaUri,
        mimeType,
        fileSize,
        type: isVideo ? 'video' : 'image',
      });
      if (!up.ok || !up.url) {
        if (up.errorKind === 'unauthenticated') {
          await signOut();
          router.replace('/(auth)/sign-in');
          onClose();
          return;
        }
        setError(up.message ?? 'Media upload failed.');
        return;
      }

      const locationCity = loc.source === 'gps' ? loc.city : null;
      const locationCountry = loc.source === 'gps' ? loc.country : null;
      const locationName = loc.source === 'none' ? null : loc.source === 'manual' ? loc.name : (loc.name ?? loc.city);

      const result = await createHighlight({
        mediaUrl: up.url,
        mediaType: mimeType,
        videoDurationSeconds: videoDuration,
        caption: caption.trim() || null,
        locationName,
        locationCity,
        locationCountry,
        visibility: vis,
        expiresInHours,
      });

      if (!result.ok) {
        if (result.errorKind === 'unauthenticated') {
          await signOut();
          router.replace('/(auth)/sign-in');
          onClose();
          return;
        }
        setError(result.message ?? 'Could not post highlight.');
        return;
      }

      onSuccess?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  const locLabel =
    loc.source === 'gps' ? `${loc.name ?? loc.city ?? 'Current location'} · GPS`
    : loc.source === 'manual' ? `${loc.name} · Manual`
    : null;

  const canSubmit = !!mediaUri && !submitting;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={s.grab} />
          <View style={s.head}>
            <Text style={s.headTitle}>New Highlight</Text>
            <Pressable onPress={onClose} hitSlop={8} style={s.closeBtn}>
              <X size={18} color={color.ink} />
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={s.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Media picker */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Media <Text style={{ color: color.signal }}>*</Text></Text>
              {mediaUri ? (
                <View style={s.mediaPreviewWrap}>
                  <Image source={{ uri: mediaUri }} style={s.mediaPreview} resizeMode="cover" />
                  {isVideo && (
                    <View style={s.videoPlayOverlay} pointerEvents="none">
                      <PlayCircle size={40} color="rgba(255,255,255,0.85)" />
                    </View>
                  )}
                  <Pressable style={s.mediaRemove} onPress={() => setMediaUri(null)} hitSlop={8}>
                    <X size={14} color="#fff" />
                  </Pressable>
                  {isVideo && videoDuration != null && (
                    <View style={s.durationBadge}>
                      <Text style={s.durationText}>{videoDuration.toFixed(1)}s</Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={s.mediaBtns}>
                  <Pressable style={s.mediaBtn} onPress={pickFromCamera}>
                    <Camera size={18} color={color.signal} />
                    <Text style={s.mediaBtnText}>Camera</Text>
                  </Pressable>
                  <Pressable style={s.mediaBtn} onPress={pickFromLibrary}>
                    <VideoIcon size={18} color={color.deep} />
                    <Text style={s.mediaBtnText}>Library</Text>
                  </Pressable>
                </View>
              )}
              <Text style={s.mediaHint}>Photos or videos up to {MAX_VIDEO_DURATION_SECONDS}s</Text>
            </View>

            {/* Caption */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Caption</Text>
              <TextInput
                style={[s.input, s.multiline]}
                placeholder="Add a caption…"
                placeholderTextColor={color.faint}
                multiline
                value={caption}
                onChangeText={setCaption}
                editable={!submitting}
                textAlignVertical="top"
              />
            </View>

            {/* Location */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Location</Text>
              <View style={s.locRow}>
                <Pressable style={s.locBtn} onPress={useGps} disabled={gpsBusy || submitting}>
                  {gpsBusy
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <Navigation size={14} color={color.deep} />}
                  <Text style={s.locBtnText}>Use GPS</Text>
                </Pressable>
              </View>
              <View style={s.manualRow}>
                <MapPin size={14} color={color.mute} />
                <TextInput
                  style={s.manualInput}
                  placeholder="Or type a place"
                  placeholderTextColor={color.faint}
                  value={manualText}
                  onChangeText={setManualText}
                  onBlur={applyManual}
                  onSubmitEditing={applyManual}
                  editable={!submitting}
                />
                {manualText.trim() ? (
                  <Pressable onPress={applyManual} hitSlop={8}><Check size={16} color={color.success} /></Pressable>
                ) : null}
              </View>
              {locLabel && <Text style={s.locLabel}>{locLabel}</Text>}
            </View>

            {/* Visibility */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Who can see this?</Text>
              <View style={s.chipRow}>
                {VISIBILITIES.map(({ value, label }) => (
                  <Pressable
                    key={value}
                    style={[s.chip, vis === value && s.chipOn]}
                    onPress={() => setVis(value)}
                  >
                    <Text style={[s.chipText, vis === value && s.chipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {/* Duration */}
            <View style={s.field}>
              <Text style={s.fieldLabel}>Expires in</Text>
              <View style={s.chipRow}>
                {DURATIONS.map(({ hours, label }) => (
                  <Pressable
                    key={hours}
                    style={[s.chip, expiresInHours === hours && s.chipOn]}
                    onPress={() => setExpiresInHours(hours)}
                  >
                    <Text style={[s.chipText, expiresInHours === hours && s.chipTextOn]}>{label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>

            {error && (
              <View style={s.errorBox}>
                <Text style={s.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <View style={s.footer}>
            <Pressable
              style={[s.submitBtn, !canSubmit && s.submitDisabled]}
              onPress={handleSubmit}
              disabled={!canSubmit}
            >
              {submitting
                ? <ActivityIndicator size="small" color={color.onInk} />
                : <Text style={s.submitText}>Share Highlight</Text>}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '90%',
    ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginTop: 10, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: 10 },
  headTitle: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md },
  field: { gap: 6 },
  fieldLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.8, textTransform: 'uppercase' },
  mediaBtns: { flexDirection: 'row', gap: space.md },
  mediaBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md, paddingVertical: space.md },
  mediaBtnText: { ...t.small, fontWeight: '700', color: color.ink },
  mediaHint: { ...t.small, color: color.faint, fontSize: 11 },
  mediaPreviewWrap: { position: 'relative' },
  mediaPreview: { width: '100%', height: 220, borderRadius: radius.md, backgroundColor: color.haze },
  videoPlayOverlay: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  mediaRemove: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(17,17,15,0.6)', alignItems: 'center', justifyContent: 'center' },
  durationBadge: { position: 'absolute', bottom: 8, left: 8, backgroundColor: 'rgba(17,17,15,0.6)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm },
  durationText: { fontFamily: 'Courier', fontSize: 11, color: '#fff', fontWeight: '700' },
  input: { ...t.body, color: color.ink, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 10 },
  multiline: { height: 80, paddingTop: 10 },
  locRow: { flexDirection: 'row', gap: space.sm, marginBottom: 4 },
  locBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  locBtnText: { ...t.small, fontWeight: '700', color: color.deep },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, backgroundColor: color.paperRaised, paddingHorizontal: space.md, paddingVertical: 6 },
  manualInput: { ...t.body, color: color.ink, flex: 1 },
  locLabel: { ...t.small, color: color.success, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink, fontSize: 12 },
  chipTextOn: { color: color.onInk },
  errorBox: { backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: space.md },
  errorText: { ...t.small, color: color.signal, fontWeight: '600' },
  footer: { paddingHorizontal: space.lg, paddingTop: space.md },
  submitBtn: { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  submitDisabled: { opacity: 0.4 },
  submitText: { ...t.bodyStrong, color: color.onInk },
});
