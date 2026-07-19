/**
 * NotificationTemplateService
 *
 * Single source of truth for all notification templates.
 * 13 categories · ~80 event types.
 *
 * Each template declares:
 *   - category: one of the 13 feature categories
 *   - defaultPriority: urgent | important | normal | low
 *   - defaultChannels: which channels to use by default
 *   - title/body: formatter functions that accept typed params
 */

export type NotificationCategory =
  | 'plans' | 'trips' | 'telegraph' | 'safe_return' | 'location' | 'trip_crew'
  | 'compass' | 'pulse' | 'passport' | 'hidden_gems' | 'trust' | 'airport' | 'admin'
  | 'rent_buddy';

export type NotificationPriority = 'urgent' | 'important' | 'normal' | 'low';

export type NotificationChannel = 'in_app' | 'push' | 'email' | 'sms' | 'telegraph';

export interface NotificationTemplate {
  eventType: string;
  category: NotificationCategory;
  defaultPriority: NotificationPriority;
  defaultChannels: NotificationChannel[];
  title: (params: Record<string, string>) => string;
  body: (params: Record<string, string>) => string;
  actionUrl?: (params: Record<string, string>) => string;
}

const tpl = (t: NotificationTemplate): NotificationTemplate => t;

export const TEMPLATES: NotificationTemplate[] = [
  // ── Plans ──────────────────────────────────────────────────────────────────
  tpl({
    eventType: 'plan.item_added',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} added a plan item`,
    body: ({ location, tripTitle }) => `New stop added${location ? ` at ${location}` : ''}${tripTitle ? ` for ${tripTitle}` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'plan.item_updated',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} updated a plan item`,
    body: ({ location, tripTitle }) => `Plan item updated${location ? ` at ${location}` : ''}${tripTitle ? ` in ${tripTitle}` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'plan.item_removed',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} removed a plan item`,
    body: ({ location, tripTitle }) => `${location ?? 'A stop'} was removed${tripTitle ? ` from ${tripTitle}` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'plan.approval_requested',
    category: 'plans',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} requests plan approval`,
    body: ({ tripTitle }) => `A plan item needs your approval${tripTitle ? ` in ${tripTitle}` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'plan.approved',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Plan item approved',
    body: ({ location, actor }) => `${actor} approved${location ? ` "${location}"` : ' your plan item'}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'plan.permission_changed',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'Plan editing permissions updated',
    body: ({ tripTitle, permission }) => `${tripTitle ?? 'Your trip'}: plan editing is now ${permission ?? 'restricted'}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'plan.checkin',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} checked in`,
    body: ({ actor, location, tripTitle }) => `${actor ?? 'Someone'} arrived at ${location ?? 'a plan stop'}${tripTitle ? ` (${tripTitle})` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),

  // ── Trips ──────────────────────────────────────────────────────────────────
  tpl({
    eventType: 'trip.invite_received',
    category: 'trips',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} invited you to a trip`,
    body: ({ tripTitle, destination }) => `Join${tripTitle ? ` "${tripTitle}"` : ''}${destination ? ` — ${destination}` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'trip.invite_accepted',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} joined your trip`,
    body: ({ actor, tripTitle }) => `${actor} is now part of ${tripTitle ?? 'your trip'}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'trip.invite_declined',
    category: 'trips',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} declined your trip invite`,
    body: ({ actor, tripTitle }) => `${actor} won't be joining ${tripTitle ?? 'your trip'}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'trip.member_removed',
    category: 'trips',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'You were removed from a trip',
    body: ({ tripTitle }) => `You're no longer a member of ${tripTitle ?? 'a trip'}`,
  }),
  tpl({
    eventType: 'trip.upcoming_reminder',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Trip coming up soon',
    body: ({ tripTitle, daysUntil, destination }) => `${tripTitle ?? 'Your trip'}${destination ? ` to ${destination}` : ''} starts in ${daysUntil ?? 'a few'} days`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),

  // ── Calls ──────────────────────────────────────────────────────────────────
  tpl({
    eventType: 'call.incoming',
    category: 'telegraph',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor ?? 'Someone'} is calling you`,
    body: ({ callKind }) => `Incoming ${callKind ?? 'call'}`,
    actionUrl: ({ threadId }) => (threadId ? `/messages/${threadId}` : '/notifications'),
  }),
  tpl({
    eventType: 'call.crew_started',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ tripTitle }) => (tripTitle ? `Crew Call · ${tripTitle}` : 'Crew Call'),
    body: () => 'Your Trip Crew started a voice call.',
    actionUrl: ({ tripId }) => (tripId ? `/trip/${tripId}` : '/notifications'),
  }),

  // ── Telegraph ──────────────────────────────────────────────────────────────
  tpl({
    eventType: 'telegraph.message',
    category: 'telegraph',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push', 'telegraph'],
    title: ({ actor }) => `${actor}`,
    body: ({ preview }) => preview ?? 'New message',
    actionUrl: ({ threadId }) => `/messages/${threadId}`,
  }),
  tpl({
    eventType: 'telegraph.message_request',
    category: 'telegraph',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} wants to message you`,
    body: ({ preview }) => preview ?? 'Tap to view their request',
    actionUrl: () => '/notifications',
  }),
  tpl({
    eventType: 'telegraph.ai_suggestion',
    category: 'telegraph',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'AI trip suggestion',
    body: ({ suggestion }) => suggestion ?? 'Compass has a suggestion for your trip',
    actionUrl: ({ threadId }) => `/messages/${threadId}`,
  }),

  // ── Safe Return ────────────────────────────────────────────────────────────
  tpl({
    eventType: 'safe_return.reminder',
    category: 'safe_return',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Safe Return check-in',
    body: () => 'Are you back okay? Tap to confirm you\'re safe.',
    actionUrl: () => '/safety-history',
  }),
  tpl({
    eventType: 'safe_return.missed',
    category: 'safe_return',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Missed Safe Return check-in',
    body: () => 'Your timer expired. Tap to confirm you\'re okay or get help.',
    actionUrl: () => '/safety-history',
  }),
  tpl({
    eventType: 'safe_return.trusted_circle_alert',
    category: 'safe_return',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: ({ travelerName }) => `${travelerName ?? 'A traveler'} missed their check-in`,
    body: ({ area, missedTime }) => `They were last in ${area ?? 'an unknown area'} and expected back by ${missedTime ?? 'a scheduled time'}`,
    actionUrl: () => '/safety-history',
  }),
  tpl({
    eventType: 'safe_return.cleared',
    category: 'safe_return',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ travelerName }) => `${travelerName ?? 'A traveler'} is safe`,
    body: ({ travelerName }) => `${travelerName ?? 'They'} confirmed they're okay`,
  }),

  // ── GPS / Location ─────────────────────────────────────────────────────────
  tpl({
    eventType: 'location.arrived_destination',
    category: 'location',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'You\'ve arrived',
    body: ({ city, country }) => `Welcome to ${[city, country].filter(Boolean).join(', ') || 'your destination'}`,
  }),
  tpl({
    eventType: 'location.nearby_traveler',
    category: 'location',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Traveler nearby',
    body: ({ actor }) => `${actor ?? 'A fellow traveler'} is in the same area`,
  }),
  tpl({
    eventType: 'location.live_share_started',
    category: 'location',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} shared their location`,
    body: () => 'Live location sharing is active. No exact coordinates are shown.',
  }),
  tpl({
    eventType: 'location.geofence_triggered',
    category: 'location',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Location check-in triggered',
    body: ({ area }) => `You entered ${area ?? 'a tracked area'}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),

  // ── Trip Crew ──────────────────────────────────────────────────────────────
  tpl({
    eventType: 'trip_crew.friend_request',
    category: 'trip_crew',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} sent a friend request`,
    body: ({ actor }) => `${actor} wants to connect`,
    actionUrl: () => '/notifications',
  }),
  tpl({
    eventType: 'trip_crew.friend_accepted',
    category: 'trip_crew',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} accepted your request`,
    body: ({ actor }) => `You and ${actor} are now travel friends`,
    actionUrl: ({ userId }) => `/profile/${userId}`,
  }),
  tpl({
    eventType: 'trip_crew.circle_invite',
    category: 'trip_crew',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} invited you to their Circle`,
    body: ({ actor }) => `Join ${actor}'s Travel Circle`,
    actionUrl: () => '/notifications',
  }),
  tpl({
    eventType: 'trip_crew.availability_nudge',
    category: 'trip_crew',
    defaultPriority: 'low',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} checked your availability`,
    body: ({ actor, dateLabel, tripTitle }) => `${actor ?? 'Someone'} is free ${dateLabel ?? 'soon'}${tripTitle ? ` for ${tripTitle}` : ''}`,
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),

  // ── Compass AI ─────────────────────────────────────────────────────────────
  tpl({
    eventType: 'compass.daily_brief',
    category: 'compass',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your daily travel brief',
    body: ({ summary }) => summary ?? 'Compass has updates for your upcoming trip',
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'compass.recommendation',
    category: 'compass',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Compass recommendation',
    body: ({ recommendation }) => recommendation ?? 'New suggestion based on your itinerary',
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),
  tpl({
    eventType: 'compass.warning',
    category: 'compass',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Travel alert',
    body: ({ warning }) => warning ?? 'Compass flagged something for your trip',
    actionUrl: ({ tripId }) => `/trip/${tripId}`,
  }),

  // ── City Pulse ─────────────────────────────────────────────────────────────
  tpl({
    eventType: 'pulse.new_post',
    category: 'pulse',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} posted`,
    body: ({ preview, city }) => `${preview ?? 'New post'}${city ? ` in ${city}` : ''}`,
    actionUrl: ({ postId }) => `/post/${postId}`,
  }),
  tpl({
    eventType: 'pulse.post_liked',
    category: 'pulse',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} liked your post`,
    body: ({ preview }) => preview ?? 'Your post got a like',
    actionUrl: ({ postId }) => `/post/${postId}`,
  }),
  tpl({
    eventType: 'pulse.post_comment',
    category: 'pulse',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} commented`,
    body: ({ comment, preview }) => comment ?? preview ?? 'New comment on your post',
    actionUrl: ({ postId }) => `/post/${postId}`,
  }),
  tpl({
    eventType: 'pulse.highlight_viewed',
    category: 'pulse',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your highlight was viewed',
    body: ({ viewCount }) => `${viewCount ?? 'Someone'} view${viewCount === '1' ? '' : 's'} on your highlight`,
  }),

  // ── Passport ───────────────────────────────────────────────────────────────
  tpl({
    eventType: 'passport.stamp_earned',
    category: 'passport',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Passport Stamp Earned 🌍',
    body: ({ location }) => `You earned a stamp for ${location ?? 'a new destination'}`,
    actionUrl: ({ stampId }) => stampId ? `/stamp/${stampId}` : '/(tabs)/passport?tab=stamps',
  }),
  tpl({
    eventType: 'passport.milestone',
    category: 'passport',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Passport milestone!',
    body: ({ milestone }) => milestone ?? 'You hit a new travel milestone',
    actionUrl: () => '/stamps',
  }),
  tpl({
    eventType: 'passport.viewed',
    category: 'passport',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} viewed your passport`,
    body: ({ actor }) => `${actor} checked out your travel history`,
    actionUrl: ({ userId }) => `/passport/${userId}`,
  }),

  // ── Hidden Gems / Local Guides ─────────────────────────────────────────────
  tpl({
    eventType: 'hidden_gems.place_saved',
    category: 'hidden_gems',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} saved your place`,
    body: ({ actor, placeName }) => `${placeName ?? 'Your submission'} was saved by ${actor ?? 'a traveler'}`,
  }),
  tpl({
    eventType: 'hidden_gems.place_approved',
    category: 'hidden_gems',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Place approved!',
    body: ({ placeName }) => `${placeName ?? 'Your submission'} is now visible to the community`,
  }),
  tpl({
    eventType: 'hidden_gems.nearby_gem',
    category: 'hidden_gems',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Hidden gem nearby',
    body: ({ placeName, city }) => `Check out ${placeName ?? 'a great spot'}${city ? ` in ${city}` : ''}`,
  }),

  // ── Trust / Reliability ────────────────────────────────────────────────────
  tpl({
    eventType: 'trust.score_changed',
    category: 'trust',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'Your trust score updated',
    body: ({ change }) => change === 'up' ? 'Your reliability score improved' : 'Your reliability score changed',
  }),
  tpl({
    eventType: 'trust.report_received',
    category: 'trust',
    defaultPriority: 'important',
    defaultChannels: ['in_app'],
    title: () => 'New report on your account',
    body: () => 'A report was filed. Our team will review it.',
  }),
  tpl({
    eventType: 'trust.no_show',
    category: 'trust',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'No-show recorded',
    body: ({ event }) => `A no-show was recorded for ${event ?? 'a meetup'}`,
  }),

  // ── Airport / Layover ──────────────────────────────────────────────────────
  tpl({
    eventType: 'airport.layover_mode',
    category: 'airport',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'Layover mode active',
    body: ({ airport, duration }) => `You're at ${airport ?? 'an airport'}${duration ? ` for ${duration}` : ''}`,
  }),
  tpl({
    eventType: 'airport.traveler_nearby',
    category: 'airport',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Fellow traveler at your airport',
    body: ({ actor }) => `${actor ?? 'Someone'} is at the same terminal`,
  }),
  tpl({
    eventType: 'airport.lounge_tip',
    category: 'airport',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Airport tip',
    body: ({ tip }) => tip ?? 'Useful info for your layover',
  }),

  // ── Additional Plans ───────────────────────────────────────────────────────
  tpl({
    eventType: 'plan.comment_added',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} commented on a plan item`,
    body: ({ comment }) => comment ?? 'New comment on your trip plan',
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'plan.voting_started',
    category: 'plans',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Vote on your trip plan',
    body: ({ tripName }) => `A vote is open for ${tripName ?? 'your trip'} — cast your vote`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'plan.geofence_arrived',
    category: 'plans',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'You arrived at a plan location!',
    body: ({ locationName }) => `Check in at ${locationName ?? 'your next stop'}`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),

  // ── Additional Trips ───────────────────────────────────────────────────────
  tpl({
    eventType: 'trip.status_changed',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Trip status updated',
    body: ({ tripName, status }) => `${tripName ?? 'Your trip'} is now ${status ?? 'updated'}`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'trip.plan_updated',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'Trip plan updated',
    body: ({ tripName, actor }) => `${actor ?? 'Someone'} updated the plan for ${tripName ?? 'your trip'}`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'trip.crew_message',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} messaged the trip crew`,
    body: ({ preview }) => preview ?? 'New message in your trip chat',
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'trip.departure_reminder',
    category: 'trips',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => '✈️ Departure soon',
    body: ({ tripName, departureIn }) => `${tripName ?? 'Your trip'} departs ${departureIn ?? 'soon'}`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),

  // ── Additional Telegraph ───────────────────────────────────────────────────
  tpl({
    eventType: 'telegraph.mention',
    category: 'telegraph',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} mentioned you`,
    body: ({ preview }) => preview ?? 'You were mentioned in a conversation',
    actionUrl: ({ threadId }) => threadId ? `/messages/${threadId}` : '/messages',
  }),
  tpl({
    eventType: 'telegraph.reaction',
    category: 'telegraph',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} reacted to your message`,
    body: ({ emoji, preview }) => `${emoji ?? '👍'} on "${preview ?? 'your message'}"`,
    actionUrl: ({ threadId }) => threadId ? `/messages/${threadId}` : '/messages',
  }),
  tpl({
    eventType: 'telegraph.thread_archived',
    category: 'telegraph',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Conversation archived',
    body: ({ actor }) => `${actor ?? 'A participant'} archived this conversation`,
    actionUrl: () => '/messages',
  }),

  // ── Additional Safe Return ─────────────────────────────────────────────────
  tpl({
    eventType: 'safe_return.check_in_prompt',
    category: 'safe_return',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => '🛡️ Safe Return check-in',
    body: ({ minutesLeft }) => `Please check in — ${minutesLeft ?? 'time'} remaining before alert`,
    actionUrl: () => '/safety-history',
  }),
  tpl({
    eventType: 'safe_return.location_shared',
    category: 'safe_return',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} shared their location with you`,
    body: ({ actor }) => `${actor ?? 'Someone'} added you as a Safe Return contact`,
  }),

  // ── Additional Location ────────────────────────────────────────────────────
  tpl({
    eventType: 'location.safe_zone_entered',
    category: 'location',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'You entered a safe zone',
    body: ({ zoneName }) => `Welcome to ${zoneName ?? 'a saved location'}`,
  }),
  tpl({
    eventType: 'location.manual_city_set',
    category: 'location',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'City updated',
    body: ({ city }) => `Your current city is now set to ${city ?? 'a new location'}`,
  }),

  // ── Additional Trip Crew ───────────────────────────────────────────────────
  tpl({
    eventType: 'trip_crew.meetup_invite',
    category: 'trip_crew',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} invited you to a meetup`,
    body: ({ meetupTitle }) => meetupTitle ?? 'New meetup invitation',
    actionUrl: ({ meetupId }) => meetupId ? `/meetup/${meetupId}` : '/meetups',
  }),
  tpl({
    eventType: 'trip_crew.follow',
    category: 'trip_crew',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} followed you`,
    body: ({ actor }) => `${actor ?? 'A traveler'} is now following your passport`,
    actionUrl: ({ userId }) => userId ? `/u/${userId}` : '/',
  }),

  // ── Additional Compass ─────────────────────────────────────────────────────
  tpl({
    eventType: 'compass.itinerary_ready',
    category: 'compass',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Your Compass itinerary is ready',
    body: ({ tripName }) => `Compass built an itinerary for ${tripName ?? 'your trip'}`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),
  tpl({
    eventType: 'compass.weather_alert',
    category: 'compass',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Weather alert for your destination',
    body: ({ alert, city }) => `${alert ?? 'Weather conditions'} expected${city ? ` in ${city}` : ''}`,
    actionUrl: ({ tripId }) => tripId ? `/trip/${tripId}` : '/',
  }),

  // ── Additional Pulse ───────────────────────────────────────────────────────
  tpl({
    eventType: 'pulse.post_share',
    category: 'pulse',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} shared your post`,
    body: ({ preview }) => `"${preview ?? 'Your post'}" was shared`,
    actionUrl: ({ postId }) => postId ? `/post/${postId}` : '/',
  }),
  tpl({
    eventType: 'pulse.highlight_replied',
    category: 'pulse',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} replied to your highlight`,
    body: ({ comment }) => comment ?? 'New reply on your highlight',
  }),

  // ── Additional Passport ────────────────────────────────────────────────────
  tpl({
    eventType: 'passport.postcard_received',
    category: 'passport',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} sent you a postcard!`,
    body: ({ city }) => `A postcard from ${city ?? 'their travels'} arrived`,
    actionUrl: () => '/stamps',
  }),
  tpl({
    eventType: 'passport.countries_milestone',
    category: 'passport',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Country milestone reached! 🌍',
    body: ({ count }) => `You've now visited ${count ?? 'a new number of'} countries`,
    actionUrl: () => '/stamps',
  }),

  // ── Additional Hidden Gems ─────────────────────────────────────────────────
  tpl({
    eventType: 'hidden_gems.place_commented',
    category: 'hidden_gems',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: ({ actor }) => `${actor} commented on your gem`,
    body: ({ placeName, comment }) => `"${comment ?? 'New comment'}" on ${placeName ?? 'your place'}`,
  }),

  // ── Additional Trust ───────────────────────────────────────────────────────
  tpl({
    eventType: 'trust.verified',
    category: 'trust',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Account verified ✓',
    body: () => 'Your identity verification was approved',
  }),
  tpl({
    eventType: 'trust.reliability_badge',
    category: 'trust',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Reliability badge earned!',
    body: ({ badge }) => `You earned the "${badge ?? 'Reliable Traveler'}" badge`,
  }),

  // ── Additional Airport ─────────────────────────────────────────────────────
  tpl({
    eventType: 'airport.flight_delay',
    category: 'airport',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => '⚠️ Flight delay detected',
    body: ({ flight, delay }) => `${flight ?? 'Your flight'} is delayed${delay ? ` by ${delay}` : ''}`,
  }),

  // ── Digest notifications ───────────────────────────────────────────────────
  // These template entries ensure the router never falls back to ['in_app','push']
  // for digest event types; digests are strictly in_app summaries.
  tpl({
    eventType: 'digest.trips',
    category: 'trips',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your Trips digest',
    body: ({ body }) => body ?? 'A summary of your recent trip activity',
    actionUrl: () => '/(tabs)/trips',
  }),
  tpl({
    eventType: 'digest.pulse',
    category: 'pulse',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your City Pulse digest',
    body: ({ body }) => body ?? 'A summary of recent pulse activity around you',
    actionUrl: () => '/(tabs)/',
  }),
  tpl({
    eventType: 'digest.passport',
    category: 'passport',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your Passport digest',
    body: ({ body }) => body ?? 'A summary of your passport and stamp activity',
    actionUrl: () => '/stamps',
  }),
  tpl({
    eventType: 'digest.hidden_gems',
    category: 'hidden_gems',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your Hidden Gems digest',
    body: ({ body }) => body ?? 'A summary of activity on your submitted places',
  }),
  tpl({
    eventType: 'digest.compass',
    category: 'compass',
    defaultPriority: 'low',
    defaultChannels: ['in_app'],
    title: () => 'Your Compass digest',
    body: ({ body }) => body ?? 'A summary of Compass AI updates for your trips',
    actionUrl: () => '/(tabs)/trips',
  }),

  // ── Tagging ────────────────────────────────────────────────────────────────
  tpl({
    eventType: 'pulse.user_tagged',
    category: 'pulse',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ taggerHandle }) => `@${taggerHandle ?? 'someone'} mentioned you`,
    body: ({ context }) => context ?? 'You were mentioned in a post.',
    actionUrl: ({ sourceType, sourceId }) =>
      sourceType && sourceId ? `/${sourceType}/${sourceId}` : '/feed',
  }),

  // ── Admin / Moderation ─────────────────────────────────────────────────────
  tpl({
    eventType: 'admin.account_notice',
    category: 'admin',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: ({ subject }) => subject ?? 'Account notice from Travel Buddy',
    body: ({ body }) => body ?? 'Please review your account settings.',
  }),
  tpl({
    eventType: 'admin.moderation_action',
    category: 'admin',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Moderation action taken',
    body: ({ reason }) => reason ?? 'An action was taken on your account.',
  }),
  tpl({
    eventType: 'admin.system_update',
    category: 'admin',
    defaultPriority: 'normal',
    defaultChannels: ['in_app'],
    title: () => 'Travel Buddy update',
    body: ({ message }) => message ?? 'New features and improvements are available.',
  }),

  // ── Find Your Circle ────────────────────────────────────────────────────────
  tpl({
    eventType: 'circle.sharing_enabled',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} joined your Circle`,
    body: ({ contextTitle }) => `${contextTitle ? `In ${contextTitle} — ` : ''}Find Your Circle is now active.`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),
  tpl({
    eventType: 'circle.sharing_paused',
    category: 'trips',
    defaultPriority: 'low',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} paused their Circle`,
    body: ({ contextTitle }) => `${contextTitle ? `In ${contextTitle} — ` : ''}They won't be visible until they resume.`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),
  tpl({
    // Fired when a user's presence sharing expires (e.g. past trip/event end time).
    // Triggered by a background job or Supabase DB trigger; not by a route directly.
    eventType: 'circle.sharing_expired',
    category: 'trips',
    defaultPriority: 'low',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Your Circle sharing ended',
    body: ({ contextTitle }) => `${contextTitle ? `In ${contextTitle} — ` : ''}Your location sharing session has ended automatically.`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),
  tpl({
    // Fired when the first member in a context starts sharing (0→1 active transition).
    // Notifies all other accepted members that Circle is now live for this context.
    eventType: 'circle.context_active',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ contextTitle }) => `Circle is live${contextTitle ? ` · ${contextTitle}` : ''}`,
    body: ({ actor }) => `${actor} started sharing. Find Your Circle is now active.`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),
  tpl({
    eventType: 'circle.checkin',
    category: 'trips',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: ({ actor }) => `${actor} checked in`,
    body: ({ statusLabel, contextTitle }) =>
      statusLabel
        ? `${statusLabel}${contextTitle ? ` · ${contextTitle}` : ''}`
        : `New check-in${contextTitle ? ` in ${contextTitle}` : ''}`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),
  tpl({
    // Privacy: body must NOT include venue names, area labels, or any location text.
    // The deep-link takes the user to the authorized Circle meeting-point endpoint.
    eventType: 'circle.meeting_point_updated',
    category: 'trips',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: ({ contextTitle }) => `Meeting point updated${contextTitle ? ` · ${contextTitle}` : ''}`,
    body: ({ contextTitle }) =>
      `${contextTitle ? `In ${contextTitle} — ` : ''}The host updated the meeting point. Tap to see details.`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),
  tpl({
    eventType: 'circle.need_help_host_alert',
    category: 'safe_return',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Circle safety alert',
    body: ({ actor, contextTitle }) =>
      `${actor} may need assistance${contextTitle ? ` during ${contextTitle}` : ''}. Tap to check in with them.`,
    actionUrl: ({ contextType, contextId }) => `/circle/${contextType}/${contextId}`,
  }),

  // ── Rent a Buddy ─────────────────────────────────────────────────────────────
  tpl({
    eventType: 'rent_buddy.booking_requested',
    category: 'rent_buddy',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'New booking request',
    body: () => 'You have a new booking request. Tap to review and accept.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_accepted',
    category: 'rent_buddy',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Booking confirmed!',
    body: () => 'Your Buddy accepted your request. Your booking is now confirmed.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_declined',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Booking declined',
    body: () => 'Your Buddy was unable to accept this request. Try searching for another Buddy.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_cancelled_by_traveler',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Booking cancelled',
    body: () => 'The traveler has cancelled this booking.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_cancelled_by_buddy',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Booking cancelled by Buddy',
    body: () => 'Your Buddy has cancelled this booking. We apologise for the inconvenience.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_completed',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Booking completed',
    body: () => 'Your booking is now complete. We hope you had a great time!',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_expired',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Booking request expired',
    body: () => 'Your booking request was not accepted in time and has expired.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.booking_pending_confirmation',
    category: 'rent_buddy',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Confirm your booking',
    body: () => 'Please confirm or dispute your completed booking.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.dispute_opened',
    category: 'rent_buddy',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Dispute opened',
    body: () => 'A dispute has been raised on your booking. Our team will review within 24 hours.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.no_show_reported',
    category: 'rent_buddy',
    defaultPriority: 'urgent',
    defaultChannels: ['in_app', 'push'],
    title: () => 'No-show reported',
    body: () => 'A no-show has been reported on your booking.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.change_request_raised',
    category: 'rent_buddy',
    defaultPriority: 'important',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Change request',
    body: () => 'A change has been proposed for your booking. Tap to review.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.change_request_accepted',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Change request accepted',
    body: () => 'Your proposed booking change has been accepted.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
  tpl({
    eventType: 'rent_buddy.change_request_declined',
    category: 'rent_buddy',
    defaultPriority: 'normal',
    defaultChannels: ['in_app', 'push'],
    title: () => 'Change request declined',
    body: () => 'Your proposed booking change was not accepted.',
    actionUrl: ({ bookingId }) => `/rent-a-buddy/bookings/${bookingId}`,
  }),
];

const TEMPLATE_MAP = new Map<string, NotificationTemplate>(
  TEMPLATES.map((t) => [t.eventType, t]),
);

export function getTemplate(eventType: string): NotificationTemplate | null {
  return TEMPLATE_MAP.get(eventType) ?? null;
}

import { DISPLAY_NAME_MAX_LENGTH, truncateDisplayName } from '../../lib/displayName';

/** Param keys that carry a user's display name and must be length-capped. */
const NAME_PARAM_KEYS = ['actor', 'travelerName'] as const;

function capNameParams(params: Record<string, string>): Record<string, string> {
  let out = params;
  for (const key of NAME_PARAM_KEYS) {
    const val = out[key];
    if (typeof val === 'string' && val.length > DISPLAY_NAME_MAX_LENGTH) {
      if (out === params) out = { ...params };
      out[key] = truncateDisplayName(val);
    }
  }
  return out;
}

export function renderTemplate(
  eventType: string,
  rawParams: Record<string, string> = {},
): { title: string; body: string; category: NotificationCategory; priority: NotificationPriority; channels: NotificationChannel[]; actionUrl?: string } | null {
  const tpl = getTemplate(eventType);
  if (!tpl) return null;
  const params = capNameParams(rawParams);
  return {
    title: tpl.title(params),
    body: tpl.body(params),
    category: tpl.category,
    priority: tpl.defaultPriority,
    channels: tpl.defaultChannels,
    actionUrl: tpl.actionUrl ? tpl.actionUrl(params) : undefined,
  };
}
