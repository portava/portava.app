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

export interface ReadinessSummary {
  computedAt: string;
  /** Mechanical: round(100 × share of categories with zero action_needed/incomplete items). */
  score: number;
  /** Category-level counts by worst status (sums to 7). */
  counts: { ready: number; actionNeeded: number; incomplete: number; unknown: number };
  /** FULL list of critical items — never truncated (critical-visibility rule). */
  criticalItems: ReadinessItem[];
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

/** Accepted member ids for a trip (owner always included). */
export async function loadAcceptedMemberIds(
  sc: any,
  tripId: string,
  ownerId: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  if (ownerId) ids.add(ownerId);
  const { data } = await sc
    .from("trip_members")
    .select("user_id, role, status")
    .eq("trip_id", tripId);
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

export function summarizeReadiness(items: ReadinessItem[], computedAt: string): ReadinessSummary {
  const categories = {} as Record<ReadinessCategory, ReadinessStatus>;
  for (const c of READINESS_CATEGORIES) categories[c] = "ready";
  for (const item of items) {
    const cur = categories[item.category] ?? "ready";
    if (STATUS_RANK[item.status] > STATUS_RANK[cur]) categories[item.category] = item.status;
  }

  const counts = { ready: 0, actionNeeded: 0, incomplete: 0, unknown: 0 };
  let readyish = 0;
  for (const c of READINESS_CATEGORIES) {
    const s = categories[c];
    if (s === "ready") counts.ready += 1;
    else if (s === "action_needed") counts.actionNeeded += 1;
    else if (s === "incomplete") counts.incomplete += 1;
    else counts.unknown += 1;
    // "Ready-ish" for the score: no action_needed and no incomplete items.
    if (s === "ready" || s === "unknown") readyish += 1;
  }
  const score = Math.round((100 * readyish) / READINESS_CATEGORIES.length);

  // CRITICAL-VISIBILITY RULE: the full critical list rides alongside the
  // score, always and untruncated — a high score must never bury a critical.
  const criticalItems = items.filter((i) => i.severity === "critical");

  return { computedAt, score, counts, criticalItems, categories, items };
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
export async function computeReadiness(sc: any, tripId: string): Promise<ReadinessSummary> {
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

  const memberIds = await loadAcceptedMemberIds(sc, tripId, (trip as any).owner_id ?? null);

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
  const reservations = await safeSelect(sc, (c) =>
    c.from("trip_reservations").select("*").eq("trip_id", tripId),
  );
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
    push({
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
    push({
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

  // ── Persist: upsert produced items, sweep stale rows ───────────────────────
  const { data: existingData } = await sc
    .from("trip_readiness_items")
    .select("dedupe_key")
    .eq("trip_id", tripId);
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
    await sc
      .from("trip_readiness_items")
      .upsert(rows, { onConflict: "trip_id,dedupe_key" })
      .then(undefined, () => {});
  }
  if (staleKeys.length > 0) {
    await sc
      .from("trip_readiness_items")
      .delete()
      .eq("trip_id", tripId)
      .in("dedupe_key", staleKeys)
      .then(undefined, () => {});
  }

  return summarizeReadiness(items, computedAt);
}
