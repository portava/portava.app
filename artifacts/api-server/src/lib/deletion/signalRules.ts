/**
 * signalRules — the HAND-WRITTEN rules that turn measured schema facts into
 * signals, applied MECHANICALLY to every table.
 *
 * ── READ THIS BEFORE TRUSTING A SIGNAL ──────────────────────────────────────
 * A signal here is RULE_DERIVED: the rule was written by a person, the
 * application of it was not. That is weaker than a measurement and stronger
 * than a per-table opinion, and the distinction is the whole reason this file
 * is separate from `schemaFacts.ts` (measured) and `handNotes.ts` (per-table
 * opinion). Nothing in the graph may present a rule hit as a measurement.
 *
 * The rules match COLUMN NAMES and TABLE NAMES. They therefore:
 *   * over-match — `notes` on a config table is not message content, and
 *     `title` on an event is not private free text. Every signal carries the
 *     columns that triggered it so a reader can overrule it by looking;
 *   * under-match — a jsonb `metadata` column can hold anything at all, and a
 *     column named `payload` says nothing about what is inside. A table with no
 *     signal is NOT thereby proven harmless, which is exactly why the absence
 *     of signals never produces a confident candidate class on its own.
 *
 * Column-name matching is TOKEN-based (split on `_`) with a few whole-name
 * patterns, so `location_name` does not count as an identity `name` and
 * `display_name` does.
 */

export type SignalKey =
  | "preciseLocation"
  | "coarseLocation"
  | "contact"
  | "identity"
  | "messageContent"
  | "freeText"
  | "media"
  | "financial"
  | "moderationSafety"
  | "legalEvidence"
  | "adminAudit"
  | "trust";

export interface SignalRule {
  key: SignalKey;
  /** Whole-column-name patterns. */
  columnPatterns: RegExp[];
  /** Table-name patterns that raise the same signal on their own. */
  tablePatterns?: RegExp[];
  /** One sentence a reviewer can check the rule against. */
  rationale: string;
}

export const SIGNAL_RULES: readonly SignalRule[] = [
  {
    key: "preciseLocation",
    columnPatterns: [
      /^(lat|lng|latitude|longitude)$/,
      /^(geog|geom|coords?|coordinates|point)$/,
      /_(lat|lng|latitude|longitude|geog|geom)$/,
      /^(accuracy|accuracy_m|altitude|speed|heading|bearing)$/,
      /^(h3_[a-z0-9_]*|geohash|s2_cell|cell_id)$/,
      /^(radius_m|geofence[a-z_]*)$/,
    ],
    rationale: "A coordinate, a cell id or a movement vector locates a person to a point, not to a city.",
  },
  {
    key: "coarseLocation",
    columnPatterns: [
      /^(city|country|country_code|region|neighborhood|neighbourhood|district|timezone|tz)$/,
      /^location_(name|city|country|label)$/,
      /^(place_id|venue_id|canonical_location_id|airport_code|iata)$/,
      /^(home_city|home_country|current_city|destination|origin)$/,
    ],
    rationale: "Place-level location: identifying in aggregate over time, but not a coordinate.",
  },
  {
    key: "contact",
    columnPatterns: [
      /^(email|email_address|phone|phone_number|phone_e164|msisdn|whatsapp|telegram)$/,
      /^(contact|contact_name|contact_phone|contact_email|emergency_contact[a-z_]*)$/,
      /^(push_token|device_token|fcm_token|apns_token|expo_token|endpoint|token)$/,
      /^(address|street|postcode|postal_code|zip)$/,
    ],
    rationale: "A channel that reaches the person off-platform, or a device credential that identifies their handset.",
  },
  {
    key: "identity",
    columnPatterns: [
      /^(handle|username|display_name|full_name|first_name|last_name|legal_name|name)$/,
      /^(dob|date_of_birth|birth_date|birthday|age|age_band|gender|pronouns|nationality)$/,
      /^(document_type|document_number|passport_number|id_number|selfie_url|verification_photo)$/,
      /^(avatar_url|cover_photo_url|profile_photo|face_[a-z_]+)$/,
    ],
    rationale: "Names the human rather than an account: a legal identifier, a face, or a display identity.",
  },
  {
    key: "messageContent",
    columnPatterns: [
      /^(body|message|message_text|content|text|raw_text|transcript|reply|reply_text)$/,
      /^(comment|comment_text|note|notes|private_note|answer|question|prompt|caption|bio)$/,
    ],
    rationale: "Free text a person typed. May be about somebody else, which is why erasing it is not automatically safe.",
  },
  {
    key: "freeText",
    columnPatterns: [/^(title|description|summary|label|reason|details|feedback)$/],
    rationale: "Weaker free-text signal: often product copy or an enum-ish reason, sometimes personal detail.",
  },
  {
    key: "media",
    columnPatterns: [
      /^(media_url|media_urls|photo_url|photos|image_url|images|video_url|audio_url|thumbnail_url)$/,
      /^(storage_path|thumbnail_storage_path|feed_storage_path|thumbnail_path|file_path|asset_url|artwork_url)$/,
      /^(attachment|attachments|reference)$/,
    ],
    rationale: "Points at stored BYTES. Deleting the row does not delete the object; a storage hook must.",
  },
  {
    key: "financial",
    columnPatterns: [
      /^(amount|amount_cents|price|price_cents|cost|fee|fee_cents|subtotal|total|total_cents)$/,
      /^(currency|payout|payout_id|payout_status|earnings|earnings_cents|balance|tip|tip_amount)$/,
      /^(stripe_[a-z_]+|payment_intent|payment_status|invoice_id|refund[a-z_]*|transaction_id)$/,
    ],
    tablePatterns: [/(payout|earnings|ledger|invoice|payment|tips?)/],
    rationale: "Money moved or was owed. Tax and chargeback windows are the usual reason such a row outlives an account.",
  },
  {
    key: "moderationSafety",
    columnPatterns: [
      /^(report_reason|reported_[a-z_]+|violation|violation_type|severity|abuse_[a-z_]+)$/,
      /^(ban_[a-z_]+|suspension_[a-z_]+|restriction_[a-z_]+|blocked_[a-z_]+|flagged[a-z_]*)$/,
      /^(safety_[a-z_]+|emergency_[a-z_]+|sos_[a-z_]+|panic_[a-z_]+|checkin_[a-z_]+)$/,
    ],
    tablePatterns: [/(report|reports|moderation|appeal|abuse|safety|safe_return|emergency|block|restriction)/],
    rationale: "Evidence in a safety process. Erasing one side of a report can destroy the other person's protection.",
  },
  {
    key: "legalEvidence",
    columnPatterns: [
      /^(consent|consent_[a-z_]+|policy_version|terms_version|legal_[a-z_]+|retention_[a-z_]+)$/,
      /^(verified_at|verification_status|verification_level|revoked_at|revocation_[a-z_]+)$/,
    ],
    tablePatterns: [/(consent|verification|verifications|revocation|deletion_requests|account_states)/],
    rationale: "Records that a permission was given, withdrawn, or checked — the evidence a later dispute is decided on.",
  },
  {
    key: "adminAudit",
    columnPatterns: [
      /^(performed_by|reviewed_by|approved_by|resolved_by|assigned_by|revoked_by|issued_by|set_by|admin_id|moderator_id)$/,
      /^(action|admin_action|audit_[a-z_]+)$/,
    ],
    tablePatterns: [/(audit|_log$|_logs$|admin|activity_log)/],
    rationale: "Names a staff member or records a staff action; the subject of the row is usually somebody else.",
  },
  {
    key: "trust",
    columnPatterns: [
      /^(trust_[a-z_]+|reputation[a-z_]*|score|scores|penalty|penalties|cap|caps|tier|level)$/,
    ],
    tablePatterns: [/(trust|reputation|creator_activity_scores|user_trust_scores)/],
    rationale: "Feeds the Trust system. A score that survives its subject, or dies with them, changes other people's limits.",
  },
] as const;

/** How a user-identifying column relates to the account being deleted. */
export type ColumnRole = "subject" | "counterparty" | "staff_actor" | "ambiguous";

/**
 * Column name -> role. HAND-WRITTEN, applied mechanically.
 *
 * `ambiguous` is used wherever the same column name means different things in
 * different tables (`created_by` is the trip's author in one place and a staff
 * member in another). Marking those ambiguous is the point: it is what keeps a
 * table with a counterparty out of the confident candidate classes.
 */
export const COLUMN_ROLES: Readonly<Record<string, ColumnRole>> = {
  // ── The account being deleted is the SUBJECT of the row ───────────────────
  user_id: "subject",
  owner_id: "subject",
  owner_user_id: "subject",
  author_id: "subject",
  submitted_by: "subject",
  profile_id: "subject",
  sender_id: "subject",
  viewer_id: "subject",
  traveler_id: "subject",
  follower_id: "subject",
  reporter_id: "subject",
  reporter_user_id: "subject",
  appellant_id: "subject",
  creator_id: "subject",
  uploader_id: "subject",
  uploader_user_id: "subject",
  contributor_id: "subject",
  replier_id: "subject",
  admirer_id: "subject",
  saver_id: "subject",
  tagger_id: "subject",
  muter_id: "subject",
  blocker_id: "subject",
  restrictor_id: "subject",
  requester_id: "subject",

  // ── The row also names SOMEBODY ELSE ──────────────────────────────────────
  recipient_id: "counterparty",
  recipient_user_id: "counterparty",
  following_id: "counterparty",
  target_user_id: "counterparty",
  target_user: "counterparty",
  target_id: "counterparty",
  subject_user_id: "counterparty",
  reviewee_id: "counterparty",
  invitee_id: "counterparty",
  blocked_id: "counterparty",
  muted_id: "counterparty",
  restricted_id: "counterparty",
  saved_id: "counterparty",
  tagged_user_id: "counterparty",
  contact_user_id: "counterparty",
  flagged_user_id: "counterparty",
  friend_user_id: "counterparty",
  other_id: "counterparty",

  // ── STAFF: the row is a record of what an operator did to someone else ────
  admin_id: "staff_actor",
  moderator_id: "staff_actor",
  performed_by: "staff_actor",
  reviewed_by: "staff_actor",
  admin_reviewed_by: "staff_actor",
  approved_by: "staff_actor",
  resolved_by: "staff_actor",
  resolver_id: "staff_actor",
  changed_by_user_id: "staff_actor",
  created_by_admin_id: "staff_actor",
  updated_by_admin_id: "staff_actor",
  awarded_by_admin_id: "staff_actor",
  launched_by_admin_id: "staff_actor",
  tested_by_admin_id: "staff_actor",
  rolled_back_by: "staff_actor",
  status_changed_by: "staff_actor",
  stamp_revoked_by: "staff_actor",
  verified_by: "staff_actor",
  guide_verified_by: "staff_actor",
  published_by: "staff_actor",
  set_by: "staff_actor",

  // ── Genuinely two-sided or role-dependent. Left ambiguous ON PURPOSE: the
  // same column name is the trip's author in one table and an operator in
  // another, and a name cannot tell them apart. Ambiguity here is what keeps
  // the table out of the confident candidate classes.
  created_by: "ambiguous",
  actor_id: "ambiguous",
  actor_user_id: "ambiguous",
  host_id: "ambiguous",
  host_user_id: "ambiguous",
  buddy_id: "ambiguous",
  buddy_user_id: "ambiguous",
  member_id: "ambiguous",
  accepted_by: "ambiguous",
  updated_by: "ambiguous",
  revoked_by: "ambiguous",
  removed_by: "ambiguous",
  restored_by: "ambiguous",
  archived_by: "ambiguous",
  released_by: "ambiguous",
  held_by: "ambiguous",
  lifted_by: "ambiguous",
  confirmed_by: "ambiguous",
  no_show_by: "ambiguous",
  responded_by: "ambiguous",
  requested_by: "ambiguous",
  raised_by: "ambiguous",
  started_by: "ambiguous",
  added_by: "ambiguous",
  invited_by: "ambiguous",
  assigned_to: "ambiguous",
  assigned_by: "ambiguous",
  issued_by: "ambiguous",
  guide_id: "ambiguous",
  group_lead_id: "ambiguous",
  circle_owner_id: "ambiguous",
  reviewer_id: "ambiguous",
  reported_by: "ambiguous",
  inviter_id: "ambiguous",
  id: "ambiguous",
};

/** Table-name shapes that suggest a table is DERIVED from something else. */
export const DERIVATIVE_TABLE_PATTERNS: readonly RegExp[] = [
  /_cache$/, /_caches$/, /_snapshot$/, /_snapshots$/, /_projections?$/,
  /_scores$/, /_score$/, /_rollups?$/, /_aggregates?$/, /_stats$/, /_summary$/,
  /_index$/, /_manifest$/, /_queue$/, /_feed_cache$/, /_counts?$/, /_ranking[a-z_]*$/,
];

/**
 * Modules that WRITE derived state on a timer rather than in response to a
 * request. A table written only by these and never by a route is a candidate
 * derivative even when its name does not say so.
 */
export const BACKGROUND_WRITER_PATTERNS: readonly RegExp[] = [
  /scheduler/i, /projection/i, /producer/i, /consumer/i, /sweeper/i, /worker/i,
  /warmup/i, /backfill/i, /Engine\.ts$/, /rank/i, /score/i, /cache/i,
];

/** Apply the token rules to a column name. */
export function signalsForColumn(column: string): SignalKey[] {
  const hits: SignalKey[] = [];
  for (const rule of SIGNAL_RULES) {
    if (rule.columnPatterns.some((re) => re.test(column))) hits.push(rule.key);
  }
  return hits;
}

/** Apply the table-name rules. */
export function signalsForTableName(table: string): SignalKey[] {
  const hits: SignalKey[] = [];
  for (const rule of SIGNAL_RULES) {
    if (rule.tablePatterns?.some((re) => re.test(table))) hits.push(rule.key);
  }
  return hits;
}
