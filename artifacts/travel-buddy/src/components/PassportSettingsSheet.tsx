import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, Pressable, Modal, ScrollView,
  ActivityIndicator, Switch, KeyboardAvoidingView, Platform,
  Image, StyleSheet, Alert,
} from 'react-native';
import { X, Camera, Check, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react-native';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
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

const ALL_LANGUAGES = [
  { key: 'English', label: 'English' }, { key: 'Spanish', label: 'Spanish' },
  { key: 'French', label: 'French' }, { key: 'Mandarin', label: 'Mandarin' },
  { key: 'Arabic', label: 'Arabic' }, { key: 'Portuguese', label: 'Portuguese' },
  { key: 'German', label: 'German' }, { key: 'Italian', label: 'Italian' },
  { key: 'Japanese', label: 'Japanese' }, { key: 'Korean', label: 'Korean' },
  { key: 'Hindi', label: 'Hindi' }, { key: 'Russian', label: 'Russian' },
  { key: 'Turkish', label: 'Turkish' }, { key: 'Dutch', label: 'Dutch' },
  { key: 'Thai', label: 'Thai' }, { key: 'Vietnamese', label: 'Vietnamese' },
  { key: 'Indonesian', label: 'Indonesian' }, { key: 'Polish', label: 'Polish' },
  { key: 'Swedish', label: 'Swedish' }, { key: 'Greek', label: 'Greek' },
];

const ALL_TRAVEL_STYLES = [
  { key: 'Luxury', label: 'Luxury' }, { key: 'Budget', label: 'Budget' },
  { key: 'Adventure', label: 'Adventure' }, { key: 'Relaxed', label: 'Relaxed' },
  { key: 'Nightlife', label: 'Nightlife' }, { key: 'Foodie', label: 'Foodie' },
  { key: 'Culture', label: 'Culture' }, { key: 'Shopping', label: 'Shopping' },
  { key: 'Beach', label: 'Beach' }, { key: 'Business', label: 'Business' },
];

const TRAVEL_PACE_OPTIONS = [
  { key: 'slow', label: 'Slow & steady' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'packed', label: 'Packed schedule' },
];

const BUDGET_OPTIONS = [
  { key: 'budget', label: 'Budget' },
  { key: 'mid-range', label: 'Mid-range' },
  { key: 'luxury', label: 'Luxury' },
  { key: 'flexible', label: 'Flexible' },
];

const GROUP_STYLE_OPTIONS = [
  { key: 'Solo', label: 'Solo' },
  { key: 'With friends', label: 'With friends' },
  { key: 'With partner', label: 'With partner' },
  { key: 'With family', label: 'With family' },
  { key: 'Open to groups', label: 'Open to groups' },
];

const LOOKING_FOR_OPTIONS = [
  { key: 'Travel buddies', label: 'Travel buddies' },
  { key: 'Local recs', label: 'Local recs' },
  { key: 'Events', label: 'Events' },
  { key: 'Group plans', label: 'Group plans' },
  { key: 'Language exchange', label: 'Language exchange' },
  { key: 'Business networking', label: 'Business networking' },
];

const COMFORT_OPTIONS = [
  { key: 'public', label: 'Public meetups' },
  { key: 'small_groups', label: 'Small groups' },
  { key: 'one_on_one', label: 'Open to 1-on-1' },
  { key: 'verified_only', label: 'Verified only' },
];

const AVAILABILITY_OPTIONS = [
  { key: 'Morning', label: 'Morning' },
  { key: 'Afternoon', label: 'Afternoon' },
  { key: 'Evening', label: 'Evening' },
  { key: 'Late night', label: 'Late night' },
];

const PLANNING_STYLE_OPTIONS = [
  { key: 'plan_ahead', label: 'Plan ahead' },
  { key: 'last_minute', label: 'Last minute' },
  { key: 'flexible', label: 'Flexible' },
  { key: 'spontaneous', label: 'Spontaneous' },
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

  // Core profile state
  const [displayName, setDisplayName] = useState(profile.displayName ?? '');
  const [username, setUsername] = useState(profile.username ?? '');
  const [bio, setBio] = useState(profile.bio ?? '');
  const [homeCity, setHomeCity] = useState(profile.homeCity ?? '');
  const [homeCountry, setHomeCountry] = useState(profile.homeCountry ?? '');
  const [passportPublic, setPassportPublic] = useState(profile.passportVisibility !== 'private');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);

  // Preferences state
  const [interests, setInterests] = useState<string[]>(profile.interests ?? []);
  const [spokenLanguages, setSpokenLanguages] = useState<string[]>(profile.spokenLanguages ?? []);
  const [defaultLanguage, setDefaultLanguage] = useState(profile.defaultLanguage ?? '');
  const [travelStyles, setTravelStyles] = useState<string[]>(profile.travelStyles ?? []);
  const [travelPace, setTravelPace] = useState<string | null>(profile.travelPace ?? null);
  const [budgetStyle, setBudgetStyle] = useState<string | null>(profile.budgetStyle ?? null);
  const [travelGroupStyle, setTravelGroupStyle] = useState<string[]>(profile.travelGroupStyle ?? []);
  const [lookingFor, setLookingFor] = useState<string[]>(profile.lookingFor ?? []);
  const [comfortLevel, setComfortLevel] = useState<string | null>(profile.comfortLevel ?? null);
  const [availabilityTags, setAvailabilityTags] = useState<string[]>(profile.availabilityTags ?? []);
  const [planningStyle, setPlanningStyle] = useState<string | null>(profile.planningStyle ?? null);

  // Collapsible preference sections (all open by default)
  const [openSections, setOpenSections] = useState<Set<string>>(
    new Set(['interests', 'languages', 'travelStyle', 'tripPrefs', 'availability'])
  );

  const togglePrefSection = (key: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
      setPassportPublic(profile.passportVisibility !== 'private');
      setAvatarUri(null);
      setSaveError('');
      setSaved(false);
      setUsernameStatus('idle');
      setInterests(profile.interests ?? []);
      setSpokenLanguages(profile.spokenLanguages ?? []);
      setDefaultLanguage(profile.defaultLanguage ?? '');
      setTravelStyles(profile.travelStyles ?? []);
      setTravelPace(profile.travelPace ?? null);
      setBudgetStyle(profile.budgetStyle ?? null);
      setTravelGroupStyle(profile.travelGroupStyle ?? []);
      setLookingFor(profile.lookingFor ?? []);
      setComfortLevel(profile.comfortLevel ?? null);
      setAvailabilityTags(profile.availabilityTags ?? []);
      setPlanningStyle(profile.planningStyle ?? null);
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

  const toggleMulti = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (key: string) => {
    setter((prev) => prev.includes(key) ? prev.filter((i) => i !== key) : [...prev, key]);
  };

  const toggleSingle = (setter: React.Dispatch<React.SetStateAction<string | null>>, current: string | null) => (key: string) => {
    setter(current === key ? null : key);
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
      spokenLanguages,
      defaultLanguage: defaultLanguage.trim() || null,
      travelStyles,
      travelPace: travelPace ?? null,
      budgetStyle: budgetStyle ?? null,
      travelGroupStyle,
      lookingFor,
      comfortLevel: comfortLevel ?? null,
      availabilityTags,
      planningStyle: planningStyle ?? null,
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
    { key: 'preferences', label: 'About Me' },
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

              <PrefSection
                title="Interests"
                subtitle="What you're into — shown on your Passport."
                open={openSections.has('interests')}
                onToggle={() => togglePrefSection('interests')}
              >
                <ChipGrid
                  options={ALL_INTERESTS}
                  selected={interests}
                  onToggle={toggleMulti(setInterests)}
                />
              </PrefSection>

              <PrefSection
                title="Languages"
                subtitle="Languages you speak — helps with local connections."
                open={openSections.has('languages')}
                onToggle={() => togglePrefSection('languages')}
              >
                <ChipGrid
                  options={ALL_LANGUAGES}
                  selected={spokenLanguages}
                  onToggle={toggleMulti(setSpokenLanguages)}
                />
                <View style={{ marginTop: space.sm }}>
                  <Text style={sh.subLabel}>Native / default language</Text>
                  <TextInput
                    style={sh.input}
                    value={defaultLanguage}
                    onChangeText={setDefaultLanguage}
                    placeholder="e.g. English"
                    placeholderTextColor={color.faint}
                    maxLength={50}
                  />
                </View>
              </PrefSection>

              <PrefSection
                title="Travel Style"
                subtitle="How you like to travel."
                open={openSections.has('travelStyle')}
                onToggle={() => togglePrefSection('travelStyle')}
              >
                <Text style={sh.subLabel}>Travel vibes (pick all that apply)</Text>
                <ChipGrid
                  options={ALL_TRAVEL_STYLES}
                  selected={travelStyles}
                  onToggle={toggleMulti(setTravelStyles)}
                />
                <Text style={[sh.subLabel, { marginTop: space.sm }]}>Travel pace</Text>
                <ChipGrid
                  options={TRAVEL_PACE_OPTIONS}
                  selected={travelPace ? [travelPace] : []}
                  onToggle={toggleSingle(setTravelPace, travelPace)}
                />
                <Text style={[sh.subLabel, { marginTop: space.sm }]}>Budget style</Text>
                <ChipGrid
                  options={BUDGET_OPTIONS}
                  selected={budgetStyle ? [budgetStyle] : []}
                  onToggle={toggleSingle(setBudgetStyle, budgetStyle)}
                />
              </PrefSection>

              <PrefSection
                title="Trip Preferences"
                subtitle="Who you travel with and what you're looking for."
                open={openSections.has('tripPrefs')}
                onToggle={() => togglePrefSection('tripPrefs')}
              >
                <Text style={sh.subLabel}>Usually travel</Text>
                <ChipGrid
                  options={GROUP_STYLE_OPTIONS}
                  selected={travelGroupStyle}
                  onToggle={toggleMulti(setTravelGroupStyle)}
                />
                <Text style={[sh.subLabel, { marginTop: space.sm }]}>Looking for</Text>
                <ChipGrid
                  options={LOOKING_FOR_OPTIONS}
                  selected={lookingFor}
                  onToggle={toggleMulti(setLookingFor)}
                />
                <Text style={[sh.subLabel, { marginTop: space.sm }]}>Comfort level with meetups</Text>
                <ChipGrid
                  options={COMFORT_OPTIONS}
                  selected={comfortLevel ? [comfortLevel] : []}
                  onToggle={toggleSingle(setComfortLevel, comfortLevel)}
                />
              </PrefSection>

              <PrefSection
                title="Availability"
                subtitle="When you're typically free and how you plan."
                open={openSections.has('availability')}
                onToggle={() => togglePrefSection('availability')}
              >
                <Text style={sh.subLabel}>Usually available</Text>
                <ChipGrid
                  options={AVAILABILITY_OPTIONS}
                  selected={availabilityTags}
                  onToggle={toggleMulti(setAvailabilityTags)}
                />
                <Text style={[sh.subLabel, { marginTop: space.sm }]}>Planning style</Text>
                <ChipGrid
                  options={PLANNING_STYLE_OPTIONS}
                  selected={planningStyle ? [planningStyle] : []}
                  onToggle={toggleSingle(setPlanningStyle, planningStyle)}
                />
              </PrefSection>

            </View>
          )}

          {section === 'safety' && (
            <View style={sh.sectionBody}>
              <View style={sh.infoBox}>
                <Text style={sh.infoLabel}>📍 Location Privacy</Text>
                <Text style={sh.infoText}>Your exact GPS is never stored or shown publicly. Only city-level location appears on your Passport.</Text>
              </View>
              <Pressable
                style={sh.linkRow}
                onPress={() => { onClose(); setTimeout(() => router.push('/settings/location' as any), 300); }}
              >
                <Text style={sh.linkRowLabel}>Location Settings</Text>
                <Text style={sh.linkRowChevron}>›</Text>
              </Pressable>
              <View style={sh.infoBox}>
                <Text style={sh.infoLabel}>🔖 Verified Stamps</Text>
                <Text style={sh.infoText}>GPS-verified posts earn stamps when your current location matches the tagged place (within ~1 mile). Manual tags do not earn stamps.</Text>
              </View>
              <View style={sh.infoBox}>
                <Text style={sh.infoLabel}>🏅 Stamp &amp; Memory Visibility</Text>
                <Text style={sh.infoText}>
                  New city stamps are public by default. Safe Return stamps are always private.
                  Memories you add manually default to private until you choose otherwise.
                </Text>
                <Text style={sh.infoText}>
                  You can change the visibility of any individual stamp or memory from the Stamps and Memories tabs on your Passport.
                </Text>
              </View>
            </View>
          )}

        </ScrollView>

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

function PrefSection({
  title, subtitle, open, onToggle, children,
}: {
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <View style={sh.prefSection}>
      <Pressable style={sh.prefSectionHeader} onPress={onToggle}>
        <View style={{ flex: 1 }}>
          <Text style={sh.prefSectionTitle}>{title}</Text>
          {!open && <Text style={sh.prefSectionSub} numberOfLines={1}>{subtitle}</Text>}
        </View>
        {open ? <ChevronUp size={18} color={color.mute} /> : <ChevronDown size={18} color={color.mute} />}
      </Pressable>
      {open && (
        <View style={sh.prefSectionBody}>
          <Text style={sh.prefSectionSub}>{subtitle}</Text>
          {children}
        </View>
      )}
    </View>
  );
}

function ChipGrid({
  options,
  selected,
  onToggle,
}: {
  options: { key: string; label: string }[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <View style={sh.chipGrid}>
      {options.map(({ key, label }) => {
        const on = selected.includes(key);
        return (
          <Pressable key={key} style={[sh.chip, on && sh.chipOn]} onPress={() => onToggle(key)}>
            <Text style={[sh.chipText, on && sh.chipTextOn]}>{label}</Text>
          </Pressable>
        );
      })}
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

  linkRow: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    marginBottom: space.xs,
  },
  linkRowLabel: { ...t.body, color: color.signal },
  linkRowChevron: { ...t.bodyStrong, color: color.signal, fontSize: 20 },
  infoBox: {
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze, padding: space.md, gap: space.xs,
  },
  infoLabel: { ...t.bodyStrong, color: color.ink },
  infoText: { ...t.body, color: color.mute, lineHeight: 20 },

  prefSection: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    backgroundColor: color.paperRaised, overflow: 'hidden',
  },
  prefSectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    padding: space.md,
  },
  prefSectionTitle: { ...t.bodyStrong, color: color.ink },
  prefSectionSub: { ...t.small, color: color.mute, marginTop: 2 },
  prefSectionBody: { paddingHorizontal: space.md, paddingBottom: space.md, gap: space.sm },

  subLabel: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.mute, letterSpacing: 0.8, marginBottom: 6 },

  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.paper,
  },
  chipOn: { backgroundColor: color.ink, borderColor: color.ink },
  chipText: { ...t.small, color: color.mute, fontWeight: '600', fontSize: 13 },
  chipTextOn: { color: color.onInk },

  saveBar: { borderTopWidth: 1, borderTopColor: color.haze, padding: space.lg, gap: space.sm },
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
