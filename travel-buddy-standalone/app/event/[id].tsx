/**
 * Event detail screen — /event/:id
 *
 * Shows cover photo, title, dates, location map pin, RSVP button, attendee strip,
 * waitlist position, host info, eligibility gates, safety notes, tags,
 * chat / reminders / add-to-trip entry points, save/share/report.
 * Host/co-host: tap Settings icon for HostDashboardPanel.
 *
 * RSVP state machine (action bar):
 *   completed → "This event has ended" (no actions)
 *   cancelled/archived → "This event was [state]" (no actions)
 *   eligibility blocked → blocked row
 *   rsvpClosed → "RSVPs closed" note
 *   already RSVP'd → change RSVP dropdown + chat button
 *   invite_only, no pending request → "Request to join"
 *   invite_only, pending request → "Request sent" (disabled)
 *   waitlist offer_pending → Accept / Leave
 *   waitlist offer_expired → "Offer expired" + Leave
 *   on waitlist, no offer → Leave waitlist
 *   event full + waitlist → Join waitlist
 *   event full + no waitlist → "Full — no waitlist"
 *   attendeeActions.canRsvp → RSVP dropdown (open/started; not banned)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, ActivityIndicator,
  StyleSheet, Alert, Image, Share, ActionSheetIOS, Platform, Linking,
  Animated,
} from 'react-native';
import { CachedImage } from '../../src/components/CachedImage';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { openMapsNavigation } from '../../src/lib/maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft, MapPin, CalendarClock, Users, Clock, Check,
  ChevronDown, MessageSquare, Shield, Star, Link, Settings,
  Bookmark, BookmarkCheck, MoreVertical, Flag,
  Bell, Briefcase, Compass, Map, Lock,
} from 'lucide-react-native';
import { PortavaShareIcon } from '../../src/components/icons/PortavaShareIcon.tsx';
import {
  getEvent,
  saveEvent, unsaveEvent, shareEvent, reportEvent, addEventToTrip,
  buildRentBuddyCtaUrl, shouldShowRentBuddyCta,
  getEventReminders, createEventReminder, deleteEventReminder,
  type EventDetail, type EventRsvpStatus, type EventReminder,
} from '../../src/services/events';
import { scheduleLocalNotificationAt, cancelScheduledNotification } from '../../src/lib/safeNotifications';
import { checkCityAvailable, getTopInCity, type BuddyProfile } from '../../src/services/rentABuddy';
import { BuddyCard, BuddyCardSkeleton } from '../../src/components/BuddyCard';
import { useRentABuddyFlag } from '../../src/hooks/useRentABuddyFlag';
import { useScreenTiming } from '../../src/hooks/useScreenTiming';
import { useEventRsvp } from '../../src/hooks/useEventRsvp';
import { EventPassportShareCard } from '../../src/features/passport/EventPassportShareCard';
import { HostDashboardPanel } from '../../src/components/HostDashboardPanel';
import { EventVoiceRoomCard } from '../../src/components/events/EventVoiceRoomCard.tsx';
import { StampButton } from '../../src/components/stamps/StampButton';
import { ReviewsSection } from '../../src/components/ReviewsSection';
import { ReportSheet } from '../../src/components/ReportSheet';
import { SharedVideoPlayer } from '../../src/components/ui/SharedVideoPlayer';
import { Avatar } from '../../src/components/ui';
import { UserAvatarButton } from '../../src/components/interaction/UserAvatarButton';
import { useSession } from '../../src/context/SessionContext';
import { color, space, radius, type as t, shadow, avatar } from '../../src/theme/tokens';
import { primaryIdentityText } from '../../src/lib/displayIdentity';
import { getWaitlistUiState } from '../../src/lib/waitlistState';
import { getAttendeeActionSet, effectiveEventState, type EventLifecycleState } from '../../src/lib/eventRoleActions';
import { useNavBarScrollHandler } from '../../src/hooks/useNavBarCollapse';
import { useStickyBarInset } from '../../src/hooks/useBottomInset';
import { FOCUS_REFETCH_TTL_MS } from '../../src/hooks/usePosts';
import { PrivateEventCard, type PrivateEventPreview } from '../../src/components/privacy/PrivateEventCard';
import { useVisualStatusChannel } from '../../src/hooks/useVisualStatusChannel.ts';
import { AiRepresentationLabel } from '../../src/components/visuals/AiRepresentationLabel.tsx';
import { resolveHeaderImage } from '../../src/lib/visuals/resolveHeaderImage';
import { fallbackUriFor } from '../../src/lib/visuals/fallbackAssets';
import { PlaceInfoSection } from '../../src/components/place/PlaceInfoSection';
import { getVenueInfoByCoords, clearVenueInfoCache, getCanonicalPlace, type VenueContactInfo } from '../../src/services/places';
import type { CanonicalPlace } from '../../src/types/canonicalPlace';
import { canonicalUrl } from '../../src/constants/canonicalUrl';
import { readFeedSession } from '../../src/lib/feedAttribution.ts';

/**
 * Composes the location subtitle line, avoiding a duplicated city when
 * `locationName` already ends with the city (e.g. locationName="Cebu,
 * Philippines" + city="Cebu" previously rendered "Cebu, Philippines, Cebu").
 */
function formatEventLocationLine(locationName?: string | null, city?: string | null): string {
  const name = locationName?.trim() ?? '';
  const c = city?.trim() ?? '';
  if (!name) return c;
  if (!c) return name;
  const normalizedName = name.toLowerCase();
  const normalizedCity = c.toLowerCase();
  if (normalizedName === normalizedCity || normalizedName.includes(normalizedCity)) return name;
  return `${name}, ${c}`;
}

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

/** Open the event location in the platform's native maps app (web falls back to Google Maps web URL). */
function openMap(locationName: string | null, lat: number | null, lng: number | null, city: string | null) {
  if (lat == null && lng == null && !locationName) return;
  openMapsNavigation({
    name: locationName ?? 'Event location',
    city,
    lat,
    lng,
  });
}

export default function EventDetailScreen() {
  const insets = useSafeAreaInsets();
  const { inset: barInset, onBarLayout } = useStickyBarInset();
  const { id, tripId: tripIdParam, sessionId: rawFeedSession } =
    useLocalSearchParams<{ id: string; tripId?: string; sessionId?: string }>();
  // Present only when this screen was opened from a feed card; null for deep
  // links, notifications and search. See src/lib/feedAttribution.ts.
  const feedSessionId = readFeedSession(rawFeedSession);
  const { userId } = useSession();
  const { enabled: rentBuddyEnabled } = useRentABuddyFlag();
  const navBarScrollHandler = useNavBarScrollHandler();
  const { markFirstContent, epoch } = useScreenTiming('EventDetail');

  const [event, setEvent] = useState<EventDetail | null>(null);
  /** Set when the API returns a private-event sentinel (isPrivate: true). */
  const [privateEvent, setPrivateEvent] = useState<PrivateEventPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDashboard, setShowDashboard] = useState(false);
  const [showRsvpMenu, setShowRsvpMenu] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [addingToTrip, setAddingToTrip] = useState(false);
  const [addedToTrip, setAddedToTrip] = useState(false);
  // null = loading/unknown; true = buddies available in this city; false = none/unavailable
  const [buddyCityAvailable, setBuddyCityAvailable] = useState<boolean | null>(null);
  // Top buddies shown inline below the CTA; null = not yet fetched
  const [previewBuddies, setPreviewBuddies] = useState<BuddyProfile[] | null>(null);
  const [buddyPreviewLoading, setBuddyPreviewLoading] = useState(false);
  // hasPendingRequest is seeded from backend on load; optimistically set true
  // when the viewer sends a request in this session.
  const [hasPendingRequest, setHasPendingRequest] = useState(false);
  const [reportSheetVisible, setReportSheetVisible] = useState(false);
  // Canonical place linked to this event — loaded when event.canonicalPlaceId is set.
  const [canonicalEventPlace, setCanonicalEventPlace] = useState<CanonicalPlace | null>(null);
  // Set when the API returns { locked: true } — the event exists but the viewer
  // is not authorized.  Renders a private-wall screen rather than an empty
  // full-detail layout with undefined fields.
  const [isLocked, setIsLocked] = useState(false);
  // Local AI cover override — applied when a realtime generated_visuals row
  // transitions to ready, so the hero crossfades in without a full reload.
  const [localAiCoverUrl, setLocalAiCoverUrl] = useState<string | null>(null);
  const aiCoverOpacity = useRef(new Animated.Value(0)).current;
  // Venue contact info enriched from FSQ via coordinates — null = loading/unavailable.
  const [venueInfo, setVenueInfo] = useState<VenueContactInfo | null>(null);
  // Reminders — the viewer's own upcoming (unsent) reminder for this event, if any.
  const [reminder, setReminder] = useState<EventReminder | null>(null);
  const [reminderBusy, setReminderBusy] = useState(false);
  const reminderNotifIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setIsLocked(false);
    setPrivateEvent(null);
    const res = await getEvent(id as string);
    if (!res.ok) {
      setError(res.message ?? 'Failed to load event');
    } else {
      const d = res.data as any;
      if (d?.locked === true || d?.isPrivate === true) {
        // Full private-event sentinel: minimal preview fields available.
        setPrivateEvent({
          isPrivate: true,
          id: d.id ?? d.eventId ?? id,
          title: d.title ?? null,
          coverImageUrl: d.coverImageUrl ?? d.coverUrl ?? null,
          hostDisplayName: d.host?.displayName ?? d.hostDisplayName ?? null,
          hostHandle: d.host?.handle ?? d.hostHandle ?? null,
          hostId: d.host?.id ?? d.hostId ?? null,
          myJoinRequestStatus: d.myJoinRequestStatus === 'pending' ? 'pending' : null,
        });
      } else {
        setEvent(res.data ?? null);
        setIsSaved(!!(res.data as any)?.isSaved);
        // Hydrate pending-request state from backend truth on every load/refresh
        setHasPendingRequest(res.data?.myJoinRequestStatus === 'pending');
      }
    }
    setLoading(false);
  }, [id]);

  // Tracks when the last load fired so focus-driven reloads are skipped within
  // the TTL window (60 s) — avoids redundant fetches on rapid back-navigation.
  const lastLoadAt = useRef(0);

  useFocusEffect(useCallback(() => {
    if (Date.now() - lastLoadAt.current >= FOCUS_REFETCH_TTL_MS) {
      lastLoadAt.current = Date.now();
      load();
    }
  }, [load]));

  /** Pull-to-refresh / host dashboard refresh: bypass the TTL guard. */
  const refreshLoad = useCallback(() => {
    lastLoadAt.current = 0;
    load();
  }, [load]);

  // Perf timing: fire on every focus cycle when event data is loaded.
  // epoch increments on each focus so warm opens fire even without data changes.
  useEffect(() => {
    if (event) markFirstContent();
  }, [epoch, !!event]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset AI cover override when the viewer navigates to a different event ──
  useEffect(() => {
    setLocalAiCoverUrl(null);
    aiCoverOpacity.setValue(0);
  }, [event?.id, aiCoverOpacity]);

  // ── Realtime AI image updates — hero crossfade ────────────────────────────
  // coverSource ('user_upload' | 'ai_generated' | null) lets the priority guard
  // block AI images from overwriting a user-uploaded cover even when the AI job
  // finishes before updatedAt is updated.
  useVisualStatusChannel({
    entityType: 'event',
    entityId: event?.id ?? null,
    currentSource: event?.coverSource ?? null,
    currentImageUpdatedAt: event?.updatedAt ?? null,
    onReady: useCallback((payload) => {
      setLocalAiCoverUrl(payload.imageUrl);
      aiCoverOpacity.setValue(0);
      Animated.timing(aiCoverOpacity, {
        toValue: 1,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }, [aiCoverOpacity]),
  });

  // ── RSVP state machine (centralised hook) ─────────────────────────────────
  const {
    busy: rsvpLoading,
    handleRsvp,
    handleLeave,
    handleJoinWaitlist,
    handleLeaveWaitlist,
    handleAcceptOffer,
    handleRequestJoin,
    handleJoinChat: rsvpJoinChat,
  } = useEventRsvp(event, load, (updater) => setEvent((e) => e ? updater(e) : e), { sessionId: feedSessionId });

  function handleRsvpWithMenu(status: EventRsvpStatus) {
    setShowRsvpMenu(false);
    handleRsvp(status);
  }

  function handleJoinChat() {
    rsvpJoinChat((threadId) => router.push(`/messages/${threadId}` as any));
  }

  async function handleSendRequest() {
    const ok = await handleRequestJoin();
    if (ok) setHasPendingRequest(true);
    // if !ok the hook already showed an Alert — do not set pending
  }

  // ── City buddy availability check for "Find a Travel Buddy" CTA ────────────
  useEffect(() => {
    if (!event?.city || !rentBuddyEnabled) { setBuddyCityAvailable(false); return; }
    let cancelled = false;
    checkCityAvailable(event.city).then((res) => {
      if (!cancelled) setBuddyCityAvailable(res.available);
    }).catch(() => { if (!cancelled) setBuddyCityAvailable(false); });
    return () => { cancelled = true; };
  }, [event?.city, rentBuddyEnabled]);

  // ── Inline buddy preview — fetch top 3 once city availability is confirmed ──
  useEffect(() => {
    if (!buddyCityAvailable || !event?.city) {
      setPreviewBuddies(null);
      return;
    }
    let cancelled = false;
    setBuddyPreviewLoading(true);
    getTopInCity(event.city)
      .then((res) => {
        if (cancelled) return;
        setPreviewBuddies(res.ok ? (res.data?.buddies?.slice(0, 3) ?? []) : []);
        setBuddyPreviewLoading(false);
      })
      .catch(() => {
        if (!cancelled) { setPreviewBuddies([]); setBuddyPreviewLoading(false); }
      });
    return () => { cancelled = true; };
  }, [buddyCityAvailable, event?.city]);

  // ── Venue contact info enrichment (FSQ nearby lookup) ─────────────────────
  // Tracks the coordinates used for the most-recent venue fetch so we can
  // invalidate that cache entry if the event's location changes.
  const prevVenueCoordsRef = useRef<{ lat: number; lng: number; name: string | null | undefined } | null>(null);

  useEffect(() => {
    const lat = event?.locationLat;
    const lng = event?.locationLng;
    const name = event?.locationName ?? undefined;
    if (lat == null || lng == null) {
      setVenueInfo(null);
      prevVenueCoordsRef.current = null;
      return;
    }
    // When the event's location changes, evict the stale cache entry so the
    // next fetch returns fresh contact info for the new coordinates.
    const prev = prevVenueCoordsRef.current;
    if (prev !== null && (prev.lat !== lat || prev.lng !== lng || prev.name !== name)) {
      clearVenueInfoCache(prev.lat, prev.lng, prev.name);
    }
    prevVenueCoordsRef.current = { lat, lng, name };
    let cancelled = false;
    getVenueInfoByCoords(lat, lng, name).then((info) => {
      if (!cancelled) setVenueInfo(info);
    }).catch(() => { /* non-fatal; PlaceInfoSection falls back to event description */ });
    return () => { cancelled = true; };
  }, [event?.locationLat, event?.locationLng, event?.locationName]);

  // ── Canonical place linked to this event ─────────────────────────────────
  // Loads the place name for the "See destination" link row.  Fail-soft: a
  // missing or erroring fetch simply leaves canonicalEventPlace as null and
  // the link is omitted — the rest of the screen is unaffected.
  useEffect(() => {
    const placeId = (event as any)?.canonicalPlaceId as string | undefined;
    if (!placeId) { setCanonicalEventPlace(null); return; }
    let cancelled = false;
    getCanonicalPlace(placeId)
      .then((place) => { if (!cancelled) setCanonicalEventPlace(place); })
      .catch(() => { if (!cancelled) setCanonicalEventPlace(null); });
    return () => { cancelled = true; };
  }, [(event as any)?.canonicalPlaceId]);

  // ── Add to itinerary (when arriving from Trip Detail with tripId param) ────
  async function handleAddToItinerary() {
    if (!event || !tripIdParam || addingToTrip || addedToTrip) return;
    setAddingToTrip(true);
    const res = await addEventToTrip(event.id, tripIdParam);
    setAddingToTrip(false);
    if (res.ok) {
      setAddedToTrip(true);
    } else if (res.data && (res.data as any).alreadyAdded) {
      setAddedToTrip(true);
    } else {
      Alert.alert('Could not add', res.message ?? 'Something went wrong adding this event to your trip.');
    }
  }

  // ── Reminders ──────────────────────────────────────────────────────────────
  // Load the viewer's own upcoming reminder (if any) once the event is known,
  // so the button correctly shows "Reminder set" after navigating back in.
  useEffect(() => {
    if (!event) return;
    let cancelled = false;
    getEventReminders(event.id).then((res) => {
      if (cancelled || !res.ok) return;
      const upcoming = (res.data?.reminders ?? []).find((r) => !r.sent) ?? null;
      setReminder(upcoming);
    });
    return () => { cancelled = true; };
  }, [event?.id]);

  const REMINDER_OFFSETS: Array<{ label: string; minutesBefore: number }> = [
    { label: '15 minutes before', minutesBefore: 15 },
    { label: '1 hour before', minutesBefore: 60 },
    { label: '1 day before', minutesBefore: 60 * 24 },
  ];

  async function scheduleReminder(minutesBefore: number) {
    if (!event?.startsAt) return;
    const remindAt = new Date(new Date(event.startsAt).getTime() - minutesBefore * 60_000);
    if (remindAt.getTime() <= Date.now()) {
      Alert.alert('Too late', 'That reminder time has already passed for this event.');
      return;
    }
    setReminderBusy(true);
    const res = await createEventReminder(event.id, remindAt.toISOString());
    setReminderBusy(false);
    if (!res.ok || !res.data) {
      Alert.alert('Could not set reminder', res.message ?? 'Something went wrong.');
      return;
    }
    setReminder(res.data);
    const notifId = await scheduleLocalNotificationAt(remindAt, {
      title: event.title,
      body: `Starting soon — ${formatEventLocationLine(event.locationName, event.city)}`.trim(),
      data: { url: `/event/${event.id}` },
    });
    reminderNotifIdRef.current = notifId;
  }

  async function handleCancelReminder() {
    if (!event || !reminder) return;
    setReminderBusy(true);
    const res = await deleteEventReminder(event.id, reminder.id);
    setReminderBusy(false);
    if (!res.ok) {
      Alert.alert('Could not remove reminder', res.message ?? 'Something went wrong.');
      return;
    }
    await cancelScheduledNotification(reminderNotifIdRef.current);
    reminderNotifIdRef.current = null;
    setReminder(null);
  }

  function handleReminderPress() {
    if (!event || reminderBusy) return;
    if (reminder) {
      // Alert.alert with a button array is a no-op on react-native-web — it
      // silently does nothing, which is what made this button look dead on
      // web. Use window.confirm there instead (same pattern as the "Add to
      // trip" web fallback).
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && window.confirm(
          `Reminder set for ${new Date(reminder.remindAt).toLocaleString()}. Remove it?`
        )) {
          handleCancelReminder();
        }
        return;
      }
      Alert.alert('Reminder set', `We'll remind you at ${new Date(reminder.remindAt).toLocaleString()}.`, [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Remove reminder', style: 'destructive', onPress: handleCancelReminder },
      ]);
      return;
    }
    if (!event.startsAt) {
      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined') window.alert('This event does not have a start time yet.');
        return;
      }
      Alert.alert('No date set', 'This event does not have a start time yet.');
      return;
    }
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined') {
        const promptLabel = REMINDER_OFFSETS.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
        const choice = window.prompt(`Remind me:\n${promptLabel}\n\nEnter a number, or cancel.`);
        const idx = choice ? parseInt(choice, 10) - 1 : -1;
        if (idx >= 0 && idx < REMINDER_OFFSETS.length) scheduleReminder(REMINDER_OFFSETS[idx].minutesBefore);
      }
      return;
    }
    const options = [...REMINDER_OFFSETS.map((o) => o.label), 'Cancel'];
    const cancelButtonIndex = options.length - 1;
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex },
        (index) => {
          if (index === cancelButtonIndex) return;
          scheduleReminder(REMINDER_OFFSETS[index].minutesBefore);
        },
      );
    } else {
      Alert.alert(
        'Remind me',
        undefined,
        [
          ...REMINDER_OFFSETS.map((o) => ({ text: o.label, onPress: () => scheduleReminder(o.minutesBefore) })),
          { text: 'Cancel', style: 'cancel' as const },
        ],
      );
    }
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
    // The endpoint mints an event_share_links row and returns it raw; it does
    // not return a URL. Carry the token as ?share= on the event's own landing
    // path so the link stays addressable when no token could be minted (the
    // caller may not be host or co-host — that's a 403, not a failure to share).
    const res = await shareEvent(event.id);
    const token = res.ok ? res.data?.token : null;
    const path = `/event/${encodeURIComponent(event.id)}`;
    const url = canonicalUrl(token ? `${path}?share=${encodeURIComponent(token)}` : path);
    try {
      await Share.share({
        title: event.title,
        message: `Check out this event on Portava: ${event.title}\n${url}`,
        url,
      });
    } catch { }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  function handleReport() {
    if (!event) return;
    setReportSheetVisible(true);
  }

  // ── Overflow menu ──────────────────────────────────────────────────────────
  function handleOverflow() {
    if (!event) return;
    const goToCirclePresence = () =>
      router.push({
        pathname: '/circle-presence',
        params: {
          contextType: 'event',
          contextId: event.id,
          contextLabel: event.title ?? 'Event Circle',
          ...(event.endsAt ? { contextEndDate: event.endsAt } : {}),
          ...(isHost ? { isHost: 'true' } : {}),
        },
      } as any);
    const goToCircleSettings = () =>
      router.push({
        pathname: '/circle-context-settings',
        params: { contextType: 'event', contextId: event.id, contextLabel: event.title ?? 'this event' },
      } as any);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [
            isSaved ? 'Remove from saved' : 'Save event',
            'Share event',
            'Find Your Circle',
            'Circle sharing settings',
            'Report event',
            'Cancel',
          ],
          cancelButtonIndex: 5,
          destructiveButtonIndex: 4,
        },
        (idx) => {
          if (idx === 0) handleSaveToggle();
          else if (idx === 1) handleShare();
          else if (idx === 2) goToCirclePresence();
          else if (idx === 3) goToCircleSettings();
          else if (idx === 4) handleReport();
        },
      );
    } else {
      Alert.alert(event.title, undefined, [
        { text: isSaved ? 'Remove from saved' : 'Save event', onPress: handleSaveToggle },
        { text: 'Share event', onPress: handleShare },
        { text: 'Find Your Circle', onPress: goToCirclePresence },
        { text: 'Circle sharing settings', onPress: goToCircleSettings },
        { text: 'Report event', onPress: handleReport, style: 'destructive' },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }

  const isHost = event?.isHost || event?.myRole === 'host' || event?.myRole === 'co_host';
  const isBanned = event?.myRole === 'banned';

  const waitlistUiState = event ? getWaitlistUiState({
    myWaitlistPosition: event.myWaitlistPosition ?? null,
    myWaitlistOfferExpiresAt: event.myWaitlistOfferExpiresAt ?? null,
    eventState: event.state,
    myRsvp: event.myRsvp ?? null,
  }) : 'not_on_waitlist';

  // Correct for events whose date has passed while the server's stored
  // `state` is still an active one — see effectiveEventState doc comment.
  const displayState: EventLifecycleState | null = event
    ? effectiveEventState(event.state as EventLifecycleState, event.startsAt, event.endsAt)
    : null;
  const attendeeActions = event
    ? getAttendeeActionSet(event.myRole ?? null, displayState as EventLifecycleState)
    : { canRsvp: false, canLeave: false, canJoinWaitlist: false };
  const stateBadge = event ? (STATE_BADGE[displayState as string] ?? STATE_BADGE.open) : null;

  // ── Eligibility gate ───────────────────────────────────────────────────────
  function getEligibilityBlock(): string | null {
    if (!event) return null;
    const viewerEligibility = (event as any).viewerEligibility;
    if (viewerEligibility?.eligible === false) {
      const reason = viewerEligibility.reason as string | undefined;
      const parts: string[] = reason ? [reason] : [];
      if (!parts.length) {
        if (event.verifiedOnly)    parts.push('verified identity required');
        if (event.trustScoreMin)   parts.push(`trust score ≥${event.trustScoreMin} required`);
        if (event.ageMin)          parts.push(`minimum age ${event.ageMin}`);
        if (event.ageMax)          parts.push(`maximum age ${event.ageMax}`);
      }
      return parts.length ? parts.join(' · ') : 'You do not meet this event\'s requirements';
    }
    return null;
  }
  const eligibilityBlock = getEligibilityBlock();

  // Does the event have a known location to show on map?
  const hasMapLocation = !!(event?.locationLat || event?.locationLng || event?.locationName);

  return (
    <View style={styles.container}>
      {loading && !event ? (
        <>
          {/* Minimal back header for loading state */}
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>Event</Text>
            <View style={styles.headerRight} />
          </View>
          <View style={styles.center}><ActivityIndicator color={color.signal} /></View>
        </>
      ) : isLocked ? (
        <>
          {/* Private-wall header */}
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>Event</Text>
            <View style={styles.headerRight} />
          </View>
          <View style={styles.center}>
            <Lock size={36} color={color.mute} style={{ marginBottom: space.md }} />
            <Text style={styles.errorText}>This event is private.</Text>
            <Text style={[styles.errorText, { color: color.faint, marginTop: space.xs, fontSize: 13 }]}>
              You need an invitation to view the details.
            </Text>
            <Pressable onPress={() => router.back()} style={[styles.retryBtn, { marginTop: space.lg }]}>
              <Text style={styles.retryText}>Go back</Text>
            </Pressable>
          </View>
        </>
      ) : error ? (
        <>
          {/* Minimal back header for error state */}
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>Event</Text>
            <View style={styles.headerRight} />
          </View>
          {(error.includes('404') || error.toLowerCase().includes('not found')) ? (
            <View style={styles.center}>
              <Text style={styles.errorText}>This event is no longer available.</Text>
              <Pressable onPress={() => router.back()} style={styles.retryBtn}>
                <Text style={styles.retryText}>Go back</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.center}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable onPress={load} style={styles.retryBtn}><Text style={styles.retryText}>Retry</Text></Pressable>
            </View>
          )}
        </>
      ) : privateEvent ? (
        /* Private / invite-only event — show minimal wall, no address/times/attendees */
        <ScrollView contentContainerStyle={{ paddingBottom: barInset }} showsVerticalScrollIndicator={false}>
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {privateEvent.title ?? 'Private Event'}
            </Text>
            <View style={styles.headerRight} />
          </View>
          <PrivateEventCard
            event={privateEvent}
            onRequestSent={() => setHasPendingRequest(true)}
          />
        </ScrollView>
      ) : event && (event.state === 'cancelled' || event.state === 'archived') ? (
        <>
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>{event.title ?? 'Event'}</Text>
            <View style={styles.headerRight} />
          </View>
          <View style={styles.center}>
            <Text style={styles.errorText}>This event is no longer available.</Text>
            <Pressable onPress={() => router.back()} style={styles.retryBtn}>
              <Text style={styles.retryText}>Go back</Text>
            </Pressable>
          </View>
        </>
      ) : event ? (
        <ScrollView contentContainerStyle={{ paddingBottom: barInset }} onScroll={navBarScrollHandler} scrollEventThrottle={16}>
          {/* Header scrolls with event content */}
          <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
            <Pressable style={styles.headerBtn} onPress={() => router.back()} hitSlop={8}>
              <ArrowLeft size={22} color={color.ink} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>{event?.title ?? 'Event'}</Text>
            <View style={styles.headerRight}>
              {event && (
                <StampButton
                  entityType="event"
                  entityId={event.id}
                  initialCount={0}
                  initialIsStamped={false}
                  iconSize={20}
                />
              )}
              {event && !isHost && (
                <Pressable style={styles.headerBtn} onPress={handleSaveToggle} disabled={saveLoading} hitSlop={8}>
                  {saveLoading
                    ? <ActivityIndicator size="small" color={color.mute} />
                    : isSaved
                      ? <BookmarkCheck size={20} color={color.signal} />
                      : <Bookmark size={20} color={color.mute} />}
                </Pressable>
              )}
              {event && (
                <Pressable
                  style={styles.headerBtn}
                  onPress={handleShare}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Share this event"
                >
                  <PortavaShareIcon size={20} color={color.mute} />
                </Pressable>
              )}
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
          {/* Cover photo / video */}
          {event.coverUrl && event.coverMediaType === 'video' ? (
            <>
              <SharedVideoPlayer
                uri={event.coverUrl}
                autoplay={false}
                muted
                style={styles.cover}
              />
              <View style={styles.promoVideoBadge}>
                <Text style={styles.promoVideoText}>Promotional video</Text>
              </View>
            </>
          ) : (
            <View style={styles.cover}>
              {/* Base layer: original cover or placeholder */}
              {event.coverUrl ? (
                <CachedImage source={{ uri: event.coverUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
              ) : (
                (() => {
                  // Category-keyed fallback so the hero is never blank grey.
                  const resolved = resolveHeaderImage([], {
                    entityType: 'event',
                    category: event.category ?? undefined,
                    fallbackUrlFor: fallbackUriFor,
                  });
                  return resolved?.url ? (
                    <>
                      <Image source={{ uri: resolved.url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(17,17,15,0.3)' }]} />
                    </>
                  ) : (
                    <View style={[StyleSheet.absoluteFill, styles.coverPlaceholder]}>
                      <CalendarClock size={48} color={color.faint} />
                    </View>
                  );
                })()
              )}
              {/* AI cover crossfade layer — fades in when generated_visuals row transitions to ready */}
              {localAiCoverUrl && (
                <Animated.Image
                  source={{ uri: localAiCoverUrl }}
                  style={[StyleSheet.absoluteFill, { opacity: aiCoverOpacity }]}
                  resizeMode="cover"
                />
              )}
              {/* AI-generated representation disclosure */}
              {localAiCoverUrl && (
                <AiRepresentationLabel style={styles.aiCoverLabel} testID="event-detail-ai-label" />
              )}
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

            {/* Location row — tappable to open map */}
            {event.locationName && (
              <Pressable
                style={styles.metaRow}
                onPress={() => openMap(event.locationName, event.locationLat, event.locationLng, event.city)}
              >
                <MapPin size={14} color={color.signal} />
                <Text style={[styles.meta, { color: color.signal }]}>
                  {formatEventLocationLine(event.locationName, event.city)}
                </Text>
              </Pressable>
            )}

            {/* Map tile — native deep link with platform fallback */}
            {hasMapLocation && (
              <Pressable
                style={styles.mapTile}
                onPress={() => openMap(event.locationName, event.locationLat, event.locationLng, event.city)}
                accessibilityRole="button"
                accessibilityLabel="Open location in maps"
              >
                <View style={styles.mapTileInner}>
                  <Map size={22} color={color.signal} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.mapTileTitle}>
                      {event.locationName ?? `${event.locationLat?.toFixed(4)}, ${event.locationLng?.toFixed(4)}`}
                    </Text>
                    {event.city && <Text style={styles.mapTileCity}>{event.city}</Text>}
                  </View>
                  <Compass size={16} color={color.mute} />
                </View>
                {!event.showExactLocation && !event.isHost && event.myRsvp !== 'going' && (
                  <View style={styles.mapTilePrivate}>
                    <Lock size={11} color={color.mute} />
                    <Text style={styles.mapTilePrivateText}>Exact location shown after RSVP</Text>
                  </View>
                )}
              </Pressable>
            )}

            {/* Capacity */}
            <View style={styles.metaRow}>
              <Users size={14} color={color.mute} />
              <Text style={styles.meta}>
                {event.counts?.going ?? 0} going{event.maxAttendees ? ` · ${event.maxAttendees} max` : ''}
                {(event.waitlistCount ?? 0) > 0 ? ` · ${event.waitlistCount} waitlisted` : ''}
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

            {/* Eligibility requirements box */}
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

            {/* Live voice room entry (visible only inside the event context) */}
            <EventVoiceRoomCard eventId={event.id} />

            {/* Host */}
            {event.host && (
              <Pressable
                style={styles.hostRow}
                onPress={event.host!.handle ? () => router.push(`/u/${encodeURIComponent(event.host!.handle!)}` as any) : undefined}
              >
                <Avatar uri={event.host.avatarUrl ?? ''} size={36} />
                <View>
                  <Text style={styles.hostLabel}>Hosted by</Text>
                  <Text style={styles.hostName}>{primaryIdentityText({ displayName: event.host.displayName, handle: event.host.handle })}</Text>
                </View>
              </Pressable>
            )}

            {/* Attendee strip */}
            {(event.goingAttendees?.length ?? 0) > 0 && (
              <View style={styles.attendeeRow}>
                {(event.goingAttendees ?? []).slice(0, 5).map((a) => (
                  <View key={a.id} style={styles.avatarOverlap}>
                    <UserAvatarButton userId={a.id} handle={a.handle} avatarUrl={a.avatarUrl} size={32} />
                  </View>
                ))}
                {(event.counts?.going ?? 0) > 5 && (
                  <View style={[styles.avatarOverlap, styles.avatarMore]}>
                    <Text style={styles.avatarMoreText}>+{(event.counts?.going ?? 0) - 5}</Text>
                  </View>
                )}
              </View>
            )}

            {/* Waitlist position banner */}
            {event.myWaitlistPosition != null && (
              <View style={styles.waitlistBanner}>
                <Clock size={14} color="#2563EB" />
                <Text style={styles.waitlistText}>
                  Waitlisted — #{event.myWaitlistPosition} in queue
                  {event.myWaitlistOfferExpiresAt
                    ? ` · Offer expires ${new Date(event.myWaitlistOfferExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : ''}
                </Text>
              </View>
            )}

            {/* Venue info — FSQ-enriched phone/website/hours when coordinates
                available; falls back to event description text only. */}
            <PlaceInfoSection
              description={event.description}
              phone={venueInfo?.phone}
              website={venueInfo?.website}
              openingHours={venueInfo?.openingHours}
            />

            {/* "See destination" — shown when the event is linked to a canonical
                place; taps through to the Living Destination Page. */}
            {canonicalEventPlace ? (
              <Pressable
                style={styles.seeDestinationRow}
                onPress={() => router.push(`/place/${(event as any).canonicalPlaceId}` as any)}
                accessibilityRole="link"
                accessibilityLabel={`See ${canonicalEventPlace.name} destination page`}
              >
                <MapPin size={14} color={color.signal} />
                <Text style={styles.seeDestinationText}>
                  📍 {canonicalEventPlace.name} — See destination →
                </Text>
              </Pressable>
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
                onPress={async () => {
                  const url = event.priceUrl!;
                  const supported = await Linking.canOpenURL(url).catch(() => false);
                  if (supported) {
                    Linking.openURL(url).catch(() =>
                      Alert.alert('Could not open link', 'Copy the URL and open it in your browser.'),
                    );
                  } else {
                    Alert.alert('Ticket link', url);
                  }
                }}
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

            {/* Entry points row: Chat · Reminders · Add to trip · Map */}
            <View style={styles.entryRow}>
              {event.chatEnabled && (
                <Pressable style={styles.entryBtn} onPress={handleJoinChat}>
                  <MessageSquare size={16} color={color.signal} />
                  <Text style={styles.entryBtnText}>Event chat</Text>
                </Pressable>
              )}
              {/* Reminders */}
              <Pressable
                style={[styles.entryBtn, reminder && { borderColor: '#16A34A' }]}
                onPress={handleReminderPress}
                disabled={reminderBusy}
              >
                {reminderBusy
                  ? <ActivityIndicator size="small" color={color.signal} />
                  : <Bell size={16} color={reminder ? '#16A34A' : color.signal} />}
                <Text style={[styles.entryBtnText, reminder && { color: '#16A34A' }]}>
                  {reminder ? 'Reminder set' : 'Reminders'}
                </Text>
              </Pressable>
              {/* Add to trip / Add to Itinerary */}
              {tripIdParam ? (
                <Pressable
                  style={[styles.entryBtn, addedToTrip && { borderColor: '#16A34A' }]}
                  onPress={handleAddToItinerary}
                  disabled={addingToTrip || addedToTrip}
                >
                  {addingToTrip
                    ? <ActivityIndicator size="small" color={color.signal} />
                    : addedToTrip
                      ? <Check size={16} color="#16A34A" />
                      : <Briefcase size={16} color={color.signal} />}
                  <Text style={[styles.entryBtnText, addedToTrip && { color: '#16A34A' }]}>
                    {addedToTrip ? 'Added!' : 'Add to Itinerary'}
                  </Text>
                </Pressable>
              ) : (
                <Pressable
                  style={styles.entryBtn}
                  onPress={() => router.push({ pathname: '/trips', params: { addEventId: event.id } } as any)}
                >
                  <Briefcase size={16} color={color.signal} />
                  <Text style={styles.entryBtnText}>Add to trip</Text>
                </Pressable>
              )}
              {/* Map — open native maps */}
              {hasMapLocation && (
                <Pressable
                  style={styles.entryBtn}
                  onPress={() => openMap(event.locationName, event.locationLat, event.locationLng, event.city)}
                >
                  <Compass size={16} color={color.signal} />
                  <Text style={styles.entryBtnText}>Directions</Text>
                </Pressable>
              )}
            </View>

            {/* Find a Travel Buddy — inline preview section */}
            {shouldShowRentBuddyCta(event, rentBuddyEnabled, buddyCityAvailable) && (
              <View style={styles.findBuddySection}>
                {/* Header — tapping navigates to the full search screen */}
                <Pressable
                  testID="find-buddy-cta"
                  style={({ pressed }) => [styles.findBuddyCta, pressed && { opacity: 0.8 }]}
                  onPress={() => {
                    const url = buildRentBuddyCtaUrl(event);
                    if (!url) return;
                    router.push(url as any);
                  }}
                >
                  <View style={styles.findBuddyIcon}>
                    <Users size={18} color="#0369A1" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.findBuddyTitle}>Find a Buddy</Text>
                    <Text style={styles.findBuddySub}>Connect with a local buddy in {event.city}</Text>
                  </View>
                  <ChevronDown size={14} color="#0369A1" style={{ transform: [{ rotate: '-90deg' }] }} />
                </Pressable>

                {/* Buddy preview cards */}
                {buddyPreviewLoading ? (
                  <>
                    <BuddyCardSkeleton />
                    <BuddyCardSkeleton />
                  </>
                ) : previewBuddies && previewBuddies.length > 0 ? (
                  <>
                    {previewBuddies.map((buddy) => (
                      <BuddyCard key={buddy.id} buddy={buddy} compact />
                    ))}
                    {/* See all — navigates to full search screen */}
                    <Pressable
                      testID="see-all-buddies"
                      style={({ pressed }) => [styles.seeAllBuddies, pressed && { opacity: 0.7 }]}
                      onPress={() => {
                        const url = buildRentBuddyCtaUrl(event);
                        if (!url) return;
                        router.push(url as any);
                      }}
                    >
                      <Text style={styles.seeAllBuddiesText}>See all buddies in {event.city}</Text>
                      <ChevronDown size={13} color="#0369A1" style={{ transform: [{ rotate: '-90deg' }] }} />
                    </Pressable>
                  </>
                ) : null}
              </View>
            )}

            {/* Comments / event updates — not yet built; shown as disabled coming-soon row */}
            {event.chatEnabled && (event.myRsvp === 'going' || event.myRsvp === 'maybe' || isHost) && (
              <View style={[styles.commentsRow, styles.commentsRowDisabled]}>
                <MessageSquare size={15} color={color.faint} />
                <Text style={[styles.commentsText, styles.commentsTextDisabled]}>Event updates & comments — coming soon</Text>
              </View>
            )}

            {/* Temporary event Passport (spec §25/§31, Phase 8). Offered only to
                someone who is actually attending; the card itself renders
                nothing when the capability is off, when the server refuses, or
                once the event is over, so this condition is the affordance's
                floor, never its authority. */}
            {(event.myRsvp === 'going' || event.myRsvp === 'interested' || isHost) && (
              <EventPassportShareCard eventId={event.id} />
            )}

            {/* Report link */}
            {!isHost && (
              <Pressable style={styles.reportLink} onPress={handleReport}>
                <Flag size={13} color={color.faint} />
                <Text style={styles.reportLinkText}>Report this event</Text>
              </Pressable>
            )}

            {/* Reviews — shown once event is completed (including past events whose
                stored state hasn't been swept to 'completed' server-side yet) */}
            {displayState === 'completed' && (
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
        <View style={[styles.actionBar, { paddingBottom: insets.bottom + space.md }]} onLayout={onBarLayout}>
          {event.state === 'completed' ? (
            /* ① Ended — show no actions; reviews are shown in the scroll body */
            <View style={styles.cancelledNote}>
              <Text style={styles.cancelledText}>This event has ended</Text>
            </View>
          ) : event.state === 'cancelled' || event.state === 'archived' ? (
            /* ② Cancelled / archived */
            <View style={styles.cancelledNote}>
              <Text style={styles.cancelledText}>This event was {event.state}</Text>
            </View>
          ) : eligibilityBlock ? (
            /* ③ Eligibility gate */
            <View style={styles.blockedRow}>
              <Shield size={15} color="#B45309" />
              <Text style={styles.blockedText} numberOfLines={2}>{eligibilityBlock}</Text>
            </View>
          ) : isHost ? (
            /* ③b Owner — RSVP is meaningless for the host; open the same
               Host Dashboard the Settings icon opens, instead of showing RSVP. */
            <Pressable style={styles.rsvpBtn} onPress={() => setShowDashboard(true)}>
              <Text style={styles.rsvpBtnText}>Manage Event</Text>
            </Pressable>
          ) : event.rsvpClosed && !event.myRsvp ? (
            /* ④ RSVPs closed — already RSVP'd viewers still see their status above */
            <View style={styles.cancelledNote}>
              <Text style={styles.cancelledText}>RSVPs are closed for this event</Text>
            </View>
          ) : event.myRsvp ? (
            /* ⑤ Already RSVP'd — show current status + change dropdown */
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
          ) : event.visibility === 'invite_only' && hasPendingRequest ? (
            /* ⑤ Invite-only — request sent, waiting */
            <View style={styles.requestSentRow}>
              <Check size={15} color="#059669" />
              <Text style={styles.requestSentText}>Request sent — waiting for host approval</Text>
            </View>
          ) : event.visibility === 'invite_only' ? (
            /* ⑥ Invite-only — no request yet */
            <Pressable style={styles.rsvpBtn} onPress={handleSendRequest} disabled={rsvpLoading}>
              {rsvpLoading
                ? <ActivityIndicator color={color.onInk} />
                : <Text style={styles.rsvpBtnText}>Request to join</Text>}
            </Pressable>
          ) : waitlistUiState === 'offer_pending' ? (
            /* ⑦ Waitlist offer active — user must accept before expiry */
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
          ) : waitlistUiState === 'offer_expired' ? (
            /* ⑧ Offer window passed — stay on waitlist or leave */
            <View style={styles.offerRow}>
              <View style={[styles.cancelledNote, { flex: 1 }]}>
                <Text style={styles.cancelledText}>Your spot offer expired</Text>
              </View>
              <Pressable style={styles.leaveWaitlistBtn} onPress={handleLeaveWaitlist} disabled={rsvpLoading}>
                <Text style={styles.leaveWaitlistText}>Leave waitlist</Text>
              </Pressable>
            </View>
          ) : waitlistUiState === 'on_waitlist' ? (
            /* ⑨ On waitlist, no offer yet */
            <Pressable style={styles.leaveWaitlistBtn} onPress={handleLeaveWaitlist} disabled={rsvpLoading}>
              <Text style={styles.leaveWaitlistText}>Leave waitlist</Text>
            </Pressable>
          ) : attendeeActions.canJoinWaitlist && event.waitlistEnabled ? (
            /* ⑩ Full + waitlist enabled — join waitlist */
            <Pressable style={styles.waitlistBtn} onPress={handleJoinWaitlist} disabled={rsvpLoading}>
              {rsvpLoading
                ? <ActivityIndicator color="#fff" />
                : <Text style={styles.waitlistBtnText}>Join waitlist</Text>}
            </Pressable>
          ) : ['full', 'waitlist'].includes(event.state) && !event.waitlistEnabled ? (
            /* ⑪ Full, no waitlist */
            <View style={styles.cancelledNote}>
              <Text style={styles.cancelledText}>This event is full — no waitlist available</Text>
            </View>
          ) : attendeeActions.canRsvp ? (
            /* ⑫ Open/started and not banned — RSVP picker */
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
            {RSVP_OPTIONS.filter((o) => (event.rsvpOptions ?? []).includes(o.key)).map((o) => (
              <Pressable
                key={o.key}
                style={[styles.rsvpMenuItem, event.myRsvp === o.key && styles.rsvpMenuItemActive]}
                onPress={() => handleRsvpWithMenu(o.key)}
              >
                <Text style={styles.rsvpMenuItemText}>{o.emoji} {o.label}</Text>
              </Pressable>
            ))}
            {event.myRsvp && (
              <Pressable style={styles.rsvpMenuLeave} onPress={() => { setShowRsvpMenu(false); handleLeave(); }}>
                <Text style={styles.rsvpMenuLeaveText}>Remove RSVP</Text>
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
          onRefresh={refreshLoad}
        />
      )}

      {/* Report event sheet */}
      {event && (
        <ReportSheet
          visible={reportSheetVisible}
          onClose={() => setReportSheetVisible(false)}
          subjectType="event"
          subjectId={event.id}
          subjectUserId={(event as any).hostId ?? (event as any).creatorId ?? undefined}
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
  cover:              { width: '100%', height: 220 },
  coverPlaceholder:   { backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  aiCoverLabel:       { position: 'absolute', bottom: 8, left: 8 },
  promoVideoBadge:    { backgroundColor: 'rgba(0,0,0,0.55)', paddingHorizontal: space.md, paddingVertical: 4, alignSelf: 'flex-start', marginLeft: space.lg, marginTop: -28, borderRadius: radius.pill, zIndex: 1 },
  promoVideoText:     { color: '#fff', fontSize: 11, fontWeight: '700' },
  body:               { padding: space.lg, gap: space.md },
  stateBadge:         { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
  stateBadgeText:     { fontSize: 12, fontWeight: '700' },
  title:              { ...t.title, color: color.ink, fontWeight: '800', fontSize: 22 },
  metaRow:            { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta:               { ...t.body, color: color.mute },

  seeDestinationRow:  { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: color.paperRaised, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, borderWidth: 1, borderColor: color.haze },
  seeDestinationText: { ...t.small, color: color.signal, fontWeight: '600', flex: 1 },

  mapTile:            { borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  mapTileInner:       { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md },
  mapTileTitle:       { ...t.body, color: color.ink, fontWeight: '600' },
  mapTileCity:        { ...t.small, color: color.mute, marginTop: 1 },
  mapTilePrivate:     { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.md, paddingBottom: space.sm },
  mapTilePrivateText: { ...t.stamp, color: color.mute },

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
  avatarMore:         { width: avatar.s32, height: avatar.s32, borderRadius: avatar.s32 / 2, backgroundColor: color.haze, alignItems: 'center', justifyContent: 'center' },
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

  entryRow:           { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  entryBtn:           { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: 8, backgroundColor: color.paperRaised, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  entryBtnText:       { ...t.small, color: color.signal, fontWeight: '600' },
  entryBtnDisabled:   { opacity: 0.45 },
  entryBtnTextDisabled: { color: color.faint },

  commentsRow:        { flexDirection: 'row', alignItems: 'center', gap: 8, padding: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze },
  commentsText:       { ...t.body, color: color.mute, flex: 1 },
  commentsRowDisabled: { opacity: 0.45 },
  commentsTextDisabled: { color: color.faint },

  findBuddySection:   { gap: space.sm },
  findBuddyCta:       { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#F0F9FF', borderRadius: radius.md, borderWidth: 1, borderColor: '#BAE6FD', paddingHorizontal: space.md, paddingVertical: 12 },
  findBuddyIcon:      { width: avatar.s36, height: avatar.s36, borderRadius: avatar.s36 / 2, backgroundColor: '#E0F2FE', alignItems: 'center', justifyContent: 'center' },
  findBuddyTitle:     { ...t.bodyStrong, color: '#0C4A6E', fontSize: 14 },
  findBuddySub:       { ...t.small, color: '#0369A1', marginTop: 1 },
  seeAllBuddies:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: space.sm },
  seeAllBuddiesText:  { ...t.small, color: '#0369A1', fontWeight: '600' },

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
  requestSentRow:     { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#F0FDF4', borderRadius: radius.md, padding: space.md },
  requestSentText:    { ...t.small, color: '#16A34A', flex: 1, fontWeight: '600' },
  rsvpMenuOverlay:    { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 },
  rsvpMenu:           { position: 'absolute', left: space.lg, right: space.lg, backgroundColor: color.paperRaised, borderRadius: radius.lg, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden', zIndex: 50 },
  rsvpMenuItem:       { padding: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  rsvpMenuItemActive: { backgroundColor: '#F0FDF4' },
  rsvpMenuItemText:   { ...t.body, color: color.ink },
  rsvpMenuLeave:      { padding: space.md },
  rsvpMenuLeaveText:  { ...t.body, color: '#DC2626', fontWeight: '600' },
});
