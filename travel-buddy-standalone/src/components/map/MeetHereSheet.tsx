/**
 * MeetHereSheet — the §25 "Meet Here" flow.
 *
 * The action was on the rail and in the long-press menu with nowhere to go.
 * This is where it goes.
 *
 * A meeting point publishes a location to several people, so the rung it
 * publishes at is decided by `meetHereModel.proposeMeetHere` from the subject
 * the user tapped — never chosen here and never requested by the user. An
 * aggregate subject is refused outright with its reason shown, because "meet
 * where those 18 travellers are" is not a place and resolving it to a point
 * would sharpen an aggregate.
 *
 * The sheet performs the create itself (via services/meetups.createMeetup)
 * because a half-finished meeting point is worse than none: the user must see
 * it succeed or fail. Everything else — what may be published, at which rung,
 * to whom — is decided in the pure model.
 *
 * Dark-mode-first (§4) via the shared map-chrome palette.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, TextInput, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, Users, X as XIcon } from 'lucide-react-native';
import { mapChrome } from '../../theme/mapChrome.ts';
import { space, radius, type as t } from '../../theme/tokens.ts';
import { createMeetup, type MeetupVisibility } from '../../services/meetups.ts';
import {
  MEET_AUDIENCES,
  MEET_REFUSAL_TEXT,
  defaultAudienceFor,
  proposeMeetHere,
  type MeetAudience,
  type MeetTarget,
} from '../../features/map/meet/meetHereModel.ts';
import type { PrivacyClass } from '../../types/mapObjects.ts';

/**
 * §35's audience vocabulary mapped onto the meetup service's own visibility
 * union. They are different vocabularies on purpose — the telemetry describes
 * WHO the user chose, the service describes HOW the row is scoped — so the
 * mapping is stated here rather than assumed to be the same word.
 */
const AUDIENCE_VISIBILITY: Record<MeetAudience, MeetupVisibility> = {
  crew: 'trip',
  friends: 'friends',
  group: 'invitees',
  buddy: 'invitees',
};

const AUDIENCE_LABEL: Record<MeetAudience, string> = {
  crew: 'Trip crew',
  friends: 'Friends',
  group: 'Event group',
  buddy: 'Buddy',
};

/** How the rung reads to a person, so the disclosure is legible before they commit. */
const RUNG_NOTE: Partial<Record<PrivacyClass, string>> = {
  place_level: 'Shared as a named place.',
  approximate: 'Shared as an approximate area — this spot is only known roughly.',
};

export interface MeetHereSheetProps {
  /** What the user chose to meet at. `null` renders nothing. */
  target: MeetTarget | null;
  onClose: () => void;
  /**
   * Fired after a meeting point is actually created, with the rung it was
   * published at — §35's `meet_here_created` requires the ACTUAL rung, not the
   * one that was asked for.
   */
  onCreated?: (info: {
    meetupId: string | null;
    audience: MeetAudience;
    sharedAs: PrivacyClass;
    inviteeCount: number;
  }) => void;
}

export function MeetHereSheet({ target, onClose, onCreated }: MeetHereSheetProps) {
  const insets = useSafeAreaInsets();
  const decision = useMemo(() => (target ? proposeMeetHere(target) : null), [target]);

  const [title, setTitle] = useState('');
  const [audience, setAudience] = useState<MeetAudience>(
    target ? defaultAudienceFor(target) : 'friends',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!target || !decision) return null;

  // The refusal is shown, not hidden — the user tapped something and deserves
  // to know why it cannot anchor a meeting.
  if (!decision.ok) {
    return (
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Can’t meet here</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <XIcon size={18} color={mapChrome.textOnDarkMute} />
          </Pressable>
        </View>
        <Text style={styles.note}>{MEET_REFUSAL_TEXT[decision.reason]}</Text>
      </View>
    );
  }

  const { proposal } = decision;
  const effectiveTitle = title.trim() || proposal.title;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await createMeetup({
      title: effectiveTitle,
      // The model already decided this is a legible label rather than a
      // coordinate pair, at a rung the subject permits.
      locationName: proposal.title,
      visibility: AUDIENCE_VISIBILITY[audience],
    }).catch(() => null);
    setBusy(false);

    if (!res || !res.ok) {
      setError('Could not create the meeting point.');
      return;
    }
    onCreated?.({
      meetupId: (res.data as { id?: string } | null)?.id ?? null,
      audience,
      // The rung it ACTUALLY published at.
      sharedAs: proposal.sharedAs,
      inviteeCount: 0,
    });
    onClose();
  };

  return (
    <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Meet here</Text>
          <View style={styles.placeRow}>
            <MapPin size={13} color={mapChrome.textOnDarkMute} />
            <Text style={styles.place} numberOfLines={1}>{proposal.title}</Text>
          </View>
        </View>
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
          <XIcon size={18} color={mapChrome.textOnDarkMute} />
        </Pressable>
      </View>

      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder={`What’s the plan? (default: ${proposal.title})`}
        placeholderTextColor={mapChrome.textOnDarkFaint}
        accessibilityLabel="Meeting title"
      />

      <Text style={styles.sectionLabel}>WHO</Text>
      <View style={styles.audienceRow}>
        {MEET_AUDIENCES.map((a) => (
          <Pressable
            key={a}
            onPress={() => setAudience(a)}
            style={[styles.chip, a === audience && styles.chipActive]}
            accessibilityRole="button"
            accessibilityState={{ selected: a === audience }}
          >
            <Users size={12} color={a === audience ? '#fff' : mapChrome.textOnDarkMute} />
            <Text style={[styles.chipText, a === audience && styles.chipTextActive]}>
              {AUDIENCE_LABEL[a]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* The disclosure, stated before the user commits — §23. */}
      {RUNG_NOTE[proposal.sharedAs] ? (
        <Text style={styles.note}>{RUNG_NOTE[proposal.sharedAs]}</Text>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Pressable
        onPress={() => void submit()}
        disabled={busy}
        style={[styles.primary, busy && styles.primaryDisabled]}
        accessibilityRole="button"
        accessibilityLabel="Create the meeting point"
      >
        {busy ? <ActivityIndicator size="small" color="#fff" /> : (
          <Text style={styles.primaryText}>Create meeting point</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: mapChrome.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairline,
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  headerText: { flex: 1 },
  title: { ...t.heading, color: mapChrome.textOnDark },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  place: { ...t.small, color: mapChrome.textOnDarkMute, flex: 1 },
  input: {
    marginTop: space.md,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: mapChrome.surfaceInset,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: mapChrome.hairline,
    color: mapChrome.textOnDark,
    ...t.body,
  },
  sectionLabel: {
    ...t.small,
    color: mapChrome.textOnDarkMute,
    letterSpacing: 0.8,
    marginTop: space.lg,
    marginBottom: space.sm,
  },
  audienceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: mapChrome.surfaceInset,
  },
  chipActive: { backgroundColor: mapChrome.brand },
  chipText: { ...t.small, color: mapChrome.textOnDarkMute, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  note: { ...t.small, color: mapChrome.textOnDarkMute, marginTop: space.md },
  error: { ...t.small, color: mapChrome.signal, marginTop: space.md },
  primary: {
    marginTop: space.lg,
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: mapChrome.signal,
  },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { ...t.body, color: '#fff', fontWeight: '700' },
});

export default MeetHereSheet;
