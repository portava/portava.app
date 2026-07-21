/**
 * CompassAutopilotEngine — Phase 13: Trip Autopilot.
 *
 * Keeps a trip healthy without ever taking the wheel:
 *   - Monitors: timing conflicts between plan items (including travel-time
 *     shortfalls between located items), weather clashes against outdoor
 *     items, social changes (a meetup-sourced item's meetup was cancelled),
 *     and injected disruptions (cancellation, transport delay, closure) so
 *     recovery paths are testable and demoable end-to-end.
 *   - Partial re-planner: proposes minimal adjustments that touch ONLY the
 *     affected items — never full regeneration. Fixed items are never moved.
 *     Flexible / Optional items are only touched within the user-granted
 *     autopilot permissions.
 *   - Propose, never auto-execute: every suggested change becomes a durable
 *     pending row in trip_autopilot_proposals with before/after per item;
 *     the user must explicitly confirm, and permissions + lock types are
 *     re-verified at confirm time.
 *   - Trip Heartbeat: an at-a-glance health view (status, active issues,
 *     upcoming risks, pending proposals, item-type counts).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { getWeatherContext, type DailyWeather } from "../lib/weatherCache.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LockType = "fixed" | "flexible" | "optional";
export type IssueSeverity = "watch" | "attention" | "high";

export interface AutopilotSettings {
  enabled: boolean;
  allowMoveFlexible: boolean;
  allowMoveOptional: boolean;
  allowRemoveOptional: boolean;
}

export interface PlanItem {
  id: string;
  title: string;
  category: string;
  status: string;
  lockType: LockType;
  dayDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  locationName: string | null;
  lat: number | null;
  lng: number | null;
  sourceType: string;
  sourceId: string | null;
  sortOrder: number;
}

export interface TripIssue {
  type:
    | "timing_conflict"
    | "weather_clash"
    | "social_change"
    | "transport_delay"
    | "closure"
    | "item_cancelled";
  severity: IssueSeverity;
  itemIds: string[];
  reason: string;
  dedupeKey: string;
  /** extra machine context used by the re-planner */
  meta?: Record<string, unknown>;
}

export interface ItemChange {
  itemId: string;
  title: string;
  lockType: LockType;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface RepairProposal {
  issueType: TripIssue["type"] | "disruption_recovery";
  severity: IssueSeverity;
  reason: string;
  changes: ItemChange[];
  dedupeKey: string;
}

export interface SimulatedDisruption {
  kind: "item_cancelled" | "transport_delay" | "closure";
  itemId: string;
  delayMinutes?: number;
  note?: string;
}

export interface HeartbeatRisk {
  type: string;
  label: string;
  detail: string;
}

export interface TripHeartbeat {
  status: "healthy" | "attention" | "at_risk";
  issues: TripIssue[];
  risks: HeartbeatRisk[];
  pendingProposals: number;
  itemCounts: { fixed: number; flexible: number; optional: number; total: number };
  nextItem: { id: string; title: string; startsAt: string | null; dayDate: string | null } | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum turnaround between back-to-back items with no location data. */
const MIN_GAP_MIN = 10;
/** Assumed on-foot speed for travel-time estimation between located items. */
const WALK_KMH = 4.5;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function toPlanItem(r: Record<string, any>): PlanItem {
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    category: String(r.category ?? "activity"),
    status: String(r.status ?? "tentative"),
    lockType: (["fixed", "flexible", "optional"].includes(r.lock_type) ? r.lock_type : "flexible") as LockType,
    dayDate: (r.day_date as string | null) ?? null,
    startsAt: (r.starts_at as string | null) ?? null,
    endsAt: (r.ends_at as string | null) ?? null,
    locationName: (r.location_name as string | null) ?? null,
    lat: typeof r.lat === "number" ? r.lat : null,
    lng: typeof r.lng === "number" ? r.lng : null,
    sourceType: String(r.source_type ?? "manual"),
    sourceId: (r.source_id as string | null) ?? null,
    sortOrder: typeof r.sort_order === "number" ? r.sort_order : 0,
  };
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Estimated minutes needed between two items (travel + turnaround). */
export function estimatedTransitMinutes(a: PlanItem, b: PlanItem): number {
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    const km = haversineKm(a.lat, a.lng, b.lat, b.lng);
    return Math.max(MIN_GAP_MIN, Math.round((km / WALK_KMH) * 60));
  }
  return MIN_GAP_MIN;
}

function hhmm(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toISOString().slice(11, 16);
}

function isMovable(item: PlanItem, settings: AutopilotSettings): boolean {
  if (item.lockType === "fixed") return false; // never, regardless of settings
  if (item.lockType === "flexible") return settings.allowMoveFlexible;
  return settings.allowMoveOptional;
}

/** Categories treated as weather-exposed when a rainy day is forecast. */
const OUTDOOR_CATEGORIES = new Set(["activity", "free_time", "meeting_point"]);

// ── Settings ──────────────────────────────────────────────────────────────────

export function defaultAutopilotSettings(): AutopilotSettings {
  return { enabled: true, allowMoveFlexible: true, allowMoveOptional: true, allowRemoveOptional: false };
}

export async function getAutopilotSettings(
  sc: SupabaseClient,
  tripId: string,
  userId: string,
): Promise<AutopilotSettings> {
  const { data } = await sc
    .from("trip_autopilot_settings")
    .select("enabled, allow_move_flexible, allow_move_optional, allow_remove_optional")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return defaultAutopilotSettings();
  const d = data as any;
  return {
    enabled: d.enabled !== false,
    allowMoveFlexible: d.allow_move_flexible !== false,
    allowMoveOptional: d.allow_move_optional !== false,
    allowRemoveOptional: d.allow_remove_optional === true,
  };
}

export async function upsertAutopilotSettings(
  sc: SupabaseClient,
  tripId: string,
  userId: string,
  patch: Partial<AutopilotSettings>,
): Promise<AutopilotSettings> {
  const current = await getAutopilotSettings(sc, tripId, userId);
  const next: AutopilotSettings = { ...current, ...patch };
  await sc.from("trip_autopilot_settings").upsert(
    {
      trip_id: tripId,
      user_id: userId,
      enabled: next.enabled,
      allow_move_flexible: next.allowMoveFlexible,
      allow_move_optional: next.allowMoveOptional,
      allow_remove_optional: next.allowRemoveOptional,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "trip_id,user_id" },
  );
  return next;
}

// ── Data loading ──────────────────────────────────────────────────────────────

export async function fetchPlanItems(sc: SupabaseClient, tripId: string): Promise<PlanItem[]> {
  const { data } = await sc
    .from("trip_plan_items")
    .select("id, title, category, status, lock_type, day_date, starts_at, ends_at, location_name, lat, lng, source_type, source_id, sort_order")
    .eq("trip_id", tripId)
    .is("removed_at", null)
    .neq("status", "cancelled");
  return ((data ?? []) as any[]).map(toPlanItem);
}

// ── Monitors / conflict detection ─────────────────────────────────────────────

/**
 * Detect timing conflicts: for each day, sort timed items and flag pairs where
 * the gap between one item's end and the next item's start is less than the
 * estimated transit time between them (or where they plainly overlap).
 */
export function detectTimingConflicts(items: PlanItem[]): TripIssue[] {
  const issues: TripIssue[] = [];
  const byDay = new Map<string, PlanItem[]>();
  for (const it of items) {
    if (!it.startsAt) continue;
    const day = it.dayDate ?? it.startsAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(it);
  }
  for (const [, dayItems] of byDay) {
    const sorted = [...dayItems].sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const aEnd = a.endsAt ?? a.startsAt;
      const aEndMs = Date.parse(String(aEnd));
      const bStartMs = Date.parse(String(b.startsAt));
      if (!Number.isFinite(aEndMs) || !Number.isFinite(bStartMs)) continue;
      const gapMin = Math.round((bStartMs - aEndMs) / 60_000);
      const neededMin = estimatedTransitMinutes(a, b);
      if (gapMin < neededMin) {
        const overlap = gapMin < 0;
        const reason = overlap
          ? `"${a.title}" (${hhmm(a.startsAt)}–${hhmm(aEnd)}) overlaps "${b.title}" at ${hhmm(b.startsAt)}.`
          : `"${a.title}" ends ${hhmm(aEnd)}, "${b.title}" starts ${hhmm(b.startsAt)} — only ${gapMin} min gap but getting there takes about ${neededMin} min.`;
        issues.push({
          type: "timing_conflict",
          severity: overlap ? "high" : "attention",
          itemIds: [a.id, b.id],
          reason,
          dedupeKey: `timing:${a.id}:${b.id}`,
          meta: { shortfallMin: neededMin - gapMin, laterItemId: b.id, earlierItemId: a.id },
        });
      }
    }
  }
  return issues;
}

/** Weather clash: rainy forecast day with weather-exposed items scheduled. */
export async function detectWeatherClashes(
  items: PlanItem[],
  destinationCity: string | null,
  tripStart: string | null,
  tripEnd: string | null,
): Promise<{ issues: TripIssue[]; forecasts: DailyWeather[] }> {
  if (!destinationCity) return { issues: [], forecasts: [] };
  const wx = await getWeatherContext(destinationCity, tripStart ?? undefined, tripEnd ?? undefined).catch(() => null);
  const forecasts = wx?.forecasts ?? [];
  if (forecasts.length === 0) return { issues: [], forecasts: [] };

  const rainyDays = new Set(
    forecasts.filter((f) => f.precipMm > 2 || f.weatherCode >= 51).map((f) => f.date),
  );
  const issues: TripIssue[] = [];
  for (const it of items) {
    const day = it.dayDate ?? (it.startsAt ? it.startsAt.slice(0, 10) : null);
    if (!day || !rainyDays.has(day) || !OUTDOOR_CATEGORIES.has(it.category)) continue;
    const f = forecasts.find((x) => x.date === day);
    issues.push({
      type: "weather_clash",
      severity: "watch",
      itemIds: [it.id],
      reason: `"${it.title}" on ${day} clashes with the forecast (${f?.summary ?? "rain"}, ${f?.precipMm ?? "?"} mm) — it's an outdoor plan.`,
      dedupeKey: `weather:${it.id}:${day}`,
      meta: { day, itemId: it.id },
    });
  }
  return { issues, forecasts };
}

/** Social change: meetup-sourced items whose meetup was cancelled. */
export async function detectSocialChanges(sc: SupabaseClient, items: PlanItem[]): Promise<TripIssue[]> {
  const meetupItems = items.filter((i) => i.sourceType === "meetup" && i.sourceId);
  if (meetupItems.length === 0) return [];
  const { data: meetups } = await sc
    .from("meetups")
    .select("id, status")
    .in("id", meetupItems.map((i) => String(i.sourceId)));
  const cancelled = new Set(
    ((meetups ?? []) as any[]).filter((m) => m.status === "cancelled").map((m) => String(m.id)),
  );
  return meetupItems
    .filter((i) => cancelled.has(String(i.sourceId)))
    .map((i) => ({
      type: "social_change" as const,
      severity: "high" as const,
      itemIds: [i.id],
      reason: `"${i.title}" is linked to a meetup that was cancelled.`,
      dedupeKey: `social:${i.id}:cancelled`,
      meta: { itemId: i.id },
    }));
}

/** Injected disruptions (simulation / external signals) mapped onto items. */
export function detectSimulatedDisruptions(
  items: PlanItem[],
  disruptions: SimulatedDisruption[],
): TripIssue[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const issues: TripIssue[] = [];
  for (const d of disruptions) {
    const item = byId.get(d.itemId);
    if (!item) continue;
    if (d.kind === "item_cancelled") {
      issues.push({
        type: "item_cancelled",
        severity: "high",
        itemIds: [item.id],
        reason: `"${item.title}" was cancelled${d.note ? ` — ${d.note}` : ""}.`,
        dedupeKey: `cancelled:${item.id}`,
        meta: { itemId: item.id },
      });
    } else if (d.kind === "transport_delay") {
      const delay = Math.max(5, Math.min(24 * 60, d.delayMinutes ?? 30));
      issues.push({
        type: "transport_delay",
        severity: "attention",
        itemIds: [item.id],
        reason: `Transport for "${item.title}" is delayed about ${delay} min${d.note ? ` — ${d.note}` : ""}.`,
        dedupeKey: `delay:${item.id}:${delay}`,
        meta: { itemId: item.id, delayMinutes: delay },
      });
    } else if (d.kind === "closure") {
      issues.push({
        type: "closure",
        severity: "attention",
        itemIds: [item.id],
        reason: `"${item.title}" may be closed at the planned time${d.note ? ` — ${d.note}` : ""}.`,
        dedupeKey: `closure:${item.id}`,
        meta: { itemId: item.id },
      });
    }
  }
  return issues;
}

// ── Partial re-planner ────────────────────────────────────────────────────────

function shiftIso(iso: string | null, minutes: number): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + minutes * 60_000).toISOString();
}

/**
 * Build minimal repair proposals for the detected issues. Touches only the
 * affected items; Fixed items are never included in a change; Flexible /
 * Optional items are only included when the user's permissions allow it.
 * Returns proposals — nothing is written or applied here.
 */
export function buildRepairProposals(
  items: PlanItem[],
  issues: TripIssue[],
  settings: AutopilotSettings,
): RepairProposal[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const proposals: RepairProposal[] = [];

  for (const issue of issues) {
    if (issue.type === "timing_conflict") {
      const later = byId.get(String(issue.meta?.laterItemId ?? ""));
      const earlier = byId.get(String(issue.meta?.earlierItemId ?? ""));
      const shortfall = Number(issue.meta?.shortfallMin ?? 0) || MIN_GAP_MIN;
      // Prefer pushing the later item back; fall back to pulling the earlier
      // item forward. If neither is movable, no proposal — the conflict stays
      // flagged for the user to resolve manually.
      if (later && isMovable(later, settings)) {
        proposals.push({
          issueType: "timing_conflict",
          severity: issue.severity,
          reason: `${issue.reason} Suggest starting "${later.title}" ${shortfall} min later.`,
          dedupeKey: `fix:${issue.dedupeKey}`,
          changes: [{
            itemId: later.id,
            title: later.title,
            lockType: later.lockType,
            before: { startsAt: later.startsAt, endsAt: later.endsAt },
            after: { startsAt: shiftIso(later.startsAt, shortfall), endsAt: shiftIso(later.endsAt, shortfall) },
          }],
        });
      } else if (earlier && isMovable(earlier, settings)) {
        proposals.push({
          issueType: "timing_conflict",
          severity: issue.severity,
          reason: `${issue.reason} Suggest starting "${earlier.title}" ${shortfall} min earlier to free up the gap.`,
          dedupeKey: `fix:${issue.dedupeKey}`,
          changes: [{
            itemId: earlier.id,
            title: earlier.title,
            lockType: earlier.lockType,
            before: { startsAt: earlier.startsAt, endsAt: earlier.endsAt },
            after: { startsAt: shiftIso(earlier.startsAt, -shortfall), endsAt: shiftIso(earlier.endsAt, -shortfall) },
          }],
        });
      }
    } else if (issue.type === "transport_delay") {
      const item = byId.get(String(issue.meta?.itemId ?? ""));
      const delay = Number(issue.meta?.delayMinutes ?? 30);
      if (item && item.startsAt && isMovable(item, settings)) {
        proposals.push({
          issueType: "transport_delay",
          severity: issue.severity,
          reason: `${issue.reason} Suggest shifting it ${delay} min later.`,
          dedupeKey: `fix:${issue.dedupeKey}`,
          changes: [{
            itemId: item.id,
            title: item.title,
            lockType: item.lockType,
            before: { startsAt: item.startsAt, endsAt: item.endsAt },
            after: { startsAt: shiftIso(item.startsAt, delay), endsAt: shiftIso(item.endsAt, delay) },
          }],
        });
      }
    } else if (issue.type === "item_cancelled" || issue.type === "social_change") {
      // Disruption recovery: mark the broken item cancelled, and — if permitted —
      // pull the same day's next movable item earlier into the freed slot.
      // Everything else on the trip is untouched (partial re-plan, never full).
      const broken = byId.get(String(issue.meta?.itemId ?? issue.itemIds[0] ?? ""));
      if (!broken) continue;
      const changes: ItemChange[] = [{
        itemId: broken.id,
        title: broken.title,
        lockType: broken.lockType,
        before: { status: broken.status },
        after: { status: "cancelled" },
      }];
      if (broken.startsAt && broken.dayDate) {
        const sameDay = items
          .filter((i) => i.id !== broken.id && i.dayDate === broken.dayDate && i.startsAt
            && Date.parse(String(i.startsAt)) > Date.parse(String(broken.startsAt)))
          .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
        const successor = sameDay.find((i) => isMovable(i, settings));
        if (successor) {
          const pullMin = Math.round(
            (Date.parse(String(successor.startsAt)) - Date.parse(String(broken.startsAt))) / 60_000,
          );
          if (pullMin > 15) {
            changes.push({
              itemId: successor.id,
              title: successor.title,
              lockType: successor.lockType,
              before: { startsAt: successor.startsAt, endsAt: successor.endsAt },
              after: {
                startsAt: shiftIso(successor.startsAt, -Math.min(pullMin, 120)),
                endsAt: shiftIso(successor.endsAt, -Math.min(pullMin, 120)),
              },
            });
          }
        }
      }
      proposals.push({
        issueType: "disruption_recovery",
        severity: "high",
        reason: `${issue.reason} Suggest marking it cancelled${changes.length > 1 ? ` and moving "${changes[1].title}" up to use the freed time` : ""}. Everything else stays as planned.`,
        dedupeKey: `fix:${issue.dedupeKey}`,
        changes,
      });
    } else if (issue.type === "weather_clash") {
      // Weather is a soft risk: surface it in the Heartbeat; only propose a
      // move when the item is movable AND there is timing info to move.
      const item = byId.get(String(issue.meta?.itemId ?? ""));
      if (item && isMovable(item, settings) && item.dayDate) {
        proposals.push({
          issueType: "weather_clash",
          severity: "watch",
          reason: `${issue.reason} Consider an indoor alternative or a different day.`,
          dedupeKey: `fix:${issue.dedupeKey}`,
          changes: [{
            itemId: item.id,
            title: item.title,
            lockType: item.lockType,
            before: { status: item.status },
            after: { status: "tentative" },
          }],
        });
      }
    } else if (issue.type === "closure") {
      const item = byId.get(String(issue.meta?.itemId ?? ""));
      if (item && isMovable(item, settings)) {
        proposals.push({
          issueType: "closure",
          severity: issue.severity,
          reason: `${issue.reason} Suggest marking it tentative until hours are confirmed.`,
          dedupeKey: `fix:${issue.dedupeKey}`,
          changes: [{
            itemId: item.id,
            title: item.title,
            lockType: item.lockType,
            before: { status: item.status },
            after: { status: "tentative" },
          }],
        });
      }
    }
  }

  // Safety net: a proposal must never contain a change to a fixed item.
  return proposals.filter((p) => p.changes.every((c) => c.lockType !== "fixed"));
}

// ── Run: detect + propose (durable, deduped, never auto-executed) ─────────────

export interface AutopilotRunResult {
  issues: TripIssue[];
  proposalsCreated: RepairProposal[];
  proposalsSkipped: number; // deduped against existing pending proposals
}

export async function runAutopilotCheck(
  sc: SupabaseClient,
  tripId: string,
  userId: string,
  opts: { simulate?: SimulatedDisruption[] } = {},
): Promise<AutopilotRunResult> {
  const settings = await getAutopilotSettings(sc, tripId, userId);
  const { data: trip } = await sc
    .from("trips")
    .select("id, destination_city, start_date, end_date")
    .eq("id", tripId)
    .maybeSingle();
  const items = await fetchPlanItems(sc, tripId);

  const issues: TripIssue[] = [
    ...detectTimingConflicts(items),
    ...(await detectSocialChanges(sc, items)),
    ...detectSimulatedDisruptions(items, opts.simulate ?? []),
  ];
  const weather = await detectWeatherClashes(
    items,
    ((trip as any)?.destination_city as string | null) ?? null,
    ((trip as any)?.start_date as string | null) ?? null,
    ((trip as any)?.end_date as string | null) ?? null,
  );
  issues.push(...weather.issues);

  if (!settings.enabled) {
    // Autopilot off: still report issues (the Heartbeat stays honest) but
    // never create proposals.
    return { issues, proposalsCreated: [], proposalsSkipped: 0 };
  }

  const proposals = buildRepairProposals(items, issues, settings);

  // Dedupe against existing pending proposals for this user+trip.
  const { data: existing } = await sc
    .from("trip_autopilot_proposals")
    .select("dedupe_key")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .eq("status", "pending");
  const existingKeys = new Set(((existing ?? []) as any[]).map((r) => String(r.dedupe_key)));

  const created: RepairProposal[] = [];
  let skipped = 0;
  for (const p of proposals) {
    if (existingKeys.has(p.dedupeKey)) { skipped++; continue; }
    const { error } = await sc.from("trip_autopilot_proposals").insert({
      trip_id: tripId,
      user_id: userId,
      issue_type: p.issueType,
      severity: p.severity,
      reason: p.reason,
      changes: p.changes,
      dedupe_key: p.dedupeKey,
      status: "pending",
    });
    if (!error) created.push(p);
  }
  return { issues, proposalsCreated: created, proposalsSkipped: skipped };
}

// ── Confirm / decline ─────────────────────────────────────────────────────────

/** Fields Autopilot is ever allowed to change on a plan item. */
const APPLYABLE_FIELDS: Record<string, string> = {
  startsAt: "starts_at",
  endsAt: "ends_at",
  dayDate: "day_date",
  status: "status",
};

export async function applyProposal(
  sc: SupabaseClient,
  proposal: { id: string; trip_id: string; user_id: string; changes: any },
): Promise<{ applied: number; blocked: string[] }> {
  // Re-verify at confirm time: permissions may have changed and items may
  // have been re-typed since the proposal was created.
  const settings = await getAutopilotSettings(sc, proposal.trip_id, proposal.user_id);
  const changes: ItemChange[] = Array.isArray(proposal.changes) ? proposal.changes : [];
  const items = await fetchPlanItems(sc, proposal.trip_id);
  const byId = new Map(items.map((i) => [i.id, i]));

  let applied = 0;
  const blocked: string[] = [];
  for (const c of changes) {
    const live = byId.get(c.itemId);
    if (!live) { blocked.push(`${c.title}: item no longer exists`); continue; }
    if (live.lockType === "fixed") { blocked.push(`${c.title}: item is Fixed — never auto-moved`); continue; }
    if (!isMovable(live, settings)) { blocked.push(`${c.title}: not permitted by your autopilot settings`); continue; }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [k, col] of Object.entries(APPLYABLE_FIELDS)) {
      if (c.after && Object.prototype.hasOwnProperty.call(c.after, k)) patch[col] = (c.after as any)[k];
    }
    if (Object.keys(patch).length === 1) continue;
    const { error } = await sc
      .from("trip_plan_items")
      .update(patch)
      .eq("id", c.itemId)
      .eq("trip_id", proposal.trip_id);
    if (!error) applied++;
    else blocked.push(`${c.title}: ${error.message}`);
  }
  return { applied, blocked };
}

// ── Trip Heartbeat ────────────────────────────────────────────────────────────

export async function computeHeartbeat(
  sc: SupabaseClient,
  tripId: string,
  userId: string,
  opts: { nowMs?: number } = {},
): Promise<TripHeartbeat> {
  const nowMs = opts.nowMs ?? Date.now();
  const { data: trip } = await sc
    .from("trips")
    .select("id, destination_city, start_date, end_date")
    .eq("id", tripId)
    .maybeSingle();
  const items = await fetchPlanItems(sc, tripId);

  const issues: TripIssue[] = [
    ...detectTimingConflicts(items),
    ...(await detectSocialChanges(sc, items)),
  ];
  const weather = await detectWeatherClashes(
    items,
    ((trip as any)?.destination_city as string | null) ?? null,
    ((trip as any)?.start_date as string | null) ?? null,
    ((trip as any)?.end_date as string | null) ?? null,
  );
  issues.push(...weather.issues);

  const risks: HeartbeatRisk[] = weather.forecasts
    .filter((f) => f.precipMm > 2 || f.weatherCode >= 51)
    .slice(0, 3)
    .map((f) => ({
      type: "weather",
      label: `Rain on ${f.date}`,
      detail: `${f.summary}, ${f.precipMm} mm — plans that day may need an indoor backup.`,
    }));

  const { data: pendingRows } = await sc
    .from("trip_autopilot_proposals")
    .select("id")
    .eq("trip_id", tripId)
    .eq("user_id", userId)
    .eq("status", "pending");
  const pendingProposals = ((pendingRows ?? []) as any[]).length;

  const itemCounts = {
    fixed: items.filter((i) => i.lockType === "fixed").length,
    flexible: items.filter((i) => i.lockType === "flexible").length,
    optional: items.filter((i) => i.lockType === "optional").length,
    total: items.length,
  };

  const upcoming = items
    .filter((i) => i.startsAt && Date.parse(String(i.startsAt)) > nowMs)
    .sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))[0] ?? null;

  const status: TripHeartbeat["status"] = issues.some((i) => i.severity === "high")
    ? "at_risk"
    : issues.length > 0 || risks.length > 0
    ? "attention"
    : "healthy";

  return {
    status,
    issues,
    risks,
    pendingProposals,
    itemCounts,
    nextItem: upcoming
      ? { id: upcoming.id, title: upcoming.title, startsAt: upcoming.startsAt, dayDate: upcoming.dayDate }
      : null,
  };
}
