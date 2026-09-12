/**
 * Trips spec §20 post-trip — the two projections the closeout's "project
 * Passport/Memory candidates" step (§20.2) produces, and the durable outcome
 * rows they are built from. census-trips TR362, TR363, TR382, TR385, TR388,
 * TR428.
 *
 * TRIP → MEMORY (TR362): candidates, never memories. §20.1: "durable memory is
 * built from outcomes" — a candidate is one meaningful outcome of the trip
 * that Memory could keep (§20's list, TR382): a place visited (a done plan
 * anchored to a place), an activity completed (a done plan without one), a
 * regroup the crew met at (a meeting checkpoint closed `met`, 2794), the
 * people intentionally associated (the accepted crew), and the stamps the
 * trip earned. Each memory-shaped candidate carries the `memoryDraft`
 * `POST /memories` takes — approving a story element IS creating the memory,
 * through Memory's own write path, never a second one here — and is marked
 * `realized` with the memory id once one of the viewer's memories of this trip
 * answers it, so a candidate is never offered twice.
 *
 * TRIP → PASSPORT (TR363): what this trip contributed — the countries and
 * cities it touched, the stamps awarded with source_type "trips" for it, and
 * whether completion has been recorded. Nothing here writes the Passport; the
 * award engine (routes/trips.ts awardTripCompletionStamps) already does, and
 * this is the row it reads back.
 *
 * WHAT DECIDES "HAPPENED"
 * =======================
 * A plan's latest trip_outcomes row (2763) wins over its status: outcomes are
 * evidence and corrections are new rows, so the newest one is the crew's last
 * word. A plan with no outcome row counts on its status alone (`done`); a plan
 * that is neither is uncertain and belongs to the §20.3 questions, not here.
 * `unrecordedDonePlanIds` names the done plans with no outcome row at all —
 * the closeout materialises those through RECORD_OUTCOME (TripCloseoutService).
 *
 * Media is Memory's: the viewer's memories of this trip and the memory_items
 * they hold are counted, never copied, so a realized candidate says how much
 * of the story is already kept.
 *
 * Kernel-era inputs (trip_outcomes, trip_meeting_checkpoints) are read only
 * under the operational gate; a projection built without them says so in
 * `unread`, and no candidate is invented for what was not read.
 */

export const MEMORY_CANDIDATE_KINDS = ["place_visited", "activity_completed", "regroup_met", "people", "stamp"] as const;
export type MemoryCandidateKind = (typeof MEMORY_CANDIDATE_KINDS)[number];

export interface PostTripTrip {
  id: string; title: string | null; status: string | null;
  destinationCity: string | null; destinationCountry: string | null;
  startDate: string | null; endDate: string | null;
}
export interface PostTripPlanItem {
  id: string; title: string | null; category: string | null; status: string | null;
  dayDate: string | null; startsAt: string | null; endsAt: string | null; locationName: string | null;
  sourceType: string | null; sourceId: string | null;
}
export interface PostTripOutcome { id: string; planId: string | null; stageId: string | null; outcomeType: string; occurredAt: string; createdAt: string | null; evidence: Record<string, unknown> }
export interface PostTripCheckpoint { id: string; label: string; status: string; placeId: string | null; meetAt: string | null; arrivedUserIds: readonly string[] }
export interface PostTripMemory { id: string; title: string | null; placeId: string | null; startsAt: string | null; state: string | null; mediaCount: number }
export interface PostTripStamp { id: string; definitionId: string; slug: string | null; name: string | null; city: string | null; country: string | null; earnedAt: string | null; revoked: boolean }

export interface PostTripInputs {
  trip: PostTripTrip;
  viewerId: string;
  planItems: readonly PostTripPlanItem[];
  /** null = not read (the operational gate is off, or the read failed). */
  outcomes: readonly PostTripOutcome[] | null;
  /** null = not read. */
  checkpoints: readonly PostTripCheckpoint[] | null;
  crew: readonly { userId: string; role: string | null }[];
  /** The viewer's own memories of this trip; null = not read. */
  memories: readonly PostTripMemory[] | null;
  /** The viewer's stamps awarded for this trip; null = not read. */
  stamps: readonly PostTripStamp[] | null;
  /** Which inputs could not be read, by table. */
  unread: readonly string[];
  now: Date;
}

export interface MemoryDraft {
  tripId: string; title: string; placeId: string | null;
  startsAt: string | null; endsAt: string | null;
  locationCity: string | null; locationCountry: string | null;
}
export interface MemoryCandidate {
  /** Stable across reads: plan:<id> | checkpoint:<id> | people | stamp:<id>. */
  id: string;
  kind: MemoryCandidateKind;
  title: string;
  occurredAt: string | null;
  /** Where the fact comes from — a row the reader can open, never a guess. */
  evidence: { source: "outcome" | "plan_status" | "checkpoint" | "crew" | "stamp"; ids: string[] };
  /** What POST /memories would take; null for a candidate that is a tag or a stamp, not a memory of its own. */
  memoryDraft: MemoryDraft | null;
  /** The viewer's memory that already answers this candidate, when one does, and how much media it holds. */
  realized: { memoryId: string; mediaCount: number } | null;
  /** people: the user ids the viewer travelled with (never the viewer). */
  peopleUserIds?: string[];
}
export interface TripMemoryProjection {
  projectionId: "TripMemoryProjection";
  tripId: string;
  viewerId: string;
  candidates: MemoryCandidate[];
  realizedCount: number;
  /** The viewer's memories of this trip and the media they hold (memory_items); null = memories not read. */
  media: { memories: number; items: number } | null;
  /** Done plans with no outcome row at all — what the closeout records. */
  unrecordedDonePlanIds: string[];
  unread: string[];
  reading: string;
}
export interface TripPassportProjection {
  projectionId: "TripPassportProjection";
  tripId: string;
  viewerId: string;
  completed: boolean;
  countries: string[];
  cities: string[];
  /** null = user_stamps was not read. */
  stamps: { id: string; slug: string | null; name: string | null; earnedAt: string | null }[] | null;
  unread: string[];
  reading: string;
}

/** The newest outcome per plan: the crew's last word (corrections are new rows). */
export function latestOutcomeByPlan(outcomes: readonly PostTripOutcome[]): Map<string, PostTripOutcome> {
  const byPlan = new Map<string, PostTripOutcome>();
  const key = (o: PostTripOutcome) => `${o.occurredAt}|${o.createdAt ?? ""}|${o.id}`;
  for (const o of outcomes) {
    if (!o.planId) continue;
    const prev = byPlan.get(o.planId);
    if (!prev || key(o) > key(prev)) byPlan.set(o.planId, o);
  }
  return byPlan;
}

function planPlaceId(p: PostTripPlanItem): string | null {
  return p.sourceType === "place" && p.sourceId ? p.sourceId : null;
}
function planTitle(p: PostTripPlanItem): string {
  return (p.locationName ?? p.title ?? "that plan").trim() || "that plan";
}
function planOccurredAt(p: PostTripPlanItem): string | null {
  return p.endsAt ?? p.startsAt ?? (p.dayDate ? `${p.dayDate}T23:59:59.000Z` : null);
}
function dateOf(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : iso.slice(0, 10);
}

/**
 * Which of the viewer's memories answers a candidate: the same place, or —
 * for a plan with no place — the same day and the same title. Deleted
 * memories never answer anything.
 */
function realizedBy(memories: readonly PostTripMemory[] | null, draft: MemoryDraft): { memoryId: string; mediaCount: number } | null {
  if (!memories) return null;
  for (const m of memories) {
    if (m.state === "deleted") continue;
    if (draft.placeId && m.placeId === draft.placeId) return { memoryId: m.id, mediaCount: m.mediaCount };
    if (!draft.placeId && dateOf(m.startsAt) !== null && dateOf(m.startsAt) === dateOf(draft.startsAt)
        && (m.title ?? "").trim().toLowerCase() === draft.title.trim().toLowerCase()) return { memoryId: m.id, mediaCount: m.mediaCount };
  }
  return null;
}

export function buildTripMemoryProjection(inputs: PostTripInputs): TripMemoryProjection {
  const { trip, viewerId } = inputs;
  const candidates: MemoryCandidate[] = [];
  const latest = latestOutcomeByPlan(inputs.outcomes ?? []);
  const unrecordedDonePlanIds: string[] = [];

  const plans = [...inputs.planItems].sort((a, b) => (planOccurredAt(a) ?? "").localeCompare(planOccurredAt(b) ?? "") || a.id.localeCompare(b.id));
  for (const p of plans) {
    const o = latest.get(p.id) ?? null;
    let happened: "outcome" | "plan_status" | null = null;
    if (o) { if (o.outcomeType === "completed" || o.outcomeType === "substituted") happened = "outcome"; }
    else if (p.status === "done") { happened = "plan_status"; if (inputs.outcomes !== null) unrecordedDonePlanIds.push(p.id); }
    if (!happened) continue;
    const placeId = planPlaceId(p);
    const title = planTitle(p);
    const occurredAt = o?.occurredAt ?? planOccurredAt(p);
    const draft: MemoryDraft = {
      tripId: trip.id, title, placeId,
      startsAt: p.startsAt ?? (p.dayDate ? `${p.dayDate}T00:00:00.000Z` : occurredAt),
      endsAt: p.endsAt ?? null,
      locationCity: trip.destinationCity, locationCountry: trip.destinationCountry,
    };
    candidates.push({
      id: `plan:${p.id}`,
      kind: placeId || p.locationName ? "place_visited" : "activity_completed",
      title, occurredAt,
      evidence: happened === "outcome" ? { source: "outcome", ids: [o!.id] } : { source: "plan_status", ids: [p.id] },
      memoryDraft: draft,
      realized: realizedBy(inputs.memories, draft),
    });
  }

  for (const cp of [...(inputs.checkpoints ?? [])].sort((a, b) => (a.meetAt ?? "").localeCompare(b.meetAt ?? "") || a.id.localeCompare(b.id))) {
    if (cp.status !== "met" || cp.arrivedUserIds.length === 0) continue;
    const title = `Met the crew at ${cp.label}`;
    const draft: MemoryDraft = { tripId: trip.id, title, placeId: cp.placeId, startsAt: cp.meetAt, endsAt: null, locationCity: trip.destinationCity, locationCountry: trip.destinationCountry };
    candidates.push({
      id: `checkpoint:${cp.id}`, kind: "regroup_met", title, occurredAt: cp.meetAt,
      evidence: { source: "checkpoint", ids: [cp.id] }, memoryDraft: draft, realized: realizedBy(inputs.memories, draft),
      peopleUserIds: [...cp.arrivedUserIds].filter((u) => u !== viewerId).sort(),
    });
  }

  const others = inputs.crew.map((c) => c.userId).filter((u) => u !== viewerId).sort();
  if (others.length > 0) {
    candidates.push({
      id: "people", kind: "people", title: `${others.length} ${others.length === 1 ? "person" : "people"} you travelled with`,
      occurredAt: trip.endDate ? `${trip.endDate}T23:59:59.000Z` : null,
      evidence: { source: "crew", ids: others }, memoryDraft: null, realized: null, peopleUserIds: others,
    });
  }

  for (const s of [...(inputs.stamps ?? [])].filter((s) => !s.revoked).sort((a, b) => (a.earnedAt ?? "").localeCompare(b.earnedAt ?? "") || a.id.localeCompare(b.id))) {
    candidates.push({
      id: `stamp:${s.id}`, kind: "stamp", title: s.name ?? s.slug ?? "a stamp", occurredAt: s.earnedAt,
      evidence: { source: "stamp", ids: [s.id] }, memoryDraft: null, realized: null,
    });
  }

  const realizedCount = candidates.filter((c) => c.realized !== null).length;
  const live = (inputs.memories ?? []).filter((m) => m.state !== "deleted");
  const media = inputs.memories === null ? null : { memories: live.length, items: live.reduce((n, m) => n + m.mediaCount, 0) };
  const parts = [
    `${candidates.length} candidate(s) for the viewer from ${plans.length} plan(s)` +
      (inputs.outcomes === null ? " (trip_outcomes not read: plan status alone decides, nothing to record)" : ` and ${inputs.outcomes.length} outcome row(s)`),
    inputs.checkpoints === null ? "meeting checkpoints not read" : `${inputs.checkpoints.filter((c) => c.status === "met").length} checkpoint(s) met`,
    inputs.memories === null ? "memories not read: nothing is marked realized" : `${realizedCount} already realized as a memory; ${media!.memories} memory/ies of this trip holding ${media!.items} media item(s)`,
    inputs.stamps === null ? "stamps not read" : `${inputs.stamps.filter((s) => !s.revoked).length} stamp(s)`,
    `${unrecordedDonePlanIds.length} done plan(s) without a durable outcome`,
  ];
  return { projectionId: "TripMemoryProjection", tripId: trip.id, viewerId, candidates, realizedCount, media, unrecordedDonePlanIds, unread: [...inputs.unread], reading: parts.join("; ") + "." };
}

function uniq(values: (string | null | undefined)[]): string[] {
  const out: string[] = []; const seen = new Set<string>();
  for (const v of values) { const s = (v ?? "").trim(); if (!s) continue; const k = s.toLowerCase(); if (seen.has(k)) continue; seen.add(k); out.push(s); }
  return out;
}

export function buildTripPassportProjection(inputs: PostTripInputs): TripPassportProjection {
  const { trip, viewerId } = inputs;
  const live = (inputs.stamps ?? []).filter((s) => !s.revoked);
  const countries = uniq([trip.destinationCountry, ...live.map((s) => s.country)]);
  const cities = uniq([trip.destinationCity, ...live.map((s) => s.city)]);
  const completed = trip.status === "completed";
  const reading = [
    completed ? "completion is recorded on the trip" : `the trip is ${trip.status ?? "unknown"}: completion is not yet recorded, so nothing here is counted by the Passport`,
    `${countries.length} country/ies and ${cities.length} city/ies from the destination` + (live.length > 0 ? " and the stamps" : ""),
    inputs.stamps === null ? "user_stamps not read" : `${live.length} stamp(s) awarded for this trip`,
  ].join("; ") + ".";
  return {
    projectionId: "TripPassportProjection", tripId: trip.id, viewerId, completed, countries, cities,
    stamps: inputs.stamps === null ? null : live.map((s) => ({ id: s.id, slug: s.slug, name: s.name, earnedAt: s.earnedAt })),
    unread: [...inputs.unread], reading,
  };
}

/* ── the reader ─────────────────────────────────────────────────────────── */

import { tripOperationalProjectionsGate } from "../../lib/tripOperationalProjections.js";
import { logger } from "../../lib/logger.js";

const log = logger.child({ mod: "tripPostTrip" });

export type PostTripRead = { ok: true; inputs: PostTripInputs } | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE"; message: string };

/**
 * Reads what both projections and the closeout step need. Kernel-era tables
 * only under the operational gate; a failed optional read lands in `unread`
 * and its input is null — never an empty list pretending to be a read.
 */
export async function readPostTripInputs(sc: any, tripId: string, viewerId: string, opts: { now?: Date } = {}): Promise<PostTripRead> {
  const now = opts.now ?? new Date();
  const unread: string[] = [];

  const { data: trip, error: tErr } = await sc.from("trips")
    .select("id, title, status, destination_city, destination_country, start_date, end_date")
    .eq("id", tripId).maybeSingle();
  if (tErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };

  const { data: items, error: iErr } = await sc.from("trip_plan_items")
    .select("id, title, category, status, day_date, starts_at, ends_at, location_name, source_type, source_id")
    .eq("trip_id", tripId).is("removed_at", null);
  if (iErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip's plans could not be read" };

  const { data: members, error: mErr } = await sc.from("trip_members").select("user_id, role, status").eq("trip_id", tripId).eq("status", "accepted");
  if (mErr) return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The crew could not be read" };

  let memories: PostTripMemory[] | null = null;
  const { data: mems, error: memErr } = await sc.from("memories").select("id, title, place_id, starts_at, state").eq("trip_id", tripId).eq("owner_id", viewerId);
  if (memErr) { unread.push("memories"); log.warn({ err: memErr.message, tripId }, "post-trip: memories unreadable"); }
  else {
    const list = (mems ?? []) as any[];
    const counts = new Map<string, number>();
    if (list.length > 0) {
      const { data: items, error: itErr } = await sc.from("memory_items").select("memory_id").in("memory_id", list.map((m) => String(m.id)));
      if (itErr) { unread.push("memory_items"); log.warn({ err: itErr.message, tripId }, "post-trip: memory items unreadable"); }
      else for (const it of (items ?? []) as any[]) { const k = String(it.memory_id); counts.set(k, (counts.get(k) ?? 0) + 1); }
    }
    memories = list.map((m) => ({ id: String(m.id), title: m.title ?? null, placeId: m.place_id ?? null, startsAt: m.starts_at ?? null, state: m.state ?? null, mediaCount: counts.get(String(m.id)) ?? 0 }));
  }

  let stamps: PostTripStamp[] | null = null;
  const { data: st, error: stErr } = await sc.from("user_stamps")
    .select("id, stamp_definition_id, earned_at, city, country, is_revoked")
    .eq("user_id", viewerId).eq("source_type", "trips").eq("source_id", tripId);
  if (stErr) { unread.push("user_stamps"); log.warn({ err: stErr.message, tripId }, "post-trip: stamps unreadable"); }
  else {
    const rows = (st ?? []) as any[];
    const defIds = Array.from(new Set(rows.map((r) => String(r.stamp_definition_id))));
    const names = new Map<string, { slug: string | null; name: string | null }>();
    if (defIds.length > 0) {
      const { data: defs, error: dErr } = await sc.from("stamp_definitions").select("id, slug, name").in("id", defIds);
      if (dErr) { unread.push("stamp_definitions"); log.warn({ err: dErr.message, tripId }, "post-trip: stamp definitions unreadable"); }
      else for (const d of (defs ?? []) as any[]) names.set(String(d.id), { slug: d.slug ?? null, name: d.name ?? null });
    }
    stamps = rows.map((r) => ({
      id: String(r.id), definitionId: String(r.stamp_definition_id),
      slug: names.get(String(r.stamp_definition_id))?.slug ?? null, name: names.get(String(r.stamp_definition_id))?.name ?? null,
      city: r.city ?? null, country: r.country ?? null, earnedAt: r.earned_at ?? null, revoked: r.is_revoked === true,
    }));
  }

  let outcomes: PostTripOutcome[] | null = null;
  let checkpoints: PostTripCheckpoint[] | null = null;
  const gate = await tripOperationalProjectionsGate(sc);
  if (gate.enabled) {
    const { data: outs, error: oErr } = await sc.from("trip_outcomes").select("id, plan_id, stage_id, outcome_type, occurred_at, created_at, evidence_json").eq("trip_id", tripId);
    if (oErr) { unread.push("trip_outcomes"); log.warn({ err: oErr.message, tripId }, "post-trip: outcomes unreadable"); }
    else outcomes = ((outs ?? []) as any[]).map((o) => ({
      id: String(o.id), planId: o.plan_id ? String(o.plan_id) : null, stageId: o.stage_id ? String(o.stage_id) : null,
      outcomeType: String(o.outcome_type), occurredAt: String(o.occurred_at), createdAt: o.created_at ? String(o.created_at) : null,
      evidence: o.evidence_json && typeof o.evidence_json === "object" ? o.evidence_json : {},
    }));
    const { data: cps, error: cErr } = await sc.from("trip_meeting_checkpoints").select("id, label, status, place_id, meet_at").eq("trip_id", tripId);
    if (cErr) { unread.push("trip_meeting_checkpoints"); log.warn({ err: cErr.message, tripId }, "post-trip: checkpoints unreadable"); }
    else {
      const list = (cps ?? []) as any[];
      const arrived = new Map<string, string[]>();
      if (list.length > 0) {
        const { data: parts, error: pErr } = await sc.from("trip_meeting_checkpoint_participants").select("checkpoint_id, user_id, arrival_state").in("checkpoint_id", list.map((c) => String(c.id)));
        if (pErr) { unread.push("trip_meeting_checkpoint_participants"); log.warn({ err: pErr.message, tripId }, "post-trip: checkpoint participants unreadable"); }
        else for (const p of (parts ?? []) as any[]) if (p.arrival_state === "arrived") { const k = String(p.checkpoint_id); arrived.set(k, [...(arrived.get(k) ?? []), String(p.user_id)]); }
      }
      checkpoints = list.map((c) => ({ id: String(c.id), label: String(c.label ?? ""), status: String(c.status ?? ""), placeId: c.place_id ? String(c.place_id) : null, meetAt: c.meet_at ?? null, arrivedUserIds: arrived.get(String(c.id)) ?? [] }));
    }
  } else {
    unread.push("trip_outcomes", "trip_meeting_checkpoints");
  }

  return {
    ok: true,
    inputs: {
      trip: { id: String((trip as any).id), title: (trip as any).title ?? null, status: (trip as any).status ?? null, destinationCity: (trip as any).destination_city ?? null, destinationCountry: (trip as any).destination_country ?? null, startDate: (trip as any).start_date ?? null, endDate: (trip as any).end_date ?? null },
      viewerId,
      planItems: ((items ?? []) as any[]).map((p) => ({ id: String(p.id), title: p.title ?? null, category: p.category ?? null, status: p.status ?? null, dayDate: p.day_date ?? null, startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, locationName: p.location_name ?? null, sourceType: p.source_type ?? null, sourceId: p.source_id ?? null })),
      outcomes, checkpoints,
      crew: ((members ?? []) as any[]).map((m) => ({ userId: String(m.user_id), role: m.role ?? null })),
      memories, stamps, unread, now,
    },
  };
}
