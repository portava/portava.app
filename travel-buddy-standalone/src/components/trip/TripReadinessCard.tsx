/**
 * TripReadinessCard — surfaces the Trip Readiness score on the trip detail page.
 *
 * • Critical items always shown above the score (never collapsed/hidden).
 * • Category rows show worst-status icon for each of the seven categories.
 * • Renders nothing when readiness is `off` (not configured / flag off).
 * • Renders an honest "couldn't be checked" row when the read is `unavailable`
 *   — this card is a risk report, and a risk report that failed to load is not
 *   a report with no risks in it. It used to render nothing for both.
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
  TrendingUp,
  TrendingDown,
  Minus,
} from 'lucide-react-native';
import { color, space, radius, type as t, shadow } from '../../theme/tokens.ts';
import { fetchTripReadiness, type ReadinessRead, type ReadinessSummary, type ReadinessItem } from '../../services/tripIntel.ts';

interface TripReadinessCardProps {
  tripId: string;
  refresh?: boolean;
  /**
   * QA round 2, bug 2. The trip header's "Trip Progress" ring used to read
   * `trips.progress` — a column no client call site ever writes, so it was
   * permanently 0 — while this card rendered the readiness score (14%). Two
   * gauges on one screen, two different numbers. Reporting the summary upward
   * lets the header render the SAME source.
   *
   * It receives the whole `ReadinessRead`, not a nullable summary, because the
   * header has to tell `off` from `unavailable` too: on `off` it may fall back
   * to the legacy `trips.progress` column, and on `unavailable` it may not —
   * that fallback is how a failed read used to become a 0% progress ring.
   */
  onSummary?: (read: ReadinessRead) => void;
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

function ScoreDelta({ current, previous }: { current: number; previous: number }) {
  // scores are integers (0–100); delta is in percentage points
  const delta = Math.round(current) - Math.round(previous);
  if (delta === 0) {
    return (
      <View style={s.deltaRow}>
        <Minus size={12} color={color.mute} />
        <Text style={[s.deltaText, { color: color.mute }]}>no change since yesterday</Text>
      </View>
    );
  }
  const isUp = delta > 0;
  const deltaColor = isUp ? color.success : color.signal;
  const sign = isUp ? '+' : '';
  return (
    <View style={s.deltaRow}>
      {isUp
        ? <TrendingUp size={12} color={deltaColor} />
        : <TrendingDown size={12} color={deltaColor} />}
      <Text style={[s.deltaText, { color: deltaColor }]}>
        {sign}{delta}% since yesterday
      </Text>
    </View>
  );
}

function ScoreHeader({
  score,
  previousScore,
  unmeasured,
}: {
  score: number | null;
  previousScore: number | null;
  unmeasured: string[];
}) {
  // A null score means NOTHING could be measured. Rendering 0% there would be
  // a confident "you are not ready at all" derived from nothing at all.
  if (score === null) {
    return (
      <View style={s.scoreArea}>
        <Text style={[s.scoreNumber, { color: color.mute }]}>—</Text>
        <Text style={s.scoreLabel}>Trip Readiness — nothing could be checked</Text>
      </View>
    );
  }
  // score is an integer (0–100) from the API
  const pct = Math.round(score);
  const scoreColor = pct >= 80 ? color.success : pct >= 50 ? color.warn : color.signal;
  return (
    <View style={s.scoreArea}>
      <Text style={[s.scoreNumber, { color: scoreColor }]}>{pct}%</Text>
      <Text style={s.scoreLabel}>Trip Readiness</Text>
      {/* The score is a fraction of the categories that COULD be measured, so
          it has to say when that is not all of them. Without this line a 100%
          over four checked categories is indistinguishable from 100% over
          seven. */}
      {unmeasured.length > 0 && (
        <Text style={s.scoreLabel}>
          {unmeasured.length} of 7 not checked: {unmeasured.join(', ')}
        </Text>
      )}
      {previousScore !== null && (
        <ScoreDelta current={score} previous={previousScore} />
      )}
    </View>
  );
}

export function TripReadinessCard({ tripId, refresh = false, onSummary }: TripReadinessCardProps) {
  const [read, setRead] = useState<ReadinessRead | undefined>(undefined); // undefined = loading
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (forceRefresh: boolean) => {
    setLoading(true);
    try {
      setRead(await fetchTripReadiness(tripId, forceRefresh));
    } catch (e: any) {
      // fetchTripReadiness does not throw, but a caller must never turn an
      // unexpected throw into "flag off" — that is the collapse this change
      // removed. An unexpected failure is still `unavailable`.
      setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') });
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { load(refresh); }, [load, refresh]);

  // QA round 2, bug 2: hand the loaded summary to the parent so the trip header's
  // progress ring can render the same number this card renders. Keyed on
  // `summary` only on purpose — adding `onSummary` to the deps would re-fire on
  // every parent render whenever the caller passes an inline lambda.
  useEffect(() => {
    if (read !== undefined) onSummary?.(read);
  }, [read]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading || read === undefined) {
    return (
      <View style={s.wrap}>
        <ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} />
      </View>
    );
  }

  // Not available here — nothing was measured, so nothing is shown and nothing
  // is claimed. This is the ONLY case that renders nothing.
  if (read.state === 'off') return null;

  // The read failed. Say so. Vanishing here is what let a trip with unmet
  // critical readiness items look exactly like a trip with none.
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-readiness-unavailable">
        <View style={s.criticalSection}>
          <View style={s.criticalRow}>
            <ShieldAlert size={16} color={color.signal} />
            <View style={{ flex: 1 }}>
              <Text style={s.criticalTitle}>Readiness couldn't be checked</Text>
              <Text style={s.criticalDetail}>
                We could not load this trip's readiness, so this is not a clean bill of health. Pull to refresh to try again.
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  const summary = read.summary;

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
      <ScoreHeader
        score={summary.score}
        previousScore={summary.previousScore ?? null}
        unmeasured={summary.unmeasuredCategories ?? []}
      />

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
  deltaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: space.xs,
  },
  deltaText: {
    ...t.stamp,
    fontWeight: '600',
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
