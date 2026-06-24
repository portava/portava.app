"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEMPLATES = void 0;
exports.getTemplate = getTemplate;
exports.renderTemplate = renderTemplate;
var tpl = function (t) { return t; };
exports.TEMPLATES = [
    // ── Plans ──────────────────────────────────────────────────────────────────
    tpl({
        eventType: 'plan.item_added',
        category: 'plans',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " added a plan item");
        },
        body: function (_a) {
            var location = _a.location, tripTitle = _a.tripTitle;
            return "New stop added".concat(location ? " at ".concat(location) : '').concat(tripTitle ? " for ".concat(tripTitle) : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'plan.item_updated',
        category: 'plans',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " updated a plan item");
        },
        body: function (_a) {
            var location = _a.location, tripTitle = _a.tripTitle;
            return "Plan item updated".concat(location ? " at ".concat(location) : '').concat(tripTitle ? " in ".concat(tripTitle) : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'plan.item_removed',
        category: 'plans',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " removed a plan item");
        },
        body: function (_a) {
            var location = _a.location, tripTitle = _a.tripTitle;
            return "".concat(location !== null && location !== void 0 ? location : 'A stop', " was removed").concat(tripTitle ? " from ".concat(tripTitle) : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'plan.approval_requested',
        category: 'plans',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " requests plan approval");
        },
        body: function (_a) {
            var tripTitle = _a.tripTitle;
            return "A plan item needs your approval".concat(tripTitle ? " in ".concat(tripTitle) : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'plan.approved',
        category: 'plans',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Plan item approved'; },
        body: function (_a) {
            var location = _a.location, actor = _a.actor;
            return "".concat(actor, " approved").concat(location ? " \"".concat(location, "\"") : ' your plan item');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'plan.permission_changed',
        category: 'plans',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function () { return 'Plan editing permissions updated'; },
        body: function (_a) {
            var tripTitle = _a.tripTitle, permission = _a.permission;
            return "".concat(tripTitle !== null && tripTitle !== void 0 ? tripTitle : 'Your trip', ": plan editing is now ").concat(permission !== null && permission !== void 0 ? permission : 'restricted');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'plan.checkin',
        category: 'plans',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " checked in");
        },
        body: function (_a) {
            var actor = _a.actor, location = _a.location, tripTitle = _a.tripTitle;
            return "".concat(actor !== null && actor !== void 0 ? actor : 'Someone', " arrived at ").concat(location !== null && location !== void 0 ? location : 'a plan stop').concat(tripTitle ? " (".concat(tripTitle, ")") : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    // ── Trips ──────────────────────────────────────────────────────────────────
    tpl({
        eventType: 'trip.invite_received',
        category: 'trips',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " invited you to a trip");
        },
        body: function (_a) {
            var tripTitle = _a.tripTitle, destination = _a.destination;
            return "Join".concat(tripTitle ? " \"".concat(tripTitle, "\"") : '').concat(destination ? " \u2014 ".concat(destination) : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'trip.invite_accepted',
        category: 'trips',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " joined your trip");
        },
        body: function (_a) {
            var actor = _a.actor, tripTitle = _a.tripTitle;
            return "".concat(actor, " is now part of ").concat(tripTitle !== null && tripTitle !== void 0 ? tripTitle : 'your trip');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'trip.invite_declined',
        category: 'trips',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " declined your trip invite");
        },
        body: function (_a) {
            var actor = _a.actor, tripTitle = _a.tripTitle;
            return "".concat(actor, " won't be joining ").concat(tripTitle !== null && tripTitle !== void 0 ? tripTitle : 'your trip');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'trip.member_removed',
        category: 'trips',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'You were removed from a trip'; },
        body: function (_a) {
            var tripTitle = _a.tripTitle;
            return "You're no longer a member of ".concat(tripTitle !== null && tripTitle !== void 0 ? tripTitle : 'a trip');
        },
    }),
    tpl({
        eventType: 'trip.upcoming_reminder',
        category: 'trips',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Trip coming up soon'; },
        body: function (_a) {
            var tripTitle = _a.tripTitle, daysUntil = _a.daysUntil, destination = _a.destination;
            return "".concat(tripTitle !== null && tripTitle !== void 0 ? tripTitle : 'Your trip').concat(destination ? " to ".concat(destination) : '', " starts in ").concat(daysUntil !== null && daysUntil !== void 0 ? daysUntil : 'a few', " days");
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    // ── Telegraph ──────────────────────────────────────────────────────────────
    tpl({
        eventType: 'telegraph.message',
        category: 'telegraph',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push', 'telegraph'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor);
        },
        body: function (_a) {
            var preview = _a.preview;
            return preview !== null && preview !== void 0 ? preview : 'New message';
        },
        actionUrl: function (_a) {
            var threadId = _a.threadId;
            return "/messages/".concat(threadId);
        },
    }),
    tpl({
        eventType: 'telegraph.message_request',
        category: 'telegraph',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " wants to message you");
        },
        body: function (_a) {
            var preview = _a.preview;
            return preview !== null && preview !== void 0 ? preview : 'Tap to view their request';
        },
        actionUrl: function () { return '/notifications'; },
    }),
    tpl({
        eventType: 'telegraph.ai_suggestion',
        category: 'telegraph',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'AI trip suggestion'; },
        body: function (_a) {
            var suggestion = _a.suggestion;
            return suggestion !== null && suggestion !== void 0 ? suggestion : 'Compass has a suggestion for your trip';
        },
        actionUrl: function (_a) {
            var threadId = _a.threadId;
            return "/messages/".concat(threadId);
        },
    }),
    // ── Safe Return ────────────────────────────────────────────────────────────
    tpl({
        eventType: 'safe_return.reminder',
        category: 'safe_return',
        defaultPriority: 'urgent',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Safe Return check-in'; },
        body: function () { return 'Are you back okay? Tap to confirm you\'re safe.'; },
        actionUrl: function () { return '/safety-history'; },
    }),
    tpl({
        eventType: 'safe_return.missed',
        category: 'safe_return',
        defaultPriority: 'urgent',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Missed Safe Return check-in'; },
        body: function () { return 'Your timer expired. Tap to confirm you\'re okay or get help.'; },
        actionUrl: function () { return '/safety-history'; },
    }),
    tpl({
        eventType: 'safe_return.trusted_circle_alert',
        category: 'safe_return',
        defaultPriority: 'urgent',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var travelerName = _a.travelerName;
            return "".concat(travelerName !== null && travelerName !== void 0 ? travelerName : 'A traveler', " missed their check-in");
        },
        body: function (_a) {
            var area = _a.area, missedTime = _a.missedTime;
            return "They were last in ".concat(area !== null && area !== void 0 ? area : 'an unknown area', " and expected back by ").concat(missedTime !== null && missedTime !== void 0 ? missedTime : 'a scheduled time');
        },
        actionUrl: function () { return '/safety-history'; },
    }),
    tpl({
        eventType: 'safe_return.cleared',
        category: 'safe_return',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var travelerName = _a.travelerName;
            return "".concat(travelerName !== null && travelerName !== void 0 ? travelerName : 'A traveler', " is safe");
        },
        body: function (_a) {
            var travelerName = _a.travelerName;
            return "".concat(travelerName !== null && travelerName !== void 0 ? travelerName : 'They', " confirmed they're okay");
        },
    }),
    // ── GPS / Location ─────────────────────────────────────────────────────────
    tpl({
        eventType: 'location.arrived_destination',
        category: 'location',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function () { return 'You\'ve arrived'; },
        body: function (_a) {
            var city = _a.city, country = _a.country;
            return "Welcome to ".concat([city, country].filter(Boolean).join(', ') || 'your destination');
        },
    }),
    tpl({
        eventType: 'location.nearby_traveler',
        category: 'location',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Traveler nearby'; },
        body: function (_a) {
            var actor = _a.actor;
            return "".concat(actor !== null && actor !== void 0 ? actor : 'A fellow traveler', " is in the same area");
        },
    }),
    tpl({
        eventType: 'location.live_share_started',
        category: 'location',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " shared their location");
        },
        body: function () { return 'Live location sharing is active. No exact coordinates are shown.'; },
    }),
    tpl({
        eventType: 'location.geofence_triggered',
        category: 'location',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Location check-in triggered'; },
        body: function (_a) {
            var area = _a.area;
            return "You entered ".concat(area !== null && area !== void 0 ? area : 'a tracked area');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    // ── Trip Crew ──────────────────────────────────────────────────────────────
    tpl({
        eventType: 'trip_crew.friend_request',
        category: 'trip_crew',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " sent a friend request");
        },
        body: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " wants to connect");
        },
        actionUrl: function () { return '/notifications'; },
    }),
    tpl({
        eventType: 'trip_crew.friend_accepted',
        category: 'trip_crew',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " accepted your request");
        },
        body: function (_a) {
            var actor = _a.actor;
            return "You and ".concat(actor, " are now travel friends");
        },
        actionUrl: function (_a) {
            var userId = _a.userId;
            return "/profile/".concat(userId);
        },
    }),
    tpl({
        eventType: 'trip_crew.circle_invite',
        category: 'trip_crew',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " invited you to their Circle");
        },
        body: function (_a) {
            var actor = _a.actor;
            return "Join ".concat(actor, "'s Travel Circle");
        },
        actionUrl: function () { return '/notifications'; },
    }),
    tpl({
        eventType: 'trip_crew.availability_nudge',
        category: 'trip_crew',
        defaultPriority: 'low',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " checked your availability");
        },
        body: function (_a) {
            var actor = _a.actor, dateLabel = _a.dateLabel, tripTitle = _a.tripTitle;
            return "".concat(actor !== null && actor !== void 0 ? actor : 'Someone', " is free ").concat(dateLabel !== null && dateLabel !== void 0 ? dateLabel : 'soon').concat(tripTitle ? " for ".concat(tripTitle) : '');
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    // ── Compass AI ─────────────────────────────────────────────────────────────
    tpl({
        eventType: 'compass.daily_brief',
        category: 'compass',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Your daily travel brief'; },
        body: function (_a) {
            var summary = _a.summary;
            return summary !== null && summary !== void 0 ? summary : 'Compass has updates for your upcoming trip';
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return tripId ? "/trip/".concat(tripId) : '/';
        },
    }),
    tpl({
        eventType: 'compass.recommendation',
        category: 'compass',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Compass recommendation'; },
        body: function (_a) {
            var recommendation = _a.recommendation;
            return recommendation !== null && recommendation !== void 0 ? recommendation : 'New suggestion based on your itinerary';
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    tpl({
        eventType: 'compass.warning',
        category: 'compass',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Travel alert'; },
        body: function (_a) {
            var warning = _a.warning;
            return warning !== null && warning !== void 0 ? warning : 'Compass flagged something for your trip';
        },
        actionUrl: function (_a) {
            var tripId = _a.tripId;
            return "/trip/".concat(tripId);
        },
    }),
    // ── City Pulse ─────────────────────────────────────────────────────────────
    tpl({
        eventType: 'pulse.new_post',
        category: 'pulse',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " posted");
        },
        body: function (_a) {
            var preview = _a.preview, city = _a.city;
            return "".concat(preview !== null && preview !== void 0 ? preview : 'New post').concat(city ? " in ".concat(city) : '');
        },
        actionUrl: function (_a) {
            var postId = _a.postId;
            return "/post/".concat(postId);
        },
    }),
    tpl({
        eventType: 'pulse.post_liked',
        category: 'pulse',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " liked your post");
        },
        body: function (_a) {
            var preview = _a.preview;
            return preview !== null && preview !== void 0 ? preview : 'Your post got a like';
        },
        actionUrl: function (_a) {
            var postId = _a.postId;
            return "/post/".concat(postId);
        },
    }),
    tpl({
        eventType: 'pulse.post_comment',
        category: 'pulse',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " commented");
        },
        body: function (_a) {
            var _b;
            var comment = _a.comment, preview = _a.preview;
            return (_b = comment !== null && comment !== void 0 ? comment : preview) !== null && _b !== void 0 ? _b : 'New comment on your post';
        },
        actionUrl: function (_a) {
            var postId = _a.postId;
            return "/post/".concat(postId);
        },
    }),
    tpl({
        eventType: 'pulse.highlight_viewed',
        category: 'pulse',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Your highlight was viewed'; },
        body: function (_a) {
            var viewCount = _a.viewCount;
            return "".concat(viewCount !== null && viewCount !== void 0 ? viewCount : 'Someone', " view").concat(viewCount === '1' ? '' : 's', " on your highlight");
        },
    }),
    // ── Passport ───────────────────────────────────────────────────────────────
    tpl({
        eventType: 'passport.stamp_earned',
        category: 'passport',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'New passport stamp! 🌍'; },
        body: function (_a) {
            var location = _a.location;
            return "You earned a stamp for ".concat(location !== null && location !== void 0 ? location : 'a new destination');
        },
        actionUrl: function () { return '/stamps'; },
    }),
    tpl({
        eventType: 'passport.milestone',
        category: 'passport',
        defaultPriority: 'important',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Passport milestone!'; },
        body: function (_a) {
            var milestone = _a.milestone;
            return milestone !== null && milestone !== void 0 ? milestone : 'You hit a new travel milestone';
        },
        actionUrl: function () { return '/stamps'; },
    }),
    tpl({
        eventType: 'passport.viewed',
        category: 'passport',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " viewed your passport");
        },
        body: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " checked out your travel history");
        },
        actionUrl: function (_a) {
            var userId = _a.userId;
            return "/passport/".concat(userId);
        },
    }),
    // ── Hidden Gems / Local Guides ─────────────────────────────────────────────
    tpl({
        eventType: 'hidden_gems.place_saved',
        category: 'hidden_gems',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function (_a) {
            var actor = _a.actor;
            return "".concat(actor, " saved your place");
        },
        body: function (_a) {
            var actor = _a.actor, placeName = _a.placeName;
            return "".concat(placeName !== null && placeName !== void 0 ? placeName : 'Your submission', " was saved by ").concat(actor !== null && actor !== void 0 ? actor : 'a traveler');
        },
    }),
    tpl({
        eventType: 'hidden_gems.place_approved',
        category: 'hidden_gems',
        defaultPriority: 'normal',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Place approved!'; },
        body: function (_a) {
            var placeName = _a.placeName;
            return "".concat(placeName !== null && placeName !== void 0 ? placeName : 'Your submission', " is now visible to the community");
        },
    }),
    tpl({
        eventType: 'hidden_gems.nearby_gem',
        category: 'hidden_gems',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Hidden gem nearby'; },
        body: function (_a) {
            var placeName = _a.placeName, city = _a.city;
            return "Check out ".concat(placeName !== null && placeName !== void 0 ? placeName : 'a great spot').concat(city ? " in ".concat(city) : '');
        },
    }),
    // ── Trust / Reliability ────────────────────────────────────────────────────
    tpl({
        eventType: 'trust.score_changed',
        category: 'trust',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function () { return 'Your trust score updated'; },
        body: function (_a) {
            var change = _a.change;
            return change === 'up' ? 'Your reliability score improved' : 'Your reliability score changed';
        },
    }),
    tpl({
        eventType: 'trust.report_received',
        category: 'trust',
        defaultPriority: 'important',
        defaultChannels: ['in_app'],
        title: function () { return 'New report on your account'; },
        body: function () { return 'A report was filed. Our team will review it.'; },
    }),
    tpl({
        eventType: 'trust.no_show',
        category: 'trust',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function () { return 'No-show recorded'; },
        body: function (_a) {
            var event = _a.event;
            return "A no-show was recorded for ".concat(event !== null && event !== void 0 ? event : 'a meetup');
        },
    }),
    // ── Airport / Layover ──────────────────────────────────────────────────────
    tpl({
        eventType: 'airport.layover_mode',
        category: 'airport',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function () { return 'Layover mode active'; },
        body: function (_a) {
            var airport = _a.airport, duration = _a.duration;
            return "You're at ".concat(airport !== null && airport !== void 0 ? airport : 'an airport').concat(duration ? " for ".concat(duration) : '');
        },
    }),
    tpl({
        eventType: 'airport.traveler_nearby',
        category: 'airport',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Fellow traveler at your airport'; },
        body: function (_a) {
            var actor = _a.actor;
            return "".concat(actor !== null && actor !== void 0 ? actor : 'Someone', " is at the same terminal");
        },
    }),
    tpl({
        eventType: 'airport.lounge_tip',
        category: 'airport',
        defaultPriority: 'low',
        defaultChannels: ['in_app'],
        title: function () { return 'Airport tip'; },
        body: function (_a) {
            var tip = _a.tip;
            return tip !== null && tip !== void 0 ? tip : 'Useful info for your layover';
        },
    }),
    // ── Admin / Moderation ─────────────────────────────────────────────────────
    tpl({
        eventType: 'admin.account_notice',
        category: 'admin',
        defaultPriority: 'urgent',
        defaultChannels: ['in_app', 'push'],
        title: function (_a) {
            var subject = _a.subject;
            return subject !== null && subject !== void 0 ? subject : 'Account notice from Travel Buddy';
        },
        body: function (_a) {
            var body = _a.body;
            return body !== null && body !== void 0 ? body : 'Please review your account settings.';
        },
    }),
    tpl({
        eventType: 'admin.moderation_action',
        category: 'admin',
        defaultPriority: 'urgent',
        defaultChannels: ['in_app', 'push'],
        title: function () { return 'Moderation action taken'; },
        body: function (_a) {
            var reason = _a.reason;
            return reason !== null && reason !== void 0 ? reason : 'An action was taken on your account.';
        },
    }),
    tpl({
        eventType: 'admin.system_update',
        category: 'admin',
        defaultPriority: 'normal',
        defaultChannels: ['in_app'],
        title: function () { return 'Travel Buddy update'; },
        body: function (_a) {
            var message = _a.message;
            return message !== null && message !== void 0 ? message : 'New features and improvements are available.';
        },
    }),
];
var TEMPLATE_MAP = new Map(exports.TEMPLATES.map(function (t) { return [t.eventType, t]; }));
function getTemplate(eventType) {
    var _a;
    return (_a = TEMPLATE_MAP.get(eventType)) !== null && _a !== void 0 ? _a : null;
}
function renderTemplate(eventType, params) {
    if (params === void 0) { params = {}; }
    var tpl = getTemplate(eventType);
    if (!tpl)
        return null;
    return {
        title: tpl.title(params),
        body: tpl.body(params),
        category: tpl.category,
        priority: tpl.defaultPriority,
        channels: tpl.defaultChannels,
        actionUrl: tpl.actionUrl ? tpl.actionUrl(params) : undefined,
    };
}
