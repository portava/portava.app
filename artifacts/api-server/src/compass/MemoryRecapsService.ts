/**
 * MemoryRecapsService — §5 "Personal Recaps" and "On This Day".
 *
 * PRIVATE, OWNER-ONLY, and SHIPS DISABLED behind the `memory_recaps` flag until
 * deletion / consent / retention behaviour is certified. This is a construction,
 * not a launch: every entry point checks the flag FIRST and fail-closed, so with
 * the flag off nothing here touches memory at all.
 *
 * ── IT REUSES THE §12 BOUNDARY. IT DOES NOT INVENT A SECOND ONE. ─────────────
 * The allow/deny boundary for what a user may see about themselves lives in
 * exactly one place — memory_remembers_for_user (migration 2213) — and §5 draws
 * on it wholesale:
 *
 *   - DERIVED memory: via memory_recaps_for_user (2214), a THIN windowed delegate
 *     of memory_remembers_for_user (adds no deny logic; a window is subtractive),
 *     then through the SAME mapper + defence-in-depth deny gate (mapDerivedRow).
 *   - SOURCE content (saved places / postcards / stamps / trips / consented
 *     Shared Moments): via the SAME §12 builders (buildSavedContent,
 *     buildSharedMoments) — the exact per-table deny filters (moderation status,
 *     tombstones, revocation, and the accepted-membership CONSENT gate).
 *   - SUPPRESSION: via the SAME loadSuppressions + isSuppressed — so "Forget"
 *     from the §12 controls uniformly removes an item here too.
 *
 * §5 adds NOTHING to that boundary. It adds only (a) a time DIMENSION (window /
 * anniversary) and (b) a narrower, fail-closed RESURFACING gate on top of the
 * already-eligible set (see isResurfaceable).
 *
 * ── STATELESS BY DESIGN — RE-CHECK ON EVERY CALL ─────────────────────────────
 * Nothing is snapshotted. Every generate/open re-runs the eligibility filter
 * from live data, so an item that has since been forgotten / made sensitive /
 * had its consent withdrawn / been deleted DROPS OUT on the next call. We persist
 * no recap rows; if we ever did, we would persist references and re-filter on
 * read. Statelessness is the simplest correct design and we keep it.
 *
 * ── NEVER AUTO-PUBLISHES ─────────────────────────────────────────────────────
 * Generation is READ-ONLY. It returns the recap to the owner and writes to no
 * public/feed/social surface. `published` is always false.
 *
 * ── DATE IS INJECTED, NEVER Date.now() ───────────────────────────────────────
 * "today"/"now" is always passed IN. The route derives it from the request time;
 * tests inject a fixed date. This module never reads the wall clock as the source
 * of truth for windowing or anniversary matching.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  buildSavedContent,
  buildSharedMoments,
  loadSuppressions,
  isSuppressed,
  mapDerivedRow,
  type RememberItem,
} from "./PassportRemembersService.js";

/** Master certification gate. Off ⇒ every read is inert and does zero work. */
export const MEMORY_RECAPS_FLAG = "memory_recaps";

/**
 * The recap/on-this-day notification opt-in is stored in the EXISTING
 * notification_category_preferences table under this category — no parallel prefs
 * table. Unlike other categories (absent row = enabled), this opt-in DEFAULTS OFF:
 * only an explicit, stored, enabled row opts the user in. See isRecapNotificationOptIn.
 */
export const RECAP_NOTIFICATION_CATEGORY = "memory_recaps";

export type RecapKind = "trip" | "month" | "year" | "milestone";

// ── The §5 fail-closed RESURFACING gate ──────────────────────────────────────
// These are the ONLY source classes §5 will resurface. They are structured,
// user-created/kept passport artefacts whose creation IS an affirmative act.
//
// "Explicitly saved for resurfacing" — the schema decision:
//   The current schema has NO per-item emotional-valence column and NO dedicated
//   "save this for resurfacing" flag. Rather than GUESS whether a memory is
//   painful (explicitly forbidden), §5 FAILS CLOSED: it resurfaces only these
//   structured classes and NEVER free-text scrapbook memories, saved Compass
//   notes, or profile/preference/availability facts, whose valence is unknown.
//   sensitive derived memory is already excluded upstream by the §12 core
//   (sensitivity='sensitive'), which is the primary painful/sensitive catch.
//   The user's own hide/forget/not_interested signals are honoured as the
//   explicit "do not resurface this" opt-out (see loadSuppressionsWithNotInterested).
//   If a real per-item resurface opt-in or valence signal is added later, tighten
//   this set; the default stays exclusion.
const RESURFACEABLE_SUBJECT_TYPES = new Set<string>([
  "passport:saved_place",
  "passport:postcard",
  "passport:stamp",
  "passport:trip",
  "passport:shared_moment",
]);

// On This Day resurfaces the narrower celebratory set the §5 spec names:
// Postcards, trips, stamps, and consented Shared Moments (NOT saved places).
const ON_THIS_DAY_SUBJECT_TYPES = new Set<string>([
  "passport:postcard",
  "passport:trip",
  "passport:stamp",
  "passport:shared_moment",
]);

// Belt-and-suspenders: subject keys / origin tables that would indicate a raw
// location trail or a safety incident. The §12 builders never read those tables,
// so this set should always be empty in practice — it exists to ASSERT that and
// to fail closed if a future builder ever introduced such a row.
const FORBIDDEN_SUBJECT_RE =
  /(location_snapshot|location_event|raw_location|trail|proximity|geofence|safe_return|safety_incident|incident|sos|panic)/i;

export interface RecapItemView {
  id: string;
  group: RememberItem["group"];
  label: string;
  title: string;
  detail?: string;
  occurredAt?: string;
  isInferred: boolean;
  subjectType: string;
  visibility: string;
}

export interface RecapWindow {
  from: string | null;
  to: string | null;
  label: string;
}

export interface RecapExclusions {
  /** Removed because the §12 eligibility boundary excluded them (or suppression). */
  ineligibleOrSuppressed: number;
  /** Removed by the §5 fail-closed resurfacing gate (unknown-valence classes). */
  notResurfaceable: number;
}

export interface Recap {
  ownerId: string;
  kind: RecapKind;
  window: RecapWindow;
  visibility: "owner_only";
  /** ALWAYS false: generation never auto-publishes. */
  published: false;
  /** Inert when the master flag is off. */
  enabled: boolean;
  sections: Array<{ group: string; label: string; items: RecapItemView[] }>;
  totals: { included: number } & RecapExclusions;
  notes: string[];
}

export interface OnThisDay {
  ownerId: string;
  /** The month/day the anniversaries are matched against (injected). */
  date: { month: number; day: number };
  visibility: "owner_only";
  published: false;
  enabled: boolean;
  items: RecapItemView[];
  totals: { included: number } & RecapExclusions;
  notes: string[];
}

export interface RecapRequest {
  kind: RecapKind;
  /** kind=trip: the owner's trip to summarise. */
  tripId?: string;
  /** kind=month|year: the calendar year. */
  year?: number;
  /** kind=month: 1-12. */
  month?: number;
  /** kind=milestone: a free label for the snapshot (e.g. "first_year"). */
  milestone?: string;
  /** Injected reference time (request time in the route; fixed in tests). */
  now: Date;
}

const INERT_NOTES = [
  "Personal Recaps and On This Day are not enabled yet.",
];

const RECAP_NOTES = [
  "This recap is private to you and is never posted anywhere — generating it publishes nothing.",
  "It is rebuilt from scratch every time you open it, so anything you have since forgotten, hidden, made sensitive, or deleted is not in it.",
  "Painful or sensitive events are not resurfaced. Raw location, trust/safety signals, and content you did not consent to share are never included.",
];

function toView(item: RememberItem): RecapItemView {
  return {
    id: item.id,
    group: item.group,
    label: item.label,
    title: item.title,
    detail: item.detail,
    occurredAt: item.occurredAt,
    isInferred: item.isInferred,
    subjectType: item.subjectType,
    visibility: item.visibility,
  };
}

/**
 * The §5 resurfacing gate over an ALREADY-ELIGIBLE item (post §12 filter +
 * suppression). Fail-closed: an item is resurfaceable only if it is on the
 * allow-list AND carries no forbidden subject signal. Everything else is dropped.
 */
function isResurfaceable(item: RememberItem, allowed: Set<string>): boolean {
  const hay = `${item.subjectType} ${item.source?.originTable ?? ""}`;
  if (FORBIDDEN_SUBJECT_RE.test(hay)) return false; // raw-location / safety — never
  return allowed.has(item.subjectType);
}

/**
 * Load hide/forget suppressions (the §12 set) PLUS 'not_interested' — the
 * explicit "do not resurface this" opt-out. 'not_interested' is a §5-specific
 * addition to the suppression set (it is not a §12 view-suppression): the §12
 * surface still shows the item for transparency, but §5 must not RESURFACE
 * something the user said they are not interested in.
 */
async function loadRecapSuppressions(client: SupabaseClient, userId: string) {
  const base = await loadSuppressions(client, userId);
  try {
    const { data, error } = await client
      .from("memory_feedback")
      .select("kind, subject_type, subject_id, projection_id")
      .eq("user_id", userId);
    if (!error && Array.isArray(data)) {
      for (const row of data as Array<Record<string, unknown>>) {
        if (String(row.kind ?? "") !== "not_interested") continue;
        if (row.subject_id != null) base.keys.add(`${row.subject_type ?? ""}::${row.subject_id ?? ""}`);
        if (row.projection_id != null) base.projectionIds.add(String(row.projection_id));
      }
    }
  } catch {
    // Fail-available on the ADD-ON only: the §12 base suppression already loaded.
  }
  return base;
}

// ── Derived memory through the §12 core, windowed ────────────────────────────
async function buildWindowedDerived(
  client: SupabaseClient,
  userId: string,
  from: string | null,
  to: string | null,
): Promise<RememberItem[]> {
  const { data, error } = await client.rpc("memory_recaps_for_user", {
    p_user_id: userId,
    p_from: from,
    p_to: to,
  });
  if (error || !Array.isArray(data)) return [];
  const out: RememberItem[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    const item = mapDerivedRow(r); // SAME mapper + deny gate as §12
    if (item) out.push(item);
  }
  return out;
}

// ── UTC date helpers (injected date only) ────────────────────────────────────
function ymdUTC(iso: string): { y: number; m: number; d: number } | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function monthWindow(year: number, month: number): { from: string; to: string; label: string } {
  const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const to = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)).toISOString();
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return { from, to, label: `${label} ${year}` };
}

function yearWindow(year: number): { from: string; to: string; label: string } {
  return {
    from: new Date(Date.UTC(year, 0, 1)).toISOString(),
    to: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
    label: String(year),
  };
}

function inWindow(occurredAt: string | undefined, from: string | null, to: string | null): boolean {
  if (!occurredAt) return false; // no date ⇒ cannot place in a window ⇒ excluded
  const t = new Date(occurredAt).getTime();
  if (Number.isNaN(t)) return false;
  if (from != null && t < new Date(from).getTime()) return false;
  if (to != null && t >= new Date(to).getTime()) return false;
  return true;
}

// ── Resolve a trip window (owner-scoped) ─────────────────────────────────────
async function resolveTripWindow(
  client: SupabaseClient,
  userId: string,
  tripId: string,
): Promise<{ from: string | null; to: string | null; label: string } | null> {
  try {
    const { data, error } = await client
      .from("trips")
      .select("id, title, destination_city, start_date, end_date, created_at, status")
      .eq("id", tripId)
      .eq("owner_id", userId) // OWNERSHIP: a borrowed trip id resolves to nothing
      .maybeSingle();
    if (error || !data) return null;
    const r = data as Record<string, unknown>;
    const start = isoLike(r.start_date) ?? isoLike(r.created_at);
    const end = isoLike(r.end_date);
    // Window is [start-of-day(start), end-of-day(end)]. If only a start exists,
    // bound the window to that single day so a trip with no end still recaps.
    const from = start ? new Date(new Date(start).getTime()).toISOString() : null;
    let to: string | null = null;
    if (end) {
      const e = new Date(end);
      e.setUTCHours(23, 59, 59, 999);
      to = e.toISOString();
    } else if (start) {
      const e = new Date(start);
      e.setUTCHours(23, 59, 59, 999);
      to = e.toISOString();
    }
    const label = String(r.title ?? r.destination_city ?? "Trip");
    return { from, to, label };
  } catch {
    return null;
  }
}

function isoLike(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

// ── Public: is §5 enabled at all? ────────────────────────────────────────────
export async function isRecapsEnabled(client: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(client, MEMORY_RECAPS_FLAG);
}

function inertRecap(userId: string, kind: RecapKind): Recap {
  return {
    ownerId: userId,
    kind,
    window: { from: null, to: null, label: "" },
    visibility: "owner_only",
    published: false,
    enabled: false,
    sections: [],
    totals: { included: 0, ineligibleOrSuppressed: 0, notResurfaceable: 0 },
    notes: INERT_NOTES,
  };
}

function inertOnThisDay(userId: string, month: number, day: number): OnThisDay {
  return {
    ownerId: userId,
    date: { month, day },
    visibility: "owner_only",
    published: false,
    enabled: false,
    items: [],
    totals: { included: 0, ineligibleOrSuppressed: 0, notResurfaceable: 0 },
    notes: INERT_NOTES,
  };
}

const SECTION_LABELS: Record<string, string> = {
  derived_memory: "What Portava remembers",
  saved_content: "Places, postcards, stamps & trips",
  shared_moment: "Shared Moments",
};

/**
 * Generate a recap for a window. FLAG-GATED (off ⇒ inert, zero work),
 * OWNER-ONLY, STATELESS, and NEVER auto-publishes.
 */
export async function generateRecap(
  client: SupabaseClient,
  userId: string,
  req: RecapRequest,
): Promise<Recap> {
  // Fail-closed master gate: if off, do ZERO work — no builders, no RPC, no reads.
  if (!(await isRecapsEnabled(client))) return inertRecap(userId, req.kind);
  if (!userId) return inertRecap(userId, req.kind);

  // Resolve the window.
  let from: string | null = null;
  let to: string | null = null;
  let windowLabel = "All time";
  if (req.kind === "trip") {
    if (!req.tripId) return { ...inertRecap(userId, req.kind), enabled: true, notes: ["No trip specified."] };
    const w = await resolveTripWindow(client, userId, req.tripId);
    if (!w) return { ...inertRecap(userId, req.kind), enabled: true, notes: ["Trip not found."] };
    from = w.from; to = w.to; windowLabel = w.label;
  } else if (req.kind === "month") {
    const y = req.year ?? req.now.getUTCFullYear();
    const m = req.month ?? req.now.getUTCMonth() + 1;
    const w = monthWindow(y, m); from = w.from; to = w.to; windowLabel = w.label;
  } else if (req.kind === "year") {
    const y = req.year ?? req.now.getUTCFullYear();
    const w = yearWindow(y); from = w.from; to = w.to; windowLabel = w.label;
  } else {
    // milestone: a labelled snapshot of the whole eligible history (unbounded).
    windowLabel = req.milestone ? `Milestone: ${req.milestone}` : "Milestone";
  }

  const suppressions = await loadRecapSuppressions(client, userId);

  // Assemble from the §12 building blocks — derived (windowed, via the core) and
  // source content (via the §12 builders, with their exact deny + consent gates).
  const [derived, saved, moments] = await Promise.all([
    buildWindowedDerived(client, userId, from, to),
    buildSavedContent(client, userId),
    buildSharedMoments(client, userId),
  ]);

  let ineligibleOrSuppressed = 0;
  let notResurfaceable = 0;
  let included = 0;

  const sections: Array<{ group: string; label: string; items: RecapItemView[] }> = [];

  const pushSection = (group: string, items: RememberItem[], opts: { windowed: boolean; resurfaceGate: boolean }) => {
    const kept: RecapItemView[] = [];
    for (const item of items) {
      if (isSuppressed(item, suppressions)) { ineligibleOrSuppressed += 1; continue; }
      if (opts.resurfaceGate && !isResurfaceable(item, RESURFACEABLE_SUBJECT_TYPES)) { notResurfaceable += 1; continue; }
      // Window: derived is already SQL-windowed; source content is windowed here
      // on its occurredAt. A milestone recap is unbounded (from=to=null ⇒ all in).
      if (opts.windowed && (from != null || to != null) && !inWindow(item.occurredAt, from, to)) {
        continue; // outside the window — not an exclusion, just not in range
      }
      kept.push(toView(item));
    }
    if (kept.length > 0) {
      included += kept.length;
      sections.push({ group, label: SECTION_LABELS[group] ?? group, items: kept });
    }
  };

  // Derived memory came back already windowed from SQL; do NOT re-window it here.
  pushSection("derived_memory", derived, { windowed: false, resurfaceGate: false });
  pushSection("saved_content", saved, { windowed: true, resurfaceGate: true });
  pushSection("shared_moment", moments, { windowed: true, resurfaceGate: true });

  return {
    ownerId: userId,
    kind: req.kind,
    window: { from, to, label: windowLabel },
    visibility: "owner_only",
    published: false,
    enabled: true,
    sections,
    totals: { included, ineligibleOrSuppressed, notResurfaceable },
    notes: RECAP_NOTES,
  };
}

/**
 * On This Day: surface eligible Postcards, trips, stamps and consented Shared
 * Moments whose anniversary (same month-day, an EARLIER year) is the injected
 * "today". FLAG-GATED, OWNER-ONLY, STATELESS, NEVER auto-publishes.
 */
export async function buildOnThisDay(
  client: SupabaseClient,
  userId: string,
  opts: { now: Date },
): Promise<OnThisDay> {
  const todayM = opts.now.getUTCMonth() + 1;
  const todayD = opts.now.getUTCDate();
  const todayY = opts.now.getUTCFullYear();

  if (!(await isRecapsEnabled(client))) return inertOnThisDay(userId, todayM, todayD);
  if (!userId) return inertOnThisDay(userId, todayM, todayD);

  const suppressions = await loadRecapSuppressions(client, userId);
  const [saved, moments] = await Promise.all([
    buildSavedContent(client, userId),
    buildSharedMoments(client, userId),
  ]);

  let ineligibleOrSuppressed = 0;
  let notResurfaceable = 0;
  const items: RecapItemView[] = [];

  for (const item of [...saved, ...moments]) {
    if (isSuppressed(item, suppressions)) { ineligibleOrSuppressed += 1; continue; }
    if (!isResurfaceable(item, ON_THIS_DAY_SUBJECT_TYPES)) { notResurfaceable += 1; continue; }
    if (!item.occurredAt) continue;
    const ymd = ymdUTC(item.occurredAt);
    if (!ymd) continue;
    // Anniversary: same month-day, an EARLIER year than today.
    if (ymd.m === todayM && ymd.d === todayD && ymd.y < todayY) {
      items.push(toView(item));
    }
  }

  return {
    ownerId: userId,
    date: { month: todayM, day: todayD },
    visibility: "owner_only",
    published: false,
    enabled: true,
    items,
    totals: { included: items.length, ineligibleOrSuppressed, notResurfaceable },
    notes: RECAP_NOTES,
  };
}

// ── Notifications — opt-in only, defaults OFF (scheduler DEFERRED) ────────────

/**
 * Whether the user has explicitly opted IN to recap / on-this-day notifications.
 *
 * Reuses the EXISTING notification_category_preferences table (category =
 * 'memory_recaps') — no parallel prefs table. DEFAULTS OFF: an absent row, or a
 * row with neither channel enabled, means NOT opted in. (Other categories treat
 * an absent row as enabled; this opt-in deliberately inverts that so a user is
 * never notified about resurfaced memory they did not ask for.)
 */
export async function isRecapNotificationOptIn(
  client: SupabaseClient,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await client
      .from("notification_category_preferences")
      .select("push_enabled, in_app_enabled")
      .eq("user_id", userId)
      .eq("category", RECAP_NOTIFICATION_CATEGORY)
      .maybeSingle();
    if (error || !data) return false; // DEFAULT OFF
    const r = data as Record<string, unknown>;
    return Boolean(r.push_enabled) || Boolean(r.in_app_enabled);
  } catch {
    return false; // fail-closed
  }
}

export interface RecapNotifyDecision {
  notify: boolean;
  reason: "flag_off" | "opt_out" | null;
}

/**
 * The gated notification check. NO scheduler is wired yet (DEFERRED): even if
 * this returned notify=true, nothing fires because the master flag is off and no
 * trigger is registered. It is defined and correct so that enabling §5 later does
 * not silently notify users who never opted in.
 *
 * BOTH gates are fail-closed: master flag off ⇒ no notify; not opted in ⇒ no notify.
 */
export async function shouldNotifyRecaps(
  client: SupabaseClient,
  userId: string,
): Promise<RecapNotifyDecision> {
  if (!(await isRecapsEnabled(client))) return { notify: false, reason: "flag_off" };
  if (!(await isRecapNotificationOptIn(client, userId))) return { notify: false, reason: "opt_out" };
  return { notify: true, reason: null };
}
