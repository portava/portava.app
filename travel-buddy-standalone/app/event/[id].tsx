/**
 * Event detail screen — /event/:id
 *
 * Full detail view with: cover photo, title, meta, gates, host, attendees,
 * waitlist position, description, save/share/report header actions,
 * full RSVP state machine via useEventRsvp, and host dashboard.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, Alert, Image, Share,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, MapPin, CalendarClock, Users, Clock, Check,
  ChevronDown, MessageSquare, Shield, Star, Link, Settings,
  Bookmark, BookmarkCheck, MoreHorizontal,
} from 'lucide-react-native';
import {
  getEvent, saveEvent, unsaveEvent, createShareLink, reportEvent,
  type EventDetail, type EventRsvpStatus,
} from '../../src/services/events';
import { useEventRsvp } from '../../src/hooks/useEventRsvp';
import { HostDashboardPanel } from '../../src/components/HostDashboardPanel';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { Avatar } from '../../src/components/ui';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

const STATE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  draft:     { label: 'Draft',          bg: color.haze,    fg: color.mute    },
  open:      { label: 'Open',           bg: '#DCFCE7',     fg: '#16A34A'     },
  full:      { label: 'Full',           bg: '#FEF3C7',     fg: '#92400E'     },
  waitlist:  { label: 'Waitlist open',  bg: '#EFF6FF',     fg: '#2563EB'     },
  started:   { label: 'Happening now',  bg: '#DCFCE7',     fg: '#16A34A'     },
  completed: { label: 'Completed',      bg: color.haze,    fg: color.mute    },
  cancelled: { label: 'Cancelled',      bg: '#FEE2E2',     fg: '#DC2626'     },
  archived:  { label: 'Archived',       bg: color.haze,    fg: color.faint   },
};

const RSVP_OPTIONS: { key: EventRsvpStatus; label: string; emoji: string }[] = [
  { key: 'going',      label: 'Going',      emoji: '✅' },
  { key: 'maybe',      label: 'Maybe',      emoji: '🤔' },
  { key: 'interested', label: 'Interested', emoji: '👀' },
  { key: 'cant_go',    label: "Can't go",   emoji: '❌' },
];

function relDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Date TBD';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function EventDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showRsvpMenu, setShowRsvpMenu] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const res = await getEvent(id as string);
    if (!res.ok) setError(res.message ?? 'Failed to load event');
    else setEvent(res.data ?? null);
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const rsvp = useEventRsvp(event, load, (updater) => {
    setEvent((e) => e ? updater(e) : e);
  });

  async function handleToggleSave() {
    if (!event || saveLoading) return;
    setSaveLoading(true);
    const res = saved ? await unsaveEvent(event.id) : await saveEvent(event.id);
    setSaveLoading(false);
    if (res.ok) setSaved((s) => !s);
    else Alert.alert('Error', res.message ?? 'Could not save event');
  }

  async function handleShare() {
    if (!event) return;
    try {
      const res = await createShareLink(event.id);
      const url = res.data?.url ?? `https://travelbuddy.app/event/${event.id}`;
      await Share.share({ title: event.title, message: `Check out this event: ${event.title}\n${url}` });
    } catch {
      await Share.share({ title: event.title, message: `Check out this event: ${event.title}` });
    }
  }

  async function handleReport() {
    setShowOverflow(false);
    Alert.alert('Report event', 'Why are you reporting this event?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Spam', onPress: () => doReport('spam') },
      { text: 'Misleading', onPress: () => doReport('misleading') },
      { text: 'Dangerous', onPress: () => doReport('dangerous') },
      { text: 'Other', onPress: () => doReport('other') },
    ]);
  }

  async function doReport(reason: string) {
    if (!event) return;
    const res = await reportEvent(event.id, reason);
    if (res.ok) Alert.alert('Reported', 'Thank you. We will review this event.');
    else Alert.alert('Error', res.message ?? 'Could not submit report');
  }

  const isHost = event?.isHost || event?.myRole === 'host' || event?.myRole === 'co_host';
  const isBanned = event?.myRole === 'banned';
  const stateBadge = event ? (STATE_BADGE[event.state] ?? STATE_BADGE.open) : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{event?.title ?? 'Event'}</Text>
        <View style={styles.headerActions}>
          {/* Save */}
          <Pressable style={styles.headerBtn} onPress={handleToggleSave} hitSlop={8} disabled={saveLoading}>
            {saveLoading
              ? <ActivityIndicator size="small" color={color.mute} />
              : saved
              ? <BookmarkCheck size={20} color={color.signal} />
              : <Bookmark size={20} color={color.ink} />
            }
          </Pressable>
          {/* Share */}
          <Pressable style={styles.headerBtn} onPress={handleShare} hitSlop={8}>
            <Link size={20} color={color.ink} />
          </Pressable>
          {/* Host settings OR overflow menu */}
          {isHost ? (
            <Pressable style={styles.headerBtn} onPress={() => setShowDashboard(true)} hitSlop={8}>
              <Settings size={20} color={color.ink} />
            </Pressable>
          ) : (
            <Pressable style={styles.headerBtn} onPress={() => setShowOverflow((v) => !v)} hitSlop={8}>
              <MoreHorizontal size={20} color={color.ink} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Overflow menu */}
      {showOverflow && (
        <View style={styles.overflowMenu}>
          <Pressable style={styles.overflowItem} onPress={handleReport}>
            <Text style={styles.overflowItemText}>Report event</Text>
          </Pressable>
          <Pressable style={styles.overflowItem} onPress={() => setShowOverflow(false)}>
            <Text style={[styles.overflowItemText, { color: color.mute }]}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {loading && !event ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : event ? (
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Cover photo */}
          {event.coverUrl ? (
            <Image source={{ uri: event.coverUrl }} style={styles.cover} resizeMode="cover" />
          ) : (
            <View style={[styles.cover, styles.coverPlaceholder]}>
              <CalendarClock size={48} color={color.faint} />
            </View>
          )}

          <View style={styles.body}>
            {/* State badge */}
            {stateBadge && (
              <View style={[styles.stateBadge, { backgroundColor: stateBadge.bg }]}>
                <Text style={[styles.stateBadgeText, { color: stateBadge.fg }]}>{stateBadge.label}</Text>
              </View>
            )}

            {/* Title */}
            <Text style={styles.title}>{event.title}</Text>

            {/* Category */}
            {event.category ? (
              <View style={styles.metaRow}>
                <Star size={14} color={color.mute} />
                <Text style={styles.meta}>{event.category}</Text>
              </View>
            ) : null}

            {/* Dates */}
            <View style={styles.metaRow}>
              <CalendarClock size={14} color={color.mute} />
              <Text style={styles.meta}>{relDateTime(event.startsAt)}</Text>
            </View>
            {event.endsAt && (
              <View style={styles.metaRow}>
                <Clock size={14} color={color.mute} />
                <Text style={styles.meta}>Ends {relDateTime(event.endsAt)}</Text>
              </View>
            )}

            {/* Location */}
            {event.locationName && (
              <View style={styles.metaRow}>
                <MapPin size={14} color={color.mute} />
                <Text style={styles.meta}>
                  {event.locationName}{event.city ? `, ${event.city}` : ''}
                </Text>
              </View>
            )}

            {/* Capacity */}
            <View style={styles.metaRow}>
              <Users size={14} color={color.mute} />
              <Text style={styles.meta}>
                {event.counts.going} going
                {event.maxAttendees ? ` · ${event.maxAttendees} max` : ''}
                {event.waitlistCount > 0 ? ` · ${event.waitlistCount} waitlisted` : ''}
              </Text>
            </View>

            {/* Eligibility gates */}
            {(event.trustScoreMin || event.ageMin || event.ageMax || event.verifiedOnly || event.priceType === 'external') && (
              <View style={styles.gateBox}>
                {event.verifiedOnly && (
                  <View style={styles.gateRow}>
                    <Shield size={13} color="#7C3AED" />
                    <Text style={styles.gateText}>Verified users only</Text>
                  </View>
                )}
                {event.trustScoreMin ? (
                  <View style={styles.gateRow}>
                    <Star size={13} color="#D97706" />
                    <Text style={styles.gateText}>Trust score ≥ {event.trustScoreMin}</Text>
                  </View>
                ) : null}
                {(event.ageMin || event.ageMax) && (
                  <View style={styles.gateRow}>
                    <Check size={13} color="#059669" />
                    <Text style={styles.gateText}>
                      Ages{event.ageMin ? ` ${event.ageMin}+` : ''}
                      {event.ageMin && event.ageMax ? '–' : ''}
                      {event.ageMax ? event.ageMax : ''}
                    </Text>
                  </View>
                )}
                {event.priceType === 'external' && event.priceUrl && (
                  <View style={styles.gateRow}>
                    <Link size={13} color="#2563EB" />
                    <Text style={[styles.gateText, { color: '#2563EB' }]}>Ticketed event</Text>
                  </View>
                )}
              </View>
            )}

            {/* Safety notes */}
            {event.safetyNotes ? (
              <View style={styles.safetyBox}>
                <View style={styles.safetyHeader}>
                  <Shield size={14} color="#7C3AED" />
                  <Text style={styles.safetyTitle}>Safety notes from the host</Text>
                </View>
                <Text style={styles.safetyText}>{event.safetyNotes}</Text>
              </View>
            ) : null}

            {/* Host */}
            {event.host && (
              <Pressable
                style={styles.hostRow}
                onPress={() => router.push(`/profile/${event.host!.id}` as any)}
              >
                <Avatar uri={event.host.avatarUrl ?? ''} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.hostLabel}>Hosted by</Text>
                  <Text style={styles.hostName}>
                    {event.host.displayName ?? event.host.handle ?? 'Unknown'}
                  </Text>
                </View>
                <ChevronDown size={14} color={color.mute} style={{ transform: [{ rotate: '-90deg' }] }} />
              </Pressable>
            )}

            {/* Going avatars */}
            {event.goingAttendees.length > 0 && (
              <View style={styles.attendeeRow}>
                {event.goingAttendees.slice(0, 5).map((a) => (
                  <View key={a.id} style={styles.avatarOverlap}>
                    <Avatar uri={a.avatarUrl ?? ''} size={32} />
                  </View>
                ))}
                {event.counts.going > 5 && (
                  <View style={[styles.avatarOverlap, styles.avatarMore]}>
                    <Text style={styles.avatarMoreText}>+{event.counts.going - 5}</Text>
                  </View>
                )}
              </View>
            )}

            {/* Waitlist position */}
            {event.myWaitlistPosition != null && (
              <View style={styles.waitlistBanner}>
                <Clock size={14} color="#2563EB" />
                <Text style={styles.waitlistText}>
                  You're #{event.myWaitlistPosition} on the waitlist
                  {event.myWaitlistOfferExpiresAt
                    ? ` · Offer expires ${new Date(event.myWaitlistOfferExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : ''}
                </Text>
              </View>
            )}

            {/* Description */}
            {event.description ? (
              <View style={styles.descBox}>
                <Text style={styles.descText}>{event.description}</Text>
              </View>
            ) : null}

            {/* Tags */}
            {event.tags && event.tags.length > 0 && (
              <View style={styles.tagsRow}>
                {event.tags.map((tag) => (
                  <View key={tag} style={styles.tag}>
                    <Text style={styles.tagText}>#{tag}</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Reviews — shown once event is completed */}
            {event.state === 'completed' && (
              <ReviewsSection
                entityType="event"
                entityId={event.id}
                entityName={event.title}
                canReview={!!userId && event.myRsvp === 'going'}
              />
            )}
          </View>
        </ScrollView>
      ) : null}

      {/* RSVP / action bar */}
      {event && !isBanned && !loading && (
        <View style={[styles.actionBar, { paddingBottom: insets.bottom + space.md }]}>
          {event.state === 'cancelled' || event.state === 'archived' ? (
            <View style={styles.cancelledNote}>
              <Text style={styles.cancelledText}>This event was {event.state}</Text>
            </View>
          ) : event.myRsvp ? (
            <View style={styles.rsvpRow}>
              <Pressable
                style={styles.rsvpCurrentBtn}
                onPress={() => setShowRsvpMenu((v) => !v)}
                disabled={rsvp.busy}
              >
                <Text style={styles.rsvpCurrentText}>
                  {RSVP_OPTIONS.find((o) => o.key === event.myRsvp)?.label ?? 'Going'}{' '}
                  {RSVP_OPTIONS.find((o) => o.key === event.myRsvp)?.emoji}
                </Text>
                <ChevronDown size={14} color={color.ink} />
              </Pressable>

              {event.chatThreadId && event.chatEnabled && (
                <Pressable
                  style={styles.chatBtn}
                  onPress={() => rsvp.handleJoinChat((id) => router.push(`/messages/${id}` as any))}
                >
                  <MessageSquare size={18} color={color.ink} />
                </Pressable>
              )}
            </View>
          ) : event.visibility === 'invite_only' ? (
            <Pressable
              style={styles.rsvpBtn}
              onPress={() => rsvp.handleRequestJoin()}
              disabled={rsvp.busy}
            >
              <Text style={styles.rsvpBtnText}>Request to join</Text>
            </Pressable>
          ) : event.myWaitlistPosition != null && event.myWaitlistOfferExpiresAt ? (
            <View style={styles.offerRow}>
              <Pressable style={styles.rsvpBtn} onPress={rsvp.handleAcceptOffer} disabled={rsvp.busy}>
                {rsvp.busy
                  ? <ActivityIndicator color={color.onInk} />
                  : <Text style={styles.rsvpBtnText}>Accept spot offer</Text>}
              </Pressable>
              <Pressable
                style={styles.leaveWaitlistBtn}
                onPress={rsvp.handleLeaveWaitlist}
                disabled={rsvp.busy}
              >
                <Text style={styles.leaveWaitlistText}>Leave waitlist</Text>
              </Pressable>
            </View>
          ) : event.myWaitlistPosition != null ? (
            <Pressable style={styles.leaveWaitlistBtn} onPress={rsvp.handleLeaveWaitlist} disabled={rsvp.busy}>
              <Text style={styles.leaveWaitlistText}>Leave waitlist</Text>
            </Pressable>
          ) : ['full', 'waitlist'].includes(event.state) ? (
            <Pressable style={styles.waitlistBtn} onPress={rsvp.handleJoinWaitlist} disabled={rsvp.busy}>
              <Text style={styles.waitlistBtnText}>Join waitlist</Text>
            </Pressable>
          ) : ['open', 'started', 'full', 'waitlist'].includes(event.state) ? (
            <Pressable
              style={styles.rsvpBtn}
              onPress={() => setShowRsvpMenu((v) => !v)}
              disabled={rsvp.busy}
            >
              {rsvp.busy
                ? <ActivityIndicator color={color.onInk} />
                : <Text style={styles.rsvpBtnText}>RSVP</Text>}
            </Pressable>
          ) : null}
        </View>
      )}

      {/* RSVP dropdown menu */}
      {showRsvpMenu && event && (
        <View style={[styles.rsvpMenu, { bottom: insets.bottom + 80 }]}>
          {RSVP_OPTIONS.filter((o) => event.rsvpOptions.includes(o.key)).map((o) => (
            <Pressable
              key={o.key}
              style={[styles.rsvpMenuItem, event.myRsvp === o.key && styles.rsvpMenuItemActive]}
              onPress={() => { setShowRsvpMenu(false); rsvp.handleRsvp(o.key); }}
            >
              <Text style={styles.rsvpMenuItemText}>{o.emoji} {o.label}</Text>
            </Pressable>
          ))}
          {event.myRsvp && (
            <Pressable
              style={styles.rsvpMenuLeave}
              onPress={() => { setShowRsvpMenu(false); rsvp.handleLeave(); }}
            >
              <Text style={styles.rsvpMenuLeaveText}>Leave event</Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Host Dashboard */}
      {showDashboard && event && (
        <HostDashboardPanel
          event={event}
          onDismiss={() => setShowDashboard(false)}
          onRefresh={load}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:         { flex: 1, backgroundColor: color.paper },
  header:            { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.md },
  headerBtn:         { padding: 4 },
  headerTitle:       { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  headerActions:     { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  overflowMenu:      { position: 'absolute', top: 58, right: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, zIndex: 50, overflow: 'hidden', minWidth: 160 },
  overflowItem:      { padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  overflowItemText:  { ...t.body, color: color.ink },
  center:            { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:         { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:          { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:         { ...t.small, color: color.onInk, fontWeight: '700' },
  scroll:            { paddingBottom: 120 },
  cover:             { width: '100%', height: 200 },
  coverPlaceholder:  { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  body:              { padding: space.lg, gap: space.md },
  stateBadge:        { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  stateBadgeText:    { fontSize: 12, fontWeight: '700' },
  title:             { ...t.title, color: color.ink, fontWeight: '800', fontSize: 22 },
  metaRow:           { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta:              { ...t.body, color: color.mute },
  gateBox:           { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, gap: space.xs },
  gateRow:           { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gateText:          { ...t.small, color: color.mute, fontWeight: '600' },
  safetyBox:         { backgroundColor: '#F3E8FF', borderRadius: radius.md, padding: space.md, gap: space.xs, borderWidth: 1, borderColor: '#DDD6FE' },
  safetyHeader:      { flexDirection: 'row', alignItems: 'center', gap: 6 },
  safetyTitle:       { ...t.small, color: '#7C3AED', fontWeight: '700' },
  safetyText:        { ...t.small, color: '#6D28D9', lineHeight: 18 },
  hostRow:           { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  hostLabel:         { ...t.small, color: color.mute },
  hostName:          { ...t.body, color: color.ink, fontWeight: '700' },
  attendeeRow:       { flexDirection: 'row', alignItems: 'center' },
  avatarOverlap:     { marginRight: -8 },
  avatarMore:        { width: 32, height: 32, borderRadius: 16, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarMoreText:    { ...t.stamp, color: color.mute, fontSize: 11 },
  waitlistBanner:    { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#EFF6FF', borderRadius: radius.md, padding: space.md },
  waitlistText:      { ...t.small, color: '#2563EB', flex: 1 },
  descBox:           { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md },
  descText:          { ...t.body, color: color.ink, lineHeight: 22 },
  tagsRow:           { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tag:               { backgroundColor: color.haze, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill },
  tagText:           { ...t.small, color: color.mute },
  actionBar:         { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze, padding: space.lg, ...shadow.card },
  rsvpRow:           { flexDirection: 'row', gap: space.sm },
  rsvpBtn:           { flex: 1, backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center' },
  rsvpBtnText:       { ...t.body, color: color.onInk, fontWeight: '700' },
  rsvpCurrentBtn:    { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.md, borderWidth: 1, borderColor: color.haze },
  rsvpCurrentText:   { ...t.body, color: color.ink, fontWeight: '700' },
  chatBtn:           { backgroundColor: color.haze, borderRadius: radius.pill, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  waitlistBtn:       { flex: 1, backgroundColor: '#2563EB', borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center' },
  waitlistBtnText:   { ...t.body, color: '#fff', fontWeight: '700' },
  offerRow:          { flex: 1, gap: space.sm },
  leaveWaitlistBtn:  { flex: 1, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  leaveWaitlistText: { ...t.body, color: color.mute, fontWeight: '600' },
  cancelledNote:     { flex: 1, alignItems: 'center', paddingVertical: space.sm },
  cancelledText:     { ...t.body, color: color.mute },
  rsvpMenu:          { position: 'absolute', left: space.lg, right: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', zIndex: 50 },
  rsvpMenuItem:      { padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  rsvpMenuItemActive:{ backgroundColor: '#F0FDF4' },
  rsvpMenuItemText:  { ...t.body, color: color.ink },
  rsvpMenuLeave:     { padding: space.md },
  rsvpMenuLeaveText: { ...t.body, color: '#DC2626', fontWeight: '600' },
});
