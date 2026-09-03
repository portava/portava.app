/**
 * portavaRoutes.ts
 *
 * Single authoritative registry of every primary and significant nested route
 * in the Portava (Travel Buddy) app.
 *
 * This file is pure type + data — no runtime dependencies, no React imports.
 * Run `tsc --noEmit` from the travel-buddy package root to verify it compiles.
 *
 * Usage:
 *   import { PORTAVA_ROUTES, type PortavaRouteDefinition } from '@/src/navigation/portavaRoutes';
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Documents a single _layout.tsx file under app/.
 * Layout files define the nested navigator for their directory; they are NOT
 * screen routes but still need to be tracked so new route groups don't go
 * undocumented.
 */
export interface PortavaLayoutDefinition {
  /** Stable, hyphenated identifier for this layout. */
  key: string;
  /**
   * Expo-Router file-system path relative to `app/`, **including** the
   * `_layout` segment and without the `.tsx` extension.
   * e.g. `'(tabs)/_layout'`, `'profile/edit/_layout'`
   */
  path: string;
  /** Human-readable label for the navigator this layout owns. */
  title: string;
  /** The Expo-Router navigator component used by this layout. */
  navigator: 'Stack' | 'Tabs';
  /** One-line description of what this layout controls / wraps. */
  description: string;
  /**
   * Feature flag key that gates the entire group, or omit when always active.
   */
  featureFlag?: string;
  /** True when the entire subtree is restricted to Portava admin accounts. */
  adminOnly?: boolean;
}

export interface PortavaRouteDefinition {
  /** Stable identifier for this route (no slashes, hyphenated). */
  key: string;
  /**
   * Expo-Router file-system path relative to `app/`.
   * Dynamic segments use [param] notation.
   * Route groups use (group) notation.
   */
  path: string;
  /** Human-readable screen title (matches the options.title in the layout). */
  title: string;
  /**
   * Parent route key, or null for top-level routes.
   * Use the enclosing group / tab screen key for screens inside a group.
   */
  parent: string | null;
  /**
   * Lucide or custom icon name shown in the tab bar / sidebar for this route.
   * null for routes that have no icon representation.
   */
  icon: string | null;
  /** Whether a valid session is required to access this screen. */
  requiresAuth: boolean;
  /**
   * Feature flag key that gates entry to this route.
   * When the flag is off the screen is either hidden or shows a fallback.
   * null means no feature-flag gate.
   */
  featureFlag?: string;
  /**
   * True when the screen enforces that the viewer is the owner of the
   * primary resource displayed (e.g. own profile, own passport, own trips).
   */
  ownerOnly?: boolean;
  /**
   * True when the screen is restricted to Portava admin accounts.
   */
  adminOnly?: boolean;
  /**
   * Universal-link / deep-link URL pattern, or null if no direct deep-link
   * is supported.  Uses the same [param] notation as the path.
   */
  deepLink?: string;
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const PORTAVA_ROUTES: PortavaRouteDefinition[] = [

  // ── Root entry gate ───────────────────────────────────────────────────────

  {
    key: 'root-entry',
    path: 'index',
    title: 'Entry Gate',
    parent: null,
    icon: null,
    requiresAuth: false,
    // Renders a spinner while session resolves, then redirects to (auth)/sign-in
    // or (tabs)/index.  Not a real screen — just the routing gate.
  },

  // ── Auth ─────────────────────────────────────────────────────────────────

  {
    key: 'sign-in',
    path: '(auth)/sign-in',
    title: 'Sign In',
    parent: null,
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'onboarding',
    path: '(auth)/onboarding',
    title: 'Onboarding',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'update-password',
    path: '(auth)/update-password',
    title: 'Update Password',
    parent: null,
    icon: null,
    requiresAuth: false,
  },

  // ── Primary tabs ──────────────────────────────────────────────────────────

  {
    key: 'tab-pulse',
    path: '(tabs)/index',
    title: 'Pulse',
    parent: null,
    icon: 'Activity',
    requiresAuth: false,
  },
  {
    key: 'tab-discovery',
    path: '(tabs)/discovery',
    title: 'Explore',
    parent: null,
    icon: 'Compass',
    requiresAuth: false,
  },
  {
    key: 'tab-media',
    path: '(tabs)/media',
    title: 'Roam',
    parent: null,
    icon: 'Film',
    requiresAuth: false,
    featureFlag: 'MEDIA_TAB_ENABLED',
  },
  {
    key: 'tab-trips',
    path: '(tabs)/trips',
    title: 'Trips',
    parent: null,
    icon: 'Plane',
    requiresAuth: true,
  },
  {
    key: 'tab-passport',
    path: '(tabs)/passport',
    title: 'Passport',
    parent: null,
    icon: 'Passport',
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Hidden tab screens (href: null — registered but not in tab bar) ────────

  {
    key: 'tab-messages',
    path: '(tabs)/messages',
    title: 'Telegraph',
    parent: null,
    icon: 'MessageCircle',
    requiresAuth: true,
    // href: null — hidden from tab bar; reached via deep-link or push
  },
  {
    key: 'tab-events',
    path: '(tabs)/events',
    title: 'Events',
    parent: null,
    icon: 'Calendar',
    requiresAuth: false,
    // href: null — hidden from tab bar
  },
  {
    key: 'tab-ai',
    path: '(tabs)/ai',
    title: 'Compass AI',
    parent: null,
    icon: 'Sparkles',
    requiresAuth: true,
    // href: null — hidden from tab bar
  },
  {
    key: 'tab-wall',
    path: '(tabs)/wall',
    title: 'Wall',
    parent: null,
    icon: 'LayoutGrid',
    requiresAuth: true,
    // Flag-gated OFF server-side (wall_enabled). Added non-disruptively:
    // href: null in the tabs layout, so it does not replace the Pulse landing
    // tab and stays a secondary surface until the server flag is turned on.
    featureFlag: 'wall_enabled',
  },

  // ── Root stack screens ────────────────────────────────────────────────────

  {
    key: 'create',
    path: 'create',
    title: 'Create',
    parent: null,
    icon: 'Plus',
    requiresAuth: true,
  },
  {
    key: 'notifications',
    path: 'notifications',
    title: 'Notifications',
    parent: null,
    icon: 'Bell',
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'featured',
    path: 'featured',
    title: 'Featured by Portava',
    parent: null,
    icon: 'Trophy',
    requiresAuth: false,
  },
  {
    key: 'compass-preferences',
    path: 'compass-preferences',
    title: 'Compass Preferences',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'compass-memories',
    path: 'compass-memories',
    title: 'Compass Memories',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'compass-memory',
    path: 'compass-memory',
    title: 'Memory Intelligence',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'safety-number',
    path: 'safety-number',
    title: 'Safety Number',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'search',
    path: 'search',
    title: 'Search',
    parent: null,
    icon: 'Search',
    requiresAuth: false,
  },
  {
    key: 'saved',
    path: 'saved',
    title: 'Saved',
    parent: null,
    icon: 'Bookmark',
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'discover',
    path: 'discover',
    title: 'Discover',
    parent: null,
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'availability',
    path: 'availability',
    title: 'Availability',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'explore-portava',
    path: 'explore-portava',
    title: 'Explore Portava',
    parent: null,
    icon: null,
    requiresAuth: false,
    // App-wide directory screen — categorised index of every major system.
    // Accessible from the Passport owner menu and Settings.
  },

  // ── Profile ───────────────────────────────────────────────────────────────

  {
    key: 'profile-analytics',
    path: 'profile/analytics',
    title: 'Profile Analytics',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-travel-history',
    path: 'profile/travel-history',
    title: 'Travel History',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-verification',
    path: 'profile/verification',
    title: 'Verification',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'user-profile',
    path: 'u/[username]',
    title: 'Profile',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/u/[username]',
  },
  {
    key: 'followers',
    path: 'followers',
    title: 'Followers',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'mutual-connections',
    path: 'mutual-connections/[userId]',
    title: 'Mutual Connections',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: false,
  },
  {
    key: 'following',
    path: 'following',
    title: 'Following',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'follow-requests',
    path: 'follow-requests',
    title: 'Follow Requests',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-handle-redirect',
    path: 'profile/[handle]',
    title: 'Profile (Legacy Redirect)',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/profile/[handle]',
  },
  {
    key: 'profile-edit',
    path: 'profile/edit/index',
    title: 'Edit Profile',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-about',
    path: 'profile/edit/about',
    title: 'About Me',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-home-base',
    path: 'profile/edit/home-base',
    title: 'Home Base',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-interests',
    path: 'profile/edit/interests',
    title: 'Interests',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-languages',
    path: 'profile/edit/languages',
    title: 'Languages',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-account',
    path: 'profile/edit/account',
    title: 'Account Settings',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-calling',
    path: 'profile/edit/calling',
    title: 'Calling Settings',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-connected',
    path: 'profile/edit/connected',
    title: 'Connected Accounts',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-content-language',
    path: 'profile/edit/content-language',
    title: 'Content Language',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-emergency-contacts',
    path: 'profile/edit/emergency-contacts',
    title: 'Emergency Contacts',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-identity',
    path: 'profile/edit/identity',
    title: 'Identity',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-location',
    path: 'profile/edit/location',
    title: 'Location Settings',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-notifications',
    path: 'profile/edit/notifications',
    title: 'Notification Preferences',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-passport-layout',
    path: 'profile/edit/passport-layout',
    title: 'Passport Layout',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-passports',
    path: 'profile/edit/passports',
    title: 'Passports',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-photos',
    path: 'profile/edit/photos',
    title: 'Profile Photos',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-privacy',
    path: 'profile/edit/privacy',
    title: 'Privacy Settings',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-reports',
    path: 'profile/edit/reports',
    title: 'My Reports',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-safety',
    path: 'profile/edit/safety',
    title: 'Safety Settings',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-travel-profile',
    path: 'profile/edit/travel-profile',
    title: 'Travel Profile',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'profile-edit-who-can-see-me',
    path: 'profile/edit/who-can-see-me',
    title: 'Who Can See Me',
    parent: 'profile-edit',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Passport ──────────────────────────────────────────────────────────────

  {
    key: 'passport-viewer',
    path: 'passport/[username]',
    title: 'Passport',
    parent: null,
    icon: null,
    requiresAuth: false,
    featureFlag: 'stamp_showcase_enabled',
    deepLink: '/passport/[username]',
  },
  {
    key: 'passport-country',
    path: 'passport/country/[country]',
    title: 'Country Stamps',
    parent: 'passport-viewer',
    icon: null,
    requiresAuth: false,
    deepLink: '/passport/country/[country]',
  },
  {
    key: 'passport-my-world',
    path: 'passport/my-world',
    title: 'My World',
    parent: 'tab-passport',
    icon: 'Globe2',
    requiresAuth: true,
    ownerOnly: true,
    deepLink: '/passport/my-world',
  },

  // ── Stamps ────────────────────────────────────────────────────────────────

  {
    key: 'stamps',
    path: 'stamps',
    title: 'My Stamps',
    parent: 'tab-passport',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'stamp-detail',
    path: 'stamp/[stampId]',
    title: 'Stamp',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/stamp/[stampId]',
  },

  // ── Events ────────────────────────────────────────────────────────────────

  {
    key: 'event-detail',
    path: 'event/[id]',
    title: 'Event',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/event/[id]',
  },
  {
    key: 'events-list',
    path: 'events/list',
    title: 'Events',
    parent: 'tab-events',
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'events-create',
    path: 'events/create/index',
    title: 'Create Event',
    parent: 'tab-events',
    icon: null,
    requiresAuth: true,
  },
  {
    key: 'events-invites',
    path: 'events/invites',
    title: 'Event Invites',
    parent: 'tab-events',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Trips ─────────────────────────────────────────────────────────────────

  {
    key: 'trip-detail',
    path: 'trip/[id]',
    title: 'Trip',
    parent: 'tab-trips',
    icon: null,
    requiresAuth: false,
    deepLink: '/trip/[id]',
  },
  {
    key: 'trip-new',
    path: 'trip/new',
    title: 'New Trip',
    parent: 'tab-trips',
    icon: null,
    requiresAuth: true,
  },
  {
    key: 'trip-edit',
    path: 'trip/edit',
    title: 'Edit Trip',
    parent: 'trip-detail',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'trip-chat',
    path: 'trip/chat',
    title: 'Trip Chat',
    parent: 'trip-detail',
    icon: null,
    requiresAuth: true,
  },

  // ── Places ────────────────────────────────────────────────────────────────

  {
    key: 'place-detail',
    path: 'place/[id]',
    title: 'Place',
    parent: null,
    icon: null,
    requiresAuth: false,
    featureFlag: 'external_places_enabled',
    deepLink: '/place/[id]',
  },
  {
    key: 'place-day',
    path: 'place/[id]/day',
    title: 'Place Day',
    parent: 'place-detail',
    icon: null,
    requiresAuth: true,
    featureFlag: 'place_days_enabled',
    deepLink: '/place/[id]/day',
  },
  {
    key: 'place-shared-moments',
    path: 'place/[id]/moments',
    title: 'Shared Moments',
    parent: 'place-day',
    icon: null,
    requiresAuth: true,
    featureFlag: 'shared_moments_enabled',
    deepLink: '/place/[id]/moments',
  },
  {
    key: 'shared-moment-detail',
    path: 'shared-moments/[id]',
    title: 'Shared Moment',
    parent: 'place-shared-moments',
    icon: null,
    requiresAuth: true,
    featureFlag: 'shared_moments_enabled',
    deepLink: '/shared-moments/[id]',
  },
  {
    key: 'place-recap-detail',
    path: 'recaps/[id]',
    title: 'Travel recap',
    parent: 'place-day',
    icon: null,
    requiresAuth: true,
    featureFlag: 'place_recaps_enabled',
    deepLink: '/recaps/[id]',
  },

  // ── Destinations ──────────────────────────────────────────────────────────

  {
    key: 'destination-detail',
    path: 'destination/[slug]',
    title: 'Destination',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/destination/[slug]',
  },
  {
    key: 'destinations-city',
    path: 'destinations/[city]',
    title: 'City',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/destinations/[city]',
  },

  // ── Gems ──────────────────────────────────────────────────────────────────

  {
    key: 'gems-directory',
    path: 'gems/index',
    title: 'Gems',
    parent: null,
    icon: 'Gem',
    requiresAuth: false,
    deepLink: '/gems',
  },
  {
    key: 'gem-detail',
    path: 'gems/[id]',
    title: 'Gem',
    parent: 'gems-directory',
    icon: null,
    requiresAuth: false,
    deepLink: '/gems/[id]',
  },
  {
    key: 'gems-guide',
    path: 'gems/guide',
    title: 'Gems Guide',
    parent: 'gems-directory',
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'gems-submit',
    path: 'gems/submit',
    title: 'Submit a Gem',
    parent: 'gems-directory',
    icon: null,
    requiresAuth: true,
  },
  {
    key: 'gems-bookmark-preview',
    path: 'gems/bookmark-preview',
    title: 'Bookmark Comparison Preview',
    parent: 'gems-directory',
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'gems-share-icon-preview',
    path: 'gems/share-icon-preview',
    title: 'Portava Share Icon Preview',
    parent: 'gems-directory',
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'media-add-gem',
    path: 'media/add-gem',
    title: 'Add Gem',
    parent: 'tab-media',
    icon: null,
    requiresAuth: true,
    featureFlag: 'MEDIA_TAB_ENABLED',
  },

  // ── Map ───────────────────────────────────────────────────────────────────

  {
    key: 'map',
    path: 'map/index',
    title: 'Map',
    parent: null,
    icon: 'Map',
    requiresAuth: false,
    featureFlag: 'map_search_enabled',
  },

  // ── Messages / Telegraph ──────────────────────────────────────────────────

  {
    key: 'message-thread',
    path: 'messages/[id]',
    title: 'Message Thread',
    parent: 'tab-messages',
    icon: null,
    requiresAuth: true,
    deepLink: '/messages/[id]',
  },

  {
    key: 'telegraph-new',
    path: 'telegraph/new',
    title: 'New Telegraph',
    parent: 'tab-messages',
    icon: null,
    requiresAuth: true,
    deepLink: '/telegraph/new',
  },

  // ── Media viewer ──────────────────────────────────────────────────────────

  {
    key: 'media-viewer',
    path: 'media-viewer/[id]',
    title: 'Media Viewer',
    parent: null,
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'media-perspective-viewer',
    path: 'media-perspective/[id]',
    title: 'Media Viewer',
    parent: null,
    icon: null,
    requiresAuth: false,
    // §14 contextual perspective viewer for the World-first Media shell.
    // Additive; reached from the shell's place/experience perspective mosaics.
  },
  {
    key: 'media-world',
    path: 'media-world/index',
    title: 'Media World',
    parent: null,
    icon: null,
    requiresAuth: false,
  },

  // ── Posts ─────────────────────────────────────────────────────────────────

  {
    key: 'post-detail',
    path: 'post/[id]',
    title: 'Post',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/post/[id]',
  },
  {
    key: 'post-edit',
    path: 'post/edit/[id]',
    title: 'Edit Post',
    parent: 'post-detail',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'pending-posts',
    path: 'pending-posts',
    title: 'Pending Posts',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Hashtag ───────────────────────────────────────────────────────────────

  {
    key: 'hashtag-feed',
    path: 'hashtag/[slug]',
    title: 'Hashtag',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/hashtag/[slug]',
  },

  // ── Invite ────────────────────────────────────────────────────────────────

  {
    key: 'invite-token',
    path: 'invite/[token]',
    title: 'Invitation',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/invite/[token]',
  },

  // ── Meetups ───────────────────────────────────────────────────────────────

  {
    key: 'meetups-list',
    path: 'meetups/index',
    title: 'Meetups',
    parent: null,
    icon: null,
    requiresAuth: false,
  },
  {
    key: 'meetup-detail',
    path: 'meetup/[id]',
    title: 'Meetup',
    parent: 'meetups-list',
    icon: null,
    requiresAuth: false,
    deepLink: '/meetup/[id]',
  },

  // ── Layover ───────────────────────────────────────────────────────────────

  {
    key: 'layover-detail',
    path: 'layover/[id]',
    title: 'Layover',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/layover/[id]',
  },

  // ── Route ─────────────────────────────────────────────────────────────────

  {
    key: 'route-detail',
    path: 'route/[id]',
    title: 'Route',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/route/[id]',
  },

  // ── Memory ────────────────────────────────────────────────────────────────

  {
    key: 'memory-detail',
    path: 'memory/[id]',
    title: 'Memory',
    parent: null,
    icon: null,
    requiresAuth: false,
    deepLink: '/memory/[id]',
  },
  {
    key: 'memory-edit',
    path: 'memory/edit',
    title: 'Edit Memory',
    parent: 'memory-detail',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'memory-location',
    path: 'memory/location',
    title: 'Memory Location',
    parent: 'memory-detail',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Review ────────────────────────────────────────────────────────────────

  {
    key: 'review-form',
    path: 'review/[entityType]/[entityId]',
    title: 'Write a Review',
    parent: null,
    icon: null,
    requiresAuth: true,
  },

  // ── Social graph ──────────────────────────────────────────────────────────

  {
    key: 'circle',
    path: 'circle',
    title: 'Circle',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'close-friends',
    path: 'close-friends',
    title: 'Close Friends',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'circle-context-settings',
    path: 'circle-context-settings',
    title: 'Circle Context Settings',
    parent: 'circle',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'circle-presence',
    path: 'circle-presence',
    title: 'Circle Presence',
    parent: 'circle',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'blocked-users',
    path: 'blocked-users',
    title: 'Blocked Users',
    parent: 'profile-edit-privacy',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'muted-users',
    path: 'muted-users',
    title: 'Muted Users',
    parent: 'profile-edit-privacy',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'restricted-users',
    path: 'restricted-users',
    title: 'Restricted Users',
    parent: 'profile-edit-privacy',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Safety ────────────────────────────────────────────────────────────────

  {
    key: 'safety-history',
    path: 'safety-history',
    title: 'Safety Check-In History',
    parent: 'profile-edit-safety',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'appeals',
    path: 'appeals',
    title: 'Appeals',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Rent a Buddy ──────────────────────────────────────────────────────────

  {
    key: 'rab-home',
    path: '(rent-a-buddy)/index',
    title: 'Rent a Buddy',
    parent: null,
    icon: 'Users',
    requiresAuth: false,
    featureFlag: 'rent_buddy_enabled',
    deepLink: '/rent-a-buddy',
  },
  {
    key: 'rab-marketplace',
    path: '(rent-a-buddy)/marketplace',
    title: 'Buddy Marketplace',
    parent: 'rab-home',
    icon: null,
    requiresAuth: false,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-buddy-profile',
    path: '(rent-a-buddy)/buddy/[id]',
    title: 'Buddy Profile',
    parent: 'rab-marketplace',
    icon: null,
    requiresAuth: false,
    featureFlag: 'rent_buddy_enabled',
    deepLink: '/rent-a-buddy/buddy/[id]',
  },
  {
    key: 'rab-booking',
    path: '(rent-a-buddy)/booking/[id]',
    title: 'Booking',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
    deepLink: '/rent-a-buddy/booking/[id]',
  },
  {
    key: 'rab-checkout',
    path: '(rent-a-buddy)/checkout',
    title: 'Checkout',
    parent: 'rab-buddy-profile',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-request-buddy',
    path: '(rent-a-buddy)/request-buddy',
    title: 'Request a Buddy',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-search',
    path: '(rent-a-buddy)/search',
    title: 'Find a Buddy',
    parent: 'rab-marketplace',
    icon: null,
    requiresAuth: false,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-saved',
    path: '(rent-a-buddy)/saved',
    title: 'Saved Buddies',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-active',
    path: '(rent-a-buddy)/active',
    title: 'Active Booking',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-match-quiz',
    path: '(rent-a-buddy)/match-quiz',
    title: 'Buddy Match Quiz',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-offers',
    path: '(rent-a-buddy)/offers',
    title: 'Offers',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-waitlist',
    path: '(rent-a-buddy)/waitlist',
    title: 'Waitlist',
    parent: 'rab-home',
    icon: null,
    requiresAuth: false,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-review',
    path: '(rent-a-buddy)/review',
    title: 'Leave a Review',
    parent: 'rab-booking',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },

  // Become a Buddy
  {
    key: 'rab-become',
    path: '(rent-a-buddy)/become/index',
    title: 'Become a Buddy',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-become-apply',
    path: '(rent-a-buddy)/become/apply',
    title: 'Apply to Become a Buddy',
    parent: 'rab-become',
    icon: null,
    requiresAuth: true,
    featureFlag: 'rent_buddy_enabled',
  },

  // Buddy dashboard
  {
    key: 'rab-dashboard',
    path: '(rent-a-buddy)/buddy-dashboard/index',
    title: 'Buddy Dashboard',
    parent: 'rab-home',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-availability',
    path: '(rent-a-buddy)/buddy-dashboard/availability',
    title: 'Availability Settings',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-availability-calendar',
    path: '(rent-a-buddy)/buddy-dashboard/availability-calendar',
    title: 'Availability Calendar',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-requests',
    path: '(rent-a-buddy)/buddy-dashboard/requests',
    title: 'Requests',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-requests-inbox',
    path: '(rent-a-buddy)/buddy-dashboard/requests-inbox',
    title: 'Requests Inbox',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-earnings',
    path: '(rent-a-buddy)/buddy-dashboard/earnings',
    title: 'Earnings',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-earnings-ledger',
    path: '(rent-a-buddy)/buddy-dashboard/earnings-ledger',
    title: 'Earnings Ledger',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-packages',
    path: '(rent-a-buddy)/buddy-dashboard/packages',
    title: 'Packages',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-offer',
    path: '(rent-a-buddy)/buddy-dashboard/offer',
    title: 'Offer Management',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-offer-create',
    path: '(rent-a-buddy)/buddy-dashboard/offer-create',
    title: 'Create Offer',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-addons',
    path: '(rent-a-buddy)/buddy-dashboard/addons',
    title: 'Add-ons',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-meetup-pin',
    path: '(rent-a-buddy)/buddy-dashboard/meetup-pin',
    title: 'Meetup Pin',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-dashboard-safety',
    path: '(rent-a-buddy)/buddy-dashboard/safety',
    title: 'Buddy Safety',
    parent: 'rab-dashboard',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },

  // @Portava curation admin
  {
    key: 'admin-portava-posts',
    path: 'admin/portava-posts',
    title: '@Portava Posts',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-featured',
    path: 'admin/featured',
    title: 'Featured by @Portava',
    parent: 'admin-portava-posts',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-portava-post-new',
    path: 'admin/portava-post',
    title: 'New @Portava Post',
    parent: 'admin-portava-posts',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-portava-post-edit',
    path: 'admin/portava-post-edit',
    title: 'Edit @Portava Post',
    parent: 'admin-portava-posts',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },

  // RAB Admin
  {
    key: 'rab-admin',
    path: '(rent-a-buddy)/admin/index',
    title: 'RAB Admin',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-analytics',
    path: '(rent-a-buddy)/admin/analytics',
    title: 'RAB Analytics',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-applications',
    path: '(rent-a-buddy)/admin/applications',
    title: 'RAB Applications',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-bookings',
    path: '(rent-a-buddy)/admin/bookings',
    title: 'RAB Bookings',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-buddies',
    path: '(rent-a-buddy)/admin/buddies',
    title: 'RAB Buddies',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-fee-rules',
    path: '(rent-a-buddy)/admin/fee-rules',
    title: 'Fee Rules',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-flags',
    path: '(rent-a-buddy)/admin/flags',
    title: 'RAB Flags',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-marketplace',
    path: '(rent-a-buddy)/admin/marketplace',
    title: 'RAB Marketplace Admin',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-package-queue',
    path: '(rent-a-buddy)/admin/package-queue',
    title: 'Package Queue',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'rab-admin-rollout',
    path: '(rent-a-buddy)/admin/rollout',
    title: 'RAB Rollout',
    parent: 'rab-admin',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
    featureFlag: 'rent_buddy_enabled',
  },

  // ── Platform Admin ────────────────────────────────────────────────────────

  {
    key: 'admin-place-mismatch-reports',
    path: 'admin/place-mismatch-reports',
    title: 'Place Mismatch Reports',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-content-reports',
    path: 'admin/content-reports',
    title: 'Content Reports',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-feature-flags',
    path: 'admin/feature-flags',
    title: 'Feature Flags',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-gaming-flags',
    path: 'admin/gaming-flags',
    title: 'Gaming Flags',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-geocode-cache',
    path: 'admin/geocode-cache',
    title: 'Geocode Cache',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-hashtags',
    path: 'admin/hashtags',
    title: 'Hashtag Management',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-media',
    path: 'admin/media/index',
    title: 'Media Admin',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-place-images',
    path: 'admin/place-images/index',
    title: 'Place Images',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-schema-drift',
    path: 'admin/schema-drift',
    title: 'Schema Drift',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-stamps',
    path: 'admin/stamps/index',
    title: 'Stamp Catalog',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-stamp-detail',
    path: 'admin/stamps/[catalogId]',
    title: 'Stamp Catalog Entry',
    parent: 'admin-stamps',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-stamps-duplicates',
    path: 'admin/stamps/duplicates',
    title: 'Duplicate Stamps',
    parent: 'admin-stamps',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-stamps-failed',
    path: 'admin/stamps/failed',
    title: 'Failed Stamps',
    parent: 'admin-stamps',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-stamps-queue',
    path: 'admin/stamps/queue',
    title: 'Stamp Queue',
    parent: 'admin-stamps',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-stamps-reconciler',
    path: 'admin/stamps/reconciler-runs',
    title: 'Reconciler Runs',
    parent: 'admin-stamps',
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-trust-detail',
    path: 'admin/trust-detail',
    title: 'Trust Detail',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-trust-reviews',
    path: 'admin/trust-reviews',
    title: 'Trust Reviews',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-trust-settings',
    path: 'admin/trust-settings',
    title: 'Trust Settings',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
  {
    key: 'admin-visuals',
    path: 'admin/visuals/index',
    title: 'Visuals Admin',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },

  // ── 404 ───────────────────────────────────────────────────────────────────

  {
    key: 'not-found',
    path: '+not-found',
    title: 'Not Found',
    parent: null,
    icon: null,
    requiresAuth: false,
  },

  // ── Reminders ─────────────────────────────────────────────────────────────

  {
    key: 'reminders-index',
    path: 'reminders/index',
    title: 'Reminders',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'reminders-new',
    path: 'reminders/new',
    title: 'New Reminder',
    parent: 'reminders-index',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'reminders-detail',
    path: 'reminders/[id]',
    title: 'Reminder',
    parent: 'reminders-index',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Settings ──────────────────────────────────────────────────────────────

  {
    key: 'settings-index',
    path: 'settings/index',
    title: 'Settings',
    parent: null,
    icon: null,
    requiresAuth: true,
  },
  {
    key: 'compass-settings',
    path: 'compass-settings',
    title: 'Compass Settings',
    parent: null,
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },
  {
    key: 'settings-intel-prompts',
    path: 'settings/intel-prompts',
    title: 'Live intel prompts',
    parent: 'settings-index',
    icon: 'Radio',
    requiresAuth: true,
    ownerOnly: true,
    featureFlag: 'intel_capture_quick_signal',
  },
  {
    key: 'profile-change-password',
    path: 'profile/change-password',
    title: 'Change Password',
    parent: 'user-profile',
    icon: null,
    requiresAuth: true,
    ownerOnly: true,
  },

  // ── Plan alias ────────────────────────────────────────────────────────────
  //
  // A "plan" is not an entity: plan items are keyed on trip_id and every server
  // route is scoped /trips/:tripId/plan/... This path is an addressable alias
  // that resolves to the owning trip, hence trip-detail as its parent.

  {
    key: 'plan-detail',
    path: 'plan/[id]',
    title: 'Plan',
    parent: 'trip-detail',
    icon: null,
    requiresAuth: true,
    deepLink: '/plan/[id]',
  },

  // ── Intelligence Gathering capture (shadow, flag-gated, off by default) ────
  //
  // Modal capture surfaces. Every screen is an inert no-op unless
  // `intel_capture_quick_signal` (and, for the Trail, `intel_trail_followup`)
  // is enabled, and is fully suppressed during an active Safe Return session.

  {
    key: 'intel-quick-signal',
    path: 'intel/quick-signal',
    title: 'Quick Signal',
    parent: null,
    icon: 'Radio',
    requiresAuth: true,
    featureFlag: 'intel_capture_quick_signal',
    deepLink: '/intel/quick-signal',
  },
  {
    key: 'intel-trail',
    path: 'intel/trail',
    title: 'Where next?',
    parent: null,
    icon: 'Signpost',
    requiresAuth: true,
    featureFlag: 'intel_trail_followup',
  },
  {
    key: 'intel-moment',
    path: 'intel/moment',
    title: 'Structured Moment',
    parent: null,
    icon: 'Sparkles',
    requiresAuth: true,
    featureFlag: 'intel_capture_quick_signal',
  },

  // ── Admin ─────────────────────────────────────────────────────────────────

  {
    key: 'admin-user-moderation',
    path: 'admin/user-moderation',
    title: 'User Moderation',
    parent: null,
    icon: null,
    requiresAuth: true,
    adminOnly: true,
  },
];

// ── Layout registry ───────────────────────────────────────────────────────────
//
// Every _layout.tsx under app/ must have a matching entry here.
// Run `pnpm --dir travel-buddy-standalone run lint:routes` to verify.

export const PORTAVA_LAYOUT_FILES: PortavaLayoutDefinition[] = [
  {
    key: 'root-layout',
    path: '_layout',
    title: 'Root Layout',
    navigator: 'Stack',
    description:
      'Top-level app shell. Wraps the entire tree in SessionProvider, FeatureFlagsProvider, ' +
      'CompassProvider, CallProvider, and all global context providers. Bootstraps the ' +
      'root Stack navigator and registers background tasks (geofence, checkpoint arrival).',
  },
  {
    key: 'auth-layout',
    path: '(auth)/_layout',
    title: 'Auth Group Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the (auth) route group (sign-in, onboarding). ' +
      'Renders with headerShown: false so each auth screen controls its own chrome.',
  },
  {
    key: 'tabs-layout',
    path: '(tabs)/_layout',
    title: 'Tabs Layout',
    navigator: 'Tabs',
    description:
      'Primary tab navigator. Renders the floating pill bar on mobile and a left sidebar ' +
      'on desktop (useIsDesktop). Owns the five main tabs (Pulse, Explore, Media/+, Trips, ' +
      'Passport) plus three hidden tabs (Messages, Events, Compass AI) with href: null.',
  },
  {
    key: 'place-layout',
    path: 'place/_layout',
    title: 'Place Stack Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the place/ subtree (place/[id]). Applies a themed header ' +
      '(paperRaised background, ink tint, no shadow) across all place screens.',
  },
  {
    key: 'profile-edit-layout',
    path: 'profile/edit/_layout',
    title: 'Edit Profile Stack Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the profile/edit/ subtree. Hides the default header ' +
      '(headerShown: false) and sets the Passport paper background colour so each ' +
      'edit screen can render its own custom header.',
  },
  {
    key: 'rent-a-buddy-layout',
    path: '(rent-a-buddy)/_layout',
    title: 'Rent a Buddy Group Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the (rent-a-buddy) route group. Guards the entire subtree ' +
      'via useRentABuddyFlag — shows a "COMING SOON" screen when the flag is off ' +
      'instead of rendering child routes.',
    featureFlag: 'rent_buddy_enabled',
  },
  {
    key: 'admin-place-images-layout',
    path: 'admin/place-images/_layout',
    title: 'Admin Place Images Stack Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the admin/place-images/ subtree. Renders headerShown: false ' +
      'so the admin place-images screens control their own headers.',
    adminOnly: true,
  },
  {
    key: 'admin-stamps-layout',
    path: 'admin/stamps/_layout',
    title: 'Admin Stamp Studio Stack Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the admin/stamps/ subtree (Stamp Studio). Renders ' +
      'headerShown: false; admin auth is enforced by each individual screen.',
    adminOnly: true,
  },
  {
    key: 'admin-visuals-layout',
    path: 'admin/visuals/_layout',
    title: 'Admin AI Visuals Stack Layout',
    navigator: 'Stack',
    description:
      'Stack navigator for the admin/visuals/ subtree. Renders headerShown: false; ' +
      'admin auth is enforced by each individual screen.',
    adminOnly: true,
  },
];
