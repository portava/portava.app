import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, TextInput, Pressable, StyleSheet,
  Alert, Switch, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardSafeScrollView } from '../../../src/components/ui/KeyboardSafeView';
import { ArrowLeft, ArrowRight, Check, Plus, X, BookOpen, Search, AlertCircle, CheckCircle, Circle } from 'lucide-react-native';
import { GlobalPlacePicker } from '../../../src/components/selectors/GlobalPlacePicker';
import { TravelButton, TravelCard, TravelChip } from '../../../src/components/primitives';
import { Stamp } from '../../../src/components/ui';
import { MediaPickerButton } from '../../../src/components/ui/MediaPickerButton';
import { MediaAttachmentTray } from '../../../src/components/ui/MediaAttachmentTray';
import { color, space, radius, type as t, icon, aspect, avatar } from '../../../src/theme/tokens';
import { useMediaComposer } from '../../../src/hooks/useMediaComposer';
import * as rentABuddy from '../../../src/services/rentABuddy';
import type { BuddyCategory, TrainingItem, ChecklistItem, ProfileSubmitResult } from '../../../src/services/rentABuddy';
import { bookingErrorCopy } from '../../../src/services/rentABuddyBookingErrors';

const TOTAL_STEPS = 7;

const ALL_CATEGORIES: { value: BuddyCategory; label: string; emoji: string }[] = [
  { value: 'arrival', label: 'Arrival Support', emoji: '✈️' },
  { value: 'city', label: 'City Tours', emoji: '🗺️' },
  { value: 'nightlife', label: 'Nightlife', emoji: '🌙' },
  { value: 'food', label: 'Food & Markets', emoji: '🍜' },
  { value: 'content', label: 'Content & Photo', emoji: '📸' },
  { value: 'nature', label: 'Nature & Adventure', emoji: '🌿' },
  { value: 'culture', label: 'Culture & Arts', emoji: '🎭' },
  { value: 'shopping', label: 'Shopping', emoji: '🛍️' },
  { value: 'language', label: 'Language Help', emoji: '💬' },
  { value: 'wellness', label: 'Wellness', emoji: '🧘' },
  { value: 'adventure', label: 'Adventure', emoji: '🏔️' },
  { value: 'other', label: 'Other', emoji: '✨' },
];

const FLUENCY = ['Conversational', 'Proficient', 'Native / Fluent'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME_BLOCKS = ['Morning\n6am–12pm', 'Afternoon\n12pm–6pm', 'Evening\n6pm–10pm', 'Late Night\n10pm–2am'];

function ProgressBar({ step }: { step: number }) {
  return (
    <View style={pb.wrap}>
      {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
        <View
          key={i}
          style={[pb.seg, i < step ? pb.done : i === step - 1 ? pb.active : pb.todo]}
        />
      ))}
    </View>
  );
}

function StepHeader({ step, title, sub }: { step: number; title: string; sub?: string }) {
  return (
    <View style={sh.wrap}>
      <Text style={sh.step}>STEP {step} OF {TOTAL_STEPS}</Text>
      <Text style={sh.title}>{title}</Text>
      {sub ? <Text style={sh.sub}>{sub}</Text> : null}
    </View>
  );
}

function FieldLabel({ label, optional }: { label: string; optional?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.xs }}>
      <Text style={fl.label}>{label}</Text>
      {optional && <Text style={fl.opt}>(optional)</Text>}
    </View>
  );
}

function Field({
  label, value, onChangeText, placeholder, optional, multiline, keyboardType,
}: {
  label: string; value: string; onChangeText: (v: string) => void;
  placeholder?: string; optional?: boolean; multiline?: boolean; keyboardType?: any;
}) {
  return (
    <View style={{ marginBottom: space.lg }}>
      <FieldLabel label={label} optional={optional} />
      <TextInput
        style={[fi.input, multiline && fi.multiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder ?? ''}
        placeholderTextColor={color.haze}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize="none"
      />
    </View>
  );
}

export default function ApplyToBeBuddy() {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const [submitted, setSubmitted] = useState(false);

  // Training checklist gate — only shown when user already has an existing application.
  // New users (no application yet) skip the gate; training is enforced at admin approval.
  const [trainingLoading, setTrainingLoading] = useState(true);
  const [trainingComplete, setTrainingComplete] = useState(false);
  const [trainingItems, setTrainingItems] = useState<TrainingItem[]>([]);
  const [checkingItem, setCheckingItem] = useState<string | null>(null);
  const checkingLockRef = useRef(new Set<string>());
  const [showTraining, setShowTraining] = useState(false);

  // Profile checklist gate — shown when user has an existing buddy profile with missing fields.
  // Blocks re-submission until the backend reports allComplete.
  const [profileChecklistItems, setProfileChecklistItems] = useState<ChecklistItem[]>([]);
  const [profileComplete, setProfileComplete] = useState(false);
  const [showProfileChecklist, setShowProfileChecklist] = useState(false);

  useEffect(() => {
    (async () => {
      const [appRes, trainRes, profileRes, buddyProfileRes] = await Promise.all([
        rentABuddy.getMyApplication(),
        rentABuddy.getTrainingChecklist(),
        rentABuddy.getProfileChecklist(),
        rentABuddy.getMyBuddyProfile(),
      ]);
      const hasExistingApplication = appRes.ok && !!appRes.data?.application;

      // Pre-fill photo tray with any previously submitted gallery photos so the
      // user doesn't have to re-upload them when re-entering the wizard.
      if (buddyProfileRes.ok && buddyProfileRes.data?.profile?.galleryUrls?.length) {
        photoComposer.preSeedFromUrls(buddyProfileRes.data.profile.galleryUrls);
      }

      // Pre-fill text fields from existing buddy profile or application so a
      // re-applicant doesn't have to retype everything from scratch.
      {
        const profile = buddyProfileRes.ok ? buddyProfileRes.data?.profile : null;
        const application = appRes.ok ? appRes.data?.application : null;

        const prefillDisplayName = profile?.displayName || application?.displayName || '';
        if (prefillDisplayName) setDisplayName(prefillDisplayName);

        const prefillBio = profile?.bio || application?.bio || '';
        if (prefillBio) setBio(prefillBio);

        const prefillCity = profile?.city || application?.city || '';
        if (prefillCity) setCity(prefillCity);

        const prefillCountry = profile?.country || application?.country || '';
        if (prefillCountry) setCountry(prefillCountry);

        const prefillCategories =
          (profile?.categories?.length ? profile.categories : application?.categories) ?? [];
        if (prefillCategories.length) setCategories(prefillCategories as BuddyCategory[]);

        const prefillRate = profile?.hourlyRateUsd ?? application?.hourlyRateUsd ?? null;
        if (prefillRate !== null) setHourlyRate(String(prefillRate));

        const prefillMotivation = application?.motivation || '';
        if (prefillMotivation) setMotivation(prefillMotivation);

        const prefillLangs =
          (profile?.languages?.length ? profile.languages : application?.languages) ?? [];
        if (prefillLangs.length) {
          setLanguages(prefillLangs.map((lang) => ({ lang, fluency: 'Proficient' })));
        }

        // Pre-fill availability grid from any previously submitted blocks.
        // Stored as [{ day, block }]; reconstruct the day → block → boolean map.
        const prefillAvailabilityBlocks = (application?.availability ?? []) as Array<Record<string, unknown>>;
        if (prefillAvailabilityBlocks.length) {
          const grid: Record<string, Record<string, boolean>> = {};
          for (const slot of prefillAvailabilityBlocks) {
            const day = slot.day as string | undefined;
            const block = slot.block as string | undefined;
            if (day && block) {
              if (!grid[day]) grid[day] = {};
              grid[day][block] = true;
            }
          }
          if (Object.keys(grid).length) setAvailability(grid);
        }

        // Pre-fill meetup zones from any previously submitted strings.
        const prefillZones = application?.zones ?? [];
        if (prefillZones.length) setZones(prefillZones);
      }

      // Profile checklist: if the user has a profile, show its completion state
      if (profileRes.ok && profileRes.data) {
        setProfileChecklistItems(profileRes.data.checklist);
        setProfileComplete(profileRes.data.allComplete);
        if (!profileRes.data.allComplete) {
          // Show profile checklist gate so the user sees what to complete before re-submitting
          setShowProfileChecklist(true);
          setTrainingLoading(false);
          return;
        }
      }

      if (trainRes.ok && trainRes.data) {
        setTrainingItems(trainRes.data.checklist);
        setTrainingComplete(trainRes.data.allComplete);
        // Only block with training gate if user already has a submitted application
        if (hasExistingApplication && !trainRes.data.allComplete) setShowTraining(true);
      } else {
        setTrainingComplete(false);
        // Do not block new users who haven't applied yet
        if (hasExistingApplication) setShowTraining(true);
      }
      setTrainingLoading(false);
    })();
  }, []);

  async function handleCheckItem(key: string) {
    if (checkingLockRef.current.has(key)) return;
    checkingLockRef.current.add(key);
    setCheckingItem(key);
    try {
      const res = await rentABuddy.completeTrainingItem(key);
      if (res.ok && res.data) {
        setTrainingItems((prev) => prev.map((i) => i.key === key ? { ...i, completed: true } : i));
        if (res.data.allComplete) {
          setTrainingComplete(true);
          setShowTraining(false);
        }
      }
    } finally {
      checkingLockRef.current.delete(key);
      setCheckingItem(null);
    }
  }

  // Step 1
  const [displayName, setDisplayName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const [languages, setLanguages] = useState<{ lang: string; fluency: string }[]>([
    { lang: '', fluency: 'Proficient' },
  ]);

  // Step 2
  const [categories, setCategories] = useState<BuddyCategory[]>([]);

  // Step 3
  const [bio, setBio] = useState('');
  const photoComposer = useMediaComposer('buddyApplication');

  // Step 4
  const [hourlyRate, setHourlyRate] = useState('');
  const [motivation, setMotivation] = useState('');

  // Step 5 — weekly grid: day x time block
  const [availability, setAvailability] = useState<Record<string, Record<string, boolean>>>({});

  // Step 6
  const [zones, setZones] = useState<string[]>(['']);

  // Step 7
  const [agreedSafety, setAgreedSafety] = useState(false);
  const [agreedPolicy, setAgreedPolicy] = useState(false);

  function toggleSlot(day: string, block: string) {
    setAvailability((prev) => {
      const dayCopy = { ...(prev[day] ?? {}) };
      dayCopy[block] = !dayCopy[block];
      return { ...prev, [day]: dayCopy };
    });
  }

  function toggleCategory(cat: BuddyCategory) {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  }

  function canAdvance(): boolean {
    if (step === 1) return displayName.trim().length > 0 && city.trim().length > 0 && languages.some((l) => l.lang.trim().length > 0);
    if (step === 2) return categories.length > 0;
    if (step === 3) return bio.trim().length >= 30;
    if (step === 7) return agreedSafety && agreedPolicy;
    return true;
  }

  async function handleSubmit() {
    if (!canAdvance()) return;
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);

    try {
      // Check city rollout status before submitting — gracefully degrade if check fails
      try {
        const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
        const { supabase } = await import('../../../src/lib/supabase');
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        const statusRes = await fetch(`${API_BASE}/api/rent-buddy/launch-status?city=${encodeURIComponent(city)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const statusData = await statusRes.json();
        if (!statusData.applicationsOpen) {
          const msg = statusData.status === 'waitlist_only'
            ? `Buddy applications for ${city} aren't open yet. You can join the waitlist to be notified when they open.`
            : statusData.status === 'disabled'
            ? `Rent a Buddy is not available in ${city} yet. Check back soon!`
            : `Buddy applications for ${city} are currently paused. Please try again later.`;
          Alert.alert('Applications Not Open', msg);
          return;
        }
      } catch {
        // Status check failed — allow submission to proceed (graceful degradation)
      }

      // Convert the availability grid (day → block → bool) to the API array shape.
      const availabilityBlocks = Object.entries(availability).flatMap(([day, blocks]) =>
        Object.entries(blocks)
          .filter(([, on]) => on)
          .map(([block]) => ({ day, block })),
      );

      // Snapshot items before uploadAll() — uploadAll() only processes idle
      // items, so done/error items must be captured from this snapshot to avoid
      // stale React state after the async call.
      const photoItemsBefore = photoComposer.items;
      const alreadyDoneUrls = photoItemsBefore
        .filter((i) => i.uploadState === 'done' && i.uploadedUrl)
        .map((i) => i.uploadedUrl as string);

      // Upload idle items and get authoritative results from the return value.
      const uploadResultMap = photoItemsBefore.some((i) => i.uploadState === 'idle')
        ? await photoComposer.uploadAll()
        : new Map<string, import('../../../src/services/media').MediaUploadResult | null>();

      // Count failures: pre-existing errors (not retried) + new failures from result map.
      const preExistingErrorCount = photoItemsBefore.filter((i) => i.uploadState === 'error').length;
      const newFailCount = [...uploadResultMap.values()].filter((r) => r === null || !r.ok).length;
      const failedPhotoCount = preExistingErrorCount + newFailCount;

      if (failedPhotoCount > 0) {
        const proceed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            'Some photos failed to upload',
            `${failedPhotoCount} photo${failedPhotoCount > 1 ? 's' : ''} couldn't be uploaded. You can go back and retry, or continue your application without them.`,
            [
              { text: 'Go back and retry', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Continue without photos', onPress: () => resolve(true) },
            ],
          );
        });
        if (!proceed) return;
      }

      // Combine already-done URLs with newly uploaded ones from the result map.
      const newlyUploadedUrls = [...uploadResultMap.values()]
        .filter((r): r is NonNullable<typeof r> => r !== null && r.ok && r.url !== null)
        .map((r) => r.url as string);
      const photoUrls = [...alreadyDoneUrls, ...newlyUploadedUrls];

      const result = await rentABuddy.submitApplication({
        city,
        country: country || undefined,
        categories,
        languages: languages.filter((l) => l.lang.trim()).map((l) => l.lang.trim()),
        motivation: motivation || undefined,
        displayName: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        hourlyRateUsd: hourlyRate ? parseFloat(hourlyRate) : undefined,
        availability: availabilityBlocks.length ? availabilityBlocks : undefined,
        zones: zones.filter((z) => z.trim()).map((z) => z.trim()).length
          ? zones.filter((z) => z.trim()).map((z) => z.trim())
          : undefined,
        photos: photoUrls.length ? photoUrls : undefined,
      });
      if (result.ok) {
        setSubmitted(true);
      } else if (result.error === 'verification_required') {
        Alert.alert(
          'Verification Required',
          'ID verification is required before your nightlife buddy profile can be submitted for review. Please complete your verification first.',
          [{ text: 'OK' }],
        );
      } else if (result.error === 'incomplete_profile') {
        const missing: string[] = (result as any).missing ?? [];
        const fieldNames: Record<string, string> = {
          display_name: 'Display name',
          bio: 'Bio (min 30 characters)',
          photo: 'Profile photo',
          categories: 'Categories',
          services: 'Service offerings',
          areas: 'Meetup areas',
          languages: 'Languages',
          pricing: 'Hourly rate',
          availability: 'Weekly availability',
          policy_accepted: 'Buddy policy acceptance',
          safety_acknowledged: 'Safety guidelines confirmation',
          boundaries_acknowledged: 'Conduct & boundaries confirmation',
        };
        const labels = missing.map((k) => fieldNames[k] ?? k).join('\n• ');
        Alert.alert('Profile Incomplete', `Please complete the following before submitting:\n\n• ${labels}`);
      } else {
        Alert.alert('Could not submit', bookingErrorCopy(result.error, 'Please try again.'));
      }
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  }

  // Submits an existing buddy profile for admin review.
  // Called from the profile checklist gate — routes to POST /api/me/buddy-profile/submit
  // which enforces all checklist + verification requirements server-side.
  async function handleProfileSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result: rentABuddy.ProfileSubmitResult = await rentABuddy.submitProfileForReview();
      if (result.ok) {
        setSubmitted(true);
      } else if (result.error === 'verification_required') {
        const vr = result as Extract<rentABuddy.ProfileSubmitResult, { error: 'verification_required' }>;
        Alert.alert(
          'Verification Required',
          `ID verification is required by your category policy before submitting for review.\n\nCurrent status: ${vr.verification_status ?? 'unverified'}. Please contact support to begin the verification process.`,
          [{ text: 'OK' }],
        );
      } else if (result.error === 'incomplete_profile') {
        const ip = result as Extract<rentABuddy.ProfileSubmitResult, { error: 'incomplete_profile' }>;
        const fieldNames: Record<string, string> = {
          display_name: 'Display name',
          bio: 'Bio (min 30 characters)',
          photo: 'Profile photo',
          categories: 'Categories',
          services: 'Service offerings',
          areas: 'Meetup areas',
          languages: 'Languages',
          pricing: 'Hourly rate',
          availability: 'Weekly availability',
          policy_accepted: 'Buddy policy acceptance',
          safety_acknowledged: 'Safety guidelines confirmation',
          boundaries_acknowledged: 'Conduct & boundaries confirmation',
        };
        const labels = (ip.missing ?? []).map((k) => fieldNames[k] ?? k).join('\n• ');
        Alert.alert('Profile Incomplete', `Please complete the following before submitting:\n\n• ${labels}`);
      } else {
        Alert.alert('Could not submit', (result as any).error ?? 'Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (trainingLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: color.paper }}>
        <ActivityIndicator size="large" color={color.signal} />
        <Text style={{ marginTop: space.md, color: color.mute, fontSize: 14 }}>Checking your profile…</Text>
      </View>
    );
  }

  // Profile checklist gate — shown when user has existing profile fields that are still missing.
  // The user must complete each item before they can re-submit for review.
  if (showProfileChecklist) {
    const doneCount = profileChecklistItems.filter((i) => i.done).length;
    const totalCount = profileChecklistItems.length;
    const verificationItem = profileChecklistItems.find((i) => i.verificationRequired && !i.done);
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[hdr.wrap, { paddingTop: insets.top + space.sm }]}>
          <Pressable onPress={() => router.back()} style={hdr.back} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 15, fontWeight: '700', color: color.ink }}>Profile Checklist</Text>
          </View>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + 120 }}>
          <View style={{ marginTop: space.xl, marginBottom: space.lg }}>
            <Text style={{ fontSize: 22, fontWeight: '700', color: color.ink, marginBottom: space.xs }}>
              Complete your profile
            </Text>
            <Text style={{ fontSize: 14, color: color.mute, lineHeight: 20 }}>
              All required fields must be filled in before you can submit your profile for review. Tap each item to complete it.
            </Text>
            <View style={{ marginTop: space.md, height: 6, backgroundColor: color.haze, borderRadius: 3, overflow: 'hidden' }}>
              <View style={{ width: `${(doneCount / Math.max(totalCount, 1)) * 100}%`, height: '100%', backgroundColor: color.signal, borderRadius: 3 }} />
            </View>
            <Text style={{ marginTop: space.xs, fontSize: 12, color: color.mute }}>{doneCount} of {totalCount} complete</Text>
          </View>

          {verificationItem && (
            <View style={{ marginBottom: space.lg, padding: space.md, backgroundColor: '#FFF8E7', borderRadius: radius.md, borderWidth: 1, borderColor: '#F59E0B', flexDirection: 'row', gap: space.sm }}>
              <AlertCircle size={18} color="#D97706" style={{ marginTop: 2 }} />
              <Text style={{ flex: 1, fontSize: 13, color: '#92400E', lineHeight: 18 }}>
                {verificationItem.label}. Please contact support to begin the verification process.
              </Text>
            </View>
          )}

          {profileChecklistItems.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => {
                // Navigate to the relevant management screen for this item
                if (item.done) return;
                if (['services', 'pricing'].includes(item.key)) router.push('/(rent-a-buddy)/buddy-dashboard/packages' as any); // services screen doesn't exist (beta-audit fix)
                else if (item.key === 'availability') router.push('/(rent-a-buddy)/buddy-dashboard/availability' as any);
                else router.push('/(rent-a-buddy)/buddy-dashboard' as any);
              }}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: space.md,
                paddingVertical: space.sm, paddingHorizontal: space.md,
                backgroundColor: item.done ? color.paperRaised : color.paper,
                borderRadius: radius.md, marginBottom: space.xs,
                borderWidth: 1, borderColor: item.done ? color.haze : color.signal + '33',
                opacity: item.done ? 0.7 : 1,
              }}
              disabled={item.done}
            >
              {item.done ? (
                <CheckCircle size={20} color={color.signal} />
              ) : (
                <Circle size={20} color={color.mute} />
              )}
              <Text style={{ flex: 1, fontSize: 14, color: item.done ? color.mute : color.ink, textDecorationLine: item.done ? 'line-through' : 'none' }}>
                {item.label}
              </Text>
              {!item.done && !item.verificationRequired && (
                <ArrowRight size={14} color={color.mute} />
              )}
            </Pressable>
          ))}
        </ScrollView>
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, paddingHorizontal: space.lg, paddingBottom: insets.bottom + space.md, paddingTop: space.md, backgroundColor: color.paper }}>
          <Pressable
            onPress={profileComplete && !submitting ? handleProfileSubmit : undefined}
            style={[
              {
                borderRadius: radius.md,
                paddingVertical: 14,
                alignItems: 'center' as const,
                justifyContent: 'center' as const,
              },
              profileComplete && !submitting
                ? { backgroundColor: color.signal }
                : { backgroundColor: color.haze },
            ]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !profileComplete || submitting }}
          >
            {submitting ? (
              <ActivityIndicator size="small" color={color.paper} />
            ) : (
              <Text style={{ color: profileComplete ? color.onInk : color.mute, fontWeight: '700', fontSize: 15 }}>
                {profileComplete ? 'Submit for Review' : 'Complete all items to submit'}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  if (showTraining) {
    const completed = trainingItems.filter((i) => i.completed).length;
    const total = trainingItems.length || 10;
    return (
      <View style={{ flex: 1, backgroundColor: color.paper }}>
        <View style={[hdr.wrap, { paddingTop: insets.top + space.sm }]}>
          <Pressable onPress={() => router.back()} style={hdr.back} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <ArrowLeft size={20} color={color.ink} />
          </Pressable>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <BookOpen size={20} color={color.signal} />
          </View>
          <View style={{ width: 36 }} />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + 120 }}>
          <View style={{ marginTop: space.xl, marginBottom: space.lg }}>
            <Text style={{ fontSize: 22, fontWeight: '700', color: color.ink, marginBottom: space.xs }}>
              Complete your training first
            </Text>
            <Text style={{ fontSize: 14, color: color.mute, lineHeight: 20 }}>
              Before applying to become a Buddy, you must read and confirm all 10 training items. These ensure every Buddy meets our safety and conduct standards.
            </Text>
            <View style={{ marginTop: space.md, height: 6, backgroundColor: color.haze, borderRadius: 3, overflow: 'hidden' }}>
              <View style={{ width: `${(completed / total) * 100}%`, height: '100%', backgroundColor: color.signal, borderRadius: 3 }} />
            </View>
            <Text style={{ marginTop: space.xs, fontSize: 12, color: color.mute }}>{completed} of {total} confirmed</Text>
          </View>

          {trainingItems.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => !item.completed && handleCheckItem(item.key)}
              style={[
                trn.row,
                item.completed && trn.rowDone,
              ]}
              disabled={item.completed || checkingItem === item.key}
            >
              <View style={[trn.check, item.completed && trn.checkDone]}>
                {item.completed ? (
                  <Check size={14} color={color.onInk} />
                ) : checkingItem === item.key ? (
                  <ActivityIndicator size="small" color={color.signal} />
                ) : null}
              </View>
              <Text style={[trn.label, item.completed && trn.labelDone]}>{item.label}</Text>
            </Pressable>
          ))}

          {trainingItems.length === 0 && (
            <Text style={{ color: color.mute, fontSize: 14, textAlign: 'center', marginTop: space.xl }}>
              No training items found. You may not have submitted an application yet. Complete training after submitting your first draft.
            </Text>
          )}

          {completed === total && total > 0 && (
            <View style={{ marginTop: space.lg }}>
              <TravelButton
                label="Start application →"
                onPress={() => { setShowTraining(false); setTrainingComplete(true); }}
                variant="primary"
                full
              />
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  if (submitted) {
    return (
      <View style={[done.wrap, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={done.circle}>
          <Check size={32} color={color.onInk} />
        </View>
        <Stamp label="APPLICATION SENT" tone="deep" rotate={-2} />
        <Text style={done.title}>Application submitted!</Text>
        <Text style={done.sub}>
          Our team reviews applications within 3–5 business days. We'll notify you when your Buddy profile is activated.
        </Text>
        <TravelButton
          label="Back to home"
          onPress={() => router.replace('/(tabs)/' as any)}
          variant="primary"
          full
        />
      </View>
    );
  }

  return (
    <KeyboardSafeScrollView style={{ backgroundColor: color.paper }}>
      {/* Header */}
      <View style={[hdr.wrap, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          onPress={() => step === 1 ? router.back() : setStep((s) => s - 1)}
          style={hdr.back}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <ArrowLeft size={20} color={color.ink} />
        </Pressable>
        <ProgressBar step={step} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: insets.bottom + 120 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* STEP 1 — Identity */}
        {step === 1 && (
          <View>
            <StepHeader step={1} title="About you" sub="This is how travellers will find you." />
            <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="e.g. Marco from Bangkok" />
            <Field label="City you guide in" value={city} onChangeText={setCity} placeholder="e.g. Bangkok" />
            <Field label="Country" value={country} onChangeText={setCountry} placeholder="e.g. Thailand" optional />
            <Pressable style={ap.searchCityBtn} onPress={() => setCityPickerOpen(true)}>
              <Search size={13} color={color.signal} />
              <Text style={ap.searchCityText}>Search city &amp; auto-fill</Text>
            </Pressable>
            <GlobalPlacePicker
              visible={cityPickerOpen}
              title="City you guide in"
              placeholder="Search a city…"
              allowGPS={false}
              usedFor="buddy_service_city"
              onSelect={(place) => {
                if (place.city) setCity(place.city);
                else setCity(place.name);
                if (place.country) setCountry(place.country);
                setCityPickerOpen(false);
              }}
              onClose={() => setCityPickerOpen(false)}
            />

            <FieldLabel label="Languages you speak" />
            {languages.map((l, i) => (
              <View key={i} style={lang.block}>
                <View style={lang.inputRow}>
                  <TextInput
                    style={[fi.input, { flex: 1 }]}
                    value={l.lang}
                    onChangeText={(v) => {
                      const next = [...languages];
                      next[i] = { ...next[i], lang: v };
                      setLanguages(next);
                    }}
                    placeholder="Language"
                    placeholderTextColor={color.haze}
                  />
                  {languages.length > 1 && (
                    <Pressable
                      onPress={() => setLanguages((prev) => prev.filter((_, j) => j !== i))}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={{ marginLeft: space.sm }}
                    >
                      <X size={16} color={color.mute} />
                    </Pressable>
                  )}
                </View>
                <View style={lang.chipRow}>
                  {FLUENCY.map((f) => (
                    <TravelChip
                      key={f}
                      label={f}
                      active={l.fluency === f}
                      onPress={() => {
                        const next = [...languages];
                        next[i] = { ...next[i], fluency: f };
                        setLanguages(next);
                      }}
                    />
                  ))}
                </View>
              </View>
            ))}
            <Pressable style={addBtn.row} onPress={() => setLanguages((prev) => [...prev, { lang: '', fluency: 'Proficient' }])}>
              <Plus size={14} color={color.signal} />
              <Text style={addBtn.text}>Add another language</Text>
            </Pressable>
          </View>
        )}

        {/* STEP 2 — Categories */}
        {step === 2 && (
          <View>
            <StepHeader step={2} title="What do you offer?" sub="Select all that apply. You can change this later." />
            <View style={grid.wrap}>
              {ALL_CATEGORIES.map((c) => (
                <Pressable
                  key={c.value}
                  onPress={() => toggleCategory(c.value)}
                  style={[grid.card, categories.includes(c.value) && grid.cardActive]}
                >
                  <Text style={grid.emoji}>{c.emoji}</Text>
                  <Text style={[grid.label, categories.includes(c.value) && grid.labelActive]}>{c.label}</Text>
                  {categories.includes(c.value) && (
                    <View style={grid.checkWrap}>
                      <Check size={12} color={color.onInk} />
                    </View>
                  )}
                </Pressable>
              ))}
            </View>
            {categories.length === 0 && (
              <Text style={hint.text}>Select at least one category to continue.</Text>
            )}
          </View>
        )}

        {/* STEP 3 — Bio + photos */}
        {step === 3 && (
          <View>
            <StepHeader step={3} title="Your bio & photos" sub="Tell travellers who you are and what makes your tours special." />
            <FieldLabel label="Bio" />
            <TextInput
              style={[fi.input, fi.multiline, { marginBottom: space.lg }]}
              value={bio}
              onChangeText={setBio}
              placeholder="I've lived in Bangkok for 10 years and love showing travellers the hidden side of the city — street food, temples off the tourist trail, and local markets most guides miss..."
              placeholderTextColor={color.haze}
              multiline
              maxLength={600}
            />
            <Text style={hint.text}>{bio.length}/600 characters (minimum 30)</Text>

            <FieldLabel label="Profile photos" optional />
            <Text style={hint.text}>Upload up to 3 photos showing you in your city.</Text>
            <MediaPickerButton composer={photoComposer} />
            {photoComposer.items.length > 0 && (
              <MediaAttachmentTray composer={photoComposer} />
            )}
          </View>
        )}

        {/* STEP 4 — Rates */}
        {step === 4 && (
          <View>
            <StepHeader step={4} title="Your rates" sub="Set your hourly rate. You can create packages after approval." />
            <Field
              label="Hourly rate (USD)"
              value={hourlyRate}
              onChangeText={setHourlyRate}
              placeholder="e.g. 35"
              keyboardType="numeric"
              optional
            />
            <TravelCard style={{ padding: space.md, marginBottom: space.lg }}>
              <Text style={s.infoTitle}>💡 Pricing tips</Text>
              <Text style={s.infoBody}>
                New Buddies in popular cities typically start at $20–40/hour. Night-life and content tours often command higher rates ($40–70/hr).
                You can always adjust your rates after approval.
              </Text>
            </TravelCard>
            <Field
              label="Why do you want to be a Buddy?"
              value={motivation}
              onChangeText={setMotivation}
              placeholder="Share what drives you to help travellers explore your city..."
              multiline
              optional
            />
          </View>
        )}

        {/* STEP 5 — Availability grid */}
        {step === 5 && (
          <View>
            <StepHeader step={5} title="Typical availability" sub="Tap slots to mark when you're generally available. You can update this anytime." />
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                {/* Day headers */}
                <View style={avail.headerRow}>
                  <View style={avail.blockLabel} />
                  {DAYS.map((d) => (
                    <View key={d} style={avail.dayHeader}>
                      <Text style={avail.dayText}>{d}</Text>
                    </View>
                  ))}
                </View>
                {TIME_BLOCKS.map((block) => (
                  <View key={block} style={avail.row}>
                    <View style={avail.blockLabel}>
                      <Text style={avail.blockText}>{block}</Text>
                    </View>
                    {DAYS.map((d) => {
                      const on = availability[d]?.[block] ?? false;
                      return (
                        <Pressable
                          key={d}
                          style={[avail.cell, on && avail.cellOn]}
                          onPress={() => toggleSlot(d, block)}
                        />
                      );
                    })}
                  </View>
                ))}
              </View>
            </ScrollView>
            <Text style={[hint.text, { marginTop: space.md }]}>
              Tap cells to toggle. Green = available. You can set specific dates in your dashboard.
            </Text>
          </View>
        )}

        {/* STEP 6 — Meetup zones */}
        {step === 6 && (
          <View>
            <StepHeader step={6} title="Preferred meetup zones" sub="Where do you typically meet travellers? (e.g. Sukhumvit, Old Town, Airport arrivals)" />
            {zones.map((z, i) => (
              <View key={i} style={lang.row}>
                <TextInput
                  style={[fi.input, { flex: 1 }]}
                  value={z}
                  onChangeText={(v) => {
                    const next = [...zones];
                    next[i] = v;
                    setZones(next);
                  }}
                  placeholder={`Zone ${i + 1}`}
                  placeholderTextColor={color.haze}
                />
                {zones.length > 1 && (
                  <Pressable
                    onPress={() => setZones((prev) => prev.filter((_, j) => j !== i))}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <X size={16} color={color.mute} />
                  </Pressable>
                )}
              </View>
            ))}
            <Pressable style={addBtn.row} onPress={() => setZones((prev) => [...prev, ''])}>
              <Plus size={14} color={color.signal} />
              <Text style={addBtn.text}>Add zone</Text>
            </Pressable>
          </View>
        )}

        {/* STEP 7 — Policy agreement */}
        {step === 7 && (
          <View>
            <StepHeader step={7} title="Safety agreement" sub="Please read and confirm both policies before submitting." />

            <TravelCard style={{ padding: space.lg, marginBottom: space.lg }}>
              <Text style={s.policyTitle}>Non-dating & Non-adult-service Policy</Text>
              <Text style={s.policyBody}>
                Rent a Buddy is strictly a local guide and travel companionship service. By applying, you confirm that:
                {'\n\n'}• You will not engage in romantic, sexual, or adult-service activities with travellers.
                {'\n'}• You will not advertise or imply such services.
                {'\n'}• You understand that violations result in immediate and permanent removal from the platform.
                {'\n'}• All meetups are professional in nature and occur in public or agreed safe spaces.
              </Text>
              <Pressable
                style={toggle.row}
                onPress={() => setAgreedPolicy((v) => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: agreedPolicy }}
              >
                <View style={[toggle.box, agreedPolicy && toggle.boxOn]}>
                  {agreedPolicy && <Check size={12} color={color.onInk} />}
                </View>
                <Text style={toggle.label}>I agree to the Non-dating & Non-adult-service Policy</Text>
              </Pressable>
            </TravelCard>

            <TravelCard style={{ padding: space.lg, marginBottom: space.lg }}>
              <Text style={s.policyTitle}>Safety & Community Guidelines</Text>
              <Text style={s.policyBody}>
                As a Buddy you agree to:
                {'\n\n'}• Respond to booking requests within 24 hours.
                {'\n'}• Meet travellers in agreed locations and honour confirmed bookings.
                {'\n'}• Use the in-app safety tools if a situation feels unsafe.
                {'\n'}• Report any policy violations by travellers immediately.
                {'\n'}• Maintain accurate availability and pricing.
              </Text>
              <Pressable
                style={toggle.row}
                onPress={() => setAgreedSafety((v) => !v)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: agreedSafety }}
              >
                <View style={[toggle.box, agreedSafety && toggle.boxOn]}>
                  {agreedSafety && <Check size={12} color={color.onInk} />}
                </View>
                <Text style={toggle.label}>I agree to the Safety & Community Guidelines</Text>
              </Pressable>
            </TravelCard>
          </View>
        )}
      </ScrollView>

      {/* Bottom nav */}
      <View style={[nav.wrap, { paddingBottom: insets.bottom + space.md }]}>
        {step < TOTAL_STEPS ? (
          <TravelButton
            label="Continue"
            onPress={() => { if (!canAdvance()) return; setStep((s) => s + 1); }}
            variant={canAdvance() ? 'primary' : 'ghost'}
            full
            icon={<ArrowRight size={16} color={canAdvance() ? color.onInk : color.mute} />}
          />
        ) : (
          <TravelButton
            label={submitting ? 'Submitting…' : 'Submit application'}
            onPress={handleSubmit}
            variant={canAdvance() ? 'primary' : 'ghost'}
            full
            icon={submitting ? <ActivityIndicator size="small" color={color.onInk} /> : <Check size={16} color={canAdvance() ? color.onInk : color.mute} />}
          />
        )}
        {!canAdvance() && step === 1 && (
          <Text style={nav.hint}>Fill in your name, city, and at least one language to continue.</Text>
        )}
        {!canAdvance() && step === 2 && (
          <Text style={nav.hint}>Select at least one category.</Text>
        )}
        {!canAdvance() && step === 3 && (
          <Text style={nav.hint}>Bio must be at least 30 characters.</Text>
        )}
        {!canAdvance() && step === 7 && (
          <Text style={nav.hint}>Accept both policies to submit.</Text>
        )}
      </View>
    </KeyboardSafeScrollView>
  );
}

const pb = StyleSheet.create({
  wrap: { flexDirection: 'row', flex: 1, gap: 4, marginLeft: space.md },
  seg: { flex: 1, height: 4, borderRadius: 2 },
  done: { backgroundColor: color.signal },
  active: { backgroundColor: color.signal, opacity: 0.5 },
  todo: { backgroundColor: color.haze },
});

const hdr = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.lg, paddingBottom: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
    backgroundColor: color.paper,
  },
  back: {},
});

const sh = StyleSheet.create({
  wrap: { marginTop: space.xl, marginBottom: space.xl },
  step: { fontFamily: 'Courier', fontSize: 10, fontWeight: '700', color: color.deep, letterSpacing: 2, marginBottom: space.xs },
  title: { ...t.heading, color: color.ink, marginBottom: space.xs },
  sub: { ...t.body, color: color.mute },
});

const fl = StyleSheet.create({
  label: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  opt: { ...t.small, color: color.haze },
});

const fi = StyleSheet.create({
  input: {
    borderWidth: 1.5, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.md,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
  multiline: { height: 120, textAlignVertical: 'top' },
});

const lang = StyleSheet.create({
  block: { marginBottom: space.sm },
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.sm },
});

const addBtn = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.xs, marginBottom: space.lg },
  text: { ...t.small, color: color.signal, fontWeight: '700' },
});

const grid = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: space.md },
  card: {
    width: '47%', borderRadius: radius.md, borderWidth: 1.5,
    borderColor: color.haze, padding: space.md, gap: 4,
    backgroundColor: color.paperRaised, position: 'relative',
  },
  cardActive: { borderColor: color.signal, backgroundColor: '#FFF3F0' },
  emoji: { fontSize: 22 },
  label: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  labelActive: { color: color.signal },
  checkWrap: {
    position: 'absolute', top: 8, right: 8,
    width: icon.s20, height: icon.s20, borderRadius: icon.s20 / 2,
    backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center',
  },
});

const avail = StyleSheet.create({
  headerRow: { flexDirection: 'row', marginBottom: 2 },
  row: { flexDirection: 'row', marginBottom: 2 },
  blockLabel: {
    width: 80, paddingRight: space.sm, justifyContent: 'center',
  },
  blockText: { fontFamily: 'Courier', fontSize: 9, color: color.mute, lineHeight: 13 },
  dayHeader: { width: 44, alignItems: 'center', paddingBottom: 4 },
  dayText: { ...t.stamp, color: color.mute },
  cell: {
    width: 44, height: 44, borderRadius: radius.sm,
    borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, margin: 1,
  },
  cellOn: { backgroundColor: '#E8F5EE', borderColor: color.success },
});

const photos = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, marginBottom: space.lg },
  slot: {
    flex: 1, aspectRatio: aspect.square, borderRadius: radius.md,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: color.paperRaised,
  },
  slotText: { ...t.small, color: color.haze },
});

const hint = StyleSheet.create({
  text: { ...t.small, color: color.haze, lineHeight: 17 },
});

const toggle = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, marginTop: space.lg },
  box: {
    width: 22, height: 22, borderRadius: 4, borderWidth: 1.5,
    borderColor: color.haze, alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.paperRaised, marginTop: 1,
  },
  boxOn: { backgroundColor: color.signal, borderColor: color.signal },
  label: { ...t.small, color: color.ink, flex: 1, lineHeight: 18 },
});

const nav = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg, paddingTop: space.md,
    borderTopWidth: 1, borderTopColor: color.haze,
    backgroundColor: color.paper, gap: space.sm,
  },
  hint: { ...t.small, color: color.haze, textAlign: 'center' },
});

const done = StyleSheet.create({
  wrap: {
    flex: 1, backgroundColor: color.paper,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: space.xl, gap: space.lg,
  },
  circle: {
    width: avatar.s64, height: avatar.s64, borderRadius: avatar.s64 / 2,
    backgroundColor: color.success, alignItems: 'center', justifyContent: 'center',
    marginBottom: space.sm,
  },
  title: { ...t.heading, color: color.ink, textAlign: 'center' },
  sub: { ...t.body, color: color.mute, textAlign: 'center', lineHeight: 22 },
});

const ap = StyleSheet.create({
  searchCityBtn:  { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.sm, marginTop: -space.sm },
  searchCityText: { ...t.small, color: color.signal, fontWeight: '600' },
});

const s = StyleSheet.create({
  infoTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.xs },
  infoBody: { ...t.small, color: color.mute, lineHeight: 18 },
  policyTitle: { ...t.bodyStrong, color: color.ink, marginBottom: space.sm },
  policyBody: { ...t.small, color: color.mute, lineHeight: 18 },
});

const trn = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingVertical: space.sm, paddingHorizontal: space.md,
    marginBottom: space.xs, backgroundColor: color.haze,
    borderRadius: radius.md, gap: space.sm,
  },
  rowDone: { backgroundColor: `${color.signal}15` },
  check: {
    width: icon.s24, height: icon.s24, borderRadius: icon.s24 / 2,
    borderWidth: 2, borderColor: color.haze,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, marginTop: 1,
  },
  checkDone: { backgroundColor: color.signal, borderColor: color.signal },
  label: { ...t.body, color: color.ink, flex: 1, lineHeight: 20 },
  labelDone: { color: color.mute, textDecorationLine: 'line-through' },
});
