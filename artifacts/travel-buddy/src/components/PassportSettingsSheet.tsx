import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, Modal, ScrollView,
  ActivityIndicator, Switch, KeyboardAvoidingView, Platform,
  Image, StyleSheet, Alert,
} from 'react-native';
import { X, Camera, Check, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import type { OwnProfile } from '../types/models';
import { updateMyProfile, checkUsername, uploadAvatar } from '../services/profile';
import { color, space, radius, type as t } from '../theme/tokens';

const ALL_INTERESTS = [
  { key: 'nightlife', label: 'Nightlife' }, { key: 'food', label: 'Food' },
  { key: 'beach', label: 'Beach' }, { key: 'luxury', label: 'Luxury' },
  { key: 'culture', label: 'Culture' }, { key: 'adventure', label: 'Adventure' },
  { key: 'wellness', label: 'Wellness' }, { key: 'photography', label: 'Photography' },
  { key: 'backpacking', label: 'Backpacking' }, { key: 'shopping', label: 'Shopping' },
  { key: 'business', label: 'Business' }, { key: 'events', label: 'Events' },
];

interface Props {
  visible: boolean;
  profile: OwnProfile;
  onClose: () => void;
  onSaved: (updated: OwnProfile) => void;
}

type Section = 'profile' | 'passport' | 'preferences' | 'safety';

export function PassportSettingsSheet({ visible, profile, onClose, onSaved }: Props) {
  const [section, setSection] = useState<Section>('profile');

  // Form state
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [username, setUsername] = useState(profile.username ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [homeCity, setHomeCity] = useState(profile.homeCity ?? '');
  const [homeCountry, setHomeCountry] = useState(profile.homeCountry ?? '');
  const [interests, setInterests] = useState<string[]>(profile.interests ?? []);
  const [passportPublic, setPassportPublic] = useState(profile.passportVisibility !== 'private');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);

  // Username check
  const [usernameStatus, setUsernameStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable'>('idle');
  const [usernameReason, setUsernameReason] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);

  // Avatar upload
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // Reset on open
  useEffect(() => {
    if (visible) {
      setDisplayName(profile.displayName ?? profile.name ?? '');
      setUsername(profile.username ?? '');
      setBio(profile.bio ?? '');
      setHomeCity(profile.homeCity ?? '');
      setHomeCountry(profile.homeCountry ?? '');
      setInterests(profile.interests ?? []);
      setPassportPublic(profile.passportVisibility !== 'private');
      setAvatarUri(null);
      setSaveError('');
      setSaved(false);
      setUsernameStatus('idle');
    }
  }, [visible, profile]);

  // Debounced username check
  const onUsernameChange = useCallback((val: string) => {
    const v = val.toLowerCase().replace(/[^a-z0-9_.]/g, '');
    setUsername(v);
    setUsernameStatus('idle');
    setUsernameReason('');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!v || v === profile.username) return;
    if (v.length < 3) { setUsernameStatus('unavailable'); setUsernameReason('Too short (min 3)'); return; }
    setUsernameStatus('checking');
    debounceRef.current = setTimeout(async () => {
      const result = await checkUsername(v);
      setUsernameStatus(result.available ? 'available' : 'unavailable');
      setUsernameReason(result.reason ?? '');
    }, 600);
  }, [profile.username]);

  const toggleInterest = (key: string) => {
    setInterests((prev) =>
      prev.includes(key) ? prev.filter((i) => i !== key) : [...prev, key],
    );
  };

  const pickAvatar = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert('Permission required', 'Allow photo library access to change your avatar.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      setAvatarUri(result.assets[0].uri);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');

    let finalAvatarUrl = profile.avatarUrl;

    // Upload avatar if changed
    if (avatarUri) {
      setUploadingAvatar(true);
      const mime = avatarUri.endsWith('.png') ? 'image/png' : avatarUri.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      const uploadRes = await uploadAvatar(avatarUri, mime);
      setUploadingAvatar(false);
      if (!uploadRes.ok || !uploadRes.data) {
        setSaveError(uploadRes.message ?? 'Avatar upload failed');
        setSaving(false);
        return;
      }
      finalAvatarUrl = uploadRes.data.url;
    }

    const patch: Record<string, unknown> = {
      displayName: displayName.trim() || undefined,
      bio: bio.trim() || undefined,
      homeCity: homeCity.trim() || undefined,
      homeCountry: homeCountry.trim() || undefined,
      interests,
      passportVisibility: passportPublic ? 'public' : 'private',
    };
    if (finalAvatarUrl !== profile.avatarUrl) patch.avatarUrl = finalAvatarUrl;
    if (username && username !== profile.username && usernameStatus !== 'unavailable') {
      patch.username = username;
    }

    const res = await updateMyProfile(patch as any);
    setSaving(false);
    if (!res.ok || !res.data) {
      setSaveError(res.message ?? 'Save failed');
      return;
    }
    setSaved(true);
    onSaved(res.data);
    setTimeout(() => { setSaved(false); onClose(); }, 1200);
  };

  const SECTIONS: { key: Section; label: string }[] = [
    { key: 'profile', label: 'Profile' },
    { key: 'passport', label: 'Passport' },
    { key: 'preferences', label: 'Travel Preferences' },
    { key: 'safety', label: 'Safety & Privacy' },
  ];

  const avatarDisplay = avatarUri ?? profile.avatarUrl ?? undefined;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={sh.header}>
          <Text style={sh.title}>Passport Settings</Text>
          <Pressable onPress={onClose} hitSlop={8}><X size={22} color={color.ink} /></Pressable>
        </View>

        {/* Section tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={sh.tabs} contentContainerStyle={sh.tabsContent}>
          {SECTIONS.map((s) => (
            <Pressable key={s.key} style={[sh.tab, section === s.key && sh.tabActive]} onPress={() => setSection(s.key)}>
              <Text style={[sh.tabText, section === s.key && sh.tabTextActive]}>{s.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <ScrollView style={sh.body} contentContainerStyle={sh.bodyContent} keyboardShouldPersistTaps="handled">

          {section === 'profile' && (
            <View style={sh.sectionBody}>
              {/* Avatar */}
              <Pressable style={sh.avatarWrap} onPress={pickAvatar}>
                {avatarDisplay ? (
                  <Image source={{ uri: avatarDisplay }} style={sh.avatar} />
                ) : (
                  <View style={[sh.avatar, sh.avatarEmpty]}>
                    <Text style={sh.avatarEmptyText}>👤</Text>
                  </View>
                )}
                <View style={sh.avatarOverlay}>
                  {uploadingAvatar
                    ? <ActivityIndicator color={color.onInk} size="small" />
                    : <Camera size={18} color={color.onInk} />}
                </View>
                {avatarUri && <Text style={sh.avatarHint}>New photo selected — will upload on save</Text>}
              </Pressable>

              <Field label="Display name">
                <TextInput style={sh.input} value={displayName} onChangeText={setDisplayName} placeholder="Your name" placeholderTextColor={color.faint} maxLength={60} />
              </Field>

              <Field label="Username">
                <View style={sh.usernameRow}>
                  <Text style={sh.atSign}>@</Text>
                  <TextInput
                    style={[sh.input, sh.usernameInput]}
                    value={username}
                    onChangeText={onUsernameChange}
                    placeholder="username"
                    placeholderTextColor={color.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={24}
                  />
                  {usernameStatus === 'checking' && <ActivityIndicator size="small" color={color.mute} />}
                  {usernameStatus === 'available' && <Check size={16} color={color.success} />}
                  {usernameStatus === 'unavailable' && <AlertCircle size={16} color={color.signal} />}
                </View>
                {usernameReason ? (
                  <Text style={[sh.fieldHint, usernameStatus === 'available' ? sh.hintGood : sh.hintBad]}>
                    {usernameReason}
                  </Text>
                ) : (
                  <Text style={sh.fieldHint}>3–24 chars, lowercase letters/numbers/underscores/periods</Text>
                )}
              </Field>

              <Field label="Bio">
                <TextInput
                  style={[sh.input, sh.multiline]}
                  value={bio}
                  onChangeText={setBio}
                  placeholder="Tell travelers about yourself…"
                  placeholderTextColor={color.faint}
                  multiline
                  maxLength={300}
                  textAlignVertical="top"
                />
                <Text style={sh.charCount}>{bio.length}/300</Text>
              </Field>

              <Field label="Home city">
                <TextInput style={sh.input} value={homeCity} onChangeText={setHomeCity} placeholder="City" placeholderTextColor={color.faint} maxLength={100} />
              </Field>

              <Field label="Home country">
                <TextInput style={sh.input} value={homeCountry} onChangeText={setHomeCountry} placeholder="Country" placeholderTextColor={color.faint} maxLength={100} />
              </Field>
            </View>
          )}

          {section === 'passport' && (
            <View style={sh.sectionBody}>
              <View style={sh.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={sh.switchLabel}>Public Passport</Text>
                  <Text style={sh.switchSub}>Anyone with your profile link can view your Passport</Text>
                </View>
                <Switch
                  value={passportPublic}
                  onValueChange={setPassportPublic}
                  trackColor={{ true: color.signal, false: color.haze }}
                  thumbColor={color.paper}
                />
              </View>
              {!passportPublic && (
                <View style={sh.infoBox}>
                  <Text style={sh.infoText}>🔒 Your Passport is private. Only you can see it.</Text>
                </View>
              )}
            </View>
          )}

          {section === 'preferences' && (
            <View style={sh.sectionBody}>
              <Text style={sh.sectionTitle}>Interests</Text>
              <Text style={sh.sectionSub}>Select what you're into — shown on your Passport.</Text>
              <View style={sh.interestGrid}>
                {ALL_INTERESTS.map(({ key, label }) => {
                  const on = interests.includes(key);
                  return (
                    <Pressable key={key} style={[sh.interestChip, on && sh.interestChipOn]} onPress={() => toggleInterest(key)}>
                      <Text style={[sh.interestText, on && sh.interestTextOn]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          )}

          {section === 'safety' && (
            <View style={sh.sectionBody}>
              <View style={sh.infoBox}>
                <Text style={sh.infoLabel}>📍 Location Privacy</Text>
                <Text style={sh.infoText}>Your exact GPS is never stored or shown publicly. Only city-level location appears on your Passport.</Text>
              </View>
              <View style={sh.infoBox}>
                <Text style={sh.infoLabel}>🔖 Verified Stamps</Text>
                <Text style={sh.infoText}>GPS-verified posts earn stamps when your current location matches the tagged place (within ~1 mile). Manual tags do not earn stamps.</Text>
              </View>
            </View>
          )}

        </ScrollView>

        {/* Save bar */}
        <View style={sh.saveBar}>
          {saveError ? <Text style={sh.saveError}>{saveError}</Text> : null}
          <Pressable
            style={[sh.saveBtn, saving && sh.saveBtnBusy, saved && sh.saveBtnDone]}
            onPress={handleSave}
            disabled={saving || saved}
          >
            {saving ? (
              <ActivityIndicator color={color.onInk} size="small" />
            ) : saved ? (
              <><Check size={16} color={color.onInk} /><Text style={sh.saveBtnText}>Saved!</Text></>
            ) : (
              <Text style={sh.saveBtnText}>Save changes</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={sh.field}>
      <Text style={sh.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const sh = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  title: { ...t.heading, color: color.ink },
  tabs: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: color.haze },
  tabsContent: { paddingHorizontal: space.lg, gap: space.sm, alignItems: 'center' },
  tab: { paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.pill },
  tabActive: { backgroundColor: color.ink },
  tabText: { ...t.small, color: color.mute, fontWeight: '600' },
  tabTextActive: { color: color.onInk },
  body: { flex: 1 },
  bodyContent: { paddingBottom: space.xxxl },
  sectionBody: { padding: space.lg, gap: space.lg },
  sectionTitle: { ...t.heading, color: color.ink },
  sectionSub: { ...t.body, color: color.mute, marginTop: -space.sm },

  avatarWrap: { alignItems: 'center', marginBottom: space.sm },
  avatar: { width: 88, height: 88, borderRadius: 44, backgroundColor: color.haze },
  avatarEmpty: { alignItems: 'center', justifyContent: 'center' },
  avatarEmptyText: { fontSize: 36 },
  avatarOverlay: {
    position: 'absolute', bottom: 0, right: 120,
    backgroundColor: color.ink, borderRadius: 16, padding: 6,
    borderWidth: 2, borderColor: color.paper,
  },
  avatarHint: { ...t.small, color: color.signal, marginTop: 4 },

  field: { gap: space.xs },
  fieldLabel: { fontFamily: 'Courier', fontSize: 11, fontWeight: '700', color: color.mute, letterSpacing: 1 },
  fieldHint: { ...t.small, color: color.mute, marginTop: 2 },
  hintGood: { color: color.success },
  hintBad: { color: color.signal },
  charCount: { ...t.small, color: color.faint, textAlign: 'right' },

  input: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: 10,
    ...t.body, color: color.ink, backgroundColor: color.paper,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  usernameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  atSign: { ...t.bodyStrong, color: color.mute, fontSize: 16 },
  usernameInput: { flex: 1 },

  switchRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md,
  },
  switchLabel: { ...t.bodyStrong, color: color.ink },
  switchSub: { ...t.small, color: color.mute, marginTop: 2 },

  infoBox: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs,
  },
  infoLabel: { ...t.bodyStrong, color: color.ink },
  infoText: { ...t.body, color: color.mute, lineHeight: 20 },

  interestGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  interestChip: {
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: 14, paddingVertical: 7,
    backgroundColor: color.paper,
  },
  interestChipOn: { backgroundColor: color.ink, borderColor: color.ink },
  interestText: { ...t.small, color: color.mute, fontWeight: '600' },
  interestTextOn: { color: color.onInk },

  saveBar: {
    borderTopWidth: 1, borderTopColor: color.haze,
    padding: space.lg, gap: space.sm,
  },
  saveBtn: {
    backgroundColor: color.signal, borderRadius: radius.pill,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 8,
  },
  saveBtnBusy: { opacity: 0.7 },
  saveBtnDone: { backgroundColor: color.success },
  saveBtnText: { ...t.bodyStrong, color: color.onInk, fontSize: 16 },
  saveError: { ...t.small, color: color.signal, textAlign: 'center' },
});
