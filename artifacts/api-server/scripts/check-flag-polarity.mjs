#!/usr/bin/env node
//
// check-flag-polarity.mjs — every feature flag is classified, and read by the
// reader its classification demands.
//
// Plain node, builtins only, no dependencies, no network, no node_modules.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS ENFORCES, AND — READ THIS — WHAT IT DOES NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// IT ENFORCES: that a classification EXISTS for every flag name, and that the
// reader used at each call site MATCHES that classification.
//
// IT DOES NOT ENFORCE: that the classification is RIGHT.
//
// Deciding whether `disable_foo` is a genuine emergency stop or a capability
// gate wearing a scary name is a judgment about what the flag MEANS to an
// operator. No script can make it. `rent_buddy_allow_bookings_without_kyc`
// below is the proof: it reads like a stop, it is not one, and only a human
// reading the surrounding code could tell. Every entry in this file is a
// recorded human judgment, and a wrong one will sail through green.
//
// What the check buys is that the judgment gets MADE — once, in writing, in a
// diff, at the moment the flag is introduced — instead of never. The failure it
// prevents is not "someone classified a flag wrongly". It is "nobody looked".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT KEYS ON FLAG NAMES AND NOT ON CALL SITES
// ─────────────────────────────────────────────────────────────────────────────
//
// The obvious check is: grep for isFlagEnabled() called with a `disable_*`
// flag, fail if found. That is the shape of the bug that was fixed in c89f09a7,
// and it is too weak in two ways that this repo actually exhibits TODAY:
//
//   1. It is blind to flags whose name does not advertise the polarity.
//      `invite_only_beta` restricts signups. `COMPASS_*_SAFETY_BLOCK` (built by
//      string concatenation in CompassNotificationEngine) blocks a category.
//      Neither contains "disable". A name-pattern rule never looks at them.
//
//   2. It is blind to who is actually reading. Files under src/ define their
//      OWN local function named `isFlagEnabled`, and they do not agree with the
//      shared helper or with each other. A rule that greps for `isFlagEnabled(`
//      scores every one of them as compliant with a contract they do not
//      implement.
//
//      This paragraph used to name FIVE such files and assert that number in
//      prose. It was wrong twice over, which is the argument for SHADOW_READERS
//      below being the machine-checked inventory instead: it omitted
//      lib/accountDeletionScheduler.ts (the population was SIX), and the sixth
//      is precisely the one the Phase 0 report had already flagged as the
//      shadow a call-site check would misread. routes/airport.ts's copy was the
//      one that genuinely diverged — it returned TRUE on a DB error and TRUE on
//      a missing row, the exact opposite of lib/featureFlags.ts. It has since
//      been deleted in favour of the shared helper, leaving five declared
//      shadows, all of them fail-closed.
//
// So the subject is the POPULATION OF FLAG NAMES, and the rule is that each
// member is classified and read through a reader that matches. Same move as
// check-guard-coverage.mjs: do not pattern-match risky code, enumerate the
// population and require every member to be accounted for.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CLASSIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────
//
// STOP        An emergency stop. `true` means "stop doing X". The DANGER is
//             that a read failure returns false, i.e. "do not stop" — the
//             switch disengages exactly when the database is unhealthy, which
//             is when an operator is reaching for it. STOP flags may be read
//             ONLY through isKillSwitchEngaged, which engages on error and
//             (crucially) does NOT engage on a missing row.
//
// CAPABILITY  An ordinary feature gate. `true` means "X is available". A read
//             failure returning false means "feature off", which is the safe
//             default. Read through isFlagEnabled / isLivePlacesCapability-
//             Enabled, or through a direct read with a DIRECT_READS entry.
//
// CONFIG      Not a boolean gate at all — a tuning value that happens to live
//             in the feature_flags table. Neither polarity rule applies; the
//             entry exists so the name is accounted for rather than silently
//             skipped.
//
// CONVENTION carries the bulk of the population so this file stays readable:
//   `disable_*` or `*_disabled`  (lowercase) → STOP
//   `*_enabled`                  (lowercase) → CAPABILITY
// A name matching NEITHER convention must appear in CLASSIFIED with a reason.
// SCREAMING_CASE names deliberately do NOT get a convention: they are a second
// naming scheme that grew separately, and auto-classifying them would be
// exactly the unexamined assumption this check exists to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY DIRECT READS ARE A RECORDED JUDGMENT AND NOT AN ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────
//
// An earlier draft of this rule said a direct `.from("feature_flags")` read is
// acceptable if "its error branch is fail-closed". That clause was removed
// because THE CHECK CANNOT VERIFY IT, and a clause a check cannot verify is an
// auto-accept dressed up as a requirement — it would have waved through ~40
// call sites on an assertion nobody ever made.
//
// It is not verifiable because, in this codebase, "the error branch" frequently
// is not a branch, and frequently is not there:
//
//   • routes/compass.ts:411 — the catch only logs. The fail direction comes
//     from `let feedEnabled = false` declared BEFORE the try. Same in
//     routes/telegraph.ts (`compassCtx` initialized null) and
//     CompassHiddenGemService (`empty` initialized before the try). The
//     analyser would have to track initializers across the try boundary.
//   • lib/rankLog.ts:34 — the catch keeps a previously CACHED value. The fail
//     direction depends on runtime cache state and is not a static property.
//   • routes/pulse.ts:379 — the read sits inside a ~40-line try shared with a
//     dozen unrelated operations, and `error` is never destructured. There is
//     no error branch belonging to this read.
//   • routes/rentABuddy.ts:123 — no try/catch and no `error` destructuring at
//     all. A rejected query throws past the function to the route handler.
//   • StampAwardEngine.ts:132 and :150 — two reads in ONE function with
//     deliberately OPPOSITE documented polarities, one using a three-state
//     test (`flagRow !== null && enabled === false`).
//   • routes/location.ts:327, geofence.ts:566, hiddenGems.ts:882,
//     safeReturn.ts:396, airport.ts:460 — reads inside fire-and-forget
//     `void (async () => {...})()` blocks, where the "branch" is a bare return
//     from a detached task and the safety of that depends on the caller.
//   • compass/flags.ts:27, CompassPipeline.ts:81, CompassFrontLoadEngine.ts:287
//     — read by wildcard `.like("flag", "COMPASS_%")`. There is no flag name
//     literal to resolve, let alone an error branch.
//
// Deciding "fail-closed" would mean dataflow analysis over `any`-typed values,
// across try boundaries, into caller-dependent semantics. A dependency-free
// node script cannot do it, and a half-done version returns confident wrong
// answers on precisely the sites that matter most.
//
// So: every direct read carries an entry stating what a human verified and
// when. The reason text is not decoration — it is the whole content of the
// guarantee. Entries say what the read ACTUALLY does, including when that is
// fail-OPEN, because an entry that says "verified fail-closed" about a read
// that fails open is worse than no entry at all.
//
// ─────────────────────────────────────────────────────────────────────────────
// VACUITY IS FAILURE
// ─────────────────────────────────────────────────────────────────────────────
//
// A check that examines nothing passes trivially. Each of these is a non-zero
// exit: zero files scanned, an empty flag inventory, zero STOP flags found
// (the whole class vanishing is not success — it means the scan broke), an
// empty CLASSIFIED list, an entry with a missing or whitespace reason, an entry
// naming a flag that no longer appears in src/, an entry naming a file that
// does not exist or no longer contains what the entry describes, and any flag
// argument that cannot be resolved to a literal and is not declared.
//
// Non-literal arguments FAIL BY DEFAULT. They are never silently skipped —
// silently skipping the unreadable ones is how a check ends up reporting clean
// on the sites it understood least.
//
// Exit 0 only if every flag is classified, every reader matches, and every
// entry is still true. Exit 1 otherwise.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
// FLAG_POLARITY_SRC exists to point the scanner at a fixture tree so the
// vacuity guards below can be PROVEN to fire. It is safe to expose precisely
// because those guards exist: aiming this at an empty or wrong directory does
// not produce a quiet pass, it produces "VACUOUS: ... The scan has no subject."
// If you are tempted to set it in CI, you are trying to make the check examine
// less, and the check is built to fail when you succeed.
const SRC = process.env.FLAG_POLARITY_SRC
  ? resolve(process.env.FLAG_POLARITY_SRC)
  : join(PKG_ROOT, 'src');

// The one true implementation. Readers imported from here are the shared
// helpers; a function of the same name defined anywhere else is a SHADOW.
// Two files own shared readers: lib/featureFlags.ts (isFlagEnabled,
// isKillSwitchEngaged, isLivePlacesCapabilityEnabled) and compass/flags.ts
// (isEnabled, over the COMPASS_%% bulk load). A reader DEFINED in one of these
// is the shared implementation; the same name defined anywhere else is a shadow.
const SHARED_HELPER_FILES = new Set(['lib/featureFlags.ts', 'compass/flags.ts']);
const SHARED_HELPER_FILE = 'lib/featureFlags.ts';
const STOP_READER = 'isKillSwitchEngaged';
// `isEnabled` is compass/flags.ts's reader over the COMPASS_%% bulk load. It was
// missing from this list until the seeded-flag population reported
// COMPASS_V1_RULE_BASED_ENABLED as unread; it is read at routes/discovery.ts:1215.
// Four shared readers, not three.
//
// `getFlagRow` joined this list on 2026-08-14, when it acquired its first caller.
// It is defined in lib/featureFlags.ts:73 alongside the other shared helpers and
// had ZERO callers until lib/discoveryEngineMode.ts — this file's own note at
// the DISCOVERY-era entry below records that state. It is the only helper that
// reads feature_flags.metadata, which is what a three-valued mode requires, and
// it returns null on any error, so a flag read through it is fail-closed and
// CAPABILITY by the same argument as isFlagEnabled — not a stop.
//
// Adding it here rather than declaring its callers UNRESOLVABLE is deliberate:
// the argument IS a resolvable literal-valued const, so an UNRESOLVABLE entry
// would be stale the moment it was written (the check says so itself). The gap
// was never in the call site; it was that a real shared reader was missing from
// the vocabulary, which is the same defect the `isEnabled` note above records.
const CAP_READERS = ['isFlagEnabled', 'isLivePlacesCapabilityEnabled', 'isEnabled', 'getFlagRow'];

// ─────────────────────────────────────────────────────────────────────────────
// SCAN SCOPE
//
// Test files are excluded: they contain fake Supabase clients whose
// `.from("feature_flags")` is a stub returning canned rows, not a reader of the
// real table. Including them would fill this file with entries describing
// fixtures. The exclusion is asserted non-empty below — if the test corpus ever
// vanishes from the scan, that is a scan bug, not a clean run.
// ─────────────────────────────────────────────────────────────────────────────
const isTestPath = (rel) => rel.includes('__tests__/') || /(^|\/)test\//.test(rel) || rel.endsWith('.test.ts');

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFIED — flag names outside both conventions.
//
// Every entry needs a reason that answers: what does `true` mean, and what
// happens to a caller when the read fails?
// ─────────────────────────────────────────────────────────────────────────────
const CLASSIFIED = [
  // ── The ones that matter most: names whose polarity the conventions miss ──
  {
    flag: 'invite_only_beta',
    kind: 'CAPABILITY',
    reason:
      'RESTRICTION SEMANTICS, DELIBERATELY NOT A STOP. `true` narrows signup to invitees; it does not stop ' +
      'signups. False-on-error opens signup to everyone, which is a rollout decision, not an outage — the ' +
      'opposite call from disable_signups, which sits two lines away in routes/auth.ts and IS a stop. This is ' +
      'the entry that justifies the whole file: no name-pattern rule would ever have looked at this flag.',
  },
  {
    flag: 'rent_buddy_allow_bookings_without_kyc',
    kind: 'CAPABILITY',
    reason:
      'AN OVERRIDE, NOT A STOP, THOUGH IT READS LIKE ONE. `true` REMOVES the KYC requirement. False-on-error ' +
      'therefore keeps KYC ENFORCED, which is the safe direction, so isFlagEnabled is correct here and ' +
      'converting it to isKillSwitchEngaged would engage the override on a DB error and let unverified ' +
      'strangers book. Recorded explicitly because a future semantic rule would misfile it as a stop.',
  },
  {
    flag: 'find_your_circle_enabled',
    kind: 'CAPABILITY',
    reason:
      'Ordinary capability gate. Listed despite matching the *_enabled convention because a STOP of the SAME ' +
      'SUBJECT exists — find_your_circle_disabled — and the two mean opposite things. A reader who sees only ' +
      'one of them will guess wrong. False-on-error keeps the feature off, which is correct.',
  },
  {
    flag: 'stamp_auto_approve_artwork',
    kind: 'CAPABILITY',
    reason:
      'No suffix at all. `true` auto-approves generated stamp artwork; false routes it to human review. ' +
      'False-on-error means artwork goes to review, which is the conservative direction.',
  },
  {
    flag: 'DISCOVERY_ENGINE_MODE',
    kind: 'CONFIG',
    reason:
      'NOT A BOOLEAN GATE. Selects which discovery EXECUTION PATH handles a request — legacy | shadow | pde — ' +
      'carried in feature_flags.metadata.mode, with `enabled` acting only as a master off switch. Neither ' +
      'naming convention applies and neither polarity rule fits a three-valued setting, which is why it is ' +
      'CONFIG rather than CAPABILITY. Read through getFlagRow (the only helper that reads metadata), and ' +
      'EVERY unusable state resolves to `legacy` — absent row, enabled=false, missing mode, unrecognised ' +
      'mode, unreadable row. Legacy is the current production path, so a failure here can only preserve what ' +
      'users already get, which is the fail-closed direction for a setting whose other values change ' +
      'behaviour. Its companion EMERGENCY STOP is a separate flag, disable_discovery_pde, classified by the ' +
      'disable_* convention and read through isKillSwitchEngaged — deliberately NOT folded into this row, ' +
      'because a stop must be readable and engageable independently of the setting it protects.',
  },
  {
    flag: 'SEARCH_SIGNAL_DECAY_DAYS',
    kind: 'CONFIG',
    reason:
      'NOT A GATE. A tuning value — the row carries a numeric_value column read as a decay half-life. Neither ' +
      'polarity rule applies. Classified so the name is accounted for rather than silently skipped by a check ' +
      'that assumes every feature_flags row is a boolean.',
  },

  // ── SCREAMING_CASE. A second naming scheme, deliberately given no ────────
  // ── convention: auto-classifying it is the unexamined assumption this ────
  // ── check exists to prevent. All verified capability gates.           ────
  { flag: 'COMPASS_ENABLED',                     kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: Compass surfaces in the pulse feed. `true` = available.' },
  {
    flag: 'COMPASS_V1_RULE_BASED_ENABLED', kind: 'CAPABILITY',
    reason:
      'SCREAMING_CASE capability gate: routes the for_you discovery tab through the Compass rule-based ' +
      'pipeline (routes/discovery.ts:1215, read via compass/flags.ts isEnabled). `true` = pipeline scoring, ' +
      'false = the prior path. Became visible to this check only when isEnabled was added to CAP_READERS.',
  },
  {
    flag: 'COMPASS_TELEGRAPH', kind: 'CAPABILITY',
    reason:
      'SCREAMING_CASE capability gate for the Compass telegraph surface (routes/compass.ts:3490, read via ' +
      'compass/flags.ts isEnabled with a .catch(() => false)). NOT SEEDED by any migration, so through the ' +
      'COMPASS_% loader it is permanently false and indistinguishable from deliberately-off — the trap ' +
      'recorded at compass/flags.ts:26-29. Classified CAPABILITY; the always-false behaviour is a separate ' +
      'question from its polarity.',
  },
  { flag: 'COMPASS_FEED_ENABLED',                kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: the Compass feed endpoint. `true` = available.' },
  { flag: 'COMPASS_FALLBACK_MODE_ENABLED',       kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: degraded-mode Compass feed builder. `true` = available.' },
  { flag: 'CREATOR_FATIGUE_ENABLED',             kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: creator-fatigue damping in ranking. `true` = damping applied.' },
  { flag: 'DISCOVERY_DIVERSITY_ENABLED',         kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: diversity re-ranking in discovery. `true` = applied.' },
  { flag: 'ACTIVITY_DISCOVERY_BOOST_ENABLED',    kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: creator-activity boost job. `true` = job runs.' },
  { flag: 'NEW_CONTRIBUTOR_BOOST_ENABLED',       kind: 'CAPABILITY', reason: 'SCREAMING_CASE ranking boost gate. `true` = boost applied.' },
  { flag: 'RETURNING_USER_BOOST_ENABLED',        kind: 'CAPABILITY', reason: 'SCREAMING_CASE ranking boost gate. `true` = boost applied.' },
  { flag: 'UNDEREXPOSED_CONTENT_BOOST_ENABLED',  kind: 'CAPABILITY', reason: 'SCREAMING_CASE ranking boost gate. `true` = boost applied.' },
  { flag: 'RANKING_EXPERIMENT_ENABLED',          kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: ranking experiment arm. `true` = experiment live.' },
  { flag: 'MEDIA_RANKING_ENABLED',               kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: media feed ranking. `true` = ranking applied.' },
  { flag: 'MEDIA_ANALYTICS_ENABLED',             kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: media analytics collection. `true` = collected.' },
  { flag: 'MEDIA_SHARING_ENABLED',               kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: media sharing surface. `true` = available.' },
  { flag: 'MEDIA_COMMENTS_ENABLED',              kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: media comments. `true` = available.' },
  { flag: 'MEDIA_VIEW_MODE_GRID_ENABLED',        kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: grid view mode. `true` = available.' },
  { flag: 'MEDIA_VIEW_MODE_HIDDEN_GEMS_ENABLED', kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: hidden-gems view mode. `true` = available.' },
  { flag: 'MEDIA_HIDDEN_GEMS_NEARBY_ENABLED',    kind: 'CAPABILITY', reason: 'SCREAMING_CASE capability gate: nearby hidden gems in media feed. `true` = available.' },
  { flag: 'MEDIA_ACTIVE_CREATOR_BOOST_ENABLED',  kind: 'CAPABILITY', reason: 'SCREAMING_CASE media ranking boost gate. `true` = boost applied.' },
  { flag: 'MEDIA_NEW_CREATOR_BOOST_ENABLED',     kind: 'CAPABILITY', reason: 'SCREAMING_CASE media ranking boost gate. `true` = boost applied.' },
  { flag: 'MEDIA_RETURNING_CREATOR_BOOST_ENABLED', kind: 'CAPABILITY', reason: 'SCREAMING_CASE media ranking boost gate. `true` = boost applied.' },
  { flag: 'MEDIA_UNDEREXPOSED_BOOST_ENABLED',    kind: 'CAPABILITY', reason: 'SCREAMING_CASE media ranking boost gate. `true` = boost applied.' },
  { flag: 'MEDIA_CREATOR_FATIGUE_ENABLED',       kind: 'CAPABILITY', reason: 'SCREAMING_CASE media ranking damping gate. `true` = damping applied.' },
  { flag: 'PORTAVA_PUBLISHER_BOOST_ENABLED',     kind: 'CAPABILITY', reason: 'SCREAMING_CASE ranking boost gate for first-party publisher content. `true` = boost applied.' },
  { flag: 'PORTAVA_FEATURED_BOOST_ENABLED',      kind: 'CAPABILITY', reason: 'SCREAMING_CASE ranking boost gate for featured content. `true` = boost applied.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// SECOND POPULATION — FLAGS SEEDED BY A MIGRATION.
//
// The read inventory above answers "is every flag that is READ classified and
// read correctly?". It is blind, structurally, to a flag that is SEEDED and
// never read: with no read site, the flag never enters the population and is
// never asked to carry a classification.
//
// That blindness has a live instance. `0065_phase7_safety.sql:39` heads its
// INSERT block "These are kill-switches for safety incidents" and seeds
// freeze_city / freeze_event / freeze_circle / freeze_booking, each described
// as "Emergency: freeze …". Nothing in the repository reads any of them. They
// are seeded false, they appear in the admin list (GET /api/feature-flags
// returns the whole table), and an operator can toggle them. Toggling them does
// nothing.
//
// MID-INCIDENT THAT IS INDISTINGUISHABLE FROM THE BUG THIS CHECK WAS BUILT FOR.
// The eleven stops converted at c89f09a77 disengaged when the database was
// unhealthy: flip the switch, the thing keeps happening. These four do that
// unconditionally. An operator cannot tell the two apart from the outside, and
// the second is worse because no outage is required.
//
// So: every flag name seeded by an `INSERT INTO feature_flags` under
// src/migrations/ must either appear in the read inventory, or carry an
// INERT_SEEDED_FLAGS entry below. "unused" is not a reason. The entry must say
// which of the two remedies is intended — write a reader, or remove it from the
// seed — because those are the only two states in which the flag stops lying to
// whoever is looking at the admin list.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allowed values for an INERT_SEEDED_FLAGS entry's `disposition`.
 *
 * `owner-decision` and `owner-decision-pending` are NOT synonyms, and the
 * difference is the whole reason the second one exists. `owner-decision` means
 * someone read the flag, read the code around it, formed a view of what the
 * remedy probably is, and handed the call to an owner — the reason field on
 * those entries argues a position. `owner-decision-pending` means the flag was
 * INVISIBLE to this check until the day it was discovered, so nobody has looked
 * at it yet and the entry records only that fact.
 *
 * Collapsing the two would let a never-examined flag inherit the credibility of
 * an examined one. That is the same class of error as the seed scan itself:
 * declared state that reads as more resolved than it is.
 */
const DISPOSITIONS = new Set([
  'write-reader',           // the flag should gate something; the reader is missing
  'remove-from-seed',       // the flag should not exist; the seed row should go
  'owner-decision',         // examined, remedy argued, call handed to an owner
  'owner-decision-pending', // never examined — surfaced by a scanner fix, awaiting a first look
]);

const INERT_SEEDED_FLAGS = [
  // ── The four that matter: seeded AS KILL SWITCHES, read by nothing. ───────
  //
  // NOTE: push_notifications_enabled was here with disposition write-reader.
  // It has been wired: isFlagEnabled(db, 'push_notifications_enabled') is now
  // called in lib/pushWithRetry.ts (covers 29/31 call sites),
  // services/notifications/NotificationRouter.ts sendPush(), and
  // services/passport/StampAwardEngine.ts milestone push. The flag is now a
  // genuine admin kill switch for push delivery. Entry removed from this list.
  // NOTE: freeze_city / freeze_event / freeze_circle / freeze_booking were here,
  // all four with disposition `remove-from-seed`. That remedy is now complete
  // and their entries are removed, as rule R7 below requires — an inert
  // declaration must still be TRUE, and a flag that is no longer seeded by any
  // migration must not still be declared inert.
  //
  // Both halves shipped:
  //   * 4d5cc1f4e hid them from the admin surface (routes/admin.ts
  //     HIDDEN_INERT_FLAGS excludes them from GET /admin/feature-flags and
  //     returns 400 not_operational from PATCH), and from the public
  //     GET /api/feature-flags (routes/featureFlags.ts INERT_FLAGS);
  //   * the seed rows are removed from 0065_phase7_safety.sql, and
  //     0209_retire_freeze_flags.sql deletes them from existing databases.
  //
  // Those admin guards are deliberately KEPT rather than removed alongside the
  // rows: they are what makes the behaviour identical on a database where 0209
  // has not been applied yet, and the red-proof tests in 2c982aab8 assert
  // exactly that GET excludes the four and PATCH returns 400 not_operational.
  //
  // The parameterised-stop design these four belonged to (target in
  // feature_flags.metadata, read via getFlagRow, which still has zero callers)
  // remains unbuilt. Nothing here revives it; if per-target freezing is ever
  // wanted, it needs a reader first and a seed row second, in that order.

  // ── MEDIA_* suite: seeded wholesale by 2038, wired selectively. ──────────
  {
    flag: 'MEDIA_TAB_ENABLED', seededIn: '2038_media_admin_flags.sql:7', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_VIEW_MODE_FULLSCREEN_ENABLED', seededIn: '2038_media_admin_flags.sql:11', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded true and read by nothing: the admin list shows a value that gates no code path, and because it reads true an operator would reasonably conclude the surface is on. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_GRID_RANKING_ENABLED', seededIn: '2038_media_admin_flags.sql:25', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_GEMS_RANKING_ENABLED', seededIn: '2038_media_admin_flags.sql:27', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_UPLOAD_ENABLED', seededIn: '2038_media_admin_flags.sql:31', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_PROCESSING_PIPELINE_ENABLED', seededIn: '2038_media_admin_flags.sql:33', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_UPLOAD_VIDEO_ENABLED', seededIn: '2038_media_admin_flags.sql:35', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_UPLOAD_PHOTO_ENABLED', seededIn: '2038_media_admin_flags.sql:37', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_LIKES_ENABLED', seededIn: '2038_media_admin_flags.sql:41', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_SAVES_ENABLED', seededIn: '2038_media_admin_flags.sql:45', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_SHARES_ENABLED', seededIn: '2038_media_admin_flags.sql:47', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_GEMS_SUBMIT_ENABLED', seededIn: '2038_media_admin_flags.sql:51', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_GEMS_WRONG_PLACE_REPORT_ENABLED', seededIn: '2038_media_admin_flags.sql:53', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_GEMS_ADD_TO_TRIP_ENABLED', seededIn: '2038_media_admin_flags.sql:55', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_GEMS_DIRECTIONS_ENABLED', seededIn: '2038_media_admin_flags.sql:57', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_AI_PROVENANCE_LABELS_ENABLED', seededIn: '2038_media_admin_flags.sql:61', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },
  {
    flag: 'MEDIA_ADMIN_REVIEW_ENABLED', seededIn: '2038_media_admin_flags.sql:69', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Part of the MEDIA_* suite seeded by 2038 (its header at :1 reads "All MEDIA_* feature flags for the Media destination"). Sibling flags in the same INSERT ARE read (MEDIA_RANKING_ENABLED, MEDIA_VIEW_MODE_GRID_ENABLED, MEDIA_SHARING_ENABLED and others appear in CLASSIFIED above), so the suite was seeded wholesale and wired selectively. Seeded false and read by nothing: the admin list shows a value that gates no code path, and because it reads false an operator would reasonably conclude the surface is off. OWNER DECISION: wire the reader when the corresponding surface ships, or drop the row until it does. Low severity — CAPABILITY by convention, so the failure is an ungated feature, not a stop that fails to stop.',
  },

  // ── Not a boolean at all. ────────────────────────────────────────────────
  {
    flag: 'MEDIA_DEFAULT_VIEW_MODE', seededIn: '2038_media_admin_flags.sql:75', kind: 'CONFIG',
    disposition: 'owner-decision',
    reason:
      'Names a MODE, not a gate — the feature_flags row carries a boolean `enabled` column, so a flag whose meaning is "which view mode is default" cannot express its own value here and would need the metadata column, which has no reader (see freeze_* above). Seeded false and read by nothing. OWNER DECISION: move the default into config or metadata with a reader, or drop the row; as it stands it is a boolean standing in for an enum and cannot work whichever way it is toggled.',
  },

  // ── events_*: seeded TRUE, unread. The admin list agrees with reality ────
  // ── only by coincidence; it diverges the moment one is switched off. ─────
  {
    flag: 'events_invites_enabled', seededIn: '0080_events_extension.sql:422', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the event flag block in 0080 (:420-428) as "Event invite system". No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes. OWNER DECISION: wire the reader if the capability is meant to be switchable, or drop the row so the admin list stops offering a switch that does nothing.',
  },
  {
    flag: 'events_cohosts_enabled', seededIn: '0080_events_extension.sql:423', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the event flag block in 0080 (:420-428) as "Event co-host system". No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes. OWNER DECISION: wire the reader if the capability is meant to be switchable, or drop the row so the admin list stops offering a switch that does nothing.',
  },
  {
    flag: 'events_reports_enabled', seededIn: '0080_events_extension.sql:424', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the event flag block in 0080 (:420-428) as "Event reporting". No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes. OWNER DECISION: wire the reader if the capability is meant to be switchable, or drop the row so the admin list stops offering a switch that does nothing.',
  },
  {
    flag: 'events_reminders_enabled', seededIn: '0080_events_extension.sql:425', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the event flag block in 0080 (:420-428) as "Event reminders". No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes. OWNER DECISION: wire the reader if the capability is meant to be switchable, or drop the row so the admin list stops offering a switch that does nothing.',
  },
  {
    flag: 'events_share_links_enabled', seededIn: '0080_events_extension.sql:426', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the event flag block in 0080 (:420-428) as "Event shareable links". No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes. OWNER DECISION: wire the reader if the capability is meant to be switchable, or drop the row so the admin list stops offering a switch that does nothing.',
  },
  {
    flag: 'events_join_leave_enabled', seededIn: '0080_events_extension.sql:427', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the event flag block in 0080 (:420-428) as "Convenience join/leave shortcuts". No reader: the capability is unconditionally ON in code, and the flag records an intention rather than a gate. Because it is seeded TRUE the admin list agrees with observed behaviour today, which is exactly why this has gone unnoticed — the disagreement only appears the first time someone toggles it OFF during an incident and nothing changes. OWNER DECISION: wire the reader if the capability is meant to be switchable, or drop the row so the admin list stops offering a switch that does nothing.',
  },

  // ── Surfaced 2026-08-12 by fixing the seed-scanner's statement terminator. ─
  //
  // All four were seeded all along; the scan could not see them because a
  // semicolon inside a description truncated the statement that seeds them. They
  // are NOT new flags and nothing about them changed — only the check's ability
  // to ask about them. Each was then read in context by the census
  // (docs/ops/flag-disposition.md), which is why these carry `remove-from-seed`
  // rather than `owner-decision-pending`: they were examined on discovery.

  // ── location_phase*: the oldest rows in the table, from 0037. ────────────

  // ── Individually-seeded flags with no reader. ────────────────────────────
  {
    flag: 'COMPASS_DIVERSITY_ENABLED', seededIn: '0053_compass_feed_intelligence.sql:198', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by 0053. Reachable ONLY through compass/flags.ts, whose loader filters .like("flag","COMPASS_%") and so would find it — but no call site asks for it. Note the trap recorded in the fact layer at 6.1: through that loader an unseeded flag and a deliberately-off flag are indistinguishable, and so is an unasked one. OWNER DECISION: wire it to the diversity re-ranking it names, or drop the row.',
  },
  {
    flag: 'COMPASS_FAIR_EXPOSURE_ENABLED', seededIn: '0053_compass_feed_intelligence.sql:199', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by 0053, no reader. Same COMPASS_% loader situation as COMPASS_DIVERSITY_ENABLED. OWNER DECISION: wire or drop.',
  },
  {
    flag: 'COMPASS_ACTIVE_REWARDS_ENABLED', seededIn: '0053_compass_feed_intelligence.sql:200', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by 0053, no reader. Same COMPASS_% loader situation. OWNER DECISION: wire or drop.',
  },
  {
    flag: 'compass_ai_enabled', seededIn: '0117_beta_feature_flags.sql:27', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded true by the beta flag block. Lower-case, so it is NOT reachable through the COMPASS_% loader either (compass/flags.ts filters on the upper-case prefix) — it could only ever be read through isFlagEnabled, and nothing does. OWNER DECISION: wire or drop.',
  },
  {
    flag: 'ai_event_auto_suggest_enabled', seededIn: '0194_generated_visuals.sql:89', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded false alongside the generated-visuals flags that ARE read (ai_visual_provider_enabled, ai_event_headers_enabled, ai_place_headers_enabled all appear in CLASSIFIED). Auto-suggest was seeded and not built. OWNER DECISION: wire when the feature ships, or drop.',
  },
  {
    flag: 'ai_visual_regeneration_enabled', seededIn: '0194_generated_visuals.sql:92', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded false by 0194, no reader. Admin regeneration exists in routes/adminVisuals.ts but gates on ai_visual_admin_review_enabled instead, so this row is a duplicate intention that was never wired. OWNER DECISION: most likely remove-from-seed; confirm the admin path is the intended gate.',
  },
  {
    flag: 'passport_contribution_enabled', seededIn: '0037_feature_flags.sql:25', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded false by 0037, no reader. The passport surfaces that DID ship read passport_stamps_enabled and passport_memories_enabled, both of which are in the read inventory. OWNER DECISION: wire or drop.',
  },
  {
    flag: 'plan_geofence_full_enabled', seededIn: '0037_feature_flags.sql:30', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded false by 0037. Its sibling plan_geofence_enabled IS read (routes/geofence.ts:65, a direct read declared in DIRECT_READS). This is the second-stage flag of a two-stage rollout whose second stage was never wired. OWNER DECISION: wire the full-geofence branch or drop the row.',
  },
  {
    flag: 'stamp_admin_award_enabled', seededIn: '0081_stamp_system_v2.sql:252', kind: 'CAPABILITY',
    disposition: 'owner-decision',
    reason:
      'Seeded false by the stamp system v2 migration, no reader. Manual admin award exists in the admin stamp routes but is gated by requireAdmin rather than by this flag. OWNER DECISION: most likely remove-from-seed, since the authorization check is the real gate.',
  },


  // The ten flags discovered here on 2026-08-12 by fixing the seed scanner have
  // been RETIRED, not resolved into entries. Their wire-or-drop pass required a
  // live read — a branch consulting the flag and changing behaviour — and none
  // of the ten had one, so all ten were dropped by
  // src/migrations/2080_retire_inert_seeded_flags.sql with their seeds
  // neutralised in 0051/0062 (and the second-tree migrations/0041).
  //
  // Rule R7 below is what removed these entries rather than a judgement call: an
  // inert declaration must still be TRUE, and a flag no longer seeded by any
  // migration fails STALE INERT ENTRY. The disposition value
  // `owner-decision-pending` is deliberately left in DISPOSITIONS with nothing
  // using it — it is the vocabulary for the next time a scanner fix surfaces a
  // flag nobody has examined, and removing it would mean re-deciding what that
  // state is called under time pressure.
];

// ─────────────────────────────────────────────────────────────────────────────
// SHADOW_READERS — files defining their own function named like a shared helper.
//
// These are the reason a call-site-pattern check cannot work. Each needs its
// ACTUAL polarity recorded, because they do not agree with the shared helper or
// with each other.
// ─────────────────────────────────────────────────────────────────────────────
const SHADOW_READERS = [
  // routes/airport.ts had the one shadow that FAILED OPEN — `if (error) return
  // true; if (data == null) return true;`, the exact inverse of the shared
  // helper under the same name, feeding every gate in that router. It was
  // deleted (not corrected in place) in favour of importing the shared helper,
  // so there is no longer a shadow there to declare. Red-proofed by
  // src/test/airportFlagPolarity.test.ts, which drives the real routes with a
  // no-row and an erroring feature_flags table and asserts they stay closed.
  {
    file: 'routes/passportStamps.ts',
    fn: 'isFlagEnabled',
    reason:
      'Shadow, single-argument (takes the flag name only, resolves its own client). Fails CLOSED — `if (error) ' +
      'return false` — matching the shared helper; its own comment records that it previously failed open and ' +
      'was corrected in FL-05. Verified by hand at c89f09a77: reads only passport_* CAPABILITY flags.',
  },
  {
    file: 'routes/hiddenGems.ts',
    fn: 'isFlagEnabled',
    reason:
      'Shadow. Destructures `data` only, never `error`; try/catch returns false. Fails closed on a thrown ' +
      'query but treats a returned error object as "no row" → false, which lands in the same place. Verified ' +
      'by hand at c89f09a77: reads only hidden_gems_* / local_guides_enabled CAPABILITY flags.',
  },
  {
    file: 'routes/safeReturn.ts',
    fn: 'isFlagEnabled',
    reason:
      'Shadow. `if (!db) return false`, try/catch returns false. Fails closed. Verified by hand at c89f09a77: ' +
      'reads only safe_return_* CAPABILITY flags.',
  },
  {
    file: 'lib/safeReturnScheduler.ts',
    fn: 'isFlagEnabled',
    reason:
      'Shadow. Destructures `data` only; `(data as any)?.enabled === true`, catch returns false. Fails closed. ' +
      'Verified by hand at c89f09a77: reads only safe_return_* CAPABILITY flags.',
  },
  {
    file: 'lib/accountDeletionScheduler.ts',
    fn: 'isFlagEnabled',
    reason:
      'Shadow. Reads the module-level FEATURE_FLAG const (account_deletion_worker_enabled), a CAPABILITY. ' +
      'Verified by hand at c89f09a77. Named in the Phase 0 report as the shadow that a call-site-pattern ' +
      'check would have scored as the shared helper.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// UNRESOLVABLE — flag arguments that are not string literals.
//
// These FAIL unless listed. A computed flag name is a hole in the inventory:
// the check cannot tell whether the name that arrives at runtime is a stop.
// ─────────────────────────────────────────────────────────────────────────────
const UNRESOLVABLE = [
  {
    file: 'lib/visuals/service.ts',
    expr: 'purposeFlag(req.purpose)',
    covers: ['ai_event_headers_enabled', 'ai_place_headers_enabled', 'ai_trip_covers_enabled'],
    reason:
      'Computed from a request field via purposeFlag() (lib/visuals/service.ts:95-100). Listed rather than ' +
      'resolved because the check does not do interprocedural constant folding and must not pretend to. ' +
      'CORRECTED 2026-08-10: this entry previously claimed the function returns "one of ' +
      'ai_event_headers_enabled / ai_place_headers_enabled". It returns THREE — :99 returns ' +
      'ai_trip_covers_enabled for purpose "trip_cover". The omission was caught by the seeded-flag ' +
      'population, which reported ai_trip_covers_enabled as seeded-but-never-read; it is read, through here. ' +
      'That is the argument for `covers` being a machine-checked list rather than prose.',
  },
  {
    file: 'routes/mediaFeed.ts',
    expr: 'flagName',
    covers: ['MEDIA_FOLLOWING_ENABLED', 'MEDIA_FOR_YOU_ENABLED'],
    reason:
      'Loop variable over a local map of MEDIA_* capability flags, every one of which is separately present in ' +
      'CLASSIFIED from its literal call sites elsewhere in the same file. Verified by hand at c89f09a77.',
  },
  {
    file: 'lib/places/recaps.ts',
    expr: 'kind === "place" ? "place_recaps_enabled" : "moment_recaps_enabled"',
    covers: ['place_recaps_enabled', 'moment_recaps_enabled'],
    reason:
      'Ternary selecting between two literals. Both are *_enabled CAPABILITY by convention and both appear ' +
      'in LIVE_PLACES_REQUIREMENTS in lib/featureFlags.ts. Declared rather than folded because the check does ' +
      'not evaluate expressions, and a check that starts guessing at expressions will eventually guess wrong ' +
      'about a stop. Verified by hand at c89f09a77.',
  },
  {
    file: 'routes/tripReadiness.ts',
    expr: 'READINESS_FLAG',
    covers: ['trip_readiness_enabled'],
    reason:
      'Imported const from lib/tripReadiness.ts (trip_readiness_enabled), CAPABILITY by convention. The check ' +
      'resolves consts only within a single file and does not follow imports. Verified by hand at c89f09a77.',
  },
  {
    file: 'routes/entryRequirements.ts',
    expr: 'ENTRY_FLAG',
    covers: ['passport_entry_intelligence_enabled'],
    reason:
      'Imported const from lib/entryRequirements.ts (passport_entry_intelligence_enabled), CAPABILITY by ' +
      'convention. The check resolves consts only within a single file and does not follow imports, so this ' +
      'is declared rather than silently resolved. Verified by hand at c89f09a77.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// DIRECT_READS — every `.from("feature_flags")` outside the shared helper.
//
// The recorded human judgment. Key is `file::flag` for reads with a resolvable
// literal name, or `file::<shape>` for the ones where no name is resolvable.
// Reasons state what the read ACTUALLY does on failure, including when that is
// fail-open — a false "verified fail-closed" would be worse than no entry.
// ─────────────────────────────────────────────────────────────────────────────
const V = 'verified by hand at c89f09a77';
const DIRECT_READS = [
  // ── Reads whose failure direction is genuinely fail-closed ───────────────
  { file: 'compass/CompassFallbackFeedBuilder.ts', flag: 'COMPASS_FALLBACK_MODE_ENABLED', reason: `Read directly, error branch ${V}: try/catch → false. Fail-closed.` },
  { file: 'lib/creatorActivityScoreScheduler.ts',  flag: 'ACTIVITY_DISCOVERY_BOOST_ENABLED', reason: `Read directly, error branch ${V}: catch → false, with an inline comment stating the job is skipped rather than run on a degraded connection. Fail-closed.` },
  { file: 'lib/fsq/fsqPlaces.ts',                  flag: 'fsq_places_enabled',            reason: `Read directly, error branch ${V}: checks \`error\` → false AND catch → false. Fail-closed.` },
  { file: 'lib/stamps/criteria/index.ts',          flag: 'stamp_criteria_engine_enabled', reason: `Read directly, error branch ${V}: checks \`error\` → false AND catch → false. Fail-closed.` },
  { file: 'lib/stamps/generationWorker.ts',        flag: 'stamp_auto_approve_artwork',    reason: `Read directly, error branch ${V}: checks \`error\` → false, so a failed read routes artwork to human review. Fail-closed.` },
  { file: 'lib/stamps/generationWorker.ts',        flag: 'stamp_premium_rendering_enabled', reason: `Read directly, error branch ${V}: checks \`error\` → false, legacy render path runs. Fail-closed.` },
  { file: 'routes/admin.ts',                       flag: 'safe_return_admin_logs_enabled', reason: `Read directly, error branch ${V}: catch → false, admin route denied. Fail-closed.` },
  { file: 'routes/geofence.ts',                    flag: 'plan_geofence_enabled',         reason: `Read directly, error branch ${V}: \`if (!db) return false\`, catch → false. Fail-closed.` },
  { file: 'routes/stamps.ts',                      flag: 'stamp_system_v2_enabled',       reason: `Read directly, error branch ${V}: catch returns 503 feature_not_available, same as the disabled path. Fail-closed.` },
  { file: 'services/passport/UnifiedStampService.ts', flag: 'stamp_unified_view_enabled', reason: `Read directly, error branch ${V}: checks \`error\` → false, legacy counts stay authoritative. Fail-closed.` },
  { file: 'services/trust/TrustEventService.ts',   flag: 'trust_engine_enabled',          reason: `Read directly, error branch ${V}: catch → false. Fail-closed.` },
  { file: 'services/trust/TrustGamingDetectionService.ts', flag: 'trust_gaming_detection_enabled', reason: `Read directly, error branch ${V}: no try/catch, but checks \`error\` explicitly, logs, and returns false. Fail-closed against a returned error; an outright throw propagates to the caller.` },

  // ── Fail-closed, but by a variable INITIALIZED OUTSIDE THE TRY, which is ──
  // ── the shape that makes static verification infeasible ───────────────────
  { file: 'routes/compass.ts',   flag: 'COMPASS_FEED_ENABLED', reason: `Read directly, error branch ${V}: the catch ONLY LOGS. Fail-closed comes from \`let feedEnabled = false\` declared before the try — the empty feed is returned. Correct, and precisely the shape no static rule can confirm.` },
  { file: 'routes/telegraph.ts', flag: 'compass_location_context_enabled', reason: `Read directly, error branch ${V}: catch is \`/* non-fatal */\`. Fail-closed comes from \`compassCtx\` initialized null before the try — degrades to no location context.` },
  { file: 'services/hiddenGems/CompassHiddenGemService.ts', flag: 'hidden_gems_compass_enabled', reason: `Read directly, error branch ${V}: fail-closed via the \`empty\` context object built before the try.` },
  { file: 'services/location/CompassLocationContext.ts',    flag: 'hidden_gems_compass_enabled', reason: `Read directly, error branch ${V}: fail-closed via \`hiddenGems\` initialized to [] before the try.` },

  // ── Fire-and-forget background tasks. A failed read means the side effect ─
  // ── silently does not happen. Safe here (no stamp / no memory is not an ───
  // ── exposure) but caller-dependent, hence recorded per site. ──────────────
  { file: 'routes/airport.ts',    flag: 'passport_stamps_enabled',   reason: `Read directly inside a \`void (async () => ...)\` block, ${V}: a failed read means no layover stamp is emitted. Fail-closed in the sense that matters — nothing is exposed.` },
  { file: 'routes/geofence.ts',   flag: 'passport_stamps_enabled',   reason: `Read directly inside a fire-and-forget block, ${V}: failure means no check-in stamp. Fail-closed.` },
  { file: 'routes/geofence.ts',   flag: 'passport_memories_enabled', reason: `Read directly inside a fire-and-forget block, ${V}: failure means no suggested memory. Fail-closed.` },
  { file: 'routes/hiddenGems.ts', flag: 'hidden_gems_passport_enabled', reason: `Read directly inside a fire-and-forget block, ${V}: failure means no gem-visit stamp. Fail-closed.` },
  { file: 'routes/hiddenGems.ts', flag: 'passport_memories_enabled', reason: `Read directly inside a fire-and-forget block, ${V}: failure means no suggested memory. Fail-closed.` },
  { file: 'routes/hiddenGems.ts', flag: 'hidden_gems_pulse_enabled', reason: `Read directly inside a fire-and-forget block, ${V}: failure means no Pulse post. Fail-closed.` },
  { file: 'routes/location.ts',   flag: 'passport_stamps_enabled',   reason: `Read directly inside a fire-and-forget block, ${V}: failure means no city stamp. Fail-closed.` },
  { file: 'routes/location.ts',   flag: 'passport_memories_enabled', reason: `Read directly inside a fire-and-forget block, ${V}: failure means no suggested memory. Fail-closed.` },
  { file: 'routes/safeReturn.ts', flag: 'passport_stamps_enabled',   reason: `Read directly inside a fire-and-forget block, ${V}: failure means no Safe Return stamp. Fail-closed.` },
  { file: 'routes/safeReturn.ts', flag: 'passport_memories_enabled', reason: `Read directly inside a fire-and-forget block, ${V}: failure means no suggested memory. Fail-closed.` },

  // ── NOT fail-closed. Recorded truthfully rather than papered over. ────────
  {
    file: 'compass/CompassSearchDecayService.ts', flag: 'SEARCH_SIGNAL_DECAY_DAYS',
    reason:
      `Read directly, error branch ${V}: FAILS OPEN — a missing row returns \`{ enabled: true, halfLifeDays: ` +
      `DEFAULT_DECAY_DAYS }\`. Deliberate and harmless: this is a CONFIG row, not a gate, and the fallback is ` +
      `the compiled-in default. Recorded as fail-open because writing "fail-closed" here would be false.`,
  },
  {
    file: 'lib/rankLog.ts', flag: 'CREATOR_FATIGUE_ENABLED',
    reason:
      `Read directly, error branch ${V}: the catch KEEPS A PREVIOUSLY CACHED VALUE (60s TTL), so the failure ` +
      `direction depends on runtime cache state and is not a static property at all. Benign — worst case is a ` +
      `stale ranking-damping flag for one TTL. This site is the clearest single argument for why the ` +
      `"error branch is fail-closed" clause had to become a recorded judgment.`,
  },
  {
    file: 'routes/pulse.ts', flag: 'COMPASS_ENABLED',
    reason:
      `Read directly, error branch ${V}: THERE IS NO ERROR BRANCH FOR THIS READ. It sits inside a ~40-line try ` +
      `shared with a dozen unrelated operations and \`error\` is never destructured; a falsy \`.data?.enabled\` ` +
      `skips the Compass section. Effectively fail-closed, established by the absence of a branch rather than ` +
      `the presence of one.`,
  },
  {
    file: 'routes/rentABuddy.ts', flag: 'rent_buddy_enabled',
    reason:
      `Read directly, error branch ${V}: NO try/catch and no \`error\` destructuring. A rejected query throws ` +
      `past checkRentBuddyEnabled to the route handler, surfacing as a 500 rather than a flag decision — which ` +
      `denies the request, so the effective direction is closed, but by exception propagation, not by a branch.`,
  },
  {
    file: 'services/passport/StampAwardEngine.ts', flag: 'stamp_system_v2_enabled',
    reason: `Read directly, error branch ${V}: catch → \`{ awarded: false, reason: "feature_disabled" }\`. Fail-closed, and documented as such in situ.`,
  },
  {
    file: 'services/passport/StampAwardEngine.ts', flag: 'passport_stamps_enabled',
    reason:
      `Read directly, error branch ${V}: FAILS OPEN — catch lets the award proceed, and the test is the ` +
      `three-state \`flagRow !== null && enabled === false\`, so only an EXPLICIT false row suppresses awards. ` +
      `Deliberate (documented in situ: stamps work out-of-box before migrations). Note this function contains ` +
      `BOTH this read and the fail-closed one above — opposite polarities, eighteen lines apart, same file.`,
  },

  // ── Bulk reads: no resolvable flag name at all ────────────────────────────
  { file: 'compass/flags.ts',                        shape: 'bulk', reason: `Wildcard \`.like("flag", "COMPASS_%")\` — no flag-name literal exists to inventory. ${V}: catch → {}, all Compass flags read as undefined/falsy. Fail-closed.` },
  { file: 'compass/CompassPipeline.ts',              shape: 'bulk', reason: `Wildcard \`.like("flag", "COMPASS_%")\`. ${V}: catch → {} with a warning log, degrading to all-defaults. Fail-closed.` },
  { file: 'compass/CompassFrontLoadEngine.ts',       shape: 'bulk', reason: `Wildcard \`.like("flag", "COMPASS_%")\`. ${V}: catch is non-fatal and \`flags\` stays {} from its initializer. Fail-closed.` },
  { file: 'services/ranking/DiscoveryRankingService.ts', shape: 'bulk', reason: `\`.in("flag", [...])\` over five SCREAMING_CASE ranking boosts, each individually present in CLASSIFIED. ${V}: catch → {}, boosts off. Fail-closed.` },
  { file: 'services/ranking/MediaFeedRankingService.ts', shape: 'bulk', reason: `\`.in("flag", [...])\` over eight SCREAMING_CASE media ranking flags, each individually present in CLASSIFIED. ${V}: a \`defaults\` object of all-false is returned on failure. Fail-closed.` },
  { file: 'routes/adminRankingConfig.ts',            shape: 'bulk', reason: `Admin listing of ranking flags for display. ${V}: not a gate.` },
  { file: 'routes/adminRankingMetrics.ts',           shape: 'bulk', reason: `\`.in("flag", ["RANKING_EXPERIMENT_ENABLED"])\` for an admin metrics panel. ${V}: not a gate — display only.` },

  // ── Management surface: administers flags rather than gating on them ──────
  { file: 'routes/featureFlags.ts',       shape: 'management', reason: `THE ADMIN READ SURFACE: selects flag/enabled/description for the admin UI. Not a gate — it reports flag state, it does not act on it. Errors surface as db_error. ${V}.` },
  { file: 'routes/admin.ts',              shape: 'management', reason: `Admin dashboard listing all flags for display (select flag/enabled/description/updated_at, no filter). Not a gate — it reports flag state. ${V}.` },
  { file: 'routes/adminCompass.ts',       shape: 'management', reason: `Admin upsert of Compass flags by variable. A write. ${V}.` },
  { file: 'routes/circle.ts',             shape: 'management', reason: `POST /admin/circle/kill-switch — the OPERATOR'S CONTROL SURFACE for find_your_circle_disabled. It upserts the stop; it does not read it to gate. Fails LOUDLY (db_error) on write failure, which is correct: an operator flipping a stop must learn if it did not take. ${V}.` },
  { file: 'routes/rentABuddyRollout.ts',  shape: 'var',
    covers: [
      'RENT_BUDDY_MVP_MODE',
      // Added 2026-08-12. These six were ALWAYS read through this same helper —
      // getFlag(sc, "<literal>") at :171, :245, :258, :271, :304 and :410, each
      // gating a 403 — but they were never listed here because the seed scanner
      // could not see them being seeded (0090:197-203, behind a semicolon in a
      // description) and so R6 never asked. Fixing the matcher surfaced them as
      // "seeded but never read", which was wrong in the informative direction:
      // they are read, by a helper this check cannot follow, which is exactly
      // what a `covers` list is for.
      'RENT_BUDDY_ADMIN_ONLY_MODE',       // :171  admin-only rollout gate
      'RENT_BUDDY_BETA_ONLY_MODE',        // :410  beta-only rollout gate
      'RENT_BUDDY_GROUP_BOOKINGS_ENABLED',// :245  403 group_bookings_unavailable
      'RENT_BUDDY_PACKAGES_ENABLED',      // :258  403 packages_unavailable
      'RENT_BUDDY_OFFERS_ENABLED',        // :271  403 offers_unavailable
      'RENT_BUDDY_NIGHTLIFE_ENABLED',     // :304  403 when off
    ],
    reason: `Local getFlag(sc, flag) helper reading rollout flags by parameter. ${V}: no try/catch, \`!!data?.enabled\`; reads only rent_buddy_* CAPABILITY flags from admin rollout routes. Every name in \`covers\` was verified at its call site by the 2026-08-12 census (docs/ops/flag-disposition.md), which read each one in context rather than trusting the string match.` },
  { file: 'routes/notifications.ts',     shape: 'var', reason: `Admin update of notification flags by loop variable (\`.update({enabled}).eq("flag", flagName)\`). A write, not a gate. ${V}.` },
  { file: 'routes/admin.ts',             shape: 'var', reason: `Admin bulk toggle: \`.update({enabled}).eq("flag", key)\` over a submitted map. A write, not a gate. ${V}.` },
  { file: 'routes/adminRankingConfig.ts', shape: 'var', reason: `Admin read-then-update of one ranking flag by variable; the update's error is checked and surfaced as db_error. A write. ${V}.` },
  {
    file: 'compass/CompassNotificationEngine.ts', shape: 'var',
    reason:
      `Flag name built by CONCATENATION from a runtime category — \`COMPASS_\${category}_SAFETY_BLOCK\` — so ` +
      `the inventory CANNOT enumerate the names this reads. Note the _SAFETY_BLOCK suffix: this is ` +
      `restriction-shaped and would be a STOP candidate if the names were visible. ${V}: catch → false, i.e. ` +
      `not blocked. FLAGGED FOR REVIEW: if these ever become genuine safety stops, false-on-error is the wrong ` +
      `default, and the names must be made literal so this check can see them at all.`,
  },

  // ── One-shot scripts. Operator-run tooling, not the serving path. ─────────
  { file: 'scripts/backfill-media-assets.ts',      flag: 'media_canonical_enabled',      reason: `One-shot backfill script preflight. ${V}: a falsy read aborts the backfill with an explanatory message. Fail-closed.` },
  { file: 'scripts/backfill-canonical-places.ts',  flag: 'external_places_enabled',      reason: `One-shot backfill script preflight. ${V}: a falsy read aborts the backfill. Fail-closed.` },
  { file: 'scripts/check-media-bucket-privacy.ts', flag: 'media_private_buckets_enabled', reason: `Read-only audit script preflight. ${V}: reports rather than acts.` },
  { file: 'scripts/set-media-buckets-private.ts',  flag: 'media_private_buckets_enabled', reason: `Bucket-privacy migration script preflight; refuses to run unless the flag is on or --force is passed. ${V}. Fail-closed.` },
  { file: 'scripts/stamp-smoke-check.ts',          flag: 'stamp_system_v2_enabled',      reason: `Smoke-check script. ${V}: an \`error\` fails the smoke check loudly. Fail-closed.` },
  { file: 'scripts/seed-demo-buddies.ts',          shape: 'management', reason: `Demo seeder upserting a rollout flag. A write, in throwaway seed tooling. ${V}.` },
];

// ─────────────────────────────────────────────────────────────────────────────
// APP_TREE_READS — seeded flags whose only reader is in the MOBILE APP tree.
//
// This check walks api-server/src (SRC, above) and nothing else. That is the
// right scope for everything else it does, but it leaves rule R6 — "every seeded
// flag is either read or declared inert" — unable to tell two very different
// situations apart:
//
//   (a) a flag nothing reads, anywhere; and
//   (b) a flag read by the mobile app, which fetches GET /api/feature-flags and
//       branches on the value client-side.
//
// Before this list there was no honest way to record (b). INERT_SEEDED_FLAGS
// asserts a flag is unread, which would be FALSE here and would park a live gate
// on a "wire or drop" list forever. An UNRESOLVABLE or DIRECT_READS `covers`
// entry is equally untrue: those are keyed to an api-server file and expression,
// and no such file exists for an app-tree read.
//
// The declaration is MACHINE-CHECKED, not trusted: rule R8 below opens the named
// app file and fails if the flag literal is not in it. If the read is deleted or
// the component moves, this check fails rather than continuing to vouch for a
// reader that is gone — the same argument the UNRESOLVABLE `covers` arrays make
// for being lists rather than prose.
//
// WHAT THIS LIST DOES NOT DO
// ==========================
//
// It does not verify the failure direction, because it cannot see the call
// site's error handling from here. An app-read flag is fail-closed by the shape
// of the transport — FeatureFlagsContext defaults a missing or unfetched flag to
// falsy — not by anything this list checks.
// ─────────────────────────────────────────────────────────────────────────────

// WHICH app tree. This matters more than it looks.
//
// There used to be two copies of the mobile app in this repository:
//
//   artifacts/travel-buddy    — FROZEN LEGACY. Not built, not shipped.
//                               ARCHIVED; the tree no longer exists on disk.
//   travel-buddy-standalone   — THE LIVE TREE. What actually ships, and where
//                               the readers this list vouches for actually live.
//
// This resolved to `artifacts/travel-buddy` until 2026-08-13 (owner ruling #7).
// The two trees hold byte-identical copies of MediaQuickCreateSheet.tsx, so R8
// passed either way and the mistake was invisible — but it made the check
// worthless in the one case it exists for: delete the live reader and R8 would
// keep vouching for it on the strength of the frozen copy, exempting the flag
// from R6 for a reader that no longer ships. Verified before correcting:
// hiding travel-buddy-standalone's copy left the guard at 0 problems; hiding
// artifacts/travel-buddy's copy is what produced a failure.
//
// It also had a shelf life, and the shelf life expired: artifacts/travel-buddy
// was archived on 2026-08-14. Had this still pointed there, R8 would now fail
// with CANNOT VERIFY against a tree that had been deliberately removed — and
// the tempting fix at that moment is to delete the entries, which the message
// above expressly warns against. Correcting it a day early is why the archival
// did not have to touch this file's behaviour at all.
const APP_TREE_ROOT = resolve(PKG_ROOT, '..', '..', 'travel-buddy-standalone');

const APP_TREE_READS = [
  {
    flag: 'MEDIA_HIDDEN_GEMS_CREATE_ENABLED',
    file: 'src/components/media/MediaQuickCreateSheet.tsx',
    line: 128,
    reason:
      "isEnabled('MEDIA_HIDDEN_GEMS_CREATE_ENABLED') from the app's FeatureFlagsContext gates whether the " +
      'Add-a-Gem entry appears in the Media tab quick-create sheet. Entered this list on 2026-08-12 when ' +
      '2084_codify_live_read_flags.sql codified the flag: it was live-but-unseeded before, so R6 never asked ' +
      'about it, and seeding it is what makes the question arise. This flag is the precedent the whole ' +
      'reconciliation rests on — it lived ONLY in production, so a restored environment got no row, read false ' +
      'through the fail-closed helper, and the entry point was permanently invisible, which was mistaken for a ' +
      'deliberate design choice rather than a missing row.',
  },
  // city_launch_mode had an entry here from 2026-08-12 until 2026-08-13: an
  // app-tree read whose banner was its ONLY reader, recorded as
  // KEEP-with-a-defect pending an owner decision. The owner ruled (ruling #4):
  // a banner-only kill switch with no server-side enforcement is misleading
  // operational machinery. 2087_retire_city_launch_mode.sql retired the row,
  // the seed left 0117, and the app-tree reader was removed in the same
  // commit — so there is no read left for this list to declare.
];

// ─────────────────────────────────────────────────────────────────────────────
// SCAN
// ─────────────────────────────────────────────────────────────────────────────

const problems = [];
const fail = (msg) => problems.push(msg);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|mjs)$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const allFiles = walk(SRC);
const testFiles = allFiles.filter((f) => isTestPath(relative(SRC, f)));
const scanFiles = allFiles.filter((f) => !isTestPath(relative(SRC, f)));

// VACUITY: the scan must actually have a subject.
if (allFiles.length === 0) fail(`VACUOUS: no source files found under ${SRC}. The scan has no subject.`);
if (scanFiles.length === 0) fail('VACUOUS: every discovered file was excluded as a test. The scan has no subject.');
if (testFiles.length === 0) fail('VACUOUS: the test-file exclusion matched nothing. Either the test corpus moved or isTestPath is broken — either way the exclusion is no longer the declared one.');

const STRING_ARG = /^(['"`])([^'"`]*)\1$/;
const CONST_DECL = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(['"`])([^'"`\n]+)\2/g;

/**
 * Blank out comments, preserving offsets and newlines so every reported line
 * number still points at the real line.
 *
 * This is not cosmetic. Without it, a DOC COMMENT that mentions `isFlagEnabled()`
 * — lib/rentBuddyKycGate.ts has one explaining why it uses that helper — is
 * scanned as a call site with an unresolvable argument, and the check reports a
 * problem in prose. A check that cannot tell code from commentary about code
 * will be ignored, and an ignored check enforces nothing.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // inside a string literal — copy verbatim, honouring escapes
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) state = 'code';
    out += c; i++; continue;
  }
  return out;
}

/**
 * Slice from a `.from("feature_flags")` match to the end of its statement, so a
 * chained `.in("flag", [ ...eight names over ten lines... ])` is read whole.
 *
 * A fixed line window silently truncated those arrays, which did not fail —
 * it made eight ranking flags VANISH from the inventory and then reported their
 * CLASSIFIED entries as stale. Under-reading looks exactly like cleanliness,
 * which is the failure mode this whole file is built against.
 */
function statementFrom(src, start) {
  let depth = 0;
  for (let i = start; i < src.length && i < start + 2000; i++) {
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if ((c === ';' || c === ',') && depth <= 0) return src.slice(start, i);
  }
  return src.slice(start, start + 2000);
}

/** Every observed use of a flag name: {flag, reader, file, line}. */
const uses = [];
/** Every direct read: {file, line, flag|null, shape}. */
const reads = [];
/** Shadow helper definitions actually found: Set of `file::fn`. */
const shadowsFound = new Set();
/** Unresolvable arguments actually found: [{file, expr, line}]. */
const unresolvedFound = [];

for (const abs of scanFiles) {
  const rel = relative(SRC, abs).split('\\').join('/');
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    fail(`UNPARSEABLE: could not read ${rel}: ${e.message}`);
    continue;
  }
  const src = stripComments(raw);
  const lineAt = (idx) => src.slice(0, idx).split('\n').length;

  // Local single-file const resolution. Deliberately NOT interprocedural and
  // NOT cross-module — anything it cannot resolve becomes an UNRESOLVABLE that
  // must be declared, rather than a guess.
  const consts = new Map();
  for (const m of src.matchAll(CONST_DECL)) consts.set(m[1], m[3]);

  // Shadow helper definitions.
  for (const fn of [STOP_READER, ...CAP_READERS]) {
    const defRe = new RegExp(`(?:async\\s+function|function|const)\\s+${fn}\\b`, 'g');
    if (SHARED_HELPER_FILES.has(rel)) continue;
    if (defRe.test(src)) shadowsFound.add(`${rel}::${fn}`);
  }
  const shadowedHere = new Set(
    [...shadowsFound].filter((k) => k.startsWith(`${rel}::`)).map((k) => k.split('::')[1]),
  );

  // Helper call sites.
  if (rel !== SHARED_HELPER_FILE) {
    for (const fn of [STOP_READER, ...CAP_READERS]) {
      const callRe = new RegExp(`\\b${fn}\\s*\\(`, 'g');
      let m;
      while ((m = callRe.exec(src)) !== null) {
        const open = m.index + m[0].length;
        // Skip the definition itself.
        const before = src.slice(Math.max(0, m.index - 30), m.index);
        if (/(?:async\s+function|function|const)\s+$/.test(before)) continue;
        let depth = 1;
        let i = open;
        while (i < src.length && depth > 0) {
          const c = src[i];
          if (c === '(') depth++;
          else if (c === ')') depth--;
          i++;
        }
        if (depth !== 0) {
          fail(`UNPARSEABLE: unbalanced parentheses in a ${fn}(...) call at ${rel}:${lineAt(m.index)}.`);
          continue;
        }
        const argSrc = src.slice(open, i - 1);
        // Split on top-level commas only.
        const args = [];
        let d = 0, cur = '';
        for (const ch of argSrc) {
          if ('([{'.includes(ch)) d++;
          else if (')]}'.includes(ch)) d--;
          if (ch === ',' && d === 0) { args.push(cur); cur = ''; } else cur += ch;
        }
        args.push(cur);
        const raw = (args[1] ?? '').trim();
        const line = lineAt(m.index);
        const reader = shadowedHere.has(fn) ? `${fn}@shadow` : fn;

        const lit = raw.match(STRING_ARG);
        if (lit && lit[2]) {
          uses.push({ flag: lit[2], reader, file: rel, line });
        } else if (consts.has(raw)) {
          uses.push({ flag: consts.get(raw), reader, file: rel, line });
        } else if (raw === '') {
          // Single-argument shadow (e.g. passportStamps' isFlagEnabled(flag)).
          const only = (args[0] ?? '').trim();
          const oLit = only.match(STRING_ARG);
          if (oLit && oLit[2]) uses.push({ flag: oLit[2], reader, file: rel, line });
          else if (consts.has(only)) uses.push({ flag: consts.get(only), reader, file: rel, line });
          else unresolvedFound.push({ file: rel, expr: only || '(empty)', line, reader });
        } else {
          unresolvedFound.push({ file: rel, expr: raw, line, reader });
        }
      }
    }
  }

  // Direct reads of the table.
  if (rel !== SHARED_HELPER_FILE) {
    for (const m of src.matchAll(/\.from\(\s*["'`]feature_flags["'`]\s*\)/g)) {
      const line = lineAt(m.index);
      const stmt = statementFrom(src, m.index);
      const eqLit = stmt.match(/\.eq\(\s*["'`]flag["'`]\s*,\s*(['"`])([^'"`]+)\1\s*\)/);
      const eqVar = stmt.match(/\.eq\(\s*["'`]flag["'`]\s*,\s*([A-Za-z_$][\w$.]*)\s*\)/);
      const inLit = stmt.match(/\.in\(\s*["'`]flag["'`]\s*,\s*\[([\s\S]*?)\]/);
      const wild = /\.(like|ilike)\(\s*["'`]flag["'`]/.test(stmt);

      if (eqLit) {
        reads.push({ file: rel, line, flag: eqLit[2], shape: 'gate' });
        uses.push({ flag: eqLit[2], reader: 'direct', file: rel, line });
      } else if (eqVar && consts.has(eqVar[1])) {
        reads.push({ file: rel, line, flag: consts.get(eqVar[1]), shape: 'gate' });
        uses.push({ flag: consts.get(eqVar[1]), reader: 'direct', file: rel, line });
      } else if (wild) {
        reads.push({ file: rel, line, flag: null, shape: 'bulk' });
      } else if (inLit) {
        reads.push({ file: rel, line, flag: null, shape: 'bulk' });
        for (const nm of inLit[1].matchAll(/(['"`])([A-Za-z_][\w]*)\1/g)) {
          uses.push({ flag: nm[2], reader: 'direct', file: rel, line });
        }
      } else if (eqVar) {
        // `.eq("flag", someVariable)` — the flag name arrives at runtime. This
        // is the body of a per-file helper (shadow or otherwise), or an admin
        // write keyed by a loop variable. Distinct from `management` because a
        // name IS being selected, we just cannot see which.
        reads.push({ file: rel, line, flag: null, shape: 'var' });
      } else {
        reads.push({ file: rel, line, flag: null, shape: 'management' });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECOND POPULATION SCAN — flags seeded by a migration.
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = join(PKG_ROOT, 'src', 'migrations');

/**
 * Strip SQL comments so migration PROSE is never parsed as migration CODE.
 *
 * Quote-aware: a `--` or `/*` inside a single-quoted literal (a flag
 * description, say) is left alone. Dollar-quoting is NOT tracked, which is safe
 * here for the one reason that matters — a `DO $$ ... $$` body is still scanned
 * for INSERT statements, and 0062 puts a real seeding INSERT inside one.
 *
 * Line numbers are preserved: comment bodies are replaced with spaces rather
 * than deleted, so the `file:line` this scan reports still points at the real
 * line in the unstripped file.
 */
function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < sql.length) {
    const c = sql[i], d = sql[i + 1];
    if (inStr) {
      out += c;
      if (c === "'") inStr = (d === "'") ? (out += sql[++i], true) : false;
      i++;
      continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && d === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += (sql[i] === '\n') ? '\n' : ' ';
        i++;
      }
      out += '  '; i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** flag name -> "file:line" of its first seeding row. */
const seeded = new Map();
let migrationFileCount = 0;
let seedStatementCount = 0;

if (!existsSync(MIGRATIONS_DIR)) {
  fail(`VACUOUS: no migrations directory at ${MIGRATIONS_DIR}. The seeded-flag population has no subject.`);
} else {
  const migFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  migrationFileCount = migFiles.length;
  for (const f of migFiles) {
    let text;
    try {
      text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    } catch (e) {
      fail(`UNPARSEABLE: could not read migration ${f}: ${e.message}`);
      continue;
    }
    // Comments are not SQL. A migration that EXPLAINS a seeding statement in its
    // header — which the retirement migrations deliberately do at length — would
    // otherwise have its prose counted as seeding statements, inflating the
    // reported totals and inviting the scanner to extract flag names out of
    // English. Stripped before matching, quote-aware so a `--` inside a
    // description literal is not mistaken for a comment.
    text = stripSqlComments(text);

    // The schema qualifier is OPTIONAL. This matcher used to be
    // /INSERT\s+INTO\s+feature_flags\b/gi, which silently skipped every
    // schema-qualified insert — 0062_notifications_schema.sql and
    // 0051_compass_foundation.sql, 14 seeded flags, 10 of them read by nothing.
    // A scan that misses a seed does not report a gap; it reports that the
    // population is clean, which is the failure this file's own preamble names
    // as "the most comfortable possible lie". Guarded by
    // src/test/flagPolaritySeedScan.test.ts, which counts the statements
    // independently with a deliberately broader matcher and fails if this one
    // finds fewer.
    for (const m of text.matchAll(/INSERT\s+INTO\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?feature_flags\b/gi)) {
      seedStatementCount++;
      // The statement runs to its terminating semicolon. Row literals look like
      // ('flag_name', true|false, 'description').
      //
      // The terminator must be found OUTSIDE a quoted string. This was a plain
      // indexOf(';') until 2026-08-12, which is the same class of bug as the
      // missing schema qualifier above and had the same consequence: a
      // description containing a semicolon truncated the statement mid-VALUES
      // and every row after it vanished from the seeded population. 0090
      // (rent_buddy rollout) and 2068 (live places) each seed a flag whose
      // description contains one, which is why 23 seeded flags — including eight
      // that no code reads — were invisible to rule R6. Once again the scan did
      // not report a gap; it reported that the population was clean, and R6
      // cannot ask about a seed it cannot see.
      //
      // SQL escapes a quote by doubling it ('' inside a literal). Toggling on
      // every quote handles that correctly: the pair toggles off then on and
      // lands back inside the string.
      const rest = text.slice(m.index);
      let semi = -1;
      let inQuote = false;
      for (let i = 0; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === "'") inQuote = !inQuote;
        else if (ch === ';' && !inQuote) { semi = i; break; }
      }
      const stmt = semi > 0 ? rest.slice(0, semi) : rest;
      for (const row of stmt.matchAll(/\(\s*'([A-Za-z0-9_]+)'\s*,/g)) {
        const flag = row[1];
        if (seeded.has(flag)) continue;
        const line = text.slice(0, m.index + row.index).split('\n').length;
        seeded.set(flag, `src/migrations/${f}:${line}`);
      }
    }
  }
}

// VACUITY: this population must also have a subject. An empty migrations tree,
// no INSERT statements, or no seeded names each mean the scan broke — and a
// broken scan here reports "every seeded flag has a reader", which is the most
// comfortable possible lie.
if (migrationFileCount === 0) {
  fail('VACUOUS: zero .sql files under src/migrations. The seeded-flag population has no subject, and an empty population would report clean.');
}
if (seedStatementCount === 0) {
  fail('VACUOUS: no `INSERT INTO feature_flags` statement found in any migration. Either the seeding moved or the matcher broke; both mean this rule is enforcing nothing.');
}
if (seeded.size === 0) {
  fail('VACUOUS: no seeded flag names extracted. See above — the row matcher is the likely cause.');
}
if (INERT_SEEDED_FLAGS.length === 0) {
  fail('VACUOUS: INERT_SEEDED_FLAGS is empty. It is not empty in reality (see §6.10 of the fact layer); an empty list means the declaration was dropped.');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFY
// ─────────────────────────────────────────────────────────────────────────────

const byConvention = (flag) => {
  if (/^disable_[a-z0-9_]+$/.test(flag) || /^[a-z0-9_]+_disabled$/.test(flag)) return 'STOP';
  if (/^[a-z0-9_]+_enabled$/.test(flag)) return 'CAPABILITY';
  return null;
};

const classifiedByName = new Map();
for (const e of CLASSIFIED) {
  if (classifiedByName.has(e.flag)) fail(`DUPLICATE: ${e.flag} appears twice in CLASSIFIED.`);
  classifiedByName.set(e.flag, e);
}

const inventory = new Map(); // flag -> {kind, source}
for (const u of uses) {
  if (inventory.has(u.flag)) continue;
  const explicit = classifiedByName.get(u.flag);
  const conv = byConvention(u.flag);
  if (explicit) inventory.set(u.flag, { kind: explicit.kind, source: 'CLASSIFIED' });
  else if (conv) inventory.set(u.flag, { kind: conv, source: 'convention' });
  else inventory.set(u.flag, { kind: null, source: 'UNCLASSIFIED' });
}

// VACUITY: the inventory and the STOP class must both be non-empty.
if (inventory.size === 0) {
  fail('VACUOUS: the flag inventory is empty. Either no flag is read anywhere in src/ (implausible) or the scan is broken.');
}
const stopCount = [...inventory.values()].filter((v) => v.kind === 'STOP').length;
if (stopCount === 0) {
  fail('VACUOUS: zero STOP flags found. The emergency-stop class vanishing from the codebase is not a clean run — it means the scan stopped seeing them, and this check would then pass while enforcing nothing.');
}
if (CLASSIFIED.length === 0) fail('VACUOUS: CLASSIFIED is empty.');
if (DIRECT_READS.length === 0) fail('VACUOUS: DIRECT_READS is empty.');

// ─────────────────────────────────────────────────────────────────────────────
// RULES
// ─────────────────────────────────────────────────────────────────────────────

// R1 — every flag name is classified.
for (const [flag, info] of inventory) {
  if (info.kind === null) {
    const where = uses.filter((u) => u.flag === flag).slice(0, 3).map((u) => `${u.file}:${u.line}`).join(', ');
    fail(
      `UNCLASSIFIED FLAG: "${flag}" matches neither naming convention and has no CLASSIFIED entry.\n` +
      `    seen at: ${where}\n` +
      `    Decide whether it is a STOP (true means "stop doing X" — an unreadable flag must ENGAGE it),\n` +
      `    a CAPABILITY (true means "X is available" — an unreadable flag leaves it OFF), or CONFIG,\n` +
      `    then add it to CLASSIFIED in ${relative(PKG_ROOT, fileURLToPath(import.meta.url))} with a reason.`,
    );
  }
}

// R2 — a STOP may only be read through the shared isKillSwitchEngaged.
for (const u of uses) {
  const info = inventory.get(u.flag);
  if (!info || info.kind !== 'STOP') continue;
  if (u.reader === STOP_READER) continue;
  fail(
    `STOP READ THROUGH THE WRONG READER: "${u.flag}" is classified STOP but is read via ` +
    `${u.reader === 'direct' ? 'a direct feature_flags query' : u.reader} at ${u.file}:${u.line}.\n` +
    `    A stop read through isFlagEnabled returns false when the DB is unhealthy, which means "do not stop" —\n` +
    `    the switch disengages at the moment it is most needed. Use ${STOP_READER}.`,
  );
}

// R3 — a CAPABILITY/CONFIG read directly needs a DIRECT_READS entry.
const directKeys = new Set();
for (const e of DIRECT_READS) directKeys.add(e.flag ? `${e.file}::${e.flag}` : `${e.file}::<${e.shape}>`);
// A declared shadow helper's own `.eq("flag", <param>)` IS its body — the
// SHADOW_READERS entry already records what that read does on failure, so
// requiring a second entry for it would only duplicate the same judgment.
const shadowFiles = new Set(SHADOW_READERS.map((s) => s.file));
for (const r of reads) {
  const key = r.flag ? `${r.file}::${r.flag}` : `${r.file}::<${r.shape}>`;
  if (directKeys.has(key)) continue;
  if (r.shape === 'var' && shadowFiles.has(r.file)) continue;
  fail(
    `UNDECLARED DIRECT READ: ${r.file}:${r.line} reads feature_flags ` +
    `${r.flag ? `for "${r.flag}"` : `(${r.shape} — no resolvable flag name)`} without a DIRECT_READS entry.\n` +
    `    The check cannot verify what this does when the read fails (see the header). Add an entry recording\n` +
    `    what a human verified: "read directly, error branch verified <direction> by hand at <commit>".`,
  );
}

// R4 — shadow helpers must be declared.
const shadowKeys = new Set(SHADOW_READERS.map((s) => `${s.file}::${s.fn}`));
for (const found of shadowsFound) {
  if (shadowKeys.has(found)) continue;
  const [file, fn] = found.split('::');
  fail(
    `UNDECLARED SHADOW READER: ${file} defines its own ${fn}(). A function with a shared helper's name but ` +
    `its own polarity is exactly what makes a call-site-pattern check useless.\n` +
    `    Add a SHADOW_READERS entry recording its verified behaviour on a failed read.`,
  );
}

// R5 — unresolvable flag arguments fail unless declared.
const unresolvableKeys = new Set(UNRESOLVABLE.map((u) => u.file));
for (const u of unresolvedFound) {
  if (unresolvableKeys.has(u.file)) continue;
  fail(
    `UNRESOLVABLE FLAG ARGUMENT: ${u.file}:${u.line} passes \`${u.expr}\` to ${u.reader}. The check cannot ` +
    `tell which flag is read, so it cannot tell whether that flag is a stop.\n` +
    `    Make it a literal, or add an UNRESOLVABLE entry saying which names it can produce and who verified that.`,
  );
}

const hasReason = (e) => typeof e.reason === 'string' && e.reason.trim().length > 0;

// R6 — every seeded flag is either read, or declared inert with a reason.
const inertByFlag = new Map();
for (const e of INERT_SEEDED_FLAGS) {
  if (inertByFlag.has(e.flag)) fail(`DUPLICATE: ${e.flag} appears twice in INERT_SEEDED_FLAGS.`);
  inertByFlag.set(e.flag, e);
}
// Names declared as reachable through an argument the scanner cannot resolve.
// Without this, a flag read through a computed or imported name reports as
// "seeded but never read" — which is how this rule found the three real gaps
// recorded in the UNRESOLVABLE entries, and would otherwise be noise forever.
const coveredByDeclaration = new Set();
for (const e of [...UNRESOLVABLE, ...DIRECT_READS]) {
  for (const f of e.covers ?? []) coveredByDeclaration.add(f);
}
// Read in the mobile app tree, which this check does not walk. Verified against
// the app source by rule R8 below rather than taken on trust.
const appTreeRead = new Set(APP_TREE_READS.map((e) => e.flag));

for (const [flag, where] of seeded) {
  if (inventory.has(flag)) continue;          // read somewhere — first population covers it
  if (coveredByDeclaration.has(flag)) continue; // read through a declared unresolvable name
  if (appTreeRead.has(flag)) continue;        // read in the app tree — declared and verified by R8
  if (inertByFlag.has(flag)) continue;        // declared inert, with a reason
  fail(
    `SEEDED BUT NEVER READ: "${flag}" is seeded at ${where} and is read by nothing under src/.\n` +
    `    An operator can see it in the admin list and toggle it; toggling it changes no code path.\n` +
    `    If it is a STOP, this is the failure mode of c89f09a77 with no outage required: the switch is\n` +
    `    flipped and the thing it names keeps happening.\n` +
    `    Add an INERT_SEEDED_FLAGS entry stating which remedy is intended — write-reader, remove-from-seed,\n` +
    `    or owner-decision — with a reason. "unused" is not a reason.`,
  );
}

// R7 — an inert declaration must still be true: still seeded, and still unread.
for (const e of INERT_SEEDED_FLAGS) {
  if (!hasReason(e)) {
    fail(`NO REASON: INERT_SEEDED_FLAGS entry for "${e.flag}" has no reason. The entry exists to record a decision; without one it records nothing.`);
  }
  if (!DISPOSITIONS.has(e.disposition)) {
    fail(
      `BAD DISPOSITION: INERT_SEEDED_FLAGS entry for "${e.flag}" has disposition "${e.disposition}". ` +
      `Must be one of: ${[...DISPOSITIONS].join(', ')}. The field exists so "we will decide later" is written down as a decision rather than implied by silence.`,
    );
  }
  if (!seeded.has(e.flag)) {
    fail(`STALE INERT ENTRY: "${e.flag}" is declared inert but is no longer seeded by any migration. Remove the entry.`);
  }
  if (coveredByDeclaration.has(e.flag)) {
    fail(
      `CONTRADICTORY DECLARATION: "${e.flag}" is declared INERT and also listed in a \`covers\` array as ` +
      `reachable through an unresolvable argument. It cannot be both. Delete whichever is false.`,
    );
  }
  if (inventory.has(e.flag)) {
    fail(
      `RESOLVED INERT ENTRY: "${e.flag}" is declared inert, but it now HAS a reader (it is in the read inventory). ` +
      `Someone did the work — delete the entry so the list keeps meaning "still inert".`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRIES MUST STILL BE TRUE  (staleness — an exemption that has outlived its
// subject is a lie the next reader will believe)
// ─────────────────────────────────────────────────────────────────────────────

for (const e of CLASSIFIED) {
  if (!hasReason(e)) fail(`NO REASON: CLASSIFIED entry for "${e.flag}" has no reason. An unexplained classification is not a judgment, it is a guess.`);
  if (!['STOP', 'CAPABILITY', 'CONFIG'].includes(e.kind)) fail(`BAD KIND: CLASSIFIED entry for "${e.flag}" has kind "${e.kind}".`);
  if (!inventory.has(e.flag)) fail(`STALE CLASSIFIED ENTRY: "${e.flag}" is classified here but no longer read anywhere under src/. Remove it.`);
}
for (const e of SHADOW_READERS) {
  if (!hasReason(e)) fail(`NO REASON: SHADOW_READERS entry for ${e.file} has no reason.`);
  if (!shadowsFound.has(`${e.file}::${e.fn}`)) fail(`STALE SHADOW ENTRY: ${e.file} no longer defines ${e.fn}(). Remove the entry.`);
}
for (const e of UNRESOLVABLE) {
  if (!hasReason(e)) fail(`NO REASON: UNRESOLVABLE entry for ${e.file} has no reason.`);
  if (!unresolvedFound.some((u) => u.file === e.file)) fail(`STALE UNRESOLVABLE ENTRY: ${e.file} no longer passes a non-literal flag argument. Remove the entry.`);
}
const seenReadKeys = new Set(reads.map((r) => (r.flag ? `${r.file}::${r.flag}` : `${r.file}::<${r.shape}>`)));
for (const e of DIRECT_READS) {
  if (!hasReason(e)) fail(`NO REASON: DIRECT_READS entry for ${e.file} has no reason. The reason IS the guarantee here — without it the entry asserts nothing.`);
  if (!e.flag && !e.shape) fail(`MALFORMED: DIRECT_READS entry for ${e.file} names neither a flag nor a shape.`);
  const key = e.flag ? `${e.file}::${e.flag}` : `${e.file}::<${e.shape}>`;
  if (!seenReadKeys.has(key)) fail(`STALE DIRECT_READS ENTRY: ${key} no longer exists under src/. Remove the entry.`);
  if (!existsSync(join(SRC, e.file))) fail(`STALE DIRECT_READS ENTRY: ${e.file} does not exist.`);
}

// R8 — an APP_TREE_READS entry must be seeded, must not also be declared inert
// or read under src/, and the app file it names must actually contain the flag.
// That last clause is the whole point: without it this list would be a way to
// silence R6 by assertion, which is precisely what INERT_SEEDED_FLAGS is careful
// not to be.
if (APP_TREE_READS.length > 0 && !existsSync(APP_TREE_ROOT)) {
  fail(
    `CANNOT VERIFY APP_TREE_READS: no app tree at ${APP_TREE_ROOT}, but ${APP_TREE_READS.length} entr(ies) claim ` +
    `a reader lives there. Those flags are exempted from R6 on the strength of that claim, so an unverifiable ` +
    `claim must FAIL rather than pass quietly. If this is a partial checkout, check out the app tree too — do ` +
    `not delete the entries to make this pass.`,
  );
}
for (const e of APP_TREE_READS) {
  if (!hasReason(e)) {
    fail(`NO REASON: APP_TREE_READS entry for "${e.flag}" has no reason. The entry exempts a flag from R6; without a reason it exempts it for nothing.`);
    continue;
  }
  if (!seeded.has(e.flag)) {
    fail(
      `STALE APP_TREE_READS ENTRY: "${e.flag}" is declared as read in the app tree but is not seeded by any ` +
      `migration, so R6 never asks about it and this entry exempts nothing. Remove it.`,
    );
  }
  if (inertByFlag.has(e.flag)) {
    fail(`CONTRADICTORY DECLARATION: "${e.flag}" is declared INERT and also declared as read in the app tree. It cannot be both. Delete whichever is false.`);
  }
  if (inventory.has(e.flag)) {
    fail(
      `RESOLVED APP_TREE_READS ENTRY: "${e.flag}" now has a reader under src/ as well, so this entry is no longer ` +
      `what exempts it from R6. Delete it so the list keeps meaning "app tree ONLY".`,
    );
  }
  if (!existsSync(APP_TREE_ROOT)) continue; // already failed loudly above
  const appFile = join(APP_TREE_ROOT, e.file);
  if (!existsSync(appFile)) {
    fail(`STALE APP_TREE_READS ENTRY: "${e.flag}" names ${e.file}, which does not exist in the app tree.`);
    continue;
  }
  if (!readFileSync(appFile, 'utf8').includes(e.flag)) {
    fail(
      `UNVERIFIED APP_TREE_READS ENTRY: "${e.flag}" is declared as read at ${e.file}:${e.line}, but that file does ` +
      `not contain the flag name. Either the read was removed — in which case the flag is now inert and this entry ` +
      `is a false exemption — or it moved and the entry must be updated.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
// ─────────────────────────────────────────────────────────────────────────────

const kinds = { STOP: 0, CAPABILITY: 0, CONFIG: 0 };
for (const v of inventory.values()) if (v.kind) kinds[v.kind]++;

if (problems.length > 0) {
  console.error('\n✖ check-flag-polarity FAILED\n');
  for (const p of problems) console.error(`  • ${p}\n`);
  console.error(
    `  Scanned ${scanFiles.length} files (${testFiles.length} test files excluded).\n` +
    `  Inventory: ${inventory.size} flags — ${kinds.STOP} STOP, ${kinds.CAPABILITY} CAPABILITY, ${kinds.CONFIG} CONFIG.\n` +
    `  Seeded: ${seeded.size} flags across ${migrationFileCount} migrations.\n` +
    `  ${problems.length} problem(s).\n`,
  );
  process.exit(1);
}

const inertCount = INERT_SEEDED_FLAGS.length;
const seededRead = [...seeded.keys()].filter((f) => inventory.has(f)).length;

console.log(
  `✓ check-flag-polarity: ${inventory.size} flags classified ` +
  `(${kinds.STOP} STOP, ${kinds.CAPABILITY} CAPABILITY, ${kinds.CONFIG} CONFIG) across ${scanFiles.length} files.\n` +
  `  ${uses.length} flag reads, ${reads.length} direct table reads declared, ` +
  `${shadowsFound.size} shadow readers declared, ${unresolvedFound.length} unresolvable arguments declared.\n` +
  `  Seeded population: ${seeded.size} flags seeded across ${migrationFileCount} migrations ` +
  `(${seedStatementCount} INSERT statements) — ${seededRead} read, ${inertCount} declared inert with a reason.\n` +
  `  Reminder: this proves a classification EXISTS and MATCHES its reader — not that it is RIGHT,\n` +
  `  and that every seeded flag is accounted for — not that an inert one is harmless.`,
);
process.exit(0);
