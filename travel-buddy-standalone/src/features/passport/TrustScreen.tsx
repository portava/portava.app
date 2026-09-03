/**
 * TrustScreen — the Passport Trust & Credentials surface (spec §9/§10/§11,
 * TABLE 12/13/14).
 *
 * Renders the SERVER-projected trust summary: the qualitative label and the
 * evidence-aware confidence band always; the 0–100 numeric score ONLY where the
 * server chose to expose it (self / permitted view, §9). Below that: the
 * domain-specific trust categories (TABLE 12), the positive credentials list
 * (TABLE 13) and the positive capability chips (TABLE 14).
 *
 * HARD RULES honoured here:
 *   • Never render private report counts, moderation evidence or safety history
 *     (§10) — the screen only ever reads the whitelisted positive fields the
 *     projection carries.
 *   • The numeric score is shown only when `trust.score` is a number (self /
 *     permitted view); otherwise the qualitative label stands alone.
 *   • The client does NOT infer authorization from the score (§11): capability
 *     chips and domain applicability come from server-owned capability flags.
 *
 * Palette matches the light "paper" passport surfaces (MyWorldScreen /
 * passport/country): green (`color.success`) for verified/positive trust, teal
 * (`color.deep`) for accents, gold (`color.warn`) for earned reputation. Colour
 * is never the only status indicator — every state carries text + iconography
 * (§27).
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
  ShieldCheck,
  ShieldHalf,
  Gauge,
  Plane,
  Users,
  Handshake,
  Sparkles,
  Compass,
  Fingerprint,
  CalendarCheck,
  Star,
  BadgeCheck,
  Info,
} from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  useTrustProjection,
  deriveTrustView,
  NOT_APPLICABLE,
  type TrustProjectionEnvelope,
  type TrustView,
  type TrustDomainRow,
  type CredentialProjection,
} from './useTrustProjection.ts';
import { useContributions } from './useContributions.ts';
import { ContributionCard } from './ContributionCard.tsx';
import {
  contributionsFromCredentials,
  hasContributionSignal,
  type ContributionProjection,
} from '../../services/passportContributions.ts';

// ── Icon helpers ─────────────────────────────────────────────────────────────

type IconCmp = typeof ShieldCheck;

/** Domain → glyph (TABLE 12). */
function domainIcon(key: string): IconCmp {
  switch (key) {
    case 'overall': return Gauge;
    case 'traveler': return Plane;
    case 'trip_guest': return Users;
    case 'trip_host': return Handshake;
    case 'contributor': return Sparkles;
    case 'buddy': return Compass;
    default: return ShieldCheck;
  }
}

/** Credential key → glyph (TABLE 13). */
function credentialIcon(cred: CredentialProjection): IconCmp {
  if (cred.key === 'identity') return Fingerprint;
  if (cred.key === 'established') return CalendarCheck;
  if (cred.key === 'trip_experience') return Plane;
  if (cred.key.startsWith('strength_')) return Star;
  return BadgeCheck;
}

// ── Score hero ───────────────────────────────────────────────────────────────

function ScoreHero({ view }: { view: TrustView }) {
  return (
    <View style={s.hero} accessibilityLabel="Trust summary">
      <View style={s.heroBadge}>
        <ShieldCheck size={icon.s22} color={color.success} />
      </View>

      {view.hasScore ? (
        <View style={s.scoreRow} accessibilityLabel={`Trust score ${view.score} out of 100`}>
          <Text style={s.scoreValue}>{view.score}</Text>
          <Text style={s.scoreDenom}>/ 100</Text>
        </View>
      ) : null}

      <Text style={s.heroLabel} numberOfLines={2}>
        {view.label}
      </Text>

      {/* Confidence awareness (§10): the evidence level, not just the number. */}
      <View style={s.confidence} accessibilityLabel={`Confidence: ${view.confidenceLabel}`}>
        <Gauge size={icon.s14} color={color.deep} />
        <Text style={s.confidenceLabel}>{view.confidenceLabel}</Text>
      </View>
      <Text style={s.confidenceCopy}>{view.confidenceCopy}</Text>
    </View>
  );
}

// ── Domain trust (TABLE 12) ──────────────────────────────────────────────────

function DomainRow({ row }: { row: TrustDomainRow }) {
  const Glyph = domainIcon(row.key);
  return (
    <View
      style={s.domainRow}
      accessibilityLabel={`${row.domain}: ${row.standing}`}
    >
      <Glyph size={icon.s16} color={row.applicable ? color.deep : color.faint} />
      <Text style={[s.domainName, !row.applicable && s.domainNameMuted]} numberOfLines={1}>
        {row.domain}
      </Text>
      <View
        style={[s.standingPill, row.applicable ? s.standingPillOn : s.standingPillOff]}
      >
        <Text
          style={[s.standingText, row.applicable ? s.standingTextOn : s.standingTextOff]}
          numberOfLines={1}
        >
          {row.standing}
        </Text>
      </View>
    </View>
  );
}

// ── Credential (TABLE 13) ────────────────────────────────────────────────────

function CredentialRow({ cred }: { cred: CredentialProjection }) {
  const Glyph = credentialIcon(cred);
  const verified = cred.tier === 'verified';
  return (
    <View style={s.credRow} accessibilityLabel={`${cred.label}${cred.detail ? ` — ${cred.detail}` : ''}`}>
      <View style={[s.credIcon, verified ? s.credIconVerified : s.credIconPositive]}>
        <Glyph size={icon.s16} color={verified ? color.success : color.deep} />
      </View>
      <View style={s.credText}>
        <Text style={s.credLabel} numberOfLines={1}>{cred.label}</Text>
        {cred.detail ? (
          <Text style={s.credDetail} numberOfLines={1}>{cred.detail}</Text>
        ) : null}
      </View>
      {verified ? (
        <BadgeCheck size={icon.s16} color={color.success} accessibilityLabel="Verified" />
      ) : null}
    </View>
  );
}

// ── Capability chips (TABLE 14) ──────────────────────────────────────────────

function CapabilityChips({ view }: { view: TrustView }) {
  return (
    <View style={s.chips}>
      {view.capabilityChips.map((chip) => (
        <View key={chip.key} style={s.chip} accessibilityLabel={chip.label}>
          <BadgeCheck size={icon.s14} color={color.success} />
          <Text style={s.chipText}>{chip.label}</Text>
        </View>
      ))}
    </View>
  );
}

// ── Section header ───────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={s.sectionTitle}>{children}</Text>;
}

// ── State views ──────────────────────────────────────────────────────────────

function LoadingView() {
  return (
    <View style={s.center}>
      <ActivityIndicator color={color.signal} />
      <Text style={s.centerText}>Loading your trust summary…</Text>
    </View>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.center}>
      <ShieldHalf size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Couldn&apos;t load trust</Text>
      <Text style={s.centerText}>{message}</Text>
      <Pressable style={s.retryBtn} onPress={onRetry} accessibilityRole="button">
        <Text style={s.retryText}>Tap to retry</Text>
      </Pressable>
    </View>
  );
}

/** Shown when the projection loaded but the server did not include trust for
 *  this viewer (e.g. trust not permitted in this context). */
function UnavailableView() {
  return (
    <View style={s.center}>
      <ShieldHalf size={icon.s26} color={color.faint} />
      <Text style={s.centerTitle}>Trust summary isn&apos;t available</Text>
      <Text style={s.centerText}>
        This traveler&apos;s trust details aren&apos;t shown in this view.
      </Text>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────────────────────────

export interface TrustScreenProps {
  /** Optional target user (UUID / @handle). Defaults to the signed-in user. */
  userId?: string;
  /** Test seam: inject a prebuilt projection to bypass the data hook. */
  projectionOverride?: TrustProjectionEnvelope;
  /** Test seam: inject prebuilt contribution reputation (bypasses the fetch). */
  contributionsOverride?: ContributionProjection | null;
}

export default function TrustScreen({
  userId,
  projectionOverride,
  contributionsOverride,
}: TrustScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const hook = useTrustProjection(userId);

  const projection = projectionOverride ?? hook.projection;
  const loading = projectionOverride ? false : hook.loading;
  const error = projectionOverride ? null : hook.error;

  const view: TrustView | null = projection ? deriveTrustView(projection) : null;

  // §20 contribution reputation. Prefer the dedicated reputation route; fall
  // back to the contribution-relevant credentials the projection already
  // carries. The fetch is disabled whenever a test seam is supplied so
  // override-driven renders stay fully inert (no network, no async setState).
  const contribHook = useContributions(userId, {
    enabled: !projectionOverride && contributionsOverride === undefined,
  });
  const contributions: ContributionProjection | null =
    contributionsOverride !== undefined
      ? contributionsOverride
      : contribHook.contributions ?? contributionsFromCredentials(projection?.credentials);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
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
          <ShieldCheck size={icon.s16} color={color.deep} />
          <Text style={s.title} numberOfLines={1}>
            Trust & Credentials
          </Text>
        </View>
        <View style={s.backBtn} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollContent, { paddingBottom: insets.bottom + space.xxl }]}
        showsVerticalScrollIndicator={false}
      >
        {loading ? (
          <LoadingView />
        ) : error ? (
          <ErrorView message={error} onRetry={hook.reload} />
        ) : !view || !view.hasTrust ? (
          <UnavailableView />
        ) : (
          <>
            <ScoreHero view={view} />

            {/* Domain-specific trust (§9, TABLE 12) */}
            <SectionTitle>Trust by area</SectionTitle>
            <View style={s.card}>
              {view.domains.map((row) => (
                <DomainRow key={row.key} row={row} />
              ))}
            </View>

            {/* Positive credentials (TABLE 13) */}
            {view.credentials.length > 0 ? (
              <>
                <SectionTitle>Credentials</SectionTitle>
                <View style={s.card}>
                  {view.credentials.map((cred) => (
                    <CredentialRow key={cred.key} cred={cred} />
                  ))}
                </View>
              </>
            ) : null}

            {/* Contribution reputation (§20, TABLE 21) — positive, organic only.
                Paid contributions and private moderation data are never part of
                the ContributionProjection shape, so they can't surface here. The
                card is self-contained (its own heading), so no SectionTitle. */}
            {hasContributionSignal(contributions) ? (
              <ContributionCard data={contributions} />
            ) : null}

            {/* Positive capabilities (TABLE 14) */}
            {view.capabilityChips.length > 0 ? (
              <>
                <SectionTitle>What this unlocks</SectionTitle>
                <CapabilityChips view={view} />
              </>
            ) : null}

            {/* §11: server owns authorization — the client never infers it. */}
            <View style={s.note}>
              <Info size={icon.s14} color={color.mute} />
              <Text style={s.noteText}>
                Portava decides what each capability unlocks. These reflect your
                current standing — they aren&apos;t a score you can act on yourself.
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: color.paper,
  },
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
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingTop: space.sm },

  // Hero
  hero: {
    alignItems: 'center',
    marginHorizontal: space.lg,
    marginTop: space.md,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    gap: space.xs,
  },
  heroBadge: {
    width: avatar.s44,
    height: avatar.s44,
    borderRadius: avatar.s44 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(46,125,91,0.10)',
    marginBottom: space.xs,
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.xs,
  },
  scoreValue: {
    ...t.hero,
    fontSize: 44,
    lineHeight: 46,
    color: color.ink,
  },
  scoreDenom: {
    ...t.small,
    color: color.faint,
    fontFamily: 'Courier',
    marginBottom: 6,
  },
  heroLabel: {
    ...t.heading,
    color: color.deep,
    textAlign: 'center',
  },
  confidence: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(10,61,74,0.08)',
  },
  confidenceLabel: {
    ...t.small,
    color: color.deep,
    fontWeight: '700',
    fontSize: 12,
  },
  confidenceCopy: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
    marginTop: space.xs,
    paddingHorizontal: space.sm,
  },

  // Section
  sectionTitle: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
    marginTop: space.xl,
    marginBottom: space.sm,
    marginHorizontal: space.lg,
  },
  card: {
    marginHorizontal: space.lg,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },

  // Domain rows
  domainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  domainName: {
    ...t.body,
    flex: 1,
    color: color.ink,
    fontSize: 15,
  },
  domainNameMuted: {
    color: color.faint,
  },
  standingPill: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  standingPillOn: {
    backgroundColor: 'rgba(46,125,91,0.10)',
  },
  standingPillOff: {
    backgroundColor: color.haze,
  },
  standingText: {
    ...t.small,
    fontSize: 12,
    fontWeight: '700',
  },
  standingTextOn: {
    color: color.success,
  },
  standingTextOff: {
    color: color.faint,
    fontWeight: '600',
  },

  // Credentials
  credRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  credIcon: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  credIconVerified: {
    backgroundColor: 'rgba(46,125,91,0.10)',
  },
  credIconPositive: {
    backgroundColor: 'rgba(10,61,74,0.08)',
  },
  credText: {
    flex: 1,
    gap: 1,
  },
  credLabel: {
    ...t.bodyStrong,
    color: color.ink,
    fontSize: 15,
  },
  credDetail: {
    ...t.small,
    color: color.mute,
    fontSize: 12,
  },

  // Capability chips
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginHorizontal: space.lg,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  chipText: {
    ...t.small,
    color: color.ink,
    fontWeight: '600',
    fontSize: 13,
  },

  // Footer note
  note: {
    flexDirection: 'row',
    gap: space.xs,
    marginHorizontal: space.lg,
    marginTop: space.xl,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.md,
    backgroundColor: color.paperRaised,
    borderWidth: 1,
    borderColor: color.haze,
  },
  noteText: {
    ...t.small,
    color: color.mute,
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 17,
  },

  // States
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: space.xxxl,
    paddingHorizontal: space.xl,
    gap: space.sm,
  },
  centerTitle: {
    ...t.bodyStrong,
    color: color.ink,
    marginTop: space.xs,
  },
  centerText: {
    ...t.small,
    color: color.mute,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
  },
  retryText: {
    ...t.bodyStrong,
    color: color.signal,
    fontSize: 14,
  },
});
