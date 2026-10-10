/**
 * moderationReportSnapshots — what a moderator is shown about the thing a
 * `moderation_reports` row names (census-trust TV-4a, "view subject content
 * snapshot").
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `GET /admin/moderation/reports` enriched only `place` reports. A reported
 * post, comment, message, event, review, buddy listing, media item or user
 * arrived as a bare UUID, so a moderator could not judge a report without
 * leaving the queue — and the one enrichment that existed discarded its read
 * error, so an unreadable `places` table showed every place report with no
 * name, as if the place had none.
 *
 * ── THREE STATES, NEVER TWO ─────────────────────────────────────────────────
 * Every subject gets exactly one of:
 *   ok           the row was read; the fields below are what it says now;
 *   not_found    the read ran and the row is gone (deleted content is a real,
 *                common answer for a report — say it);
 *   unavailable  the read FAILED. Not a fact about the content: a moderator
 *                must not dismiss a report because its snapshot looked empty.
 *   unsupported  a subject type this module has no reader for.
 * A failed read is reported for every row of that type, and reads are batched
 * per subject type (one query per type per page, never one per report).
 *
 * ── WHAT IS SHOWN, AND WHAT IS NOT ──────────────────────────────────────────
 * The minimum a moderator needs to judge the report: the text (truncated to
 * SNAPSHOT_EXCERPT_CHARS), who is accountable for it, and whether it has since
 * been deleted. Never a coordinate, never an email or phone, never media URLs.
 * A DELETED message or comment shows no text: the author removed it, and the
 * report row still carries the reporter's own `details`.
 *
 * Columns are the schema's (baseline 20260819 + migrations), not the generated
 * types: posts.content/author_id/deleted_at, posts_comments.body/user_id/
 * deleted_at, messages.body/sender_id/deleted_at, events.title/host_id/
 * starts_at/city/state, reviews.body/rating/reviewer_id/entity_type/state,
 * rent_buddy_profiles.display_name/tagline/user_id/status, media_assets.
 * media_type/caption/owner_user_id/moderation_status, profiles.name/handle/
 * account_status, places.name/address.
 */

/**
 * Re-exported for routes/admin.ts's review route, so that file gains no import
 * LINE: its lines below the moderation block are cited by a commit-pinned
 * record (docs/architecture/trust-unproduced-vocabulary.md) and must not move.
 */
export { resolveContentOwnerDetailed } from "./contentOwner.js";
import { probeSchemaReadiness, readFlagState } from "./capability/schemaCapability.js";
import { logger } from "./logger.js";
import { SCHEMA_PROBE_SENTINEL_ID, type CapabilityDefinition } from "./capability/schemaRequirement.js";

export const SNAPSHOT_EXCERPT_CHARS = 280;

/** moderation_reports.category CHECK (baseline 20260819; 2029 widened it). */
export const MODERATION_REPORT_CATEGORIES = [
  "impersonation", "harassment", "scam_fraud", "inappropriate_content", "safety_concern",
  "underage", "spam", "other", "wrong_place", "wrong_photo", "duplicate", "closed",
  "incorrect_address", "incorrect_category", "outdated_image",
] as const;

/** moderation_reports.status CHECK. */
export const MODERATION_REPORT_STATUSES = ["open", "reviewing", "actioned", "dismissed"] as const;
export type ModerationReportStatus = (typeof MODERATION_REPORT_STATUSES)[number];

/** Which status a moderator may move a report to, from which. Terminal states move nowhere. */
export const MODERATION_REPORT_TRANSITIONS: Readonly<Record<ModerationReportStatus, readonly ModerationReportStatus[]>> = {
  open: ["reviewing", "actioned", "dismissed"],
  reviewing: ["actioned", "dismissed"],
  actioned: [],
  dismissed: [],
};

export type SubjectSnapshot =
  | ({ state: "ok" } & Record<string, unknown>)
  | { state: "not_found" }
  | { state: "unavailable" }
  | { state: "unsupported" };

interface ReportLike { id: string; subject_type: string; subject_id: string | null }

function excerpt(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > SNAPSHOT_EXCERPT_CHARS ? `${t.slice(0, SNAPSHOT_EXCERPT_CHARS - 1)}…` : t;
}

interface Reader {
  table: string;
  select: string;
  /** The column the subject_id is matched against. */
  key: string;
  shape: (row: any) => Record<string, unknown>;
}

const READERS: Readonly<Record<string, Reader>> = {
  user: {
    table: "profiles", select: "id, name, handle, account_status", key: "id",
    shape: (r) => ({ name: r.name ?? null, handle: r.handle ?? null, accountStatus: r.account_status ?? null, accountableUserId: r.id }),
  },
  post: {
    table: "posts", select: "id, author_id, content, created_at, deleted_at", key: "id",
    shape: (r) => ({ excerpt: r.deleted_at ? null : excerpt(r.content), createdAt: r.created_at ?? null, deleted: !!r.deleted_at, accountableUserId: r.author_id ?? null }),
  },
  comment: {
    table: "posts_comments", select: "id, post_id, user_id, body, created_at, deleted_at", key: "id",
    shape: (r) => ({ excerpt: r.deleted_at ? null : excerpt(r.body), postId: r.post_id ?? null, createdAt: r.created_at ?? null, deleted: !!r.deleted_at, accountableUserId: r.user_id ?? null }),
  },
  message: {
    table: "messages", select: "id, thread_id, sender_id, body, created_at, deleted_at", key: "id",
    shape: (r) => ({ excerpt: r.deleted_at ? null : excerpt(r.body), threadId: r.thread_id ?? null, createdAt: r.created_at ?? null, deleted: !!r.deleted_at, accountableUserId: r.sender_id ?? null }),
  },
  event: {
    table: "events", select: "id, host_id, title, starts_at, city, state", key: "id",
    shape: (r) => ({ title: excerpt(r.title), startsAt: r.starts_at ?? null, city: r.city ?? null, eventState: r.state ?? null, accountableUserId: r.host_id ?? null }),
  },
  review: {
    table: "reviews", select: "id, reviewer_id, entity_type, entity_id, rating, body, state", key: "id",
    shape: (r) => ({ excerpt: excerpt(r.body), rating: r.rating ?? null, reviewedEntityType: r.entity_type ?? null, reviewedEntityId: r.entity_id ?? null, reviewState: r.state ?? null, accountableUserId: r.reviewer_id ?? null }),
  },
  buddy_listing: {
    table: "rent_buddy_profiles", select: "id, user_id, display_name, tagline, status", key: "id",
    shape: (r) => ({ displayName: r.display_name ?? null, tagline: excerpt(r.tagline), listingStatus: r.status ?? null, accountableUserId: r.user_id ?? null }),
  },
  media: {
    table: "media_assets", select: "id, owner_user_id, media_type, caption, moderation_status", key: "id",
    shape: (r) => ({ mediaType: r.media_type ?? null, caption: excerpt(r.caption), moderationStatus: r.moderation_status ?? null, accountableUserId: r.owner_user_id ?? null }),
  },
  place: {
    table: "places", select: "id, name, address", key: "id",
    shape: (r) => ({ name: r.name ?? null, address: r.address ?? null, accountableUserId: null }),
  },
};

export const SNAPSHOT_SUBJECT_TYPES: readonly string[] = Object.freeze(Object.keys(READERS));

/**
 * One snapshot per report id. Never throws; a failed read becomes
 * `unavailable` for that subject type and is returned in `failedTypes` so the
 * route can say the page is incomplete.
 */
export async function loadModerationSubjectSnapshots(
  sc: any,
  reports: readonly ReportLike[],
): Promise<{ snapshots: Map<string, SubjectSnapshot>; failedTypes: string[] }> {
  const snapshots = new Map<string, SubjectSnapshot>();
  const failedTypes: string[] = [];
  const byType = new Map<string, ReportLike[]>();
  for (const r of reports) {
    if (!READERS[r.subject_type]) { snapshots.set(r.id, { state: "unsupported" }); continue; }
    if (!r.subject_id) { snapshots.set(r.id, { state: "not_found" }); continue; }
    const list = byType.get(r.subject_type) ?? [];
    list.push(r);
    byType.set(r.subject_type, list);
  }

  for (const [type, list] of byType) {
    const reader = READERS[type]!;
    const ids = [...new Set(list.map((r) => r.subject_id as string))];
    let rows: any[] | null = null;
    try {
      const { data, error } = await sc.from(reader.table).select(reader.select).in(reader.key, ids);
      if (!error) rows = (data ?? []) as any[];
    } catch {
      rows = null;
    }
    // buddy_listing: a subject id may name the listing row OR its user
    // (lib/contentOwner.ts keeps the same two-step). Only ids the first read
    // did not find are tried again, and a failed second read fails the type.
    if (rows && type === "buddy_listing") {
      const found = new Set(rows.map((r) => String(r.id)));
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        try {
          const { data, error } = await sc.from(reader.table).select(reader.select).in("user_id", missing);
          if (error) rows = null;
          else rows = [...rows, ...((data ?? []) as any[]).map((r) => ({ ...r, __matchedBy: String(r.user_id) }))];
        } catch {
          rows = null;
        }
      }
    }
    if (!rows) {
      failedTypes.push(type);
      for (const r of list) snapshots.set(r.id, { state: "unavailable" });
      continue;
    }
    const index = new Map<string, any>();
    for (const row of rows) index.set(String(row.__matchedBy ?? row[reader.key]), row);
    for (const r of list) {
      const row = index.get(String(r.subject_id));
      snapshots.set(r.id, row ? { state: "ok", ...reader.shape(row) } : { state: "not_found" });
    }
  }
  return { snapshots, failedTypes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead ruling Q-L23 / D-38a (2026-10-06): capture the reported content WHEN THE
// REPORT IS FILED — for moderators only, deleted with the report, never shown to
// the reporter or the reported person. Migration 3705 (moderation_report_captures,
// ON DELETE CASCADE from moderation_reports; service-role only), behind
// moderation_report_capture_enabled, seeded FALSE.
//
// WHY. The snapshot above is read LIVE when a moderator opens the queue, so a
// person whose post, comment or message was reported could delete or edit it
// before review and leave the moderator nothing to judge. The capture is the
// same reader's output at the moment of the report, minus the accountable
// user's id (the report row already names the subject; the capture carries no
// person uuid of its own).
//
// THE SAME D-MODACTION-SHAPE MIGRATION adds moderation_actions.report_id (a
// real FK, SET NULL with the report); lib/moderationAudit.ts writes it once this
// database has 3705 (`moderationActionReportLinkReady`), alongside the
// metadata.report_id it has always written.
// ─────────────────────────────────────────────────────────────────────────────

export const MODERATION_REPORT_CAPTURE_FLAG = "moderation_report_capture_enabled";

/** Capability: the capture table and the action link, both from 3705. */
export const MODERATION_REPORT_CAPTURE: CapabilityDefinition = {
  flag: MODERATION_REPORT_CAPTURE_FLAG,
  providedBy: ["3705_moderation_report_capture_and_action_link.sql"],
  requires: {
    tables: {
      // Keyed by report_id — there is no `id`, so the default sentinel probe would answer 42703.
      moderation_report_captures: {
        columns: ["report_id", "capture_state", "snapshot", "captured_at"],
        probe: { column: "report_id", value: SCHEMA_PROBE_SENTINEL_ID },
      },
      moderation_actions: { columns: ["report_id"] },
    },
  },
  consumers: ["lib/moderationReportSnapshots.ts", "lib/moderationAudit.ts"],
  note:
    "A capture written to a database without 3705 would fail on every report; refusing leaves the moderator the live " +
    "snapshot, as before, and the report itself is filed either way.",
};

/** One capture, as stored and as a moderator is shown it. */
export interface ReportCapture {
  capture_state: SubjectSnapshot["state"];
  /** The reader's moderator-facing fields at report time, without `accountableUserId`. */
  snapshot: Record<string, unknown>;
  captured_at: string;
}

/**
 * Read the reported content NOW, for a report about to be filed. `null` when
 * capture is not on here (flag off, absent or unreadable, or 3705 not applied):
 * nothing is read. Never throws, and never refuses the report: a read that fails
 * is captured as `unavailable` — said, not dressed as missing content.
 */
export async function captureReportedContent(
  sc: any,
  subjectType: string,
  subjectId: string,
  nowMs: number = Date.now(),
): Promise<ReportCapture | null> {
  // The capability contract (flag on AND schema ready), read through the shared
  // four-valued reader so check:flag-polarity sees the flag read by name.
  let flag: string;
  try { flag = await readFlagState(sc, MODERATION_REPORT_CAPTURE_FLAG); } catch { flag = "unreadable"; }
  if (flag !== "on") return null;
  let schema: string;
  try { schema = (await probeSchemaReadiness(sc, MODERATION_REPORT_CAPTURE)).state; } catch { schema = "unknown"; }
  if (schema !== "ready") {
    logger.error(
      { capability: MODERATION_REPORT_CAPTURE_FLAG, schemaState: schema, providedBy: MODERATION_REPORT_CAPTURE.providedBy },
      `capability ${MODERATION_REPORT_CAPTURE_FLAG} is ON but its schema is not ready — nothing captured; the report is filed. Apply 3705 or turn the flag off.`,
    );
    return null;
  }
  const { snapshots } = await loadModerationSubjectSnapshots(sc, [{ id: "capture", subject_type: subjectType, subject_id: subjectId }]);
  const snap = (snapshots.get("capture") ?? { state: "unsupported" }) as Record<string, unknown> & { state: SubjectSnapshot["state"] };
  const { state, accountableUserId: _accountable, ...fields } = snap;
  return { capture_state: state, snapshot: fields, captured_at: new Date(nowMs).toISOString() };
}

/** Store a capture against the report it was taken for. Never throws. */
export async function recordReportCapture(
  sc: any,
  reportId: string,
  capture: ReportCapture,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await sc.from("moderation_report_captures").insert({ report_id: reportId, ...capture });
    return error ? { ok: false, error: String(error.message ?? error) } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as any)?.message ?? err) };
  }
}

/**
 * What a moderator is shown about each report's capture. FOUR states, so an
 * outage or an unapplied migration is never read as "nothing was captured":
 *   captured      the capture, as taken when the report was filed;
 *   none          the read ran, and no capture exists for this report;
 *   unavailable   the read FAILED (or readiness could not be established);
 *   not_deployed  3705 is not applied here, so nothing could have been captured.
 */
export type CapturedContent =
  | { state: "captured"; capture: ReportCapture }
  | { state: "none" }
  | { state: "unavailable" }
  | { state: "not_deployed" };

export async function loadCapturedReportContent(
  sc: any,
  reportIds: readonly string[],
): Promise<{ captures: Map<string, CapturedContent>; unavailable: boolean }> {
  const captures = new Map<string, CapturedContent>();
  const ids = [...new Set(reportIds.map(String))];
  if (ids.length === 0) return { captures, unavailable: false };
  const fill = (c: CapturedContent) => { for (const id of ids) captures.set(id, c); };
  let state: string;
  try { state = (await probeSchemaReadiness(sc, MODERATION_REPORT_CAPTURE)).state; } catch { state = "unknown"; }
  if (state === "missing") { fill({ state: "not_deployed" }); return { captures, unavailable: false }; }
  if (state !== "ready") { fill({ state: "unavailable" }); return { captures, unavailable: true }; }
  let rows: any[] | null = null;
  try {
    const { data, error } = await sc
      .from("moderation_report_captures")
      .select("report_id, capture_state, snapshot, captured_at")
      .in("report_id", ids);
    if (!error) rows = (data ?? []) as any[];
  } catch {
    rows = null;
  }
  if (!rows) { fill({ state: "unavailable" }); return { captures, unavailable: true }; }
  const byId = new Map(rows.map((r) => [String(r.report_id), r]));
  for (const id of ids) {
    const r = byId.get(id);
    captures.set(id, r
      ? { state: "captured", capture: { capture_state: r.capture_state, snapshot: (r.snapshot ?? {}) as Record<string, unknown>, captured_at: r.captured_at } }
      : { state: "none" });
  }
  return { captures, unavailable: false };
}

/** D-MODACTION-SHAPE: may moderation_actions.report_id be written on this database (3705 applied)? Never throws. */
export async function moderationActionReportLinkReady(sc: any): Promise<boolean> {
  try { return (await probeSchemaReadiness(sc, MODERATION_REPORT_CAPTURE)).state === "ready"; } catch { return false; }
}
