import React, { useState } from 'react';
import {
  View, Text, ScrollView, TextInput, Pressable, StyleSheet, ActivityIndicator,
  Switch, Image,
} from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { X, Image as ImageIcon, MapPin, Navigation, Check } from 'lucide-react-native';
import { Chip } from '../src/components/ui';
import type { PostCategory } from '../src/types/models';
import { color, space, radius, type as t } from '../src/theme/tokens';
import { usePostActions } from '../src/hooks/usePosts';
import type { PostVisibility } from '../src/services/posts';
import { uploadMedia, validateMedia, type PickedMedia } from '../src/services/media';
import { getCurrentGps, reverseGeocode } from '../src/services/location';

const CATS: PostCategory[] = ['hotel','food','nightlife','beach','activity','transport','airport','visa','safety','tip','question'];

const VIS_OPTIONS: { label: string; value: PostVisibility }[] = [
  { label: 'Public', value: 'public' },
  { label: 'Private', value: 'private' },
];

type LocState =
  | { source: 'none' }
  | { source: 'gps'; lat: number; lng: number; name: string | null; city: string | null; country: string | null }
  | { source: 'manual'; name: string; city: string | null; country: string | null };

export default function Create() {
  const [cat, setCat] = useState<PostCategory>('beach');
  const [vis, setVis] = useState<PostVisibility>('public');
  const [caption, setCaption] = useState('');
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [addToPassport, setAddToPassport] = useState(true);
  const [loc, setLoc] = useState<LocState>({ source: 'none' });
  const [manualText, setManualText] = useState('');
  const [gpsBusy, setGpsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { create, submitting } = usePostActions();

  const hasMedia = !!media;
  const canShare = hasMedia && !submitting; // media REQUIRED before submit

  async function pickMedia() {
    setError(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError('Photo library permission is needed to add media.'); return; }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const picked: PickedMedia = {
      uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg', fileName: a.fileName,
      fileSize: a.fileSize ?? null, width: a.width, height: a.height, type: a.type,
    };
    const v = validateMedia(picked);
    if (!v.ok) { setError(v.message); return; }
    setMedia(picked);
    if (!addToPassport) setAddToPassport(true); // default ON once media exists
  }

  async function useCurrentLocation() {
    setError(null);
    setGpsBusy(true);
    try {
      const gps = await getCurrentGps();
      if (!gps.granted || gps.lat == null || gps.lng == null) {
        setError('Location not available — you can add a location manually instead.');
        return;
      }
      const geo = await reverseGeocode(gps.lat, gps.lng);
      setLoc({ source: 'gps', lat: gps.lat, lng: gps.lng, name: geo.name, city: geo.city, country: geo.country });
    } finally {
      setGpsBusy(false);
    }
  }

  function applyManualLocation() {
    const name = manualText.trim();
    if (!name) { setLoc({ source: 'none' }); return; }
    setLoc({ source: 'manual', name, city: null, country: null });
  }

  async function onShare() {
    if (!canShare) {
      if (!hasMedia) setError('Add a photo or video before sharing.');
      return;
    }
    setError(null);

    // 1) Upload media first. If it fails, do NOT create the post.
    const up = await uploadMedia(media as PickedMedia);
    if (!up.ok || !up.url) {
      setError(up.message ?? 'Media upload failed. Your post was not created.');
      return;
    }

    // 2) Build payload. location_verified is NEVER sent — the server decides.
    const content = `[${cat}] ${caption.trim()}`.trim();
    const base = {
      content,
      visibility: vis,
      mediaUrls: [up.url],
      mediaType: up.mediaType,
      addToPassport,
    };
    let locationFields: Record<string, unknown> = { locationSource: 'none' as const };
    if (loc.source === 'gps') {
      locationFields = {
        locationSource: 'gps' as const,
        locationName: loc.name, locationCity: loc.city, locationCountry: loc.country,
        locationLat: loc.lat, locationLng: loc.lng,
        userGpsLat: loc.lat, userGpsLng: loc.lng,
      };
    } else if (loc.source === 'manual') {
      locationFields = {
        locationSource: 'manual' as const,
        locationName: loc.name, locationCity: loc.city, locationCountry: loc.country,
      };
    }

    const res = await create({ ...base, ...locationFields });
    if (res.ok) { router.back(); return; }

    const messages: Record<string, string> = {
      unauthenticated: 'Please sign in to post.',
      network_unreachable: 'Network unavailable. Try again.',
      invalid_payload: 'Please check your post and try again.',
      config_error: 'Posting is not available right now.',
      not_member: 'You need to be a member to post here.',
      forbidden: "You can't post here.",
    };
    setError(messages[res.errorKind ?? ''] ?? res.message ?? 'Could not share your post.');
  }

  const locLabel =
    loc.source === 'gps'
      ? `${loc.name ?? loc.city ?? 'Current location'} · GPS`
      : loc.source === 'manual'
      ? `${loc.name} · Manual`
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} hitSlop={8}><X size={24} color={color.ink} /></Pressable>
        <Text style={styles.title}>New post</Text>
        <View style={{ flex: 1 }} />
        <Pressable style={[styles.post, !canShare && styles.postDisabled]} onPress={onShare} disabled={!canShare}>
          {submitting ? <ActivityIndicator size="small" color={color.onInk} /> : <Text style={styles.postText}>Share</Text>}
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {error ? <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View> : null}

        <Pressable style={styles.media} onPress={pickMedia}>
          {media ? (
            <Image source={{ uri: media.uri }} style={styles.preview} resizeMode="cover" />
          ) : (
            <>
              <ImageIcon size={28} color={color.mute} />
              <Text style={styles.mediaText}>Add photo or video (required)</Text>
            </>
          )}
        </Pressable>

        <TextInput
          style={styles.caption}
          placeholder="Share a tip, review, question, or moment…"
          placeholderTextColor={color.faint}
          multiline value={caption} onChangeText={setCaption} editable={!submitting}
        />

        <View style={styles.toggleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.toggleTitle}>Add this post to my Passport</Text>
            <Text style={styles.toggleSub}>Creates a Passport postcard from this post.</Text>
          </View>
          <Switch value={addToPassport} onValueChange={setAddToPassport} disabled={!hasMedia} />
        </View>

        <View>
          <Text style={styles.label}>Add location</Text>
          <View style={styles.locRow}>
            <Pressable style={styles.locBtn} onPress={useCurrentLocation} disabled={gpsBusy}>
              {gpsBusy ? <ActivityIndicator size="small" color={color.deep} /> : <Navigation size={16} color={color.deep} />}
              <Text style={styles.locBtnText}>Use my current location</Text>
            </Pressable>
          </View>
          <View style={styles.manualRow}>
            <MapPin size={16} color={color.mute} />
            <TextInput
              style={styles.manualInput}
              placeholder="Or type a place (manual)"
              placeholderTextColor={color.faint}
              value={manualText}
              onChangeText={setManualText}
              onBlur={applyManualLocation}
              onSubmitEditing={applyManualLocation}
              editable={!submitting}
            />
            {manualText.trim() ? (
              <Pressable onPress={applyManualLocation} hitSlop={8}><Check size={18} color={color.success} /></Pressable>
            ) : null}
          </View>

          {locLabel ? (
            <View style={styles.locState}>
              <Text style={styles.locStateText}>{locLabel}</Text>
              <Text style={styles.locStateHint}>
                {loc.source === 'gps'
                  ? 'May earn a verified stamp if you are near this place.'
                  : 'Manual location — not GPS verified.'}
              </Text>
            </View>
          ) : null}
        </View>

        <View>
          <Text style={styles.label}>Category</Text>
          <View style={styles.wrap}>{CATS.map((c) => <Chip key={c} label={c} active={c===cat} onPress={() => setCat(c)} />)}</View>
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
  media: { height: 200, borderRadius: radius.lg, borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze, alignItems: 'center', justifyContent: 'center', gap: space.sm, backgroundColor: color.paperRaised, overflow: 'hidden' },
  preview: { width: '100%', height: '100%' },
  mediaText: { ...t.body, color: color.mute },
  caption: { ...t.body, color: color.ink, minHeight: 80, textAlignVertical: 'top' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  toggleTitle: { ...t.bodyStrong, color: color.ink },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },
  label: { ...t.stamp, fontFamily: 'Courier', color: color.mute, marginBottom: space.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  locRow: { flexDirection: 'row', gap: space.sm, marginBottom: space.sm },
  locBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  locBtnText: { ...t.small, fontWeight: '700', color: color.deep },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: 2, backgroundColor: color.paper },
  manualInput: { ...t.body, color: color.ink, flex: 1, paddingVertical: space.sm },
  locState: { marginTop: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  locStateText: { ...t.bodyStrong, color: color.ink },
  locStateHint: { ...t.small, color: color.mute, marginTop: 2 },
  errorBox: { backgroundColor: '#FDECEC', borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: '#F5B5B5' },
  errorText: { ...t.small, color: '#B23B3B', fontWeight: '600' },
});
