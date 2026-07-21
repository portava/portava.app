/**
 * CityConfidenceBadge — subtle "local data depth" indicator for a city.
 *
 * Surfaces GET /api/compass/city-confidence honesty in the Compass UI:
 *   • deep      → "Deep local data" pill
 *   • moderate  → "Growing local data" pill
 *   • thin      → "Still learning this city" pill + the honest note line
 *
 * Self-hides while loading, when no city is set, or when the fetch fails —
 * this is a trust signal, never a blocker.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Radar } from 'lucide-react-native';
import { color, space, radius } from '../../theme/tokens.ts';
import { fetchCityConfidence, type CityConfidence } from '../../services/compass.ts';

interface Props {
  city?: string | null;
}

const TIER_LABELS: Record<CityConfidence['tier'], string> = {
  deep:     'Deep local data',
  moderate: 'Growing local data',
  thin:     'Still learning this city',
};

const TIER_COLORS: Record<CityConfidence['tier'], string> = {
  deep:     color.signal,
  moderate: color.deep,
  thin:     color.mute,
};

export function CityConfidenceBadge({ city }: Props) {
  const [conf, setConf] = useState<CityConfidence | null>(null);

  useEffect(() => {
    let cancelled = false;
    setConf(null);
    if (!city || !city.trim()) return;
    fetchCityConfidence(city)
      .then((r) => {
        if (!cancelled && r.ok && r.data) setConf(r.data);
      })
      .catch(() => { /* self-hide on failure */ });
    return () => { cancelled = true; };
  }, [city]);

  if (!conf) return null;

  const tier = (conf.tier === 'deep' || conf.tier === 'moderate' || conf.tier === 'thin')
    ? conf.tier
    : 'thin';
  const tint = TIER_COLORS[tier];

  return (
    <View style={s.wrap} testID="city-confidence-badge">
      <View style={s.pill}>
        <Radar size={11} color={tint} />
        <Text style={[s.pillText, { color: tint }]}>{TIER_LABELS[tier]}</Text>
      </View>
      {tier === 'thin' && !!conf.note && (
        <Text style={s.note} numberOfLines={2}>{conf.note}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg,
    marginTop: space.xs,
    marginBottom: space.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: color.paperRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.haze,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '600',
  },
  note: {
    marginTop: 4,
    fontSize: 11,
    color: color.mute,
    lineHeight: 15,
  },
});
