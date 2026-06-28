/**
 * SubmitPlaceSheet — lets authenticated users submit a hidden gem or traveler pick
 * for the current city. Calls POST /api/discovery/community via submitCommunityPlace().
 */
import React, { useState } from 'react';
import {
  View, Text, Modal, Pressable, TextInput, ScrollView, StyleSheet,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { X, MapPin, Star } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { submitCommunityPlace } from '../../services/discovery';

const CATEGORIES = [
  'hidden_gem', 'food', 'nightlife', 'activities',
  'beaches', 'transport', 'events', 'places',
];

const PLACE_TYPES: { key: 'hidden_gem' | 'traveler_pick'; label: string; desc: string }[] = [
  { key: 'hidden_gem',    label: 'Hidden Gem',     desc: 'A secret spot most tourists miss' },
  { key: 'traveler_pick', label: 'Traveler Pick',  desc: "A favourite you'd recommend to anyone" },
];

interface SubmitPlaceSheetProps {
  visible: boolean;
  city: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

export function SubmitPlaceSheet({ visible, city, onClose, onSubmitted }: SubmitPlaceSheetProps) {
  const [placeType, setPlaceType]       = useState<'hidden_gem' | 'traveler_pick'>('hidden_gem');
  const [name, setName]                 = useState('');
  const [category, setCategory]         = useState('hidden_gem');
  const [neighborhood, setNeighborhood] = useState('');
  const [blurb, setBlurb]               = useState('');
  const [tag, setTag]                   = useState('');
  const [note, setNote]                 = useState('');
  const [rating, setRating]             = useState<number | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [success, setSuccess]       = useState(false);

  const reset = () => {
    setPlaceType('hidden_gem');
    setName('');
    setCategory('hidden_gem');
    setNeighborhood('');
    setBlurb('');
    setTag('');
    setNote('');
    setRating(null);
    setError(null);
    setSuccess(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Place name is required.'); return; }

    setSubmitting(true);
    setError(null);

    const result = await submitCommunityPlace({
      city:         city.trim(),
      name:         name.trim(),
      place_type:   placeType,
      category:     category || undefined,
      neighborhood: neighborhood.trim() || undefined,
      blurb:        blurb.trim() || undefined,
      tag:          tag.trim() || undefined,
      note:         note.trim() || undefined,
      rating:       rating,
    });

    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSuccess(true);
    onSubmitted?.();
    setTimeout(() => {
      handleClose();
    }, 1800);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <MapPin size={18} color={color.signal} />
              <Text style={styles.title}>Share a Place</Text>
            </View>
            <Pressable onPress={handleClose} style={styles.closeBtn} hitSlop={12}>
              <X size={20} color={color.mute} />
            </Pressable>
          </View>

          <Text style={styles.cityLabel}>
            Adding to: <Text style={styles.cityName}>{city}</Text>
          </Text>

          {success ? (
            <View style={styles.successBox}>
              <Text style={styles.successEmoji}>🎉</Text>
              <Text style={styles.successTitle}>Thanks for sharing!</Text>
              <Text style={styles.successDesc}>Your spot is now live for other travellers to discover.</Text>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.form} showsVerticalScrollIndicator={false}>
              {/* Place type */}
              <Text style={styles.label}>Type</Text>
              <View style={styles.typeRow}>
                {PLACE_TYPES.map((pt) => {
                  const active = placeType === pt.key;
                  return (
                    <Pressable
                      key={pt.key}
                      style={[styles.typeCard, active && styles.typeCardActive]}
                      onPress={() => setPlaceType(pt.key)}
                    >
                      <Text style={[styles.typeCardTitle, active && styles.typeCardTitleActive]}>
                        {pt.label}
                      </Text>
                      <Text style={styles.typeCardDesc}>{pt.desc}</Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Name */}
              <Text style={styles.label}>Name <Text style={styles.required}>*</Text></Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                placeholder="e.g. Secret rooftop bar"
                placeholderTextColor={color.faint}
                maxLength={120}
              />

              {/* Category */}
              <Text style={styles.label}>Category</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
                <View style={styles.chipRow}>
                  {CATEGORIES.map((cat) => {
                    const active = category === cat;
                    return (
                      <Pressable
                        key={cat}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={() => setCategory(cat)}
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>
                          {cat.replace('_', ' ')}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              {/* Neighborhood */}
              <Text style={styles.label}>Neighborhood</Text>
              <TextInput
                style={styles.input}
                value={neighborhood}
                onChangeText={setNeighborhood}
                placeholder="e.g. Montmartre"
                placeholderTextColor={color.faint}
                maxLength={80}
              />

              {/* Blurb */}
              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={blurb}
                onChangeText={setBlurb}
                placeholder="What makes this place special?"
                placeholderTextColor={color.faint}
                multiline
                numberOfLines={3}
                maxLength={300}
              />

              {/* Note (personal tip) */}
              <Text style={styles.label}>Personal tip</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={note}
                onChangeText={setNote}
                placeholder="Any insider advice? (e.g. Go at sunset)"
                placeholderTextColor={color.faint}
                multiline
                numberOfLines={2}
                maxLength={200}
              />

              {/* Tag */}
              <Text style={styles.label}>Tag</Text>
              <TextInput
                style={styles.input}
                value={tag}
                onChangeText={setTag}
                placeholder="e.g. romantic, budget-friendly"
                placeholderTextColor={color.faint}
                maxLength={40}
              />

              {/* Rating */}
              <Text style={styles.label}>Your rating</Text>
              <View style={styles.starsRow}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <Pressable
                    key={star}
                    onPress={() => setRating(rating === star ? null : star)}
                    hitSlop={6}
                  >
                    <Star
                      size={28}
                      color={rating != null && star <= rating ? '#F59E0B' : color.haze}
                      fill={rating != null && star <= rating ? '#F59E0B' : 'transparent'}
                    />
                  </Pressable>
                ))}
                {rating != null && (
                  <Text style={styles.ratingValue}>{rating}/5</Text>
                )}
              </View>

              {error && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              <Pressable
                style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.submitBtnText}>Submit Place</Text>
                )}
              </Pressable>

              <View style={{ height: space.xxxl }} />
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.paper,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...t.heading,
    color: color.ink,
    fontSize: 18,
  },
  closeBtn: {
    padding: space.xs,
  },
  cityLabel: {
    ...t.small,
    color: color.mute,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xs,
  },
  cityName: {
    color: color.signal,
    fontWeight: '700',
  },
  form: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    gap: space.xs,
  },
  label: {
    ...t.stamp,
    color: color.mute,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: space.md,
    marginBottom: 4,
  },
  required: {
    color: color.signal,
  },
  typeRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  typeCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    padding: space.md,
    backgroundColor: color.paperRaised,
  },
  typeCardActive: {
    borderColor: color.signal,
    backgroundColor: color.signal + '10',
  },
  typeCardTitle: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 13,
    marginBottom: 2,
  },
  typeCardTitleActive: {
    color: color.signal,
  },
  typeCardDesc: {
    ...t.small,
    color: color.mute,
    fontSize: 11,
    lineHeight: 15,
  },
  input: {
    borderWidth: 1,
    borderColor: color.haze,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    ...t.body,
    color: color.ink,
    backgroundColor: color.paperRaised,
    fontSize: 14,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: space.md,
  },
  chipScroll: {
    flexGrow: 0,
  },
  chipRow: {
    flexDirection: 'row',
    gap: space.xs,
    paddingBottom: space.xs,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paperRaised,
  },
  chipActive: {
    borderColor: color.signal,
    backgroundColor: color.signal + '12',
  },
  chipText: {
    ...t.stamp,
    color: color.mute,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  chipTextActive: {
    color: color.signal,
    fontWeight: '700',
  },
  starsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
  },
  ratingValue: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    marginLeft: space.xs,
  },
  errorBox: {
    marginTop: space.md,
    padding: space.md,
    backgroundColor: '#FEE2E2',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: {
    ...t.small,
    color: '#DC2626',
    fontSize: 13,
  },
  submitBtn: {
    marginTop: space.lg,
    backgroundColor: color.signal,
    borderRadius: radius.md,
    paddingVertical: space.md + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    ...t.bodyStrong,
    color: '#fff',
    fontSize: 15,
  },
  successBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
  },
  successEmoji: {
    fontSize: 48,
  },
  successTitle: {
    ...t.heading,
    color: color.ink,
    fontSize: 22,
    textAlign: 'center',
  },
  successDesc: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    lineHeight: 21,
  },
});

export default SubmitPlaceSheet;
