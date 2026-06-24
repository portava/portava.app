import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, Image,
  ActivityIndicator, Alert, StyleSheet, KeyboardAvoidingView,
  Platform, SafeAreaView, Modal, FlatList,
} from 'react-native';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Camera, ImagePlus, Check, X, AlertCircle, ChevronDown } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { renderAvatarImage, renderCoverImage, MAX_ORIGINAL_BYTES } from '../../src/lib/imageRender';
import { getMyProfile, updateMyProfile, uploadAvatar, uploadCover, checkUsername } from '../../src/services/profile';
import type { OwnProfile } from '../../src/types/models';
import { useLanguagePreference } from '../../src/context/LanguagePreferenceContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

const BIO_MAX = 300;

type Visibility = 'public' | 'followers_only' | 'private';

const VISIBILITY_OPTIONS: { key: Visibility; label: string; desc: string }[] = [
  { key: 'public', label: 'Public', desc: 'Anyone can view your profile' },
  { key: 'followers_only', label: 'Followers only', desc: 'Only people who follow you' },
  { key: 'private', label: 'Private', desc: 'Only you can see your passport' },
];

const LANGUAGE_OPTIONS: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'sv', label: 'Swedish' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'id', label: 'Indonesian' },
  { code: 'tl', label: 'Filipino' },
];

function languageLabel(code: string | null): string {
  if (!code) return 'Same as message settings';
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;
}

interface FormState {
  displayName: string;
  username: string;
  bio: string;
  visibility: Visibility;
  avatarUri: string | null;
  coverUri: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  preferredLanguage: string | null;
  dateOfBirth: string | null;
}

type UsernameStatus = 'idle' | 'checking' | 'available' | 'taken' | 'invalid';

export default function EditProfileScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { preferredLanguage: ctxLanguage, updateLanguage } = useLanguagePreference();

  const [loadingProfile, setLoadingProfile] = useState(true);
  const [profile, setProfile] = useState<OwnProfile | null>(null);

  const [form, setForm] = useState<FormState>({
    displayName: '',
    username: '',
    bio: '',
    visibility: 'public',
    avatarUri: null,
    coverUri: null,
    avatarUrl: null,
    coverUrl: null,
    preferredLanguage: null,
    dateOfBirth: null,
  });

  const [originalForm, setOriginalForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [langPickerVisible, setLangPickerVisible] = useState(false);

  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>('idle');
  const [usernameMessage, setUsernameMessage] = useState<string | null>(null);
  const usernameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  type PhotoPhase = 'idle' | 'optimizing' | 'uploading';
  const [photoPhase, setPhotoPhase] = useState<PhotoPhase>('idle');
  /** Width (px) of the last cover image picked — used to avoid upscaling in renderCoverImage */
  const coverOriginalWidthRef = useRef<number>(1920);

  const isDirty = originalForm !== null && (
    form.displayName !== originalForm.displayName ||
    form.username !== originalForm.username ||
    form.bio !== originalForm.bio ||
    form.visibility !== originalForm.visibility ||
    form.avatarUri !== originalForm.avatarUri ||
    form.coverUri !== originalForm.coverUri ||
    form.preferredLanguage !== originalForm.preferredLanguage ||
    form.dateOfBirth !== originalForm.dateOfBirth
  );

  useEffect(() => {
    let alive = true;
    getMyProfile().then((res) => {
      if (!alive) return;
      if (res.ok && res.data) {
        const p = res.data as OwnProfile;
        setProfile(p);
        // Prefer context value (already reflects any language-settings changes); fall back to profile
        const langFromCtx = ctxLanguage !== undefined ? ctxLanguage : (p.preferredLanguage ?? null);
        const initial: FormState = {
          displayName: p.displayName ?? p.name ?? '',
          username: p.username ?? '',
          bio: p.bio ?? '',
          visibility: p.passportVisibility ?? 'public',
          avatarUri: null,
          coverUri: null,
          avatarUrl: p.avatarUrl,
          coverUrl: p.coverPhotoUrl,
          preferredLanguage: langFromCtx,
          dateOfBirth: p.dateOfBirth ?? null,
        };
        setForm(initial);
        setOriginalForm(initial);
      }
      setLoadingProfile(false);
    }).catch(() => {
      if (alive) setLoadingProfile(false);
    });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync preferred language from context whenever the screen gains focus (e.g. after
  // the user changed it in Settings) — but only when the field hasn't been modified locally.
  const originalFormRef = useRef<FormState | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (ctxLanguage === undefined || ctxLanguage === null) return;
      setForm((prev) => {
        const isClean = prev.preferredLanguage === (originalFormRef.current?.preferredLanguage ?? null);
        if (isClean && prev.preferredLanguage !== ctxLanguage) {
          return { ...prev, preferredLanguage: ctxLanguage };
        }
        return prev;
      });
      setOriginalForm((prev) => {
        if (!prev) return prev;
        originalFormRef.current = { ...prev, preferredLanguage: ctxLanguage };
        return originalFormRef.current;
      });
    }, [ctxLanguage]),
  );

  // Keep originalFormRef in sync whenever originalForm changes
  useEffect(() => {
    originalFormRef.current = originalForm;
  }, [originalForm]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      if (!isDirty) return;
      e.preventDefault();
      Alert.alert(
        'Discard changes?',
        'You have unsaved changes. Are you sure you want to go back?',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ],
      );
    });
    return unsubscribe;
  }, [navigation, isDirty]);

  const handleUsernameChange = useCallback((text: string) => {
    const cleaned = text.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    setForm((f) => ({ ...f, username: cleaned }));
    setUsernameStatus('idle');
    setUsernameMessage(null);

    if (usernameTimer.current) clearTimeout(usernameTimer.current);
    if (!cleaned || cleaned === (profile?.username ?? '')) return;

    if (cleaned.length < 3) {
      setUsernameStatus('invalid');
      setUsernameMessage('At least 3 characters required');
      return;
    }

    setUsernameStatus('checking');
    usernameTimer.current = setTimeout(async () => {
      const res = await checkUsername(cleaned);
      if (res.available) {
        setUsernameStatus('available');
        setUsernameMessage(null);
      } else {
        setUsernameStatus('taken');
        setUsernameMessage(res.reason ?? 'Username not available');
      }
    }, 500);
  }, [profile?.username]);

  const pickAvatar = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to update your profile photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      // No quality cap here — renderAvatarImage handles compression
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      if (asset.fileSize != null && asset.fileSize > MAX_ORIGINAL_BYTES) {
        Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
        return;
      }
      setForm((f) => ({ ...f, avatarUri: asset.uri }));
    }
  }, []);

  const pickCover = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission needed', 'Allow photo access to update your cover photo.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [16, 9],
      // No quality cap here — renderCoverImage handles compression
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      if (asset.fileSize != null && asset.fileSize > MAX_ORIGINAL_BYTES) {
        Alert.alert('Image too large', 'This image is very large. Choose a file under 25 MB or use a smaller photo.');
        return;
      }
      // Store original width so renderCoverImage knows whether to downscale
      coverOriginalWidthRef.current = asset.width ?? 1920;
      setForm((f) => ({ ...f, coverUri: asset.uri }));
    }
  }, []);

  const canSave = usernameStatus !== 'taken' && usernameStatus !== 'invalid' && usernameStatus !== 'checking';

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);

    const patch: Parameters<typeof updateMyProfile>[0] = {};

    if (form.displayName !== (originalForm?.displayName ?? '')) {
      patch.displayName = form.displayName.trim();
    }
    if (form.username !== (originalForm?.username ?? '') && form.username) {
      patch.username = form.username;
    }
    if (form.bio !== (originalForm?.bio ?? '')) {
      patch.bio = form.bio;
    }
    if (form.visibility !== (originalForm?.visibility ?? 'public')) {
      patch.passportVisibility = form.visibility;
    }
    // preferredLanguage is saved separately via the canonical language-settings endpoint below

    if (form.avatarUri) {
      // Step 1 — compress to 512×512 JPEG
      setPhotoPhase('optimizing');
      const rendered = await renderAvatarImage(form.avatarUri);
      // Step 2 — upload compressed variant
      setPhotoPhase('uploading');
      const upRes = await uploadAvatar(rendered.uri, rendered.mimeType);
      setPhotoPhase('idle');
      if (!upRes.ok) {
        setSaveError(upRes.message ?? 'Photo upload failed. Try again.');
        setSaving(false);
        return;
      }
      patch.avatarUrl = upRes.data!.url;
    }

    if (form.coverUri) {
      // Step 1 — compress to max 1200px JPEG
      setPhotoPhase('optimizing');
      const rendered = await renderCoverImage(form.coverUri, coverOriginalWidthRef.current);
      // Step 2 — upload compressed variant
      setPhotoPhase('uploading');
      const upRes = await uploadCover(rendered.uri, rendered.mimeType);
      setPhotoPhase('idle');
      if (!upRes.ok) {
        setSaveError(upRes.message ?? 'Photo upload failed. Try again.');
        setSaving(false);
        return;
      }
      patch.coverUrl = upRes.data!.url;
    }

    if (form.dateOfBirth !== (originalForm?.dateOfBirth ?? null)) {
      const dob = form.dateOfBirth;
      if (dob !== null) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
          setSaveError('Date of birth must be in YYYY-MM-DD format');
          setSaving(false);
          return;
        }
        const d = new Date(dob);
        if (isNaN(d.getTime()) || d >= new Date()) {
          setSaveError('Date of birth must be a valid past date');
          setSaving(false);
          return;
        }
      }
      (patch as any).dateOfBirth = dob;
    }

    const langChanged = form.preferredLanguage !== (originalForm?.preferredLanguage ?? null);

    if (Object.keys(patch).length === 0 && !langChanged) {
      setSaving(false);
      router.back();
      return;
    }

    // Save language via canonical endpoint; save other profile fields via updateMyProfile
    const [langRes, profileRes] = await Promise.all([
      langChanged ? updateLanguage(form.preferredLanguage) : Promise.resolve({ ok: true as const }),
      Object.keys(patch).length > 0 ? updateMyProfile(patch) : Promise.resolve({ ok: true as const }),
    ]);
    setSaving(false);

    if (!langRes.ok) {
      setSaveError(langRes.message ?? 'Failed to save language preference');
      return;
    }
    if (!profileRes.ok) {
      if ((profileRes as any).errorKind === 'invalid_payload' && (profileRes as any).message?.toLowerCase().includes('username')) {
        setUsernameStatus('taken');
        setUsernameMessage((profileRes as any).message ?? 'Username not available');
      } else {
        setSaveError((profileRes as any).message ?? 'Failed to save profile');
      }
      return;
    }

    setOriginalForm(form);
    router.back();
  }, [form, originalForm, canSave, updateLanguage]);

  if (loadingProfile) {
    return (
      <SafeAreaView style={styles.loadingWrap}>
        <ActivityIndicator color={color.signal} size="large" />
      </SafeAreaView>
    );
  }

  const avatarSource = form.avatarUri ?? form.avatarUrl ?? null;
  const coverSource = form.coverUri ?? form.coverUrl ?? null;

  return (
    <View style={{ flex: 1, backgroundColor: color.paper }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={{ flex: 1 }}>
          {/* Header */}
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle}>Edit Profile</Text>
            <Pressable
              style={[styles.saveBtn, (!canSave || saving) && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={!canSave || saving}
            >
              {saving && photoPhase === 'idle' ? (
                <ActivityIndicator size="small" color={color.onInk} />
              ) : photoPhase === 'optimizing' ? (
                <Text style={styles.saveBtnText}>Optimizing…</Text>
              ) : photoPhase === 'uploading' ? (
                <Text style={styles.saveBtnText}>Uploading…</Text>
              ) : (
                <Text style={styles.saveBtnText}>Save</Text>
              )}
            </Pressable>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: insets.bottom + space.xxxl }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Cover photo */}
            <Pressable style={styles.coverWrap} onPress={pickCover}>
              {coverSource ? (
                <Image source={{ uri: coverSource }} style={styles.coverImage} />
              ) : (
                <View style={styles.coverPlaceholder}>
                  <ImagePlus size={28} color={color.faint} />
                  <Text style={styles.coverPlaceholderText}>Add cover photo</Text>
                </View>
              )}
              <View style={styles.coverEditBadge}>
                <Camera size={16} color={color.onInk} />
              </View>
            </Pressable>

            {/* Avatar */}
            <View style={styles.avatarRow}>
              <Pressable style={styles.avatarWrap} onPress={pickAvatar}>
                {avatarSource ? (
                  <Image source={{ uri: avatarSource }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatarEmpty}>
                    <Text style={{ fontSize: 32 }}>👤</Text>
                  </View>
                )}
                <View style={styles.avatarEditBadge}>
                  <Camera size={14} color={color.onInk} />
                </View>
              </Pressable>
              <Text style={styles.avatarHint}>Tap to change photo</Text>
            </View>

            {/* Error banner */}
            {saveError && (
              <View style={styles.errorBanner}>
                <AlertCircle size={16} color={color.signal} />
                <Text style={styles.errorBannerText}>{saveError}</Text>
              </View>
            )}

            {/* Form fields */}
            <View style={styles.form}>
              {/* Display name */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Display Name</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={form.displayName}
                  onChangeText={(text) => setForm((f) => ({ ...f, displayName: text }))}
                  placeholder="Your name"
                  placeholderTextColor={color.faint}
                  maxLength={60}
                  autoCapitalize="words"
                  returnKeyType="next"
                />
              </View>

              {/* Username */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Username</Text>
                <View style={styles.usernameRow}>
                  <View style={[styles.fieldInputWrap, styles.usernameInputWrap]}>
                    <Text style={styles.atSign}>@</Text>
                    <TextInput
                      style={[styles.fieldInput, styles.usernameInput]}
                      value={form.username}
                      onChangeText={handleUsernameChange}
                      placeholder="username"
                      placeholderTextColor={color.faint}
                      maxLength={24}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="next"
                    />
                    {usernameStatus === 'checking' && (
                      <ActivityIndicator size="small" color={color.faint} />
                    )}
                    {usernameStatus === 'available' && (
                      <Check size={16} color={color.success} />
                    )}
                    {(usernameStatus === 'taken' || usernameStatus === 'invalid') && (
                      <X size={16} color={color.signal} />
                    )}
                  </View>
                </View>
                {usernameMessage && (
                  <Text style={[styles.fieldHint, usernameStatus === 'available' ? styles.hintSuccess : styles.hintError]}>
                    {usernameMessage}
                  </Text>
                )}
                <Text style={styles.fieldHint}>3-24 chars, letters/numbers/underscores/periods</Text>
              </View>

              {/* Bio */}
              <View style={styles.field}>
                <View style={styles.fieldLabelRow}>
                  <Text style={styles.fieldLabel}>Bio</Text>
                  <Text style={[styles.charCount, form.bio.length > BIO_MAX * 0.9 && styles.charCountWarn]}>
                    {form.bio.length}/{BIO_MAX}
                  </Text>
                </View>
                <TextInput
                  style={[styles.fieldInput, styles.bioInput]}
                  value={form.bio}
                  onChangeText={(text) => setForm((f) => ({ ...f, bio: text.slice(0, BIO_MAX) }))}
                  placeholder="Tell travelers about yourself…"
                  placeholderTextColor={color.faint}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  maxLength={BIO_MAX}
                  returnKeyType="default"
                />
              </View>

              {/* Date of Birth */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Date of Birth</Text>
                <TextInput
                  style={styles.fieldInput}
                  value={form.dateOfBirth ?? ''}
                  onChangeText={(text) => setForm((f) => ({ ...f, dateOfBirth: text || null }))}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={color.faint}
                  maxLength={10}
                  keyboardType="numeric"
                  returnKeyType="next"
                />
                <Text style={styles.fieldHint}>
                  Used to enforce age limits on meetups and circles. Not shown publicly.
                </Text>
              </View>

              {/* Visibility */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Profile Visibility</Text>
                <View style={styles.visibilityOptions}>
                  {VISIBILITY_OPTIONS.map((opt) => (
                    <Pressable
                      key={opt.key}
                      style={[styles.visibilityOption, form.visibility === opt.key && styles.visibilityOptionActive]}
                      onPress={() => setForm((f) => ({ ...f, visibility: opt.key }))}
                    >
                      <View style={styles.visibilityRadio}>
                        {form.visibility === opt.key && <View style={styles.visibilityRadioDot} />}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.visibilityLabel, form.visibility === opt.key && styles.visibilityLabelActive]}>
                          {opt.label}
                        </Text>
                        <Text style={styles.visibilityDesc}>{opt.desc}</Text>
                      </View>
                    </Pressable>
                  ))}
                </View>
              </View>

              {/* Preferred translation language */}
              <View style={styles.field}>
                <Text style={styles.fieldLabel}>Preferred Translation Language</Text>
                <Pressable
                  style={styles.langPickerRow}
                  onPress={() => setLangPickerVisible(true)}
                >
                  <Text style={[styles.langPickerValue, !form.preferredLanguage && styles.langPickerPlaceholder]}>
                    {languageLabel(form.preferredLanguage)}
                  </Text>
                  <ChevronDown size={18} color={color.mute} />
                </Pressable>
                <Text style={styles.fieldHint}>
                  Messages from others will be translated into this language. Leave unset to use your message language preference.
                </Text>
              </View>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      {/* Language picker modal */}
      <Modal
        visible={langPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setLangPickerVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setLangPickerVisible(false)}>
          <Pressable style={[styles.modalSheet, { paddingBottom: insets.bottom + space.md }]} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Translation Language</Text>

            <FlatList
              data={[{ code: null, label: 'Same as message settings' }, ...LANGUAGE_OPTIONS] as { code: string | null; label: string }[]}
              keyExtractor={(item) => item.code ?? '__none'}
              style={styles.langList}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                const selected = form.preferredLanguage === item.code;
                return (
                  <Pressable
                    style={[styles.langItem, selected && styles.langItemSelected]}
                    onPress={() => {
                      setForm((f) => ({ ...f, preferredLanguage: item.code }));
                      setLangPickerVisible(false);
                    }}
                  >
                    <Text style={[styles.langItemText, selected && styles.langItemTextSelected]}>
                      {item.label}
                    </Text>
                    {selected && <Check size={16} color={color.ink} />}
                  </Pressable>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paper,
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  headerBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', flex: 1, textAlign: 'center' },
  saveBtn: {
    backgroundColor: color.ink,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 8,
    minWidth: 60,
    alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: color.haze },
  saveBtnText: { ...t.small, color: color.onInk, fontWeight: '700' },

  coverWrap: {
    height: 180,
    backgroundColor: color.haze,
    position: 'relative',
    overflow: 'hidden',
  },
  coverImage: { width: '100%', height: '100%' },
  coverPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  coverPlaceholderText: { ...t.small, color: color.faint, fontWeight: '600' },
  coverEditBadge: {
    position: 'absolute',
    bottom: space.md,
    right: space.md,
    backgroundColor: 'rgba(17,17,15,0.65)',
    borderRadius: radius.pill,
    padding: 8,
    ...shadow.card,
  },

  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.md,
  },
  avatarWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: color.paper,
    backgroundColor: color.haze,
    overflow: 'visible',
    ...shadow.card,
  },
  avatar: { width: 74, height: 74, borderRadius: 37 },
  avatarEmpty: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0EDE8',
  },
  avatarEditBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: color.ink,
    borderRadius: 12,
    padding: 5,
    borderWidth: 2,
    borderColor: color.paper,
  },
  avatarHint: { ...t.small, color: color.mute, fontWeight: '500' },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    backgroundColor: '#FFF1EF',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#FFCCBB',
    padding: space.md,
  },
  errorBannerText: { ...t.small, color: color.signal, flex: 1 },

  form: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.xl,
  },
  field: { gap: space.sm },
  fieldLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldLabel: { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  fieldInput: {
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  fieldInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.xs,
  },
  usernameRow: {},
  usernameInputWrap: { flex: 1 },
  atSign: { ...t.body, color: color.mute, fontWeight: '600' },
  usernameInput: {
    flex: 1,
    backgroundColor: 'transparent',
    borderWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  bioInput: {
    minHeight: 100,
    paddingTop: space.md,
  },
  charCount: { ...t.stamp, color: color.faint },
  charCountWarn: { color: color.warn },
  fieldHint: { ...t.stamp, color: color.faint, fontSize: 11 },
  hintSuccess: { color: color.success },
  hintError: { color: color.signal },

  visibilityOptions: {
    gap: space.sm,
  },
  visibilityOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
  },
  visibilityOptionActive: {
    borderColor: color.ink,
    backgroundColor: color.paper,
  },
  visibilityRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.paperRaised,
  },
  visibilityRadioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: color.ink,
  },
  visibilityLabel: { ...t.bodyStrong, color: color.mute, fontWeight: '600' },
  visibilityLabelActive: { color: color.ink },
  visibilityDesc: { ...t.stamp, color: color.faint, marginTop: 2 },

  langPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  langPickerValue: { ...t.body, color: color.ink, flex: 1 },
  langPickerPlaceholder: { color: color.faint },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.sm,
    paddingHorizontal: space.lg,
    maxHeight: '70%',
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.haze,
    alignSelf: 'center',
    marginBottom: space.md,
  },
  modalTitle: { ...t.bodyStrong, color: color.ink, fontWeight: '700', marginBottom: space.md },
  langList: { flexGrow: 0 },
  langItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  langItemSelected: {},
  langItemText: { ...t.body, color: color.ink },
  langItemTextSelected: { fontWeight: '700' },
});
