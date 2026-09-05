/**
 * YearbookScreen — the per-year Passport surface (spec §9 / Phase 9
 * "Intelligence": Travel DNA, yearbook, deeper Experience Graph).
 *
 * Renders the server's owner-private Yearbook projection
 * (`getPassportYearbook()` → `GET /api/passport/me/yearbook`): each year the
 * traveller has history for becomes a card of explainable LINES aggregated from
 * material that already exists elsewhere in the Passport — journeys, stamps,
 * memories and Travel DNA.
 *
 * TWO RULES THIS SCREEN EXISTS TO HONOUR
 * --------------------------------------
 *  1. NO UNEXPLAINED NUMBER. Every line renders its server-supplied evidence
 *     underneath the claim. A line that somehow arrived without evidence is not
 *     rendered at all rather than shown as a bare assertion — the screen would
 *     otherwise be the one place a number could appear unbacked.
 *  2. TRUTH BOUNDARY (§37). Each line carries `basis`. An `inferred` line (a
 *     Travel DNA shift) is drawn with an explicit "Inferred" pill and an
 *     "inferred, not recorded" evidence heading; an `observed` line is labelled
 *     as coming from records. A prediction is never dressed as an observation.
 *
 * PRIVACY (§23 / TABLE 25): every place here is COARSE — country and city names
 * only, exactly as the projection already carries them. There are no
 * coordinates in this payload and this screen renders none. All filtering
 * (blocked companions, private trips, hidden memories, suppressed DNA axes) is
 * already done server-side; the screen re-derives nothing (§30).
 *
 * The yearbook is the OWNER's own — it is not a viewer surface — so there is no
 * target-user prop and no share affordance here.
 */
import React from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  BookOpen,
  MapPin,
  Route as RouteIcon,
  Stamp,
  Images,
  Sparkles,
  Info,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import { useYearbook, type UseYearbookResult } from './useYearbook.ts';
import type {
  YearbookLine,
  YearbookLineKind,
  YearbookProjection,
  YearbookYear,
} from '../../services/passportProjection.ts';

// ── Line presentation ────────────────────────────────────────────────────────

const KIND_ICON: Record<YearbookLineKind, typeof MapPin> = {
  places: MapPin,
  journey: RouteIcon,
  stamp_milestone: Stamp,
  memories: Images,
  dna_shift: Sparkles,
};

const KIND_LABEL: Record<YearbookLineKind, string> = {
  places: 'Places',
  journey: 'Journey',
  stamp_milestone: 'Milestone',
  memories: 'Memories',
  dna_shift: 'Travel DNA',
};

/**
 * The evidence block. Its heading states WHAT KIND of claim this is, so an
 * inference can never read as a record (§37).
 */
function Evidence({ line }: { line: YearbookLine }) {
  const inferred = line.basis === 'inferred';
  return (
    <View style={s.evidence}>
      <View style={s.evidenceHead}>
        <Info size={icon.s14} color={color.faint} />
        <Text style={s.evidenceLabel}>
          {inferred ? 'Inferred from' : 'From your records'}
        </Text>
      </View>
      {line.evidence.map((e, i) => (
        <Text key={i} style={s.evidenceItem} testID={`yearbook-evidence-${line.key}-${i}`}>
          • {e}
        </Text>
      ))}
    </View>
  );
}

function LineCard({ line }: { line: YearbookLine }) {
  const Glyph = KIND_ICON[line.kind] ?? MapPin;
  const inferred = line.basis === 'inferred';
  return (
    <View style={s.line} testID={`yearbook-line-${line.key}`}>
      <View style={s.lineHead}>
        <View style={[s.lineIcon, inferred && s.lineIconInferred]}>
          <Glyph size={icon.s16} color={inferred ? color.warn : color.deep} />
        </View>
        <View style={s.lineTitleWrap}>
          <Text style={s.lineKind}>{KIND_LABEL[line.kind] ?? 'Detail'}</Text>
          <Text style={s.lineHeadline}>{line.headline}</Text>
        </View>
        {inferred ? (
          <View style={s.inferredPill} testID={`yearbook-inferred-${line.key}`}>
            <Text style={s.inferredPillText}>Inferred</Text>
          </View>
        ) : null}
      </View>
      <Evidence line={line} />
    </View>
  );
}

// ── Year card ────────────────────────────────────────────────────────────────

/** Coarse place summary chips — country/city names only (§23). */
function PlaceChips({ year }: { year: YearbookYear }) {
  const chips = [...year.countries, ...year.cities].slice(0, 12);
  if (chips.length === 0) return null;
  return (
    <View style={s.chips}>
      {chips.map((c) => (
        <View key={c} style={s.chip}>
          <Text style={s.chipText}>{c}</Text>
        </View>
      ))}
    </View>
  );
}

function YearCard({ year }: { year: YearbookYear }) {
  // A line with no evidence would be an unexplained claim — never render one.
  const lines = year.lines.filter((l) => l.evidence.length > 0 && l.headline.trim().length > 0);
  return (
    <View style={s.yearCard} testID={`yearbook-year-${year.year}`}>
      <View style={s.yearHead}>
        <Text style={s.yearNumber}>{year.year}</Text>
        <Text style={s.yearCounts}>
          {`${year.journeyCount} journeys · ${year.stampCount} stamps · ${year.memoryCount} memories`}
        </Text>
      </View>

      {year.empty || lines.length === 0 ? (
        <Text style={s.yearEmpty} testID={`yearbook-empty-${year.year}`}>
          {year.emptyMessage ?? `Nothing recorded for ${year.year}.`}
        </Text>
      ) : (
        <>
          <PlaceChips year={year} />
          <View style={s.lines}>
            {lines.map((l) => (
              <LineCard key={l.key} line={l} />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Assembling your yearbook…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <BookOpen size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load your yearbook</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

/** Explains a collection the server could not include, rather than under-counting silently. */
function IncludedNote({ included }: { included: YearbookProjection['included'] }) {
  const missing: string[] = [];
  if (!included.stamps) missing.push('stamps');
  if (!included.memories) missing.push('memories');
  if (!included.journeys) missing.push('journeys');
  if (missing.length === 0) return null;
  return (
    <Text style={s.includedNote} testID="yearbook-included-note">
      {`Not counted here: ${missing.join(', ')} — hidden by your passport visibility settings.`}
    </Text>
  );
}

// ── Screen ───────────────────────────────────────────────────────────────────

export interface YearbookScreenProps {
  /** Optional single year to load (defaults to every year with content). */
  year?: number | null;
  /** Test seam: inject a prebuilt yearbook to bypass the data hook. */
  yearbookOverride?: YearbookProjection;
}

export default function YearbookScreen({ year, yearbookOverride }: YearbookScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const hook: UseYearbookResult = useYearbook(year ?? null);

  const yearbook = yearbookOverride ?? hook.yearbook;
  const loading = yearbookOverride ? false : hook.loading;
  const error = yearbookOverride ? null : hook.error;
  const restricted = yearbookOverride ? false : hook.restricted;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.header}>
        <Pressable
          style={s.backBtn}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <ArrowLeft size={icon.s20} color={color.ink} />
        </Pressable>
        <View style={s.titleRow}>
          <BookOpen size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>Yearbook</Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.subtitle}>
          Your travel year by year — every line shows what it was built from
        </Text>

        {loading ? (
          <LoadingView />
        ) : error ? (
          <ErrorView message={error} onRetry={hook.reload} />
        ) : restricted ? (
          <View style={s.center}>
            <BookOpen size={icon.s26} color={color.faint} />
            <Text style={s.centerTitle}>Yearbooks are private</Text>
            <Text style={s.centerText}>
              A yearbook is only ever shown to the traveller it belongs to.
            </Text>
          </View>
        ) : !yearbook || yearbook.years.length === 0 ? (
          <View style={s.center} testID="yearbook-empty">
            <BookOpen size={icon.s26} color={color.faint} />
            <Text style={s.centerTitle}>No yearbook yet</Text>
            <Text style={s.centerText}>
              {yearbook?.emptyMessage ??
                'Your yearbook fills in as you take trips, earn stamps and save memories.'}
            </Text>
          </View>
        ) : (
          <>
            <View style={s.explainer}>
              <Sparkles size={icon.s14} color={color.warn} />
              <Text style={s.explainerText}>
                Lines marked “Inferred” are readings, not records — they show the activity
                they were read from. Everything else restates what your Passport already
                holds.
              </Text>
            </View>
            <IncludedNote included={yearbook.included} />
            <View style={s.years}>
              {yearbook.years.map((y) => (
                <YearCard key={y.year} year={y} />
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.paper },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    gap: space.sm,
  },
  backBtn: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  title: { ...t.title, fontSize: 17, color: color.ink },
  subtitle: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    paddingVertical: space.xs,
    paddingHorizontal: space.lg,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  explainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: 'rgba(200,133,26,0.08)',
  },
  explainerText: { ...t.small, color: color.mute, fontSize: 12, flexShrink: 1 },
  includedNote: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    fontStyle: 'italic',
  },

  years: { marginTop: space.lg, paddingHorizontal: space.lg, gap: space.lg },

  yearCard: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    padding: space.md,
    gap: space.sm,
  },
  yearHead: { gap: 2 },
  yearNumber: { ...t.title, color: color.ink, fontSize: 26, letterSpacing: -1 },
  yearCounts: { ...t.small, color: color.faint, fontSize: 12, fontFamily: 'Courier' },
  yearEmpty: { ...t.small, color: color.mute, fontSize: 13, fontStyle: 'italic' },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  chipText: { ...t.small, color: color.mute, fontSize: 11 },

  lines: { gap: space.md, marginTop: space.xs },
  line: {
    gap: space.xs,
    paddingTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: color.haze,
  },
  lineHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  lineIcon: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10,61,74,0.08)',
  },
  lineIconInferred: { backgroundColor: 'rgba(200,133,26,0.12)' },
  lineTitleWrap: { flex: 1, gap: 2 },
  lineKind: {
    ...t.small,
    color: color.faint,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontFamily: 'Courier',
  },
  lineHeadline: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  inferredPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(200,133,26,0.14)',
  },
  inferredPillText: { ...t.small, color: color.warn, fontSize: 10, fontWeight: '700' },

  evidence: { gap: 2, paddingLeft: avatar.s36 + space.sm },
  evidenceHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  evidenceLabel: {
    ...t.small,
    color: color.faint,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontFamily: 'Courier',
  },
  evidenceItem: { ...t.small, color: color.mute, fontSize: 12 },

  center: { alignItems: 'center', gap: space.sm, padding: space.xl, marginTop: space.xl },
  centerTitle: { ...t.heading, color: color.ink, fontSize: 17, textAlign: 'center' },
  centerText: { ...t.small, color: color.mute, textAlign: 'center' },
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: { ...t.small, color: color.deep, fontWeight: '600' },
});
