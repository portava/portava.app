import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Pressable, Modal, ScrollView, StyleSheet, TextInput,
  Image, ActivityIndicator, Switch, Platform,
} from 'react-native';
import { KeyboardSafeScrollView } from './ui/KeyboardSafeView.tsx';
// (KeyboardSafeScrollView is the bare KAV wrapper — the composer page brings
// its own single ScrollView so the submit footer can sit below it, inside the
// KAV, and rise above the keyboard.)
import { MentionInput, type MentionInputHandle } from './MentionInput.tsx';
import { MentionSuggestionList } from './MentionSuggestionList.tsx';
import type { AnyMentionSuggestion, TagSpan } from '../services/tagging.ts';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import {
  X, Check, PenLine, HelpCircle, Gem, Camera, Mail, UtensilsCrossed,
  MapPin, SlidersHorizontal, Video as VideoIcon, ImageIcon,
} from 'lucide-react-native';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PULSE_FILTERS } from '../types/models.ts';
import type { PulseFilter, PostCategory } from '../types/models.ts';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens.ts';
import { usePostActions } from '../hooks/usePosts.ts';
import type { PostVisibility, LocationPrivacyMode } from '../services/posts.ts';
import { uploadMedia, validateMedia, type PickedMedia } from '../services/media.ts';
import { useSession } from '../context/SessionContext.tsx';
import type { Place } from '../lib/location/placeTypes.ts';
import { HighlightComposer } from './HighlightComposer.tsx';
import { MediaFilterEditor, type FilterApplyResult } from './MediaFilterEditor.tsx';
import { MediaSourceSheet } from './ui/MediaSourceSheet.tsx';
import { useMediaComposer } from '../hooks/useMediaComposer.ts';
import DateTimePicker from '@react-native-community/datetimepicker';
import { createComposerDismissHandlers, createSubmitLock, createOnceGuard, handleSubmitResult, handleUploadResult, handleFilterApplyResult, TYPE_CATEGORY, CATEGORY_OPTIONS, resolveDefaultCategory, handleCategoryChipPress, resolveCreateCategory, validateCategoryGate } from './PulseCreate.machine';
import { createFilterDismissHandlers } from './PulseFilterSheet.machine';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadLastCategory, saveLastCategory, clearLastCategory } from './pulseCreateCategoryStorage.ts';

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

// TYPE_CATEGORY and CATEGORY_OPTIONS are imported from PulseCreate.machine
// (single source of truth — the machine tests exercise the same objects).

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

function needsPlace(t: PostTypeId)  { return t === 'share_hidden_gem' || t === 'share_food_spot'; }
function requiresMedia(t: PostTypeId) { return t === 'share_postcard'; }
function requiresPhoto(t: PostTypeId) { return t === 'share_postcard'; }
function photoLabel(t: PostTypeId) {
  if (requiresMedia(t)) return 'Photo or video (required)';
  if (t === 'share_moment') return 'Photo or video (recommended)';
  return 'Photo or video (optional)';
}

function validate(
  type: PostTypeId,
  text: string,
  placeName: string,
  media: PickedMedia | null,
  selectedCategory: PostCategory | null,
): string | null {
  // Defense-in-depth: if the post type maps to a default category but none was
  // selected (e.g. due to a state bug), block submit before the API is called.
  if (TYPE_CATEGORY[type] && !selectedCategory) {
    return 'Pick a category before posting.';
  }
  // Catch new post types that ship without a TYPE_CATEGORY mapping — the chip
  // picker is hidden for those types, so selectedCategory stays null and would
  // silently produce a category-less post without this guard.
  const gate = validateCategoryGate(type, selectedCategory);
  if (!gate.ok) {
    return 'Pick a category before posting.';
  }
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
  const dismiss = createFilterDismissHandlers(onClose);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={dismiss.onRequestClose}>
      <Pressable testID="filter-sheet-backdrop" style={fs.backdrop} onPress={dismiss.onBackdropPress} />
      <View style={fs.sheet}>
        <View style={fs.grab} />
        <View style={fs.head}>
          <Text style={fs.title}>Filter Pulse</Text>
          <View style={{ flex: 1 }} />
          {active.length > 0 && (
            <Pressable onPress={onClear} hitSlop={layout.hitSlop}><Text style={fs.clear}>Clear ({active.length})</Text></Pressable>
          )}
          <Pressable testID="filter-sheet-close-btn" onPress={dismiss.onCloseButtonPress} hitSlop={layout.hitSlop} style={fs.x}><X size={18} color={color.ink} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={fs.chips}>
          {PULSE_FILTERS.map((f) => {
            const on = active.includes(f);
            const label = f === 'Hidden Gems' ? 'Gems' : f;
            return (
              <Pressable key={f} style={[fs.chip, on && fs.chipOn]} onPress={() => onToggle(f)}>
                {on ? <Check size={14} color={color.onInk} /> : null}
                <Text style={[fs.chipText, on && fs.chipTextOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Pressable testID="filter-sheet-apply" style={fs.apply} onPress={dismiss.onApplyPress}>
          <Text style={fs.applyText}>Show results</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/* ── Unified post composer ── */
export function UnifiedPostComposer({
  onClose,
  onSuccess,
  openCameraOnMount = false,
  initialPlace = null,
  initialBucket = null,
}: {
  onClose: () => void;
  onSuccess?: () => void;
  /** When true, the camera launches immediately on mount (native only). */
  openCameraOnMount?: boolean;
  /** Pre-selected place (e.g. when opened from a place page CTA). */
  initialPlace?: Place | null;
  /** Bucket hint passed from a place-page bucket CTA (e.g. 'night'). */
  initialBucket?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const { create, submitting } = usePostActions();
  const { signOut } = useSession();

  // True from the moment the submit lock is acquired until the finally block
  // releases it. Covers the upload phase where `submitting` (from usePostActions)
  // is still false, ensuring the button is visually disabled for the full
  // upload → create lifecycle, not just the create phase.
  const [inFlight, setInFlight] = useState(false);

  const [selectedType, setSelectedType] = useState<PostTypeId | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<PostCategory | null>(null);
  const [text, setText] = useState('');
  const [placeName, setPlaceName] = useState('');
  const mentionRef = useRef<MentionInputHandle>(null);
  // Shared lock across concurrent handleSubmit() calls — prevents double-close
  // on the upload unauthenticated path where `submitting` is still false.
  const submitLock = useRef(createSubmitLock());
  const [mentionSuggestions, setMentionSuggestions] = useState<AnyMentionSuggestion[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionVisible, setMentionVisible] = useState(false);
  const [postTags, setPostTags] = useState<TagSpan[]>([]);
  const [media, setMedia] = useState<PickedMedia | null>(null);
  const [vis, setVis] = useState<PostVisibility>('public');
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(initialPlace ?? null);
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [addToPassport, setAddToPassport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightComposerOpen, setHighlightComposerOpen] = useState(false);
  const [filterEditorOpen, setFilterEditorOpen] = useState(false);
  const [filterEditorPending, setFilterEditorPending] = useState<PickedMedia | null>(null);
  const [filterId, setFilterId] = useState<string>('original');
  const [filterIntensity, setFilterIntensity] = useState<number>(100);
  const [locationPrivacyMode, setLocationPrivacyMode] = useState<LocationPrivacyMode>('none');
  const [scheduledTime, setScheduledTime] = useState<Date | null>(null);

  // Restore the last-used category for the selected post type, falling back to
  // the type default when no preference has been saved yet.
  // The cancellation flag prevents a slow earlier load from overwriting the
  // result of a later load when the user switches types quickly.
  useEffect(() => {
    if (!selectedType) return;
    let cancelled = false;
    loadLastCategory(AsyncStorage, selectedType).then((saved) => {
      if (cancelled) return;
      setSelectedCategory(saved ?? resolveDefaultCategory(selectedType));
    });
    return () => { cancelled = true; };
  }, [selectedType]);

  // Auto-select delayed_until_exit when the user attaches a location
  useEffect(() => {
    if (!selectedPlace) {
      setLocationPrivacyMode('none');
    } else if (locationPrivacyMode === 'none') {
      setLocationPrivacyMode('delayed_until_exit');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlace]);

  // Pre-fill scheduledTime when switching to "At a time" so the submit
  // always has a value even if the user never touches the spinner.
  useEffect(() => {
    if (locationPrivacyMode === 'delayed_until_time' && scheduledTime === null) {
      setScheduledTime(new Date(Date.now() + 60 * 60 * 1_000));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationPrivacyMode]);

  // No reset-on-open effect: the composer is a full-screen /create page, so
  // every navigation mounts a fresh instance whose useState initializers
  // already provide clean state.

  // Sheet state is managed by useMediaComposer; PulseCreate uses the
  // hook only for sheetVisible/openSheet/closeSheet — it keeps its own
  // single-item `media` state and filter-editor flow.
  const pulseComposer = useMediaComposer('pulse');

  // Auto-open camera on mount (native only). Fires exactly once.
  // If the user captures something, 'share_moment' is auto-selected and the
  // asset is fed into the filter-editor pipeline. Cancelling simply shows the
  // regular composer so the user can pick a type and add media manually.
  const didAutoOpenCamera = useRef(false);
  useEffect(() => {
    if (!openCameraOnMount || didAutoOpenCamera.current || Platform.OS === 'web') return;
    didAutoOpenCamera.current = true;
    (async () => {
      try {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) return;
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ['images', 'videos'],
          quality: 0.92,
          videoMaxDuration: 60,
        });
        if (result.canceled || !result.assets?.[0]) return;
        const asset = result.assets[0];
        const mime = asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
        const picked: PickedMedia = {
          uri: asset.uri,
          mimeType: mime,
          fileName: asset.fileName ?? null,
          fileSize: asset.fileSize ?? null,
          width: asset.width,
          height: asset.height,
          type: asset.type as 'image' | 'video',
          duration: asset.duration != null ? asset.duration / 1000 : null,
        };
        const v = validateMedia(picked, { maxVideoDurationSeconds: 60 });
        if (!v.ok) { setError(v.message); return; }
        // Auto-select 'share_moment' so the form is immediately usable
        setSelectedType('share_moment');
        setAddToPassport(true);
        if (picked.type === 'video') {
          // Videos skip the filter editor
          setMedia(picked);
        } else {
          setFilterEditorPending(picked);
          setFilterEditorOpen(true);
        }
      } catch { /* silently show regular composer */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally no deps — runs once on mount

  function openPickerSheet() {
    setError(null);
    pulseComposer.openSheet();
  }

  function handlePickResult(asset: ImagePicker.ImagePickerAsset) {
    const mime = asset.mimeType ?? (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
    const durationSec = asset.duration != null ? asset.duration / 1000 : null;
    const picked: PickedMedia = {
      uri: asset.uri, mimeType: mime,
      fileName: asset.fileName, fileSize: asset.fileSize ?? null,
      width: asset.width, height: asset.height,
      type: asset.type as 'image' | 'video',
      duration: durationSec,
    };
    // Allow video for all post types. Highlights get a shorter limit (10s);
    // everything else gets up to 60s.
    const maxDuration = selectedType === 'share_highlight' ? 10 : 60;
    const v = validateMedia(picked, { maxVideoDurationSeconds: maxDuration });
    if (!v.ok) { setError(v.message); return; }
    if (selectedType === 'share_postcard' || selectedType === 'share_moment') setAddToPassport(true);
    if (picked.type === 'video') {
      // Videos skip the filter editor — store directly.
      setMedia(picked);
    } else {
      setFilterEditorPending(picked);
      setFilterEditorOpen(true);
    }
  }

  const handleFilterApply = useCallback((result: FilterApplyResult) => {
    if (!filterEditorPending) {
      setFilterEditorOpen(false);
      return;
    }
    handleFilterApplyResult(
      {
        ok: true,
        filteredMedia: { ...filterEditorPending, uri: result.uri },
        filterId: result.filterId,
        filterIntensity: result.filterIntensity,
      },
      {
        setMedia: (m) => setMedia(m as PickedMedia),
        setFilterId,
        setFilterIntensity,
        setFilterEditorPending: () => setFilterEditorPending(null),
        setFilterEditorOpen,
        setError,
      },
    );
  }, [filterEditorPending]);

  const locLabel = selectedPlace
    ? `${selectedPlace.displayName}${selectedPlace.source === 'gps' ? ' · GPS' : ''}`
    : null;

  async function handleSubmit() {
    if (!selectedType || submitting || inFlight) return;
    // Acquire the shared submit lock before any async work.
    // The `submitting` flag from usePostActions only flips true inside create(),
    // AFTER the upload phase — so without this lock a rapid double-tap could
    // re-enter here while upload is in flight and call onClose() twice on an
    // unauthenticated upload failure.
    if (!submitLock.current.acquire()) return;
    // Flip inFlight immediately (synchronously after lock acquisition) so the
    // button is visually disabled for the whole upload → create cycle, not only
    // the create phase.
    setInFlight(true);
    setError(null);
    const vErr = validate(selectedType, text, placeName, media, selectedCategory);
    if (vErr) { submitLock.current.release(); setInFlight(false); setError(vErr); return; }

    // Defense-in-depth: even within a single submit invocation wrap onClose so
    // it can only fire once (covers hypothetical paths where both upload and
    // submit legs try to close).
    const closeOnce = createOnceGuard(onClose);

    try {
      let mediaUrl: string | null = null;
      let mediaType: string | undefined = undefined;
      if (media) {
        const up = await uploadMedia(media);
        const outcome = await handleUploadResult(up, {
          onClose: closeOnce,
          signOut,
          navigate: router.replace as (path: string) => void,
          setError,
        });
        if (!outcome.continue) return;
        mediaUrl = outcome.url;
        mediaType = outcome.mediaType ?? undefined;
      }

      const placePrefix = needsPlace(selectedType) && placeName.trim() ? `📍 ${placeName.trim()}\n` : '';
      const content = `${placePrefix}${text.trim()}`.trim();

      let locationFields: Record<string, unknown> = { locationSource: 'none' };
      if (selectedPlace) {
        const isGps = selectedPlace.source === 'gps';
        locationFields = {
          locationSource: isGps ? 'gps' : 'manual',
          locationName: selectedPlace.displayName,
          locationCity: selectedPlace.city,
          locationCountry: selectedPlace.country,
          locationLat: selectedPlace.lat,
          locationLng: selectedPlace.lng,
          ...(isGps ? { userGpsLat: selectedPlace.lat, userGpsLng: selectedPlace.lng } : {}),
        };
      }

      const autoPassport = selectedType === 'share_postcard';
      const res = await create({
        content,
        visibility: vis,
        mediaUrls: mediaUrl ? [mediaUrl] : [],
        ...(mediaType ? { mediaType } : {}),
        addToPassport: autoPassport || addToPassport,
        ...locationFields,
        filterId,
        filterIntensity,
        locationPrivacyMode: locationPrivacyMode === 'none' ? undefined : locationPrivacyMode,
        publishAfterTime: locationPrivacyMode === 'delayed_until_time' ? (scheduledTime?.toISOString() ?? null) : null,
        category: resolveCreateCategory(selectedCategory),
      });

      await handleSubmitResult(res, {
        onSuccess,
        onClose: closeOnce,
        signOut,
        navigate: router.replace as (path: string) => void,
        setError,
      });
    } finally {
      submitLock.current.release();
      setInFlight(false);
    }
  }

  // Highlight type: open dedicated composer immediately on type select
  function handleTypeSelect(id: PostTypeId) {
    setSelectedType(id);
    setError(null);
    if (DEDICATED_COMPOSERS[id]) {
      setHighlightComposerOpen(true);
    }
  }

  // inFlight covers the upload phase; submitting covers the create() call.
  // Both must be false for the button to be interactive.
  const canSubmit = !!selectedType && !submitting && !inFlight &&
    !DEDICATED_COMPOSERS[selectedType as PostTypeId] &&
    validate(selectedType, text, placeName, media, selectedCategory) === null;

  const dismiss = createComposerDismissHandlers(onClose);

  return (
    <View style={uc.page}>
      {/* Full-screen page header — safe-area aware. Dismiss = X button
          (Android hardware back pops the /create route via the router). */}
      <View style={[uc.head, { paddingTop: insets.top + 8 }]}>
        <Text style={uc.headTitle}>What are you sharing?</Text>
        <Pressable testID="post-composer-close-btn" onPress={dismiss.onCloseButtonPress} hitSlop={8} style={uc.closeBtn}>
          <X size={18} color={color.ink} />
        </Pressable>
      </View>

      {/* Scrollable body — bare KAV + a single ScrollView, with the sticky
          submit footer as a sibling inside the KAV so it rises above the
          keyboard. (The old bottom-sheet presentation capped height at 88%
          without a scroll container, which clipped the form.) */}
      <KeyboardSafeScrollView style={uc.body}>
        <View style={uc.bodyInner}>
          <ScrollView
            style={uc.bodyScroll}
            contentContainerStyle={uc.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* When a type is selected show a compact chip; otherwise show the full 2-col grid.
                This keeps the form fields visible even when the keyboard is open. */}
            {selectedType ? (
              (() => {
                const pt = POST_TYPES.find(p => p.id === selectedType)!;
                const Icon = pt.icon;
                return (
                  <Pressable
                    style={uc.typeChip}
                    onPress={() => { setSelectedType(null); setError(null); }}
                  >
                    <View style={[uc.typeChipIcon, { backgroundColor: pt.iconColor + '20' }]}>
                      <Icon size={14} color={pt.iconColor} />
                    </View>
                    <Text style={uc.typeChipLabel}>{pt.label}</Text>
                    <View style={{ flex: 1 }} />
                    <X size={14} color={color.mute} />
                  </Pressable>
                );
              })()
            ) : (
              <View style={uc.grid}>
                {POST_TYPES.map(({ id, label, sub, icon: Icon, iconColor }) => (
                  <Pressable
                    key={id}
                    style={uc.typeCard}
                    onPress={() => handleTypeSelect(id)}
                  >
                    <View style={uc.typeIcon}>
                      <Icon size={16} color={color.mute} />
                    </View>
                    <Text style={uc.typeLabel}>{label}</Text>
                    <Text style={uc.typeSub} numberOfLines={1}>{sub}</Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* form fields — appear once type is selected */}
            {selectedType && (
              <View style={uc.form}>
                {/* category chip picker */}
                {!DEDICATED_COMPOSERS[selectedType] && !!TYPE_CATEGORY[selectedType] && (
                  <View style={uc.field}>
                    <View style={uc.fieldLabelRow}>
                      <Text style={uc.fieldLabel}>Category</Text>
                      {selectedCategory !== resolveDefaultCategory(selectedType) && (
                        <Pressable
                          onPress={() => {
                            clearLastCategory(AsyncStorage, selectedType);
                            setSelectedCategory(resolveDefaultCategory(selectedType));
                          }}
                          disabled={submitting}
                        >
                          <Text style={uc.resetLink}>Reset to default</Text>
                        </Pressable>
                      )}
                    </View>
                    <View style={uc.chipRowWrap}>
                      {CATEGORY_OPTIONS.map(({ value, label }) => (
                        <Pressable
                          key={value}
                          style={[uc.visChip, selectedCategory === value && uc.visChipOn]}
                          onPress={() => {
                            const cat = handleCategoryChipPress(value);
                            setSelectedCategory(cat);
                            saveLastCategory(AsyncStorage, selectedType, cat);
                          }}
                          disabled={submitting}
                        >
                          <Text style={[uc.visChipText, selectedCategory === value && uc.visChipTextOn]}>
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )}

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
                  <MentionSuggestionList
                    suggestions={mentionSuggestions}
                    loading={mentionLoading}
                    visible={mentionVisible}
                    onSelect={(s) => mentionRef.current?.insertTag(s)}
                  />
                  <MentionInput
                    ref={mentionRef}
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
                    surface="post"
                    onTagsChange={setPostTags}
                    onSuggestionsChange={(items, isLoading, trigger) => {
                      setMentionSuggestions(items);
                      setMentionLoading(isLoading);
                      setMentionVisible(!!trigger && (items.length > 0 || isLoading));
                    }}
                  />
                </View>

                {/* photo picker */}
                <View style={uc.field}>
                  <Text style={uc.fieldLabel}>{photoLabel(selectedType)}</Text>
                  <Pressable style={uc.mediaPicker} onPress={openPickerSheet} disabled={submitting}>
                    {media ? (
                      <View style={uc.mediaPreviewWrap}>
                        <Image source={{ uri: media.uri }} style={uc.mediaPreview} resizeMode="cover" />
                        <Pressable style={uc.mediaRemove} onPress={() => setMedia(null)} hitSlop={8}>
                          <X size={14} color="#fff" />
                        </Pressable>
                      </View>
                    ) : (
                      <View style={uc.mediaEmpty}>
                        <View style={uc.mediaEmptyIcons}>
                          <Camera size={20} color={color.mute} />
                          <ImageIcon size={20} color={color.mute} />
                        </View>
                        <Text style={uc.mediaEmptyText}>
                          {selectedType === 'share_highlight' ? 'Photo or video (up to 10s)' : 'Photo or video'}
                        </Text>
                        <Text style={uc.mediaEmptySub}>Camera · Library</Text>
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
                  {selectedPlace ? (
                    <View style={uc.locChip}>
                      <MapPin size={13} color={color.signal} />
                      <Text style={uc.locChipText} numberOfLines={1}>{locLabel}</Text>
                      <Pressable
                        onPress={() => setSelectedPlace(null)}
                        hitSlop={8}
                        style={uc.locChipRemove}
                      >
                        <X size={13} color={color.mute} />
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable
                      style={uc.locBtn}
                      onPress={() => setLocationPickerOpen(true)}
                      disabled={submitting}
                    >
                      <MapPin size={14} color={color.deep} />
                      <Text style={uc.locBtnText}>Add location</Text>
                    </Pressable>
                  )}
                </View>

                {/* location privacy — only shown when a location is attached */}
                {selectedPlace !== null && (
                  <View style={uc.field}>
                    <Text style={uc.fieldLabel}>Share location</Text>
                    <View style={uc.chipRowWrap}>
                      {([
                        { mode: 'delayed_until_exit' as LocationPrivacyMode, label: 'After I leave' },
                        { mode: 'delayed_until_time' as LocationPrivacyMode, label: 'At a time' },
                        { mode: 'city_only' as LocationPrivacyMode, label: 'City only' },
                        { mode: 'none' as LocationPrivacyMode, label: 'Now' },
                        { mode: 'hidden' as LocationPrivacyMode, label: 'Hidden' },
                        { mode: 'trusted_circle_only' as LocationPrivacyMode, label: 'Trusted circle' },
                      ] satisfies { mode: LocationPrivacyMode; label: string }[]).map(({ mode, label }) => (
                        <Pressable
                          key={mode}
                          style={[uc.visChip, locationPrivacyMode === mode && uc.visChipOn]}
                          onPress={() => setLocationPrivacyMode(mode)}
                        >
                          <Text style={[uc.visChipText, locationPrivacyMode === mode && uc.visChipTextOn]}>
                            {label}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    {locationPrivacyMode === 'delayed_until_exit' && (
                      <Text style={uc.privacyHint}>
                        Location will appear after you've left this spot.
                      </Text>
                    )}
                    {locationPrivacyMode === 'delayed_until_time' && (
                      <>
                        <Text style={uc.privacyHint}>
                          {scheduledTime
                            ? `Publishing at ${scheduledTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                            : 'Pick a time to publish your location'}
                        </Text>
                        <DateTimePicker
                          value={scheduledTime ?? new Date(Date.now() + 60 * 60 * 1_000)}
                          mode="time"
                          is24Hour={false}
                          display="spinner"
                          onChange={(_e: any, date?: Date) => { if (date) setScheduledTime(date); }}
                          style={{ height: 100 }}
                        />
                      </>
                    )}
                    {locationPrivacyMode === 'city_only' && (
                      <Text style={uc.privacyHint}>Only the city name will be shared.</Text>
                    )}
                    {locationPrivacyMode === 'hidden' && (
                      <Text style={uc.privacyHint}>Location stays completely hidden.</Text>
                    )}
                    {locationPrivacyMode === 'trusted_circle_only' && (
                      <Text style={uc.privacyHint}>
                        Only people in your Trusted Circle can see where you are.
                      </Text>
                    )}
                  </View>
                )}

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

          {/* sticky submit — hidden for dedicated composers; sibling of the
              ScrollView inside the KAV so it stays above the keyboard */}
          {selectedType && !DEDICATED_COMPOSERS[selectedType] && (
            <View style={[uc.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
              <Pressable
                style={[uc.submitBtn, !canSubmit && uc.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={!canSubmit}
              >
                {(submitting || inFlight)
                  ? <ActivityIndicator size="small" color={color.onInk} />
                  : <Text style={uc.submitText}>{SUBMIT_LABEL[selectedType]}</Text>}
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardSafeScrollView>

      {/* Location picker */}
      <GlobalPlacePicker
        visible={locationPickerOpen}
        title="Add location"
        onSelect={(place) => {
          setSelectedPlace(place);
          setLocationPickerOpen(false);
        }}
        onClose={() => setLocationPickerOpen(false)}
        usedFor="pulse_location"
      />

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

      {/* Filter editor — opens after media pick, before storing */}
      {filterEditorOpen && filterEditorPending && (
        <MediaFilterEditor
          file={{
            uri: filterEditorPending.uri,
            mimeType: filterEditorPending.mimeType ?? 'image/jpeg',
            width: filterEditorPending.width ?? null,
            height: filterEditorPending.height ?? null,
          }}
          mediaType={(filterEditorPending.mimeType ?? '').startsWith('video/') ? 'video' : 'image'}
          onApply={handleFilterApply}
          onCancel={() => {
            setFilterEditorOpen(false);
            setFilterEditorPending(null);
          }}
        />
      )}

      {/* Media source sheet — opened by openPickerSheet(); handles camera/library
          picking plus the denied→Settings path and iOS limited-library prompt.
          Sheet visibility is managed by pulseComposer (useMediaComposer); the
          result is routed through PulseCreate's own handlePickResult so the
          filter-editor step and single-item PickedMedia state are preserved. */}
      <MediaSourceSheet
        visible={pulseComposer.sheetVisible}
        onClose={pulseComposer.closeSheet}
        onResult={(asset) => { pulseComposer.closeSheet(); handlePickResult(asset); }}
        allowsVideo={true}
        videoMaxDuration={selectedType === 'share_highlight' ? 10 : 60}
        title="Add media"
      />
    </View>
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
  /* full-screen page chrome */
  page: { flex: 1, backgroundColor: color.paper },
  body: { flex: 1 },
  bodyInner: { flex: 1 },
  bodyScroll: { flex: 1 },
  head: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingBottom: 10,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  headTitle: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  scroll: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg },

  /* selected-type compact chip (replaces full grid once a type is picked) */
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: color.signal,
    backgroundColor: color.signal + '08',
    marginBottom: space.md,
  },
  typeChipIcon: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeChipLabel: { ...t.bodyStrong, fontSize: 13, color: color.ink },

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
  fieldLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  resetLink: { fontSize: 11, color: color.mute, textDecorationLine: 'underline' },
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
  mediaEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 5 },
  mediaEmptyIcons: { flexDirection: 'row', gap: 10, marginBottom: 2 },
  mediaEmptyText: { ...t.small, color: color.mute, fontWeight: '600' },
  mediaEmptySub: { ...t.small, fontSize: 10, color: color.faint },
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
  locBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised,
    alignSelf: 'flex-start',
  },
  locBtnText: { ...t.small, fontWeight: '700', color: color.deep },
  locChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1,
    borderColor: color.signal + '50', backgroundColor: color.signal + '10',
    alignSelf: 'flex-start', maxWidth: '100%',
  },
  locChipText: { ...t.small, fontWeight: '600', color: color.signal, flex: 1 },
  locChipRemove: { padding: 2 },
  privacyHint: { ...t.small, color: color.mute, marginTop: 4, fontStyle: 'italic' },

  /* visibility */
  chipRow: { flexDirection: 'row', gap: 8 },
  chipRowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
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
