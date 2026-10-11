/**
 * Account-deletion coverage manifest.
 *
 * WHY THIS EXISTS. executeAccountDeletion keeps an ANONYMISED TOMBSTONE profile
 * rather than deleting profiles(id), so no FK cascade hanging off profiles ever
 * fires — every table has to be cleared by hand. The hand-written list covers
 * 24 tables. Measured against production on 2026-08-22, **255 tables carry a
 * user-identifying column and 229 of them are untouched by deletion**: every
 * behavioural, presence and location row a user ever generated survives account
 * deletion indefinitely, keyed to a uuid that is still joinable across tables.
 *
 * This manifest does not fix that. It makes it IMPOSSIBLE TO GROW SILENTLY.
 * Modelled on rlsDispositions.ts: every user-linked table in the baseline must
 * appear in exactly one bucket below, and checkDeletionCoverage.ts fails if a
 * NEW one appears in none of them. A new table therefore cannot enter the blind
 * spot without someone writing down what happens to it on deletion.
 *
 * WHICH TABLES THOSE ARE IS NOW MEASURED, NOT GUESSED (2026-09-08). The gate
 * used to find user-keyed tables by matching 18 recognised COLUMN NAMES, which
 * reported 248 tables. A column name is a convention, not a fact: a table can
 * hold a person's uuid behind a foreign key and carry no recognised name at all.
 * src/lib/deletion/userLink.ts derives the universe from the FOREIGN KEY GRAPH
 * of the committed baseline instead, and the answer is 366 — 296 with a direct
 * foreign key to profiles/auth.users, 30 owned indirectly through another owned
 * row, 31 derived from an unbacked user column or a hand registration, and 9
 * AMBIGUOUS. The 91 tables that difference uncovered — blocks, appeals,
 * moderation_actions, reviews, media_assets, user_restrictions, user_mutes,
 * safe_return_contacts, trip_documents and `profiles` itself among them — are in
 * DENOMINATOR_CORRECTION_BACKLOG below, with the reason each one is in scope
 * available per table from the user-link graph.
 *
 * THE BUCKETS ARE NOT EQUIVALENT:
 *   ERASED_BY_CASCADE       — the service actually deletes these today.
 *   RETAINED_WITH_REASON    — a DECIDED retention, with the reason written down.
 *   AWAITING_OWNER_DECISION — the fate is a NAMED open owner decision whose two
 *                             answers are already written, and the schema
 *                             refuses the DELETE meanwhile so neither answer is
 *                             taken by default. Triaged, not decided.
 *   UNCLASSIFIED_BACKLOG    — NOT a decision. Pre-existing tables nobody has
 *                             triaged. Being on this list means the data survives
 *                             deletion and no one has said whether it should.
 *
 * Emptying UNCLASSIFIED_BACKLOG is owner decision D6 in the A0 packet. Entries
 * move to ERASED_BY_CASCADE (with matching code in AccountDeletionService) or to
 * RETAINED_WITH_REASON (with a reason a user could be shown). Nothing should be
 * left here permanently.
 */

/** Tables AccountDeletionService clears today. */
export const ERASED_BY_CASCADE: readonly string[] = [
  // PENDING BASELINE RECAPTURE — do not add the string yet.
  //   "phone_verification_challenges" (migration 2142) holds a phone number and
  //   a hashed live credential, and IS already deleted explicitly by
  //   AccountDeletionService (step "delete_phone_challenges") — not by its FK,
  //   because the tombstone profile means no cascade off profiles ever fires.
  //   It cannot be listed here until the baseline snapshot is recaptured: this
  //   gate reads baseline/20260819_baseline_structure.sql and rejects entries it
  //   cannot see as "STALE". Add the string in the same change that recaptures
  //   the baseline.
  // Erased by a DATABASE CONSTRAINT, not by service code — the one entry here
  // that AccountDeletionService never names. passport_stamps_gps.user_id
  // REFERENCES auth.users ON DELETE CASCADE, and step 5 calls
  // auth.admin.deleteUser, so the coordinates go. Verified against the live
  // schema on 2026-08-23; it sat in UNCLASSIFIED_BACKLOG until then because the
  // absence of a service reference was read as absence of deletion.
  //
  // Its PARENT is the open question, not this: passport_stamps references
  // profiles, which on production has no FK to auth.users, so the stamp itself
  // survives while its coordinates do not. That stays with D6.
  "passport_stamps_gps",
  // Layover (census-layover L163; lead ruling 2026-10-07). AccountDeletionService's
  // FATAL layover block deletes the traveller's crew memberships
  // (`delete_layover_crew_memberships`) and sessions (`delete_layover_sessions`);
  // every table below hangs off layover_sessions ON DELETE CASCADE (0127, 2700,
  // 2984, 2992, 3900), so the session delete takes them in the same statement.
  // layover_events is NOT here: OD-MAP-4 keeps it pseudonymised for at most 12
  // months (RETAINED_WITH_REASON below). The post-baseline ones are named in
  // POST_BASELINE_TABLES.
  "layover_sessions",
  "layover_plan_stops",
  "layover_recommendations",
  "layover_presence",
  "layover_crews",
  "layover_crew_members",
  "layover_constraints",
  "layover_time_budgets",
  "layover_return_plans",
  "layover_checkpoints",
  "layover_outcomes",
  "layover_certified_computations", "layover_event_pseudonymisation_dead_letters", // 3622 (PR-R-L163a): session id, failure text and times; erased with its session (ON DELETE CASCADE)
  // IG-02 intel tables. Registered here in the SAME change that creates them:
  // a new user-keyed table gets a deletion fate on day one, which is the whole
  // point of this manifest. Their append-only triggers permit DELETE only inside
  // a declared erasure (SET LOCAL portava.erasure_in_progress).
  "intel_observations",
  "intel_claims",
  "intel_evidence",
  "intel_confirmations",
  "intel_state_snapshots",
  // Unit I3 presence-verification audit rows (migration 2276). observation_id
  // and actor_id both cascade: erase_intel_for_actor deletes the actor's
  // observations inside its erasure declaration, so the cascade is permitted by
  // the ROW-LEVEL append-only trigger and the rows go with the observation.
  // Coarse buckets only — never a coordinate — so nothing precise outlives the
  // actor.
  //
  // That was only true on paper until 2292. 2276 also attached the
  // STATEMENT-level guard that 2137 had removed, and a statement-level BEFORE
  // trigger fires before any row is examined — so it refused the profiles
  // cascade even when the user had produced no verification row at all, making
  // the account undeletable either way. Observed live: every test in
  // rlsHardening.test.ts failed on PR #402 with "purgeFixtures: delete
  // profiles: intel_presence_verifications is append-only: DELETE is not
  // permitted at statement level". 2292 drops it; the row-level guard, which is
  // what makes this disposition true, is untouched.
  "intel_presence_verifications",
  // IG-02 contribution consent (migration 2172, user_id-keyed). Its ON DELETE
  // CASCADE to profiles never fires because the deletion keeps an anonymised
  // tombstone profile — the same mistake 2187 made for derived memory. Erased
  // explicitly by AccountDeletionService's `delete_intel_consent` step (a direct
  // scoped delete; the table is not append-only), with service_role DELETE
  // granted by migration 2203.
  "intel_contribution_consent",
  // IG-10 non-cash reward ledger (migration 2170, actor_id-keyed). Its ON DELETE
  // CASCADE to profiles never fires under the tombstone (same as consent above),
  // so a departed contributor's earning rows would survive while the observations
  // that earned them are erased by erase_intel_for_actor. Erased explicitly by
  // AccountDeletionService's `delete_intel_reward_ledger` step (a direct scoped
  // delete; the ledger has no DELETE-blocking trigger), with service_role DELETE
  // granted by migration 2204. Non-cash, so no financial-retention reason to keep it.
  "intel_reward_ledger",
  // I4a attribution ledger (migration 2277, actor_id = the CONTRIBUTOR). Erased
  // with the contributor's observations: observation_id REFERENCES
  // intel_observations ON DELETE CASCADE, and that cascade fires INSIDE
  // erase_intel_for_actor's declared-erasure transaction (the reused 2130
  // append-only trigger permits DELETE there). The profiles cascade never fires
  // under the tombstone, but it does not need to — every row hangs off an
  // observation the erasure function already removes. The outcome REPORTER is
  // not named on this table (their id stays on the canonical_events spine row,
  // whose retention 2120 governs). erase_intel_for_actor (widened by 2278) also
  // deletes it by actor_id explicitly, so nothing waits on the cascade.
  //
  // 2277 also re-attached 2137's removed STATEMENT-level guard here, which
  // refused any profiles/intel_observations delete that merely TOUCHED the
  // table, zero rows included. Removed by 2292 — see the note on
  // intel_presence_verifications above. The row-level guard, the one this
  // disposition depends on, is untouched.
  "intel_attributions",
  // I4a scoped-trust fold (migration 2278, actor_id = the CONTRIBUTOR). Mutable
  // derived state whose profiles cascade never fires under the tombstone, so it
  // is deleted EXPLICITLY inside erase_intel_for_actor (re-created by 2278 as a
  // superset of 2130's body) — the same declared-erasure RPC the worker already
  // calls. Attribution rows for the actor are deleted there too, so nothing
  // waits on a cascade.
  "intel_scoped_trust",
  "comment_likes",
  "devices",
  "event_saves",
  "hidden_gem_saves",
  "hidden_gems",
  "identity_verifications",
  "messages",
  "notification_devices",
  "notifications",
  "post_media",
  "post_reactions",
  "post_saves",
  "post_shares",
  "posts",
  "posts_comments",
  "posts_likes",
  "saved_places",
  "search_history",
  "stories",
  "story_reactions",
  "story_replies",
  "story_views",
  "user_follows",
  "wishlist_places",
  // Trip "Memories" UGC + engagement (audit MEM·H2). AccountDeletionService now
  // collects each memory_item's media path (post-media/memories/{userId}/…)
  // BEFORE deleting, removes the storage objects, and clears the rows: the
  // user's owned memories (owner_id, all states incl. soft-deleted), their
  // children (memory_items, memory_tags/likes/saves by memory_id), and the
  // footprint the user left on other people's memories (likes/saves by user_id,
  // tags by tagged_user_id). memory_items and memory_tags are NOT listed here:
  // this manifest only tracks tables carrying a USER_IDENTIFYING_COLUMN, and
  // neither has one (memory_id / tagged_user_id are not in that set) — the
  // coverage check would flag them as STALE.
  "memories",
  "memory_likes",
  "memory_saves",
  // Passport / Wall owner-scoped tables (migrations 2260 / 2261 / 2271), each
  // keyed by user_id REFERENCES profiles(id) ON DELETE CASCADE. That cascade
  // never fires under the tombstone profile — the same mistake 2172/2170/2187
  // made for consent/reward-ledger/derived-memory — so the rows would survive
  // deletion as orphaned personal data (wall_session_intents even stores a
  // raw_text echo of typed input). Erased explicitly by AccountDeletionService's
  // `delete_availability_windows` / `delete_travel_dna_prefs` /
  // `delete_wall_session_intent` steps (direct scoped deletes keyed by user_id;
  // none is append-only). service_role already holds DELETE on all three (2260
  // and 2271 grant it explicitly; 2261 inherits it from Supabase default
  // privileges — verified against CI), so no grant migration was needed.
  "availability_windows",
  "passport_travel_dna_prefs",
  "wall_session_intents",
  // Temporary event Passport shares (migration 2294), user_id-keyed with
  // ON DELETE CASCADE to profiles — the same tombstone problem as the three
  // above, so the share rows (which name an event the user attended) would
  // survive deletion. Not append-only; erased by the
  // `delete_event_passport_shares` step. service_role holds DELETE (2294
  // grants it explicitly).
  "event_passport_shares",
  // Wall §32 telemetry (migration 2308). Unlike the three above, this one is
  // keyed by viewer_id REFERENCES auth.users(id) ON DELETE CASCADE — the same
  // mechanism rank_events uses — so the cascade DOES fire: the deletion flow
  // removes the auth.users row even though it keeps an anonymised profiles
  // tombstone. That FK was chosen deliberately over a profiles-keyed one for
  // exactly the reason the comment above records. (map_telemetry_events, the
  // table this one is modelled on, has NO foreign key at all and therefore
  // survives deletion; that is a Map-lane defect, not a pattern to copy.)
  "wall_telemetry_events",
  // Derived memory (migrations 2183-2191). Erased explicitly by
  // AccountDeletionService's `erase_derived_memory` step, which calls the
  // SECURITY DEFINER erase_memory_for_user in one atomic, idempotent statement.
  // Deliberately NOT left to a foreign-key cascade: production's public.profiles
  // has no FK to auth.users, and the service keeps an anonymised tombstone
  // profile rather than deleting the row, so a profiles-keyed cascade can never
  // fire. Migration 2187 assumed it would; 2190 corrected it.
  "memory_projections",
  "memory_events",
  "memory_feedback",
  // Provenance spine (migration 2320). Same fate and the same mechanism as the
  // three above: erase_memory_for_user was EXTENDED rather than duplicated, so
  // one call still purges everything. memory_evidence is deleted FIRST and by
  // user_id directly — not by traversing episodes and not by leaning on the
  // episode cascade — so a memory the user forgets cannot survive in evidence
  // even if the episode delete were to fail.
  "memory_episodes",
  "memory_evidence",
  // Input-assistance opt-ins and outcome counters (migrations 3780 / 3782).
  // Each is keyed by user_id REFERENCES auth.users(id) ON DELETE CASCADE — the
  // wall_telemetry_events mechanism, not a profiles-keyed one — so the rows go
  // when AccountDeletionService's final step calls auth.admin.deleteUser, even
  // though the profiles row is kept as a tombstone. No service step names them.
  // (input_outcome_task_daily, migration 3783, carries no user column at all:
  // it is a day/context/task aggregate, so it is not user-keyed and not listed.)
  "input_outcome_consent",
  "input_outcome_counters",
  "input_memory_context_consent", "memory_deletion_dead_letters", "memory_resurfacing_preferences", "memory_corrections", "nearby_proximity_observations", "availability_audience_policies", "nearby_consents", "eta_coordination_grants", "memory_relations", "memory_id_redirects", "telegraph_thread_member_mutes", /* 3661 (lane T-GRP, unapplied): telegraph_thread_member_mutes.user_id AND .muted_by REFERENCE auth.users(id) ON DELETE CASCADE, so a host mute goes with either account at AccountDeletionService's final step (auth.admin.deleteUser); telegraph_thread_controls carries no person column and is not user-keyed. */ /* 2994 + 3674 (docs/architecture/memories-graph-model-decision.md §3.5): memory_relations is erased by 3674's row triggers, NOT by its owner_id -> profiles cascade (the tombstone means that never fires): a Memory hard-deleted (AccountDeletionService deletes every Memory by owner_id) takes every relation it sources or targets, a memory_tags row deleted (deleted by tagged_user_id) or moved out of approved takes its PERSON edge, an episode deleted (erase_memory_for_user) takes its EPISODE relations; memory_id_redirects CASCADEs from both Memories and from auth.users. Rehearsed in sql/rehearsals/3674_01 (S12). */ // 3673 (§AO, §AP): the owner's place corrections, append-only. ERASURE DELETE (lead ruling H-13): per Memory, the §21 lifecycle (memoryDeletionLifecycle RAW_EVIDENCE_PURGED → memoryCorrections.eraseCorrectionsForDeletedMemory) deletes a deleted Memory's corrections — service_role holds DELETE for that path only, and 3673's memory_corrections_guard() refuses any DELETE while the Memory is live and its owner exists; per account, the same two FK cascades as 3670. 3671 (§AJ): per-Memory §11 controls, erased by the same two FK cascades as 3670. 3670 (census-highlights-memories §AF): §21 dead letters, erased by FK CASCADE from public.memories (account deletion hard-deletes every Memory) and from auth.users (its final step); no service step names it. One line so cited lines below hold. | lane T, migrations 3651 / 3652 (unapplied): every user column CASCADEs from profiles (Telegraph §4.3 observation budget; §4.1 audience policies, Nearby opt-in, mutual ETA grants)
  // OD-MAP-6 sensing consents (migration 3703): user_id REFERENCES
  // auth.users(id) ON DELETE CASCADE, the same mechanism as the three above, so
  // the rows go with AccountDeletionService's final auth.admin.deleteUser.
  "sensing_consent_grants",
  // CPH-08-ADAPT live-search quota (migration 3704): user_id REFERENCES
  // auth.users(id) ON DELETE CASCADE — the same mechanism.
  "compass_live_search_usage",
];

/**
 * Tables the service does NOT delete, but where it NULLs a user-identifying
 * column on deletion — the 'anonymised / FK nulled' fate. The ROW is retained
 * (it is an operational record, not the user's content) and only the identifier
 * is removed. Distinct from ERASED_BY_CASCADE, whose rows are gone entirely.
 *
 * These carry a column declared `REFERENCES profiles(id) ON DELETE SET NULL`,
 * whose SET NULL never fires because the deletion keeps an anonymised TOMBSTONE
 * profile rather than deleting profiles(id) — so the service performs the SET
 * NULL by hand, restoring the FK's own declared intent.
 */
export const ANONYMISED_FK_NULLED: readonly string[] = [
  // intel_mission_candidates.accepted_by (migration 2167) names the contributor
  // who accepted a dispatched mission. The row is a city-scoped ops record with
  // no other user-identifying column, so it is kept while accepted_by is NULLed by
  // AccountDeletionService's `null_intel_mission_accepted_by` step — exactly what
  // the column's ON DELETE SET NULL declared, which the tombstone otherwise
  // silently defeats. UPDATE granted to service_role by 2167 and reaffirmed by 2211.
  "intel_mission_candidates",
];

/**
 * Tables read or written by the deletion flow itself, not user content to erase.
 */
export const DELETION_FLOW_TABLES: readonly string[] = [
  "user_account_states",
  "user_deletion_requests",
];

/**
 * DECIDED retentions. Each entry needs a reason a user could be shown.
 * Empty until D6 is answered — deliberately, so the backlog count stays honest.
 */
export const RETAINED_WITH_REASON: ReadonlyArray<{ table: string; reason: string }> = [
  // The layover decision ledger (census-layover L163; lead ruling 2026-10-07
  // adopting OD-MAP-4). AccountDeletionService's `pseudonymise_layover_events`
  // removes the user and the session, sets one random pseudonym per deletion,
  // empties the metadata and stamps retain_until 365 days out; migration 3621's
  // CHECK refuses a row that is half-identified or kept past 12 months, and
  // lib/layoverAuditRetentionScheduler.ts deletes it at retain_until. Without
  // 3621 the rows are erased with their sessions instead (0127's cascade).
  {
    table: "layover_events",
    reason:
      "OD-MAP-4 (docs/ops/owner-decisions-20261004.md): a pseudonymised, access-restricted audit record kept for at most 12 months, then deleted. " +
      "On account deletion the row loses its user and session, carries a random per-deletion pseudonym and no metadata, and is deleted at retain_until (365 days) by the layover audit retention sweep.",
  },
  // I1 (migration 2273). NOT user-keyed: it carries no actor column and no
  // personal data — subject_id is a place, distinct_actors is a count, and the
  // replay record is a set of weighted model inputs. It is an append-only log of
  // what the projection computed, keyed by (place, zone, claim_type); nothing in
  // it can be attributed to a person, so account deletion leaves it alone. The
  // per-person inputs behind a version are erased through erase_intel_for_actor
  // (observations, evidence, confirmations); a version row remains as the record
  // that an aggregate was once computed — the same posture as intel_claims and
  // intel_state_snapshots, which erase_intel_for_actor deliberately does not
  // touch ("aggregate beliefs about a place, not personal data"). Listed here so
  // the fate is written down, not inherited silence.
  {
    table: "intel_state_snapshot_versions",
    reason:
      "Append-only projection history with no actor column and no personal data (place key, counts, model inputs). " +
      "The per-person contributions behind it are erased by erase_intel_for_actor; the aggregate record is kept, as intel_claims/intel_state_snapshots are.",
  },
  // The creator ledger's RULE CATALOGUE (migration 2920), registered in the same
  // change that classified the four ledger tables it prices. It is in this
  // bucket, and NOT in AWAITING_OWNER_DECISION below, because C-11 is a question
  // about EARNING RECORDS and this table holds none: its seven columns are
  // creator_type, rule_version, params, effective_from, note, created_at and id
  // — no beneficiary, no actor, no person-shaped uuid of any kind, and six
  // seeded rows written by the migration itself before any account exists.
  // Neither held answer mentions it (3511 and 3512 both name exactly the four
  // ledger tables), so retaining it resolves nothing the owner has to decide.
  //
  // It is also the one table here that no erasure path could reach even if it
  // tried: 2920 grants service_role INSERT and SELECT only and asserts in its
  // own postconditions that service_role has neither UPDATE nor DELETE
  // ("a rule version can be deleted; history would be unreconstructable"), so
  // the retention is a property of the grants, not a promise in a comment.
  {
    table: "creator_rule_versions",
    reason:
      "The versioned rule set that prices creator value (07 §8/§10) — creator_type, rule_version, params, effective_from, note. " +
      "No beneficiary, no actor and no personal data: the rows are seeded by migration 2920 before any account exists, and service_role holds INSERT/SELECT only (no DELETE), so a rule lineage cannot be deleted at all. " +
      "Retained so that an earning record naming a rule_version stays reconstructable; the earning records themselves are the open C-11 decision, not this.",
  },
  // Rent-a-Buddy payments (migration 3931, lane B 2026-10-05): the provider
  // webhook DEDUPLICATION log. Its eight columns are provider, provider_event_id,
  // endpoint ('platform' | 'connect'), event_type, occurred_at, received_at,
  // processed_at and outcome — no party, no profile, no payload, no amount. The
  // event body is never stored (the allow-listed projection lands on the payment
  // row it concerns, which is retained below under OD-PAY-8). Same posture as
  // the two entries above: kept because nothing in it is a person's row.
  {
    table: "payment_webhook_events",
    reason:
      "A record of which payment-provider notifications were received and processed, so a re-delivered notification is not applied twice. " +
      "No person, no account and no amount: the columns are the provider's event id and type, which endpoint it reached, and when it was received and processed. " +
      "Migration 3931 grants service_role SELECT/INSERT/UPDATE only (no DELETE) and fails if it ever could delete.",
  },
  // The Rent-a-Buddy payment slice's four money tables (migration 3931, lane B).
  // Moved here from AWAITING_OWNER_DECISION on 2026-10-06 (lead ruling, to match
  // lane P's #592): OD-PAY-8 decided the fate (pseudonymised retention, C-11
  // answer B), and the period is the owner's DEFAULT pending legal confirmation.
  {
    table: "rent_buddy_payment_recipients",
    reason:
      "The buddy's provider account reference (recipient_ref), country, settlement currency, onboarding state and the provider's requirement CODES only: never a document, number or date of birth. Keyed by party_id. " +
      "OWNER DECISION OD-PAY-8 / C-11 answer B (docs/ops/owner-decisions-20261004.md; question 22(a)), the same ruling lane P applies to the creator ledgers in PR #592: \"Pseudonymize accounting entries, removing direct identifiers and the identity link when deletion is requested. Keep only the records needed for tax, accounting, disputes, or legal claims, with a defined retention period\" (GDPR Art. 17(3)(b) legal obligation and 17(3)(e) legal claims). Pseudonymised by construction: every column naming a traveller or buddy is a payment party id (3821, ON DELETE RESTRICT), never a profile id, so removing the identity link (payment_parties.profile_id SET NULL, payment_party_remove_identity) changes one payment_parties row and no row here. PERIOD: the owner's DEFAULT, seven years after fiscal year-end, with jurisdiction-specific legal periods overriding it, PENDING LEGAL CONFIRMATION (not approved; 3823 payment_retention_settings stays seeded undecided). No purge: nothing deletes these rows on any schedule, so nothing is erased early. Migration 3931 grants service_role SELECT/INSERT/UPDATE and NOT DELETE, and fails if it ever could delete. NOT YET PSEUDONYMISED BY ACCOUNT DELETION: AccountDeletionService keeps a tombstone profile and does not call removePaymentIdentity (services/payments/PaymentLedger.ts, \"NOT YET CALLED\", PAY-T23), so after a deletion the party still links to the tombstone's uuid until that step is wired.",
  },
  {
    table: "rent_buddy_monthly_payouts",
    reason:
      "One row per (party, provider, currency, month). held_by / released_by name the ADMIN who held or released a payout (a staff audit fact, no FK) and hold_reason / release_reason are free text up to 2000 characters. " +
      "OWNER DECISION OD-PAY-8 / C-11 answer B (docs/ops/owner-decisions-20261004.md; question 22(a)), the same ruling lane P applies to the creator ledgers in PR #592: \"Pseudonymize accounting entries, removing direct identifiers and the identity link when deletion is requested. Keep only the records needed for tax, accounting, disputes, or legal claims, with a defined retention period\" (GDPR Art. 17(3)(b) legal obligation and 17(3)(e) legal claims). Pseudonymised by construction: every column naming a traveller or buddy is a payment party id (3821, ON DELETE RESTRICT), never a profile id, so removing the identity link (payment_parties.profile_id SET NULL, payment_party_remove_identity) changes one payment_parties row and no row here. PERIOD: the owner's DEFAULT, seven years after fiscal year-end, with jurisdiction-specific legal periods overriding it, PENDING LEGAL CONFIRMATION (not approved; 3823 payment_retention_settings stays seeded undecided). No purge: nothing deletes these rows on any schedule, so nothing is erased early. Migration 3931 grants service_role SELECT/INSERT/UPDATE and NOT DELETE, and fails if it ever could delete. NOT YET PSEUDONYMISED BY ACCOUNT DELETION: AccountDeletionService keeps a tombstone profile and does not call removePaymentIdentity (services/payments/PaymentLedger.ts, \"NOT YET CALLED\", PAY-T23), so after a deletion the party still links to the tombstone's uuid until that step is wired.",
  },
  {
    table: "rent_buddy_booking_payments",
    reason:
      "One row per payment attempt: amounts, commission, tax components, provider references and an allow-listed projection of the provider's object (no client secret, name, email, phone, address or card digits). booking_id -> rent_buddy_bookings ON DELETE RESTRICT. " +
      "OWNER DECISION OD-PAY-8 / C-11 answer B (docs/ops/owner-decisions-20261004.md; question 22(a)), the same ruling lane P applies to the creator ledgers in PR #592: \"Pseudonymize accounting entries, removing direct identifiers and the identity link when deletion is requested. Keep only the records needed for tax, accounting, disputes, or legal claims, with a defined retention period\" (GDPR Art. 17(3)(b) legal obligation and 17(3)(e) legal claims). Pseudonymised by construction: every column naming a traveller or buddy is a payment party id (3821, ON DELETE RESTRICT), never a profile id, so removing the identity link (payment_parties.profile_id SET NULL, payment_party_remove_identity) changes one payment_parties row and no row here. PERIOD: the owner's DEFAULT, seven years after fiscal year-end, with jurisdiction-specific legal periods overriding it, PENDING LEGAL CONFIRMATION (not approved; 3823 payment_retention_settings stays seeded undecided). No purge: nothing deletes these rows on any schedule, so nothing is erased early. Migration 3931 grants service_role SELECT/INSERT/UPDATE and NOT DELETE, and fails if it ever could delete. NOT YET PSEUDONYMISED BY ACCOUNT DELETION: AccountDeletionService keeps a tombstone profile and does not call removePaymentIdentity (services/payments/PaymentLedger.ts, \"NOT YET CALLED\", PAY-T23), so after a deletion the party still links to the tombstone's uuid until that step is wired.",
  },
  {
    table: "rent_buddy_payment_refunds",
    reason:
      "Who asked for a refund, by role and (for a traveller or buddy) by party; support is the role 'admin' with no party. booking_payment_id -> rent_buddy_booking_payments ON DELETE RESTRICT. " +
      "OWNER DECISION OD-PAY-8 / C-11 answer B (docs/ops/owner-decisions-20261004.md; question 22(a)), the same ruling lane P applies to the creator ledgers in PR #592: \"Pseudonymize accounting entries, removing direct identifiers and the identity link when deletion is requested. Keep only the records needed for tax, accounting, disputes, or legal claims, with a defined retention period\" (GDPR Art. 17(3)(b) legal obligation and 17(3)(e) legal claims). Pseudonymised by construction: every column naming a traveller or buddy is a payment party id (3821, ON DELETE RESTRICT), never a profile id, so removing the identity link (payment_parties.profile_id SET NULL, payment_party_remove_identity) changes one payment_parties row and no row here. PERIOD: the owner's DEFAULT, seven years after fiscal year-end, with jurisdiction-specific legal periods overriding it, PENDING LEGAL CONFIRMATION (not approved; 3823 payment_retention_settings stays seeded undecided). No purge: nothing deletes these rows on any schedule, so nothing is erased early. Migration 3931 grants service_role SELECT/INSERT/UPDATE and NOT DELETE, and fails if it ever could delete. NOT YET PSEUDONYMISED BY ACCOUNT DELETION: AccountDeletionService keeps a tombstone profile and does not call removePaymentIdentity (services/payments/PaymentLedger.ts, \"NOT YET CALLED\", PAY-T23), so after a deletion the party still links to the tombstone's uuid until that step is wired.",
  },
];

/**
 * ── A FATE THAT IS AN OPEN OWNER DECISION, NAMED AND HELD ───────────────────
 *
 * NOT A DECISION, AND NOT UNTRIAGED EITHER. This bucket exists because the four
 * buckets above could not describe the creator ledger without answering a
 * question that is the owner's to answer:
 *
 *   * ERASED_BY_CASCADE would assert the rows are deleted on erasure. That is
 *     C-11 answer A (reconciliation-staging/3511), and it is also false today:
 *     3510 refuses every DELETE of these rows with SQLSTATE CL451.
 *   * RETAINED_WITH_REASON would assert a DECIDED retention. That is C-11
 *     answer B (reconciliation-staging/3512), which additionally pseudonymises
 *     the identity — a retention this manifest cannot promise, because no code
 *     performs it and no retention period exists (question 22(a): "for the
 *     period your legal advice sets").
 *   * UNCLASSIFIED_BACKLOG and DENOMINATOR_CORRECTION_BACKLOG both mean
 *     "nobody has looked". Somebody has: both answers are written, rehearsed in
 *     a throwaway database by src/test/db/creatorLedgerErasurePolicy.db.test.ts,
 *     and held out of the chain. Filing these tables as untriaged debt would
 *     lose that, and the dated backlogs are records of what was found in
 *     2026-08-22 / 2026-09-08, not places to put a 2026-10 table.
 *
 * So the fate recorded here is the true one: the DELETE is REFUSED while a named
 * owner decision is open, and the refusal is in the schema rather than in this
 * comment. Each entry states the decision and the mechanism holding it open, and
 * check:deletion-coverage rejects an entry missing either.
 *
 * THIS IS NOT A THIRD HIDING PLACE, and the difference is mechanical: an entry
 * here must name a decision whose two answers are already written. A table whose
 * fate merely has not been thought about does not qualify — it has to be decided
 * on the day it is created, which is what the gate exists for.
 *
 * Entries leave this list when the owner answers: the chosen migration is
 * promoted out of reconciliation-staging/, the service is wired to it, and the
 * table moves to ERASED_BY_CASCADE (answer A) or to RETAINED_WITH_REASON with
 * the period the answer sets (answer B).
 */
export const AWAITING_OWNER_DECISION: ReadonlyArray<{
  table: string;
  /** The owner question, by its identifier, and where it is written down. */
  decision: string;
  /** What stops either answer being taken by default in the meantime. */
  heldOpenBy: string;
}> = [
  // The four creator / Rent-a-Buddy ledger tables, registered in the same change
  // that discovered they were in no bucket at all. All four carry money owed to
  // a named person; creator_ledger_audit_events additionally carries the ADMIN
  // who placed or released a hold (actor_user_id, a deliberate non-FK audit
  // fact) and a mandatory free-text `reason` of up to 2000 characters.
  //
  // They were invisible rather than ignored: see the migration-chain note on
  // POST_BASELINE_TABLES below. Every one of them holds zero rows on every
  // database that exists — creator_attribution_enabled (2922) and
  // rent_buddy_enabled (2210) are FALSE and the migrations are not applied to
  // production — so nothing is retained in practice by recording the question.
  {
    table: "rent_buddy_earnings_entries",
    decision:
      "C-11 / W10D-B0 (docs/ops/discovery-owner-approval-request.md question 22(a); census-discovery §107): on account erasure, are a person's earning records DELETED, or RETAINED with the direct identity removed for a statutory period? " +
      "The two answers are complete and held out of the canonical chain: reconciliation-staging/3511_creator_ledger_erasure_delete_on_erasure.sql (A) and reconciliation-staging/3512_creator_ledger_erasure_retain_pseudonymised.sql (B).",
    heldOpenBy:
      "migration 3510: a ROW-LEVEL BEFORE DELETE trigger refuses every DELETE with SQLSTATE CL451, by any path (the profile's cascade, the booking's cascade, a direct DELETE). " +
      "3510 also replaces 2901's ON DELETE SET NULL with CASCADE so an erasure reaches that refusal instead of failing as an append-only UPDATE violation that named the wrong cause.",
  },
  {
    table: "creator_attributions",
    decision:
      "C-11 / W10D-B0 (question 22(a); census-discovery §107): delete the earning records on erasure, or retain them pseudonymised? Answers held at reconciliation-staging/3511 (A) and 3512 (B).",
    heldOpenBy:
      "migration 3510's row-level BEFORE DELETE refusal (SQLSTATE CL451). Without it 2920's beneficiary_user_id ON DELETE CASCADE would silently delete a creator's whole ledger on erasure — answer A, taken by default rather than chosen.",
  },
  {
    table: "creator_earning_entries",
    decision:
      "C-11 / W10D-B0 (question 22(a); census-discovery §107): delete the earning records on erasure, or retain them pseudonymised? Answers held at reconciliation-staging/3511 (A) and 3512 (B).",
    heldOpenBy:
      "migration 3510's row-level BEFORE DELETE refusal (SQLSTATE CL451), which also catches the cascade 3387 gave this table's keys.",
  },
  {
    table: "creator_ledger_audit_events",
    decision:
      "C-11 / W10D-B0 (question 22(a); census-discovery §107): delete the earning records on erasure, or retain them pseudonymised? Answers held at reconciliation-staging/3511 (A) and 3512 (B). " +
      "This table makes the question sharper rather than easier: it names the ADMIN who acted (actor_user_id) and why (reason), so answer A erases the record of who held a creator's money and answer B pseudonymises the admin as well as the creator.",
    heldOpenBy:
      "migration 3510's row-level BEFORE DELETE refusal (SQLSTATE CL451). Its attribution_id is NOT NULL ON DELETE CASCADE, so without the refusal it would be erased with the attribution it audits.",
  },  // Lead ruling Q-L23 / D-38a (migration 3705, lane L): the reported content as
  // it was when a moderation report was filed, DELETED WITH ITS REPORT. Moved
  // here from RETAINED_WITH_REASON on 2026-10-08 (V-L6d F4): its fate on a
  // person's erasure is its report's, and that is an open owner question, so a
  // "decided" bucket overstated it.
  {
    table: "moderation_report_captures",
    decision:
      "D-38b / D-39 (the lead's consolidated owner-decision packet; census-trust §39.2): how long captured moderation evidence is kept, and whether moderation records about a person are kept (name removed) or destroyed when that person's account is erased. " +
      "Q-L23 / D-38a already decided the capture lives and dies with its moderation_reports row (ON DELETE CASCADE), and that row is itself in UNCLASSIFIED_BACKLOG for the same two questions.",
    heldOpenBy:
      "migration 3705 seeds moderation_report_capture_enabled FALSE, and routes/moderation.ts writes no capture while it is off (lib/moderationReportSnapshots.ts captureReportedContent reads the flag through readFlagState, fail-closed): no row exists for either answer to govern until the owner answers and the flag is turned on.",
  },
];

/**
 * NOT DECISIONS. Pre-existing user-keyed tables that survive account deletion and
 * that nobody has triaged. Baselined 2026-08-22 so the check can fail on NEW
 * tables while this backlog is worked down. Adding to this list is not allowed
 * for a new table — that is what the check enforces.
 */
export const UNCLASSIFIED_BACKLOG: readonly string[] = [
  // Live on production, migrations unpushed. Deletion fate is the Journey
  // workstream's decision, not this manifest's.
  "journey_observations",
  "journey_revocation_jobs",
  "journey_segment_revisions",
  "journey_shadow_cohort_assignments",
  "journey_shadow_ground_truth",
  "journey_shadow_qa_reports",
  "journey_shadow_session_issuances",
  "activity_events",
  "airport_profiles",
  "availability_nudges",
  "buddy_availability_exceptions",
  "buddy_services",
  "call_moderation_actions",
  "call_participants",
  "call_preferences",
  "circle_age_settings",
  "circle_checkins",
  "circle_context_settings",
  "circle_invites",
  "circle_member_visibility_overrides",
  "circle_memberships",
  "circle_presence",
  "circle_visibility_settings",
  "circles",
  "close_friends",
  "collections",
  "compass_active_user_badges",
  "compass_active_user_events",
  "compass_active_user_scores",
  "compass_admin_weight_sets",
  "compass_analytics",
  "compass_analytics_events",
  "compass_cache_invalidations",
  "compass_category_reputation",
  "compass_city_reputation",
  "compass_conversations",
  "compass_eligibility_logs",
  "compass_feed_cache",
  "compass_feed_sections",
  "compass_feedback",
  "compass_feedback_events",
  "compass_live_sessions",
  "compass_media_preload_manifest",
  "compass_memories",
  "compass_notification_decisions",
  "compass_outcome_events",
  "compass_preload_events",
  "compass_preload_queue",
  "compass_privacy_guard_logs",
  "compass_recent_context",
  "compass_recommendation_scores",
  "compass_safety_filter_logs",
  "compass_sense_nudges",
  "compass_sense_settings",
  "compass_served_recommendations",
  "compass_settings",
  "compass_suspension_requests",
  "compass_testing_scenarios",
  "compass_user_context_snapshots",
  "compass_user_navigation_patterns",
  "compass_user_preferences",
  "compass_user_profiles",
  "compass_visibility_boosts",
  "compass_visibility_cooldowns",
  "content_stamps",
  "creator_activity_scores",
  "daily_briefs",
  "delayed_post_location_events",
  "discovery_place_reports",
  "discovery_place_saves",
  "discovery_places",
  "discovery_shadow_serves",
  "event_activity_log",
  "event_attendee_states",
  "event_attendees",
  "event_cohosts",
  "event_drafts",
  "event_join_requests",
  "event_posts",
  "event_reminders",
  "event_reports",
  "event_roles",
  "event_rsvps",
  "event_updates",
  "event_waitlist",
  "events",
  "friend_requests",
  "geo_zones",
  "hashtag_reports",
  "hashtag_usage",
  "hidden_gem_reports",
  "hidden_gem_verifications",
  "hidden_gem_visits",
  "highlight_likes",
  "highlight_reports",
  "highlight_views",
  "highlights",
  "live_place_recaps",
  "local_guide_profiles",
  "location_preferences",
  "location_sessions",
  "location_snapshots",
  "location_trust_events",
  "map_pins",
  "media_ranking_snapshots",
  "media_stamp_reactions",
  "meetup_invites",
  "meetup_time_votes",
  // memories / memory_likes / memory_saves moved to ERASED_BY_CASCADE (MEM·H2).
  "message_reports",
  "message_requests",
  "message_thread_members",
  "message_threads",
  "message_translations",
  "moderation_reports",
  "notification_category_preferences",
  "notification_delivery_attempts",
  "notification_preferences",
  "passport_contribution_events",
  "passport_memories",
  "passport_postcards",
  "passport_stamps",
  "passport_visibility_preferences",
  "place_mismatch_reports",
  "place_top_contributors",
  "place_votes",
  "plan_attendance_events",
  "plan_checkins",
  "plan_editors",
  "plan_geofences",
  "post_edits",
  "post_hides",
  "post_impressions",
  "profile_emergency_contacts",
  "profile_privacy_settings",
  "profile_views",
  "pulse_geo_tags",
  "push_retry_queue",
  "quick_availability_status",
  "rank_events",
  "ranking_debug_samples",
  "rent_buddy_addons",
  "rent_buddy_applications",
  "rent_buddy_availability",
  "rent_buddy_beta_access",
  "rent_buddy_bookings",
  "rent_buddy_city_restrictions",
  "rent_buddy_earnings_ledger",
  "rent_buddy_emergency_contacts_snapshot",
  "rent_buddy_launch_controls",
  "rent_buddy_marketplace_analytics_events",
  "rent_buddy_match_preferences",
  "rent_buddy_match_scores",
  "rent_buddy_packages",
  "rent_buddy_payouts",
  "rent_buddy_profiles",
  "rent_buddy_requests",
  "rent_buddy_review_notes",
  "rent_buddy_safety_checkins",
  "rent_buddy_saved",
  "rent_buddy_search_events",
  "rent_buddy_support_reports",
  "rent_buddy_tips",
  "rent_buddy_training_checklist",
  "rent_buddy_user_limits",
  "rent_buddy_waitlist",
  "reports",
  "route_plan_members",
  "safe_return_events",
  "safe_return_live_shares",
  "safe_return_sessions",
  "saved_messages",
  "shared_moment_audit_events",
  "shared_moment_memberships",
  "shared_moment_suggestions",
  "shared_moments",
  "stamp_award_events",
  "stamp_milestones",
  "stamp_progress",
  "telegraph_chat_suggestions",
  "thread_reports",
  "traveler_passports",
  "trip_activity_log",
  "trip_area_preferences",
  "trip_autopilot_proposals",
  "trip_autopilot_settings",
  "trip_availability",
  "trip_checklists",
  "trip_crew_location_events",
  "trip_crew_location_preferences",
  "trip_crew_location_sessions",
  "trip_invite_link_attempts",
  "trip_invite_links",
  "trip_join_requests",
  "trip_members",
  "trip_notes",
  "trip_readiness_items",
  "trip_reminders",
  "trip_reservations",
  "trip_saved_places",
  "trip_traveler_passports",
  "trips",
  "trust_caps",
  "trust_events",
  "trust_profiles",
  "trust_restrictions",
  "trust_reviews",
  "user_availability",
  "user_hashtag_follows",
  "user_interaction_cooldowns",
  "user_location_preferences",
  "user_location_privacy",
  "user_location_state",
  "user_locations",
  "user_message_settings",
  "user_preference_events",
  "user_preference_profiles",
  "user_privacy_settings",
  "user_recent_places",
  "user_stamp_showcase",
  "user_stamps",
  "user_suggestion_seen",
  "user_trust_scores",
  "viewer_creator_fatigue",
];

/**
 * ── THE DENOMINATOR CORRECTION OF 2026-09-08 ────────────────────────────────
 *
 * These 91 tables were ALWAYS user-keyed. They were never in this manifest
 * because check:deletion-coverage decided "is this table about a user?" by
 * matching 18 recognised COLUMN NAMES, and every table here carries a person's
 * uuid under a name that list had never heard of, or reaches an account through
 * a foreign key rather than through a column name. The guard reported 248
 * user-keyed tables while the schema declares 366.
 *
 * The denominator is now measured from the FOREIGN KEY GRAPH of the baseline
 * (src/lib/deletion/userLink.ts), and these tables entered scope the moment it
 * was. They are held here, separately from UNCLASSIFIED_BACKLOG, for one
 * reason: PROVENANCE. The 225 entries above were triaged by a person and found
 * undecided. These 91 have never been triaged at all - they were invisible.
 * Merging the two lists would lose that difference and let a bigger number look
 * like more work done.
 *
 * NOTHING HERE IS A DECISION. Being on this list means exactly what
 * UNCLASSIFIED_BACKLOG means: the rows survive account deletion and nobody has
 * ruled on whether they should. It is owner decision D6, and this list is its
 * input, not its answer.
 *
 * SOME OF THESE ARE NOT ACTUALLY UNDECIDED, and that must not be papered over
 * by a lane that does not own the decision:
 *   * `profiles` is deliberately kept as an ANONYMISED TOMBSTONE by
 *     executeAccountDeletion - the behaviour is implemented and is the reason
 *     no cascade off profiles ever fires. That is a decision in CODE that has
 *     never been written down as a disposition here. Recording it belongs to
 *     whoever answers D6, not to the change that discovered the table was
 *     missing from the universe.
 *   * several of these are already cleared by AccountDeletionService. Until the
 *     corrected denominator existed they could not even be RECORDED as erased:
 *     an entry naming a table the name list could not see was reported as a
 *     STALE ENTRY and failed the gate. That contradiction is now gone, so
 *     moving them to ERASED_BY_CASCADE is finally possible - it is a triage
 *     pass, and it is not this one.
 *
 * Entries leave this list the same way UNCLASSIFIED_BACKLOG entries do: to
 * ERASED_BY_CASCADE with matching service code, or to RETAINED_WITH_REASON with
 * a reason a user could be shown. A NEW table must never be added here - it has
 * a fate decided on the day it is created, which is what the gate exists for.
 */
export const DENOMINATOR_CORRECTION_BACKLOG: readonly string[] = [
  "admin_access_log",
  "age_limit_audit_log",
  "appeals",
  "blocks",
  "buddy_booking_change_requests",
  "buddy_booking_events",
  "call_sessions",
  "circle_audit_events",
  "circle_meeting_points",
  "collection_items",
  "compass_abuse_flags",
  "compass_admin_actions",
  "compass_algorithm_versions",
  "compass_conversation_messages",
  "compass_rollbacks",
  "content_distribution_stats",
  "entry_requirements",
  "event_agenda_items",
  "event_invites",
  "event_media",
  "event_reviews",
  "event_share_links",
  "feature_flag_audit_log",
  "generated_visuals",
  "highlight_replies",
  "key_packages",
  "live_place_recap_chapters",
  "live_place_recap_snapshots",
  "live_place_recap_sources",
  "live_place_recap_versions",
  "local_guide_contributions",
  "media_assets",
  "media_attachments",
  "media_dedup_groups",
  "media_dedup_memberships",
  "meetup_time_options",
  "meetups",
  "memory_items",
  "memory_tags",
  "moderation_actions",
  "place_image_reports",
  "place_merge_log",
  "place_profiles",
  "portava_featured",
  "post_bucket_ledger",
  "post_event_links",
  "post_media_moderation_ledger",
  "price_baselines",
  "profiles",
  "ranking_config_audit_log",
  "rent_buddy_admin_access_logs",
  "rent_buddy_admin_actions",
  "rent_buddy_booking_addons",
  "rent_buddy_booking_extensions",
  "rent_buddy_city_rollouts",
  "rent_buddy_disputes",
  "rent_buddy_global_controls",
  "rent_buddy_launch_audit_logs",
  "rent_buddy_launch_checklists",
  "rent_buddy_offers",
  "rent_buddy_package_stops",
  "rent_buddy_policy_flags",
  "rent_buddy_reviews",
  "rent_buddy_route_change_requests",
  "rent_buddy_route_stops",
  "rent_buddy_safety_events",
  "rent_buddy_tag_consents",
  "report_evidence",
  "reviews",
  "route_legs",
  "route_plans",
  "route_stops",
  "safe_return_contacts",
  "shared_moment_contributions",
  "stamp_admin_audit_log",
  "stamp_admires",
  "stamp_artwork_versions",
  "tags",
  "trip_budget",
  "trip_checklist_items",
  "trip_destinations",
  "trip_documents",
  "trip_plan_items",
  "trip_readiness_snapshots",
  "trust_admin_actions",
  "user_friendships",
  "user_mutes",
  "user_restrictions",
  "user_saves",
];

/**
 * Tables created by canonical migrations AFTER the 2026-08-19 baseline. They are
 * classified above but cannot be found in the baseline yet, so the coverage check
 * must not report them as stale.
 *
 * The journey_* family belongs here too: those tables are LIVE ON PRODUCTION
 * (verified 2026-08-22) while their migrations are still unpushed to git. They
 * are listed as backlog rather than erased because their deletion fate is the
 * Journey workstream's call, not this one's.
 *
 * ── THIS LIST IS THE BLIND SPOT, NOT THE FIX FOR IT (measured 2026-10-04) ────
 * An earlier revision of this comment said entries "leave this list when the
 * baseline is recaptured — which is part of the apply sequence". That is true of
 * an APPLIED migration and false of every other kind, and the difference is the
 * whole hole:
 *
 *   * the denominator has exactly two sources — baseline/20260819_baseline_
 *     structure.sql, and this hand-written list passed to classifyUserLinks as
 *     `extraTables`. Nothing reads src/migrations/.
 *   * so a migration that CREATEs a user-keyed table puts it in the universe
 *     only when a person remembers to type its name here. Forgetting is not an
 *     error the gate can report: the table is absent from the baseline, so it is
 *     absent from the denominator, so check:deletion-coverage passes.
 *   * a baseline recapture cannot close this. Recapture snapshots PRODUCTION, and
 *     a committed-but-unapplied migration's tables are not on production. The
 *     creator-ledger tables (2901 / 2920 / 2921 / 3387) are exactly that case:
 *     absent from the 2026-08-19 dump, absent from
 *     baseline/20260922_production_tables.txt, and absent from
 *     lib/capability/production-applied-migrations.json, whose newest applied
 *     version is 20260922155706.
 *
 * MEASURED, so the size of the hole is a number rather than a worry — and
 * measured with a model this repository ALREADY HAS. scripts/lib/
 * canonicalSchema.ts replays every file in migrations/ and src/migrations/ over
 * the same baseline (754 files on 2026-10-04) and is already the source of truth
 * for check:schema-references. Asked what tables it knows, it answers 529, of
 * which 142 are post-baseline, of which 114 — including all five added here —
 * were named in no bucket of this file.
 *
 * SO THE FIX IS SMALLER THAN IT LOOKS, and it is still not this change:
 *   * the PRESENCE half needs no new parser. "Every table the canonical chain
 *     creates must be named in this manifest" is answerable today from
 *     canonicalSchema.columns, and it is the half that would have caught these
 *     five. It cannot be switched on here because it reports 114 tables at once,
 *     and the gate's own failure text forbids parking a new table in either
 *     dated backlog — correctly. It needs a change that triages them.
 *   * the CLASSIFICATION half does need new work: canonicalSchema deliberately
 *     models columns and not constraints, and lib/deletion/userLink.ts decides
 *     HOW a table is user-linked from the FOREIGN KEY graph, which is parsed out
 *     of the dump's format (lib/deletion/schemaFacts.ts) and not out of
 *     migration DDL. Until that exists, a post-baseline table registered here
 *     is DERIVED_USER_LINKED by hand registration — in scope, with no schema
 *     evidence either way, which is what these five now are.
 */
export const POST_BASELINE_TABLES: readonly string[] = [
  // Derived memory, added by migrations 2183-2191 (post-baseline).
  "memory_projections",
  "memory_events",
  "memory_feedback",
  // Provenance spine, added by migration 2320 (post-baseline). Classified in
  // ERASED_BY_CASCADE above.
  "memory_episodes",
  "memory_evidence",
  "intel_observations",
  "intel_claims",
  "intel_evidence",
  "intel_confirmations",
  "intel_state_snapshots",
  // I1 append-only projection history, added by migration 2273 (post-baseline).
  // Classified in RETAINED_WITH_REASON above (no actor column).
  "intel_state_snapshot_versions",
  "intel_contribution_consent",
  // IG-10 non-cash reward ledger, added by migration 2170 (post-baseline).
  "intel_reward_ledger",
  // I4a attribution ledger, added by migration 2277 (post-baseline). Classified
  // in ERASED_BY_CASCADE above.
  "intel_attributions",
  // I4a scoped-trust fold, added by migration 2278 (post-baseline). Classified
  // in ERASED_BY_CASCADE above.
  "intel_scoped_trust",
  // IG mission candidates, added by migration 2167 (post-baseline). Classified
  // in ANONYMISED_FK_NULLED (accepted_by is NULLed, the row is kept).
  "intel_mission_candidates",
  // Unit I3 presence-verification audit, added by migration 2276 (post-baseline).
  // Classified in ERASED_BY_CASCADE above.
  "intel_presence_verifications",
  // Passport / Wall owner-scoped tables (migrations 2260 / 2261 / 2271,
  // post-baseline). Classified in ERASED_BY_CASCADE above.
  "availability_windows",
  "passport_travel_dna_prefs",
  "wall_session_intents",
  // Temporary event Passport shares, added by migration 2294 (post-baseline).
  // Classified in ERASED_BY_CASCADE above.
  "event_passport_shares",
  // Wall §32 telemetry sink, added by migration 2308 (post-baseline).
  // Classified in ERASED_BY_CASCADE above.
  "wall_telemetry_events",
  // Input-assistance opt-ins and outcome counters, added by migrations 3780 /
  // 3782 (post-baseline). Classified in ERASED_BY_CASCADE above.
  "input_outcome_consent",
  "input_outcome_counters",
  "input_memory_context_consent", "memory_deletion_dead_letters", "memory_resurfacing_preferences", "memory_corrections", "nearby_proximity_observations", "availability_audience_policies", "nearby_consents", "eta_coordination_grants", "memory_relations", "memory_id_redirects", "telegraph_thread_member_mutes", // 3661 (lane T-GRP) classified ERASED_BY_CASCADE above. 3670, 3671, 3673, 2994 + 3674 (post-baseline, unapplied): classified in ERASED_BY_CASCADE above. One line so cited lines below hold. | lane T, migrations 3651 / 3652 (unapplied), classified ERASED_BY_CASCADE above
  // OD-MAP-6 sensing consents, added by migration 3703 (post-baseline).
  // Classified in ERASED_BY_CASCADE above.
  "sensing_consent_grants",
  // CPH-08-ADAPT live-search quota, added by migration 3704 (post-baseline).
  // Classified in ERASED_BY_CASCADE above.
  "compass_live_search_usage",
  // Q-L23 report captures, added by migration 3705 (post-baseline). Classified
  // in RETAINED_WITH_REASON above (it follows its moderation_reports row).
  "moderation_report_captures",
  "journey_observations",
  "journey_revocation_jobs",
  "journey_segment_revisions",
  "journey_shadow_cohort_assignments",
  "journey_shadow_ground_truth",
  "journey_shadow_qa_reports",
  "journey_shadow_session_issuances",
  // The creator / Rent-a-Buddy ledger (migrations 2901, 2920, 2921, 3387).
  // Post-baseline AND unapplied to production, so neither the 2026-08-19 dump
  // nor a recapture of it can ever see these five: they are in the denominator
  // only because they are named here. creator_rule_versions is classified in
  // RETAINED_WITH_REASON; the other four in AWAITING_OWNER_DECISION (C-11).
  "rent_buddy_earnings_entries",
  "creator_rule_versions",
  "creator_attributions",
  "creator_earning_entries",
  "creator_ledger_audit_events",
  // The Rent-a-Buddy payment slice (migration 3931, lane B). Post-baseline and
  // applied to no database, so — like the five above — the gate sees them only
  // because they are named here. All five are RETAINED_WITH_REASON:
  // payment_webhook_events (no person) and the four money tables (OD-PAY-8).
  // Migration 3930 adds a column to identity_verifications (ERASED_BY_CASCADE,
  // deleted by AccountDeletionService) and creates no table.
  "rent_buddy_payment_recipients",
  "rent_buddy_monthly_payouts",
  "rent_buddy_booking_payments",
  "rent_buddy_payment_refunds",
  "payment_webhook_events",
  // Layover tables created after the 2026-08-19 baseline (2700, 2984, 2992,
  // 3900), registered with their fate on the day it was decided (census-layover
  // L163): every one is erased through the session delete's cascade, so all are
  // in ERASED_BY_CASCADE above.
  "layover_presence",
  "layover_crews",
  "layover_crew_members",
  "layover_constraints",
  "layover_time_budgets",
  "layover_return_plans",
  "layover_checkpoints",
  "layover_outcomes",
  "layover_certified_computations", "layover_event_pseudonymisation_dead_letters", // 3622 (PR-R-L163a): session id, failure text and times; erased with its session (ON DELETE CASCADE)
];

/** Columns that make a table user-keyed for the purposes of this manifest. */
export const USER_IDENTIFYING_COLUMNS: readonly string[] = [
  "accepted_by",
  "actor_id",
  "author_id",
  "buddy_id",
  "created_by",
  "follower_id",
  "following_id",
  "host_id",
  "member_id",
  "owner_id",
  "profile_id",
  "recipient_id",
  "reporter_id",
  "sender_id",
  "submitted_by",
  "traveler_id",
  "user_id",
  "viewer_id",
];
