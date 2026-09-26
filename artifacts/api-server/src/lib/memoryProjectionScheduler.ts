/**
 * Memory projection scheduler — the driver that makes the memory system run.
 *
 * Implements the memory spec's activation step (§22): on a cadence,
 *   1. project_all_memory()   — projects canonical facts + the Experience Graph
 *      (compass_graph_edges) into memory_events / memory_projections. Idempotent
 *      upsert, so cadence only affects freshness, never correctness.
 *   2. memory_sweep_expired()  — retention (§18): expired ephemeral/short-lived
 *      memory is deleted; other expired memory decays (intent §9 decays fast).
 *
 * Both are service_role-only SQL functions (2184/2186 projector, 2185 sweep) that
 * self-check the `memory_projection` flag. Gated here too (fail-closed): off ⇒ an
 * inert no-op that touches nothing. Follows the house scheduler shape
 * (see intelCoverageScheduler / intelProjectionScheduler): startup delay, then a
 * self-rescheduling timer, every error logged and swallowed so a bad pass can
 * never crash the server.
 *
 * ── S92: THE THIRD STEP, AND WHY IT IS NOT STEP 1 ────────────────────────────
 * Step 1 projects the Experience Graph (`compass_graph_edges`) into memory. An
 * EDGE cannot tell someone who went and loved a place from someone who decided
 * not to go: both interacted, so both get an edge, and a Memory projected from
 * one is a memory of an evening that did not happen. Sensing §5.4's bridge
 * carries the fact the edge is missing — the OUTCOME — so step 3 computes
 * memory eligibility from a closed `ExperienceSession`'s outcome instead
 * (`services/memoryProjections/experienceSessionBridge`).
 *
 * It reads through `lib/experienceSessionStore.readSessionById`, which is
 * bounded to ONE session id inside ONE session lifetime. That is deliberate and
 * it is the limit of this step: there is no enumeration of closed sessions
 * anywhere in the tree, because S54's read seam offers no list and no history
 * read ON PURPOSE — that absence is what makes the bridge not a tracking
 * history. So this step evaluates the sessions it is HANDED, and with none it
 * reports `sessionsConsidered: 0` rather than pretending to have swept anything.
 *
 * The WRITE does not happen here. The session-closing path
 * (`routes/experienceSessions.ts`, POST …/close) calls
 * `services/memoryProjections/sessionMemoryStore.persistSessionMemory` in the
 * same request, while the session is still readable: it runs this same gate and,
 * when the gate admits, writes the memory WITH the claim refs it was derived
 * from (3314's `memory_projections.claim_refs`), so the revocation reach and
 * erasure can find it later. Nothing is queued for this pass to pick up; this
 * step stays for a caller that holds session ids of its own, and it is gated by
 * the same `memory_projection` flag the store checks.
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { readSessionById } from "./experienceSessionStore.js";
import {
  sessionMemoryEligibility,
  type SessionBridgeRefusal,
} from "../services/memoryProjections/experienceSessionBridge.js";

const MEMORY_FLAG = "memory_projection";
const STARTUP_DELAY_MS = 5 * 60 * 1000;       // after intel projection (3m) so the graph it reads is fresh
const INTERVAL_MS = 6 * 60 * 60 * 1000;       // every 6h; the projection is idempotent, so cadence only affects freshness

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface MemoryProjectionResult {
  skipped: boolean;
  reason: "disabled" | "no_client" | "error" | null;
  projected: number;
  swept: number;
  /** S92 — how many closed sessions the outcome bridge judged this pass. */
  sessionsConsidered: number;
  /** Of those, how many the section-6 gate admitted as memory candidates. */
  sessionsEligible: number;
}

/** One session's trip through the bridge, for the pass log and for a test. */
export interface SessionBridgeOutcome {
  sessionId: string;
  ownerId: string;
  eligible: boolean;
  /** The gate's rejection reason, the bridge's refusal, or null when admitted. */
  reason: string | null;
}

/**
 * S92 — run the outcome bridge over the sessions this pass was handed.
 *
 * Every refusal is REPORTED rather than dropped: a session the bridge would not
 * speak for (still open, expired without an outcome) and one the gate refused
 * (`did_not_go` is PLANNED, `could_not_enter` proves no occurrence) are
 * different facts, and §28.11 forbids folding either into a plausible-looking
 * empty result.
 */
export async function runSessionMemoryBridge(
  db: any,
  sessions: ReadonlyArray<{ ownerId: string; sessionId: string }>,
  nowMs: number,
): Promise<SessionBridgeOutcome[]> {
  const out: SessionBridgeOutcome[] = [];
  for (const { ownerId, sessionId } of sessions) {
    const read = await readSessionById(db, ownerId, sessionId, nowMs);
    if (read.refusal !== null || read.session === null) {
      out.push({ sessionId, ownerId, eligible: false, reason: read.refusal ?? "session_not_found" });
      continue;
    }
    const verdict = sessionMemoryEligibility(ownerId, read.session.envelope, nowMs);
    out.push({
      sessionId,
      ownerId,
      eligible: verdict.eligible,
      reason: verdict.eligible
        ? null
        : ((verdict.refusal as SessionBridgeRefusal | null) ?? verdict.verdict?.reason ?? "refused"),
    });
  }
  return out;
}

export async function runMemoryProjectionPass(
  opts: { client?: any; sessions?: ReadonlyArray<{ ownerId: string; sessionId: string }>; nowMs?: number } = {},
): Promise<MemoryProjectionResult> {
  // Explicit null means "no client"; undefined means "use the service client"
  // (the house pattern — see intelCoverageScheduler).
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const empty: MemoryProjectionResult = {
    skipped: true, reason: null, projected: 0, swept: 0, sessionsConsidered: 0, sessionsEligible: 0,
  };
  if (!db) return { ...empty, reason: "no_client" };
  if (!(await isFlagEnabled(db, MEMORY_FLAG))) return { ...empty, reason: "disabled" };

  try {
    // project_all_memory fans out to project_user_memory_with_retraction, so each
    // pass both re-affirms supported memory and RETRACTS what lost its support
    // (a block landing after projection, an unfollow, an unsave, a removed
    // interest). Without the retraction half, derived memory would outlive the
    // relationship it was derived from.
    const { data: projData, error: projErr } = await db.rpc("project_all_memory", { p_enforce_flag: true });
    if (projErr) {
      logger.warn({ err: projErr }, "memory projection: project_all_memory failed");
      return { ...empty, reason: "error" };
    }
    const { data: sweepData, error: sweepErr } = await db.rpc("memory_sweep_expired", { p_enforce_flag: true });
    if (sweepErr) {
      logger.warn({ err: sweepErr }, "memory projection: memory_sweep_expired failed");
      return { ...empty, reason: "error" };
    }
    const projected = typeof projData === "number" ? projData : 0;
    const swept = typeof sweepData === "number" ? sweepData : 0;

    // S92 — step 3. Runs inside the same flag gate as the other two, so the
    // bridge cannot judge a session while memory projection is off.
    const sessions = opts.sessions ?? [];
    const bridged = sessions.length > 0
      ? await runSessionMemoryBridge(db, sessions, opts.nowMs ?? Date.now())
      : [];
    const sessionsEligible = bridged.filter((b) => b.eligible).length;

    if (projected > 0 || swept > 0 || bridged.length > 0) {
      logger.info(
        { projected, swept, sessionsConsidered: bridged.length, sessionsEligible },
        "memory projection pass complete",
      );
    }
    return {
      skipped: false, reason: null, projected, swept,
      sessionsConsidered: bridged.length, sessionsEligible,
    };
  } catch (err) {
    logger.warn({ err }, "memory projection pass threw");
    return { ...empty, reason: "error" };
  }
}

export function startMemoryProjectionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    { startupDelayMs: STARTUP_DELAY_MS, intervalMs: INTERVAL_MS, flag: MEMORY_FLAG },
    "MemoryProjectionScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void runMemoryProjectionPass()
      .catch((err) => logger.warn({ err }, "memory projection pass failed"))
      .finally(() => { _timer = setTimeout(tick, INTERVAL_MS); });
  }, STARTUP_DELAY_MS);
}

export function stopMemoryProjectionScheduler(): void {
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
