/**
 * lib/tripReadiness.ts — Trip Readiness engine.
 *
 * computeReadiness(sc, tripId) derives readiness items across seven fixed
 * categories (plan, stay, transport, budget, entry, documents, reservations),
 * persists them into trip_readiness_items (upsert by (trip_id, dedupe_key) +
 * stale-row sweep) and returns a mechanical summary.
 *
 * CRITICAL-VISIBILITY RULE: the aggregate score must NEVER hide critical
 * items. The summary always carries the FULL `criticalItems` array —
 * untruncated — no matter how high the score is. Consumers must render
 * criticalItems independently of the score.
 *
 * Defensive posture: several source tables (trip_reservations,
 * trip_traveler_passports, entry_requirements, trip_autopilot_proposals) and
 * the optional ../lib/countryCodes module may not exist yet in a given
 * environment. Every read of those is wrapped so absence degrades to
 * "no data" instead of an error.
 */

export const READINESS_FLAG = "trip_readiness_enabled";

/** Stored items older than this are lazily recomputed on read. */
export const READINESS_STALE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export const READINESS_CATEGORIES = [
  "plan",
  "stay",
  "transport",
  "budget",
  "entry",
  "documents",
  "reservations",
] as const;

export type ReadinessCategory = (typeof READINESS_CATEGORIES)[number];
export type ReadinessStatus = "ready" | "action_needed" | "incomplete" | "unknown";
export type ReadinessSeverity = "normal" | "critical";

export interface ReadinessItem {
  id?: string;
  userId: string | null;
  category: ReadinessCategory;
  status: ReadinessStatus;
  severity: ReadinessSeverity;
  title: string;
  detail: string | null;
  dueAt: string | null;
  actionRef: Record<string, any> | null;
  dedupeKey: string;
  computedAt: string | null;
}

/** How a category reads in a sentence. */
export const READINESS_CATEGORY_PHRASE: Record<ReadinessCategory, string> = {
  plan: "the plan",
  stay: "somewhere to stay",
  transport: "transport",
  budget: "the budget",
  entry: "entry requirements",
  documents: "documents",
  reservations: "reservations",
};

/**
 * Trips spec §8: readiness is an EXPLANATORY projection, not a gamified truth
 * score (census-trips TR142). This is the explanation — what stands between
 * the trip and ready, per category, with the item to act on first — built
 * mechanically from the same items the counts are. It carries no percentage
 * and no trend: a consumer that renders readiness renders THIS, and `score`
 * stays what it is below, a count for the snapshot table.
 */
export interface ReadinessExplanation {
  /** One sentence. Never a number out of 100. */
  headline: string;
  /** Every category, in READINESS_CATEGORIES order. */
  byCategory: {
    category: ReadinessCategory;
    status: ReadinessStatus;
    /** Why the category reads as it does — the worst item's own words, or "Nothing outstanding" / "Could not be checked". */
    because: string;
    /** The open item to act on first, or null when nothing is open. */
    nextAction: { title: string; detail: string | null; dueAt: string | null; actionRef: Record<string, any> | null } | null;
  }[];
  /** The counts the headline is built from: categories that could be checked, and of those, the ready ones. */
  measured: number;
  ready: number;
}

export interface ReadinessSummary {
  computedAt: string;
  /**
   * §8 first: the explanation. Rendered by every consumer; the numbers below
   * are what it is built from, not what a traveller is shown.
   */
  explanation: ReadinessExplanation;
  /**
   * Mechanical: round(100 × share of MEASURED categories that are "ready").
   *
   * Not a gauge. It is persisted to trip_readiness_snapshots so a recompute
   * can tell whether the trip moved, and it is the input to `previousScore`;
   * no client renders it as a percentage or a ring (census-trips TR142).
   *
   * NULL when no category could be measured at all. Null is not 0 and it is
   * not 100 — it is "we have no readiness figure for this trip", and the two
   * numbers are both confident claims this function is not entitled to make.
   *
   * The denominator is the measured categories, NOT all seven. A category
   * whose status is `unknown` — the entry corridor with no verified data, a
   * reservations table that could not be read — used to be counted as
   * READY-ISH and pushed the score UP, so a trip got more "ready" the less of
   * it could be checked. `unmeasuredCategories` names what was left out.
   */
  score: number | null;
  /**
   * Score from the most recent prior snapshot (e.g. yesterday's computation).
   * Null when no prior snapshot exists or the score is being served from cache.
   */
  previousScore: number | null;
  /** Category-level counts by worst status (sums to 7). */
  counts: { ready: number; actionNeeded: number; incomplete: number; unknown: number };
  /**
   * The categories the score does NOT cover, because their status is unknown.
   * Empty on a fully-measured trip. A consumer rendering the score has to say
   * so when this is non-empty; a percentage over 5 of 7 categories is not the
   * same statement as a percentage over 7.
   */
  unmeasuredCategories: ReadinessCategory[];
  /** FULL list of critical items — never truncated (critical-visibility rule). */
  criticalItems: ReadinessItem[];
  /** §8.3 "by upcoming day": critical unresolved items grouped by their due date, soonest first; undated last. */
  byDay: { date: string | null; critical: number; actionNeeded: number; itemIds: string[] }[];
  /**
   * §8.3 "by upcoming stage": the same items grouped by the 2760 stage whose
   * interval contains the due date. Null when the deployment cannot read
   * trip_stages (the operational-projections gate is off) — not [] — so
   * "no stages" and "not read" stay different answers.
   */
  byStage: { stageId: string; sequence: number | null; startsAt: string | null; endsAt: string | null; critical: number; actionNeeded: number; itemIds: string[] }[] | null;
  /** category → worst status among its items ("ready" when a category has none). */
  categories: Record<ReadinessCategory, ReadinessStatus>;
  items: ReadinessItem[];
}

// ---------------------------------------------------------------------------
// Defensive query helpers
// ---------------------------------------------------------------------------

/** Run a query builder; return [] on thrown errors or DB error results. */
export async function safeSelect(sc: any, run: (sc: any) => any): Promise<any[]> {
  try {
    const { data, error } = await run(sc);
    if (error) return [];
    return ((data as any) ?? []) as any[];
  } catch {
    return [];
  }
}

/**
 * Report a readiness PERSISTENCE failure. This module deliberately takes no
 * logger dependency (it is imported by routes and by the reminder scheduler),
 * so the warning goes to console.warn with a stable prefix — the point is that
 * a failed write leaves a trace somewhere, which `.then(undefined, () => {})`
 * did not.
 */
function readinessPersistWarn(message: string, context: Record<string, unknown>): void {
  try {
    // eslint-disable-next-line no-console
    console.warn(`[tripReadiness] ${message}`, context);
  } catch { /* logging must never be the thing that fails a compute */ }
}

/** Like safeSelect but null-signals "source unavailable" (table absent, etc.). */
async function safeSelectOrNull(sc: any, run: (sc: any) => any): Promise<any[] | null> {
  try {
    const { data, error } = await run(sc);
    if (error) return null;
    return ((data as any) ?? []) as any[];
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Optional countryCodes module (may not exist in every environment)
// ---------------------------------------------------------------------------

let _toCountryCode: ((value: string) => string | null) | null | undefined;

async function loadToCountryCode(): Promise<((value: string) => string | null) | null> {
  if (_toCountryCode !== undefined) return _toCountryCode;
  try {
    // Computed specifier on purpose: the module is optional, and a static
    // import (or literal import()) would fail the build when it is absent.
    const specifier = "./countryCodes" + ".js";
    const mod: any = await import(specifier);
    _toCountryCode = typeof mod?.toCountryCode === "function" ? mod.toCountryCode : null;
  } catch {
    _toCountryCode = null;
  }
  return _toCountryCode ?? null;
}

/**
 * Resolve a trip destination_country value to ISO2, using toCountryCode when
 * the module exists, else accepting values that are already ISO2. Returns
 * null when unresolvable — callers then skip the corridor check entirely.
 */
async function resolveDestinationIso2(raw: string | null | undefined): Promise<string | null> {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const fn = await loadToCountryCode();
  if (fn) {
    try {
      const code = fn(trimmed);
      if (code && /^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
    } catch {
      /* fall through to the ISO2 passthrough */
    }
  }
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

/**
 * Accepted member ids for a trip (owner always included).
 *
 * NULL means the membership could not be read. Distinct from an owner-only
 * trip, which is a real and common answer — the caller must not treat "we could
 * not look" as "there is nobody else to check".
 */
export async function loadAcceptedMemberIds(
  sc: any,
  tripId: string,
  ownerId: string | null,
): Promise<string[] | null> {
  // NULL on failure, not owner-only. An unreadable trip_members returned just
  // the owner, so every OTHER member's entry/passport check was silently not
  // performed and the `entry` category read "ready" — for a crew whose
  // documents nobody looked at.
  const ids = new Set<string>();
  if (ownerId) ids.add(ownerId);
  const { data, error } = await sc
    .from("trip_members")
    .select("user_id, role, status")
    .eq("trip_id", tripId);
  if (error) return null;
  for (const row of (((data as any) ?? []) as any[])) {
    const role = (row as any).role as string;
    const status = (row as any).status as string | null | undefined;
    if (!["owner", "co_host", "member", "viewer"].includes(role)) continue;
    if (status != null && status !== "accepted") continue;
    const uid = (row as any).user_id as string | null;
    if (uid) ids.add(uid);
  }
  return [...ids];
}

/** Pending Trip Autopilot proposals — defensive (table may not exist). */
export async function fetchPendingAutopilotProposals(sc: any, tripId: string): Promise<any[]> {
  return safeSelect(sc, (c) =>
    c
      .from("trip_autopilot_proposals")
      .select("id, trip_id, user_id, issue_type, severity, reason, status, created_at")
      .eq("trip_id", tripId)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
  );
}

// ---------------------------------------------------------------------------
// Row/item mapping + summary
// ---------------------------------------------------------------------------

export function rowToItem(row: any): ReadinessItem {
  return {
    id: (row as any).id ?? undefined,
    userId: (row as any).user_id ?? null,
    category: (row as any).category as ReadinessCategory,
    status: (row as any).status as ReadinessStatus,
    severity: ((row as any).severity ?? "normal") as ReadinessSeverity,
    title: (row as any).title ?? "",
    detail: (row as any).detail ?? null,
    dueAt: (row as any).due_at ?? null,
    actionRef: (row as any).action_ref ?? null,
    dedupeKey: (row as any).dedupe_key as string,
    computedAt: (row as any).computed_at ?? null,
  };
}

const STATUS_RANK: Record<ReadinessStatus, number> = {
  ready: 0,
  unknown: 1,
  incomplete: 2,
  action_needed: 3,
};

export interface ReadinessStage { id: string; sequence: number | null; startsAt: string | null; endsAt: string | null }

/** §8.3: group the unresolved items by due date and, when stages are known, by stage. */
export function groupReadinessByTime(items: ReadinessItem[], stages: ReadinessStage[] | null): Pick<ReadinessSummary, "byDay" | "byStage"> {
  const open = items.filter((i) => i.status === "action_needed" || i.status === "incomplete");
  const days = new Map<string | null, ReadinessItem[]>();
  for (const i of open) { const d = i.dueAt ? i.dueAt.slice(0, 10) : null; const l = days.get(d) ?? []; l.push(i); days.set(d, l); }
  const byDay = [...days.entries()].sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[0].localeCompare(b[0])))
    .map(([date, l]) => ({ date, critical: l.filter((i) => i.severity === "critical").length, actionNeeded: l.filter((i) => i.status === "action_needed").length, itemIds: l.map((i) => i.id ?? i.dedupeKey) }));
  let byStage: ReadinessSummary["byStage"] = null;
  if (stages) {
    byStage = [...stages].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)).map((st) => {
      const s0 = st.startsAt ? Date.parse(st.startsAt) : NaN; const e0 = st.endsAt ? Date.parse(st.endsAt) : NaN;
      const l = open.filter((i) => { const d = i.dueAt ? Date.parse(i.dueAt) : NaN; return Number.isFinite(d) && Number.isFinite(s0) && Number.isFinite(e0) && d >= s0 && d < e0; });
      return { stageId: st.id, sequence: st.sequence, startsAt: st.startsAt, endsAt: st.endsAt, critical: l.filter((i) => i.severity === "critical").length, actionNeeded: l.filter((i) => i.status === "action_needed").length, itemIds: l.map((i) => i.id ?? i.dedupeKey) };
    });
  }
  return { byDay, byStage };
}

export function summarizeReadiness(
  items: ReadinessItem[],
  computedAt: string,
  previousScore: number | null = null,
  stages: ReadinessStage[] | null = null,
): ReadinessSummary {
  const categories = {} as Record<ReadinessCategory, ReadinessStatus>;
  for (const c of READINESS_CATEGORIES) categories[c] = "ready";
  for (const item of items) {
    const cur = categories[item.category] ?? "ready";
    if (STATUS_RANK[item.status] > STATUS_RANK[cur]) categories[item.category] = item.status;
  }

  const counts = { ready: 0, actionNeeded: 0, incomplete: 0, unknown: 0 };
  const unmeasuredCategories: ReadinessCategory[] = [];
  let ready = 0;
  for (const c of READINESS_CATEGORIES) {
    const s = categories[c];
    if (s === "ready") counts.ready += 1;
    else if (s === "action_needed") counts.actionNeeded += 1;
    else if (s === "incomplete") counts.incomplete += 1;
    else counts.unknown += 1;
    // An `unknown` category is NOT ready and it is NOT not-ready: it is out of
    // the fraction entirely. It used to be counted in the numerator alongside
    // `ready`, which is how an unreadable reservations table and an entry
    // corridor with no data both RAISED a trip's readiness score.
    if (s === "unknown") { unmeasuredCategories.push(c); continue; }
    if (s === "ready") ready += 1;
  }
  const measured = READINESS_CATEGORIES.length - unmeasuredCategories.length;
  const score = measured === 0 ? null : Math.round((100 * ready) / measured);

  // CRITICAL-VISIBILITY RULE: the full critical list rides alongside the
  // score, always and untruncated — a high score must never bury a critical.
  const criticalItems = items.filter((i) => i.severity === "critical");

  const { byDay, byStage } = groupReadinessByTime(items, stages);
  const explanation = explainReadiness(items, categories, unmeasuredCategories, measured, ready);
  return { computedAt, explanation, score, previousScore, counts, unmeasuredCategories, criticalItems, byDay, byStage, categories, items };
}

/** The worst open item of a category: critical before normal, then by status rank, then earliest due. */
function worstOpenItem(items: ReadinessItem[]): ReadinessItem | null {
  const open = items.filter((i) => i.status !== "ready");
  if (open.length === 0) return null;
  return [...open].sort((a, b) => {
    const sev = (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1);
    if (sev !== 0) return sev;
    const rank = STATUS_RANK[b.status] - STATUS_RANK[a.status];
    if (rank !== 0) return rank;
    const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
    const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
    return da - db;
  })[0];
}

const listPhrases = (cs: ReadinessCategory[]): string => cs.map((c) => READINESS_CATEGORY_PHRASE[c]).join(", ");

/**
 * The §8 explanation, mechanically. The headline names the critical items
 * when there are any, otherwise the categories that need action or are
 * incomplete, otherwise says the checks are ready — and always says which
 * checks could not be made, because "ready on five of seven" is not "ready".
 */
export function explainReadiness(
  items: ReadinessItem[],
  categories: Record<ReadinessCategory, ReadinessStatus>,
  unmeasuredCategories: ReadinessCategory[],
  measured: number,
  ready: number,
): ReadinessExplanation {
  const byCategory: ReadinessExplanation["byCategory"] = READINESS_CATEGORIES.map((category) => {
    const status = categories[category] ?? "ready";
    const own = items.filter((i) => i.category === category);
    const worst = worstOpenItem(own);
    const because = worst
      ? (worst.detail ? `${worst.title} — ${worst.detail}` : worst.title)
      : status === "unknown" ? "Could not be checked" : "Nothing outstanding";
    return {
      category,
      status,
      because,
      nextAction: worst ? { title: worst.title, detail: worst.detail, dueAt: worst.dueAt, actionRef: worst.actionRef } : null,
    };
  });

  const critical = items.filter((i) => i.severity === "critical" && i.status !== "ready");
  const needsAction = READINESS_CATEGORIES.filter((c) => categories[c] === "action_needed");
  const incomplete = READINESS_CATEGORIES.filter((c) => categories[c] === "incomplete");

  let headline: string;
  if (critical.length > 0) {
    const titles = critical.slice(0, 3).map((i) => i.title).join("; ");
    const more = critical.length > 3 ? ` and ${critical.length - 3} more` : "";
    headline = `${critical.length} critical item${critical.length === 1 ? "" : "s"} need${critical.length === 1 ? "s" : ""} attention: ${titles}${more}`;
  } else if (needsAction.length > 0 || incomplete.length > 0) {
    const parts: string[] = [];
    if (needsAction.length > 0) parts.push(`${listPhrases(needsAction)} need${needsAction.length === 1 ? "s" : ""} action`);
    if (incomplete.length > 0) parts.push(`${listPhrases(incomplete)} ${incomplete.length === 1 ? "is" : "are"} incomplete`);
    headline = parts.join("; ");
  } else if (measured === 0) {
    headline = "Nothing about this trip could be checked yet";
  } else {
    headline = unmeasuredCategories.length > 0 ? "Every check that could be made is ready" : "Every check is ready";
  }
  if (unmeasuredCategories.length > 0 && measured > 0) {
    headline += `; ${listPhrases(unmeasuredCategories)} could not be checked`;
  }
  return { headline, byCategory, measured, ready };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatShortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return isoDate;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function toNumberOrNull(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute, persist and summarize readiness for one trip.
 * Throws an Error with `.code === "not_found"` when the trip does not exist.
 */
/**
 * `opts.stages`: the 2760 stages, read BY THE CALLER under the
 * operational-projections gate (this module imports nothing and reads no
 * gate-owned table). Omitted or null → byStage is null: "not read".
 */
export async function computeReadiness(sc: any, tripId: string, opts: { stages?: ReadinessStage[] | null } = {}): Promise<ReadinessSummary> {
  const nowMs = Date.now();
  const computedAt = new Date(nowMs).toISOString();

  // ── Load core sources ──────────────────────────────────────────────────────
  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr || !trip) {
    const err: any = new Error("Trip not found");
    err.code = "not_found";
    throw err;
  }

  const memberIdsRead = await loadAcceptedMemberIds(sc, tripId, (trip as any).owner_id ?? null);
  // An unreadable membership means the per-member entry and passport checks
  // below would silently run over the owner alone, and the `entry` category
  // would come back "ready" for a crew nobody looked at. The compute refuses
  // instead: readiness is a claim about a whole party.
  if (memberIdsRead === null) {
    const err = new Error("trip membership unreadable; readiness cannot be computed for the party") as any;
    err.code = "degraded_unavailable";
    throw err;
  }
  const memberIds = memberIdsRead;

  const { data: planData } = await sc
    .from("trip_plan_items")
    .select("id, category, status, day_date, starts_at")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .neq("status", "cancelled");
  const planItems = (((planData as any) ?? []) as any[]);

  const { data: budgetRow } = await sc
    .from("trip_budget")
    .select("*")
    .eq("trip_id", tripId)
    .maybeSingle();

  const { data: docsData } = await sc
    .from("trip_documents")
    .select("id")
    .eq("trip_id", tripId);
  const documentCount = (((docsData as any) ?? []) as any[]).length;

  // ── Defensive sources (tables may not exist yet in this environment) ───────
  // safeSelectOrNull, NOT safeSelect. An unreadable trip_reservations used to
  // come back as [], the 72-hour cancellation-deadline scan below found
  // nothing, and the `reservations` category stayed "ready" — asserting "your
  // free-cancellation window is not closing" from a read that failed. That is
  // a deadline claim, and being wrong about it costs money.
  const reservationsRead = await safeSelectOrNull(sc, (c) =>
    c.from("trip_reservations").select("*").eq("trip_id", tripId),
  );
  const reservationsUnavailable = reservationsRead === null;
  const reservations = reservationsRead ?? [];
  const passports = await safeSelect(sc, (c) =>
    c.from("trip_traveler_passports").select("*").eq("trip_id", tripId),
  );

  const destIso2 = await resolveDestinationIso2((trip as any).destination_country ?? null);
  // null = corridor data unavailable (table absent / destination unresolvable)
  let corridors: any[] | null = null;
  if (destIso2) {
    corridors = await safeSelectOrNull(sc, (c) =>
      c.from("entry_requirements").select("*").eq("destination_country", destIso2),
    );
  }

  // ── Derive items ───────────────────────────────────────────────────────────
  const items: ReadinessItem[] = [];
  const push = (i: Omit<ReadinessItem, "computedAt">) => items.push({ ...i, computedAt });

  const startDate = ((trip as any).start_date ?? null) as string | null;
  const endDate = ((trip as any).end_date ?? null) as string | null;

  // plan --------------------------------------------------------------------
  if (!startDate || !endDate) {
    push({
      userId: null,
      category: "plan",
      status: "incomplete",
      severity: "normal",
      title: "Trip dates not set",
      detail: "Set start and end dates to unlock day-by-day planning checks.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "plan:dates",
    });
  } else {
    const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
    const endMs = new Date(`${endDate}T00:00:00Z`).getTime();
    const gapDates: string[] = [];
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      const dayCount = Math.min(Math.floor((endMs - startMs) / DAY_MS) + 1, 30); // cap 30 scanned
      for (let i = 0; i < dayCount; i++) {
        const dayStr = new Date(startMs + i * DAY_MS).toISOString().slice(0, 10);
        const covered = planItems.some((p) => {
          const dd = (p as any).day_date as string | null;
          if (dd && String(dd).slice(0, 10) === dayStr) return true;
          const sa = (p as any).starts_at as string | null;
          return Boolean(sa && String(sa).slice(0, 10) === dayStr);
        });
        if (!covered) gapDates.push(dayStr);
      }
    }
    if (gapDates.length > 0) {
      const shown = gapDates.slice(0, 5).map(formatShortDate);
      const suffix = gapDates.length > shown.length ? "…" : "";
      push({
        userId: null,
        category: "plan",
        status: "action_needed",
        severity: "normal",
        title: `${gapDates.length} open ${gapDates.length === 1 ? "day" : "days"}: ${shown.join(", ")}${suffix}`,
        detail: "These trip days have no plan items yet.",
        dueAt: null,
        actionRef: { dates: gapDates.slice(0, 10) },
        dedupeKey: "plan:gaps",
      });
    }
  }

  // stay --------------------------------------------------------------------
  const hasStayPlan = planItems.some((p) => (p as any).category === "accommodation");
  const hasStayReservation = reservations.some((r) => String((r as any).type ?? "") === "stay");
  if (!hasStayPlan && !hasStayReservation) {
    let severity: ReadinessSeverity = "normal";
    if (startDate) {
      const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
      if (Number.isFinite(startMs) && startMs - nowMs <= 14 * DAY_MS) severity = "critical";
    }
    // "No accommodation plan item OR stay reservation found" is a claim about
    // BOTH sources. With reservations unreadable, `hasStayReservation` is false
    // because nothing was read, not because nothing is there — the sentence
    // would be asserting half of itself out of a query that never answered.
    push(reservationsUnavailable ? {
      userId: null,
      category: "stay",
      status: "unknown",
      severity,
      title: "Accommodation could not be confirmed",
      detail: "This trip has no accommodation plan item, and its reservations could not be read — so we cannot tell whether a stay is booked.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "stay:none",
    } : {
      userId: null,
      category: "stay",
      status: "action_needed",
      severity,
      title: "No accommodation planned",
      detail: "No accommodation plan item or stay reservation found for this trip.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "stay:none",
    });
  }

  // transport ---------------------------------------------------------------
  const hasTransportPlan = planItems.some((p) => (p as any).category === "transport");
  const hasTransportReservation = reservations.some((r) =>
    ["flight", "transport"].includes(String((r as any).type ?? "")),
  );
  if (!hasTransportPlan && !hasTransportReservation) {
    // Same asymmetry as `stay` above.
    push(reservationsUnavailable ? {
      userId: null,
      category: "transport",
      status: "unknown",
      severity: "normal",
      title: "Transport could not be confirmed",
      detail: "This trip has no transport plan item, and its reservations could not be read — so we cannot tell whether travel is booked.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "transport:none",
    } : {
      userId: null,
      category: "transport",
      status: "action_needed",
      severity: "normal",
      title: "No transport planned",
      detail: "No transport plan item or flight/transport reservation found.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "transport:none",
    });
  }

  // budget ------------------------------------------------------------------
  if (!budgetRow) {
    push({
      userId: null,
      category: "budget",
      status: "incomplete",
      severity: "normal",
      title: "No budget set",
      detail: "Set a trip budget to track spending.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "budget:none",
    });
  } else {
    const total = toNumberOrNull((budgetRow as any).total_budget);
    const spent = toNumberOrNull((budgetRow as any).spent);
    if (total !== null && spent !== null && total > 0 && spent > total) {
      push({
        userId: null,
        category: "budget",
        status: "action_needed",
        severity: "critical",
        title: "Over budget",
        detail: `Spent ${spent} of ${total} ${(budgetRow as any).currency ?? "USD"}.`,
        dueAt: null,
        actionRef: null,
        dedupeKey: "budget:over",
      });
    }
  }

  // entry (per accepted member, user_id-scoped) -----------------------------
  // Resolve passport issuing countries: inline columns first (test fixtures /
  // older shapes), else join through traveler_passports by passport_id
  // (canonical 0169 schema). The join is defensive like every entry source.
  const inlineCountry = (p: any): string | null => {
    const v = p?.passport_country ?? p?.country_code ?? p?.issuing_country ?? p?.country ?? null;
    const t = v == null ? "" : String(v).trim().toUpperCase();
    return /^[A-Z]{2}$/.test(t) ? t : null;
  };
  const missingPassportIds = passports
    .filter((p) => !inlineCountry(p) && (p as any).passport_id)
    .map((p) => (p as any).passport_id as string);
  const passportCountryById = new Map<string, string>();
  if (missingPassportIds.length > 0) {
    const passportRows = await safeSelect(sc, (c) =>
      c.from("traveler_passports").select("id, issuing_country").in("id", missingPassportIds),
    );
    for (const r of passportRows) {
      const cc = inlineCountry({ issuing_country: (r as any).issuing_country });
      if ((r as any).id && cc) passportCountryById.set((r as any).id as string, cc);
    }
  }

  for (const uid of memberIds) {
    const passport = passports.find((p) => (p as any).user_id === uid);
    if (!passport) {
      push({
        userId: uid,
        category: "entry",
        status: "action_needed",
        severity: "normal",
        title: "Select your travel passport",
        detail: "Entry requirements can't be checked until you pick the passport you're traveling on.",
        dueAt: null,
        actionRef: null,
        dedupeKey: `entry:${uid}:passport`,
      });
      continue;
    }
    // Corridor check unavailable (no ISO2 destination or no entry data source):
    // skip honestly rather than guess.
    if (!destIso2 || corridors === null) continue;

    const passportCountry =
      inlineCountry(passport) ??
      ((passport as any).passport_id
        ? passportCountryById.get((passport as any).passport_id as string) ?? null
        : null);
    if (!passportCountry) continue;

    const corridor = corridors.find(
      (r) => String((r as any).passport_country ?? "").trim().toUpperCase() === passportCountry,
    );
    if (!corridor) {
      push({
        userId: uid,
        category: "entry",
        status: "unknown",
        severity: "normal",
        title: "No verified entry data yet",
        detail: `No verified entry data for ${passportCountry} → ${destIso2} yet.`,
        dueAt: null,
        actionRef: null,
        dedupeKey: `entry:${uid}`,
      });
      continue;
    }

    const corridorStatus = String((corridor as any).status ?? "");
    const officialSourceUrl =
      (corridor as any).official_source_url ?? (corridor as any).source_url ?? null;
    if (["visa_required", "evisa", "special_authorization"].includes(corridorStatus)) {
      push({
        userId: uid,
        category: "entry",
        status: "action_needed",
        severity: "critical",
        title: "Visa/authorization required — verify with official source",
        detail: `${passportCountry} → ${destIso2}: ${corridorStatus.replace(/_/g, " ")}. Always confirm with the official source before booking.`,
        dueAt: null,
        actionRef: { officialSourceUrl },
        dedupeKey: `entry:${uid}`,
      });
    } else if (corridorStatus === "entry_restricted") {
      push({
        userId: uid,
        category: "entry",
        status: "action_needed",
        severity: "critical",
        title: "Entry restricted — verify with official source",
        detail: `${passportCountry} → ${destIso2}: entry is currently restricted. Confirm with the official source.`,
        dueAt: null,
        actionRef: { officialSourceUrl },
        dedupeKey: `entry:${uid}`,
      });
    }
    // visa_free / visa_on_arrival / eta etc. → no item; category stays ready.
  }

  // documents ---------------------------------------------------------------
  if (documentCount === 0) {
    push({
      userId: null,
      category: "documents",
      status: "incomplete",
      severity: "normal",
      title: "No documents saved",
      detail: "Save tickets, confirmations and IDs so the crew can find them.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "documents:none",
    });
  }

  // reservations (cancellation deadlines within 72h) ------------------------
  if (reservationsUnavailable) {
    // `unknown`, not `action_needed`. Both are non-"ready", but action_needed
    // says THERE IS SOMETHING TO DO and this does not know that; unknown says
    // the category was not measured, which is exactly true and is what keeps
    // it out of the score's denominator (summarizeReadiness). `critical`
    // severity keeps it in criticalItems, so it is surfaced rather than buried.
    push({
      userId: null,
      category: "reservations",
      status: "unknown",
      severity: "critical",
      title: "Reservation deadlines could not be checked",
      detail: "We could not read this trip's reservations, so we cannot say whether a free-cancellation window is closing.",
      dueAt: null,
      actionRef: null,
      dedupeKey: "reservations:unreadable",
    });
  }
  for (const r of reservations) {
    if (String((r as any).status ?? "") === "dismissed") continue;
    const deadlineRaw = (r as any).cancellation_deadline_at as string | null;
    if (!deadlineRaw) continue;
    const deadlineMs = new Date(deadlineRaw).getTime();
    if (!Number.isFinite(deadlineMs)) continue;
    if (deadlineMs < nowMs || deadlineMs - nowMs > 72 * HOUR_MS) continue;
    const label = String((r as any).title ?? "Reservation");
    push({
      userId: null,
      category: "reservations",
      status: "action_needed",
      severity: "critical",
      title: `Cancellation deadline soon: ${label}`,
      detail: "The free-cancellation window closes within 72 hours.",
      dueAt: new Date(deadlineMs).toISOString(),
      actionRef: (r as any).id ? { reservationId: (r as any).id } : null,
      dedupeKey: `reservations:deadline:${(r as any).id ?? label}`,
    });
  }

  // Set false when the upsert is known to have failed; gates the sweep below.
  let upsertLanded = true;

  // ── Persist: upsert produced items, sweep stale rows ───────────────────────
  //
  // THE ORDER IS THE CONTRACT AND IT WAS NOT ENFORCED. Both writes below were
  // `.then(undefined, () => {})`, a REJECTION handler on a client that RESOLVES
  // — postgrest-js catches its own fetch errors and returns `{ error }`, so the
  // handler never ran for a database error and the resolved error was discarded
  // unread. The sweep DELETE then ran unconditionally: a failed upsert was
  // followed by deleting the rows describing the PREVIOUS run, leaving
  // trip_readiness_items claiming fewer blockers than either the old or the new
  // truth. That table is member-readable directly over PostgREST (policy
  // tri_member_read), and this file's own header says the critical-item list
  // must never be hidden.
  //
  // The posture is unchanged — a persistence failure must NOT fail the compute,
  // because the summary returned below is derived in memory and is correct
  // either way — but the writes are no longer silent, and the DELETE now
  // happens only when the UPSERT is known to have landed.
  const { data: existingData, error: existingErr } = await sc
    .from("trip_readiness_items")
    .select("dedupe_key")
    .eq("trip_id", tripId);
  // An unreadable stored set cannot be swept against: the sweep is skipped
  // (deleting on an unknown set would be strictly worse than leaving stale rows
  // in place), and it is recorded rather than inferred from a table that never
  // shrinks. NOTE: this branch produces the same visible behaviour as an empty
  // stored set — it is annotation and a log line, not a behaviour change.
  if (existingErr) {
    readinessPersistWarn("trip_readiness_items stale-key read failed — the stale-row sweep is skipped, so superseded readiness items stay in the table", { tripId, error: existingErr });
  }
  const producedKeys = new Set(items.map((i) => i.dedupeKey));
  const staleKeys = ((((existingData as any) ?? []) as any[]))
    .map((r) => (r as any).dedupe_key as string)
    .filter((k) => !producedKeys.has(k));

  if (items.length > 0) {
    const rows = items.map((i) => ({
      trip_id: tripId,
      user_id: i.userId,
      category: i.category,
      status: i.status,
      severity: i.severity,
      title: i.title,
      detail: i.detail,
      due_at: i.dueAt,
      action_ref: i.actionRef,
      dedupe_key: i.dedupeKey,
      computed_at: computedAt,
    }));
    // Persistence failure must not fail the compute — the summary is still fresh.
    const { error: upsertErr } = await sc
      .from("trip_readiness_items")
      .upsert(rows, { onConflict: "trip_id,dedupe_key" });
    if (upsertErr) {
      upsertLanded = false;
      readinessPersistWarn("trip_readiness_items upsert failed — this run's items are NOT stored; the stale-row sweep is skipped so the previous run's rows survive", { tripId, error: upsertErr, itemCount: rows.length });
    }
  }
  // Only sweep when the replacement rows are actually in place. Deleting the
  // superseded rows after a failed upsert removes the only record of those
  // items from a member-readable table.
  if (upsertLanded && staleKeys.length > 0) {
    const { error: sweepErr } = await sc
      .from("trip_readiness_items")
      .delete()
      .eq("trip_id", tripId)
      .in("dedupe_key", staleKeys);
    if (sweepErr) {
      readinessPersistWarn("trip_readiness_items stale-row sweep failed — superseded readiness items stay in the table", { tripId, error: sweepErr, staleCount: staleKeys.length });
    }
  }

  return summarizeReadiness(items, computedAt, null, opts.stages ?? null);
}
