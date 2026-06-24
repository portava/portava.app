/**
 * LayoverRecommendationScreen
 *
 * Displays recommendation cards grouped by category.
 * Each card shows: safety badge, travel + activity time, hard return time,
 * Compass explanation snippet. Actions: Save, Add to Plan, Invite Crew, Safe Return.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable,
  StyleSheet, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Shield, Clock, MapPin, AlertTriangle, Plane, Coffee, Building, Compass } from 'lucide-react-native';
import {
  getRecommendations,
  getSessionSafety,
  type LayoverRecommendation,
  type LayoverSafetyResult,
  type SafetyRating,
} from '../../services/layover';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  onAskCompass?: () => void;
  onSafeReturn?: () => void;
}

// ── Safety badge ──────────────────────────────────────────────────────────────

const RATING_COLORS: Record<SafetyRating, { bg: string; text: string; icon: string }> = {
  safe:               { bg: '#E8F5E9', text: '#2E7D32', icon: '✓' },
  possible_but_risky: { bg: '#FFF8E1', text: '#E65100', icon: '⚠' },
  not_recommended:    { bg: '#FFEBEE', text: '#C62828', icon: '✗' },
  airport_only:       { bg: '#E3F2FD', text: '#1565C0', icon: '✈' },
};

const GROUP_LABELS: Record<string, string> = {
  inside_airport:   '✈ Inside Airport',
  near_airport:     '🚗 Near Airport',
  food:             '🍜 Food',
  rest:             '😴 Rest',
  quick_city_escape:'🌆 Quick City Escape',
  meetup:           '🤝 Meetups',
  hidden_gem:       '💎 Hidden Gems',
  activity:         '🎯 Activities',
};

function SafetyBadge({ rating }: { rating: SafetyRating }) {
  const c = RATING_COLORS[rating] ?? RATING_COLORS.safe;
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.text }]}>{c.icon} {rating.replace(/_/g, ' ')}</Text>
    </View>
  );
}

function RecCard({ rec, onAskCompass }: { rec: LayoverRecommendation; onAskCompass?: () => void }) {
  const isRisky = rec.safetyRating === 'not_recommended' || rec.safetyRating === 'possible_but_risky';

  return (
    <View style={[styles.card, isRisky && styles.cardRisky]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={2}>{rec.title}</Text>
        <SafetyBadge rating={rec.safetyRating} />
      </View>

      {rec.description ? (
        <Text style={styles.cardDesc} numberOfLines={3}>{rec.description}</Text>
      ) : null}

      <View style={styles.cardMeta}>
        {!rec.insideAirport && (
          <View style={styles.metaItem}>
            <Plane size={12} color="#888" />
            <Text style={styles.metaText}>{rec.travelTimeMin} min travel</Text>
          </View>
        )}
        <View style={styles.metaItem}>
          <Clock size={12} color="#888" />
          <Text style={styles.metaText}>{rec.activityTimeMin} min activity</Text>
        </View>
        {rec.hardReturnTime && (
          <View style={styles.metaItem}>
            <Shield size={12} color="#888" />
            <Text style={styles.metaText}>
              Back by {new Date(rec.hardReturnTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        )}
      </View>

      {rec.locationLabel || rec.city ? (
        <View style={styles.metaItem}>
          <MapPin size={12} color="#888" />
          <Text style={styles.metaText} numberOfLines={1}>
            {rec.meetupLocationHidden
              ? rec.meetupLocationReveal ?? 'Location revealed after acceptance'
              : (rec.locationLabel ?? rec.city)}
          </Text>
        </View>
      ) : null}

      {rec.warningReason ? (
        <View style={styles.warning}>
          <AlertTriangle size={12} color="#E65100" />
          <Text style={styles.warningText} numberOfLines={2}>{rec.warningReason}</Text>
        </View>
      ) : null}

      <View style={styles.cardActions}>
        <Pressable style={styles.actionBtn} onPress={onAskCompass}>
          <Compass size={14} color="#2196F3" />
          <Text style={styles.actionBtnText}>Ask Compass</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function LayoverRecommendationScreen({ sessionId, onAskCompass, onSafeReturn }: Props) {
  const [recs, setRecs]           = useState<LayoverRecommendation[]>([]);
  const [safety, setSafety]       = useState<LayoverSafetyResult | null>(null);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const [r, s] = await Promise.all([
        getRecommendations(sessionId),
        getSessionSafety(sessionId),
      ]);
      setRecs(r);
      setSafety(s);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#2196F3" />
        <Text style={styles.loadingText}>Calculating safe options…</Text>
      </View>
    );
  }

  // Group recs by type
  const grouped: Record<string, LayoverRecommendation[]> = {};
  for (const rec of recs) {
    if (!grouped[rec.recType]) grouped[rec.recType] = [];
    grouped[rec.recType].push(rec);
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
    >
      {/* Overall safety banner */}
      {safety && (
        <View style={[styles.safetyBanner, { backgroundColor: RATING_COLORS[safety.overallRating]?.bg ?? '#F5F5F5' }]}>
          <Text style={[styles.safetyBannerLabel, { color: RATING_COLORS[safety.overallRating]?.text ?? '#333' }]}>
            {safety.overallLabel}
          </Text>
          <Text style={styles.safetyBannerSub}>
            {safety.usableMinutes} min usable · Back by {new Date(safety.hardReturnTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
          <Pressable style={styles.safeReturnBtn} onPress={onSafeReturn}>
            <Shield size={14} color="#fff" />
            <Text style={styles.safeReturnBtnText}>Set up Safe Return</Text>
          </Pressable>
        </View>
      )}

      {/* Compass CTA */}
      <Pressable style={styles.compassCta} onPress={onAskCompass}>
        <Compass size={18} color="#2196F3" />
        <Text style={styles.compassCtaText}>Ask Compass a layover question</Text>
      </Pressable>

      {/* Groups */}
      {Object.entries(grouped).map(([type, items]) => (
        <View key={type} style={styles.group}>
          <Text style={styles.groupLabel}>{GROUP_LABELS[type] ?? type}</Text>
          {items.map((rec, idx) => (
            <RecCard key={rec.id ?? idx} rec={rec} onAskCompass={onAskCompass} />
          ))}
        </View>
      ))}

      {recs.length === 0 && (
        <View style={styles.empty}>
          <Building size={32} color="#ccc" />
          <Text style={styles.emptyText}>No recommendations yet. Tap refresh to generate options.</Text>
        </View>
      )}
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#f8f8f8' },
  content:     { padding: 16, paddingBottom: 120 },
  centered:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  loadingText: { marginTop: 12, color: '#888', fontSize: 14 },

  safetyBanner:      { borderRadius: 12, padding: 16, marginBottom: 12 },
  safetyBannerLabel: { fontSize: 16, fontWeight: '700' },
  safetyBannerSub:   { fontSize: 13, color: '#555', marginTop: 4 },
  safeReturnBtn:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#2196F3', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, marginTop: 10, alignSelf: 'flex-start' },
  safeReturnBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },

  compassCta:     { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#E3F2FD', borderRadius: 10, padding: 14, marginBottom: 16 },
  compassCtaText: { fontSize: 14, color: '#1565C0', fontWeight: '500' },

  group:      { marginBottom: 20 },
  groupLabel: { fontSize: 15, fontWeight: '700', color: '#1a1a1a', marginBottom: 10 },

  card:        { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  cardRisky:   { borderLeftWidth: 3, borderLeftColor: '#FF8F00' },
  cardHeader:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  cardTitle:   { flex: 1, fontSize: 15, fontWeight: '600', color: '#1a1a1a' },
  cardDesc:    { fontSize: 13, color: '#666', marginTop: 6, lineHeight: 18 },

  badge:     { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },

  cardMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: '#888' },

  warning:     { flexDirection: 'row', alignItems: 'flex-start', gap: 6, backgroundColor: '#FFF3E0', borderRadius: 6, padding: 8, marginTop: 8 },
  warningText: { flex: 1, fontSize: 12, color: '#E65100' },

  cardActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionBtn:   { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: '#2196F3', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  actionBtnText:{ fontSize: 12, color: '#2196F3', fontWeight: '500' },

  empty:     { alignItems: 'center', padding: 40 },
  emptyText: { marginTop: 12, color: '#aaa', fontSize: 14, textAlign: 'center' },
});
