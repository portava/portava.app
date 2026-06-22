import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, TextInput,
  Image, ActivityIndicator, Switch, Platform, KeyboardAvoidingView,
} from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import {
  X, Check, PenLine, HelpCircle, Gem, Camera, Mail, UtensilsCrossed,
  MapPin, Navigation, SlidersHorizontal, Video as VideoIcon,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PULSE_FILTERS } from '../types/models';
import type { PulseFilter } from '../types/models';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';
import { usePostActions } from '../hooks/usePosts';
import type { PostVisibility } from '../services/posts';
import { uploadMedia, validateMedia, type PickedMedia } from '../services/media';
import { useSession } from '../context/SessionContext';
import { getCurrentGps, reverseGeocode } from '../services/location';
import { HighlightComposer } from './HighlightComposer';

/* ── Types ── */

const POST_TYPES = [
  { id: 'post_update',     label: 'Post Update',    sub: 'Share what\'s happening.',         icon: PenLine,        iconColor: color.signal },
  { id: 'ask_question',    label: 'Ask Question',   sub: 'Ask travelers nearby.',            icon: HelpCircle,     iconColor: '#8B5CF6' },
  { id: 'share_moment',    label: 'Share a Moment', sub: 'Capture a travel moment.',         icon: Camera,         iconColor: color.warn },
  { id: 'share_postcard',  label: 'Share Postcard', sub: 'A photo from your trip.',          icon: Mail,           iconColor: color.deep },
  { id: 'share_hidden_gem',label: 'Hidden Gem',     sub: 'Recommend a place.',               icon: Gem,            iconColor: color.success },
  { id: 'share_food_spot', label: 'Food Spot',      sub: 'Local food recommendation.',       icon: UtensilsCrossed,iconColor: '#F97316' },
  { id: 'share_highlight', label: 'Highlight',      sub: 'Photo or video up to 10s.',        icon: VideoIcon,      iconColor: '#E91E8C' },
] as const;
type PostTypeId = typeof POST_TYPES[number]['id'];

const TYPE_CATEGORY: Record<PostTypeId, string> = {
  post_update: 'tip',
  ask_question: 'question',
  share_moment: 'activity',
  share_postcard: 'activity',
  share_hidden_gem: 'activity',
  share_food_spot: 'food',
  share_highlight: 'highlight',
};

const SUBMIT_LABEL: Record<PostTypeId, string> = {
  post_update: 'Post Update',
  ask_question: 'Ask Question',
  share_moment: 'Share Moment',
  share_postcard: 'Share Postcard',
  share_hidden_gem: 'Share Hidden Gem',
  share_food_spot: 'Share Food Spot',
  share_highlight: 'Share Highlight',
};

/** Types that bypass the standard post form and open a dedicated composer. */
const DEDICATED_COMPOSERS: Partial<Record<PostTypeId, true>> = {
  share_highlight: true,
};

type LocState =
  | { source: 'none' }
  | { source: 'gps'; lat: number; lng: number; name: string | null; city: string | null; country: string | null }
  | { source: 'manual'; name: string; city: string | null; country: string | null };

function needsPlace(t: PostTypeId)  { return t === 'share_hidden_gem' || t === 'share_food_spot'; }
function requiresMedia(t: PostTypeId) { return t === 'share_postcard'; }
function requiresPhoto(t: PostTypeId) { return t === 'share_postcard'; }
function photoLabel(t: PostTypeId) {
  if (requiresMedia(t)) return 'Add photo or video (required)';
  if (t === 'share_moment') return 'Add photo (recommended)';
  return 'Add photo (optional)';
}

function validate(type: PostTypeId, text: string, placeName: string, media: PickedMedia | null): string | null {
  switch (type) {
    case 'post_update':     return (!text.trim() && !media) ? 'Add text or a photo.' : null;
    case 'ask_question':    return !text.trim() ? 'Type your question.' : null;
    case 'share_moment':    return (!text.trim() && !media) ? 'Add text or a photo.' : null;
    case 'share_postcard':  return !media ? 'Add a photo or video for your postcard.' : null;
    case 'share_hidden_gem': {
      if (!placeName.trim()) return 'Enter a place name.';
      if (!text.trim()) return 'Add a description.';
      return null;
    }
    case 'share_food_spot': {
      if (!placeName.trim()) return 'Enter the name of the spot.';
      if (!text.trim()) return 'Add a recommendation.';
      return null;
    }
    case 'share_highlight':
      // Handled by dedicated HighlightComposer — always "valid" here
      return null;
  }
}

/* ── Filter bottom sheet ── */
export function PulseFilterSheet({
  visible, active, onToggle, onClear, onClose,
}: {
  visible: boolean;
  active: PulseFilter[];
  onToggle: (f: PulseFilter) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={fs.backdrop} onPress={onClose} />
      <View style={fs.sheet}>
        <View style={fs.grab} />
        <View style={fs.head}>
          <Text style={fs.title}>Filter Pulse</Text>
          <View style={{ flex: 1 }} />
          {active.length > 0 && (
            <Pressable onPress={onClear} hitSlop={layout.hitSlop}><Text style={fs.clear}>Clear ({active.length})</Text></Pressable>
          )}
          <Pressable onPress={onClose} hitSlop={layout.hitSlop} style={fs.x}><X size={18} color={color.ink} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={fs.chips}>
          {PULSE_FILTERS.map((f) => {
            const on = active.includes(f);
            return (
              <Pressable key={f} style={[fs.chip, on && fs.chipOn]} onPress={() => onToggle(f)}>
                {on ? <Check size={14} color={color.onInk} /> : null}
                <Text style={[fs.chipText, on && fs.chipTextOn]}>{f}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Pressable style={fs.apply} onPress={onClose}>
          <Text style={fs.applyText}>Show results</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/* ── Unified post composer ── */
export function UnifiedPostComposer({
  visible,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { create, submitting } = usePostActions();
  const { signOut } = useSession();

  const [selectedType, setSelectedType] = useState<PostTypeId | null>(null);
  const [text, setText] = useState('');
  const [placeName, setPlaceName] = useState('');
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [vis, setVis] = useState<PostVisibility>('public');
  const [loc, setLoc] = useState<LocState>({ source: 'none' });
  const [manualText, setManualText] = useState('');
  const [gpsBusy, setGpsBusy] = useState(false);
  const [addToPassport, setAddToPassport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightComposerOpen, setHighlightComposerOpen] = useState(false);

  useEffect(() => {
    if (visible) {
      setSelectedType(null);
      setText('');
      setPlaceName('');
      setMedia(null);
      setVis('public');
      setLoc({ source: 'none' });
      setManualText('');
      setAddToPassport(false);
      setError(null);
      setHighlightComposerOpen(false);
    }
  }, [visible]);

  async function pickMedia() {
    setError(null);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { setError('Photo library permission required.'); return; }
    const allowVideo = selectedType === 'share_postcard';
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: allowVideo ? ['images', 'videos'] : ['images'],
      quality: 0.85,
      videoMaxDuration: allowVideo ? 10 : undefined,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const durationSec = a.duration != null ? a.duration / 1000 : null;
    const picked: PickedMedia = {
      uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg',
      fileName: a.fileName, fileSize: a.fileSize ?? null,
      width: a.width, height: a.height, type: a.type,
      duration: durationSec,
    };
    const v = validateMedia(picked, selectedType === 'share_postcard' ? { maxVideoDurationSeconds: 10 } : undefined);
    if (!v.ok) { setError(v.message); return; }
    setMedia(picked);
    if (selectedType === 'share_postcard' || selectedType === 'share_moment') setAddToPassport(true);
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

  const locLabel =
    loc.source === 'gps' ? `${loc.name ?? loc.city ?? 'Current location'} · GPS`
    : loc.source === 'manual' ? `${loc.name} · Manual`
    : null;

  async function handleSubmit() {
    if (!selectedType || submitting) return;
    setError(null);
    const vErr = validate(selectedType, text, placeName, media);
    if (vErr) { setError(vErr); return; }

    let mediaUrl: string | null = null;
    let mediaType: string | undefined = undefined;
    if (media) {
      const up = await uploadMedia(media);
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
      mediaUrl = up.url;
      mediaType = up.mediaType ?? undefined;
    }

    const cat = TYPE_CATEGORY[selectedType];
    const placePrefix = needsPlace(selectedType) && placeName.trim() ? `📍 ${placeName.trim()}\n` : '';
    const content = `[${cat}] ${placePrefix}${text.trim()}`.trim();

    let locationFields: Record<string, unknown> = { locationSource: 'none' };
    if (loc.source === 'gps') {
      locationFields = {
        locationSource: 'gps', locationName: loc.name, locationCity: loc.city,
        locationCountry: loc.country, locationLat: loc.lat, locationLng: loc.lng,
        userGpsLat: loc.lat, userGpsLng: loc.lng,
      };
    } else if (loc.source === 'manual') {
      locationFields = { locationSource: 'manual', locationName: loc.name, locationCity: loc.city, locationCountry: loc.country };
    }

    const autoPassport = selectedType === 'share_postcard';
    const res = await create({
      content,
      visibility: vis,
      mediaUrls: mediaUrl ? [mediaUrl] : [],
      ...(mediaType ? { mediaType } : {}),
      addToPassport: autoPassport || addToPassport,
      ...locationFields,
    });

    if (res.ok) {
      onSuccess?.();
      onClose();
      return;
    }
    if (res.errorKind === 'unauthenticated') {
      await signOut();
      router.replace('/(auth)/sign-in');
      onClose();
      return;
    }
    const msgs: Record<string, string> = {
      network_unreachable: 'Network unavailable. Try again.',
      invalid_payload: 'Check your post and try again.',
      config_error: 'Posting unavailable right now.',
    };
    setError(msgs[res.errorKind ?? ''] ?? res.message ?? 'Could not post.');
  }

  // Highlight type: open dedicated composer immediately on type select
  function handleTypeSelect(id: PostTypeId) {
    setSelectedType(id);
    setError(null);
    if (DEDICATED_COMPOSERS[id]) {
      setHighlightComposerOpen(true);
    }
  }

  const canSubmit = !!selectedType && !submitting &&
    !DEDICATED_COMPOSERS[selectedType as PostTypeId] &&
    validate(selectedType, text, placeName, media) === null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={uc.backdrop} onPress={onClose} />

        <View style={[uc.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          {/* drag handle + header */}
          <View style={uc.grab} />
          <View style={uc.head}>
            <Text style={uc.headTitle}>What are you sharing?</Text>
            <Pressable onPress={onClose} hitSlop={8} style={uc.closeBtn}>
              <X size={18} color={color.ink} />
            </Pressable>
          </View>

          {/* type grid + form */}
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={uc.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* 2-column type grid */}
            <View style={uc.grid}>
              {POST_TYPES.map(({ id, label, sub, icon: Icon, iconColor }) => {
                const on = selectedType === id;
                return (
                  <Pressable
                    key={id}
                    style={[uc.typeCard, on && uc.typeCardOn]}
                    onPress={() => handleTypeSelect(id)}
                  >
                    <View style={[uc.typeIcon, on && { backgroundColor: iconColor + '20' }]}>
                      <Icon size={16} color={on ? iconColor : color.mute} />
                    </View>
                    <Text style={[uc.typeLabel, on && { color: color.ink }]} numberOfLines={1}>{label}</Text>
                    <Text style={uc.typeSub} numberOfLines={1}>{sub}</Text>
                  </Pressable>
                );
              })}
            </View>

            {/* form fields — appear once type is selected */}
            {selectedType && (
              <View style={uc.form}>
                {/* place name — hidden gem / food spot only */}
                {needsPlace(selectedType) && (
                  <View style={uc.field}>
                    <Text style={uc.fieldLabel}>
                      {selectedType === 'share_food_spot' ? 'Name of spot' : 'Place name'}{' '}
                      <Text style={{ color: color.signal }}>*</Text>
                    </Text>
                    <TextInput
                      style={uc.input}
                      placeholder={selectedType === 'share_food_spot' ? 'e.g. Larsian BBQ' : 'e.g. Tops Lookout'}
                      placeholderTextColor={color.faint}
                      value={placeName}
                      onChangeText={setPlaceName}
                      editable={!submitting}
                    />
                  </View>
                )}

                {/* text / description */}
                <View style={uc.field}>
                  <Text style={uc.fieldLabel}>
                    {selectedType === 'ask_question' ? 'Your question' :
                     selectedType === 'share_hidden_gem' || selectedType === 'share_food_spot' ? 'Description' :
                     selectedType === 'share_postcard' ? 'Caption (optional)' :
                     'What\'s on your mind?'}
                  </Text>
                  <TextInput
                    style={[uc.input, uc.multiline]}
                    placeholder={
                      selectedType === 'ask_question' ? 'What do you want to know?' :
                      selectedType === 'share_hidden_gem' ? 'Why should travelers check this out?' :
                      selectedType === 'share_food_spot' ? 'What makes it worth trying?' :
                      selectedType === 'share_postcard' ? 'Add a caption…' :
                      'Share a tip, story, or update…'
                    }
                    placeholderTextColor={color.faint}
                    multiline
                    value={text}
                    onChangeText={setText}
                    editable={!submitting}
                    textAlignVertical="top"
                  />
                </View>

                {/* photo picker */}
                <View style={uc.field}>
                  <Text style={uc.fieldLabel}>{photoLabel(selectedType)}</Text>
                  <Pressable style={uc.mediaPicker} onPress={pickMedia} disabled={submitting}>
                    {media ? (
                      <View style={uc.mediaPreviewWrap}>
                        <Image source={{ uri: media.uri }} style={uc.mediaPreview} resizeMode="cover" />
                        <Pressable style={uc.mediaRemove} onPress={() => setMedia(null)} hitSlop={8}>
                          <X size={14} color="#fff" />
                        </Pressable>
                      </View>
                    ) : (
                      <View style={uc.mediaEmpty}>
                        <Camera size={22} color={color.mute} />
                        <Text style={uc.mediaEmptyText}>Tap to add photo</Text>
                      </View>
                    )}
                  </Pressable>
                </View>

                {/* add to passport toggle — for types that make sense */}
                {selectedType !== 'share_postcard' && (
                  <View style={uc.toggleRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={uc.toggleTitle}>Add to Passport</Text>
                      <Text style={uc.toggleSub}>Creates a postcard on your travel passport.</Text>
                    </View>
                    <Switch
                      value={addToPassport}
                      onValueChange={setAddToPassport}
                      disabled={!media || submitting}
                      trackColor={{ false: color.haze, true: color.signal }}
                    />
                  </View>
                )}

                {/* location */}
                <View style={uc.field}>
                  <Text style={uc.fieldLabel}>Location (optional)</Text>
                  <View style={uc.locRow}>
                    <Pressable style={uc.locBtn} onPress={useGps} disabled={gpsBusy || submitting}>
                      {gpsBusy
                        ? <ActivityIndicator size="small" color={color.deep} />
                        : <Navigation size={14} color={color.deep} />}
                      <Text style={uc.locBtnText}>Use GPS</Text>
                    </Pressable>
                  </View>
                  <View style={uc.manualRow}>
                    <MapPin size={14} color={color.mute} />
                    <TextInput
                      style={uc.manualInput}
                      placeholder="Or type a place name"
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
                  {locLabel && (
                    <Text style={uc.locLabel}>{locLabel}</Text>
                  )}
                </View>

                {/* visibility */}
                <View style={uc.field}>
                  <Text style={uc.fieldLabel}>Visibility</Text>
                  <View style={uc.chipRow}>
                    {(['public', 'private'] as PostVisibility[]).map((v) => (
                      <Pressable
                        key={v}
                        style={[uc.visChip, vis === v && uc.visChipOn]}
                        onPress={() => setVis(v)}
                      >
                        <Text style={[uc.visChipText, vis === v && uc.visChipTextOn]}>
                          {v.charAt(0).toUpperCase() + v.slice(1)}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>

                {error && (
                  <View style={uc.errorBox}>
                    <Text style={uc.errorText}>{error}</Text>
                  </View>
                )}
              </View>
            )}

            {!selectedType && error && (
              <View style={[uc.errorBox, { marginTop: space.md }]}>
                <Text style={uc.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          {/* sticky submit — hidden for dedicated composers */}
          {selectedType && !DEDICATED_COMPOSERS[selectedType] && (
            <View style={uc.footer}>
              <Pressable
                style={[uc.submitBtn, !canSubmit && uc.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={!canSubmit}
              >
                {submitting
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={uc.submitText}>{SUBMIT_LABEL[selectedType]}</Text>}
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      {/* Dedicated Highlight Composer — slides in over the type-picker */}
      <HighlightComposer
        visible={highlightComposerOpen}
        onClose={() => {
          setHighlightComposerOpen(false);
          setSelectedType(null);
        }}
        onSuccess={() => {
          setHighlightComposerOpen(false);
          onSuccess?.();
          onClose();
        }}
      />
    </Modal>
  );
}

/* ── styles ── */

const fs = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, paddingBottom: space.xxl, gap: space.md, ...shadow.float },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.title, color: color.ink, fontSize: 19 },
  clear: { ...t.small, color: color.signal, fontWeight: '700' },
  x: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink },
  chipTextOn: { color: color.onInk },
  apply: { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  applyText: { ...t.bodyStrong, color: color.onInk },
});

const uc = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.45)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '88%',
    ...shadow.float,
  },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze, marginTop: 10, marginBottom: 4 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: 10 },
  headTitle: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.lg },

  /* type grid — 2 columns */
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: space.md },
  typeCard: {
    width: '48.5%',
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: color.haze,
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 4,
  },
  typeCardOn: { borderColor: color.signal, backgroundColor: color.signal + '08' },
  typeIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  typeLabel: { ...t.bodyStrong, fontSize: 13, color: color.deep },
  typeSub: { ...t.small, fontSize: 10, color: color.faint, lineHeight: 13 },

  /* form */
  form: { gap: space.md },
  field: { gap: 6 },
  fieldLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.8, textTransform: 'uppercase' },
  input: {
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  multiline: { minHeight: 80, textAlignVertical: 'top', paddingTop: 10 },

  /* media */
  mediaPicker: {
    height: 120,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
    overflow: 'hidden',
  },
  mediaEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  mediaEmptyText: { ...t.small, color: color.mute },
  mediaPreviewWrap: { flex: 1 },
  mediaPreview: { width: '100%', height: '100%' },
  mediaRemove: {
    position: 'absolute', top: 6, right: 6,
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },

  /* passport toggle */
  toggleRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.md, borderRadius: radius.md,
    backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze,
  },
  toggleTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  toggleSub: { ...t.small, color: color.mute, marginTop: 2 },

  /* location */
  locRow: { flexDirection: 'row', gap: 8 },
  locBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  locBtnText: { ...t.small, fontWeight: '700', color: color.deep },
  manualRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: 10, paddingVertical: 2, backgroundColor: color.paper,
  },
  manualInput: { ...t.body, color: color.ink, flex: 1, paddingVertical: 8 },
  locLabel: { ...t.small, color: color.deep, fontWeight: '600', marginTop: 4 },

  /* visibility */
  chipRow: { flexDirection: 'row', gap: 8 },
  visChip: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
  },
  visChipOn: { backgroundColor: color.ink, borderColor: color.ink },
  visChipText: { ...t.small, fontWeight: '700', color: color.ink },
  visChipTextOn: { color: color.onInk },

  /* error */
  errorBox: { backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: '#FCA5A5' },
  errorText: { ...t.small, color: '#DC2626', fontWeight: '600' },

  /* footer */
  footer: { paddingHorizontal: space.lg, paddingTop: 12, borderTopWidth: 1, borderTopColor: color.haze },
  submitBtn: {
    backgroundColor: color.signal,
    borderRadius: radius.pill,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: { opacity: 0.45 },
  submitText: { ...t.bodyStrong, color: color.onInk, fontSize: 15 },
});
