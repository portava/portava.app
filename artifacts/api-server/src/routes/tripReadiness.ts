/**
 * tripReadiness.ts — Trip Readiness + Next Best Action + Arrival Board.
 *
 *   GET /api/trips/:tripId/readiness         — flag-gated; lazily recomputed
 *       readiness summary (recompute when stored items are >10 min old, when
 *       no items are stored, or when ?refresh=1).
 *   GET /api/trips/:tripId/next-best-action  — flag-gated; single ranked
 *       action + up to 3 alternatives. Ranking: critical readiness items
 *       (earliest due_at first) → pending autopilot proposals → action_needed
 *       → incomplete → honest "on track" fallback.
 *   GET /api/trips/:tripId/arrival-board     — membership only (no flag);
 *       per-member arrival info derived from flight reservations, with an
 *       honest note when data is sparse.
 *
 * Security: requireUser + explicit accepted-membership check (service-role
 * client) on every route, trips-expansion style.
 */
import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { logger } from "../lib/logger.js";
import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { tripOperationalProjectionsGate } from "../lib/tripOperationalProjections.js";
import type { ReadinessStage } from "../lib/tripReadiness.js";
import {
  READINESS_FLAG,
  READINESS_STALE_MS,
  computeReadiness,
  summarizeReadiness,
  rowToItem,
  fetchPendingAutopilotProposals,
  loadAcceptedMemberIds,
  safeSelect,
  type ReadinessItem,
  type ReadinessSummary,
} from "../lib/tripReadiness.js";

/** Return today's UTC date string (YYYY-MM-DD). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Derive the score from a set of stored rows using summarizeReadiness.
 * Returns null when rows is empty (no prior snapshot).
 */
function scoreFromRows(rows: any[]): number | null {
  if (rows.length === 0) return null;
  const items = rows.map(rowToItem);
  const fakeAt = (rows[0] as any).computed_at ?? new Date().toISOString();
  return summarizeReadiness(items, fakeAt, null).score;
}

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Explicit membership check (trips-expansion style): trip must exist and the
 * caller must be the owner or an accepted member. Writes the error response
 * and returns null on failure; returns the trip row on success.
 */
async function requireMembership(
  sc: any,
  res: Response,
  tripId: string,
  userId: string,
): Promise<any | null> {
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return null; }

  const { data: trip, error } = await sc
    .from("trips")
    .select("id, owner_id, destination_city, destination_country")
    .eq("id", tripId)
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return null; }
  if (!trip) { sendError(res, "not_found", "Trip not found"); return null; }

  if ((trip as any).owner_id === userId) return trip;

  const membership = await requireTripMember(sc, tripId, userId);
  if (!membership) { sendError(res, "not_member", "Not a trip member"); return null; }
  return trip;
}

/** Newest computed_at (epoch ms) among stored readiness rows; 0 when none. */
function newestComputedAtMs(rows: any[]): number {
  let max = 0;
  for (const r of rows) {
    const t = new Date((r as any).computed_at ?? 0).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

/**
 * Fetch the most recent snapshot score for this trip from a prior UTC day.
 *
 * `null` is the right answer for "no prior snapshot" — it renders as "no trend
 * yet", which is honest — so a failed read still returns null rather than
 * failing the whole readiness response over a decoration. But it is no longer
 * SILENT: an unreadable trip_readiness_snapshots and a genuinely first-ever
 * compute produced the identical null, so a permanently broken trend looked
 * exactly like a new trip and could never be noticed. The error is now logged
 * and the two cases are distinguishable in the log.
 *
 * The `try`/`catch` is kept but is no longer EMPTY. It was written to absorb
 * PostgREST failures and could never do that — supabase-js RESOLVES
 * `{ data, error }` and does not throw — so it only ever covered a
 * transport-level rejection, and covered that silently too. Both paths log.
 */
async function loadPreviousSnapshotScore(sc: any, tripId: string): Promise<number | null> {
  try {
    const { data, error } = await sc
      .from("trip_readiness_snapshots")
      .select("score, snapshot_date")
      .eq("trip_id", tripId)
      .lt("snapshot_date", todayUtc())
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, tripId }, "trip_readiness_snapshots read failed — readiness trend will read as 'no prior snapshot'");
      return null;
    }
    if (!data) return null;
    return typeof (data as any).score === "number" ? (data as any).score : null;
  } catch (err) {
    // TRANSPORT-level rejection only (socket, DNS, a client that throws before
    // it queries). PostgREST failures arrive through `error` above — that is why
    // this catch, when it was EMPTY, could not do the job it was written for.
    logger.warn({ err, tripId }, "trip_readiness_snapshots read threw — readiness trend will read as 'no prior snapshot'");
    return null;
  }
}

/**
 * Persist today's score snapshot (upsert by trip_id + snapshot_date), then prune
 * rows older than 30 days for this trip so the table does not grow unbounded
 * (only the most recent prior-day row is ever read).
 *
 * Still best-effort — a failed snapshot must not break a readiness response that
 * is otherwise correct — but no longer SILENT, which is the part that mattered.
 * Both writes were `.then(undefined, () => {})` inside a `try`/`catch`, and
 * BOTH of those are dead: a PostgREST builder RESOLVES on a database error, so
 * the rejection handler never ran and the catch never fired; the resolved
 * `{ error }` was discarded unread. The consequence was invisible and
 * self-concealing: if the upsert failed systematically, every later
 * loadPreviousSnapshotScore found nothing, `previousScore` was permanently
 * null, the readiness TREND silently never worked, and it looked exactly like a
 * trip on its first compute. Both are the pair baselined in
 * scripts/SILENT_SUPABASE_WRITES_BASELINE.json as routes/tripReadiness.ts: 2.
 */
async function persistTodaySnapshot(sc: any, tripId: string, score: number | null): Promise<void> {
  // A score of `null` means no readiness category could be measured at all.
  // There is nothing to record, and writing a placeholder would make tomorrow's
  // trend arrow compare against a number nobody computed.
  if (score === null) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const todayStr = nowIso.slice(0, 10);

  try {
    const { error: upsertErr } = await sc
      .from("trip_readiness_snapshots")
      .upsert(
        { trip_id: tripId, snapshot_date: todayStr, score, computed_at: nowIso },
        { onConflict: "trip_id,snapshot_date" },
      );
    if (upsertErr) {
      logger.warn({ err: upsertErr, tripId, snapshotDate: todayStr },
        "trip_readiness_snapshots upsert failed — today's score is not recorded, so tomorrow's trend will read as 'no prior snapshot'");
    }
  } catch (err) {
    // Transport-level only; see loadPreviousSnapshotScore. Kept because the
    // snapshot is a decoration on an otherwise-correct readiness response and
    // must not turn it into a 5xx — but it LOGS now, which is the whole point.
    logger.warn({ err, tripId, snapshotDate: todayStr }, "trip_readiness_snapshots upsert threw — today's score is not recorded");
  }

  const cutoff = new Date(nowMs - 30 * 864e5).toISOString().slice(0, 10);
  try {
    const { error: pruneErr } = await sc
      .from("trip_readiness_snapshots")
      .delete()
      .eq("trip_id", tripId)
      .lt("snapshot_date", cutoff);
    if (pruneErr) {
      logger.warn({ err: pruneErr, tripId, cutoff },
        "trip_readiness_snapshots prune failed — old snapshot rows will accumulate for this trip");
    }
  } catch (err) {
    logger.warn({ err, tripId, cutoff }, "trip_readiness_snapshots prune threw — old snapshot rows will accumulate for this trip");
  }
}

/**
 * Serve stored items when fresh (<10 min), else recompute (also on
 * forceRefresh). Returns null after writing an error response.
 */
async function loadOrComputeSummary(
  sc: any,
  res: Response,
  tripId: string,
  forceRefresh: boolean,
): Promise<ReadinessSummary | null> {
  const { data: rowsData, error: rowsErr } = await sc
    .from("trip_readiness_items")
    .select("*")
    .eq("trip_id", tripId);
  if (rowsErr) { sendError(res, "db_error", rowsErr.message); return null; }

  const rows = (((rowsData as any) ?? []) as any[]);
  const newestMs = newestComputedAtMs(rows);
  // Zero rows could mean "never computed" as well as "fully ready" — recompute
  // so a fully-ready trip stays honest and a new trip gets a first pass.
  const stale = rows.length === 0 || Date.now() - newestMs > READINESS_STALE_MS;

  if (forceRefresh || stale) {
    // 1. Read the most recent prior-day score from the snapshots table.
    //    This survives same-day recomputes (unlike relying on items rows).
    //    Fall back to deriving from today's stale items when no snapshot
    //    exists yet but the items are from a prior day (migration path).
    let previousScore: number | null = await loadPreviousSnapshotScore(sc, tripId);
    if (previousScore === null && rows.length > 0) {
      const cachedDay = new Date(newestMs).toISOString().slice(0, 10);
      if (cachedDay !== todayUtc()) {
        previousScore = scoreFromRows(rows);
      }
    }

    try {
      // §8.3 "by upcoming stage": 2760's stages, read here under the gate that owns them.
      let stages: ReadinessStage[] | null = null;
      if ((await tripOperationalProjectionsGate(sc)).enabled) {
        const { data: stageRows, error: stErr } = await sc.from("trip_stages").select("id, sequence, starts_at, ends_at").eq("trip_id", tripId);
        if (!stErr) stages = ((stageRows ?? []) as any[]).map((st) => ({ id: String(st.id), sequence: typeof st.sequence === "number" ? st.sequence : null, startsAt: st.starts_at ?? null, endsAt: st.ends_at ?? null }));
      }
      const fresh = await computeReadiness(sc, tripId, { stages });
      // 2. Persist today's score so future recomputes can read it as "previous".
      await persistTodaySnapshot(sc, tripId, fresh.score);
      return { ...fresh, previousScore };
    } catch (e: any) {
      if (e?.code === "not_found") { sendError(res, "not_found", "Trip not found"); return null; }
      sendError(res, "db_error", e?.message ?? "Failed to compute readiness");
      return null;
    }
  }

  const items = rows.map(rowToItem);
  return summarizeReadiness(items, new Date(newestMs).toISOString(), null);
}

const ReadinessQuerySchema = z.object({ refresh: z.string().optional() }).passthrough();

// ---------------------------------------------------------------------------
// GET /trips/:tripId/readiness
// ---------------------------------------------------------------------------
router.get("/trips/:tripId/readiness", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!(await isFlagEnabled(sc, READINESS_FLAG))) {
    sendError(res, "feature_disabled", "Trip readiness is not enabled");
    return;
  }

  const trip = await requireMembership(sc, res, tripId, user.id);
  if (!trip) return;

  const parsedQuery = ReadinessQuerySchema.safeParse(req.query);
  const refresh = parsedQuery.success && ["1", "true"].includes(parsedQuery.data.refresh ?? "");

  const summary = await loadOrComputeSummary(sc, res, tripId, refresh);
  if (!summary) return;
  res.json(summary);
}));

// ---------------------------------------------------------------------------
// GET /trips/:tripId/next-best-action
// ---------------------------------------------------------------------------

interface NbaCandidate {
  title: string;
  detail: string | null;
  category: string;
  severity: string;
  dueAt: string | null;
  actionRef: Record<string, any> | null;
}

function itemToCandidate(i: ReadinessItem): NbaCandidate {
  return {
    title: i.title,
    detail: i.detail,
    category: i.category,
    severity: i.severity,
    dueAt: i.dueAt,
    actionRef: i.actionRef,
  };
}

function byDueThenTitle(a: ReadinessItem, b: ReadinessItem): number {
  const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.title.localeCompare(b.title);
}

router.get("/trips/:tripId/next-best-action", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!(await isFlagEnabled(sc, READINESS_FLAG))) {
    sendError(res, "feature_disabled", "Trip readiness is not enabled");
    return;
  }

  const trip = await requireMembership(sc, res, tripId, user.id);
  if (!trip) return;

  const summary = await loadOrComputeSummary(sc, res, tripId, false);
  if (!summary) return;

  const proposals = await fetchPendingAutopilotProposals(sc, tripId);

  // Rank 1: critical readiness items, earliest due_at first.
  const critical = summary.items
    .filter((i) => i.severity === "critical")
    .sort(byDueThenTitle)
    .map(itemToCandidate);

  // Rank 2: pending autopilot proposals → "Review proposed fix: …".
  const proposalCandidates: NbaCandidate[] = proposals.map((p) => {
    const reason = String((p as any).reason ?? "an itinerary issue");
    const short = reason.length > 140 ? `${reason.slice(0, 137)}…` : reason;
    return {
      title: `Review proposed fix: ${short}`,
      detail: reason,
      category: "plan",
      severity: String((p as any).severity ?? "") === "high" ? "critical" : "normal",
      dueAt: null,
      actionRef: { kind: "autopilot_proposal", proposalId: (p as any).id ?? null },
    };
  });

  // Rank 3: non-critical action_needed. Rank 4: incomplete.
  const actionNeeded = summary.items
    .filter((i) => i.severity !== "critical" && i.status === "action_needed")
    .sort(byDueThenTitle)
    .map(itemToCandidate);
  const incomplete = summary.items
    .filter((i) => i.severity !== "critical" && i.status === "incomplete")
    .sort(byDueThenTitle)
    .map(itemToCandidate);

  const ranked = [...critical, ...proposalCandidates, ...actionNeeded, ...incomplete];

  if (ranked.length === 0) {
    res.json({
      primary: null,
      alternatives: [],
      message: "You're on track — nothing urgent.",
      computedAt: summary.computedAt,
    });
    return;
  }

  res.json({
    primary: ranked[0],
    alternatives: ranked.slice(1, 4),
    computedAt: summary.computedAt,
  });
}));

// ---------------------------------------------------------------------------
// GET /trips/:tripId/arrival-board  (membership only — no feature flag)
// ---------------------------------------------------------------------------
router.get("/trips/:tripId/arrival-board", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;
  const { tripId } = req.params;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const trip = await requireMembership(sc, res, tripId, user.id);
  if (!trip) return;

  // First destination by position (defensive — table may be empty/absent),
  // falling back to the trip's primary destination fields.
  const destinations = await safeSelect(sc, (c) =>
    c
      .from("trip_destinations")
      .select("city, country, arrival_date, position")
      .eq("trip_id", tripId)
      .order("position", { ascending: true }),
  );
  const firstDest = destinations[0] ?? null;
  const destination = firstDest
    ? { city: (firstDest as any).city ?? null, country: (firstDest as any).country ?? null }
    : (trip as any).destination_city
      ? { city: (trip as any).destination_city, country: (trip as any).destination_country ?? null }
      : null;

  const memberIds = await loadAcceptedMemberIds(sc, tripId, (trip as any).owner_id ?? null);
  if (memberIds === null) {
    // The board IS the crew. An unreadable membership would render a
    // flight-status board containing only the owner, which reads as "nobody
    // else has a flight" rather than "we could not look".
    sendError(res, "degraded_unavailable", "Could not read this trip's members");
    return;
  }

  // Resolve handles for all members in one query — used for profile navigation on the client.
  const profileRows = memberIds.length > 0
    ? await safeSelect(sc, (c) =>
        c.from("profiles").select("id, handle").in("id", memberIds),
      )
    : [];
  const handleMap = new Map<string, string | null>(
    profileRows.map((p) => [(p as any).id as string, (p as any).handle as string | null ?? null]),
  );

  // Flight reservations — defensive: the table may not exist yet.
  const flights = (
    await safeSelect(sc, (c) => c.from("trip_reservations").select("*").eq("trip_id", tripId))
  ).filter((r) => String((r as any).type ?? "") === "flight");

  const board = memberIds.map((uid) => {
    const own = flights.filter(
      (r) => (r as any).user_id === uid || (r as any).creator_id === uid,
    );
    let best: { timeMs: number; time: string; label: string | null } | null = null;
    for (const r of own) {
      // Flight arrival is the reservation's ends_at; starts_at is the fallback.
      const iso = ((r as any).ends_at ?? (r as any).starts_at) as string | null;
      if (!iso) continue;
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t)) continue;
      if (!best || t < best.timeMs) {
        best = { timeMs: t, time: new Date(t).toISOString(), label: (r as any).title ?? null };
      }
    }
    return {
      userId: uid,
      handle: handleMap.get(uid) ?? null,
      arrival: best ? { time: best.time, label: best.label } : null,
    };
  });

  // Honest note when the board is sparse instead of pretending it's complete.
  const sparse = board.length === 0 || board.some((b) => b.arrival === null);

  res.json({
    tripId,
    destination,
    board,
    note: sparse ? "Add flight reservations to populate the arrival board." : null,
  });
}));

export default router;
