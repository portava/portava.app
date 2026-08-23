/**
 * D6 classifications — the tables the triage pass left undecided.
 *
 * The D6 packet delivered on 2026-08-23 classified 260 tables and escalated 5.
 * An adversarial review found the real escalation set was larger: 21 tables had
 * been decided by nobody, because they were never classified at all. Two of them
 * hold production data (`rent_buddy_availability`, `passport_stamps`) and one is
 * `profiles` itself — the single row guaranteed to survive every deletion.
 *
 * The owner then issued five governing rulings and asked that they be applied
 * MECHANICALLY, with escalation reserved for cases that genuinely straddle two
 * of them. Applying them that way takes 21 down to 2.
 *
 * ── THE FIVE RULINGS (2026-08-23), quoted because they are the whole basis ───
 *  1. Deletion erases identifiable personal data by DEFAULT. Retention is the
 *     exception and needs a documented purpose.
 *  2. Community intelligence may survive, identity should not.
 *  3. User-created social content is user-controlled — deletable with the
 *     account, unless a minimal tombstone preserves another user's conversation
 *     or transaction integrity.
 *  4. Security/legal/financial records may be retained NARROWLY, for their
 *     stated retention requirement, preferring pseudonymisation.
 *  5. Aggregates survive only when genuinely non-identifiable. Nulling
 *     `user_id` does not make a row anonymous.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
 * A decision record, not an implementation. None of these fates is enforced
 * yet: the deletion worker still clears only its curated list, and every entry
 * here remains in UNCLASSIFIED_BACKLOG until the worker actually performs its
 * stated fate. Moving a table out of the backlog before the code does the work
 * would be the same false claim this codebase keeps finding elsewhere — a
 * disposition that describes an intention as though it were a behaviour.
 */

/** The fate vocabulary from the owner's rulings. */
export type D6Fate =
  | "ERASE"
  | "ANONYMIZE"
  | "RETAIN_LEGAL_SECURITY"
  | "RETAIN_AGGREGATE_NON_PERSONAL"
  | "NEEDS_OWNER_DECISION";

export interface D6Classification {
  table: string;
  fate: D6Fate;
  /** Which of the five rulings decides it. */
  rule: 1 | 2 | 3 | 4 | 5;
  reason: string;
  /** For NEEDS_OWNER_DECISION: the exact columns that make it straddle. */
  ambiguousColumns?: readonly string[];
}

export const D6_CLASSIFICATIONS: readonly D6Classification[] = [
  // ── ERASE — the user's own data, nobody else depends on it ────────────────
  {
    table: "rent_buddy_availability",
    fate: "ERASE", rule: 3,
    reason:
      "A buddy's own working calendar: dates, time slots, vacation blocks, booking limits and a free-text " +
      "`notes` column that routinely carries personal detail. 126 rows on production. No other user's " +
      "transaction depends on the availability of a buddy who no longer exists — a booking that already " +
      "happened lives in rent_buddy_bookings, not here.",
  },
  {
    table: "passport_stamps",
    fate: "ERASE", rule: 3,
    reason:
      "The owner ruled on 2026-08-23 that a stamp is a POST — user-created content. Ruling 3 makes posts " +
      "deletable with the account. This also resolves an asymmetry the packet flagged: passport_stamps_gps " +
      "already cascades from auth.users, so today the coordinates die and the stamp survives. Erasing the " +
      "stamp makes the content and its location share one fate instead of two.",
  },
  {
    table: "place_top_contributors",
    fate: "ERASE", rule: 2,
    reason:
      "A (place_id, user_id, contribution_count) leaderboard row. Ruling 2 keeps the community intelligence " +
      "and drops the contributor: here the row IS the pairing, so severing user_id leaves nothing meaningful. " +
      "The useful fact — how much a place has been contributed to — is recomputable at place level from the " +
      "contributions that remain, so nothing is lost by deleting the pairing.",
  },
  {
    table: "compass_memories",
    fate: "ERASE", rule: 3,
    reason:
      "Compass personalisation and history, which ruling 3 names explicitly. Holds a free-text `content` " +
      "column of compressed inferences about the person, scoped to circles and trips. Nothing outside this " +
      "user's own experience reads it.",
  },
  {
    table: "friend_requests",
    fate: "ERASE", rule: 3,
    reason:
      "Social graph edges (requester_id, recipient_id, status). Ruling 3. Must be deleted on BOTH columns — " +
      "clearing only the requester side leaves the departed person's uuid sitting in every request they " +
      "received, which looks complete and is not.",
  },
  {
    table: "media_stamp_reactions",
    fate: "ERASE", rule: 3,
    reason: "A reaction a user left on a post. User-created social content, ruling 3. Counts are recomputable.",
  },
  {
    table: "media_ranking_snapshots",
    fate: "ERASE", rule: 5,
    reason:
      "Per-viewer ranking telemetry: viewer_id, item_id, session_id, position, score, served_at. Ruling 5 " +
      "forbids calling this an aggregate — session_id plus a timestamp sequence re-identifies a person's " +
      "viewing session even with viewer_id removed. It is behavioural data about one person, so ruling 1's " +
      "default applies.",
  },
  {
    table: "rent_buddy_addons",
    fate: "ERASE", rule: 3,
    reason:
      "A buddy's own service listings — title, description, price. Their content under ruling 3. Historical " +
      "bookings that referenced an addon carry their own record.",
  },
  {
    table: "journey_observations",
    fate: "ERASE", rule: 3,
    reason:
      "Raw passive device telemetry: lat, lng, accuracy, speed, heading, per observation. This is location " +
      "history, which ruling 3 names, and the D4 ruling independently minimises. The single clearest erase " +
      "in the set.",
  },
  {
    table: "journey_segment_revisions",
    fate: "ERASE", rule: 3,
    reason:
      "Derived movement segments for one person — start/end, duration, movement class, place category. " +
      "Derived from location history and re-identifying in the same way; ruling 3 and D4 both point here.",
  },
  {
    table: "journey_shadow_ground_truth",
    fate: "ERASE", rule: 3,
    reason:
      "Per-user research ground truth: user_id, location_session_id, a `ground_truth` payload and free-text " +
      "`notes`. It describes one person's movements during a study window. `submitted_by` (staff) is severed " +
      "with it rather than kept beside an erased subject.",
  },
  {
    table: "journey_shadow_session_issuances",
    fate: "ERASE", rule: 3,
    reason:
      "Which location sessions were issued to which participant. Keyed to the person and to a session that " +
      "is itself erased; `issued_by` (staff) severs with it.",
  },

  // ── ANONYMIZE — the artefact survives, the person does not ────────────────
  {
    table: "plan_geofences",
    fate: "ANONYMIZE", rule: 3,
    reason:
      "Keyed to a TRIP, not a user — the only person-shaped column is the nullable `created_by`. Ruling 3's " +
      "tombstone case: the geofence belongs to a trip other members share, and deleting it would edit their " +
      "itinerary. Sever created_by; the geofence follows the trip's own lifecycle. Note it also carries lat/lng " +
      "and venue detail, which are about a PLACE the trip visits, not about the departing person.",
  },
  {
    table: "journey_shadow_qa_reports",
    fate: "ANONYMIZE", rule: 2,
    reason:
      "Programme quality reports with no subject user at all — the only identity is `submitted_by`, a staff " +
      "member. Ruling 2: the intelligence survives, the contributor is severed.",
  },
  {
    table: "journey_shadow_stages",
    fate: "ANONYMIZE", rule: 2,
    reason:
      "Programme stage configuration — windows, caps, active flag. Not personal data; the only identity is " +
      "`approved_by`. Sever it and the stage record is intact.",
  },
  {
    table: "profiles",
    fate: "ANONYMIZE", rule: 3,
    reason:
      "The tombstone, and the one row guaranteed to survive every deletion — which is exactly why it must be " +
      "classified rather than assumed. It is anonymised, not erased, so other users' threads and events keep " +
      "a referent. BUT ruling 5 applies with force: the current anonymisation names twelve columns and leaves " +
      "everything it does not name — id, created_at, role, account_status, and every column added since it " +
      "was written. An anonymisation that enumerates what it clears will drift the moment a column is added. " +
      "The column list must be derived from the schema, not hand-maintained.",
  },

  // ── RETAIN — narrowly, with a stated purpose ──────────────────────────────
  {
    table: "journey_revocation_jobs",
    fate: "RETAIN_LEGAL_SECURITY", rule: 4,
    reason:
      "DELETION AUDIT EVIDENCE, which ruling 4 names explicitly. Each row records that a revocation was " +
      "requested for a consent scope, when it completed, and how many rows it removed. Retaining it is how " +
      "Portava can later show a deletion actually happened — severing user_id would destroy the only thing " +
      "that makes it evidence. Requires Privacy Policy disclosure, and a stated retention window: it should " +
      "not outlive the limitation period it exists to answer.",
  },
  {
    table: "journey_retention_health",
    fate: "RETAIN_AGGREGATE_NON_PERSONAL", rule: 5,
    reason:
      "Operational health of the retention job itself: job name, last status, deleted/failed counts, lag, " +
      "lease state. NO user column of any kind, and no combination of its columns points at a person — it " +
      "counts rows, it does not describe them. This is the one table in the set that passes ruling 5's test " +
      "rather than merely claiming to.",
  },

  // ── STILL YOURS — genuinely straddles two rulings ─────────────────────────
  {
    table: "rent_buddy_review_notes",
    fate: "NEEDS_OWNER_DECISION", rule: 3,
    ambiguousColumns: ["reviewer_admin_id", "note", "booking_id", "review_id"],
    reason:
      "STILL OPEN, and the reason changed. The owner ruled on 2026-08-23 that the author is an " +
      "authorised admin or staff reviewer, and asked for author_id to be renamed reviewer_admin_id " +
      "and the note retained as moderation evidence. Reading the code before implementing that " +
      "shows the premise does not hold: the table has exactly ONE writer, " +
      "POST /rent-a-buddy/bookings/:bookingId/review at routes/rentABuddy.ts:2581, which is guarded " +
      "by requireUser (NOT an admin check) and inserts author_id = auth.user.id with the note taken " +
      "from a `privateNote` field in the request body. That is an ordinary traveller or buddy " +
      "attaching a private note to their OWN review. It also has zero readers anywhere in " +
      "routes/services/lib, and zero rows on production.\n" +
      "Renaming it reviewer_admin_id would therefore label ordinary users' free text as " +
      "staff-authored and move their personal content into a retain-indefinitely moderation " +
      "bucket — worse than the ambiguity that prompted the question. Under the actual behaviour " +
      "ruling 3 applies and the note is the reviewer's own content.\n" +
      "The question to settle is not which fate but which system is wrong: should this table become " +
      "staff-authored as ruled (which needs the write path moved behind an admin guard), or is it " +
      "a user's private note and simply misnamed?",
  },
  {
    table: "journey_shadow_cohort_assignments",
    fate: "ERASE", rule: 1,
    reason:
      "RULED 2026-08-23: research consent must NOT outlive the consenter. Account deletion or " +
      "consent withdrawal deletes the identifiable assignment — production already has " +
      "user_id -> profiles ON DELETE CASCADE, so this is the behaviour today. Aggregate statistics " +
      "already produced may survive ONLY if genuinely anonymous. The owner ruled out the tempting " +
      "middle option explicitly: no stable user hash, no encrypted user id, no reversible linkage " +
      "kept and called anonymous, because a value anyone can relink is pseudonymous and " +
      "pseudonymous data is still personal data (ICO anonymisation guidance). Where an aggregate " +
      "must record that it lost a participant, record THAT — a decrement — not a token standing in " +
      "for the person. The staff columns assigned_by and revoked_by are severed by 2138.",
  },
] as const;

/** Tables the rulings decided, by fate — for the worker and for reporting. */
export function d6ByFate(fate: D6Fate): readonly string[] {
  return D6_CLASSIFICATIONS.filter((c) => c.fate === fate).map((c) => c.table);
}

/** The set still requiring an owner ruling. Should shrink, never grow. */
export function d6StillUndecided(): readonly D6Classification[] {
  return D6_CLASSIFICATIONS.filter((c) => c.fate === "NEEDS_OWNER_DECISION");
}
