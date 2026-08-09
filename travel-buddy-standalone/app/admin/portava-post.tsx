/**
 * Admin — Create / schedule a new @Portava post.
 *
 * Provides a form with:
 *  - Body text editor (required)
 *  - Category chip picker (13 editorial categories)
 *  - Location fields (city, country)
 *  - Optional media URLs (comma-separated entry)
 *  - Optional datetime picker for scheduling
 *
 * On submit: calls POST /api/admin/portava/posts and navigates back to the list.
 *
 * Requires admin role (enforced by useRequireAdmin hook + server-side).
 */
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { adminPost } from '../../src/services/adminApi';
import { icon } from '../../src/theme/tokens';

// ── Category definitions ───────────────────────────────────────────────────────

const CATEGORIES = [
  { key: 'hidden_gem',           label: 'Hidden Gem' },
  { key: 'inspiration',          label: 'Inspiration' },
  { key: 'festival',             label: 'Festival' },
  { key: 'restaurant',           label: 'Restaurant' },
  { key: 'beach_resort',         label: 'Beach Resort' },
  { key: 'nightlife',            label: 'Nightlife' },
  { key: 'neighborhood',         label: 'Neighborhood' },
  { key: 'trending_destination', label: 'Trending Destination' },
  { key: 'travel_tip',           label: 'Travel Tip' },
  { key: 'hotel',                label: 'Hotel' },
  { key: 'featured_creator',     label: 'Featured Creator' },
  { key: 'destination_of_week',  label: 'Destination of Week' },
  { key: 'community_spotlight',  label: 'Community Spotlight' },
] as const;

type CategoryKey = (typeof CATEGORIES)[number]['key'];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a local-datetime string compatible with HTML/RN datetime inputs. */
function nowPlusOneHourISO(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  // Format: YYYY-MM-DDTHH:MM
  return d.toISOString().slice(0, 16);
}

/** Very light validation: ISO datetime string from a text input. */
function parseScheduledAt(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PortavaPostScreen() {
  useRequireAdmin();

  const [content, setContent]         = useState('');
  const [category, setCategory]       = useState<CategoryKey | null>(null);
  const [locationCity, setCity]       = useState('');
  const [locationCountry, setCountry] = useState('');
  const [mediaRaw, setMediaRaw]       = useState('');   // comma-separated URLs
  const [scheduleEnabled, setSchedule] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(nowPlusOneHourISO());
  const [submitting, setSubmitting]   = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const onSubmit = async () => {
    const body = content.trim();
    if (!body) {
      Alert.alert('Body required', 'Please enter post content before publishing.');
      return;
    }

    let isoScheduled: string | null = null;
    if (scheduleEnabled) {
      isoScheduled = parseScheduledAt(scheduledAt);
      if (!isoScheduled) {
        Alert.alert('Invalid date', 'Please enter a valid scheduled date and time.');
        return;
      }
      if (new Date(isoScheduled) <= new Date()) {
        Alert.alert('Date in the past', 'Scheduled time must be in the future.');
        return;
      }
    }

    const mediaUrls = mediaRaw
      .split(',')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    setSubmitting(true);
    const res = await adminPost('/api/admin/portava/posts', {
      content: body,
      category: category ?? undefined,
      mediaUrls: mediaUrls.length > 0 ? mediaUrls : undefined,
      locationCity:    locationCity.trim() || undefined,
      locationCountry: locationCountry.trim() || undefined,
      scheduledAt:     isoScheduled ?? undefined,
    });
    setSubmitting(false);

    if (!res.ok) {
      Alert.alert('Error', res.error);
      return;
    }

    Alert.alert(
      isoScheduled ? 'Post scheduled' : 'Post published',
      isoScheduled
        ? `Post will go live on ${new Date(isoScheduled).toLocaleString()}`
        : 'Post is now live.',
      [{ text: 'OK', onPress: () => router.replace('/admin/portava-posts' as any) }],
    );
  };

  return (
    <KeyboardAvoidingView
      style={s.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={s.header}>
        <Pressable onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backText}>← Back</Text>
        </Pressable>
        <Text style={s.title}>New @Portava Post</Text>
      </View>

      <ScrollView ref={scrollRef} style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

        {/* Body */}
        <Text style={s.label}>Post body <Text style={s.required}>*</Text></Text>
        <TextInput
          style={s.textarea}
          multiline
          numberOfLines={6}
          placeholder="Write your curated travel content here…"
          placeholderTextColor="#9CA3AF"
          value={content}
          onChangeText={setContent}
          maxLength={3000}
        />
        <Text style={s.charCount}>{content.length} / 3000</Text>

        {/* Category picker */}
        <Text style={s.label}>Category</Text>
        <View style={s.chipGrid}>
          {CATEGORIES.map((c) => (
            <Pressable
              key={c.key}
              style={[s.catChip, category === c.key && s.catChipActive]}
              onPress={() => setCategory((prev) => prev === c.key ? null : c.key)}
            >
              <Text style={[s.catChipText, category === c.key && s.catChipTextActive]}>
                {c.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Location */}
        <Text style={s.label}>Location (optional)</Text>
        <View style={s.row}>
          <TextInput
            style={[s.input, s.flex]}
            placeholder="City"
            placeholderTextColor="#9CA3AF"
            value={locationCity}
            onChangeText={setCity}
            maxLength={100}
          />
          <TextInput
            style={[s.input, s.flex]}
            placeholder="Country"
            placeholderTextColor="#9CA3AF"
            value={locationCountry}
            onChangeText={setCountry}
            maxLength={100}
          />
        </View>

        {/* Media URLs */}
        <Text style={s.label}>Media URLs (optional, comma-separated)</Text>
        <TextInput
          style={s.input}
          placeholder="https://… , https://…"
          placeholderTextColor="#9CA3AF"
          value={mediaRaw}
          onChangeText={setMediaRaw}
          autoCapitalize="none"
          keyboardType="url"
        />

        {/* Scheduling */}
        <View style={s.scheduleRow}>
          <Text style={s.label}>Schedule for later</Text>
          <Pressable
            style={[s.toggle, scheduleEnabled && s.toggleOn]}
            onPress={() => setSchedule((v) => !v)}
          >
            <View style={[s.toggleThumb, scheduleEnabled && s.toggleThumbOn]} />
          </Pressable>
        </View>

        {scheduleEnabled && (
          <View>
            <Text style={s.helperText}>Enter date and time (your local time zone)</Text>
            <TextInput
              style={s.input}
              placeholder="YYYY-MM-DDTHH:MM"
              placeholderTextColor="#9CA3AF"
              value={scheduledAt}
              onChangeText={setScheduledAt}
              autoCapitalize="none"
              keyboardType="default"
            />
            <Text style={s.helperText}>
              Example: {new Date(Date.now() + 3600_000).toISOString().slice(0, 16)}
            </Text>
          </View>
        )}

        {/* Submit */}
        <Pressable
          style={[s.submitBtn, submitting && s.submitBtnDisabled]}
          onPress={onSubmit}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={s.submitText}>
              {scheduleEnabled ? '📅 Schedule Post' : '🚀 Publish Now'}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:              { flex: 1, backgroundColor: '#F9FAFB' },
  header:            { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB' },
  backBtn:           { marginBottom: 8 },
  backText:          { fontSize: 14, color: '#3B82F6' },
  title:             { fontSize: 22, fontWeight: '700', color: '#111827' },
  scroll:            { flex: 1 },
  content:           { padding: 16, gap: 6, paddingBottom: 60 },
  label:             { fontSize: 14, fontWeight: '600', color: '#374151', marginTop: 14, marginBottom: 4 },
  required:          { color: '#EF4444' },
  textarea:          { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 10, padding: 12, fontSize: 15, color: '#111827', minHeight: 130, textAlignVertical: 'top' },
  charCount:         { fontSize: 11, color: '#9CA3AF', textAlign: 'right' },
  chipGrid:          { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catChip:           { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  catChipActive:     { backgroundColor: '#EDE9FE', borderColor: '#7C3AED' },
  catChipText:       { fontSize: 13, color: '#6B7280' },
  catChipTextActive: { color: '#7C3AED', fontWeight: '600' },
  row:               { flexDirection: 'row', gap: 8 },
  input:             { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 10, padding: 12, fontSize: 14, color: '#111827' },
  scheduleRow:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  toggle:            { width: 48, height: 28, borderRadius: 14, backgroundColor: '#D1D5DB', justifyContent: 'center', paddingHorizontal: 3 },
  toggleOn:          { backgroundColor: '#3B82F6' },
  toggleThumb:       { width: icon.s22, height: icon.s22, borderRadius: icon.s22 / 2, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2 },
  toggleThumbOn:     { alignSelf: 'flex-end' },
  helperText:        { fontSize: 12, color: '#6B7280', marginBottom: 4 },
  submitBtn:         { marginTop: 28, backgroundColor: '#3B82F6', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.6 },
  submitText:        { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
