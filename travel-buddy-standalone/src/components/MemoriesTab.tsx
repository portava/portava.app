import React, { useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, Image, ScrollView,
  ActivityIndicator, Modal, TextInput,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { KeyboardSafeView } from './ui/KeyboardSafeView.tsx';
import { MapPin, Lock, Globe, Users, Eye, Camera, X } from 'lucide-react-native';
import { Plus } from 'lucide-react-native';
import type { PassportMemory, MemoryVisibility } from '../services/passportStamps.ts';
import {
  createPassportMemory,
  updatePassportMemory,
} from '../services/passportStamps.ts';
import { uploadMedia } from '../services/media.ts';
import { SaveButton } from './SaveButton.tsx';
import { color, space, radius, type as t } from '../theme/tokens.ts';

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

// ── Edit Memory Photo Modal ───────────────────────────────────────────────────

interface EditPhotoModalProps {
  visible: boolean;
  memory: PassportMemory;
  onClose: () => void;
  onSaved: (memoryId: string, newPhotoUrl: string | null) => void;
}

function EditMemoryPhotoModal({ visible, memory, onClose, onSaved }: EditPhotoModalProps) {
  // Track whether we're working with a newly picked local URI or the existing remote URL.
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoMime, setPhotoMime] = useState<string>('image/jpeg');
  // null  → user explicitly removed the photo
  // undefined → no change (keep existing)
  const [removePhoto, setRemovePhoto] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [error, setError] = useState('');

  // Reset state whenever the modal opens for a (potentially different) memory.
  React.useEffect(() => {
    if (visible) {
      setPhotoUri(null);
      setPhotoMime('image/jpeg');
      setRemovePhoto(false);
      setUploading(false);
      setSaving(false);
      setUploadError('');
      setError('');
    }
  }, [visible]);

  async function pickPhoto() {
    setUploadError('');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setUploadError('Photo library permission required to add a photo.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setPhotoUri(asset.uri);
    setPhotoMime(asset.mimeType ?? 'image/jpeg');
    setRemovePhoto(false);
  }

  function handleRemove() {
    setPhotoUri(null);
    setRemovePhoto(true);
    setUploadError('');
  }

  function handleUndoRemove() {
    setRemovePhoto(false);
  }

  const isBusy = uploading || saving;

  // Decide what the "current" preview is:
  // 1. Newly picked local image  → photoUri
  // 2. User removed              → nothing (show picker)
  // 3. No change                 → memory.photoUrl
  const previewUri = photoUri ?? (removePhoto ? null : memory.photoUrl);

  async function handleSave() {
    setSaving(true);
    setError('');
    setUploadError('');

    let photoUrl: string | null | undefined;

    if (photoUri) {
      // Upload the newly selected image.
      setUploading(true);
      const up = await uploadMedia({ uri: photoUri, mimeType: photoMime, type: 'image' });
      setUploading(false);
      if (!up.ok || !up.url) {
        setUploadError(up.message ?? 'Photo upload failed. You can save without a photo or try again.');
        setSaving(false);
        return;
      }
      photoUrl = up.url;
    } else if (removePhoto) {
      photoUrl = null;
    } else {
      // Nothing changed — close without a network call.
      setSaving(false);
      onClose();
      return;
    }

    const res = await updatePassportMemory(memory.id, { photoUrl });
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    onSaved(memory.id, photoUrl as string | null);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardSafeView>
        <View style={cm.header}>
          <Text style={cm.title}>Edit Photo</Text>
          <Pressable onPress={onClose} hitSlop={8} disabled={isBusy}>
            <X size={22} color={color.ink} />
          </Pressable>
        </View>
        <View style={cm.body}>
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
                <Pressable style={cm.photoRemoveBtn} onPress={handleRemove} hitSlop={8} disabled={isBusy}>
                  <X size={14} color="#fff" />
                </Pressable>
              )}
              <Pressable style={cm.photoChangeBtn} onPress={pickPhoto} disabled={isBusy}>
                <Text style={cm.photoChangeBtnText}>Change</Text>
              </Pressable>
            </View>
          ) : removePhoto ? (
            <View style={ep.removedState}>
              <Text style={ep.removedText}>Photo will be removed</Text>
              <Pressable onPress={handleUndoRemove} hitSlop={8}>
                <Text style={ep.undoText}>Undo</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={cm.photoPickerBtn} onPress={pickPhoto} disabled={isBusy}>
              <Camera size={18} color={color.signal} />
              <Text style={cm.photoPickerText}>Add photo</Text>
            </Pressable>
          )}

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
        </View>
      </KeyboardSafeView>
    </Modal>
  );
}

// ── Memory Card ───────────────────────────────────────────────────────────────

interface MemoryCardProps {
  memory: PassportMemory;
  onVisibilityChange: (id: string, v: MemoryVisibility) => void;
  onEditPhoto: (memory: PassportMemory) => void;
}

function MemoryCard({ memory, onVisibilityChange, onEditPhoto }: MemoryCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const badge = verificationBadge(memory.verificationLevel);
  const cat = CATEGORIES.find((c) => c.key === memory.category);

  return (
    <View style={mc.card}>
      {memory.photoUrl ? (
        <Pressable onPress={() => onEditPhoto(memory)} style={mc.photoWrap}>
          <Image source={{ uri: memory.photoUrl }} style={mc.photo} resizeMode="cover" />
          <View style={mc.photoEditBadge}>
            <Camera size={13} color="#fff" />
          </View>
        </Pressable>
      ) : (
        <Pressable style={mc.addPhotoBanner} onPress={() => onEditPhoto(memory)}>
          <Camera size={14} color={color.signal} />
          <Text style={mc.addPhotoText}>Add photo</Text>
        </Pressable>
      )}
      <View style={mc.body}>
        <View style={mc.row}>
          {cat && <Text style={mc.catLabel}>{cat.label}</Text>}
          {badge ? <Text style={mc.badge}>{badge}</Text> : null}
        </View>
        <Text style={mc.title} numberOfLines={2}>{memory.title ?? 'Untitled memory'}</Text>
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

function CreateMemoryModal({ visible, onClose, onCreated }: CreateModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [category, setCategory] = useState('city');
  const [visibility, setVisibility] = useState<MemoryVisibility>('private');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Photo state
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoMime, setPhotoMime] = useState<string>('image/jpeg');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

  async function pickPhoto() {
    setUploadError('');
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setUploadError('Photo library permission required to add a photo.');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      allowsEditing: true,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setPhotoUri(asset.uri);
    setPhotoMime(asset.mimeType ?? 'image/jpeg');
  }

  function removePhoto() {
    setPhotoUri(null);
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
    setUploadError('');
    setError('');
  }

  const handleSave = async () => {
    if (!title.trim()) { setError('Title is required'); return; }
    setSaving(true);
    setError('');
    setUploadError('');

    let photoUrl: string | undefined;

    // Upload photo first if one was selected
    if (photoUri) {
      setUploading(true);
      const up = await uploadMedia({ uri: photoUri, mimeType: photoMime, type: 'image' });
      setUploading(false);
      if (!up.ok || !up.url) {
        setUploadError(up.message ?? 'Photo upload failed. You can save without a photo or try again.');
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

          {/* Photo picker */}
          <Text style={cm.label}>Photo</Text>
          {photoUri ? (
            <View style={cm.photoPreviewWrap}>
              <Image source={{ uri: photoUri }} style={cm.photoPreview} resizeMode="cover" />
              {uploading && (
                <View style={cm.photoUploadingOverlay}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={cm.photoUploadingText}>Uploading…</Text>
                </View>
              )}
              {!uploading && (
                <Pressable style={cm.photoRemoveBtn} onPress={removePhoto} hitSlop={8} disabled={isBusy}>
                  <X size={14} color="#fff" />
                </Pressable>
              )}
              <Pressable style={cm.photoChangeBtn} onPress={pickPhoto} disabled={isBusy}>
                <Text style={cm.photoChangeBtnText}>Change</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable style={cm.photoPickerBtn} onPress={pickPhoto} disabled={isBusy}>
              <Camera size={18} color={color.signal} />
              <Text style={cm.photoPickerText}>Add photo</Text>
            </Pressable>
          )}

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
  const [editPhotoMemory, setEditPhotoMemory] = useState<PassportMemory | null>(null);

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

  const handleEditPhoto = useCallback((memory: PassportMemory) => {
    setEditPhotoMemory(memory);
  }, []);

  const handlePhotoSaved = useCallback((memoryId: string, newPhotoUrl: string | null) => {
    setLocalMemories((prev) =>
      prev.map((m) => m.id === memoryId ? { ...m, photoUrl: newPhotoUrl } : m),
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
                  <MemoryCard key={m.id} memory={m} onVisibilityChange={handleVisibilityChange} onEditPhoto={handleEditPhoto} />
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
            {editPhotoMemory && (
              <EditMemoryPhotoModal
                visible={true}
                memory={editPhotoMemory}
                onClose={() => setEditPhotoMemory(null)}
                onSaved={handlePhotoSaved}
              />
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
            <MemoryCard key={m.id} memory={m} onVisibilityChange={handleVisibilityChange} onEditPhoto={handleEditPhoto} />
          ))}
        </View>
      )}

      <CreateMemoryModal
        visible={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
      {editPhotoMemory && (
        <EditMemoryPhotoModal
          visible={true}
          memory={editPhotoMemory}
          onClose={() => setEditPhotoMemory(null)}
          onSaved={handlePhotoSaved}
        />
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
  photo: { width: '100%', aspectRatio: 4 / 5, backgroundColor: color.haze },
  photoEditBadge: {
    position: 'absolute', bottom: 8, right: 8,
    width: 28, height: 28, borderRadius: 14,
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
});

const cm = StyleSheet.create({
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
  photoRemoveBtn: { position: 'absolute', top: 8, right: 8, width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(17,17,15,0.6)', alignItems: 'center', justifyContent: 'center' },
  photoChangeBtn: { position: 'absolute', bottom: 8, right: 8, backgroundColor: 'rgba(17,17,15,0.6)', borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  photoChangeBtnText: { ...t.small, color: '#fff', fontWeight: '700' },
  uploadErrorBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FEF2F2', borderRadius: radius.md, padding: space.md, marginTop: space.sm, gap: space.sm },
  uploadErrorText: { ...t.small, color: color.signal, fontWeight: '600', flex: 1 },
  uploadErrorDismiss: { ...t.small, color: color.signal, fontWeight: '700' },
  error: { ...t.small, color: color.signal, marginTop: space.sm },
  saveBtn: { backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md + 2, alignItems: 'center', marginTop: space.xl },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { ...t.bodyStrong, color: '#fff' },
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
