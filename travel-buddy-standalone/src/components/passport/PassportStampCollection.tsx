/**
 * PassportStampCollection — MY STAMPS section in passport document style.
 * Horizontal scrollable stamp strip with category filter pills + View All link.
 * Accepts legacy PassportStamp[] from usePassport().stamps.
 */
import React, { useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, Image,
} from 'react-native';
import { Compass, ShieldCheck, PenLine, Sparkles } from 'lucide-react-native';
import type { PassportStamp, StampVerification } from '../../types/models.ts';
import { PP, PP_LABEL, PP_VALUE, fmtMonthYear } from '../../theme/passportTokens.ts';
import { avatar, dot } from '../../theme/tokens.ts';
import { trackStampViewed } from '../../features/passport/passportTelemetry.ts';

type StampFilter = 'all' | 'cities' | 'special';

interface Props {
  stamps: PassportStamp[];
  isOwner?: boolean;
  onViewAll?: () => void;
  onStampPress?: (stamp: PassportStamp) => void;
}

const FILTERS: { key: StampFilter; label: string }[] = [
  { key: 'all',     label: 'All' },
  { key: 'cities',  label: 'Cities' },
  { key: 'special', label: 'Special' },
];

function filterStamps(stamps: PassportStamp[], filter: StampFilter): PassportStamp[] {
  const unlocked = stamps.filter((s) => !s.locked);
  if (filter === 'cities')  return unlocked.filter((s) => s.kind === 'city');
  if (filter === 'special') return unlocked.filter((s) => s.kind !== 'city');
  return unlocked;
}

/** Per-kind accent colors in passport palette */
function kindAccent(kind: PassportStamp['kind']): string {
  switch (kind) {
    case 'city':   return '#2D5F3F';  // PP.inkLight
    case 'plan':   return '#1A3A2A';  // PP.ink
    case 'gem':    return '#6B4C2A';  // warm ochre
    case 'safe':   return '#2A4A3A';
    case 'host':   return '#3A2A5A';
    case 'perk':   return '#4A1A2A';
    default:       return '#1A3A2A';
  }
}

/**
 * §12 verification treatment. `verification` is optional on legacy stamps; an
 * absent value is treated as 'decorative' so a stamp of unknown provenance can
 * never read as verified.
 */
const VERIFICATION_META: Record<
  StampVerification,
  { label: string; color: string; Icon: typeof ShieldCheck }
> = {
  verified:   { label: 'Verified',      color: '#2E7D5B', Icon: ShieldCheck },
  reported:   { label: 'Self-reported', color: '#B4791F', Icon: PenLine },
  decorative: { label: 'Decorative',    color: PP.inkMuted, Icon: Sparkles },
};

function stampVerification(stamp: PassportStamp): StampVerification {
  return stamp.verification ?? 'decorative';
}

/**
 * A small corner badge announcing the stamp's provenance treatment (§12). Colour
 * is paired with a distinct glyph and an accessibility label so it is never the
 * only signal (§27), and only 'verified' wears the green shield — a self-reported
 * or decorative stamp can never impersonate a verified one.
 */
function VerificationMark({ verification }: { verification: StampVerification }) {
  const meta = VERIFICATION_META[verification];
  const Icon = meta.Icon;
  return (
    <View
      style={[vm.badge, { backgroundColor: meta.color }]}
      accessibilityLabel={`${meta.label} stamp`}
    >
      <Icon size={8} color={PP.paper} strokeWidth={2.5} />
    </View>
  );
}

function StampChit({ stamp, onPress }: { stamp: PassportStamp; onPress?: () => void }) {
  const accent = kindAccent(stamp.kind);
  const [artFailed, setArtFailed] = useState(false);
  const showArt = !!stamp.universalArtworkUrl && !artFailed;
  const verification = stampVerification(stamp);
  const handlePress = () => {
    // §32 stamp_viewed — ids/enums only, never the stamp label text.
    trackStampViewed({ stampId: stamp.id, kind: stamp.kind, verification });
    onPress?.();
  };
  return (
    <Pressable
      style={({ pressed }) => [ch.card, pressed && { opacity: 0.8 }]}
      onPress={handlePress}
      accessibilityLabel={`${stamp.label} stamp, ${VERIFICATION_META[verification].label}`}
    >
      {/* Top artwork area — AI artwork when available, colored placeholder otherwise */}
      {showArt ? (
        <View style={[ch.artArea, { backgroundColor: accent, padding: 0 }]}>
          <Image
            source={{ uri: stamp.universalArtworkUrl }}
            style={ch.artImage}
            resizeMode="cover"
            onError={() => setArtFailed(true)}
            accessibilityIgnoresInvertColors
          />
        </View>
      ) : (
        <View style={[ch.artArea, { backgroundColor: accent }]}>
          <View style={ch.artInnerRing} />
          <Text style={ch.artLabel} numberOfLines={2}>{stamp.label}</Text>
          {stamp.sublabel ? (
            <Text style={ch.artSublabel} numberOfLines={1}>{stamp.sublabel}</Text>
          ) : null}
        </View>
      )}
      {/* §12 provenance treatment — verified never looks the same as reported/decorative. */}
      <VerificationMark verification={verification} />
      {/* Bottom label strip */}
      <View style={ch.labelStrip}>
        <Text style={ch.labelText} numberOfLines={1}>
          {stamp.label}
        </Text>
        {stamp.earnedAt ? (
          <Text style={ch.dateText} numberOfLines={1}>
            {fmtMonthYear(stamp.earnedAt)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const vm = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.85)',
  },
});

function EmptyChit({ onViewAll }: { onViewAll?: () => void }) {
  return (
    <Pressable style={em.card} onPress={onViewAll}>
      <Compass size={22} color={PP.inkMuted} strokeWidth={1.5} />
      <Text style={em.title}>Collect stamps</Text>
      <Text style={em.sub}>Visit places to earn your first stamp</Text>
    </Pressable>
  );
}

export function PassportStampCollection({ stamps, isOwner, onViewAll, onStampPress }: Props) {
  const [filter, setFilter] = useState<StampFilter>('all');
  const shown = filterStamps(stamps, filter).slice(0, 8);
  const totalUnlocked = stamps.filter((s) => !s.locked).length;

  return (
    <View style={s.section}>
      {/* Section header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.sectionTitle}>MY STAMPS</Text>
          {totalUnlocked > 0 ? (
            <View style={s.countBadge}>
              <Text style={s.countText}>{totalUnlocked}</Text>
            </View>
          ) : null}
        </View>
        {onViewAll ? (
          <Pressable onPress={onViewAll} hitSlop={8}>
            <Text style={s.viewAll}>View All →</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Category filter pills */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.filtersContent}
        style={s.filtersRow}
      >
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[s.pill, filter === f.key && s.pillActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[s.pillText, filter === f.key && s.pillTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* Stamp strip */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.rail}
      >
        {shown.length === 0 ? (
          <EmptyChit onViewAll={onViewAll} />
        ) : (
          <>
            {shown.map((stamp) => (
              <StampChit
                key={stamp.id}
                stamp={stamp}
                onPress={() => onStampPress?.(stamp)}
              />
            ))}
            {/* Remaining teaser */}
            {totalUnlocked > 8 ? (
              <Pressable style={more.card} onPress={onViewAll}>
                <Text style={more.count}>+{totalUnlocked - 8}</Text>
                <Text style={more.label}>more</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const CHIT_W = 72;
const CHIT_H = 90;
const ART_H = 60;

const ch = StyleSheet.create({
  card: {
    width: CHIT_W, height: CHIT_H,
    borderRadius: 10,
    backgroundColor: PP.paper,
    borderWidth: 1, borderColor: PP.border,
    overflow: 'hidden',
    shadowColor: PP.ink,
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  artArea: {
    height: ART_H,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    padding: 6,
  },
  artImage: {
    width: '100%',
    height: '100%',
  },
  artInnerRing: {
    position: 'absolute',
    width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  artLabel: {
    fontFamily: 'Courier', fontSize: 8, fontWeight: '800',
    color: 'rgba(248,243,232,0.9)', textAlign: 'center',
    letterSpacing: 0.5, lineHeight: 10, zIndex: 1,
  },
  artSublabel: {
    fontFamily: 'Courier', fontSize: 6.5, color: 'rgba(248,243,232,0.6)',
    textAlign: 'center', letterSpacing: 0.3, zIndex: 1,
  },
  labelStrip: {
    flex: 1, paddingHorizontal: 4, paddingVertical: 3,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: PP.paper, gap: 1,
  },
  labelText: {
    ...PP_LABEL, fontSize: 7, color: PP.ink, textAlign: 'center',
    letterSpacing: 0.8,
  },
  dateText: {
    fontFamily: 'Courier', fontSize: 6, color: PP.inkMuted,
    textAlign: 'center', letterSpacing: 0.3,
  },
});

const em = StyleSheet.create({
  card: {
    width: 160, height: CHIT_H,
    borderRadius: 10,
    borderWidth: 1.5, borderColor: PP.borderLight, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 12, gap: 4,
    backgroundColor: PP.paperDeep,
  },
  title: { ...PP_LABEL, color: PP.inkMuted, letterSpacing: 1.5, fontSize: 8 },
  sub: {
    fontSize: 10, color: PP.inkMuted, textAlign: 'center', lineHeight: 13,
  },
});

const more = StyleSheet.create({
  card: {
    width: 52, height: CHIT_H,
    borderRadius: 10,
    borderWidth: 1, borderColor: PP.borderLight, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center',
    gap: 2, backgroundColor: PP.paperDeep,
  },
  count: { fontSize: 15, fontWeight: '800', color: PP.inkMuted },
  label: { ...PP_LABEL, fontSize: 7.5, color: PP.inkMuted, letterSpacing: 1 },
});

const s = StyleSheet.create({
  section: { paddingBottom: 4 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, marginBottom: 10,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionTitle: { ...PP_LABEL, fontSize: 10, letterSpacing: 2, color: PP.ink },
  countBadge: {
    backgroundColor: PP.ink, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  countText: { ...PP_LABEL, fontSize: 7.5, color: PP.paper, letterSpacing: 0.5 },
  viewAll: { ...PP_LABEL, fontSize: 9, color: PP.inkLight, letterSpacing: 1.2 },

  filtersRow: { marginBottom: 10 },
  filtersContent: { paddingHorizontal: 16, gap: 6 },
  pill: {
    paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 20, borderWidth: 1, borderColor: PP.borderLight,
    backgroundColor: PP.paperDeep,
  },
  pillActive: { backgroundColor: PP.ink, borderColor: PP.ink },
  pillText: { ...PP_LABEL, fontSize: 8.5, color: PP.inkMuted, letterSpacing: 1 },
  pillTextActive: { color: PP.paper },

  rail: {
    paddingLeft: 16, paddingRight: 16,
    gap: 8, alignItems: 'center', paddingBottom: 4,
  },
});
