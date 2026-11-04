/**
 * personalDataExport — what "Download your data" gives a person, and how it is
 * read.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The privacy policy (travel-buddy-standalone/server/templates/
 * privacy-policy.html, "Your rights") promises access and portability "in-app".
 * Until this file the only in-app export was Compass memory
 * (GET /api/compass/me/memory/export): a person could not take their own
 * posts, trips, follows or settings with them.
 *
 * ── THE RULES THIS FILE HOLDS ───────────────────────────────────────────────
 *   * OWN ROWS ONLY. Every section is read by a column that names the person
 *     (`owners`), or through a parent section that already did (`via`). There
 *     is no section read any other way.
 *   * ALL OR NOTHING. supabase-js resolves `{ data, error }`, it does not throw,
 *     so every read's `error` is checked and any failure fails the whole export.
 *     A file that silently lacks the posts table is worse than no file: the
 *     person would believe it complete.
 *   * NOTHING THAT IS NOT THEIRS TO TAKE. Staff identities and staff notes are
 *     left out (reports and appeals list their columns explicitly; other
 *     sections `omit` the staff column), and so is the device push token, which
 *     works as a credential for sending to that device. Each omission says why.
 *   * SAID, NOT IMPLIED. `notIncluded` names what the file does not hold, and
 *     a section that hit the row cap is marked `truncated`, which makes
 *     `complete` false.
 *
 * Every table here is in the 2026-08-19 production baseline;
 * src/test/personalDataExport.test.ts checks each table, owner, order and named
 * column against it, and that no later migration drops or renames one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ExportSection {
  /** Key in the export's `data` object. */
  readonly key: string;
  /** What a person reads in the export's section list. */
  readonly label: string;
  readonly table: string;
  /** A row is the person's when ANY of these columns is their id. */
  readonly owners: readonly string[];
  /** Read through a parent section instead: rows whose `column` is one of the parent's ids. */
  readonly via?: { readonly section: string; readonly column: string };
  /** Columns that order the person's rows uniquely, so paging neither skips nor repeats a row. */
  readonly orderBy: readonly string[];
  /** Explicit columns, for a table that also carries what is not the person's (staff notes). Default: every column. */
  readonly columns?: readonly string[];
  /** Columns removed from every row. */
  readonly omit?: readonly string[];
  readonly omitWhy?: string;
  /** Columns holding other people's ids, resolved to a handle in the export's `people`. */
  readonly people?: readonly string[];
}

const STAFF = "who on the Portava team reviewed or changed it is not your data to take";

const SECTIONS: ExportSection[] = [
  // ── You ─────────────────────────────────────────────────────────────────
  { key: "profile", label: "Your profile", table: "profiles", owners: ["id"], orderBy: ["id"], omit: ["expo_push_token", "safety_flags_count"], omitWhy: "the push token can send notifications to your phone, and the safety-flag count is a moderation counter" },
  { key: "privacySettings", label: "Profile privacy settings", table: "profile_privacy_settings", owners: ["user_id"], orderBy: ["user_id"] },
  { key: "tagAndLocationSettings", label: "Tagging and location sharing settings", table: "user_privacy_settings", owners: ["user_id"], orderBy: ["id"] },
  { key: "messageSettings", label: "Who can message you", table: "user_message_settings", owners: ["user_id"], orderBy: ["user_id"] },
  { key: "notificationSettings", label: "Notification settings", table: "notification_preferences", owners: ["user_id"], orderBy: ["user_id"] },
  { key: "notificationCategorySettings", label: "Notification settings by category", table: "notification_category_preferences", owners: ["user_id"], orderBy: ["category"] },
  { key: "travelDocuments", label: "Passports you added", table: "traveler_passports", owners: ["user_id"], orderBy: ["id"] },

  // ── What you made ───────────────────────────────────────────────────────
  { key: "posts", label: "Your posts", table: "posts", owners: ["author_id"], orderBy: ["id"] },
  { key: "comments", label: "Your comments", table: "posts_comments", owners: ["user_id"], orderBy: ["id"] },
  { key: "reactions", label: "Your reactions to posts", table: "post_reactions", owners: ["user_id"], orderBy: ["id"] },
  { key: "likes", label: "Posts you liked", table: "posts_likes", owners: ["user_id"], orderBy: ["id"] },
  { key: "stories", label: "Your stories", table: "stories", owners: ["owner_id"], orderBy: ["id"] },
  { key: "highlights", label: "Your highlights", table: "highlights", owners: ["owner_id"], orderBy: ["id"] },
  { key: "memories", label: "Your memories", table: "memories", owners: ["owner_id"], orderBy: ["id"] },
  { key: "postcards", label: "Your passport postcards", table: "passport_postcards", owners: ["user_id"], orderBy: ["id"], omit: ["stamp_revoked_by"], omitWhy: STAFF },
  { key: "passportStamps", label: "Your passport stamps", table: "passport_stamps", owners: ["user_id"], orderBy: ["id"] },
  { key: "earnedStamps", label: "Stamps you earned", table: "user_stamps", owners: ["user_id"], orderBy: ["id"], omit: ["awarded_by_admin_id"], omitWhy: STAFF },
  { key: "hiddenGems", label: "Hidden gems you submitted", table: "hidden_gems", owners: ["submitted_by"], orderBy: ["id"], omit: ["guide_verified_by", "report_count"], omitWhy: "who verified it, and how many times other people reported it, is not your data to take" },

  // ── People ──────────────────────────────────────────────────────────────
  { key: "following", label: "People you follow", table: "user_follows", owners: ["follower_id"], orderBy: ["following_id"], people: ["following_id"] },
  { key: "followers", label: "People who follow you", table: "user_follows", owners: ["following_id"], orderBy: ["follower_id"], people: ["follower_id"] },
  { key: "friendRequestsSent", label: "Friend requests you sent", table: "friend_requests", owners: ["requester_id"], orderBy: ["id"], people: ["recipient_id"] },
  { key: "friendRequestsReceived", label: "Friend requests you received", table: "friend_requests", owners: ["recipient_id"], orderBy: ["id"], people: ["requester_id"] },
  { key: "friends", label: "Your friends", table: "user_friendships", owners: ["user_a", "user_b"], orderBy: ["user_a", "user_b"], people: ["user_a", "user_b"] },
  { key: "savedPeople", label: "People you saved", table: "user_saves", owners: ["saver_id"], orderBy: ["id"], people: ["saved_id"] },
  { key: "blocked", label: "Accounts you blocked", table: "blocks", owners: ["blocker_id"], orderBy: ["id"], people: ["blocked_id"] },
  { key: "muted", label: "Accounts you muted", table: "user_mutes", owners: ["muter_id"], orderBy: ["id"], people: ["muted_id"] },
  { key: "restricted", label: "Accounts you restricted", table: "user_restrictions", owners: ["restrictor_id"], orderBy: ["id"], people: ["restricted_id"] },

  // ── Saved ───────────────────────────────────────────────────────────────
  { key: "collections", label: "Your collections", table: "collections", owners: ["owner_id"], orderBy: ["id"] },
  { key: "collectionItems", label: "What is in your collections", table: "collection_items", owners: [], via: { section: "collections", column: "collection_id" }, orderBy: ["id"] },
  { key: "savedPosts", label: "Posts you saved", table: "post_saves", owners: ["user_id"], orderBy: ["id"] },
  { key: "savedPlaces", label: "Places you saved", table: "saved_places", owners: ["user_id"], orderBy: ["id"] },
  { key: "wishlist", label: "Your wishlist", table: "wishlist_places", owners: ["user_id"], orderBy: ["id"] },

  // ── Trips and events ────────────────────────────────────────────────────
  { key: "trips", label: "Trips you own", table: "trips", owners: ["owner_id"], orderBy: ["id"] },
  { key: "tripMemberships", label: "Trips you are a member of", table: "trip_members", owners: ["user_id"], orderBy: ["trip_id"] },
  { key: "tripPlanItems", label: "Plan items you added to trips", table: "trip_plan_items", owners: ["creator_id"], orderBy: ["id"] },
  { key: "eventsHosted", label: "Events you host", table: "events", owners: ["host_id"], orderBy: ["id"] },
  { key: "eventRsvps", label: "Your event RSVPs", table: "event_rsvps", owners: ["user_id"], orderBy: ["event_id"] },

  // ── Safety ──────────────────────────────────────────────────────────────
  { key: "reportsFiled", label: "Reports you filed", table: "reports", owners: ["reporter_id"], orderBy: ["id"], columns: ["id", "target_type", "target_id", "reason_code", "reason_detail", "context_type", "context_id", "status", "created_at", "updated_at"], omitWhy: "the moderator's notes and triage severity are left out, and " + STAFF },
  { key: "appeals", label: "Your appeals", table: "appeals", owners: ["appellant_id"], orderBy: ["id"], columns: ["id", "target_type", "target_id", "reason", "evidence_url", "state", "resolution_note", "created_at", "updated_at"], omitWhy: STAFF },
];

export const EXPORT_SECTIONS: readonly ExportSection[] = Object.freeze(SECTIONS.map((s) => Object.freeze(s)));

/** Said in the file, so nobody takes the file for more than it is. */
export const NOT_INCLUDED: readonly string[] = Object.freeze([
  "Messages. Your conversations are not in this file yet; ask for them through the privacy contact in the privacy policy.",
  "Photo and video files. Posts, stories, highlights and postcards list their media by link; the files themselves are not inside this download.",
  "What Compass has learned about you. Download that from Compass memory in the app; it is a separate export.",
  "Location history, safety check-ins, Rent-a-Buddy bookings and payments, and any other record not listed in `sections`. Ask for them through the privacy contact in the privacy policy.",
  "Other people's data, staff notes, and who on the Portava team handled a report or appeal.",
]);

export const EXPORT_FORMAT = "portava.personal-data-export";
export const EXPORT_VERSION = 1;
/** PostgREST answers at most this many rows per request (Supabase's default max-rows). */
export const PAGE_SIZE = 1000;
/** Rows per section before the export says `truncated` rather than keep reading. */
export const MAX_ROWS_PER_SECTION = 50_000;
const IN_CHUNK = 200;
const CONCURRENCY = 4;

type Row = Record<string, unknown>;

export interface SectionSummary { key: string; label: string; rows: number; truncated: boolean; omitted?: string }

export interface PersonalDataExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  generatedAt: string;
  userId: string;
  /** False only when a section hit MAX_ROWS_PER_SECTION; a failed read never yields an export at all. */
  complete: boolean;
  sections: SectionSummary[];
  data: Record<string, Row[]>;
  /** The handle and name of every other person a section names by id. */
  people: Record<string, { handle: string | null; name: string | null }>;
  notIncluded: readonly string[];
}

export class ExportReadError extends Error {
  constructor(readonly section: string, readonly cause: unknown) {
    super(`personal data export: the ${section} read failed`);
  }
}

/**
 * Every page of one filtered read. `filter` adds the person-scoping clause
 * (`.eq(owner, id)` or `.in(column, parentIds)`); nothing is read without one.
 */
async function readAll(
  sc: SupabaseClient,
  s: ExportSection,
  filter: (q: any) => any,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const select = s.columns ? s.columns.join(", ") : "*";
  const rows: Row[] = [];
  for (let from = 0; from < MAX_ROWS_PER_SECTION; from += PAGE_SIZE) {
    let q = filter(sc.from(s.table).select(select));
    for (const c of s.orderBy) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new ExportReadError(s.key, error);
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

function strip(rows: Row[], omit: readonly string[] | undefined): Row[] {
  if (!omit || omit.length === 0) return rows;
  return rows.map((r) => {
    const out: Row = { ...r };
    for (const c of omit) delete out[c];
    return out;
  });
}

async function readSection(
  sc: SupabaseClient,
  s: ExportSection,
  userId: string,
  done: Map<string, Row[]>,
): Promise<{ rows: Row[]; truncated: boolean }> {
  if (s.via) {
    const parentIds = (done.get(s.via.section) ?? []).map((r) => r.id).filter((v): v is string => typeof v === "string");
    const rows: Row[] = [];
    let truncated = false;
    for (let i = 0; i < parentIds.length; i += IN_CHUNK) {
      const chunk = parentIds.slice(i, i + IN_CHUNK);
      const r = await readAll(sc, s, (q) => q.in(s.via!.column, chunk));
      rows.push(...r.rows);
      truncated ||= r.truncated;
    }
    return { rows, truncated };
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const owner of s.owners) {
    const r = await readAll(sc, s, (q) => q.eq(owner, userId));
    truncated ||= r.truncated;
    for (const row of r.rows) {
      // A row can name the person in two owner columns only in a malformed
      // table; key on the ordering columns so it is listed once either way.
      const k = s.orderBy.map((c) => String(row[c])).join("\u0000");
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(row);
    }
  }
  return { rows, truncated };
}

async function resolvePeople(sc: SupabaseClient, ids: string[]): Promise<PersonalDataExport["people"]> {
  const people: PersonalDataExport["people"] = {};
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await sc.from("profiles").select("id, handle, name").in("id", chunk);
    if (error) throw new ExportReadError("people", error);
    for (const p of (data ?? []) as Array<{ id: string; handle: string | null; name: string | null }>) {
      people[p.id] = { handle: p.handle ?? null, name: p.name ?? null };
    }
  }
  return people;
}

/**
 * Build the person's export, or throw ExportReadError naming the first section
 * whose read failed. There is no partial result.
 */
export async function buildPersonalDataExport(
  sc: SupabaseClient,
  userId: string,
  now: () => Date = () => new Date(),
): Promise<PersonalDataExport> {
  const done = new Map<string, Row[]>();
  const truncatedKeys = new Set<string>();

  // Parents first (a `via` section needs its parent's ids), a few at a time.
  const direct = EXPORT_SECTIONS.filter((s) => !s.via);
  const derived = EXPORT_SECTIONS.filter((s) => s.via);
  for (const batch of [direct, derived]) {
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(batch.slice(i, i + CONCURRENCY).map(async (s) => {
        const r = await readSection(sc, s, userId, done);
        done.set(s.key, r.rows);
        if (r.truncated) truncatedKeys.add(s.key);
      }));
    }
  }

  const otherIds = new Set<string>();
  for (const s of EXPORT_SECTIONS) {
    for (const c of s.people ?? []) {
      for (const row of done.get(s.key) ?? []) {
        const v = row[c];
        if (typeof v === "string" && v !== userId) otherIds.add(v);
      }
    }
  }
  const people = await resolvePeople(sc, [...otherIds].sort());

  const data: Record<string, Row[]> = {};
  const sections: SectionSummary[] = [];
  for (const s of EXPORT_SECTIONS) {
    data[s.key] = strip(done.get(s.key) ?? [], s.omit);
    sections.push({
      key: s.key, label: s.label, rows: data[s.key].length, truncated: truncatedKeys.has(s.key),
      ...(s.omitWhy ? { omitted: s.omitWhy } : {}),
    });
  }

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    generatedAt: now().toISOString(),
    userId,
    complete: truncatedKeys.size === 0,
    sections,
    data,
    people,
    notIncluded: NOT_INCLUDED,
  };
}
