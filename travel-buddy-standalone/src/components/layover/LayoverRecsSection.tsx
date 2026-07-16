/**
 * LayoverRecsSection — time-aware recommendations with safety badges and
 * one-tap "Add to plan".
 */
import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { Compass, Plus, Check } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { fmtDur, REC_EMOJI, safetyColors } from './layoverFormat';
import type { LayoverRecommendation } from '../../services/layover';

interface Props {
  recs: LayoverRecommendation[];
  loading: boolean;
  canPlan: boolean;
  addedRecIds: Set<string>;
  addingRecId: string | null;
  onAddToPlan: (recId: string) => void;
}

type Filter = 'all' | 'inside' | 'outside';

export function LayoverRecsSection({
  recs, loading, canPlan, addedRecIds, addingRecId, onAddToPlan,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'inside')  return recs.filter((r) => r.insideAirport);
    if (filter === 'outside') return recs.filter((r) => !r.insideAirport);
    return recs;
  }, [recs, filter]);

  return (
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Compass size={18} color={color.ink} />
        <Text style={styles.heading}>What you can actually do</Text>
      </View>

      <View style={styles.filterRow}>
        {(['all', 'inside', 'outside'] as Filter[]).map((f) => (
          <Pressable key={f} style={[styles.filterChip, filter === f && styles.filterChipActive]} onPress={() => setFilter(f)}>
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === 'all' ? 'All' : f === 'inside' ? 'In airport' : 'Out in the city'}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading && <ActivityIndicator color={color.deep} style={{ marginVertical: space.lg }} />}

      {!loading && filtered.length === 0 && (
        <Text style={styles.empty}>
          {filter === 'outside'
            ? 'Nothing outside fits this window — the buffers win this time.'
            : 'No recommendations yet for this layover.'}
        </Text>
      )}

      {!loading && filtered.map((rec, idx) => {
        const sc = safetyColors(rec.safetyRating);
        const recId = rec.id ?? null;
        const added = recId ? addedRecIds.has(recId) : false;
        return (
          <View key={recId ?? `${rec.title}-${idx}`} style={styles.recRow}>
            <Text style={styles.emoji}>{REC_EMOJI[rec.recType] ?? '📍'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.recTitle} numberOfLines={1}>{rec.title}</Text>
              {rec.description ? <Text style={styles.recDesc} numberOfLines={2}>{rec.description}</Text> : null}
              <View style={styles.recMeta}>
                <View style={[styles.safetyBadge, { backgroundColor: sc.bg }]}>
                  <Text style={[styles.safetyText, { color: sc.fg }]}>{rec.safetyLabel}</Text>
                </View>
                {!rec.insideAirport && rec.travelTimeMin > 0 && (
                  <Text style={styles.metaStamp}>{rec.travelTimeMin}m away</Text>
                )}
                <Text style={styles.metaStamp}>{fmtDur(rec.activityTimeMin)} there</Text>
              </View>
              {rec.warningReason ? <Text style={styles.warning}>{rec.warningReason}</Text> : null}
            </View>
            {canPlan && recId && rec.safetyRating !== 'not_recommended' && (
              added ? (
                <View style={styles.addedBadge}><Check size={15} color={color.success} /></View>
              ) : (
                <Pressable
                  style={styles.addBtn}
                  disabled={addingRecId === recId}
                  onPress={() => onAddToPlan(recId)}
                  accessibilityLabel={`Add ${rec.title} to plan`}
                >
                  {addingRecId === recId
                    ? <ActivityIndicator size="small" color={color.deep} />
                    : <Plus size={16} color={color.deep} />}
                </Pressable>
              )
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heading:   { ...t.heading, color: color.ink },
  filterRow: { flexDirection: 'row', gap: space.sm },
  filterChip:{ borderWidth: 1, borderColor: color.haze, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.paper },
  filterChipActive: { backgroundColor: color.ink, borderColor: color.ink },
  filterText:{ ...t.small, color: color.mute },
  filterTextActive: { color: color.onInk },
  empty:     { ...t.small, color: color.faint, marginTop: space.sm },

  recRow:    { flexDirection: 'row', gap: space.md, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, alignItems: 'flex-start' },
  emoji:     { fontSize: 22, marginTop: 2 },
  recTitle:  { ...t.bodyStrong, color: color.ink },
  recDesc:   { ...t.small, color: color.mute, marginTop: 2 },
  recMeta:   { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 6, flexWrap: 'wrap' },
  safetyBadge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  safetyText:{ ...t.stamp },
  metaStamp: { ...t.stamp, color: color.faint },
  warning:   { ...t.small, color: color.warn, marginTop: 4 },

  addBtn:    { width: 34, height: 34, borderRadius: 17, borderWidth: 1.5, borderColor: color.deep, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  addedBadge:{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(46,125,91,0.12)', alignItems: 'center', justifyContent: 'center', marginTop: 4 },
});
