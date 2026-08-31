/**
 * PassportRemembersService — the §12 "What Portava Remembers" assembly.
 *
 * PRIVATE, OWNER-ONLY. Every function here is called with the id of the
 * AUTHENTICATED caller (derived from the session in the route, never from a
 * query param — the 2182 lesson). Nothing here accepts a client-supplied user
 * id. The surface is assembled for the owner about themselves and is never part
 * of anyone else's Passport.
 *
 * The allow/deny boundary:
 *   - DERIVED memory (memory_projections) is filtered in SQL, fail-closed, by
 *     memory_remembers_for_user (migration 2213): expired / non-active /
 *     sensitive / non-user-visible-policy-class / sensitive-category inference /
 *     deleted-subject social memory / user-suppressed are all excluded there.
 *     This module re-applies the user-suppression filter in TS as defence in
 *     depth (a second, independent gate over the same rows).
 *   - SOURCE content the user created (saved places, Memories, Postcards, Stamps,
 *     trips, saved Compass memories, availability, consented Shared Moments) is
 *     read here with per-table deny filters (moderation status, tombstones,
 *     revocation, consent) and then run through the SAME suppression filter, so
 *     "Forget" is uniform across every group.
 *
 * Forget semantics (see buildForgetResult / the route):
 *   - For DERIVED memory, Forget records a durable, subject-keyed memory_feedback
 *     'forget' that both the SQL read and this module exclude, and that SURVIVES
 *     a re-projection (2190) — so the projector cannot regenerate it.
 *   - For SOURCE content, Forget is "forget from this memory view": it records the
 *     same suppression signal and hides the item here, but NEVER deletes the
 *     user's underlying Postcard / saved place / trip / etc.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type RememberGroup =
  | "derived_memory"
  | "profile"
  | "preferences"
  | "saved_content"
  | "saved_compass_memory"
  | "shared_moment"
  | "availability";

/** Forget behaviour, reported per item so the owner knows what "Forget" does. */
export type ForgetBehavior = "suppress_no_regen" | "suppress_from_view";

export interface RememberSource {
  /** How the memory came to be — the "why". */
  kind: "derivation" | "user_provided" | "origin_row";
  derivation?: string;
  originTable?: string;
  originId?: string;
  sourceEventIds?: string[];
  observationCount?: number;
}

export interface RememberControls {
  /** Provenance is returned inline in `source`; true means it is available. */
  viewSource: boolean;
  correct: { supported: boolean; endpoint: string; note?: string };
  forget: { supported: boolean; endpoint: string; behavior: ForgetBehavior };
  /** Owner-only surface: every item is private to the owner here. */
  visibility: string;
}

export interface RememberItem {
  /** Stable client id for the item. */
  id: string;
  group: RememberGroup;
  /** Human label for the group/kind. */
  label: string;
  title: string;
  detail?: string;
  /** True when Portava INFERRED this rather than being told it. */
  isInferred: boolean;
  inferredNote?: string;
  visibility: string;
  source: RememberSource;
  /** Durable suppression key (namespaced so source rows never collide with
   * derived-memory subjects). */
  subjectType: string;
  subjectId: string;
  memoryType: string | null;
  controls: RememberControls;
}

export interface RememberGroupBlock {
  group: RememberGroup;
  label: string;
  /** Owner-facing note: what this group is, and (for inferred) the caveat. */
  description: string;
  items: RememberItem[];
}

export interface RememberSurface {
  ownerId: string;
  visibility: "owner_only";
  groups: RememberGroupBlock[];
  /** Counts to make the deny boundary observable to the caller/tests. */
  totals: { surfaced: number; suppressed: number };
  notes: string[];
}

const FORGET_ENDPOINT = "/compass/me/passport/remembers/forget";
const CORRECT_ENDPOINT = "/compass/me/passport/remembers/correct";

/** Suppression keys the user has set (forget/hide), plus suppressed projection ids. */
interface SuppressionSet {
  keys: Set<string>;
  projectionIds: Set<string>;
}

function keyOf(subjectType: string | null | undefined, subjectId: string | null | undefined): string {
  return `${subjectType ?? ""}::${subjectId ?? ""}`;
}

/**
 * Load the caller's forget/hide suppressions. 'incorrect' is deliberately NOT
 * treated as a view-suppression here: it suppresses DERIVED memory inside the
 * SQL read (where a wrong inference must stop surfacing), but on user-created
 * source content "correct" is an annotation, not a hide.
 */
export async function loadSuppressions(
  client: SupabaseClient,
  userId: string,
): Promise<SuppressionSet> {
  const set: SuppressionSet = { keys: new Set(), projectionIds: new Set() };
  try {
    const { data, error } = await client
      .from("memory_feedback")
      .select("kind, subject_type, subject_id, projection_id")
      .eq("user_id", userId);
    if (error || !Array.isArray(data)) return set;
    for (const row of data as Array<Record<string, unknown>>) {
      const kind = String(row.kind ?? "");
      if (kind !== "forget" && kind !== "hide") continue;
      if (row.subject_id != null) {
        set.keys.add(keyOf(row.subject_type as string, row.subject_id as string));
      }
      if (row.projection_id != null) set.projectionIds.add(String(row.projection_id));
    }
  } catch {
    // Fail-available: a feedback read error must not block the whole surface,
    // but note the SQL read already excluded suppressed derived memory, so a
    // forgotten derived item cannot leak even if this TS gate is empty.
  }
  return set;
}

function isSuppressed(item: RememberItem, sup: SuppressionSet): boolean {
  if (sup.keys.has(keyOf(item.subjectType, item.subjectId))) return true;
  // Derived items carry their projection id as the client id.
  if (item.group === "derived_memory" && sup.projectionIds.has(item.id)) return true;
  return false;
}

// Sensitive inferred-trait categories. The SQL read (2213) already excludes
// these fail-closed; this mirror is the TS half of a defence-in-depth gate, and
// the thing the CI unit tests can observe without a live DB.
const SENSITIVE_CATEGORY_RE =
  /(health|medical|illness|disease|mental|therapy|psych|sexual|lgbt|\bgay\b|lesbian|queer|\bbi\b|trans|religio|church|mosque|temple|islam|christ|jewish|\bjew\b|hindu|buddhis|ethnic|\brace\b|racial|politic|election|abortion|\bincome\b|salary|\bdebt\b|bankrupt|financ|pregnan|disab|addict|hiv)/i;

/**
 * DEFENCE-IN-DEPTH deny gate over a derived-memory row. The authoritative gate
 * is the SQL function; this is a second, independent check so that a row which
 * should never have been returned (a regressed SQL filter, a hand-written test
 * fixture, a future caller) is still dropped before it reaches the owner. It is
 * fail-closed: anything it is unsure about, it excludes.
 */
function derivedRowIsAllowed(r: Record<string, unknown>): boolean {
  const state = r.state == null ? "active" : String(r.state);
  if (state !== "active") return false;                       // decayed/hidden/forgotten/retracted
  if (String(r.sensitivity ?? "normal") === "sensitive") return false; // §19 sensitive
  const validTo = r.valid_to == null ? null : new Date(String(r.valid_to));
  if (validTo && validTo.getTime() <= Date.now()) return false;        // expired
  const isInferred = Boolean(r.is_inferred) || String(r.subject_type ?? "") === "inferred_interest";
  if (isInferred) {
    const hay = `${String(r.subject_id ?? "")} ${String(r.content ?? "")}`;
    if (SENSITIVE_CATEGORY_RE.test(hay)) return false;        // sensitive-category inference
  }
  return true;
}

// ── Group 1: derived memory (the SQL-filtered core) ──────────────────────────
export async function buildDerivedMemory(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  const { data, error } = await client.rpc("memory_remembers_for_user", { p_user_id: userId });
  if (error || !Array.isArray(data)) return [];
  const out: RememberItem[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    if (!derivedRowIsAllowed(r)) continue; // defence in depth over the SQL deny gate
    const isInferred = Boolean(r.is_inferred);
    const memoryType = (r.memory_type as string) ?? null;
    const subjectType = (r.subject_type as string) ?? "";
    const subjectId = (r.subject_id as string) ?? "";
    const obs = Number(r.observation_count ?? 0);
    out.push({
      id: String(r.id ?? keyOf(subjectType, subjectId)),
      group: "derived_memory",
      label: isInferred ? "Inferred preference" : labelForMemoryType(memoryType),
      title: String(r.content ?? ""),
      detail: undefined,
      isInferred,
      inferredNote: isInferred
        ? `Portava inferred this from your activity${obs > 0 ? ` (${obs} observation${obs === 1 ? "" : "s"})` : ""}. It is a guess, not something you told us.`
        : undefined,
      visibility: String(r.visibility ?? "private"),
      source: {
        kind: "derivation",
        derivation: (r.derivation as string) ?? undefined,
        sourceEventIds: Array.isArray(r.source_event_ids) ? (r.source_event_ids as string[]) : undefined,
        observationCount: isInferred ? obs : undefined,
      },
      subjectType,
      subjectId,
      memoryType,
      controls: {
        viewSource: true,
        correct: {
          supported: true,
          endpoint: CORRECT_ENDPOINT,
          note: isInferred
            ? "Tell Portava the right value; the inferred one stops showing and will not be re-derived."
            : "Record that this is wrong; it stops showing and will not be re-derived.",
        },
        forget: { supported: true, endpoint: FORGET_ENDPOINT, behavior: "suppress_no_regen" },
        visibility: String(r.visibility ?? "private"),
      },
    });
  }
  return out;
}

function labelForMemoryType(t: string | null): string {
  switch (t) {
    case "episodic": return "Place you visited";
    case "place": return "Place memory";
    case "social": return "Person you know";
    case "semantic": return "Preference";
    case "intent": return "Recent intent";
    default: return "Memory";
  }
}

// ── Group 2: profile facts (user-provided) ───────────────────────────────────
export async function buildProfileFacts(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  const { data, error } = await client
    .from("profiles")
    .select("home_city, home_country, display_name, bio")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return [];
  const p = data as Record<string, unknown>;
  const items: RememberItem[] = [];
  const push = (field: string, title: string, value: unknown) => {
    if (value == null || String(value).trim() === "") return;
    items.push(
      userProvidedItem({
        group: "profile",
        label: "Profile fact",
        title,
        detail: String(value),
        subjectType: "passport:profile",
        subjectId: field,
        originTable: "profiles",
        originId: userId,
        // Profile fields are edited in the normal profile editor; Correct here
        // points there rather than recording a memory correction.
        correctNote: "Edit this in your profile settings.",
        correctSupported: false,
        visibility: "private",
      }),
    );
  };
  const homeParts = [p.home_city, p.home_country].filter((v) => v != null && String(v).trim() !== "");
  if (homeParts.length > 0) push("home_base", "Home base", homeParts.join(", "));
  push("display_name", "Display name", p.display_name);
  push("bio", "Bio", p.bio);
  return items;
}

// ── Group 3: preferences (interests / travel styles) ─────────────────────────
export async function buildPreferences(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  let interests: string[] = [];
  let styles: string[] = [];
  try {
    const { data } = await client
      .from("compass_user_preferences")
      .select("interests, travel_styles")
      .eq("user_id", userId)
      .maybeSingle();
    const c = (data ?? {}) as Record<string, unknown>;
    interests = arr(c.interests);
    styles = arr(c.travel_styles);
  } catch { /* fall through to profile fallback */ }
  if (interests.length === 0 && styles.length === 0) {
    try {
      const { data } = await client
        .from("profiles")
        .select("interests, travel_styles")
        .eq("id", userId)
        .maybeSingle();
      const c = (data ?? {}) as Record<string, unknown>;
      interests = arr(c.interests);
      styles = arr(c.travel_styles);
    } catch { /* none */ }
  }
  const items: RememberItem[] = [];
  for (const v of interests) {
    items.push(userProvidedItem({
      group: "preferences", label: "Interest", title: v,
      subjectType: "passport:interest", subjectId: v,
      originTable: "compass_user_preferences", originId: userId,
      correctSupported: false, correctNote: "Edit your interests in Compass settings.",
      visibility: "private",
    }));
  }
  for (const v of styles) {
    items.push(userProvidedItem({
      group: "preferences", label: "Travel style", title: v,
      subjectType: "passport:travel_style", subjectId: v,
      originTable: "compass_user_preferences", originId: userId,
      correctSupported: false, correctNote: "Edit your travel styles in Compass settings.",
      visibility: "private",
    }));
  }
  return items;
}

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() !== "") : [];
}

// ── Group 4: saved content (places / Memories / Postcards / Stamps / trips) ──
const SOURCE_LIMIT = 50;

export async function buildSavedContent(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  const items: RememberItem[] = [];

  // Saved places. No status/tombstone column exists on saved_places.
  await safe(async () => {
    const { data } = await client
      .from("saved_places")
      .select("id, place_id, saved_at")
      .eq("user_id", userId)
      .order("saved_at", { ascending: false })
      .limit(SOURCE_LIMIT);
    for (const r of asRows(data)) {
      items.push(originItem({
        group: "saved_content", label: "Saved place",
        title: `Saved place ${r.place_id ?? r.id}`,
        subjectType: "passport:saved_place", subjectId: String(r.id),
        originTable: "saved_places", originId: String(r.id),
        visibility: "private",
      }));
    }
  });

  // User-created Memories (the scrapbook parent). Exclude deleted/removed states.
  await safe(async () => {
    const { data } = await client
      .from("memories")
      .select("id, title, caption, state, visibility, created_at")
      .eq("owner_id", userId)
      .order("created_at", { ascending: false })
      .limit(SOURCE_LIMIT);
    for (const r of asRows(data)) {
      const state = String(r.state ?? "");
      if (state === "deleted" || state === "removed" || state === "hidden") continue;
      items.push(originItem({
        group: "saved_content", label: "Memory",
        title: String(r.title ?? r.caption ?? "Memory"),
        detail: r.title ? (r.caption ? String(r.caption) : undefined) : undefined,
        subjectType: "passport:memory", subjectId: String(r.id),
        originTable: "memories", originId: String(r.id),
        visibility: String(r.visibility ?? "private"),
      }));
    }
  });

  // Postcards. Only the owner's own, moderation-active, non-tombstoned rows.
  await safe(async () => {
    const { data } = await client
      .from("passport_postcards")
      .select("id, caption, note, status, visibility, deleted_at, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(SOURCE_LIMIT);
    for (const r of asRows(data)) {
      if (String(r.status ?? "") !== "active") continue; // hidden/reported/deleted excluded
      if (r.deleted_at != null) continue;                 // tombstoned excluded
      items.push(originItem({
        group: "saved_content", label: "Postcard",
        title: String(r.caption ?? r.note ?? "Postcard"),
        subjectType: "passport:postcard", subjectId: String(r.id),
        originTable: "passport_postcards", originId: String(r.id),
        visibility: String(r.visibility ?? "private"),
      }));
    }
  });

  // Earned stamps (v2). Exclude revoked.
  await safe(async () => {
    const { data } = await client
      .from("user_stamps")
      .select("id, stamp_definition_id, earned_at, visibility, is_revoked, display_on_passport")
      .eq("user_id", userId)
      .order("earned_at", { ascending: false })
      .limit(SOURCE_LIMIT);
    for (const r of asRows(data)) {
      if (r.is_revoked === true) continue;
      items.push(originItem({
        group: "saved_content", label: "Stamp",
        title: `Stamp ${r.stamp_definition_id ?? r.id}`,
        subjectType: "passport:stamp", subjectId: String(r.id),
        originTable: "user_stamps", originId: String(r.id),
        visibility: String(r.visibility ?? "private"),
      }));
    }
  });

  // Trips the owner created. Exclude cancelled/archived.
  await safe(async () => {
    const { data } = await client
      .from("trips")
      .select("id, title, status, visibility, destination_city")
      .eq("owner_id", userId)
      .order("id", { ascending: false })
      .limit(SOURCE_LIMIT);
    for (const r of asRows(data)) {
      const status = String(r.status ?? "");
      if (status === "cancelled" || status === "archived") continue;
      items.push(originItem({
        group: "saved_content", label: "Trip",
        title: String(r.title ?? r.destination_city ?? "Trip"),
        detail: r.destination_city ? String(r.destination_city) : undefined,
        subjectType: "passport:trip", subjectId: String(r.id),
        originTable: "trips", originId: String(r.id),
        visibility: String(r.visibility ?? "private"),
      }));
    }
  });

  return items;
}

// ── Group 5: explicitly saved Compass memories ───────────────────────────────
// compass_memories via the existing service store. Owner-scoped; shape varies,
// so read defensively.
export async function buildSavedCompassMemories(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  const items: RememberItem[] = [];
  await safe(async () => {
    const { data } = await client
      .from("compass_memories")
      .select("id, content, category, scope, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(SOURCE_LIMIT);
    for (const r of asRows(data)) {
      items.push(originItem({
        group: "saved_compass_memory", label: "Saved Compass memory",
        title: String(r.content ?? "Compass memory"),
        detail: r.category ? String(r.category) : undefined,
        subjectType: "passport:compass_memory", subjectId: String(r.id),
        originTable: "compass_memories", originId: String(r.id),
        visibility: "private",
        // These have a dedicated editor (PATCH/DELETE /compass/me/memories/:id).
        correctSupported: false,
        correctNote: "Edit or delete this saved memory in Compass.",
      }));
    }
  });
  return items;
}

// ── Group 6: consented Shared Moments (involving other people) ───────────────
// ONLY moments the caller has ACCEPTED membership in, and that are active. That
// accepted membership IS the recorded consent. We surface the moment's own
// title only — never another participant's private contribution.
export async function buildSharedMoments(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  const items: RememberItem[] = [];
  await safe(async () => {
    const { data: memberships } = await client
      .from("shared_moment_memberships")
      .select("moment_id, status")
      .eq("user_id", userId)
      .eq("status", "accepted"); // consent gate
    // The recorded consent is an ACCEPTED membership. Build the allow-set in TS so
    // the gate holds even if the moments query returns more than we asked for —
    // never trust the row set alone to enforce consent.
    const consented = new Set(
      asRows(memberships)
        .filter((m) => String(m.status ?? "") === "accepted" && m.moment_id != null)
        .map((m) => String(m.moment_id)),
    );
    if (consented.size === 0) return;
    const { data: moments } = await client
      .from("shared_moments")
      .select("id, title, status, visibility, archived_at")
      .in("id", Array.from(consented))
      .limit(SOURCE_LIMIT);
    for (const r of asRows(moments)) {
      if (!consented.has(String(r.id))) continue;        // consent gate (defence in depth)
      if (String(r.status ?? "") !== "active") continue; // archived excluded
      if (r.archived_at != null) continue;
      items.push(originItem({
        group: "shared_moment", label: "Shared Moment",
        title: String(r.title ?? "Shared Moment"),
        subjectType: "passport:shared_moment", subjectId: String(r.id),
        originTable: "shared_moments", originId: String(r.id),
        // The moment involves other people; visibility of the moment as set by
        // its owner. Shown to this owner only because they consented (accepted).
        visibility: String(r.visibility ?? "private"),
        correctSupported: false,
        correctNote: "Manage this in Shared Moments.",
      }));
    }
  });
  return items;
}

// ── Group 7: current availability settings (owner-only) ──────────────────────
export async function buildAvailability(
  client: SupabaseClient,
  userId: string,
): Promise<RememberItem[]> {
  const items: RememberItem[] = [];
  await safe(async () => {
    const { data } = await client
      .from("user_availability")
      .select("open_to_meet, strict_mode, weekly_days, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return;
    const a = data as Record<string, unknown>;
    items.push(userProvidedItem({
      group: "availability", label: "Availability",
      title: a.open_to_meet ? "Open to meet" : "Not currently open to meet",
      detail: a.strict_mode ? "Strict mode on" : undefined,
      subjectType: "passport:availability", subjectId: "settings",
      originTable: "user_availability", originId: userId,
      correctSupported: false, correctNote: "Change this in your availability settings.",
      visibility: "private",
    }));
  });
  return items;
}

// ── Item constructors ────────────────────────────────────────────────────────
function userProvidedItem(o: {
  group: RememberGroup; label: string; title: string; detail?: string;
  subjectType: string; subjectId: string; originTable: string; originId: string;
  correctSupported: boolean; correctNote?: string; visibility: string;
}): RememberItem {
  return {
    id: `${o.subjectType}:${o.subjectId}`,
    group: o.group, label: o.label, title: o.title, detail: o.detail,
    isInferred: false,
    visibility: o.visibility,
    source: { kind: "user_provided", originTable: o.originTable, originId: o.originId },
    subjectType: o.subjectType, subjectId: o.subjectId, memoryType: null,
    controls: {
      viewSource: true,
      correct: { supported: o.correctSupported, endpoint: CORRECT_ENDPOINT, note: o.correctNote },
      forget: { supported: true, endpoint: FORGET_ENDPOINT, behavior: "suppress_from_view" },
      visibility: o.visibility,
    },
  };
}

function originItem(o: {
  group: RememberGroup; label: string; title: string; detail?: string;
  subjectType: string; subjectId: string; originTable: string; originId: string;
  visibility: string; correctSupported?: boolean; correctNote?: string;
}): RememberItem {
  return {
    id: `${o.subjectType}:${o.subjectId}`,
    group: o.group, label: o.label, title: o.title, detail: o.detail,
    isInferred: false,
    visibility: o.visibility,
    source: { kind: "origin_row", originTable: o.originTable, originId: o.originId },
    subjectType: o.subjectType, subjectId: o.subjectId, memoryType: null,
    controls: {
      viewSource: true,
      correct: {
        supported: o.correctSupported ?? false,
        endpoint: CORRECT_ENDPOINT,
        note: o.correctNote ?? "This is content you created; edit it where you made it.",
      },
      forget: { supported: true, endpoint: FORGET_ENDPOINT, behavior: "suppress_from_view" },
      visibility: o.visibility,
    },
  };
}

async function safe(fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch { /* a single group's read error must not sink the surface */ }
}

function asRows(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
}

const GROUP_DESCRIPTIONS: Record<RememberGroup, string> = {
  derived_memory: "Memory Portava derived from what you've done — places you visited, saved, and people you know. Inferred items are clearly marked.",
  profile: "Facts you gave Portava about yourself.",
  preferences: "Interests and travel styles you told Portava.",
  saved_content: "Things you saved or created — places, Memories, Postcards, stamps, and trips.",
  saved_compass_memory: "Memories you explicitly asked Compass to remember.",
  shared_moment: "Shared Moments you joined. Shown here only because you accepted them.",
  availability: "Your current availability settings. Visible only to you here.",
};

const GROUP_ORDER: RememberGroup[] = [
  "profile", "preferences", "derived_memory", "saved_content",
  "saved_compass_memory", "shared_moment", "availability",
];

const GROUP_LABELS: Record<RememberGroup, string> = {
  derived_memory: "What Portava figured out",
  profile: "About you",
  preferences: "Your interests",
  saved_content: "Saved & created",
  saved_compass_memory: "Saved Compass memories",
  shared_moment: "Shared Moments",
  availability: "Availability",
};

/**
 * Assemble the full owner-only surface. Applies the uniform suppression filter
 * across every group and reports how many items were suppressed.
 */
export async function buildRememberSurface(
  client: SupabaseClient,
  userId: string,
): Promise<RememberSurface> {
  const [sup, derived, profile, prefs, saved, compassMem, moments, avail] = await Promise.all([
    loadSuppressions(client, userId),
    buildDerivedMemory(client, userId),
    buildProfileFacts(client, userId),
    buildPreferences(client, userId),
    buildSavedContent(client, userId),
    buildSavedCompassMemories(client, userId),
    buildSharedMoments(client, userId),
    buildAvailability(client, userId),
  ]);

  const byGroup: Record<RememberGroup, RememberItem[]> = {
    derived_memory: derived,
    profile,
    preferences: prefs,
    saved_content: saved,
    saved_compass_memory: compassMem,
    shared_moment: moments,
    availability: avail,
  };

  let surfaced = 0;
  let suppressed = 0;
  const groups: RememberGroupBlock[] = [];
  for (const g of GROUP_ORDER) {
    const kept: RememberItem[] = [];
    for (const item of byGroup[g]) {
      if (isSuppressed(item, sup)) { suppressed += 1; continue; }
      kept.push(item);
    }
    surfaced += kept.length;
    groups.push({
      group: g,
      label: GROUP_LABELS[g],
      description: GROUP_DESCRIPTIONS[g],
      items: kept,
    });
  }

  return {
    ownerId: userId,
    visibility: "owner_only",
    groups,
    totals: { surfaced, suppressed },
    notes: [
      "This view is private to you and is never shown on your public Passport.",
      "Raw location trails, trust/safety signals, and sensitive inferences are never shown here.",
      "Forget removes an item from this view; for things you created it never deletes the original.",
    ],
  };
}
