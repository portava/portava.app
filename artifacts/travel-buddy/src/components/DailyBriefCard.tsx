/**
 * DailyBriefCard — "Today's Brief" for accepted trip members.
 *
 * Shows: date, summary text, plan preview, open windows, suggestions,
 * meetup opportunities, warnings, quick-action buttons.
 * Expandable/collapsible. Renders access-denied + error states without crashing.
 *
 * Privacy: only shown to accepted members; non-members see a graceful state.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, Pressable, ActivityIndicator, ScrollView, StyleSheet, AppState,
} from 'react-native';
import { router } from 'expo-router';
import { Zap, ChevronDown, ChevronUp, Clock, AlertTriangle, Calendar, Sparkles, RefreshCw, Ticket, Cloud, CloudRain, Sun, MapPin, Globe } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens.ts';
import { fetchDailyBrief, refreshDailyBrief, dismissBriefRecommendation } from '../services/intelligence.ts';
import { TelegraphFeedbackMenu } from './TelegraphFeedbackMenu.tsx';

interface DailyBriefCardProps {
  tripId: string;
  date?: string;
  compact?: boolean;
  onGapDays?: (days: string[], destination: string) => void;
}

export function DailyBriefCard({ tripId, date, compact = false, onGapDays }: DailyBriefCardProps) {
  const [brief, setBrief] = useState<any>(null);
  const [access, setAccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!compact);

  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await fetchDailyBrief(tripId, date);
    setLoading(false);
    if (!res.ok) { setError("Could not load today's brief"); return; }
    setAccess(res.data?.access ?? 'access_denied');
    const b = res.data?.brief ?? null;
    setBrief(b);
    if (b?.gapDays?.length && onGapDays) {
      onGapDays(b.gapDays, b.destination ?? '');
    }
  }, [tripId, date, onGapDays]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    const res = await refreshDailyBrief(tripId, date);
    setRefreshing(false);
    if (!res.ok) return; // silently keep old brief on failure
    setAccess(res.data?.access ?? 'access_denied');
    const b = res.data?.brief ?? null;
    setBrief(b);
    if (b?.gapDays?.length && onGapDays) {
      onGapDays(b.gapDays, b.destination ?? '');
    }
  }, [tripId, date, onGapDays]);

  // Silent background re-fetch via the GET (cached) endpoint — used when the
  // app returns to the foreground. Keeps existing content visible; the server
  // returns the cached brief when it is still fresh, avoiding regeneration.
  // Distinct from handleRefresh which POSTs and forces cache invalidation.
  const backgroundRefetch = useCallback(async () => {
    setRefreshing(true);
    const res = await fetchDailyBrief(tripId, date);
    setRefreshing(false);
    if (!res.ok) return; // silently keep old brief on failure
    setAccess(res.data?.access ?? 'access_denied');
    const b = res.data?.brief ?? null;
    setBrief(b);
    if (b?.gapDays?.length && onGapDays) {
      onGapDays(b.gapDays, b.destination ?? '');
    }
  }, [tripId, date, onGapDays]);

  useEffect(() => { load(); }, [load]);

  // Re-fetch silently when the app returns to the foreground so users always
  // see a fresh brief rather than a stale card from hours ago.
  // Uses backgroundRefetch (GET) so server caching is respected and existing
  // content stays visible during the in-flight request.
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      if ((prev === 'background' || prev === 'inactive') && nextState === 'active') {
        backgroundRefetch();
      }
    });
    return () => sub.remove();
  }, [backgroundRefetch]);

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

  // QA round 2, bug 3. The server emits a "general" brief whose headline is
  // "No active trip right now — here's some travel inspiration…"
  // (api-server/src/lib/dailyBriefEngine.ts) whenever fetchActiveTripForUser
  // finds no trip starting within 3 days — it is never told WHICH trip page the
  // card is mounted on. Inside a specific trip's own detail page that copy flatly
  // contradicts the screen around it, so stay silent instead.
  //
  // Both call sites of this component are trip-scoped (app/trip/[id].tsx and
  // app/trip/chat.tsx), so suppressing here loses nothing. The proper fix is
  // server-side (scope the brief to the viewed tripId), but that needs the L2
  // cache re-keyed first: briefCacheKey is `${userId}:${date}` and the cache
  // table is UNIQUE (user_id, brief_date), so a trip-scoped brief would serve
  // trip A's brief on trip B's page. Left for a deliberate change.
  if (access === 'access_denied' || !brief || brief.briefType === 'general') {
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
          <View style={s.icon}>
            {brief.briefType === 'general'
              ? <Globe size={13} color={color.signal} />
              : <Zap size={13} color={color.signal} fill={color.signal} />}
          </View>
          <View>
            <Text style={s.headerTitle}>
              {brief.briefType === 'general' ? 'Travel Inspiration' : "Today's Brief"}
            </Text>
            {brief.destination
              ? (
                <View style={s.destRow}>
                  <MapPin size={9} color={color.signal} />
                  <Text style={s.destText}>{brief.destination}</Text>
                </View>
              )
              : <Text style={s.headerDate}>{formatDate(brief.date)}</Text>}
          </View>
        </View>
        <View style={s.headerRight}>
          <Pressable style={s.refreshBtn} onPress={handleRefresh} hitSlop={8} disabled={refreshing}>
            <RefreshCw size={13} color={refreshing ? color.signal : color.mute} />
          </Pressable>
          {expanded ? <ChevronUp size={16} color={color.mute} /> : <ChevronDown size={16} color={color.mute} />}
        </View>
      </Pressable>

      {/* Destination date row (when destination shown in header) */}
      {brief.destination && (
        <Text style={s.headerDateSub}>{formatDate(brief.date)}</Text>
      )}

      {/* Last-refreshed timestamp + staleness badge */}
      {brief.generatedAt ? (
        <View style={s.generatedAtRow}>
          <Text style={s.generatedAt}>Updated {formatGeneratedAt(brief.generatedAt)}</Text>
          {brief.isStale && (
            <Pressable style={s.staleBadge} onPress={handleRefresh} disabled={refreshing} hitSlop={6}>
              <AlertTriangle size={10} color="#92400E" />
              <Text style={s.staleBadgeText}>May be outdated — tap to refresh</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      {/* Summary */}
      <Text style={s.summary}>{brief.summaryText}</Text>

      {/* Weather banner */}
      {brief.weatherSummary ? <WeatherBanner summary={brief.weatherSummary} /> : null}

      {/* Multi-day forecast strip — only when the trip spans more than 1 day */}
      {brief.weatherForecasts?.length > 1 ? (
        <WeatherForecastStrip forecasts={brief.weatherForecasts} />
      ) : null}

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
              <Text style={s.sectionLabel}>FREE TIME TODAY</Text>
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

          {/* Gap days */}
          {brief.gapDays?.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>UNPLANNED DAYS AHEAD</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRow}>
                {brief.gapDays.map((d: string) => (
                  <View key={d} style={s.gapChip}>
                    <Calendar size={10} color={color.signal} />
                    <Text style={s.gapChipText}>{formatShortDate(d)}</Text>
                  </View>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Happening nearby — Ticketmaster event suggestions */}
          {(brief.suggestions?.filter((s: any) => s.id?.startsWith('rec_event_')).length > 0) && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>HAPPENING NEARBY</Text>
              {brief.suggestions
                .filter((s: any) => s.id?.startsWith('rec_event_'))
                .map((sug: any) => (
                  <EventSuggestionRow
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

          {/* Suggestions (non-event) */}
          {(brief.suggestions?.filter((s: any) => !s.id?.startsWith('rec_event_')).length > 0) && (
            <View style={s.section}>
              <Text style={s.sectionLabel}>SUGGESTIONS</Text>
              {brief.suggestions
                .filter((s: any) => !s.id?.startsWith('rec_event_'))
                .map((sug: any) => (
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
                <Text style={s.actionText}>{chipLabelForAction(action)}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

/** Returns "Updated X h ago" when the brief is ≥ 1 h old, otherwise null. */
function computeAgeLabel(generatedAt: number | undefined): string | null {
  if (!generatedAt) return null;
  const ageHours = (Date.now() - generatedAt) / 3_600_000;
  if (ageHours < 1) return null;
  return `Updated ${Math.floor(ageHours)} h ago`;
}

function CompactBriefCard({ brief, tripId }: { brief: any; tripId: string }) {
  const topSuggestion = brief.suggestions?.[0] ?? null;

  // Recompute every minute so the label stays accurate without a re-fetch.
  const [ageLabel, setAgeLabel] = useState<string | null>(() => computeAgeLabel(brief.generatedAt));
  useEffect(() => {
    setAgeLabel(computeAgeLabel(brief.generatedAt));
    const timer = setInterval(() => setAgeLabel(computeAgeLabel(brief.generatedAt)), 60_000);
    return () => clearInterval(timer);
  }, [brief.generatedAt]);

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
      {ageLabel && <Text style={sc.ageLabel}>{ageLabel}</Text>}
      <Pressable style={sc.btn} onPress={() => router.push(`/trip/${tripId}`)}>
        <Text style={sc.btnText}>Full Brief</Text>
      </Pressable>
    </View>
  );
}

function WeatherBanner({ summary }: { summary: string }) {
  const lower = summary.toLowerCase();
  const isRainy = lower.includes('rain') || lower.includes('shower') || lower.includes('thunderstorm');
  const isSunny = lower.includes('sunny') || lower.includes('clear sky');
  const bgColor = isRainy ? '#E3F2FD' : isSunny ? '#FFF8E1' : '#EFF6FF';
  const iconColor = isRainy ? '#1565C0' : isSunny ? '#F59E0B' : '#3B82F6';
  const Icon = isRainy ? CloudRain : isSunny ? Sun : Cloud;
  return (
    <View style={[s.weatherBanner, { backgroundColor: bgColor }]}>
      <Icon size={12} color={iconColor} />
      <Text style={[s.weatherText, { color: iconColor }]} numberOfLines={2}>{summary}</Text>
    </View>
  );
}

interface ForecastDay {
  date: string;
  weatherCode: number;
  summary: string;
  maxTempC: number;
  minTempC: number;
}

function forecastIcon(code: number): typeof Sun {
  if (code === 0 || code === 1) return Sun;
  if (code >= 51) return CloudRain;
  return Cloud;
}

function forecastIconColor(code: number): string {
  if (code === 0 || code === 1) return '#F59E0B';
  if (code >= 51) return '#1565C0';
  return '#3B82F6';
}

function shortDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  return d.toLocaleDateString('en', { weekday: 'short' });
}

function WeatherForecastStrip({ forecasts }: { forecasts: ForecastDay[] }) {
  if (forecasts.length === 0) return null;
  return (
    <View style={s.forecastWrap}>
      <Text style={s.forecastLabel}>TRIP FORECAST</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.forecastRow}>
        {forecasts.map((f) => {
          const Icon = forecastIcon(f.weatherCode);
          const iconColor = forecastIconColor(f.weatherCode);
          return (
            <View key={f.date} style={s.forecastDay}>
              <Text style={s.forecastDayName}>{shortDay(f.date)}</Text>
              <Icon size={16} color={iconColor} />
              <Text style={s.forecastHigh}>{f.maxTempC}°</Text>
              <Text style={s.forecastLow}>{f.minTempC}°</Text>
            </View>
          );
        })}
      </ScrollView>
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

function EventSuggestionRow({ suggestion, tripId, onDismiss }: { suggestion: any; tripId: string; onDismiss: () => void }) {
  const categoryLabel = suggestion.category === 'nightlife' ? 'Music' : suggestion.category === 'outdoor' ? 'Sports' : 'Event';
  return (
    <View style={s.eventRow}>
      <View style={s.eventIconCol}>
        <Ticket size={14} color={color.signal} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.eventTitleRow}>
          <Text style={s.eventTitle} numberOfLines={1}>{suggestion.title}</Text>
          <View style={s.eventBadge}>
            <Text style={s.eventBadgeText}>{categoryLabel.toUpperCase()}</Text>
          </View>
        </View>
        <Text style={s.eventReason} numberOfLines={2}>{suggestion.reason}</Text>
        <Text style={s.eventMeta}>{suggestion.estimatedTime} · {suggestion.priceLevel}</Text>
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

function SuggestionRow({ suggestion, tripId, onDismiss }: { suggestion: any; tripId: string; onDismiss: () => void }) {
  return (
    <View style={s.sugRow}>
      <View style={{ flex: 1 }}>
        {suggestion.forGapDay && (
          <View style={s.gapDayBadge}>
            <Calendar size={9} color={color.signal} />
            <Text style={s.gapDayBadgeText}>{formatShortDate(suggestion.forGapDay)}</Text>
          </View>
        )}
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

/**
 * Returns a concise, descriptive label for a quick-action chip.
 *
 * For meal-nudge chips (those with params.meetupTime), the meal label is
 * derived from the meetup's scheduled hour so it always matches context:
 *   07–10 → breakfast, 11–13 → lunch, 17+ → dinner.
 *
 * Other kinds are mapped to short, human-readable labels.
 * Falls back to the server-provided action.label for anything unrecognised.
 */
function chipLabelForAction(action: any): string {
  // Meal nudge — derive from the meetup's scheduled hour
  if (action.params?.meetupTime) {
    const h = new Date(action.params.meetupTime).getHours();
    if (h >= 7 && h < 11) return 'Find breakfast nearby';
    if (h >= 11 && h < 14) return 'Find lunch spot';
    if (h >= 17) return 'Find dinner option';
  }
  // Specific action kinds → fixed descriptive labels
  switch (action.kind) {
    case 'view_plan':     return 'View plan';
    case 'create_meetup': return 'Plan a meetup';
    case 'add_to_plan':   return 'Add to trip plan';
    case 'open_poll':     return 'See the poll';
  }
  // Fall back to server-provided label (e.g. "Fill free time", "Plan today", "Ask Telegraph")
  return action.label ?? 'Quick action';
}

function handleQuickAction(action: any, tripId: string) {
  switch (action.kind) {
    case 'view_plan':
      router.push(`/trip/${tripId}`);
      break;
    case 'ask_telegraph': {
      // Navigate to trip detail — ConciergeCommandBar lives there.
      // Pass the prompt and any structured meetup context as search params so
      // the bar pre-fills the text and Telegraph receives location/time context.
      if (!action.params?.prompt) {
        router.push(`/trip/${tripId}`);
        break;
      }
      const params = new URLSearchParams({
        telegraphPrompt: action.params.prompt,
      });
      if (action.params?.meetupId) {
        params.set('telegraphMeetupId', action.params.meetupId);
        if (action.params?.meetupTime) params.set('telegraphMeetupTime', action.params.meetupTime);
        if (action.params?.meetupLocation) params.set('telegraphMeetupLocation', action.params.meetupLocation);
      }
      router.push(`/trip/${tripId}?${params.toString()}`);
      break;
    }
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

function formatGeneratedAt(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return isToday ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatShortDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
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
  headerDateSub: { ...t.small, color: color.mute, fontSize: 11, paddingHorizontal: space.lg, paddingTop: 4 },
  generatedAtRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm, paddingHorizontal: space.lg, paddingTop: 2, paddingBottom: space.sm },
  generatedAt: { ...t.small, color: color.mute, fontSize: 10 },
  staleBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#FCD34D', borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 3 },
  staleBadgeText: { ...t.small, color: '#92400E', fontSize: 10, fontWeight: '600' },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  destText: { ...t.small, color: color.signal, fontSize: 11 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  refreshBtn: { padding: 4 },
  summary: { ...t.body, color: color.ink, fontSize: 13, lineHeight: 18, padding: space.lg, paddingBottom: space.sm },
  weatherBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: space.lg, paddingVertical: 7 },
  weatherText: { ...t.small, fontSize: 11, lineHeight: 16, flex: 1 },
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
  gapChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#FFF0EE', paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: '#FFD9D4' },
  gapChipText: { ...t.small, color: color.signal, fontSize: 11 },
  sugRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.sm },
  gapDayBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, marginBottom: 3 },
  gapDayBadgeText: { ...t.stamp, fontFamily: 'Courier', color: color.signal, fontSize: 9, letterSpacing: 0.5 },
  sugTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  sugTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13, flex: 1 },
  sugPrice: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 11 },
  sugReason: { ...t.small, color: color.mute, fontSize: 11, lineHeight: 16 },
  sugTime: { ...t.small, color: color.faint, fontSize: 10, marginTop: 2 },
  eventRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: color.haze, gap: space.sm },
  eventIconCol: { width: 24, alignItems: 'center', paddingTop: 2 },
  eventTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2, flexWrap: 'wrap' },
  eventTitle: { ...t.bodyStrong, color: color.ink, fontSize: 13, flexShrink: 1 },
  eventBadge: { backgroundColor: '#FFF0EE', borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 2 },
  eventBadgeText: { ...t.stamp, color: color.signal, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  eventReason: { ...t.small, color: color.mute, fontSize: 11, lineHeight: 16 },
  eventMeta: { ...t.small, color: color.faint, fontSize: 10, marginTop: 2 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.lg, paddingTop: space.md },
  actionBtn: { paddingHorizontal: space.md, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: color.signal, backgroundColor: '#FFF0EE' },
  actionText: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
  forecastWrap: { paddingHorizontal: space.lg, paddingVertical: space.sm },
  forecastLabel: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.8, marginBottom: space.sm },
  forecastRow: { gap: space.sm, paddingBottom: 2 },
  forecastDay: { alignItems: 'center', gap: 3, backgroundColor: '#F8F8F8', borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, minWidth: 54 },
  forecastDayName: { ...t.stamp, fontFamily: 'Courier', color: color.mute, fontSize: 10, letterSpacing: 0.3 },
  forecastHigh: { ...t.bodyStrong, color: color.ink, fontSize: 12, fontWeight: '700' },
  forecastLow: { ...t.small, color: color.mute, fontSize: 11 },
});

const sc = StyleSheet.create({
  wrap: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, marginHorizontal: space.lg, marginTop: space.md, padding: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  label: { ...t.small, color: color.ink, fontSize: 12, flex: 1 },
  next: { ...t.small, color: color.mute, fontSize: 11, marginTop: 2 },
  sugRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  sugText: { ...t.small, color: color.signal, fontSize: 11, flex: 1 },
  ageLabel: { ...t.small, color: color.mute, fontSize: 10, marginTop: 3 },
  btn: { alignSelf: 'flex-end', marginTop: space.sm, paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  btnText: { ...t.small, color: color.ink, fontSize: 11, fontWeight: '700' },
});
