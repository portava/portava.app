import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, ScrollView,
  ActivityIndicator, Modal, TextInput, Alert,
} from 'react-native';
import { CachedImage } from './CachedImage.tsx';
import * as ImagePicker from 'expo-image-picker';
import { KeyboardSafeView } from './ui/KeyboardSafeView.tsx';
import { SharedVideoPlayer } from './ui/SharedVideoPlayer.tsx';
import { VideoThumbnail } from './ui/VideoThumbnail.tsx';
import { MediaSourceSheet } from './ui/MediaSourceSheet.tsx';
import { MapPin, Lock, Globe, Users, Eye, Camera, X, Pencil, Video } from 'lucide-react-native';
import { Plus } from 'lucide-react-native';
import { VIDEO_MAX_DURATION_SECONDS } from '../constants/mediaLimits.ts';
import type { PassportMemory, MemoryVisibility } from '../services/passportStamps.ts';
import {
  createPassportMemory,
  updatePassportMemory,
} from '../services/passportStamps.ts';
import { uploadMedia } from '../services/media.ts';
import { SaveButton } from './SaveButton.tsx';
import { GlobalPlacePicker } from './selectors/GlobalPlacePicker.tsx';
import { resolvePickedPlace } from '../lib/location/applyPickedPlace.ts';
import type { Place } from '../lib/location/placeTypes.ts';
import { color, space, radius, type as t, avatar, aspect } from '../theme/tokens.ts';

const CATEGORIES = [
  { key: 'city', label: '🏙 City' },
  { key: 'plan', label: '📅 Plan' },
  { key: 'food', label: '🍜 Food' },
  { key: 'adventure', label: '🧗 Adventure' },
  { key: 'culture', label: '🏛 Culture' },
  { key: 'hidden_gem', label: '💎 Gem' },
  { key: 'safe_return', label: '🛡 Safe Return' },
];

function verificationBadge(level: string): string {
  if (level === 'gps') return '📍';
  if (level === 'checkin') return '✅';
  if (level === 'safe_return') return '🛡';
  if (level === 'crew') return '👥';
  if (level === 'admin') return '⭐';
  return '';
}

function visibilityIcon(vis: MemoryVisibility) {
  if (vis === 'public') return <Globe size={12} color={color.success} />;
  if (vis === 'circle_only') return <Users size={12} color={color.signal} />;
  if (vis === 'trip_crew') return <Eye size={12} color={color.signal} />;
  return <Lock size={12} color={color.mute} />;
}

function visibilityLabel(vis: MemoryVisibility): string {
  if (vis === 'public') return 'Public';
  if (vis === 'circle_only') return 'Circle';
  if (vis === 'trip_crew') return 'Crew';
  return 'Private';
}

// ── Edit Memory Modal ─────────────────────────────────────────────────────────

interface EditMemoryPatch {
  title?: string | null;
  description?: string | null;
  city?: string | null;
  country?: string | null;
  photoUrl?: string | null;
}

interface EditMemoryModalProps {
  visible: boolean;
  memory: PassportMemory;
  onClose: () => void;
  onSaved: (memoryId: string, patch: EditMemoryPatch) => void;
}

/**
 * usePlacePicker — the city/country picker wiring, shared by BOTH memory modals.
 *
 * This file renders the same city + country pair twice: once in
 * EditMemoryModal and once in CreateMemoryModal. They are separate components
 * over separate state, which is precisely why a fix applied to one of them
 * looks complete and comes back through the other. The wiring lives here so
 * there is one implementation and both call sites are visibly the same call.
 *
 * Both fields were free text with no autocomplete, persisted verbatim (patch at
 * the edit path, createPassportMemory at the create path), so the same city
 * arrived under as many spellings as people typed.
 *
 * Preferred, not required — a memory from a village no global place index
 * carries must still save — and a pick never overwrites typed text without
 * asking, which is the "QA round 2, bug 6" line drawn in
 * EventComposerSheet.tsx:604 and app/events/create/index.tsx:927.
 */
function usePlacePicker(
  city: string,
  country: string,
  setCity: (v: string) => void,
  setCountry: (v: string) => void,
) {
  const [placePickerOpen, setPlacePickerOpen] = useState(false);

  const handlePlacePicked = useCallback((place: Place) => {
    setPlacePickerOpen(false);
    const { fill, conflict, hasConflict } = resolvePickedPlace(place, { city, country });
    if (fill.city) setCity(fill.city);
    if (fill.country) setCountry(fill.country);
    if (!hasConflict) return;
    Alert.alert(
      'Replace what you typed?',
      `${place.displayName} is linked. Replace the city and country you entered with its own?`,
      [
        { text: 'Keep mine', style: 'cancel' },
        {
          text: 'Use this place',
          onPress: () => {
            if (conflict.city) setCity(conflict.city);
            if (conflict.country) setCountry(conflict.country);
          },
        },
      ],
    );
  }, [city, country, setCity, setCountry]);

  return { placePickerOpen, setPlacePickerOpen, handlePlacePicked };
}

/** The picker entry point rendered above each city/country pair. */
function PickPlaceRow({ onPress, testID }: { onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} style={cm.pickPlaceBtn} onPress={onPress}>
      <MapPin size={13} color={color.signal} />
      <Text style={cm.pickPlaceText}>Search for a place</Text>
    </Pressable>
  );
}

function EditMemoryModal({ visible, memory, onClose, onSaved }: EditMemoryModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const { placePickerOpen, setPlacePickerOpen, handlePlacePicked } =
    usePlacePicker(city, country, setCity, setCountry);

  // Photo state
  // photoUri: newly picked local URI; null means no new pick
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoMime, setPhotoMime] = useState<string>('image/jpeg');
  // removePhoto: user explicitly wants to delete the existing photo
  const [removePhoto, setRemovePhoto] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset all fields whenever the modal opens for a (potentially different) memory.
  React.useEffect(() => {
    if (visible) {
      setTitle(memory.title ?? '');
      setDescription(memory.description ?? '');
      setCity(memory.city ?? '');
      setCountry(memory.country ?? '');
      setPhotoUri(null);
      setPhotoMime('image/jpeg');
      setRemovePhoto(false);
      setUploading(false);
      setSaving(false);
      setUploadError('');
      setError('');
      setPhotoSheetOpen(false);
    }
  }, [visible, memory]);

  function handleEditPhotoResult(asset: ImagePicker.ImagePickerAsset) {
    setUploadError('');
    setPhotoUri(asset.uri);
    setPhotoMime(asset.mimeType ?? 'image/jpeg');
    setRemovePhoto(false);
  }

  function handleRemovePhoto() {
    setPhotoUri(null);
    setRemovePhoto(true);
    setUploadError('');
  }

  function handleUndoRemovePhoto() {
    setRemovePhoto(false);
  }

  const isBusy = uploading || saving;

  // What photo preview to show:
  // 1. Newly picked local image  → photoUri
  // 2. User removed              → nothing (show picker)
  // 3. No change                 → memory.photoUrl
  const previewUri = photoUri ?? (removePhoto ? null : memory.photoUrl);

  async function handleSave() {
    const trimTitle = title.trim();
    if (!trimTitle) { setError('Title is required'); return; }

    setSaving(true);
    setError('');
    setUploadError('');

    // Build the patch — only include fields that actually changed.
    const patch: EditMemoryPatch = {};

    const newTitle = trimTitle !== (memory.title ?? '') ? trimTitle : undefined;
    if (newTitle !== undefined) patch.title = newTitle;

    const trimDesc = description.trim();
    const origDesc = memory.description ?? '';
    if (trimDesc !== origDesc) patch.description = trimDesc || null;

    const trimCity = city.trim();
    const origCity = memory.city ?? '';
    if (trimCity !== origCity) patch.city = trimCity || null;

    const trimCountry = country.trim();
    const origCountry = memory.country ?? '';
    if (trimCountry !== origCountry) patch.country = trimCountry || null;

    // Handle photo changes.
    if (photoUri) {
      setUploading(true);
      const up = await uploadMedia({ uri: photoUri, mimeType: photoMime, type: 'image' });
      setUploading(false);
      if (!up.ok || !up.url) {
        const uploadMsg =
          up.errorKind === 'rate_limited' ? 'Too many uploads — please wait a moment and try again.' :
          up.errorKind === 'invalid_payload' ? "This file couldn't be read — try a different photo." :
          (up.message ?? 'Photo upload failed. You can save without a photo or try again.');
        setUploadError(uploadMsg);
        setSaving(false);
        return;
      }
      patch.photoUrl = up.url;
    } else if (removePhoto) {
      patch.photoUrl = null;
    }

    // If nothing changed, close without a network call.
    if (Object.keys(patch).length === 0) {
      setSaving(false);
      onClose();
      return;
    }

    const res = await updatePassportMemory(memory.id, patch);
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    onSaved(memory.id, patch);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardSafeView>
        <View style={cm.header}>
          <Text style={cm.title}>Edit Memory</Text>
          <Pressable onPress={onClose} hitSlop={8} disabled={isBusy}>
            <X size={22} color={color.ink} />
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={cm.body} keyboardShouldPersistTaps="handled">
          <Text style={cm.label}>Title *</Text>
          <TextInput
            style={cm.input}
            value={title}
            onChangeText={setTitle}
            placeholder="A memorable moment…"
            placeholderTextColor={color.faint}
            maxLength={200}
            editable={!isBusy}
          />

          <Text style={cm.label}>Description</Text>
          <TextInput
            style={[cm.input, cm.multiline]}
            value={description}
            onChangeText={setDescription}
            placeholder="Tell the story…"
            placeholderTextColor={color.faint}
            multiline
            maxLength={1000}
            textAlignVertical="top"
            editable={!isBusy}
          />

          <PickPlaceRow testID="memory-edit-pick-place" onPress={() => setPlacePickerOpen(true)} />

          <View style={cm.row}>
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>City</Text>
              <TextInput
                style={cm.input}
                value={city}
                onChangeText={setCity}
                placeholder="City"
                placeholderTextColor={color.faint}
                maxLength={100}
                editable={!isBusy}
              />
            </View>
            <View style={{ width: space.md }} />
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>Country</Text>
              <TextInput
                style={cm.input}
                value={country}
                onChangeText={setCountry}
                placeholder="Country"
                placeholderTextColor={color.faint}
                maxLength={100}
                editable={!isBusy}
              />
            </View>
          </View>

          <Text style={cm.label}>Photo</Text>
          {previewUri ? (
            <View style={cm.photoPreviewWrap}>
              <Image source={{ uri: previewUri }} style={cm.photoPreview} resizeMode="cover" />
              {uploading && (
                <View style={cm.photoUploadingOverlay}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={cm.photoUploadingText}>Uploading…</Text>
                </View>
              )}
              {!uploading && (
                <Pressable style={cm.photoRemoveBtn} onPress={handleRemovePhoto} hitSlop={8} disabled={isBusy}>
                  <X size={14} color="#fff" />
                </Pressable>
              )}
              <Pressable style={cm.photoChangeBtn} onPress={() => setPhotoSheetOpen(true)} disabled={isBusy}>
                <Text style={cm.photoChangeBtnText}>Change</Text>
              </Pressable>
            </View>
          ) : removePhoto ? (
            <View style={ep.removedState}>
              <Text style={ep.removedText}>Photo will be removed</Text>
              <Pressable onPress={handleUndoRemovePhoto} hitSlop={8}>
                <Text style={ep.undoText}>Undo</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={cm.photoPickerBtn} onPress={() => setPhotoSheetOpen(true)} disabled={isBusy}>
              <Camera size={18} color={color.signal} />
              <Text style={cm.photoPickerText}>Add photo</Text>
            </Pressable>
          )}

          <MediaSourceSheet
            visible={photoSheetOpen}
            onClose={() => setPhotoSheetOpen(false)}
            onResult={handleEditPhotoResult}
            allowsVideo={false}
            title="Add memory photo"
          />

          {uploadError ? (
            <View style={cm.uploadErrorBox}>
              <Text style={cm.uploadErrorText}>{uploadError}</Text>
              <Pressable onPress={() => setUploadError('')} hitSlop={8}>
                <Text style={cm.uploadErrorDismiss}>Dismiss</Text>
              </Pressable>
            </View>
          ) : null}

          {error ? <Text style={cm.error}>{error}</Text> : null}

          <Pressable style={[cm.saveBtn, isBusy && cm.saveBtnDisabled]} onPress={handleSave} disabled={isBusy}>
            {isBusy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={cm.saveBtnText}>Save</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardSafeView>

      {/* Mounted only while open: the picker reads safe-area insets and starts
          its own location work on mount, and neither is worth paying for while
          it is invisible. It also keeps this modal renderable without a
          SafeAreaProvider, which is how its existing tests render it. */}
      {placePickerOpen && (
      <GlobalPlacePicker
        visible={placePickerOpen}
        title="Where was this?"
        placeholder="City, area or country…"
        allowGPS
        usedFor="memory_edit_location"
        onSelect={handlePlacePicked}
        onClose={() => setPlacePickerOpen(false)}
      />
      )}
    </Modal>
  );
}

// ── Memory Card ───────────────────────────────────────────────────────────────

interface MemoryCardProps {
  memory: PassportMemory;
  onVisibilityChange: (id: string, v: MemoryVisibility) => void;
  onEdit: (memory: PassportMemory) => void;
  onViewVideo?: (memory: PassportMemory) => void;
}

function MemoryCard({ memory, onVisibilityChange, onEdit, onViewVideo }: MemoryCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const badge = verificationBadge(memory.verificationLevel);
  const cat = CATEGORIES.find((c) => c.key === memory.category);
  const isVideo = memory.mediaType === 'video';

  return (
    <View style={mc.card}>
      {isVideo && memory.photoUrl ? (
        <Pressable onPress={() => onViewVideo?.(memory)} style={mc.photoWrap}>
          <VideoThumbnail posterUri={memory.photoUrl} style={mc.photo} />
          <View style={mc.videoBadge}>
            <Video size={10} color="#fff" />
            <Text style={mc.videoBadgeText}>Video</Text>
          </View>
        </Pressable>
      ) : memory.photoUrl ? (
        <Pressable onPress={() => onEdit(memory)} style={mc.photoWrap}>
          <CachedImage source={{ uri: memory.photoUrl }} style={mc.photo} resizeMode="cover" />
          <View style={mc.photoEditBadge}>
            <Camera size={13} color="#fff" />
          </View>
        </Pressable>
      ) : (
        <Pressable style={mc.addPhotoBanner} onPress={() => onEdit(memory)}>
          <Camera size={14} color={color.signal} />
          <Text style={mc.addPhotoText}>Add photo</Text>
        </Pressable>
      )}
      <View style={mc.body}>
        <View style={mc.titleRow}>
          <View style={mc.titleMeta}>
            <View style={mc.row}>
              {cat && <Text style={mc.catLabel}>{cat.label}</Text>}
              {badge ? <Text style={mc.badge}>{badge}</Text> : null}
            </View>
            <Text style={mc.title} numberOfLines={2}>{memory.title ?? 'Untitled memory'}</Text>
          </View>
          <Pressable onPress={() => onEdit(memory)} hitSlop={8} style={mc.editBtn}>
            <Pencil size={14} color={color.mute} />
          </Pressable>
        </View>
        {(memory.city || memory.country) && (
          <View style={mc.locationRow}>
            <MapPin size={12} color={color.mute} />
            <Text style={mc.locationText}>
              {[memory.city, memory.country].filter(Boolean).join(', ')}
            </Text>
          </View>
        )}
        {memory.description ? (
          <Text style={mc.desc} numberOfLines={2}>{memory.description}</Text>
        ) : null}
        <View style={mc.footer}>
          <Text style={mc.date}>
            {new Date(memory.earnedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
          </Text>
          <Pressable style={mc.visBadge} onPress={() => setMenuOpen(true)}>
            {visibilityIcon(memory.visibility)}
            <Text style={mc.visText}>{visibilityLabel(memory.visibility)}</Text>
          </Pressable>
          <SaveButton entityType="memory" entityId={memory.id} size={14} />
        </View>
      </View>

      {/* Visibility picker */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={mc.overlay} onPress={() => setMenuOpen(false)}>
          <View style={mc.menuBox}>
            <Text style={mc.menuTitle}>Memory visibility</Text>
            {(['public', 'circle_only', 'trip_crew', 'private'] as MemoryVisibility[]).map((v) => (
              <Pressable
                key={v}
                style={[mc.menuItem, memory.visibility === v && mc.menuItemActive]}
                onPress={() => { onVisibilityChange(memory.id, v); setMenuOpen(false); }}
              >
                {visibilityIcon(v)}
                <Text style={mc.menuItemText}>{visibilityLabel(v)}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ── Create Memory Modal ───────────────────────────────────────────────────────

interface CreateModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (memory: PassportMemory) => void;
}

export function CreateMemoryModal({ visible, onClose, onCreated }: CreateModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const { placePickerOpen, setPlacePickerOpen, handlePlacePicked } =
    usePlacePicker(city, country, setCity, setCountry);
  const [category, setCategory] = useState('city');
  const [visibility, setVisibility] = useState<MemoryVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Media state
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoMime, setPhotoMime] = useState<string>('image/jpeg');
  const [mediaType, setMediaType] = useState<'image' | 'video' | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [mediaSheetOpen, setMediaSheetOpen] = useState(false);

  function handleCreateMediaResult(asset: ImagePicker.ImagePickerAsset) {
    setUploadError('');
    const isVideo = asset.type === 'video' || (asset.mimeType ?? '').startsWith('video/');
    setPhotoUri(asset.uri);
    setPhotoMime(asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'));
    setMediaType(isVideo ? 'video' : 'image');
    setVideoDuration(isVideo && asset.duration ? Math.round(asset.duration / 1000) : null);
  }

  function removeMedia() {
    setPhotoUri(null);
    setMediaType(null);
    setVideoDuration(null);
    setUploadError('');
  }

  function resetForm() {
    setTitle('');
    setDescription('');
    setCity('');
    setCountry('');
    setCategory('city');
    setVisibility('private');
    setPhotoUri(null);
    setPhotoMime('image/jpeg');
    setMediaType(null);
    setVideoDuration(null);
    setUploadError('');
    setError('');
  }

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    setUploadError('');

    let photoUrl: string | undefined;

    // Upload media first if one was selected
    if (photoUri) {
      setUploading(true);
      const up = await uploadMedia(
        { uri: photoUri, mimeType: photoMime, type: mediaType === 'video' ? 'video' : 'image', duration: videoDuration ?? undefined },
        { surface: 'memory' },
      );
      setUploading(false);
      if (!up.ok || !up.url) {
        const uploadMsg =
          up.errorKind === 'rate_limited' ? 'Too many uploads — please wait a moment and try again.' :
          up.errorKind === 'invalid_payload' ? "This file couldn't be read — try a different photo." :
          (up.message ?? 'Upload failed. You can save without media or try again.');
        setUploadError(uploadMsg);
        setSaving(false);
        return;
      }
      photoUrl = up.url;
    }

    const res = await createPassportMemory({
      title: title.trim(),
      description: description.trim() || undefined,
      city: city.trim() || undefined,
      country: country.trim() || undefined,
      category,
      visibility,
      photoUrl,
      mediaType: photoUrl ? (mediaType ?? 'image') : undefined,
    });
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    onCreated(res.data);
    resetForm();
    onClose();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const isBusy = saving || uploading;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <KeyboardSafeView>
        <View style={cm.header}>
          <Text style={cm.title}>New Memory</Text>
          <Pressable onPress={handleClose} hitSlop={8}><X size={22} color={color.ink} /></Pressable>
        </View>
        <View style={cm.body}>
          <Text style={cm.label}>Title *</Text>
          <TextInput style={cm.input} value={title} onChangeText={setTitle} placeholder="A memorable moment…" placeholderTextColor={color.faint} maxLength={200} editable={!isBusy} />

          <Text style={cm.label}>Description</Text>
          <TextInput style={[cm.input, cm.multiline]} value={description} onChangeText={setDescription} placeholder="Tell the story…" placeholderTextColor={color.faint} multiline maxLength={1000} textAlignVertical="top" editable={!isBusy} />

          <PickPlaceRow testID="memory-create-pick-place" onPress={() => setPlacePickerOpen(true)} />

          <View style={cm.row}>
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>City</Text>
              <TextInput style={cm.input} value={city} onChangeText={setCity} placeholder="City" placeholderTextColor={color.faint} maxLength={100} editable={!isBusy} />
            </View>
            <View style={{ width: space.md }} />
            <View style={{ flex: 1 }}>
              <Text style={cm.label}>Country</Text>
              <TextInput style={cm.input} value={country} onChangeText={setCountry} placeholder="Country" placeholderTextColor={color.faint} maxLength={100} editable={!isBusy} />
            </View>
          </View>

          <Text style={cm.label}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={cm.chips}>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c.key}
                style={[cm.chip, category === c.key && cm.chipActive]}
                onPress={() => setCategory(c.key)}
                disabled={isBusy}
              >
                <Text style={[cm.chipText, category === c.key && cm.chipTextActive]}>{c.label}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Text style={cm.label}>Visibility</Text>
          <View style={cm.visRow}>
            {(['public', 'circle_only', 'trip_crew', 'private'] as MemoryVisibility[]).map((v) => (
              <Pressable
                key={v}
                style={[cm.visOption, visibility === v && cm.visOptionActive]}
                onPress={() => setVisibility(v)}
                disabled={isBusy}
              >
                {visibilityIcon(v)}
                <Text style={[cm.visOptionText, visibility === v && cm.visOptionTextActive]}>
                  {visibilityLabel(v)}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Media picker */}
          <Text style={cm.label}>Photo or Video</Text>
          {photoUri ? (
            <View style={cm.photoPreviewWrap}>
              {mediaType === 'video' ? (
                <SharedVideoPlayer uri={photoUri} autoplay muted loop style={cm.photoPreview} />
              ) : (
                <Image source={{ uri: photoUri }} style={cm.photoPreview} resizeMode="cover" />
              )}
              {mediaType === 'video' && videoDuration ? (
                <View style={cm.videoBadge} pointerEvents="none">
                  <Video size={10} color="#fff" />
                  <Text style={cm.videoBadgeText}>Video · {Math.floor(videoDuration / 60)}:{String(videoDuration % 60).padStart(2, '0')}</Text>
                </View>
              ) : null}
              {uploading && (
                <View style={cm.photoUploadingOverlay}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={cm.photoUploadingText}>Uploading…</Text>
                </View>
              )}
              {!uploading && (
                <Pressable style={cm.photoRemoveBtn} onPress={removeMedia} hitSlop={8} disabled={isBusy}>
                  <X size={14} color="#fff" />
                </Pressable>
              )}
              <Pressable style={cm.photoChangeBtn} onPress={() => setMediaSheetOpen(true)} disabled={isBusy}>
                <Text style={cm.photoChangeBtnText}>Change</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={cm.photoPickerBtn} onPress={() => setMediaSheetOpen(true)} disabled={isBusy}>
              <Camera size={18} color={color.signal} />
              <Text style={cm.photoPickerText}>Add photo or video</Text>
            </Pressable>
          )}

          <MediaSourceSheet
            visible={mediaSheetOpen}
            onClose={() => setMediaSheetOpen(false)}
            onResult={handleCreateMediaResult}
            allowsVideo
            videoMaxDuration={VIDEO_MAX_DURATION_SECONDS.memory}
            title="Add photo or video"
          />

          {uploadError ? (
            <View style={cm.uploadErrorBox}>
              <Text style={cm.uploadErrorText}>{uploadError}</Text>
              <Pressable onPress={() => setUploadError('')} hitSlop={8}>
                <Text style={cm.uploadErrorDismiss}>Dismiss</Text>
              </Pressable>
            </View>
          ) : null}

          {error ? <Text style={cm.error}>{error}</Text> : null}
          <Pressable style={[cm.saveBtn, isBusy && cm.saveBtnDisabled]} onPress={handleSave} disabled={isBusy}>
            {isBusy
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={cm.saveBtnText}>Save Memory</Text>}
          </Pressable>
        </View>
      </KeyboardSafeView>

      {/* Mounted only while open: the picker reads safe-area insets and starts
          its own location work on mount, and neither is worth paying for while
          it is invisible. It also keeps this modal renderable without a
          SafeAreaProvider, which is how its existing tests render it. */}
      {placePickerOpen && (
      <GlobalPlacePicker
        visible={placePickerOpen}
        title="Where was this?"
        placeholder="City, area or country…"
        allowGPS
        usedFor="memory_create_location"
        onSelect={handlePlacePicked}
        onClose={() => setPlacePickerOpen(false)}
      />
      )}
    </Modal>
  );
}

// ── Main MemoriesTab ──────────────────────────────────────────────────────────

interface MemoriesTabProps {
  memories: PassportMemory[];
  loading?: boolean;
  onReload: () => void;
  /** When true, renders as a collapsible section (for embedding inside another tab). */
  collapsed?: boolean;
}

export function MemoriesTab({ memories, loading, onReload, collapsed }: MemoriesTabProps) {
  const [localMemories, setLocalMemories] = useState<PassportMemory[]>(memories);
  const [createOpen, setCreateOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editMemory, setEditMemory] = useState<PassportMemory | null>(null);
  const [viewVideoMemory, setViewVideoMemory] = useState<PassportMemory | null>(null);

  React.useEffect(() => {
    setLocalMemories(memories);
  }, [memories]);

  const handleVisibilityChange = useCallback(async (id: string, vis: MemoryVisibility) => {
    setLocalMemories((prev) => prev.map((m) => m.id === id ? { ...m, visibility: vis } : m));
    await updatePassportMemory(id, { visibility: vis });
  }, []);

  const handleCreated = useCallback((memory: PassportMemory) => {
    setLocalMemories((prev) => [memory, ...prev]);
    onReload();
  }, [onReload]);

  const handleEdit = useCallback((memory: PassportMemory) => {
    setEditMemory(memory);
  }, []);

  const handleViewVideo = useCallback((memory: PassportMemory) => {
    setViewVideoMemory(memory);
  }, []);

  const handleEditSaved = useCallback((memoryId: string, patch: EditMemoryPatch) => {
    setLocalMemories((prev) =>
      prev.map((m) => {
        if (m.id !== memoryId) return m;
        return {
          ...m,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.city !== undefined ? { city: patch.city } : {}),
          ...(patch.country !== undefined ? { country: patch.country } : {}),
          ...(patch.photoUrl !== undefined ? { photoUrl: patch.photoUrl } : {}),
        };
      }),
    );
  }, []);

  if (loading && !collapsed) {
    return (
      <View style={mt.center}>
        <ActivityIndicator color={color.signal} />
      </View>
    );
  }

  if (collapsed) {
    return (
      <View style={mt.collapsedWrap}>
        <Pressable style={mt.collapsedHeader} onPress={() => setExpanded((v) => !v)}>
          <Text style={mt.collapsedTitle}>Memories{localMemories.length > 0 ? ` (${localMemories.length})` : ''}</Text>
          <Text style={mt.collapsedChevron}>{expanded ? '▲' : '▼'}</Text>
        </Pressable>
        {expanded && (
          <>
            {localMemories.length === 0 ? (
              <View style={mt.collapsedEmpty}>
                <Text style={mt.emptySub}>No memories yet. Memories are added when you check in or complete a Safe Return.</Text>
                <Pressable style={mt.addBtn} onPress={() => setCreateOpen(true)}>
                  <Plus size={14} color="#fff" />
                  <Text style={mt.addBtnText}>Add memory</Text>
                </Pressable>
              </View>
            ) : (
              <View style={mt.list}>
                {localMemories.slice(0, 5).map((m) => (
                  <MemoryCard key={m.id} memory={m} onVisibilityChange={handleVisibilityChange} onEdit={handleEdit} onViewVideo={handleViewVideo} />
                ))}
                {localMemories.length > 5 && (
                  <Pressable style={mt.addBtnLarge} onPress={() => setCreateOpen(true)}>
                    <Text style={mt.addBtnLargeText}>+{localMemories.length - 5} more memories</Text>
                  </Pressable>
                )}
                <Pressable style={mt.addBtn} onPress={() => setCreateOpen(true)}>
                  <Plus size={14} color="#fff" />
                  <Text style={mt.addBtnText}>Add memory</Text>
                </Pressable>
              </View>
            )}
            <CreateMemoryModal
              visible={createOpen}
              onClose={() => setCreateOpen(false)}
              onCreated={handleCreated}
            />
            {editMemory && (
              <EditMemoryModal
                visible={true}
                memory={editMemory}
                onClose={() => setEditMemory(null)}
                onSaved={handleEditSaved}
              />
            )}
            {viewVideoMemory?.photoUrl && (
              <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setViewVideoMemory(null)}>
                <View style={vv.container}>
                  <View style={vv.header}>
                    <Text style={vv.title} numberOfLines={1}>{viewVideoMemory.title ?? 'Memory'}</Text>
                    <Pressable onPress={() => setViewVideoMemory(null)} hitSlop={8}>
                      <X size={22} color={color.ink} />
                    </Pressable>
                  </View>
                  <SharedVideoPlayer uri={viewVideoMemory.photoUrl} autoplay muted={false} loop={false} style={vv.player} />
                </View>
              </Modal>
            )}
          </>
        )}
      </View>
    );
  }

  return (
    <View style={mt.wrap}>
      <View style={mt.headerRow}>
        <Text style={mt.heading}>Memories</Text>
        <Pressable style={mt.addBtn} onPress={() => setCreateOpen(true)}>
          <Plus size={16} color="#fff" />
          <Text style={mt.addBtnText}>Add</Text>
        </Pressable>
      </View>

      {localMemories.length === 0 ? (
        <View style={mt.empty}>
          <Text style={mt.emptyIcon}>📖</Text>
          <Text style={mt.emptyTitle}>No memories yet</Text>
          <Text style={mt.emptySub}>
            Memories are created when you check in, complete a Safe Return, or visit a new city.
            You can also add them manually.
          </Text>
          <Pressable style={mt.addBtnLarge} onPress={() => setCreateOpen(true)}>
            <Text style={mt.addBtnLargeText}>Add first memory</Text>
          </Pressable>
        </View>
      ) : (
        <View style={mt.list}>
          {localMemories.map((m) => (
            <MemoryCard key={m.id} memory={m} onVisibilityChange={handleVisibilityChange} onEdit={handleEdit} onViewVideo={handleViewVideo} />
          ))}
        </View>
      )}

      <CreateMemoryModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      {editMemory && (
        <EditMemoryModal
          visible={true}
          memory={editMemory}
          onClose={() => setEditMemory(null)}
          onSaved={handleEditSaved}
        />
      )}
      {viewVideoMemory?.photoUrl && (
        <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setViewVideoMemory(null)}>
          <View style={vv.container}>
            <View style={vv.header}>
              <Text style={vv.title} numberOfLines={1}>{viewVideoMemory.title ?? 'Memory'}</Text>
              <Pressable onPress={() => setViewVideoMemory(null)} hitSlop={8}>
                <X size={22} color={color.ink} />
              </Pressable>
            </View>
            <SharedVideoPlayer uri={viewVideoMemory.photoUrl} autoplay muted={false} loop={false} style={vv.player} />
          </View>
        </Modal>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mc = StyleSheet.create({
  card: {
    backgroundColor: color.paperRaised, borderRadius: radius.lg,
    borderWidth: 1, borderColor: color.haze, overflow: 'hidden',
    marginBottom: space.md,
  },
  photoWrap: { position: 'relative' },
  photo: { width: '100%', aspectRatio: aspect.portrait, backgroundColor: color.haze },
  photoEditBadge: {
    position: 'absolute', bottom: 8, right: 8,
    width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2,
    backgroundColor: 'rgba(17,17,15,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  addPhotoBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  addPhotoText: { ...t.small, color: color.signal, fontWeight: '700' },
  body: { padding: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 },
  titleMeta: { flex: 1, marginRight: space.sm },
  editBtn: { padding: 4, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: 4 },
  catLabel: { fontFamily: 'Courier', fontSize: 10, color: color.mute, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  badge: { fontSize: 12 },
  title: { ...t.bodyStrong, color: color.ink, marginBottom: 4 },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 },
  locationText: { ...t.small, color: color.mute },
  desc: { ...t.small, color: color.mute, marginBottom: 8 },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  date: { ...t.small, color: color.mute },
  visBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.haze, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  visText: { fontSize: 11, color: color.mute, fontWeight: '600' },
  saveBtn: { padding: 4 },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end', padding: space.lg },
  menuBox: { backgroundColor: color.paper, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  menuTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.xs },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.sm, borderRadius: radius.md },
  menuItemActive: { backgroundColor: color.haze },
  menuItemText: { ...t.body, color: color.ink },
  videoBadge: {
    position: 'absolute', bottom: 8, left: 8,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(17,17,15,0.65)',
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.pill,
  },
  videoBadgeText: { fontSize: 10, color: '#fff', fontWeight: '700', fontFamily: 'Courier' },
});

const cm = StyleSheet.create({
  pickPlaceBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 },
  pickPlaceText: { ...t.small, color: color.signal, fontWeight: '600' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg, borderBottomWidth: 1, borderColor: color.haze },
  title: { ...t.heading, color: color.ink, fontSize: 18 },
  body: { padding: space.lg, paddingBottom: 48 },
  label: { ...t.small, color: color.mute, fontWeight: '600', marginBottom: 6, marginTop: space.md },
  input: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.md, padding: space.md, ...t.body, color: color.ink, backgroundColor: color.paperRaised },
  multiline: { height: 96, textAlignVertical: 'top' },
  row: { flexDirection: 'row', marginTop: space.sm },
  chips: { gap: space.sm, paddingBottom: space.xs },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  chipText: { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive: { color: color.signal },
  visRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  visOption: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  visOptionActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  visOptionText: { ...t.small, color: color.mute, fontWeight: '600' },
  visOptionTextActive: { color: color.signal },
  // Photo picker
  photoPickerBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1.5, borderColor: color.haze, borderStyle: 'dashed', borderRadius: radius.md, paddingVertical: 14, backgroundColor: color.paperRaised },
  photoPickerText: { ...t.small, color: color.signal, fontWeight: '700' },
  photoPreviewWrap: { position: 'relative', borderRadius: radius.md, overflow: 'hidden' },
  photoPreview: { width: '100%', height: 160, backgroundColor: color.haze },
  photoUploadingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', gap: 8 },
  photoUploadingText: { ...t.small, color: '#fff', fontWeight: '600' },
  photoRemoveBtn: { position: 'absolute', top: 8, right: 8, width: avatar.s28, height: avatar.s28, borderRadius: avatar.s28 / 2, backgroundColor: 'rgba(17,17,15,0.6)', alignItems: 'center', justifyContent: 'center' },
  photoChangeBtn: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(17,17,15,0.6)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  photoChangeBtnText: { ...t.small, color: '#fff', fontWeight: '700' },
  uploadErrorBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: space.md, marginTop: space.sm, gap: space.sm },
  uploadErrorText: { ...t.small, color: color.signal, fontWeight: '600', flex: 1 },
  uploadErrorDismiss: { ...t.small, color: color.signal, fontWeight: '700' },
  error: { ...t.small, color: color.signal, marginTop: space.sm },
  saveBtn: { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md + 2, alignItems: 'center', marginTop: space.xl },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { ...t.bodyStrong, color: '#fff' },
  videoBadge: {
    position: 'absolute', bottom: 8, left: 8,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(17,17,15,0.65)',
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.pill,
  },
  videoBadgeText: { fontSize: 10, color: '#fff', fontWeight: '700', fontFamily: 'Courier' },
});

const ep = StyleSheet.create({
  removedState: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1.5, borderColor: color.haze, borderStyle: 'dashed',
    borderRadius: radius.md, paddingVertical: 14, paddingHorizontal: space.md,
    backgroundColor: color.paperRaised,
  },
  removedText: { ...t.small, color: color.mute, fontWeight: '600' },
  undoText: { ...t.small, color: color.signal, fontWeight: '700' },
});

const mt = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: space.xxxl },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  heading: { ...t.heading, color: color.ink },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: color.signal, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { ...t.small, color: '#fff', fontWeight: '700' },
  empty: { paddingTop: space.xxxl, alignItems: 'center', gap: space.md },
  emptyIcon: { fontSize: 48 },
  emptyTitle: { ...t.heading, color: color.ink },
  emptySub: { ...t.body, color: color.mute, textAlign: 'center', paddingHorizontal: space.lg },
  addBtnLarge: { marginTop: space.sm, borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.md, paddingHorizontal: space.xl },
  addBtnLargeText: { ...t.bodyStrong, color: color.ink },
  list: { paddingBottom: space.xxxl },
  collapsedWrap: {
    marginHorizontal: space.lg, marginTop: space.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, overflow: 'hidden',
  },
  collapsedHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.md, paddingVertical: 12,
  },
  collapsedTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  collapsedChevron: { color: color.mute, fontSize: 11 },
  collapsedEmpty: { padding: space.md, gap: space.md, borderTopWidth: 1, borderTopColor: color.haze },
});

const vv = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md,
    backgroundColor: color.paper,
  },
  title: { ...t.bodyStrong, color: color.ink, flex: 1, marginRight: space.md },
  player: { flex: 1 },
});
