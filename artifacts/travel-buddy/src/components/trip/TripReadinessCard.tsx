/**
 * TripReadinessCard — surfaces the Trip Readiness score on the trip detail page.
 *
 * • Critical items always shown above the score (never collapsed/hidden).
 * • Category rows show worst-status icon for each of the seven categories.
 * • Returns null when fetchTripReadiness returns null (flag off in prod).
 * • Accepts an optional `refresh` boolean that appends ?refresh=1 to the fetch.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  CheckCircle2,
  AlertCircle,
  Circle,
  HelpCircle,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { fetchTripReadiness, type ReadinessSummary, type ReadinessItem } from '../../services/tripIntel.ts';

interface TripReadinessCardProps {
  tripId: string;
  refresh?: boolean;
}

// The seven standard readiness categories (display order + labels)
const CATEGORIES: Array<{ key: string; label: string }> = [
  { key: 'plan',          label: 'Plan' },
  { key: 'stay',          label: 'Stay' },
  { key: 'transport',     label: 'Transport' },
  { key: 'budget',        label: 'Budget' },
  { key: 'entry',         label: 'Entry' },
  { key: 'documents',     label: 'Documents' },
  { key: 'reservations',  label: 'Reservations' },
];

type ItemStatus = ReadinessItem['status'];

// Severity order for worst-status computation
const STATUS_RANK: Record<ItemStatus, number> = {
  action_needed: 0,
  incomplete:    1,
  unknown:       2,
  ready:         3,
};

function worstStatus(items: ReadinessItem[]): ItemStatus | null {
  if (items.length === 0) return null;
  return items.reduce<ReadinessItem>(
    (worst, item) => STATUS_RANK[item.status] < STATUS_RANK[worst.status] ? item : worst,
    items[0],
  ).status;
}

function StatusIcon({ status }: { status: ItemStatus | null }) {
  if (!status || status === 'unknown') {
    return <HelpCircle size={16} color={color.mute} />;
  }
  if (status === 'ready') {
    return <CheckCircle2 size={16} color={color.success} />;
  }
  if (status === 'action_needed') {
    return <AlertCircle size={16} color={color.warn} />;
  }
  // incomplete
  return <Circle size={16} color={color.mute} />;
}

function CriticalItemRow({ item }: { item: ReadinessItem }) {
  const hasTap = !!item.actionRef;
  const content = (
    <View style={s.criticalRow}>
      <ShieldAlert size={14} color={color.warn} />
      <View style={{ flex: 1 }}>
        <Text style={s.criticalTitle}>{item.title}</Text>
        {item.detail ? <Text style={s.criticalDetail}>{item.detail}</Text> : null}
      </View>
      {hasTap && (
        <Text style={s.criticalCta}>Fix →</Text>
      )}
    </View>
  );

  if (hasTap) {
    return (
      <Pressable
        onPress={() => {
          const ref = item.actionRef as Record<string, unknown>;
          const href = (ref.href ?? ref.path ?? ref.route) as string | undefined;
          if (href) router.push(href as any);
        }}
      >
        {content}
      </Pressable>
    );
  }
  return content;
}

function CategoryRow({ label, status }: { label: string; status: ItemStatus | null }) {
  return (
    <View style={s.catRow}>
      <StatusIcon status={status} />
      <Text style={s.catLabel}>{label}</Text>
    </View>
  );
}

function ScoreHeader({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const scoreColor = pct >= 80 ? color.success : pct >= 50 ? color.warn : color.signal;
  return (
    <View style={s.scoreArea}>
      <Text style={[s.scoreNumber, { color: scoreColor }]}>{pct}%</Text>
      <Text style={s.scoreLabel}>Trip Readiness</Text>
    </View>
  );
}

export function TripReadinessCard({ tripId, refresh = false }: TripReadinessCardProps) {
  const [summary, setSummary] = useState<ReadinessSummary | null | undefined>(undefined); // undefined = loading
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    try {
      const res = await fetchTripReadiness(tripId, forceRefresh);
      setSummary(res); // null means flag off → render nothing
    } catch {
      setSummary(null); // network/unexpected error → treat same as feature flag off
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { load(refresh); }, [load, refresh]);

  if (loading || summary === undefined) {
    return (
      <View style={s.wrap}>
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  // null → feature flag off or error → render nothing
  if (summary === null) return null;

  // Build a map from category key → items
  const byCategory = new Map<string, ReadinessItem[]>();
  for (const item of summary.items) {
    const key = item.category.toLowerCase();
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(item);
  }

  return (
    <View style={s.wrap} testID="trip-readiness-card">
      {/* Critical items — always above the score */}
      {summary.criticalItems.length > 0 && (
        <View style={s.criticalSection}>
          {summary.criticalItems.map((item, i) => (
            <CriticalItemRow key={`${item.category}-${i}`} item={item} />
          ))}
        </View>
      )}

      {/* Score */}
      <ScoreHeader score={summary.score} />

      {/* Category rows */}
      <View style={s.categories}>
        {CATEGORIES.map(({ key, label }) => {
          const items = byCategory.get(key) ?? [];
          // Also check categories map from the summary (worst-status string)
          const summaryStatus = summary.categories[key] as ItemStatus | undefined;
          const status: ItemStatus | null = items.length > 0
            ? worstStatus(items)
            : summaryStatus ?? null;
          return <CategoryRow key={key} label={label} status={status} />;
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    marginHorizontal: space.lg,
    marginTop: space.md,
    backgroundColor: color.paperRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    ...shadow.card,
    overflow: 'hidden',
  },
  criticalSection: {
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
    paddingVertical: space.sm,
  },
  criticalRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  criticalTitle: {
    ...t.small,
    fontWeight: '600',
    color: color.ink,
  },
  criticalDetail: {
    ...t.stamp,
    color: color.mute,
    marginTop: 2,
  },
  criticalCta: {
    ...t.stamp,
    color: color.signal,
    fontWeight: '700',
    alignSelf: 'center',
  },
  scoreArea: {
    alignItems: 'center',
    paddingVertical: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  scoreNumber: {
    fontSize: 36,
    fontWeight: '800',
    lineHeight: 40,
    letterSpacing: -1,
  },
  scoreLabel: {
    ...t.stamp,
    color: color.mute,
    marginTop: space.xs,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  categories: {
    paddingVertical: space.sm,
  },
  catRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  catLabel: {
    ...t.body,
    color: color.ink,
  },
});
