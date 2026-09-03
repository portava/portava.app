/**
 * ContributionCard — the §20 Contribution reputation card (TABLE 21).
 *
 * Renders the traveler's POSITIVE contribution standing: contributor level,
 * accepted intel contributions, confirmations, hidden gems surfaced, and top
 * areas of expertise. It is a PURE, prop-driven component — all fetching and
 * normalisation happen upstream (passportContributions.ts), so the card can be
 * rendered from either the reputation route or the projection credentials
 * fallback with identical output, and unit-tested with no network.
 *
 * HARD RULES honoured here (§20):
 *   • Only positive, organic reputation is shown. There is no field for paid /
 *     purchased contributions, so paid activity can never appear as boosting
 *     confidence — the closed `ContributionProjection` shape has no such key.
 *   • No private moderation data (report-against-user counts, rejections, flags,
 *     safety history) — the card reads only the whitelisted TABLE-21 fields.
 *
 * Colour is never the only signal: every metric carries a glyph + text label
 * (§27). Palette matches the light "paper" passport surfaces (tokens.ts).
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Award, CheckCircle2, MapPin, Sparkles } from 'lucide-react-native';
import { color, space, radius, type as t, avatar, icon } from '../../theme/tokens.ts';
import {
  hasContributionSignal,
  type ContributionProjection,
} from '../../services/passportContributions.ts';

export interface ContributionCardProps {
  /** Already-normalised, privacy-filtered contribution reputation, or null. */
  data: ContributionProjection | null;
  /** Optional test seam / layout override. */
  testID?: string;
}

/** One metric tile — glyph + count + label. Rendered only for a real count. */
function Metric({
  glyph,
  count,
  label,
}: {
  glyph: React.ReactNode;
  count: number;
  label: string;
}) {
  return (
    <View style={s.metric} accessibilityLabel={`${count} ${label}`}>
      <View style={s.metricIcon}>{glyph}</View>
      <Text style={s.metricValue}>{count}</Text>
      <Text style={s.metricLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The §20 card. Returns null when there is no positive signal to show, so the
 * caller can render it unconditionally.
 */
export function ContributionCard({ data, testID }: ContributionCardProps) {
  if (!hasContributionSignal(data)) return null;
  const c = data as ContributionProjection;

  const metrics: Array<{ key: string; glyph: React.ReactNode; count: number; label: string }> = [];
  if ((c.acceptedReports ?? 0) > 0) {
    metrics.push({
      key: 'accepted',
      glyph: <CheckCircle2 size={icon.s16} color={color.success} />,
      count: c.acceptedReports as number,
      // TABLE 21 "accepted reports" = accepted intel contributions. Labelled
      // "Accepted tips" for travelers so it reads as a positive contribution
      // metric, never confusable with moderation reports.
      label: 'Accepted tips',
    });
  }
  if ((c.confirmations ?? 0) > 0) {
    metrics.push({
      key: 'confirmations',
      glyph: <Sparkles size={icon.s16} color={color.deep} />,
      count: c.confirmations as number,
      label: 'Confirmations',
    });
  }
  if ((c.hiddenGems ?? 0) > 0) {
    metrics.push({
      key: 'hidden',
      glyph: <MapPin size={icon.s16} color={color.warn} />,
      count: c.hiddenGems as number,
      label: 'Hidden gems',
    });
  }

  return (
    <View style={s.card} testID={testID ?? 'contribution-card'} accessibilityLabel="Contributions">
      {/* Header — level + title */}
      <View style={s.header}>
        <View style={s.headerIcon}>
          <Award size={icon.s18} color={color.warn} />
        </View>
        <View style={s.headerText}>
          <Text style={s.title}>Contributions</Text>
          {c.level ? (
            <Text style={s.levelText} numberOfLines={1}>
              {c.level}
            </Text>
          ) : (
            <Text style={s.subtitle} numberOfLines={1}>
              What you&apos;ve added to Portava
            </Text>
          )}
        </View>
      </View>

      {/* Metrics row */}
      {metrics.length > 0 ? (
        <View style={s.metricsRow}>
          {metrics.map((m) => (
            <Metric key={m.key} glyph={m.glyph} count={m.count} label={m.label} />
          ))}
        </View>
      ) : null}

      {/* Top expertise */}
      {c.topExpertise.length > 0 ? (
        <View style={s.expertise}>
          <Text style={s.expertiseTitle}>Top expertise</Text>
          <View style={s.chips}>
            {c.topExpertise.slice(0, 6).map((area) => (
              <View key={area} style={s.chip} accessibilityLabel={`Expertise: ${area}`}>
                <Text style={s.chipText} numberOfLines={1}>
                  {area}
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
  card: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    gap: space.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  headerIcon: {
    width: avatar.s36,
    height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(200,133,26,0.12)',
  },
  headerText: { flex: 1, gap: 1 },
  title: { ...t.bodyStrong, color: color.ink, fontSize: 15 },
  levelText: { ...t.small, color: color.warn, fontWeight: '700', fontSize: 12 },
  subtitle: { ...t.small, color: color.mute, fontSize: 12 },

  metricsRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  metric: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.paper,
    borderWidth: 1,
    borderColor: color.haze,
  },
  metricIcon: { marginBottom: 2 },
  metricValue: { ...t.title, fontSize: 20, color: color.ink },
  metricLabel: { ...t.small, color: color.mute, fontSize: 11, textAlign: 'center' },

  expertise: { gap: space.xs },
  expertiseTitle: {
    ...t.small,
    color: color.mute,
    fontFamily: 'Courier',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontSize: 11,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  chip: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(10,61,74,0.08)',
  },
  chipText: { ...t.small, color: color.deep, fontSize: 12, fontWeight: '600' },
});

export default ContributionCard;
