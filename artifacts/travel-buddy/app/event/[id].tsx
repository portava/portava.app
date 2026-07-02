/**
 * Event detail screen — /event/:id
 *
 * Shows cover photo, title, dates, location, RSVP button, attendee count/avatars,
 * waitlist position, host info, eligibility gates, safety notes, tags, save/share/report.
 * Host/co-host: tap Settings icon for HostDashboardPanel.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, Alert, Image, Share, ActionSheetIOS, Platform,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, MapPin, CalendarClock, Users, Clock, Check,
  ChevronDown, MessageSquare, Shield, Star, Link, Settings,
  Bookmark, BookmarkCheck, Share2, MoreVertical, Flag,
} from 'lucide-react-native';
import {
  getEvent, rsvpEvent, leaveEvent, joinWaitlist, leaveWaitlist,
  acceptWaitlistOffer, requestToJoinEvent, joinEventChat,
  saveEvent, unsaveEvent, shareEvent, reportEvent,
  type EventDetail, type EventRsvpStatus,
} from '../../src/services/events';
import { HostDashboardPanel } from '../../src/components/HostDashboardPanel';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { Avatar } from '../../src/components/ui';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow } from '../../src/theme/tokens';

const STATE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  draft:     { label: 'Draft',          bg: color.haze, fg: color.mute },
  open:      { label: 'Open',           bg: '#DCFCE7', fg: '#16A34A' },
  full:      { label: 'Full',           bg: '#FEF3C7', fg: '#92400E' },
  waitlist:  { label: 'Waitlist open',  bg: '#EFF6FF', fg: '#2563EB' },
  started:   { label: 'Happening now',  bg: '#DCFCE7', fg: '#16A34A' },
  completed: { label: 'Completed',      bg: color.haze, fg: color.mute },
  cancelled: { label: 'Cancelled',      bg: '#FEE2E2', fg: '#DC2626' },
  archived:  { label: 'Archived',       bg: color.haze, fg: color.faint },
};

const RSVP_OPTIONS: { key: EventRsvpStatus; label: string; emoji: string }[] = [
  { key: 'going',      label: 'Going',      emoji: '✅' },
  { key: 'maybe',      label: 'Maybe',      emoji: '🤔' },
  { key: 'interested', label: 'Interested', emoji: '👀' },
  { key: 'cant_go',   label: "Can't go",   emoji: '❌' },
];

const REPORT_REASONS = [
  'Unsafe or dangerous',
  'Spam or scam',
  'Inappropriate content',
  'Misleading information',
  'Hateful or discriminatory',
  'Other',
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
  const [rsvpLoading, setRsvpLoading] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showRsvpMenu, setShowRsvpMenu] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    const res = await getEvent(id as string);
    if (!res.ok) setError(res.message ?? 'Failed to load event');
    else {
      setEvent(res.data ?? null);
      setIsSaved(!!(res.data as any)?.isSaved);
    }
    setLoading(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── RSVP ──────────────────────────────────────────────────────────────────
  async function handleRsvp(status: EventRsvpStatus) {
    if (!event) return;
    setRsvpLoading(true);
    setShowRsvpMenu(false);
    const res = await rsvpEvent(event.id, status);
    setRsvpLoading(false);
    if (!res.ok) {
      Alert.alert('Error', res.message ?? 'Could not update RSVP');
      return;
    }
    if (res.data && 'status' in res.data && (res.data as any).status === 'waitlisted') {
      Alert.alert('Added to waitlist', (res.data as any).message ?? 'You have been added to the waitlist.');
      await load();
      return;
    }
    setEvent((e) => e ? { ...e, myRsvp: status } : e);
    await load();
  }

  async function handleLeave() {
    if (!event) return;
    Alert.alert('Leave event?', 'Your RSVP will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive',
        onPress: async () => {
          const res = await leaveEvent(event.id);
          if (!res.ok) Alert.alert('Error', res.message);
          else await load();
        },
      },
    ]);
  }

  async function handleJoinWaitlist() {
    if (!event) return;
    const res = await joinWaitlist(event.id);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Could not join waitlist');
    else { Alert.alert('Added!', `You are #${res.data?.position} on the waitlist.`); await load(); }
  }

  async function handleAcceptOffer() {
    if (!event) return;
    setRsvpLoading(true);
    const res = await acceptWaitlistOffer(event.id);
    setRsvpLoading(false);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Could not accept offer');
    else { Alert.alert("You're in!", 'Your RSVP has been confirmed.'); await load(); }
  }

  async function handleLeaveWaitlist() {
    if (!event) return;
    Alert.alert('Leave waitlist?', 'Your spot in the queue will be removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave', style: 'destructive',
        onPress: async () => {
          setRsvpLoading(true);
          const res = await leaveWaitlist(event.id);
          setRsvpLoading(false);
          if (!res.ok) Alert.alert('Error', res.message ?? 'Could not leave waitlist');
          else await load();
        },
      },
    ]);
  }

  async function handleJoinChat() {
    if (!event) return;
    const res = await joinEventChat(event.id);
    if (!res.ok) { Alert.alert('Error', res.message ?? 'Could not join chat'); return; }
    if (res.data?.threadId) router.push(`/messages/${res.data.threadId}` as any);
  }

  async function handleRequestJoin() {
    if (!event) return;
    const res = await requestToJoinEvent(event.id);
    if (!res.ok) Alert.alert('Error', res.message ?? 'Could not send request');
    else Alert.alert('Request sent', 'The host will review your request.');
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  async function handleSaveToggle() {
    if (!event) return;
    setSaveLoading(true);
    const optimistic = !isSaved;
    setIsSaved(optimistic);
    const res = optimistic ? await saveEvent(event.id) : await unsaveEvent(event.id);
    setSaveLoading(false);
    if (!res.ok) setIsSaved(!optimistic);
  }

  // ── Share ──────────────────────────────────────────────────────────────────
  async function handleShare() {
    if (!event) return;
    const res = await shareEvent(event.id);
    const url = res.ok && res.data?.shareUrl
      ? res.data.shareUrl
      : `https://travelbuddy.app/event/${event.id}`;
    try {
      await Share.share({
        title: event.title,
        message: `Check out this event on Travel Buddy: ${event.title}\n${url}`,
        url,
      });
    } catch { }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  function handleReport() {
    if (!event) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...REPORT_REASONS, 'Cancel'], cancelButtonIndex: REPORT_REASONS.length, destructiveButtonIndex: 0, title: 'Report event' },
        async (idx) => {
          if (idx < REPORT_REASONS.length) {
            await reportEvent(event.id, REPORT_REASONS[idx]);
            Alert.alert('Report submitted', 'Thanks for keeping Travel Buddy safe.');
          }
        },
      );
    } else {
      Alert.alert('Report event', 'Why are you reporting this event?', [
        ...REPORT_REASONS.map((reason) => ({
          text: reason,
          onPress: async () => {
            await reportEvent(event.id, reason);
            Alert.alert('Report submitted', 'Thanks for keeping Travel Buddy safe.');
          },
        })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  }

  // ── Overflow menu ──────────────────────────────────────────────────────────
  function handleOverflow() {
    if (!event) return;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [isSaved ? 'Remove from saved' : 'Save event', 'Share event', 'Report event', 'Cancel'], cancelButtonIndex: 3 },
        (idx) => {
          if (idx === 0) handleSaveToggle();
          else if (idx === 1) handleShare();
          else if (idx === 2) handleReport();
        },
      );
    } else {
      Alert.alert(event.title, undefined, [
        { text: isSaved ? 'Remove from saved' : 'Save event', onPress: handleSaveToggle },
        { text: 'Share event', onPress: handleShare },
        { text: 'Report event', onPress: handleReport, style: 'destructive' },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }

  const isHost = event?.isHost || event?.myRole === 'host' || event?.myRole === 'co_host';
  const isBanned = event?.myRole === 'banned';
  const stateBadge = event ? (STATE_BADGE[event.state] ?? STATE_BADGE.open) : null;

  // ── Eligibility gate ───────────────────────────────────────────────────────
  // Returns a gate explanation string if the viewer cannot join, null if they can
  function getEligibilityBlock(): string | null {
    if (!event) return null;
    const gates: string[] = [];
    if (event.verifiedOnly) gates.push('verified identity required');
    if (event.trustScoreMin) gates.push(`trust score ≥${event.trustScoreMin} required`);
    if (event.ageMin) gates.push(`minimum age ${event.ageMin}`);
    if (event.ageMax) gates.push(`maximum age ${event.ageMax}`);
    // If event explicitly marks viewer as ineligible, surface it
    const ineligible = (event as any).viewerEligibility?.eligible === false;
    if (ineligible && gates.length > 0) return gates.join(' · ');
    return null;
  }
  const eligibilityBlock = getEligibilityBlock();

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={color.ink} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{event?.title ?? 'Event'}</Text>
        <View style={styles.headerRight}>
          {/* Save */}
          {event && !isHost && (
            <Pressable style={styles.headerBtn} onPress={handleSaveToggle} disabled={saveLoading} hitSlop={8}>
              {saveLoading
                ? <ActivityIndicator size="small" color={color.mute} />
                : isSaved
                  ? <BookmarkCheck size={20} color={color.signal} />
                  : <Bookmark size={20} color={color.mute} />}
            </Pressable>
          )}
          {/* Share */}
          {event && (
            <Pressable style={styles.headerBtn} onPress={handleShare} hitSlop={8}>
              <Share2 size={20} color={color.mute} />
            </Pressable>
          )}
          {/* Host dashboard */}
          {isHost ? (
            <Pressable style={styles.headerBtn} onPress={() => setShowDashboard(true)} hitSlop={8}>
              <Settings size={20} color={color.ink} />
            </Pressable>
          ) : event ? (
            <Pressable style={styles.headerBtn} onPress={handleOverflow} hitSlop={8}>
              <MoreVertical size={20} color={color.mute} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {loading && !event ? (
        <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retryBtn}><Text style={styles.retryText}>Retry</Text></Pressable>
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
                <Text style={styles.meta}>{event.locationName}{event.city ? `, ${event.city}` : ''}</Text>
              </View>
            )}

            {/* Capacity */}
            <View style={styles.metaRow}>
              <Users size={14} color={color.mute} />
              <Text style={styles.meta}>
                {event.counts.going} going{event.maxAttendees ? ` · ${event.maxAttendees} max` : ''}
                {event.waitlistCount > 0 ? ` · ${event.waitlistCount} waitlisted` : ''}
              </Text>
            </View>

            {/* Eligibility gate notice */}
            {eligibilityBlock && (
              <View style={styles.eligibilityBlock}>
                <Shield size={15} color="#B45309" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.eligibilityTitle}>You can't join this event</Text>
                  <Text style={styles.eligibilityDesc}>{eligibilityBlock}</Text>
                </View>
              </View>
            )}

            {/* Eligibility requirements box (always shown if present) */}
            {(event.trustScoreMin || event.ageMin || event.ageMax || event.verifiedOnly || (event.priceType === 'external' && event.priceUrl)) && (
              <View style={styles.gateBox}>
                <Text style={styles.gateBoxTitle}>Requirements</Text>
                {event.verifiedOnly && (
                  <View style={styles.gateRow}>
                    <Shield size={13} color="#7C3AED" />
                    <Text style={styles.gateText}>Verified identity required</Text>
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
                      Ages {event.ageMin ? `${event.ageMin}+` : ''}
                      {event.ageMin && event.ageMax ? '–' : ''}
                      {event.ageMax ?? ''}
                    </Text>
                  </View>
                )}
                {event.priceType === 'external' && event.priceUrl && (
                  <View style={styles.gateRow}>
                    <Link size={13} color="#2563EB" />
                    <Text style={[styles.gateText, { color: '#2563EB' }]}>External ticketing required</Text>
                  </View>
                )}
              </View>
            )}

            {/* Host */}
            {event.host && (
              <Pressable
                style={styles.hostRow}
                onPress={() => router.push(`/profile/${event.host!.id}` as any)}
              >
                <Avatar uri={event.host.avatarUrl ?? ''} size={36} />
                <View>
                  <Text style={styles.hostLabel}>Hosted by</Text>
                  <Text style={styles.hostName}>{event.host.displayName ?? event.host.handle ?? 'Unknown'}</Text>
                </View>
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

            {/* Waitlist position banner */}
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

            {/* Safety notes */}
            {(event as any).safetyNotes ? (
              <View style={styles.safetyBox}>
                <View style={styles.safetyHeader}>
                  <Shield size={14} color="#7C3AED" />
                  <Text style={styles.safetyTitle}>Safety notes</Text>
                </View>
                <Text style={styles.safetyText}>{(event as any).safetyNotes}</Text>
              </View>
            ) : null}

            {/* Ticket link */}
            {event.priceType === 'external' && event.priceUrl ? (
              <Pressable
                style={styles.ticketBtn}
                onPress={() => Alert.alert('External tickets', `Open ${event.priceUrl} to purchase tickets.`, [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Open link', onPress: () => { } },
                ])}
              >
                <Link size={14} color="#2563EB" />
                <Text style={styles.ticketBtnText}>Get tickets</Text>
              </Pressable>
            ) : (
              <View style={styles.freeTag}>
                <Check size={12} color="#16A34A" />
                <Text style={styles.freeTagText}>Free event</Text>
              </View>
            )}

            {/* Report link */}
            {!isHost && (
              <Pressable style={styles.reportLink} onPress={handleReport}>
                <Flag size={13} color={color.faint} />
                <Text style={styles.reportLinkText}>Report this event</Text>
              </Pressable>
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
          ) : eligibilityBlock ? (
            /* Eligibility gate — RSVP button disabled with explanation */
            <View style={styles.blockedRow}>
              <Shield size={15} color="#B45309" />
              <Text style={styles.blockedText} numberOfLines={2}>{eligibilityBlock}</Text>
            </View>
          ) : event.myRsvp ? (
            <View style={styles.rsvpRow}>
              <Pressable
                style={styles.rsvpCurrentBtn}
                onPress={() => setShowRsvpMenu((v) => !v)}
                disabled={rsvpLoading}
              >
                <Text style={styles.rsvpCurrentText}>
                  {RSVP_OPTIONS.find((o) => o.key === event.myRsvp)?.label ?? 'Going'}{' '}
                  {RSVP_OPTIONS.find((o) => o.key === event.myRsvp)?.emoji}
                </Text>
                <ChevronDown size={14} color={color.ink} />
              </Pressable>
              {event.chatThreadId && event.chatEnabled && (
                <Pressable style={styles.chatBtn} onPress={handleJoinChat}>
                  <MessageSquare size={18} color={color.ink} />
                </Pressable>
              )}
            </View>
          ) : event.visibility === 'invite_only' ? (
            <Pressable style={styles.rsvpBtn} onPress={handleRequestJoin} disabled={rsvpLoading}>
              <Text style={styles.rsvpBtnText}>Request to join</Text>
            </Pressable>
          ) : event.myWaitlistPosition != null && event.myWaitlistOfferExpiresAt ? (
            <View style={styles.offerRow}>
              <Pressable style={styles.rsvpBtn} onPress={handleAcceptOffer} disabled={rsvpLoading}>
                {rsvpLoading
                  ? <ActivityIndicator color={color.onInk} />
                  : <Text style={styles.rsvpBtnText}>Accept spot offer</Text>}
              </Pressable>
              <Pressable style={styles.leaveWaitlistBtn} onPress={handleLeaveWaitlist} disabled={rsvpLoading}>
                <Text style={styles.leaveWaitlistText}>Leave waitlist</Text>
              </Pressable>
            </View>
          ) : event.myWaitlistPosition != null ? (
            <Pressable style={styles.leaveWaitlistBtn} onPress={handleLeaveWaitlist} disabled={rsvpLoading}>
              <Text style={styles.leaveWaitlistText}>Leave waitlist</Text>
            </Pressable>
          ) : ['full', 'waitlist'].includes(event.state) ? (
            <Pressable style={styles.waitlistBtn} onPress={handleJoinWaitlist} disabled={rsvpLoading}>
              <Text style={styles.waitlistBtnText}>Join waitlist</Text>
            </Pressable>
          ) : ['open', 'started', 'full', 'waitlist'].includes(event.state) ? (
            <Pressable
              style={styles.rsvpBtn}
              onPress={() => setShowRsvpMenu((v) => !v)}
              disabled={rsvpLoading}
            >
              {rsvpLoading
                ? <ActivityIndicator color={color.onInk} />
                : <Text style={styles.rsvpBtnText}>RSVP</Text>}
            </Pressable>
          ) : null}
        </View>
      )}

      {/* RSVP dropdown menu */}
      {showRsvpMenu && event && (
        <Pressable
          style={styles.rsvpMenuOverlay}
          onPress={() => setShowRsvpMenu(false)}
        >
          <View style={[styles.rsvpMenu, { bottom: insets.bottom + 80 }]}>
            {RSVP_OPTIONS.filter((o) => event.rsvpOptions.includes(o.key)).map((o) => (
              <Pressable
                key={o.key}
                style={[styles.rsvpMenuItem, event.myRsvp === o.key && styles.rsvpMenuItemActive]}
                onPress={() => handleRsvp(o.key)}
              >
                <Text style={styles.rsvpMenuItemText}>{o.emoji} {o.label}</Text>
              </Pressable>
            ))}
            {event.myRsvp && (
              <Pressable style={styles.rsvpMenuLeave} onPress={() => { setShowRsvpMenu(false); handleLeave(); }}>
                <Text style={styles.rsvpMenuLeaveText}>Leave event</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
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
  container:          { flex: 1, backgroundColor: color.paper },
  header:             { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze, backgroundColor: color.paperRaised, gap: space.sm },
  headerBtn:          { padding: 4 },
  headerTitle:        { ...t.title, color: color.ink, fontWeight: '800', flex: 1 },
  headerRight:        { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  center:             { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl, gap: space.md },
  errorText:          { ...t.body, color: color.mute, textAlign: 'center' },
  retryBtn:           { paddingHorizontal: space.lg, paddingVertical: space.sm, backgroundColor: color.signal, borderRadius: radius.pill },
  retryText:          { ...t.small, color: color.onInk, fontWeight: '700' },
  scroll:             { paddingBottom: 120 },
  cover:              { width: '100%', height: 220 },
  coverPlaceholder:   { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  body:               { padding: space.lg, gap: space.md },
  stateBadge:         { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  stateBadgeText:     { fontSize: 12, fontWeight: '700' },
  title:              { ...t.title, color: color.ink, fontWeight: '800', fontSize: 22 },
  metaRow:            { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta:               { ...t.body, color: color.mute },
  eligibilityBlock:   { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: '#FEF3C7', borderRadius: radius.md, padding: space.md, borderWidth: 1, borderColor: '#F59E0B' },
  eligibilityTitle:   { ...t.body, color: '#92400E', fontWeight: '700' },
  eligibilityDesc:    { ...t.small, color: '#92400E', marginTop: 2 },
  gateBox:            { backgroundColor: color.haze, borderRadius: radius.md, padding: space.md, gap: 6 },
  gateBoxTitle:       { ...t.small, color: color.mute, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  gateRow:            { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gateText:           { ...t.small, color: color.mute, fontWeight: '600' },
  hostRow:            { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  hostLabel:          { ...t.small, color: color.mute },
  hostName:           { ...t.body, color: color.ink, fontWeight: '700' },
  attendeeRow:        { flexDirection: 'row', alignItems: 'center', marginLeft: 4 },
  avatarOverlap:      { marginRight: -8 },
  avatarMore:         { width: 32, height: 32, borderRadius: 16, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  avatarMoreText:     { ...t.stamp, color: color.mute, fontSize: 11 },
  waitlistBanner:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#EFF6FF', borderRadius: radius.md, padding: space.md },
  waitlistText:       { ...t.small, color: '#2563EB', flex: 1 },
  descBox:            { backgroundColor: color.paperRaised, borderRadius: radius.md, padding: space.md },
  descText:           { ...t.body, color: color.ink, lineHeight: 22 },
  safetyBox:          { backgroundColor: '#F5F3FF', borderRadius: radius.md, padding: space.md, gap: 6, borderWidth: 1, borderColor: '#DDD6FE' },
  safetyHeader:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  safetyTitle:        { ...t.body, color: '#7C3AED', fontWeight: '700' },
  safetyText:         { ...t.body, color: '#4C1D95', lineHeight: 20 },
  ticketBtn:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: space.md, backgroundColor: '#EFF6FF', borderRadius: radius.md, borderWidth: 1, borderColor: '#BFDBFE' },
  ticketBtnText:      { ...t.body, color: '#2563EB', fontWeight: '700' },
  freeTag:            { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  freeTagText:        { ...t.small, color: '#16A34A', fontWeight: '600' },
  reportLink:         { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', paddingVertical: space.sm },
  reportLinkText:     { ...t.small, color: color.faint },

  actionBar:          { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: color.paperRaised, borderTopWidth: 1, borderTopColor: color.haze, padding: space.lg, ...shadow.card },
  blockedRow:         { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FEF3C7', borderRadius: radius.md, padding: space.md },
  blockedText:        { ...t.small, color: '#92400E', flex: 1, fontWeight: '600' },
  rsvpRow:            { flexDirection: 'row', gap: space.sm },
  rsvpBtn:            { flex: 1, backgroundColor: color.signal, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center' },
  rsvpBtnText:        { ...t.body, color: color.onInk, fontWeight: '700' },
  rsvpCurrentBtn:     { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.md, borderWidth: 1, borderColor: color.haze },
  rsvpCurrentText:    { ...t.body, color: color.ink, fontWeight: '700' },
  chatBtn:            { backgroundColor: color.haze, borderRadius: radius.pill, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  waitlistBtn:        { flex: 1, backgroundColor: '#2563EB', borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center' },
  waitlistBtnText:    { ...t.body, color: '#fff', fontWeight: '700' },
  offerRow:           { flex: 1, gap: space.sm },
  leaveWaitlistBtn:   { flex: 1, backgroundColor: color.paperRaised, borderRadius: radius.pill, paddingVertical: space.md, alignItems: 'center', borderWidth: 1, borderColor: color.haze },
  leaveWaitlistText:  { ...t.body, color: color.mute, fontWeight: '600' },
  cancelledNote:      { flex: 1, alignItems: 'center', paddingVertical: space.sm },
  cancelledText:      { ...t.body, color: color.mute },
  rsvpMenuOverlay:    { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 },
  rsvpMenu:           { position: 'absolute', left: space.lg, right: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', zIndex: 50 },
  rsvpMenuItem:       { padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  rsvpMenuItemActive: { backgroundColor: '#F0FDF4' },
  rsvpMenuItemText:   { ...t.body, color: color.ink },
  rsvpMenuLeave:      { padding: space.md },
  rsvpMenuLeaveText:  { ...t.body, color: '#DC2626', fontWeight: '600' },
});
