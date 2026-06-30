# Travel Buddy — User Interaction System
# PHASED MASTER COMMAND (self-verifying, evidence-gated)

## HOW THIS WORKS (read before doing anything)

This is a **safety-critical** build (block, report, age-gating, location privacy, abuse
prevention). It is split into 8 phases. Hand the agent **ONE PHASE AT A TIME** by pasting
that phase's "AGENT MESSAGE" block. Each phase ends with a **PHASE GATE** the agent runs
itself — but the gate passes on *pasted evidence*, not on the agent's say-so.

### THE GOLDEN RULE OF EVERY GATE (this is what makes self-pass safe)
The agent may mark a phase ✅ PASS **only after pasting the raw command output that proves
it** — the actual grep showing code is in the file, the actual test-runner output with
pass/fail counts, the actual curl/SQL result. A *summary* is not evidence; the *raw output*
is. **If the agent's claimed result and its pasted evidence ever disagree (it says "passed"
but the output shows an error, 0 rows, a failing test, or a missing string), that is an
automatic FAIL. The agent must fix it, log it, re-run, and paste fresh passing output before
marking the gate ✅.** Then it STOPS and waits for the human.

### RUNNING ERROR LOG (the agent maintains this across all phases)
The agent keeps a file `docs/INTERACTION_BUILD_LOG.md` and appends to it at every gate:
- Phase number + name
- Each check run + its result (pass/fail)
- Every error encountered, the root cause, and the fix applied
- Anything deferred or flagged for human decision
At each gate the agent pastes the new log entries.

### GLOBAL RULES (apply to EVERY phase — agent re-reads these each phase)
1. Inspect existing code before writing new code. Reuse/extend existing tables, routes,
   hooks, components, navigation, design-system pieces. Do NOT duplicate systems.
2. Do NOT rename/remove working features unless absolutely required; if required, preserve
   compatibility with existing screens.
3. Do NOT delete existing data. Migrations must be backward-compatible + idempotent
   (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS` before create).
4. Do NOT apply Supabase migrations yourself. OUTPUT SQL + verification query for the human
   to run. Wait.
5. Do NOT weaken privacy/safety. On conflict, SAFETY WINS (priority order below).
6. Do NOT break: Safe Return, Pulse, Discovery, Trips, Passport, Telegraph, Events,
   Circles, tagging, hashtags, Rent a Buddy, navigation.
7. Do NOT sync the standalone app from any artifacts copy.
8. If you find a table/column conflict (existing table, different shape), STOP and report.
   Do NOT drop/alter destructively without explicit human approval.
9. At each PHASE GATE: paste raw evidence, update the error log, mark ✅/❌, and STOP. Never
   auto-advance to the next phase.

### SAFETY PRIORITY ORDER (permission engine uses this; safety wins on conflict)
1 Deleted/banned/suspended · 2 Blocked · 3 Serious moderation/safety restriction ·
4 Age restriction · 5 Location/privacy restriction · 6 Target privacy settings ·
7 Context access (booking/trip/event/circle) · 8 Friend · 9 Follow · 10 Message request ·
11 Discovery recommendation.
Examples: friends but one blocks → block wins. Same event but one safety-restricted →
safety wins. Active booking but suspended → suspension wins.

### SAFETY-CRITICAL PHASES (3, 4, 6, 7): stricter gate
For these, the gate evidence MUST include the test-runner output showing the named safety
tests passing (by name), and the relevant grep/endpoint proof. "Self-passed" with only a
summary is an automatic FAIL on these phases.

================================================================================
## PHASE 1 — AUDIT ONLY (read-only, no code, no migrations)
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 1 of 8 — AUDIT ONLY. Read-only. Do NOT create tables, write migrations, or change
code. Re-read the GLOBAL RULES.

Inspect the codebase AND Supabase schema and produce a reuse-vs-build report (file paths +
table names + current row counts) for: existing profile/Passport screen + route; profile
navigation patterns; user card/avatar components; Telegraph messaging (tables/routes/
conversation model); message-request logic; friend/follow/saved-profile systems; block/
report systems; mute/restrict systems; privacy settings (tables + UI); user settings/
preferences; tagging + hashtag system; Event attendee/member logic + roles; Circle member
logic + roles; Trip Crew logic; Rent a Buddy provider/client/booking logic; Safe Return/
location-privacy (geofence, delayed posting); Activity Center/notifications; Supabase
tables/RLS/indexes/RPCs; backend routes/API utilities; frontend API hooks; auth/session
identity helpers; moderation/admin systems.

Classify each concept in this build as EXISTS-and-reuse / EXISTS-but-extend / MISSING-build-
new. Create `docs/INTERACTION_BUILD_LOG.md` and write the Phase 1 entry.

PHASE 1 GATE — prove it and self-pass:
- Paste the raw output of the commands you used to inspect (grep/ls/SQL counts) — actual
  output, not a summary.
- Paste the reuse-vs-build classification table.
- Confirm in evidence that NO files were changed (e.g. `git status` showing clean, or the
  diff is empty). If anything changed, that's a FAIL — revert and re-run.
- Append the Phase 1 entry to docs/INTERACTION_BUILD_LOG.md and paste it.
- Mark ✅ PASS only if the pasted git status proves read-only AND the classification is
  complete. Then STOP. Do not start Phase 2.
----- END AGENT MESSAGE -----

Human review before Phase 2: confirm read-only, confirm the classification, decide which
existing tables (e.g. user_follows, user_blocks, profiles, messaging tables) are canonical.

================================================================================
## PHASE 2 — DATA FOUNDATION (migrations as SQL only; human applies)
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 2 of 8 — DATA FOUNDATION. Output ALL SQL as files in docs/sql/; APPLY NOTHING. Extend
existing tables found in Phase 1; create only what's genuinely missing. Re-read GLOBAL
RULES (esp. #3, #4, #8). All SQL idempotent + backward-compatible + RLS enabled.

Provide SQL for these concepts (reuse existing equivalents; do not duplicate):
CORE: user_relationships (id, viewer_user_id, target_user_id, relationship_type, status,
context_type, context_id, created_by, created_at, updated_at, expires_at, policy_version,
metadata; types: friend/follow/saved_profile/message_request/message_accepted/block/mute/
restrict/event_connection/circle_connection/trip_crew/booking_connection; statuses:
pending/accepted/declined/cancelled/expired/active/inactive/removed/blocked/muted/
restricted); friend_requests (only if it adds value, else model via user_relationships;
sender, recipient, status, note, created_at, responded_at, expires_at, cooldown_until);
follows (only if existing pattern uses separate table); saved_profiles (private; no social
access); user_blocks (app-wide); user_mutes (messages/posts/event_invites/circle_invites/
trip_invites/all); user_restrictions (messages→requests, no read receipts, no online
status, optional media/contact limits, user not told); message_requests (no_relationship/
request_sent/request_received/accepted/declined/expired/blocked/restricted/hidden/
reported); conversation_members (direct/message_request/event/circle/trip/booking/support);
reports (reporter_user_id, reported_user_id, reason, description, context_type, context_id,
status, severity, evidence metadata, moderation_action, created_at, updated_at; reasons:
harassment/scam-fraud/fake-profile/impersonation/unsafe-behavior/spam/adult-dating-misuse/
hate-discrimination/threat-violence/underage-concern/payment-dispute/rent-a-buddy-boundary/
off-app-payment/privacy-location-violation/fake-review/other); report_evidence (messages/
posts/events/bookings/media refs/timestamps/metadata).
PRIVACY/AUDIT/MOD/STATE: user_privacy_settings (profile visibility {public/travelers_only/
friends_only/hidden_from_search}; message perms {everyone/verified_only/friends_of_friends/
event_circle_trip_connections_only/friends_only/no_requests}; friend-request perms
{everyone/verified_only/friends_of_friends/event_circle_trip_connections_only/off}; tagging
{anyone/friends_only/approval_required/no_one}; invite {everyone/verified_only/friends/
shared_context_only/off}; location {city_only/delayed_only/friends_general_area/
trip_crew_limited/emergency_only/hidden}; activity {online_status_*/read_receipts_*}; travel
mode {open_to_plans/group_events_only/friends_only/invisible/looking_for_locals/
looking_for_trip_crew/do_not_disturb}; comfort {public_meetups_only/group_plans_preferred/
verified_users_only/no_one_on_one_invites/no_late_night_invites/no_alcohol_invites/
no_photo_tags/no_live_location_sharing/keep_communication_in_app}); user_interaction_audit_
log (actor_user_id, target_user_id, action_type, context_type, context_id, metadata,
created_at, policy_version; all sensitive social actions); moderation_actions (warning/
message_limit/invite_limit/hosting_limit/discovery_hidden/rent_a_buddy_frozen/
temporary_suspension/permanent_ban/report_resolved/content_removed/event_removed/
circle_removed/booking_frozen); user_account_states (active/new/verified/limited/
under_review/suspended/banned/deleted/deactivated — engine MUST check); user_interaction_
cooldowns (repeated requests, friend-after-decline, repeated invites, tag-after-removal,
nudges, follow/unfollow churn, report-retaliation); user_social_consents (community rules,
messaging rules, RaB boundaries, off-app payment warning, location sharing, photo/tag
consent, Safe Return escalation, social policy version); user_hidden_recommendations
("don't show me"/"don't recommend me to them"); user_private_notes (author-only, never
public; only if quick/safe); user_profile_views (only if already partly supported;
aggregated counts only, no viewer names).
INDEXES: (viewer_user_id,target_user_id), (target_user_id,viewer_user_id),
relationship_type, status, (context_type,context_id), expires_at.
RLS: users read only rows involving them (unless admin); create only their own actions;
cannot fabricate accepted relationships without recipient action; cannot read others'
private notes; cannot read report evidence except own summaries/admin; blocked users can't
bypass via direct queries; admin access audited; privacy settings never expose hidden
fields; deep links still run checks; media refs respect ownership + evidence rules.
POLICY VERSIONS: social_policy_version, message_policy_version, privacy_policy_version +
consent history.

PHASE 2 GATE — prove it and self-pass:
- Paste the list of SQL files created (ls docs/sql/) and the FULL contents of each.
- For each, state extend-vs-new and which Phase-1 table it reuses.
- Paste a self-check confirming every file is idempotent (show the IF NOT EXISTS / DROP
  POLICY IF EXISTS lines) and that NONE were applied to the DB (no service-role write ran).
- Confirm no app code changed (git status / empty diff). Code change here = FAIL.
- Append Phase 2 log entry and paste it.
- Mark ✅ only if evidence shows: SQL files exist, are idempotent, unapplied, no code
  changed. Then STOP. (Human will review + run the SQL in Supabase.)
----- END AGENT MESSAGE -----

Human review before Phase 3: read every migration; confirm no destructive drops; confirm
RLS on every table; confirm extend-not-duplicate; RUN the SQL yourself in Supabase; run the
verification queries.

================================================================================
## PHASE 3 — PERMISSION ENGINE (backend core) + 22 TESTS  [SAFETY-CRITICAL]
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 3 of 8 — PERMISSION ENGINE. SAFETY-CRITICAL gate applies. Re-read GLOBAL RULES +
SAFETY PRIORITY ORDER. Build the one canonical backend service (reuse existing naming if
present; suggested userInteractionPermissions/relationshipPermissions).

Endpoint: GET /api/users/:targetUserId/interaction-context?sourceType=...&sourceId=...
It answers: viewer? target? context? friends? mutual follow? either blocked? muted/
restricted? suspended/deactivated/deleted? active reports/moderation? same event/circle/
trip-crew? booking-connected? viewer age-eligible? target privacy allows? verification
required? trust too low? cooldown/rate-limit? which actions SHOW vs DISABLE? reason code.
Return full object: targetUserId, viewerId, relationshipLabel (Friend|Following|Same Event|
Trip Crew|Booking|Message Request|Blocked|Restricted|Unavailable|None), profileVisibility
(full|limited|private|unavailable), canViewProfile, canViewFullProfile, canMessage,
canSendMessageRequest, canAcceptMessageRequest, canDeclineMessageRequest, canAddFriend,
canAcceptFriendRequest, canDeclineFriendRequest, canCancelFriendRequest, canFollow,
canUnfollow, canSaveProfile, canUnsaveProfile, canInviteToEvent, canInviteToCircle,
canInviteToTripCrew, canTag, canMention, canBookBuddy, canReview, canMute, canRestrict,
canBlock, canReport, canShareProfile, canSeeMutuals, canSeeAvailability, canSeeTrips,
canSeePublicPosts, canSeeFriendOnlyPosts, canSeeLocationContext, safetyWarnings[],
reasonCodes[], context{sourceType,sourceId,sharedEventId,sharedCircleId,sharedTripId,
sharedBookingId}. Source types: pulse/telegraph/event/circle/trip/rent_a_buddy/search/tag/
comment/review/discovery/passport. Reason codes: blocked, target_blocked_viewer,
viewer_blocked_target, target_private, viewer_unverified, target_only_accepts_friends,
message_requests_closed, age_restricted, trust_too_low, event_only_chat, booking_required,
cooldown_active, rate_limited, suspended, deactivated, deleted_user, tag_requires_approval,
rent_a_buddy_boundary, off_app_payment_restricted, location_privacy_restricted. Enforce the
SAFETY PRIORITY ORDER. Leave fields for separate trust signals (Safety Trust, Reliability,
Host Quality, Provider Quality, Payment Reliability, Communication Quality, No-show) even if
not implemented; paid boosts NEVER override safety. Engine fast; blocks/suspensions/age/
active membership/location must never be stale.

Write these 22 backend tests and make them pass: 1 block prevents message; 2 block prevents
friend request; 3 block prevents tag; 4 block prevents invite; 5 block prevents booking;
6 unblock does NOT auto-restore friendship; 7 unknown user only sends message request (not
DM); 8 declined request creates cooldown; 9 one nudge max; 10 private profile hidden from
stranger; 11 friend sees friend-level profile if privacy allows; 12 suspended user cannot
interact; 13 deleted/deactivated profile unavailable; 14 event attendee cannot DM before
allowed; 15 same event shows "Same Event"; 16 RaB pre-booking chat blocks/warns off-app
payment; 17 report preserves evidence; 18 restrict hides read receipts/limits messages;
19 tag approval required for non-friend; 20 deep link respects block/privacy; 21 age
restriction blocks event/circle invite; 22 admin moderation action audited.

PHASE 3 GATE — SAFETY-CRITICAL, prove it and self-pass:
- Paste the raw test-runner output showing all 22 tests BY NAME with pass/fail counts. Any
  failure or any test not present = FAIL; fix, log, re-run, paste fresh output.
- Paste a grep proving the endpoint route + service exist and export the listed fields.
- Paste one real example response from the endpoint for a blocked pair (showing block wins)
  and one for a normal pair.
- Append Phase 3 log entry (include any bug found + fix). Paste it.
- Mark ✅ only if the pasted test output shows 22/22 passing AND the example responses are
  correct. Then STOP.
----- END AGENT MESSAGE -----

Human review before Phase 4: read the 22 test results; spot-read 2–3 safety tests' code to
confirm they test the real path (not a stub); confirm block-wins example is genuine.

================================================================================
## PHASE 4 — CORE ACTIONS (backend)  [SAFETY-CRITICAL]
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 4 of 8 — CORE ACTIONS. SAFETY-CRITICAL gate. Re-read GLOBAL RULES. Implement/complete
each, ALL checked through the Phase-3 engine:
Friend: Add→request; recipient Accept/Decline/Block/Report; accepted mutual; decline→
cooldown; cancel pending; remove friend (no auto-block); friend does NOT override privacy/
block/age/safety; optional short note, NO links/media/contact. Follow: one-way; no private
trip/location unlock; block hides. Save profile: private; grants no access; private save
preferred; block hides. Message request: unknown→request (not DM) unless context allows;
one initial; no unlimited follow-ups; one nudge max; decline→cooldown; new/unverified
stricter; hidden requests for spammy/risky; preview hides harmful; accepted→main Telegraph.
Block (app-wide): prevents DMs/requests/friend-requests/follows/invites/tags/mentions/
booking/full-profile/Discovery-search exposure where possible/comment-reaction; cancels
pending; hides thread; stops notifications; preserves evidence; unblock restores NOTHING.
Mute: per type; not notified; keeps friendship. Restrict: quiet; messages→requests/limited;
no read receipts; no online status; optional media/contact off; user not told. Report:
accessible from profile/mini/chat/request/post/comment/event/circle/trip/booking/review/
tag; auto-attaches context; after report offer block; preserve evidence if serious; create
moderation queue entry; high severity may restrict; protect reporter from retaliation. Tag
check: cannot tag blocked or those who blocked viewer; respect tag privacy; approval-
required stays pending; location tags stricter; user can remove own tag + report photo
issue. Anti-retaliation: after decline/block/report block repeated requests/tags/mentions/
invite-spam/revenge-reviews and bypass via shared groups/events.

PHASE 4 GATE — SAFETY-CRITICAL, prove it and self-pass:
- Add/extend tests for each action and paste the raw runner output (names + counts).
- Paste a grep proving each action routes through the permission engine (not a direct DB
  write bypassing it).
- Paste evidence that block is app-wide: a test/endpoint result showing a blocked user is
  denied across message + friend + tag + invite + booking.
- Append Phase 4 log entry (+ any bug/fix). Paste it.
- Mark ✅ only if pasted evidence shows all action tests green AND block-app-wide proven.
  STOP.
----- END AGENT MESSAGE -----

Human review before Phase 5: confirm block-app-wide evidence is real; confirm anti-
retaliation tests exist.

================================================================================
## PHASE 5 — FRONTEND INTEGRATION (shared hooks + components)
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 5 of 8 — FRONTEND INTEGRATION. Re-read GLOBAL RULES. All driven by the Phase-3
engine; all in the existing design system; do NOT create conflicting profile screens.
Hooks: useUserInteractionContext(targetUserId, sourceType?, sourceId?), useProfileActions,
useRelationshipLabel, useCanMessageUser, useBlockUser, useReportUser, useMuteUser,
useRestrictUser, useFriendRequestActions, useFollowActions, useSavedProfileActions.
Components: 1 UserAvatarButton (everywhere a photo appears; opens mini/full; respects
disabled/unavailable; verified badge) · 2 UserNameButton · 3 UserMiniProfileCard (photo,
name, username, verified, relationship label, trust badge if any, shared context, public
languages/interests; actions View Profile/Message-or-Request/Add Friend-Request Sent-Accept-
Decline/Follow-Unfollow/Save-Unsave/Invite/Mute/Restrict/Block/Report) · 4 ProfileActionBar
· 5 UserOverflowMenu (View Profile/Message/Add-Remove Friend/Follow-Unfollow/Save-Unsave/
Invite/Mute/Restrict/Block/Report/Share Profile/Copy Profile Link; unavailable hidden/
disabled w/ safe copy) · 6 RelationshipBadge (Friend/Follows you/You follow them/Same
Event/Same Circle/Trip Crew/Booking/Host/Provider/Past Connection/New Traveler/Restricted/
Unavailable) · 7 MessageRequestCard (sender preview, intent, "Known from", verification/
trust badge, safe first-message preview, Accept/Decline/Block/Report/View Profile) · 8
ReportUserSheet · 9 BlockUserConfirmSheet (explains can't message/can't view full profile/
can't invite-tag-book/you'll stop seeing them/they won't be notified) · 10 RestrictUserSheet
· 11 MuteUserSheet · 12 PrivacySettingsScreen/section if absent · 13 SocialSafetyControls
Screen (who can message/add/tag/invite me; profile/trip/location visibility; online/read-
receipt; blocked/muted/restricted lists; hidden recommendations; comfort settings) · 14
KnownFromRow ("Known from: Tokyo Food Crawl"/"Solo Travelers Circle"/"Rent a Buddy booking"/
"No shared context").
Profile visibility: full/limited/private-unavailable exactly per spec, and NEVER reveal
"blocked you"/"reported you"/safety penalties/exact live location/hotel/private trip
details/internal trust penalties/safety contacts/ID docs/payment info.

PHASE 5 GATE — prove it and self-pass:
- Paste grep/ls proving each hook + each of the 14 components exists.
- Paste typecheck output (must be clean; errors = FAIL, fix + re-run + paste).
- Paste frontend/component test output where supported: avatar opens profile/mini; Profile
  ActionBar shows correct buttons from a MOCKED permission response; message-request accept/
  decline/block/report; block confirmation; private/unavailable state; relationship badge;
  tag mention opens profile.
- Paste a grep proving none of the forbidden fields (blocked-you/reported-you/exact
  location/hotel/payment/ID) are rendered in the profile components.
- Append Phase 5 log entry. Paste it.
- Mark ✅ only if components exist, typecheck clean, tests green, forbidden-field grep
  empty. STOP.
----- END AGENT MESSAGE -----

Human review before Phase 6: confirm typecheck clean; confirm unavailable/limited states
render safely; confirm no forbidden info exposed.

================================================================================
## PHASE 6 — WIRE ACROSS THE APP  [SAFETY-CRITICAL]
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 6 of 8 — WIRE ACROSS APP. SAFETY-CRITICAL gate. Re-read GLOBAL RULES. Make profile-tap
+ permission checks consistent everywhere: tapping any avatar/display name/@mention opens
mini/full profile via the SAME engine + rules in: Pulse, Comments, Likes/Reactions,
Telegraph, Message Requests, Discovery, Events, Event attendees, Circles, Circle members,
Trips, Trip Crew, Rent a Buddy, Reviews, Tags/Mentions, Search results, Notifications/
Activity Center.
Context rules: Events (attendee clicks use engine; host approve/reject/remove; host mute/
remove/ban per role; attendee DMs default to group first unless allowed; direct DM unlocks
after acceptance/check-in or mutual opt-in; attendee-list privacy; detect block conflicts +
protect blocker privately). Circles (member clicks use engine; admins approve/remove/mute/
ban per roles; circle privacy; no bypass via membership). Trip Crew (temporary, not auto-
friendship; chat expires/archives after trip; post-trip suggest friend/follow only if both
eligible; live/location explicit + time-limited; blocked users never get Safe Return/
location). Rent a Buddy (provider profiles same system + provider context; booking chat
context-specific; pre-booking chat limited; off-app payment/contact restricted/warned;
adult-dating/non-service flagged; booking ≠ auto-friendship; reviews unlock only after
verified completed booking). Reviews (only after verified interaction: completed event/
completed booking/confirmed Trip Crew/confirmed participation; block-report prevents revenge
reviews or routes to moderation; separate public review/private feedback/safety report).
Unknown-user messaging flow: tap Message→engine check→if allowed open request composer→
choose intent (Event question/Trip Crew/Local rec/Rent a Buddy/Friendship/Circle invite/
Safety-check-in/Other)→one short message→block links/media/contact for new/untrusted→
recipient gets request→Accept/Decline/Block/Report/View Profile→accepted becomes chat→
declined→cooldown→sender gets safe status only.
Sender-side warnings (safe copy) when content asks for hotel/live location, pushes off-app
too fast, requests payment (Cash App/Zelle/Venmo/PayPal/crypto/gift card/wire), uses adult-
dating language in RaB, is aggressive repeated follow-up, or has suspicious links.
Notifications/Activity Center: message-request received/accepted, friend-request received/
accepted, followed-you (if enabled), tagged-you, tag-approval request, event/circle/trip
invites, RaB booking request/update, report update, safety alert. Notification privacy:
unknown-request push hides sensitive text; sensitive travel/location hidden from lock-screen
previews; never notify someone they were blocked; never reveal exact report punishment.

PHASE 6 GATE — SAFETY-CRITICAL, prove it and self-pass:
- Paste a grep across each surface (Pulse/Comments/Telegraph/Discovery/Events/Circles/
  Trips/RaB/Reviews/Search/Notifications) showing the profile-open + permission hook is
  wired in each.
- Paste evidence (test or endpoint trace) that a blocked user is NOT reachable from a
  SECOND surface (e.g. blocked in DMs is also blocked via event attendee list) — proving
  no cross-screen bypass.
- Paste evidence that Trip Crew / Safe Return location is withheld from a blocked user.
- Paste typecheck output (clean) and that existing flows still build.
- Append Phase 6 log entry (+ any bug/fix). Paste it.
- Mark ✅ only if every surface shows the wired hook AND cross-screen block-bypass evidence
  is green. STOP.
----- END AGENT MESSAGE -----

Human review before Phase 7: spot-check 2–3 surfaces yourself; confirm the cross-screen
no-bypass evidence is real.

================================================================================
## PHASE 7 — SAFETY, MODERATION, EMERGENCY CONTROLS  [SAFETY-CRITICAL]
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 7 of 8 — SAFETY/MODERATION/EMERGENCY. SAFETY-CRITICAL gate. Re-read GLOBAL RULES.
- Finalize evidence preservation + report flow.
- Admin/moderation (extend existing if present): view account state, verification,
  relationship summary, reports received/submitted, block/mute/restrict counts, message-
  request abuse signals, event/circle removals, booking disputes, recent risky contexts
  (within privacy rules), moderation actions, audit log, appeal status. Actions: warn,
  limit messaging/invites/hosting, hide from Discovery, freeze RaB provider, remove content,
  remove from event/circle, suspend, ban, restore, resolve report, lock evidence, freeze
  chat/event/booking. EVERY admin action audited; NO secret relationship changes.
- Finalize anti-retaliation cooldowns.
- Emergency controls (feature flags/config foundation, backend-first if UI too big): disable
  unknown message requests, disable new event creation, disable RaB bookings, disable
  tagging, disable location sharing, disable profile search, disable media uploads, freeze a
  city/event/circle/booking during an incident.
- Optional QA/dev-only interaction tester: "View User A interacting with User B from Context
  C" → relationship label, profile visibility, allowed/denied actions, reason codes, safety
  warnings.

PHASE 7 GATE — SAFETY-CRITICAL, prove it and self-pass:
- Paste tests proving every admin action writes an audit-log row (and that no admin path
  changes a relationship without an audit entry).
- Paste evidence each emergency flag actually gates the feature (flip flag → feature
  blocked).
- Paste anti-retaliation test output.
- Append Phase 7 log entry (+ any bug/fix). Paste it.
- Mark ✅ only if audit-on-every-admin-action proven AND each emergency flag proven to gate.
  STOP.
----- END AGENT MESSAGE -----

Human review before Phase 8: confirm admin auditing is genuine; confirm emergency flags
work.

================================================================================
## PHASE 8 — VERIFICATION & REGRESSION
================================================================================

----- AGENT MESSAGE (paste this) -----
Phase 8 of 8 — FULL VERIFICATION & REGRESSION. Re-read GLOBAL RULES.
- Run existing tests + ALL new tests; typecheck/lint.
- Confirm the app still builds.
- Confirm existing flows still work: Pulse, Discovery, Trips, Passport, Telegraph, Events,
  Circles, tagging, hashtags, Rent a Buddy, Safe Return.
- Confirm no migration broke existing data.
- Confirm no screen crashes when the permission endpoint returns limited/unavailable.
Acceptance criteria (all must hold): consistent profile navigation everywhere; one shared
engine controls actions; unknown DMs go through requests; friend requests work; follow/save
work; block app-wide + unbypassable cross-screen; mute/restrict work or safe backend
foundation; reports work w/ context + evidence; privacy settings influence permissions;
event/circle/trip/RaB return correct labels; tags/mentions respect block + privacy; deep
links respect checks; suspended/deactivated/deleted unavailable; admin/moderation has basic
visibility + audit; existing features not broken; tests prove critical safety paths; new UI
follows design system.
Non-goals (do NOT build): complex compatibility-scoring UI, public profile-view names,
contact import, paid boosts, shared expenses, city-moderator program, public follower-count
clout, minors mode (launch assumption 18+).

PHASE 8 GATE — prove it and self-pass:
- Paste the FULL test-suite output (existing + new) with total pass/fail counts. Any
  failure = FAIL; fix, log, re-run, paste fresh output.
- Paste typecheck/lint output (clean).
- Paste a build-success indicator.
- Go through the acceptance-criteria list and, for EACH item, paste the one piece of
  evidence that proves it (a test name, a grep, an endpoint result).
- Append the final Phase 8 log entry summarizing the whole build, every bug found + fixed,
  and anything deferred. Paste it.
- Mark ✅ COMPLETE only if all tests green, typecheck clean, app builds, and every
  acceptance item has pasted evidence. STOP.
----- END AGENT MESSAGE -----

Final principle (the build exists to enforce this): every time one user tries to see,
message, tag, invite, follow, friend, save, block, report, book, review, or join another
user, the app asks the SAME permission engine first. Safety, privacy, and block rules
override everything.
