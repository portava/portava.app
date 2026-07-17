/**
 * PassportAboutSection — About / Languages / Travel Style / Interests
 * rendered as a passport dossier block. Hidden entirely when no data exists.
 */
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { OwnProfile, PublicProfile } from '../../types/models.ts';
import { PP, PP_LABEL, PP_VALUE } from '../../theme/passportTokens.ts';

type AnyProfile = OwnProfile | PublicProfile;

const INTEREST_LABEL: Record<string, string> = {
  nightlife: 'Nightlife', food: 'Food', beach: 'Beach', luxury: 'Luxury',
  culture: 'Culture', adventure: 'Adventure', wellness: 'Wellness',
  photography: 'Photography', backpacking: 'Backpacking', shopping: 'Shopping',
  business: 'Business', dating: 'Social', events: 'Events',
};

const INTEREST_COLORS = [
  '#2D5F3F', '#6B4C2A', '#3A2A5A', '#1A3A4A', '#4A2A1A',
  '#2A4A2A', '#5A2A2A', '#2A2A5A', '#4A3A1A',
];

interface FieldRowProps {
  label: string;
  value: string;
}

function DossierField({ label, value }: FieldRowProps) {
  return (
    <View style={f.row}>
      <View style={f.leftRule} />
      <View style={f.content}>
        <Text style={f.label}>{label}</Text>
        <Text style={f.value}>{value}</Text>
      </View>
    </View>
  );
}

const f = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 10,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
  },
  leftRule: {
    width: 2, borderRadius: 1,
    backgroundColor: PP.ink,
  },
  content: { flex: 1, gap: 2 },
  label: { ...PP_LABEL, fontSize: 8 },
  value: { ...PP_VALUE, fontSize: 13, lineHeight: 18 },
});

interface Props {
  profile: AnyProfile;
  isOwner?: boolean;
  onEdit?: () => void;
}

export function PassportAboutSection({ profile, isOwner, onEdit }: Props) {
  const bio = profile.bio;
  const interests = profile.interests ?? [];
  const travelStyle = profile.travelStyle;

  // Fields only available on OwnProfile
  const spokenLanguages = 'spokenLanguages' in profile
    ? (profile.spokenLanguages as string[] | null | undefined)
    : null;
  const travelStyles = 'travelStyles' in profile
    ? (profile.travelStyles as string[] | null | undefined)
    : null;
  const travelPace = 'travelPace' in profile
    ? (profile.travelPace as string | null | undefined)
    : null;

  const hasAnyData =
    !!bio ||
    interests.length > 0 ||
    !!travelStyle ||
    (spokenLanguages && spokenLanguages.length > 0) ||
    (travelStyles && travelStyles.length > 0) ||
    !!travelPace;

  if (!hasAnyData) return null;

  return (
    <View style={s.section}>
      {/* Section heading */}
      <View style={s.heading}>
        <View style={s.headingLeft}>
          <Text style={s.headingTitle}>ABOUT</Text>
          <View style={s.headingRule} />
        </View>
        {isOwner && onEdit ? (
          <Pressable onPress={onEdit} hitSlop={8}>
            <Text style={s.editLink}>Edit</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={s.fields}>
        {bio ? <DossierField label="Bio" value={bio} /> : null}

        {spokenLanguages && spokenLanguages.length > 0 ? (
          <DossierField label="Languages" value={spokenLanguages.join(' · ')} />
        ) : null}

        {(travelStyles && travelStyles.length > 0) ? (
          <DossierField label="Travel Style" value={travelStyles.join(', ')} />
        ) : travelStyle ? (
          <DossierField label="Travel Style" value={travelStyle} />
        ) : null}

        {travelPace ? (
          <DossierField label="Travel Pace" value={travelPace} />
        ) : null}
      </View>

      {/* Interests chips */}
      {interests.length > 0 ? (
        <View style={s.interestsBlock}>
          <Text style={[PP_LABEL, { fontSize: 8, marginBottom: 8 }]}>INTERESTS</Text>
          <View style={s.chips}>
            {interests.map((interest, i) => (
              <View
                key={interest}
                style={[s.chip, { backgroundColor: INTEREST_COLORS[i % INTEREST_COLORS.length] }]}
              >
                <Text style={s.chipText}>
                  {INTEREST_LABEL[interest] ?? interest}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    marginHorizontal: 16,
    backgroundColor: PP.paper,
    borderRadius: 10,
    borderWidth: 1, borderColor: PP.borderLight,
    overflow: 'hidden',
    padding: 14,
    gap: 12,
  },
  heading: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between',
  },
  headingLeft: {
    flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1,
  },
  headingTitle: { ...PP_LABEL, fontSize: 10, color: PP.ink, letterSpacing: 2 },
  headingRule: { flex: 1, height: 1, backgroundColor: PP.borderLight },
  editLink: { ...PP_LABEL, fontSize: 9, color: PP.inkLight, letterSpacing: 1 },
  fields: { gap: 0 },
  interestsBlock: { gap: 0 },
  chips: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
  },
  chip: {
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20,
  },
  chipText: {
    fontFamily: 'Courier',
    fontSize: 10, fontWeight: '700',
    color: 'rgba(248,243,232,0.9)',
    letterSpacing: 0.5,
  },
});
