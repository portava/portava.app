/**
 * Rent a Buddy — WHICH gate refused, and what unblocks it.
 *
 * Testing mode (lane tm-rab, WP-01) requires that when a Rent-a-Buddy gate
 * refuses, the app shows a state of its own that names the gate and says what
 * unblocks it — never an empty list and never a generic error. The gates are
 * all enforced on the SERVER; nothing here decides whether anything is allowed.
 * This module only turns the server's refusal (its `error` code, plus the
 * `gate` field the server adds where one code covers several gates) into that
 * sentence.
 *
 * The server gates, in the order a booking meets them:
 *   rent_buddy_enabled                     master switch (requireRentBuddyEnabled)
 *   identity-verification readiness        KYC gate (lib/rentBuddyKycGate.ts), with
 *                                          the rent_buddy_allow_bookings_without_kyc override
 *   disable_rent_buddy_booking /
 *   disable_rab_bookings                   booking kill switches
 *   rent_buddy_global_controls.*           platform-wide pauses
 *   RENT_BUDDY_ADMIN_ONLY_MODE / _MVP_MODE / RENT_BUDDY_BETA_ONLY_MODE
 *   rent_buddy_city_rollouts               per-city rollout stage
 *   rent_buddy_beta_access                 per-user beta invitations
 *   rent_buddy_launch_controls             per city/country/category policy
 *   rent_buddy_user_limits                 per-account admin limits
 *
 * `feature_disabled` is the one code three gates share (the master switch and
 * both kill switches); the server names which in `gate`. A `feature_disabled`
 * WITHOUT a `gate` can only have come from checkRentBuddyAccess's step 1 —
 * the master switch — so that is what it is reported as.
 *
 * Kept import-free so it runs under node:test.
 */

export interface GateRefusal {
  /** The gate's own name — a flag, a table, or a table column — as an admin would search for it. */
  gate: string;
  /** Short heading. */
  title: string;
  /** What refused and why, in plain words. */
  body: string;
  /** What unblocks it, and who can do that. */
  unblock: string;
  /** An in-app route that clears it, when the person themselves can. */
  action?: { label: string; route: string };
}

const KILL_SWITCHES = new Set(['disable_rent_buddy_booking', 'disable_rab_bookings', 'rab_booking_kill_switch']);

const ROLLOUT_ADMIN = 'An admin changes the city in Admin → Rent a Buddy → Rollout Dashboard.';

function masterSwitch(): GateRefusal {
  return {
    gate: 'rent_buddy_enabled',
    title: 'Rent a Buddy is switched off',
    body: 'The rent_buddy_enabled feature flag is off for this app (or could not be read), so the server refuses every Rent a Buddy action.',
    unblock: 'An admin turns rent_buddy_enabled on in Admin → Feature flags. Switching it on is an owner decision for this deployment.',
  };
}

function killSwitch(name: string): GateRefusal {
  const which = name === 'rab_booking_kill_switch' ? 'A booking kill switch' : name;
  return {
    gate: name,
    title: 'New bookings are stopped by a kill switch',
    body: `${which} is engaged (or its state could not be read, which counts as engaged), so the server refuses new bookings. Bookings that already exist keep working.`,
    unblock: `An admin turns ${name === 'rab_booking_kill_switch' ? 'disable_rent_buddy_booking and disable_rab_bookings' : name} off in Admin → Feature flags, once whatever it was pulled for is resolved.`,
  };
}

const BY_CODE: Record<string, (gate?: string) => GateRefusal> = {
  verification_unavailable: () => ({
    gate: 'identity-verification readiness (rent_buddy_allow_bookings_without_kyc)',
    title: 'Bookings wait on identity verification',
    body: 'No identity-verification provider is operational in this deployment and the rent_buddy_allow_bookings_without_kyc override is off, so the server refuses new bookings between strangers.',
    unblock: 'An operational ID-verification provider is configured, or the owner explicitly turns rent_buddy_allow_bookings_without_kyc on for testing. Both are owner decisions.',
  }),
  globally_paused: () => ({
    gate: 'rent_buddy_global_controls.all_bookings_paused',
    title: 'All bookings are paused',
    body: 'The platform-wide "pause all bookings" control is on, so the server refuses new bookings everywhere. Existing bookings keep working.',
    unblock: 'An admin clears "All bookings paused" in Admin → Rent a Buddy → Rollout Dashboard → Global controls.',
  }),
  applications_paused: () => ({
    gate: 'rent_buddy_global_controls.applications_paused',
    title: 'Buddy applications are paused',
    body: 'The platform-wide "pause applications" control is on.',
    unblock: 'An admin clears "Applications paused" in Admin → Rent a Buddy → Rollout Dashboard → Global controls.',
  }),
  admin_only: () => ({
    gate: 'RENT_BUDDY_ADMIN_ONLY_MODE',
    title: 'Rent a Buddy is in admin-only mode',
    body: 'RENT_BUDDY_ADMIN_ONLY_MODE is on, so only admins can use Rent a Buddy right now.',
    unblock: 'An admin turns RENT_BUDDY_ADMIN_ONLY_MODE off in Admin → Feature flags.',
  }),
  city_not_available: () => ({
    gate: 'rent_buddy_city_rollouts',
    title: "This city isn't rolled out",
    body: 'This city has no rollout, or its rollout is disabled or suspended, so the server refuses bookings here.',
    unblock: `${ROLLOUT_ADMIN} Until then you can join the waitlist for it.`,
  }),
  city_not_launched: () => ({
    gate: 'rent_buddy_city_rollouts',
    title: "This city hasn't launched",
    body: 'This city has no active rollout, so the server refuses bookings here.',
    unblock: `${ROLLOUT_ADMIN} Until then you can join the waitlist for it.`,
  }),
  waitlist_only: () => ({
    gate: 'rent_buddy_city_rollouts / rent_buddy_launch_controls (waitlist only)',
    title: 'This location is waitlist-only',
    body: "This city's rollout stage, or the launch control for this location, is set to waitlist-only, so bookings are refused.",
    unblock: `${ROLLOUT_ADMIN} or edits the location's launch control in Admin → Rent a Buddy → Launch controls. You can join the waitlist meanwhile.`,
  }),
  not_open_for_bookings: () => ({
    gate: 'rent_buddy_city_rollouts (buddy_applications_open)',
    title: 'This city is recruiting buddies, not taking bookings',
    body: "The city's rollout is at the buddy-applications stage, so traveller bookings are refused.",
    unblock: `${ROLLOUT_ADMIN} It must be advanced past buddy_applications_open.`,
  }),
  internal_testing: () => ({
    gate: 'rent_buddy_city_rollouts (internal_testing)',
    title: 'This city is in internal testing',
    body: "The city's rollout is at the internal-testing stage, which only admin test accounts can use.",
    unblock: `${ROLLOUT_ADMIN} It must be advanced to beta or public.`,
  }),
  city_paused: () => ({
    gate: 'rent_buddy_city_rollouts (paused)',
    title: 'Bookings in this city are paused',
    body: "The city's rollout is paused, so new bookings are refused. Existing bookings keep working.",
    unblock: `${ROLLOUT_ADMIN} It must be resumed.`,
  }),
  city_beta_access_required: () => ({
    gate: 'rent_buddy_beta_access',
    title: 'This city is in beta',
    body: "The city's rollout is at the beta stage and your account has no active beta access for it.",
    unblock: 'An admin grants your account beta access for this city in Admin → Rent a Buddy → Rollout Dashboard → Beta access.',
  }),
  beta_access_required: () => ({
    gate: 'RENT_BUDDY_BETA_ONLY_MODE + rent_buddy_beta_access',
    title: 'Rent a Buddy is beta-only',
    body: 'RENT_BUDDY_BETA_ONLY_MODE is on and your account has no active beta access.',
    unblock: 'An admin grants your account beta access in Admin → Rent a Buddy → Rollout Dashboard → Beta access, or turns RENT_BUDDY_BETA_ONLY_MODE off.',
  }),
  location_unavailable: () => ({
    gate: 'rent_buddy_launch_controls',
    title: 'No launch control covers this booking',
    body: 'Launch controls are deny-by-default: there is no enabled control for this city, country and category, so the server refuses the booking.',
    unblock: 'An admin adds or enables a launch control for this location in Admin → Rent a Buddy → Launch controls.',
  }),
  restrictions_unavailable: () => ({
    gate: 'rent_buddy_launch_controls (unreadable)',
    title: "Availability here couldn't be checked",
    body: 'The launch-control table could not be read, and an unknown gate refuses rather than lets a booking through.',
    unblock: 'Try again shortly. If it persists, the database needs looking at.',
  }),
  verification_required: () => ({
    gate: 'rent_buddy_launch_controls.require_id_verification / RENT_BUDDY_MVP_MODE',
    title: 'Your ID needs verifying first',
    body: 'This location (or the MVP launch phase) requires a verified ID before a booking can go through.',
    unblock: 'Verify your ID once and come straight back.',
    action: { label: 'Verify my ID', route: '/profile/verification' },
  }),
  age_verification_required: () => ({
    gate: 'rent_buddy_launch_controls (age)',
    title: 'Your date of birth is needed',
    body: 'The launch control for this location checks age, and your profile has no date of birth on it.',
    unblock: 'Add your date of birth to your profile, then try again.',
  }),
  age_requirement: () => ({
    gate: 'rent_buddy_launch_controls.min_age / nightlife_min_age',
    title: "You're under this location's minimum age",
    body: 'The launch control for this location sets a minimum age your profile does not meet.',
    unblock: 'Only an admin can change the minimum age, in Admin → Rent a Buddy → Launch controls.',
  }),
  access_limited: () => ({
    gate: 'rent_buddy_user_limits',
    title: 'Your Rent a Buddy access is limited',
    body: 'An admin has placed a limit on this account (for example while a report is reviewed).',
    unblock: 'Contact support. An admin lifts account limits.',
  }),
  offers_unavailable: () => ({
    gate: 'RENT_BUDDY_OFFERS_ENABLED',
    title: 'Offer bookings are off',
    body: 'RENT_BUDDY_MVP_MODE is on and RENT_BUDDY_OFFERS_ENABLED is off, so accepting an offer cannot create a booking.',
    unblock: 'An admin turns RENT_BUDDY_OFFERS_ENABLED on in Admin → Feature flags.',
  }),
  packages_unavailable: () => ({
    gate: 'RENT_BUDDY_PACKAGES_ENABLED',
    title: 'Package bookings are off',
    body: 'RENT_BUDDY_MVP_MODE is on and RENT_BUDDY_PACKAGES_ENABLED is off.',
    unblock: 'An admin turns RENT_BUDDY_PACKAGES_ENABLED on in Admin → Feature flags.',
  }),
  category_not_available: () => ({
    gate: 'RENT_BUDDY_MVP_MODE (category list)',
    title: "This category isn't open in the MVP phase",
    body: 'RENT_BUDDY_MVP_MODE limits bookings to city, language, arrival, shopping and content.',
    unblock: 'Choose one of those categories, or an admin turns RENT_BUDDY_MVP_MODE off.',
  }),
  nightlife_disabled: () => ({
    gate: 'RENT_BUDDY_NIGHTLIFE_ENABLED / rent_buddy_global_controls.nightlife_paused',
    title: 'Nightlife bookings are off',
    body: 'Either RENT_BUDDY_NIGHTLIFE_ENABLED is off or nightlife is paused in global controls.',
    unblock: 'An admin turns RENT_BUDDY_NIGHTLIFE_ENABLED on in Admin → Feature flags and clears the nightlife pause.',
  }),
  group_bookings_unavailable: () => ({
    gate: 'RENT_BUDDY_GROUP_BOOKINGS_ENABLED',
    title: 'Group bookings are off',
    body: 'RENT_BUDDY_MVP_MODE is on and RENT_BUDDY_GROUP_BOOKINGS_ENABLED is off, so groups over 4 are refused.',
    unblock: 'Book for 4 or fewer, or an admin turns RENT_BUDDY_GROUP_BOOKINGS_ENABLED on.',
  }),
};

/**
 * The gate behind a refusal, or `null` when the code is not a gate refusal
 * (an ordinary failure, a validation error, a state conflict) — those keep
 * their own error treatment.
 */
export function describeGateRefusal(
  code: string | null | undefined,
  gate?: string | null,
): GateRefusal | null {
  if (!code) return null;
  if (code === 'feature_disabled') {
    if (gate && KILL_SWITCHES.has(gate)) return killSwitch(gate);
    return masterSwitch();
  }
  const make = BY_CODE[code];
  return make ? make(gate ?? undefined) : null;
}

/** True when this refusal is a gate, and so gets the gate state rather than an error. */
export function isGateRefusal(code: string | null | undefined, gate?: string | null): boolean {
  return describeGateRefusal(code, gate) !== null;
}

/** The layout's own refusal: the master switch read as OFF (not unreadable). */
export function masterSwitchOffRefusal(): GateRefusal {
  return masterSwitch();
}
