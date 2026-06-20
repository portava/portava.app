/**
 * DailyBriefCard — "Today's Brief" for accepted trip members.
 *
 * Shows: date, summary text, plan preview, open windows, suggestions,
 * meetup opportunities, warnings, quick-action buttons.
 * Expandable/collapsible. Renders access-denied + error states without crashing.
 *
 * Privacy: only shown to accepted members; non-members see a graceful state.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, ScrollView, StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { Zap, ChevronDown, ChevronUp, Clock, AlertTriangle, Calendar, Sparkles, RefreshCw } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';
import { fetchDailyBrief, dismissBriefRecommendation } from '../services/intelligence';
import { TelegraphFeedbackMenu } from './TelegraphFeedbackMenu';

interface DailyBriefCardProps {
  tripId: string;
  date?: string;
  compact?: boolean;
}

export function DailyBriefCard({ tripId, date, compact = false }: DailyBriefCardProps) {
  const [brief, setBrief] = useState<any>(null);
  const [access, setAccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchDailyBrief(tripId, date);
    setLoading(false);
    if (!res.ok) { setError("Could not load today's brief"); return; }
    setAccess(res.data?.access ?? 'access_denied');
    setBrief(res.data?.brief ?? null);
  }, [tripId, date]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <View style={s.wrap}>
        <View style={s.loadRow}>
          <ActivityIndicator size="small" color={color.signal} />
          <Text style={s.loadText}>Loading today's brief…</Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.wrap}>
        <Text style={s.errorText}>{error}</Text>
        <Pressable style={s.retryBtn} onPress={load}><Text style={s.retryText}>Retry</Text></Pressable>
      </View>
    );
  }

  if (access === 'access_denied' || !brief) {
    return (
      <View style={s.wrap}>
        <View style={s.deniedRow}>
          <Zap size={13} color={color.mute} />
          <Text style={s.deniedText}>Today's Brief is only available to accepted trip members.</Text>
        </View>
      </View>
    );
  }

  if (compact) {
    return <CompactBriefCard brief={brief} tripId={tripId} />;
  }

  return (
    <View style={s.wrap}>
      {/* Header */}
      <Pressable style={s.header} onPress={() => setExpanded((e) => !e)}>
        <View style={s.headerLeft}>
          <View style={s.icon}><Zap size={13} color={color.signal} fill={color.signal} /></View>
          <View>
            <Text style={s.headerTitle}>Today's Brief</Text>
            <Text style={s.headerDate}>{formatDate(brief.date)}</Text>
          </View>
        </View>
        <View style={s.headerRight}>
          <Pressable style={s.refreshBtn} onPress={load} hitSlop={8}>
            <RefreshCw size={13} color={color.mute} />
          </Pressable>
          {expanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
        </View>
      </Pressable>

      {/* Summary */}
      <Text style={s.summary}>{brief.summaryText}</Text>

      {/* Warnings */}
      {brief.warnings?.length > 0 && (
        <View style={s.warningRow}>
          <AlertTriangle size={12} color={color.warn} />
          <Text style={s.warningText}>{friendlyWarning(brief.warnings[0])}</Text>
        </View>
      )}

      {expanded && (
        <>
          {/* Open windows */}
          {brief.openWindows?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>FREE TIME</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
                {brief.openWindows.map((w: any, i: number) => (
                  <View key={i} style={s.chip}>
                    <Clock size={10} color={color.deep} />
                    <Text style={s.chipText}>{w.label} · {w.startTime}–{w.endTime}</Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Plan preview */}
          {brief.planPreview?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>TODAY'S PLAN</Text>
              {brief.planPreview.map((item: any) => (
                <PlanRow key={item.id} item={item} />
              ))}
            </View>
          )}

          {/* Suggestions */}
          {brief.suggestions?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>SUGGESTIONS</Text>
              {brief.suggestions.map((sug: any) => (
                <SuggestionRow
                  key={sug.id}
                  suggestion={sug}
                  tripId={tripId}
                  onDismiss={() => {
                    dismissBriefRecommendation(tripId, sug.id, sug.category);
                    setBrief((b: any) => b ? { ...b, suggestions: b.suggestions.filter((s: any) => s.id !== sug.id) } : b);
                  }}
                />
              ))}
            </View>
          )}

          {/* Quick actions */}
          <View style={s.actionRow}>
            {brief.quickActions?.map((action: any) => (
              <Pressable
                key={action.id}
                style={s.actionBtn}
                onPress={() => handleQuickAction(action, tripId)}
              >
                <Text style={s.actionText}>{action.label}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

function CompactBriefCard({ brief, tripId }: { brief: any; tripId: string }) {
  const topSuggestion = brief.suggestions?.[0] ?? null;
  return (
    <View style={sc.wrap}>
      <View style={sc.row}>
        <Zap size={11} color={color.signal} fill={color.signal} />
        <Text style={sc.label} numberOfLines={1}>{brief.summaryText}</Text>
      </View>
      {brief.planPreview?.[0] && (
        <Text style={sc.next} numberOfLines={1}>
          Next: {brief.planPreview[0].title}
        </Text>
      )}
      {topSuggestion && (
        <View style={sc.sugRow}>
          <Sparkles size={10} color={color.signal} />
          <Text style={sc.sugText} numberOfLines={1}>{topSuggestion.title}</Text>
        </View>
      )}
      <Pressable style={sc.btn} onPress={() => router.push(`/trip/${tripId}`)}>
        <Text style={sc.btnText}>Full Brief</Text>
      </Pressable>
    </View>
  );
}

function PlanRow({ item }: { item: any }) {
  return (
    <View style={s.planRow}>
      <View style={s.planDot} />
      <View style={{ flex: 1 }}>
        <Text style={s.planTitle} numberOfLines={1}>{item.title}</Text>
        {item.startsAt && <Text style={s.planTime}>{formatTime(item.startsAt)}</Text>}
        {item.locationName && <Text style={s.planLoc} numberOfLines={1}>{item.locationName}</Text>}
        {item.warnings?.length > 0 && (
          <View style={s.planWarnRow}>
            <AlertTriangle size={10} color={color.warn} />
            <Text style={s.planWarnText}>{item.warnings.join(', ')}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function SuggestionRow({ suggestion, tripId, onDismiss }: { suggestion: any; tripId: string; onDismiss: () => void }) {
  return (
    <View style={s.sugRow}>
      <View style={{ flex: 1 }}>
        <View style={s.sugTitleRow}>
          <Sparkles size={12} color={color.signal} />
          <Text style={s.sugTitle} numberOfLines={1}>{suggestion.title}</Text>
          <Text style={s.sugPrice}>{suggestion.priceLevel}</Text>
        </View>
        <Text style={s.sugReason} numberOfLines={2}>{suggestion.reason}</Text>
        <Text style={s.sugTime}>{suggestion.estimatedTime}</Text>
      </View>
      <TelegraphFeedbackMenu
        recommendationId={suggestion.id}
        category={suggestion.category}
        tripId={tripId}
        onDismiss={onDismiss}
      />
    </View>
  );
}

function handleQuickAction(action: any, tripId: string) {
  switch (action.kind) {
    case 'view_plan':
      router.push(`/trip/${tripId}`);
      break;
    case 'ask_telegraph':
      // Navigate to trip detail — ConciergeCommandBar lives there.
      // Pass the prompt as a search param so the bar pre-fills the text.
      router.push(
        action.params?.prompt
          ? `/trip/${tripId}?telegraphPrompt=${encodeURIComponent(action.params.prompt)}`
          : `/trip/${tripId}`,
      );
      break;
    case 'add_to_plan':
      router.push(`/trip/${tripId}`);
      break;
    case 'create_meetup':
      // Navigate to meetup creation if the route exists; fall back to trip detail.
      router.push(`/trip/${tripId}`);
      break;
    case 'open_poll':
      router.push(`/trip/${tripId}`);
      break;
    default:
      router.push(`/trip/${tripId}`);
  }
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function friendlyWarning(w: string): string {
  const map: Record<string, string> = {
    time_overlap: 'Schedule conflict detected',
    cancelled_meetup: 'A meetup was cancelled',
    free_window_unplanned: 'Your day has unplanned windows',
    late_addition: 'Item added late — check your plan',
  };
  return map[w] ?? w;
}

const s = StyleSheet.create({
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginHorizontal: space.lg, marginTop: space.xl, overflow: 'hidden' },
  loadRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg },
  loadText: { ...t.small, color: color.mute },
  errorText: { ...t.small, color: color.signal, padding: space.lg },
  retryBtn: { paddingHorizontal: space.lg, paddingBottom: space.md },
  retryText: { ...t.small, color: color.signal, fontWeight: '700' },
  deniedRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, padding: space.lg },
  deniedText: { ...t.small, color: color.mute, flex: 1, lineHeight: 17 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.lg, borderBottomWidth: 1, borderBottomColor: color.haze },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFF0EE', alignItems: 'center', justifyContent: 'center' },
  headerTitle: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  headerDate: { ...t.small, color: color.mute, fontSize: 11 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  refreshBtn: { padding: 4 },
  summary: { ...t.body, color: color.ink, fontSize: 13, lineHeight: 18, padding: space.lg, paddingBottom: space.sm },
  warningRow: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FFF8E1', paddingHorizontal: space.lg, paddingVertical: 6 },
  warningText: { ...t.small, color: color.warn, fontSize: 11, flex: 1 },
  section: { paddingHorizontal: space.lg, paddingTop: space.md },
  sectionLabel: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.8, marginBottom: space.sm },
  chipRow: { gap: space.sm, paddingBottom: space.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#E8F0F2', paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill },
  chipText: { ...t.small, color: color.deep, fontSize: 11 },
  planRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: color.haze },
  planDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.signal, marginTop: 5 },
  planTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13 },
  planTime: { ...t.small, color: color.mute, fontSize: 11 },
  planLoc: { ...t.small, color: color.mute, fontSize: 11 },
  planWarnRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  planWarnText: { ...t.small, color: color.warn, fontSize: 10 },
  sugRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.sm },
  sugTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  sugTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13, flex: 1 },
  sugPrice: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 11 },
  sugReason: { ...t.small, color: color.mute, fontSize: 11, lineHeight: 16 },
  sugTime: { ...t.small, color: color.faint, fontSize: 10, marginTop: 2 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg, paddingTop: space.md },
  actionBtn: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal, backgroundColor: '#FFF0EE' },
  actionText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
});

const sc = StyleSheet.create({
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginHorizontal: space.lg, marginTop: space.md, padding: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { ...t.small, color: color.ink, fontSize: 12, flex: 1 },
  next: { ...t.small, color: color.mute, fontSize: 11, marginTop: 2 },
  sugRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  sugText: { ...t.small, color: color.signal, fontSize: 11, flex: 1 },
  btn: { alignSelf: 'flex-end', marginTop: space.sm, paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  btnText: { ...t.small, color: color.ink, fontSize: 11, fontWeight: '700' },
});
