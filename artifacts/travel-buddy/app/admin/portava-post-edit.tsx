/**
 * Admin — Edit an existing @Portava post.
 *
 * Prefilled from the list via `postJson` route param (JSON-serialised PortavaPost).
 * Allows changing:
 *   - Body text (always)
 *   - Category (always)
 *   - Schedule (only for pending_delay / scheduled posts)
 *
 * Published posts show a read-only schedule notice instead of the toggle.
 *
 * On save: calls PATCH /api/admin/portava/posts/:id and navigates back.
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
import { router, useLocalSearchParams } from 'expo-router';
import { useRequireAdmin } from '../../src/hooks/useRequireAdmin';
import { adminPatch } from '../../src/services/adminApi';

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

// ── Types ──────────────────────────────────────────────────────────────────────

interface PortavaPost {
  id: string;
  content: string;
  category: string | null;
  postStatus: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  visibility: string;
  mediaUrls: string[];
  locationCity: string | null;
  locationCountry: string | null;
  status: string;
  createdAt: string;
  updatedAt: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Very light validation: ISO datetime string from a text input. */
function parseScheduledAt(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Format an ISO string to YYYY-MM-DDTHH:MM for the text input. */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  // Use toISOString slice — keep as UTC display for consistency with create form
  return new Date(iso).toISOString().slice(0, 16);
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PortavaPostEditScreen() {
  useRequireAdmin();

  const params = useLocalSearchParams<{ postJson: string }>();

  // Parse the serialised post passed from the list screen
  const post: PortavaPost | null = (() => {
    try {
      return params.postJson ? JSON.parse(params.postJson) : null;
    } catch {
      return null;
    }
  })();

  const isScheduled = post?.postStatus === 'pending_delay';

  const [content, setContent]       = useState(post?.content ?? '');
  const [category, setCategory]     = useState<CategoryKey | null>(
    (post?.category as CategoryKey | null) ?? null,
  );
  const [scheduleEnabled, setSchedule] = useState(isScheduled);
  const [scheduledAt, setScheduledAt]  = useState(toLocalInput(post?.scheduledAt ?? null));
  const [submitting, setSubmitting]    = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  if (!post) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>Post data unavailable. Please go back and try again.</Text>
        <Pressable style={s.retryBtn} onPress={() => router.back()}>
          <Text style={s.retryText}>← Back</Text>
        </Pressable>
      </View>
    );
  }

  const onSave = async () => {
    const body = content.trim();
    if (!body) {
      Alert.alert('Body required', 'Please enter post content before saving.');
      return;
    }

    // Build patch payload — only include fields that may change
    const patch: Record<string, unknown> = {
      content: body,
      category: category ?? null,
    };

    // Scheduling — only allowed on scheduled posts
    if (isScheduled) {
      if (scheduleEnabled) {
        const isoScheduled = parseScheduledAt(scheduledAt);
        if (!isoScheduled) {
          Alert.alert('Invalid date', 'Please enter a valid scheduled date and time.');
          return;
        }
        if (new Date(isoScheduled) <= new Date()) {
          Alert.alert('Date in the past', 'Scheduled time must be in the future.');
          return;
        }
        patch.scheduledAt = isoScheduled;
      } else {
        // Toggle turned off → publish immediately
        patch.scheduledAt = null;
      }
    }

    setSubmitting(true);
    const res = await adminPatch<{ post: PortavaPost }>(
      `/api/admin/portava/posts/${post.id}`,
      patch,
    );
    setSubmitting(false);

    if (!res.ok) {
      Alert.alert('Error', res.error);
      return;
    }

    Alert.alert(
      'Saved',
      'The post has been updated.',
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
        <Text style={s.title}>Edit @Portava Post</Text>
        {post.postStatus === 'published' && (
          <View style={s.liveBadge}>
            <Text style={s.liveBadgeText}>LIVE</Text>
          </View>
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >

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

        {/* Scheduling — only for scheduled posts */}
        {isScheduled ? (
          <View>
            <View style={s.scheduleRow}>
              <Text style={s.label}>Keep schedule</Text>
              <Pressable
                style={[s.toggle, scheduleEnabled && s.toggleOn]}
                onPress={() => setSchedule((v) => !v)}
              >
                <View style={[s.toggleThumb, scheduleEnabled && s.toggleThumbOn]} />
              </Pressable>
            </View>

            {scheduleEnabled ? (
              <View>
                <Text style={s.helperText}>Enter date and time (UTC)</Text>
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
            ) : (
              <View style={s.publishNowNote}>
                <Text style={s.publishNowText}>
                  ⚡ Turning off the schedule will publish this post immediately.
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View style={s.scheduleReadonly}>
            <Text style={s.scheduleReadonlyText}>
              🔒 Scheduling is not available for published posts — only body and category can be edited.
            </Text>
          </View>
        )}

        {/* Save */}
        <Pressable
          style={[s.saveBtn, submitting && s.saveBtnDisabled]}
          onPress={onSave}
          disabled={submitting}
        >
          {submitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={s.saveText}>💾 Save Changes</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex:                  { flex: 1, backgroundColor: '#F9FAFB' },
  centered:              { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorText:             { fontSize: 15, color: '#EF4444', textAlign: 'center', marginBottom: 16 },
  retryBtn:              { paddingHorizontal: 20, paddingVertical: 8, backgroundColor: '#3B82F6', borderRadius: 8 },
  retryText:             { color: '#FFFFFF', fontWeight: '600' },
  header:                { paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#E5E7EB', flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  backBtn:               { marginBottom: 0 },
  backText:              { fontSize: 14, color: '#3B82F6' },
  title:                 { fontSize: 20, fontWeight: '700', color: '#111827', flex: 1 },
  liveBadge:             { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: '#D1FAE5', marginBottom: 2 },
  liveBadgeText:         { fontSize: 11, fontWeight: '700', color: '#059669' },
  scroll:                { flex: 1 },
  scrollContent:         { padding: 16, gap: 6, paddingBottom: 60 },
  label:                 { fontSize: 14, fontWeight: '600', color: '#374151', marginTop: 14, marginBottom: 4 },
  required:              { color: '#EF4444' },
  textarea:              { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 10, padding: 12, fontSize: 15, color: '#111827', minHeight: 130, textAlignVertical: 'top' },
  charCount:             { fontSize: 11, color: '#9CA3AF', textAlign: 'right' },
  chipGrid:              { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  catChip:               { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, backgroundColor: '#F3F4F6', borderWidth: 1, borderColor: '#E5E7EB' },
  catChipActive:         { backgroundColor: '#EDE9FE', borderColor: '#7C3AED' },
  catChipText:           { fontSize: 13, color: '#6B7280' },
  catChipTextActive:     { color: '#7C3AED', fontWeight: '600' },
  input:                 { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 10, padding: 12, fontSize: 14, color: '#111827' },
  scheduleRow:           { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 },
  toggle:                { width: 48, height: 28, borderRadius: 14, backgroundColor: '#D1D5DB', justifyContent: 'center', paddingHorizontal: 3 },
  toggleOn:              { backgroundColor: '#3B82F6' },
  toggleThumb:           { width: 22, height: 22, borderRadius: 11, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2 },
  toggleThumbOn:         { alignSelf: 'flex-end' },
  helperText:            { fontSize: 12, color: '#6B7280', marginBottom: 4, marginTop: 4 },
  publishNowNote:        { marginTop: 8, padding: 12, backgroundColor: '#FFFBEB', borderRadius: 10, borderWidth: 1, borderColor: '#FDE68A' },
  publishNowText:        { fontSize: 13, color: '#92400E' },
  scheduleReadonly:      { marginTop: 14, padding: 12, backgroundColor: '#F0F9FF', borderRadius: 10, borderWidth: 1, borderColor: '#BAE6FD' },
  scheduleReadonlyText:  { fontSize: 13, color: '#0369A1' },
  saveBtn:               { marginTop: 28, backgroundColor: '#3B82F6', borderRadius: 12, paddingVertical: 16, alignItems: 'center' },
  saveBtnDisabled:       { opacity: 0.6 },
  saveText:              { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
});
