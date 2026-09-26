/**
 * MediaContributionSheet — the composer of a §4 Media Contribution (spec §40
 * `MediaContributionSheet.tsx`; census-media §19: MD316).
 *
 * The contributor states, before anything is sent:
 *   • WHAT their perspective shows — the category the §12 perspective grouping
 *     really buckets by (no vantage the schema cannot store is offered);
 *   • WHO may see it — public or only them (§33);
 *   • HOW PRECISELY the place is shown — the place, the city only, only after
 *     they leave (§34 delayed publishing), or no location at all.
 * Every choice maps to a field of the existing post write; nothing here is a
 * control that goes nowhere. The media itself is shown as picked, and the
 * send button is disabled until there is something to send.
 */
import React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { color, radius, space } from '../../../theme/tokens.ts';
import { CachedImage } from '../../../components/CachedImage.tsx';
import {
  CONTRIBUTION_CATEGORIES,
  PRECISION_LABELS,
  type ContributionAction,
  type ContributionDraft,
  type ContributionPrecision,
} from '../state/mediaContribution.ts';

export interface MediaContributionSheetProps {
  placeName: string;
  draft: ContributionDraft;
  dispatch: (a: ContributionAction) => void;
  onPickMedia: () => void;
  onSubmit: () => void;
  /** Why the draft cannot be sent yet, or null. */
  blocker: string | null;
  busy: boolean;
}

const PRECISIONS: ContributionPrecision[] = ['venue', 'city_only', 'after_i_leave', 'hidden'];

export function MediaContributionSheet({
  placeName,
  draft,
  dispatch,
  onPickMedia,
  onSubmit,
  blocker,
  busy,
}: MediaContributionSheetProps) {
  return (
    <ScrollView contentContainerStyle={styles.content} testID="media-contribution-sheet" keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Add your view of {placeName}</Text>
      <Text style={styles.sub}>A current photo or clip becomes a perspective of this place. Location data inside the file is removed on upload.</Text>

      <Pressable
        style={styles.mediaSlot}
        onPress={onPickMedia}
        accessibilityRole="button"
        accessibilityLabel={draft.media ? 'Change photo or clip' : 'Add a photo or clip'}
        testID="media-contribution-pick"
      >
        {draft.media ? (
          <CachedImage source={{ uri: draft.media.uri }} style={styles.preview} resizeMode="cover" fallbackBg={color.mute} />
        ) : (
          <Text style={styles.mediaHint}>Add a photo or clip from here</Text>
        )}
      </Pressable>

      <Text style={styles.label}>What does it show?</Text>
      <View style={styles.chips}>
        {CONTRIBUTION_CATEGORIES.map((c) => (
          <Chip
            key={c.key}
            label={c.label}
            active={draft.category === c.key}
            testID={`media-contribution-category-${c.key}`}
            onPress={() => dispatch({ type: 'set_category', category: c.key })}
          />
        ))}
      </View>

      <Text style={styles.label}>Who can see it?</Text>
      <View style={styles.chips}>
        <Chip label="Everyone" active={draft.audience === 'public'} testID="media-contribution-audience-public" onPress={() => dispatch({ type: 'set_audience', audience: 'public' })} />
        <Chip label="Only me" active={draft.audience === 'private'} testID="media-contribution-audience-private" onPress={() => dispatch({ type: 'set_audience', audience: 'private' })} />
      </View>

      <Text style={styles.label}>How precisely is the place shown?</Text>
      <View style={styles.chips}>
        {PRECISIONS.map((p) => (
          <Chip
            key={p}
            label={PRECISION_LABELS[p]}
            active={draft.precision === p}
            testID={`media-contribution-precision-${p}`}
            onPress={() => dispatch({ type: 'set_precision', precision: p })}
          />
        ))}
      </View>

      <TextInput
        testID="media-contribution-note"
        style={styles.note}
        value={draft.note}
        onChangeText={(note) => dispatch({ type: 'set_note', note })}
        placeholder="What's it like right now? (optional)"
        placeholderTextColor={color.faint}
        multiline
        maxLength={280}
      />

      {blocker ? <Text style={styles.blocker}>{blocker}</Text> : null}

      <Pressable
        style={[styles.submit, (blocker != null || busy) && styles.submitDisabled]}
        disabled={blocker != null || busy}
        onPress={onSubmit}
        accessibilityRole="button"
        accessibilityState={{ disabled: blocker != null || busy }}
        testID="media-contribution-submit"
      >
        {busy ? <ActivityIndicator color={color.ink} /> : <Text style={styles.submitText}>Share this perspective</Text>}
      </Pressable>
    </ScrollView>
  );
}

function Chip({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xxxl },
  title: { color: color.onInk, fontSize: 20, fontWeight: '800', letterSpacing: -0.4 },
  sub: { color: color.onInkMute, fontSize: 13, lineHeight: 18 },
  mediaSlot: {
    height: 200,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  preview: { width: '100%', height: '100%' },
  mediaHint: { color: color.onInkMute, fontSize: 14, fontWeight: '700' },
  label: { color: color.onInkMute, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginTop: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: 'rgba(250,249,246,0.08)' },
  chipActive: { backgroundColor: color.onInk },
  chipText: { color: color.onInkMute, fontSize: 13, fontWeight: '700' },
  chipTextActive: { color: color.ink },
  note: {
    minHeight: 72,
    color: color.onInk,
    fontSize: 15,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(250,249,246,0.06)',
    textAlignVertical: 'top',
  },
  blocker: { color: color.onInkMute, fontSize: 12 },
  submit: {
    marginTop: space.sm,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: color.onInk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitDisabled: { opacity: 0.4 },
  submitText: { color: color.ink, fontSize: 15, fontWeight: '800' },
});
