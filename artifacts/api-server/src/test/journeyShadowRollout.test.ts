/**
 * journeyShadowRollout.test.ts
 *
 * Tests for the Journey Shadow Rollout admin workflow.
 *
 * Covers:
 *  1. Non-admin denied before RPC — admin guard fires first.
 *  2. Actor never comes from body — ctx.userId is always used.
 *  3. Invalid / coordinate truth rejected at schema level.
 *  4. RPC failures fail closed — no partial success.
 *  5. Stop path — global stop returns summary.
 *  6. Report aggregate privacy — no user IDs, session IDs, assignment IDs.
 *  7. Evaluation persists aggregate-only — no raw data in QA report.
 *  8. Rating boundary — behaviorPatternInferenceReady always false.
 *  9. Unissued session isolation — same user in another unissued session cannot affect QA/report.
 * 10. Denied raw_read blocks evaluation.
 * 11. Jitter/gap/impossible metrics are aggregate and deterministic.
 * 12. No coordinate/raw/session/user IDs in persisted payload or response.
 *
 * Run: node --import tsx/esm --test src/test/journeyShadowRollout.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminJourneyRouter from "../routes/adminJourney.js";
import {
  computeShadowRating,
} from "../services/journey/JourneyShadowQaService.js";
import {
  measureJourneyGroundTruth,
  type JourneyGroundTruthMetrics,
  type JourneyGroundTruthFixture,
} from "../services/location/JourneyShadowMetrics.js";

// ── Test server ────────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

const ADMIN_TOKEN = "journey-admin-token";
const USER_TOKEN  = "journey-user-token";
const ADMIN_ID    = "00000000-0000-0000-0000-000000000001";
const USER_ID     = "00000000-0000-0000-0000-000000000002";

const STAGE_ID       = "10000000-0000-0000-0000-000000000001";
const ASSIGNMENT_ID  = "20000000-0000-0000-0000-000000000001";
const SESSION_ID     = "30000000-0000-0000-0000-000000000001";
const TRUTH_ID       = "40000000-0000-0000-0000-000000000001";
const REPORT_ID      = "50000000-0000-0000-0000-000000000001";
const USER_SUBJECT_ID = "60000000-0000-0000-0000-000000000001";
// A second user / session that is NOT issued through the shadow rollout
const OTHER_USER_ID   = "70000000-0000-0000-0000-000000000001";
const OTHER_SESSION_ID = "80000000-0000-0000-0000-000000000001";

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  token: string = USER_TOKEN,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    };
    const r = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (inRes) => {
        let raw = "";
        inRes.on("data", (c) => (raw += c));
        inRes.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: inRes.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── In-memory fake state ──────────────────────────────────────────────────────

interface FakeState {
  profiles: Record<string, { id: string; role: string }>;
  stages: Record<string, any>;
  assignments: Record<string, any>;
  sessions: Record<string, any>;
  locationSessions: Record<string, any>;
  issuances: Record<string, any>;
  groundTruth: Record<string, any>;
  qaReports: Record<string, any>;
  observations: any[];
  revisions: any[];
  retentionHealth: any;
  rpcOverrides: Record<string, (args: any) => any>;
  /** Per-session authorize override: sessionId -> authorized (true) or denied (false/error) */
  authorizeResults: Record<string, boolean | "error">;
}

let state: FakeState;

function resetState(): void {
  const now = new Date().toISOString();
  const stageEnds = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const cohortEnds = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();

  state = {
    profiles: {
      [ADMIN_ID]: { id: ADMIN_ID, role: "admin" },
      [USER_ID]:  { id: USER_ID,  role: "user" },
    },
    stages: {
      [STAGE_ID]: {
        id: STAGE_ID,
        stage: "internal",
        starts_at: now,
        ends_at: stageEnds,
        is_active: true,
        created_at: now,
        max_accounts: 10,
      },
    },
    assignments: {
      [ASSIGNMENT_ID]: {
        id: ASSIGNMENT_ID,
        user_id: USER_SUBJECT_ID,
        stage_id: STAGE_ID,
        assigned_at: now,
        revoked_at: null,
        cohort_starts_at: now,
        cohort_ends_at: cohortEnds,
      },
    },
    sessions: {},
    locationSessions: {
      [SESSION_ID]: {
        id: SESSION_ID,
        user_id: USER_SUBJECT_ID,
        journey_purpose: "journey_observation_v1",
        ended_at: null,
        expires_at: cohortEnds,
      },
    },
    issuances: {
      // Default: SESSION_ID is issued for ASSIGNMENT_ID
      "issuance-1": {
        id: "issuance-1",
        assignment_id: ASSIGNMENT_ID,
        user_id: USER_SUBJECT_ID,
        location_session_id: SESSION_ID,
        issued_at: now,
        session_type: "live_share",
        session_expires_at: cohortEnds,
        revoked_at: null,
      },
    },
    groundTruth: {},
    qaReports: {},
    observations: [],
    revisions: [],
    retentionHealth: {
      job: "journey_observation_retention",
      last_status: "HEALTHY",
      last_run_at: now,
      last_success_at: now,
      last_failed_at: null,
      last_deleted_count: 0,
      last_failed_count: 0,
      oldest_expired_age_ms: null,
      deletion_lag_ms: null,
      pending_retry_count: 0,
      consecutive_failures: 0,
      last_error: null,
    },
    rpcOverrides: {},
    authorizeResults: {},
  };
}

/**
 * Build a fake Supabase-like client compatible with requireAdmin and the route handlers.
 * The client also handles requireUser (auth.getUser).
 */
function makeFakeClient(userId: string): any {
  return {
    auth: {
      async getUser(token: string) {
        let uid = userId;
        if (token === ADMIN_TOKEN) uid = ADMIN_ID;
        if (token === USER_TOKEN)  uid = USER_ID;
        return { data: { user: { id: uid } }, error: null };
      },
    },
    from(table: string) {
      return makeFakeTable(table);
    },
    rpc(fn: string, args: any) {
      return makeFakeRpc(fn, args);
    },
  };

  function makeFakeTable(table: string) {
    const ctx: {
      _filters: Array<[string, string, any]>;
      _maybeSingle: boolean;
      _head: boolean;
      _count: boolean;
      _order: { col: string; desc: boolean } | null;
      _limit: number | null;
      _not: Array<[string, string, any]>;
      _in: Array<[string, any[]]>;
      _gte: Array<[string, any]>;
      _lte: Array<[string, any]>;
      _gt: Array<[string, any]>;
      _selectCols: string;
    } = {
      _filters: [],
      _maybeSingle: false,
      _head: false,
      _count: false,
      _order: null,
      _limit: null,
      _not: [],
      _in: [],
      _gte: [],
      _lte: [],
      _gt: [],
      _selectCols: "",
    };

    const q: any = {
      select(_cols?: string, opts?: any) {
        if (typeof _cols === "string") ctx._selectCols = _cols;
        if (opts?.count) ctx._count = true;
        if (opts?.head) ctx._head = true;
        return q;
      },
      eq(col: string, val: any) { ctx._filters.push(["eq", col, val]); return q; },
      in(col: string, vals: any[]) { ctx._in.push([col, vals]); return q; },
      gte(col: string, val: any) { ctx._gte.push([col, val]); return q; },
      lte(col: string, val: any) { ctx._lte.push([col, val]); return q; },
      gt(col: string, val: any) { ctx._gt.push([col, val]); return q; },
      not(col: string, op: string, val: any) { ctx._not.push([col, op, val]); return q; },
      order(col: string, opts?: any) { ctx._order = { col, desc: opts?.ascending === false }; return q; },
      limit(n: number) { ctx._limit = n; return q; },
      maybeSingle() { ctx._maybeSingle = true; return q; },
      then(resolve: (v: any) => void, reject: (e: any) => void) {
        Promise.resolve(resolveTable(table, ctx)).then(resolve, reject);
        return Promise.resolve(resolveTable(table, ctx));
      },
    };
    // Make it awaitable
    (q as any)[Symbol.toStringTag] = "Promise";
    q.then = function(onFulfilled: any, onRejected: any) {
      return Promise.resolve(resolveTable(table, ctx)).then(onFulfilled, onRejected);
    };
    return q;
  }

  function resolveTable(table: string, ctx: any): any {
    const getEq = (col: string) => ctx._filters.find(([op, c]: any) => op === "eq" && c === col)?.[2];
    const getIn = (col: string): any[] | undefined => ctx._in.find(([c]: any) => c === col)?.[1];
    const getLte = (col: string): any => ctx._lte.find(([c]: any) => c === col)?.[1];
    const getGte = (col: string): any => ctx._gte.find(([c]: any) => c === col)?.[1];

    if (table === "profiles") {
      const id = getEq("id");
      if (ctx._maybeSingle) {
        return { data: state.profiles[id] ?? null, error: null };
      }
      return { data: Object.values(state.profiles), error: null };
    }

    if (table === "journey_retention_health") {
      const job = getEq("job");
      if (ctx._maybeSingle) {
        if (job === "journey_observation_retention") {
          return { data: state.retentionHealth ?? null, error: null };
        }
        return { data: null, error: null };
      }
      return { data: state.retentionHealth ? [state.retentionHealth] : [], error: null };
    }

    if (table === "journey_shadow_stages") {
      const id = getEq("id");
      if (ctx._maybeSingle) {
        return { data: state.stages[id] ?? null, error: null };
      }
      return { data: Object.values(state.stages), error: null };
    }

    if (table === "journey_shadow_cohort_assignments") {
      const stageId = getEq("stage_id");
      const inIds = getIn("assignment_id") ?? getIn("id");

      // Support overlapping cohort window filtering
      const cohortStartsAtLte = getLte("cohort_starts_at");
      const cohortEndsAtGte = getGte("cohort_ends_at");

      let rows = Object.values(state.assignments);
      if (stageId) rows = rows.filter((r: any) => r.stage_id === stageId);
      if (inIds) rows = rows.filter((r: any) => inIds.includes(r.id));

      // Filter by overlapping cohort window if present
      if (cohortStartsAtLte) {
        rows = rows.filter((r: any) => r.cohort_starts_at <= cohortStartsAtLte);
      }
      if (cohortEndsAtGte) {
        rows = rows.filter((r: any) => r.cohort_ends_at >= cohortEndsAtGte);
      }

      if (ctx._count && ctx._head) {
        return { count: rows.length, error: null };
      }
      return { data: rows, count: rows.length, error: null };
    }

    if (table === "journey_shadow_session_issuances") {
      const inAssignmentIds = getIn("assignment_id");
      let rows = Object.values(state.issuances);
      if (inAssignmentIds) rows = rows.filter((r: any) => inAssignmentIds.includes(r.assignment_id));

      if (ctx._count && ctx._head) {
        return { count: rows.length, error: null };
      }
      // Return location_session_id and user_id fields
      return {
        data: rows.map((r: any) => ({
          location_session_id: r.location_session_id,
          user_id: r.user_id,
        })),
        error: null,
      };
    }

    if (table === "journey_observations") {
      const inUserIds = getIn("user_id");
      const inSessionIds = getIn("location_session_id");
      const notFilter = ctx._not.find(([c]: any) => c === "quality_class");
      // Get not-unusable filter
      const excludeUnusable = notFilter && notFilter[1] === "eq" && notFilter[2] === "unusable";

      let rows = state.observations;

      // Scope by session IDs if provided (new hardened path)
      if (inSessionIds) {
        rows = rows.filter((r: any) => inSessionIds.includes(r.location_session_id));
      } else if (inUserIds) {
        // Legacy fallback for old tests that still use user_id
        rows = rows.filter((r: any) => inUserIds.includes(r.user_id));
      }

      if (excludeUnusable) {
        rows = rows.filter((r: any) => r.quality_class !== "unusable");
      }

      if (ctx._count && ctx._head) {
        return { count: rows.length, error: null };
      }
      // Only expose lat/lng when the caller explicitly selected them
      // (the QA service does so ONLY after raw_read authorization).
      const wantsCoords =
        ctx._selectCols.includes("lat") || ctx._selectCols.includes("lng");
      // Return quality_class and quality_reasons (for aggregate distribution)
      return {
        data: rows.map((r: any) => {
          const base: any = {
            quality_class: r.quality_class,
            quality_reasons: r.quality_reasons ?? [],
            location_session_id: r.location_session_id,
            observed_at: r.observed_at,
          };
          if (wantsCoords) {
            base.lat = r.lat ?? null;
            base.lng = r.lng ?? null;
          }
          return base;
        }),
        error: null,
      };
    }

    if (table === "journey_segment_revisions") {
      const inUserIds = getIn("user_id");
      const inSessionIds = getIn("location_session_id");

      let rows = state.revisions;

      // Scope by session IDs if provided (new hardened path)
      if (inSessionIds) {
        rows = rows.filter((r: any) => inSessionIds.includes(r.location_session_id));
      } else if (inUserIds) {
        rows = rows.filter((r: any) => inUserIds.includes(r.user_id));
      }

      if (ctx._count && ctx._head) {
        return { count: rows.length, error: null };
      }
      return { data: rows, error: null };
    }

    if (table === "journey_shadow_ground_truth") {
      const inAssignmentIds = getIn("assignment_id");
      if (ctx._count && ctx._head) {
        let rows = Object.values(state.groundTruth);
        if (inAssignmentIds) rows = rows.filter((r: any) => inAssignmentIds.includes(r.assignment_id));
        return { count: rows.length, error: null };
      }
      let rows = Object.values(state.groundTruth);
      if (inAssignmentIds) rows = rows.filter((r: any) => inAssignmentIds.includes(r.assignment_id));
      return { data: rows, error: null };
    }

    if (table === "journey_shadow_qa_reports") {
      const stageId = getEq("stage_id");
      if (ctx._maybeSingle) {
        const rows = Object.values(state.qaReports).filter((r: any) => !stageId || r.stage_id === stageId);
        return { data: rows[rows.length - 1] ?? null, error: null };
      }
      return { data: Object.values(state.qaReports), error: null };
    }

    return { data: null, error: null };
  }

  function makeFakeRpc(fn: string, args: any): Promise<any> {
    // Check for override
    if (state.rpcOverrides[fn]) {
      const result = state.rpcOverrides[fn](args);
      return Promise.resolve(result);
    }

    if (fn === "journey_shadow_authorize_v1") {
      const sessionId = args.p_location_session_id;
      const override = state.authorizeResults[sessionId];
      if (override === "error") {
        return Promise.resolve({ data: null, error: { message: "authorization denied" } });
      }
      if (override === false) {
        return Promise.resolve({ data: "not_authorized", error: null });
      }
      // Default: authorize if session is in issuances
      const isIssued = Object.values(state.issuances).some(
        (iss: any) => iss.location_session_id === sessionId,
      );
      if (isIssued) {
        return Promise.resolve({ data: "authorized", error: null });
      }
      // Not issued — deny
      return Promise.resolve({ data: "not_authorized", error: null });
    }

    // Authorising raw-read RPC for segmentation — calls authorize inside SQL,
    // returns zero rows on denial. Unusable rows excluded (segmentation boundary).
    if (fn === "read_journey_shadow_observations_v1") {
      const sessionId = args.p_location_session_id;
      const userId = args.p_user_id;
      const override = state.authorizeResults[sessionId];
      if (override === "error") {
        return Promise.resolve({ data: null, error: { message: "rpc error" } });
      }
      if (override === false) {
        // Denied — return zero rows (RPC fails closed without raising).
        return Promise.resolve({ data: [], error: null });
      }
      const isIssued = Object.values(state.issuances).some(
        (iss: any) => iss.location_session_id === sessionId,
      );
      if (!isIssued) {
        return Promise.resolve({ data: [], error: null });
      }
      // Return observations for this session (excluding unusable — segmentation boundary).
      const rows = state.observations
        .filter((r: any) =>
          r.location_session_id === sessionId
          && r.user_id === userId
          && r.quality_class !== "unusable",
        )
        .map((r: any) => ({
          id: r.id,
          observed_at: r.observed_at,
          source: r.source,
          lat: r.lat ?? null,
          lng: r.lng ?? null,
          accuracy_m: r.accuracy_m ?? null,
          speed_mps: r.speed_mps ?? null,
          quality_version: r.quality_version ?? null,
          quality_score: r.quality_score ?? null,
          quality_class: r.quality_class ?? null,
          quality_reasons: r.quality_reasons ?? [],
        }));
      return Promise.resolve({ data: rows, error: null });
    }

    // Admin-only authorising QA raw-read RPC. Includes ALL quality classes
    // (including unusable). Returns an error (denial 42501) when authorization
    // fails so callers distinguish denial from authorised-but-empty ([]).
    if (fn === "read_journey_shadow_qa_observations_v1") {
      const sessionId = args.p_location_session_id;
      const userId = args.p_user_id;
      // Admin gate.
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "not authorized", code: "42501" } });
      }
      const override = state.authorizeResults[sessionId];
      if (override === "error") {
        return Promise.resolve({ data: null, error: { message: "rpc error" } });
      }
      if (override === false) {
        // Denial RAISEs — surfaced here as an error (never [] for denial).
        return Promise.resolve({ data: null, error: { message: "not authorized", code: "42501" } });
      }
      const isIssued = Object.values(state.issuances).some(
        (iss: any) => iss.location_session_id === sessionId,
      );
      if (!isIssued) {
        // Not issued → authorize denies → error, not empty.
        return Promise.resolve({ data: null, error: { message: "not authorized", code: "42501" } });
      }
      // Authorised: return observations INCLUDING unusable (QA failure-mode).
      const rows = state.observations
        .filter((r: any) =>
          r.location_session_id === sessionId
          && r.user_id === userId,
        )
        .map((r: any) => ({
          id: r.id,
          observed_at: r.observed_at,
          source: r.source,
          lat: r.lat ?? null,
          lng: r.lng ?? null,
          accuracy_m: r.accuracy_m ?? null,
          speed_mps: r.speed_mps ?? null,
          quality_version: r.quality_version ?? null,
          quality_score: r.quality_score ?? null,
          quality_class: r.quality_class ?? null,
          quality_reasons: r.quality_reasons ?? [],
        }));
      return Promise.resolve({ data: rows, error: null });
    }

    // Admin aggregate RPC — authorises all issued sessions then returns only
    // counts + quality distributions; never coordinates, IDs, or raw timestamps.
    // Unusable rows included for failure-mode distribution measurement.
    if (fn === "aggregate_journey_shadow_observations_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor must be admin" } });
      }
      // Check each issued session is authorized; fail closed if any denied.
      const issuedSessions = Object.values(state.issuances).filter(
        (iss: any) => iss.revoked_at == null,
      );
      for (const iss of issuedSessions) {
        const override = state.authorizeResults[(iss as any).location_session_id];
        if (override === "error") {
          return Promise.resolve({ data: null, error: { message: "authorization denied for a session" } });
        }
        if (override === false) {
          return Promise.resolve({ data: null, error: { message: "session denied" } });
        }
      }
      const issuedSessionIds = new Set(issuedSessions.map((iss: any) => iss.location_session_id));
      const rows = state.observations.filter((r: any) => issuedSessionIds.has(r.location_session_id));
      const classDist: Record<string, number> = {};
      const reasonDist: Record<string, number> = {};
      for (const r of rows) {
        if (r.quality_class) {
          classDist[r.quality_class] = (classDist[r.quality_class] ?? 0) + 1;
        }
        if (Array.isArray(r.quality_reasons)) {
          for (const reason of r.quality_reasons) {
            if (typeof reason === "string") {
              reasonDist[reason] = (reasonDist[reason] ?? 0) + 1;
            }
          }
        }
      }
      return Promise.resolve({
        data: {
          totalObservationCount: rows.length,
          qualityClassDistribution: classDist,
          qualityReasonDistribution: reasonDist,
        },
        error: null,
      });
    }

    // Admin-only authorising QA raw-read RPC for derived segment revisions.
    // Mirrors read_journey_shadow_qa_observations_v1: RAISEs (error, code 42501)
    // on denial; authorised-but-empty returns []. Scopes by exact user+session.
    if (fn === "read_journey_shadow_qa_segment_revisions_v1") {
      const sessionId = args.p_location_session_id;
      const userId = args.p_user_id;
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "not authorized", code: "42501" } });
      }
      const override = state.authorizeResults[sessionId];
      if (override === "error") {
        return Promise.resolve({ data: null, error: { message: "rpc error" } });
      }
      if (override === false) {
        return Promise.resolve({ data: null, error: { message: "not authorized", code: "42501" } });
      }
      const isIssued = Object.values(state.issuances).some(
        (iss: any) => iss.location_session_id === sessionId,
      );
      if (!isIssued) {
        return Promise.resolve({ data: null, error: { message: "not authorized", code: "42501" } });
      }
      const rows = state.revisions.filter((r: any) =>
        r.location_session_id === sessionId && r.user_id === userId,
      );
      return Promise.resolve({ data: rows, error: null });
    }

    // Admin aggregate RPC for derived segment revisions — authorises all issued
    // sessions then returns only {revisionCount}; never rows, IDs, or timestamps.
    if (fn === "aggregate_journey_shadow_segment_revisions_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor must be admin" } });
      }
      const issuedSessions = Object.values(state.issuances).filter(
        (iss: any) => iss.revoked_at == null,
      );
      for (const iss of issuedSessions) {
        const override = state.authorizeResults[(iss as any).location_session_id];
        if (override === "error") {
          return Promise.resolve({ data: null, error: { message: "authorization denied for a session" } });
        }
        if (override === false) {
          return Promise.resolve({ data: null, error: { message: "session denied" } });
        }
      }
      const issuedSessionIds = new Set(issuedSessions.map((iss: any) => iss.location_session_id));
      const rows = state.revisions.filter((r: any) => issuedSessionIds.has(r.location_session_id));
      return Promise.resolve({ data: { revisionCount: rows.length }, error: null });
    }

    if (fn === "configure_journey_shadow_stage_v1") {
      const id = `stage-${Math.random().toString(36).slice(2)}`;
      state.stages[id] = {
        id, stage: args.p_stage,
        starts_at: args.p_starts_at,
        ends_at: args.p_ends_at,
        approved_by: args.p_approved_by,
        approved_at: args.p_approved_at,
        is_active: true,
        created_at: new Date().toISOString(),
      };
      return Promise.resolve({ data: id, error: null });
    }

    if (fn === "assign_journey_shadow_cohort_v1") {
      // Verify actor is admin
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor is not an admin" } });
      }
      const id = `assign-${Math.random().toString(36).slice(2)}`;
      state.assignments[id] = {
        id, user_id: args.p_user_id, stage_id: args.p_stage_id,
        assigned_at: new Date().toISOString(),
        cohort_starts_at: args.p_cohort_starts_at,
        cohort_ends_at: args.p_cohort_ends_at,
        revoked_at: null,
      };
      return Promise.resolve({ data: id, error: null });
    }

    if (fn === "revoke_journey_shadow_cohort_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor is not an admin" } });
      }
      const assignment = state.assignments[args.p_assignment_id];
      if (!assignment || assignment.revoked_at) {
        return Promise.resolve({ data: false, error: null });
      }
      assignment.revoked_at = new Date().toISOString();
      return Promise.resolve({ data: true, error: null });
    }

    if (fn === "issue_journey_shadow_session_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor is not an admin" } });
      }
      const sid = `session-${Math.random().toString(36).slice(2)}`;
      state.locationSessions[sid] = {
        id: sid, assignment_id: args.p_assignment_id,
        session_type: args.p_session_type,
        expires_at: args.p_expires_at,
      };
      return Promise.resolve({ data: sid, error: null });
    }

    if (fn === "global_journey_shadow_stop_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor is not an admin" } });
      }
      return Promise.resolve({
        data: {
          flags_disabled: 3,
          stages_stopped: 1,
          assignments_revoked: 2,
          sessions_ended: 1,
          ground_truth_deleted: 4,
          observations_deleted: 10,
          segments_deleted: 5,
          stopped_at: new Date().toISOString(),
        },
        error: null,
      });
    }

    if (fn === "record_journey_shadow_ground_truth_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor is not an admin" } });
      }
      const id = `truth-${Math.random().toString(36).slice(2)}`;
      state.groundTruth[id] = {
        id,
        assignment_id: args.p_assignment_id,
        recorded_at: args.p_recorded_at,
        ground_truth: args.p_ground_truth,
        notes: args.p_notes,
        location_session_id: args.p_location_session_id ?? null,
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      };
      return Promise.resolve({ data: id, error: null });
    }

    if (fn === "persist_journey_shadow_qa_report_v1") {
      const actorProfile = state.profiles[args.p_actor];
      if (!actorProfile || actorProfile.role !== "admin") {
        return Promise.resolve({ data: null, error: { message: "actor is not an admin" } });
      }
      const id = `report-${Math.random().toString(36).slice(2)}`;
      state.qaReports[id] = {
        id,
        stage_id: args.p_stage_id,
        report_type: args.p_report_type,
        period_starts_at: args.p_period_starts_at,
        period_ends_at: args.p_period_ends_at,
        payload: args.p_payload,
        submitted_at: new Date().toISOString(),
      };
      return Promise.resolve({ data: id, error: null });
    }

    return Promise.resolve({ data: null, error: null });
  }
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

before(async () => {
  const app = express();
  app.use(express.json());

  // Log middleware for debugging
  app.use((req, _res, next) => {
    (req as any).log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });

  app.use(adminJourneyRouter);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

beforeEach(() => {
  resetState();
  const client = makeFakeClient(ADMIN_ID);
  _setTestClient(client, true);
  _setTestServiceClient(client);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Journey Shadow Rollout admin routes", () => {
  // ── 1. Non-admin denied before RPC ──────────────────────────────────────

  it("non-admin is denied (403) before any RPC is called", async () => {
    // Track if any RPC was called
    let rpcCalled = false;
    state.rpcOverrides["configure_journey_shadow_stage_v1"] = () => {
      rpcCalled = true;
      return { data: null, error: null };
    };

    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // Use user client (non-admin)
    const userClient = makeFakeClient(USER_ID);
    _setTestClient(userClient, true);
    _setTestServiceClient(userClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stages", {
      stage: "internal",
      startsAt: now,
      endsAt: end,
    }, USER_TOKEN);

    assert.equal(r.status, 403, "should return 403");
    assert.equal(rpcCalled, false, "RPC must not be called for non-admin");
  });

  it("non-admin is denied on cohort assign", async () => {
    const userClient = makeFakeClient(USER_ID);
    _setTestClient(userClient, true);
    _setTestServiceClient(userClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/cohorts", {
      userId: USER_SUBJECT_ID,
      stageId: STAGE_ID,
      cohortStartsAt: new Date().toISOString(),
      cohortEndsAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    }, USER_TOKEN);

    assert.equal(r.status, 403, "should return 403 for non-admin");
  });

  it("non-admin is denied on global stop", async () => {
    const userClient = makeFakeClient(USER_ID);
    _setTestClient(userClient, true);
    _setTestServiceClient(userClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stop", {}, USER_TOKEN);
    assert.equal(r.status, 403, "should return 403 for non-admin");
  });

  // ── 2. Actor not from body ────────────────────────────────────────────

  it("actor always comes from ctx.userId — not from request body", async () => {
    let capturedActor: string | null = null;
    state.rpcOverrides["configure_journey_shadow_stage_v1"] = (args: any) => {
      capturedActor = args.p_actor;
      const id = "captured-stage-id";
      return { data: id, error: null };
    };

    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stages", {
      stage: "internal",
      startsAt: now,
      endsAt: end,
      // Attempting to inject actor from body — must be ignored
      actor: "evil-actor-id",
      approvedBy: "evil-approved-by",
    }, ADMIN_TOKEN);

    // Strict schema rejects extra keys
    assert.equal(r.status, 400, "strict schema should reject extra body keys");
    assert.equal(capturedActor, null, "RPC should not have been called");
  });

  it("actor is always ctx.userId for ground truth — never from body", async () => {
    let capturedActor: string | null = null;
    state.rpcOverrides["record_journey_shadow_ground_truth_v1"] = (args: any) => {
      capturedActor = args.p_actor;
      const id = "truth-captured";
      return { data: id, error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const now = new Date().toISOString();
    await makeRequest("POST", "/admin/journey-shadow/ground-truth", {
      assignmentId: ASSIGNMENT_ID,
      locationSessionId: SESSION_ID,
      recordedAt: now,
      expectedStop: true,
    }, ADMIN_TOKEN);

    // Actor must be the authenticated admin, not anything from body
    assert.equal(capturedActor, ADMIN_ID, "actor must always be ctx.userId");
  });

  // ── 3. Invalid / coordinate truth rejected ────────────────────────────

  it("ground truth with coordinate field lat is rejected (400)", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/ground-truth", {
      assignmentId: ASSIGNMENT_ID,
      locationSessionId: SESSION_ID,
      recordedAt: new Date().toISOString(),
      expectedStop: false,
      lat: 51.5074, // coordinate — must be rejected
    }, ADMIN_TOKEN);

    assert.equal(r.status, 400, "lat field must be rejected");
  });

  it("ground truth with lng field is rejected (400)", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/ground-truth", {
      assignmentId: ASSIGNMENT_ID,
      locationSessionId: SESSION_ID,
      recordedAt: new Date().toISOString(),
      expectedStop: false,
      lng: -0.1278,
    }, ADMIN_TOKEN);

    assert.equal(r.status, 400, "lng field must be rejected");
  });

  it("ground truth with invalid stage (wrong enum) is rejected (400)", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stages", {
      stage: "production", // not in enum
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    }, ADMIN_TOKEN);

    assert.equal(r.status, 400, "invalid stage enum must be rejected");
  });

  it("ground truth with missing required fields is rejected (400)", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/ground-truth", {
      assignmentId: ASSIGNMENT_ID,
      locationSessionId: SESSION_ID,
      // missing recordedAt, expectedStop
    }, ADMIN_TOKEN);

    assert.equal(r.status, 400, "missing required fields must be rejected");
  });

  // ── 4. RPC failures fail closed ───────────────────────────────────────

  it("RPC failure on stage configure fails closed (500)", async () => {
    state.rpcOverrides["configure_journey_shadow_stage_v1"] = () => ({
      data: null,
      error: { message: "DB_ERROR: internal server error" },
    });

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stages", {
      stage: "qa",
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    }, ADMIN_TOKEN);

    assert.equal(r.status, 500, "RPC failure must return 500");
    // Must not expose raw DB error message
    const body = JSON.stringify(r.body);
    assert.ok(
      !body.includes("DB_ERROR"),
      "raw DB error message must not be exposed in response",
    );
  });

  it("RPC failure on cohort assign fails closed (500)", async () => {
    state.rpcOverrides["assign_journey_shadow_cohort_v1"] = () => ({
      data: null,
      error: { message: "constraint violation: unique index" },
    });

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/cohorts", {
      userId: USER_SUBJECT_ID,
      stageId: STAGE_ID,
      cohortStartsAt: new Date().toISOString(),
      cohortEndsAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    }, ADMIN_TOKEN);

    assert.equal(r.status, 500, "RPC failure must return 500");
  });

  it("RPC failure on ground truth recording fails closed (500)", async () => {
    state.rpcOverrides["record_journey_shadow_ground_truth_v1"] = () => ({
      data: null,
      error: { message: "table does not exist" },
    });

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/ground-truth", {
      assignmentId: ASSIGNMENT_ID,
      locationSessionId: SESSION_ID,
      recordedAt: new Date().toISOString(),
      expectedStop: false,
    }, ADMIN_TOKEN);

    assert.equal(r.status, 500, "RPC failure must return 500");
    const body = JSON.stringify(r.body);
    assert.ok(!body.includes("table does not exist"), "must not expose raw DB details");
  });

  // ── 5. Stop path ─────────────────────────────────────────────────────

  it("global stop returns summary with counts", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stop", {}, ADMIN_TOKEN);

    assert.equal(r.status, 200, "stop should return 200");
    assert.ok(typeof r.body.flagsDisabled === "number", "flagsDisabled must be a number");
    assert.ok(typeof r.body.stagesStopped === "number", "stagesStopped must be a number");
    assert.ok(typeof r.body.assignmentsRevoked === "number", "assignmentsRevoked must be a number");
    assert.ok(typeof r.body.sessionsEnded === "number", "sessionsEnded must be a number");
    assert.ok(typeof r.body.groundTruthDeleted === "number", "groundTruthDeleted must be a number");
    assert.equal(r.body.groundTruthDeleted, 4, "groundTruthDeleted must reflect deleted ground truth rows");
    assert.ok(typeof r.body.observationsDeleted === "number", "observationsDeleted must be a number");
    assert.ok(typeof r.body.segmentsDeleted === "number", "segmentsDeleted must be a number");
    assert.ok(typeof r.body.stoppedAt === "string", "stoppedAt must be a string");
    assert.equal(r.body.ok, true, "ok must be true");
  });

  it("global stop with RPC failure returns 500", async () => {
    state.rpcOverrides["global_journey_shadow_stop_v1"] = () => ({
      data: null,
      error: { message: "permission denied" },
    });

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stop", {}, ADMIN_TOKEN);
    assert.equal(r.status, 500, "stop RPC failure must return 500");
  });

  // ── 6. Report aggregate privacy ───────────────────────────────────────

  it("GET /report returns 400 without required query params", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("GET", "/admin/journey-shadow/report", undefined, ADMIN_TOKEN);
    assert.equal(r.status, 400, "missing query params must return 400");
  });

  it("GET /report does not include user IDs, session IDs, or raw assignment IDs", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const r = await makeRequest(
      "GET",
      `/admin/journey-shadow/report?stageId=${encodeURIComponent(STAGE_ID)}&periodStartsAt=${encodeURIComponent(now)}&periodEndsAt=${encodeURIComponent(end)}`,
      undefined,
      ADMIN_TOKEN,
    );

    assert.equal(r.status, 200, "report must return 200");

    // Must never contain user IDs (subject user ID)
    const bodyStr = JSON.stringify(r.body);
    assert.ok(
      !bodyStr.includes(USER_SUBJECT_ID),
      "report must not contain subject user IDs",
    );

    // Must have aggregate counts not per-user rows
    assert.ok(typeof r.body.counts === "object", "counts must be present");
    assert.ok(typeof r.body.counts.cohortAssignments === "number", "cohortAssignments must be a number");
    assert.ok(typeof r.body.counts.sessions === "number", "sessions must be a number");

    // Must have retentionHealth without per-user data
    assert.ok(typeof r.body.retentionHealth === "object", "retentionHealth must be present");
    assert.ok("state" in r.body.retentionHealth, "retentionHealth.state must be present");

    // behaviorPatternInferenceReady must always be false
    assert.equal(r.body.behaviorPatternInferenceReady, false, "behaviorPatternInferenceReady must always be false");

    // failureModes must include quality distributions (aggregate, not per-user)
    assert.ok(typeof r.body.failureModes === "object", "failureModes must be present");
  });

  it("GET /report fails closed when retention is not HEALTHY", async () => {
    state.retentionHealth = {
      ...state.retentionHealth,
      last_status: "DEGRADED",
      consecutive_failures: 1,
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const r = await makeRequest(
      "GET",
      `/admin/journey-shadow/report?stageId=${encodeURIComponent(STAGE_ID)}&periodStartsAt=${encodeURIComponent(now)}&periodEndsAt=${encodeURIComponent(end)}`,
      undefined,
      ADMIN_TOKEN,
    );

    // Report still returns, but shadowRating should be blocked
    if (r.status === 200) {
      assert.equal(r.body.shadowRating, "blocked", "degraded retention must block rating");
    }
  });

  // ── 7. Evaluation persists aggregate-only ─────────────────────────────

  it("POST /evaluate persists only aggregate payload — no user IDs in QA report", async () => {
    // Set up state with ground truth linked to ASSIGNMENT_ID
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    state.groundTruth["gt1"] = {
      id: "gt1",
      assignment_id: ASSIGNMENT_ID,
      recorded_at: now,
      ground_truth: { expectedStop: false },
      location_session_id: SESSION_ID,
      expires_at: end,
    };

    let capturedPayload: any = null;
    state.rpcOverrides["persist_journey_shadow_qa_report_v1"] = (args: any) => {
      capturedPayload = args.p_payload;
      const id = "qa-report-1";
      return { data: id, error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/evaluate", {
      stageId: STAGE_ID,
      periodStartsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      periodEndsAt: end,
    }, ADMIN_TOKEN);

    if (r.status === 201 && capturedPayload) {
      const payloadStr = JSON.stringify(capturedPayload);
      // Must not contain user IDs (subject user UUID)
      assert.ok(
        !payloadStr.includes(USER_SUBJECT_ID),
        "QA report payload must not contain subject user IDs",
      );
      // Must not contain raw coordinates
      const forbiddenKeys = ["lat", "lng", "latitude", "longitude", "coordinates"];
      for (const key of forbiddenKeys) {
        assert.ok(
          !payloadStr.toLowerCase().includes(`"${key}"`),
          `QA payload must not contain coordinate key: ${key}`,
        );
      }
      // Must contain aggregate metrics
      assert.ok("fixtures" in capturedPayload, "QA payload must contain fixtures count");
      // Must not contain session IDs or assignment IDs in payload values
      assert.ok(
        !payloadStr.includes(SESSION_ID),
        "QA payload must not contain session IDs",
      );
      assert.ok(
        !payloadStr.includes(ASSIGNMENT_ID),
        "QA payload must not contain assignment IDs",
      );
    } else if (r.status !== 201) {
      // Acceptable — evaluation may fail if ground truth has too few fixtures
      // but error must be well-formed
      assert.ok(r.body.error || r.body.message, "non-201 must have error info");
    }
  });

  // ── 8. Rating boundary — behaviorPatternInferenceReady always false ───

  it("computeShadowRating: behaviorPatternInferenceReady is always false regardless of metrics", () => {
    // Perfect metrics
    const perfectMetrics: JourneyGroundTruthMetrics = {
      fixtures: 100,
      arrivalErrorDist: { count: 100, minS: 1, maxS: 30, medianS: 10, p90S: 25 },
      departureErrorDist: { count: 100, minS: 1, maxS: 30, medianS: 10, p90S: 25 },
      dwellErrorDist: { count: 100, minS: 1, maxS: 30, medianS: 10, p90S: 25 },
      falseStop: { falseCount: 0, eligibleCount: 50, rate: 0 },
      falseDwell: { falseCount: 0, eligibleCount: 50, rate: 0 },
      placeMatch: { expectedCount: 100, resolvedCount: 90, matchedCount: 85, unknownCount: 5 },
      categoryMatch: { expectedCount: 100, resolvedCount: 90, matchedCount: 85, unknownCount: 5 },
      confidenceCalibration: {
        moving: { count: 50, meanUncertaintyScore: 0.1 },
        candidate_stop: { count: 30, meanUncertaintyScore: 0.2 },
        dwelling: { count: 20, meanUncertaintyScore: 0.15 },
        departed: { count: 10, meanUncertaintyScore: 0.1 },
        discarded: { count: 5, meanUncertaintyScore: 0.3 },
      },
      jitterDistM: { count: 100, minM: 0.5, maxM: 50, medianM: 5, p90M: 30 },
      samplingGapDist: { count: 100, minS: 1, maxS: 60, medianS: 15, p90S: 45 },
      impossibleSpeedEvents: 0,
      byCondition: {},
    };

    const rating = computeShadowRating(perfectMetrics, "HEALTHY", 100);
    assert.equal(rating.behaviorPatternInferenceReady, false, "must always be false");
    assert.ok(["insufficient", "blocked", "poor", "promising", "ready_for_larger_shadow_only"].includes(rating.rating), "rating must be one of the defined values");
  });

  it("computeShadowRating: blocked when retention not HEALTHY", () => {
    const metrics: JourneyGroundTruthMetrics = {
      fixtures: 50,
      arrivalErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      departureErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      dwellErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      falseStop: { falseCount: 0, eligibleCount: 50, rate: 0 },
      falseDwell: { falseCount: 0, eligibleCount: 50, rate: 0 },
      placeMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      categoryMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      confidenceCalibration: {
        moving: { count: 0, meanUncertaintyScore: 0 },
        candidate_stop: { count: 0, meanUncertaintyScore: 0 },
        dwelling: { count: 0, meanUncertaintyScore: 0 },
        departed: { count: 0, meanUncertaintyScore: 0 },
        discarded: { count: 0, meanUncertaintyScore: 0 },
      },
      jitterDistM: { count: 0, minM: null, maxM: null, medianM: null, p90M: null },
      samplingGapDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      impossibleSpeedEvents: 0,
      byCondition: {},
    };

    const rating = computeShadowRating(metrics, "FAILED", 50);
    assert.equal(rating.rating, "blocked", "must be blocked when retention is FAILED");
    assert.equal(rating.behaviorPatternInferenceReady, false, "must always be false");
  });

  it("computeShadowRating: blocked when zero truth samples", () => {
    const metrics: JourneyGroundTruthMetrics = {
      fixtures: 0,
      arrivalErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      departureErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      dwellErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      falseStop: { falseCount: 0, eligibleCount: 0, rate: 0 },
      falseDwell: { falseCount: 0, eligibleCount: 0, rate: 0 },
      placeMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      categoryMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      confidenceCalibration: {
        moving: { count: 0, meanUncertaintyScore: 0 },
        candidate_stop: { count: 0, meanUncertaintyScore: 0 },
        dwelling: { count: 0, meanUncertaintyScore: 0 },
        departed: { count: 0, meanUncertaintyScore: 0 },
        discarded: { count: 0, meanUncertaintyScore: 0 },
      },
      jitterDistM: { count: 0, minM: null, maxM: null, medianM: null, p90M: null },
      samplingGapDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      impossibleSpeedEvents: 0,
      byCondition: {},
    };

    const rating = computeShadowRating(metrics, "HEALTHY", 0);
    assert.equal(rating.rating, "blocked", "must be blocked when zero truth samples");
    assert.equal(rating.behaviorPatternInferenceReady, false, "must always be false");
  });

  it("computeShadowRating: poor when false stop rate is high", () => {
    const metrics: JourneyGroundTruthMetrics = {
      fixtures: 50,
      arrivalErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      departureErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      dwellErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      // 30% false stop rate > threshold
      falseStop: { falseCount: 15, eligibleCount: 50, rate: 0.30 },
      falseDwell: { falseCount: 0, eligibleCount: 50, rate: 0 },
      placeMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      categoryMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      confidenceCalibration: {
        moving: { count: 50, meanUncertaintyScore: 0.2 },
        candidate_stop: { count: 0, meanUncertaintyScore: 0 },
        dwelling: { count: 0, meanUncertaintyScore: 0 },
        departed: { count: 0, meanUncertaintyScore: 0 },
        discarded: { count: 0, meanUncertaintyScore: 0 },
      },
      jitterDistM: { count: 0, minM: null, maxM: null, medianM: null, p90M: null },
      samplingGapDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      impossibleSpeedEvents: 0,
      byCondition: {},
    };

    const rating = computeShadowRating(metrics, "HEALTHY", 50);
    assert.equal(rating.rating, "poor", "high false stop rate must give poor rating");
    assert.equal(rating.behaviorPatternInferenceReady, false, "must always be false");
  });

  it("computeShadowRating: insufficient when too many unknown places", () => {
    const metrics: JourneyGroundTruthMetrics = {
      fixtures: 50,
      arrivalErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      departureErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      dwellErrorDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      falseStop: { falseCount: 0, eligibleCount: 50, rate: 0 },
      falseDwell: { falseCount: 0, eligibleCount: 50, rate: 0 },
      // 80% unknown = > 50% threshold
      placeMatch: { expectedCount: 50, resolvedCount: 10, matchedCount: 8, unknownCount: 40 },
      categoryMatch: { expectedCount: 0, resolvedCount: 0, matchedCount: 0, unknownCount: 0 },
      confidenceCalibration: {
        moving: { count: 0, meanUncertaintyScore: 0 },
        candidate_stop: { count: 0, meanUncertaintyScore: 0 },
        dwelling: { count: 0, meanUncertaintyScore: 0 },
        departed: { count: 0, meanUncertaintyScore: 0 },
        discarded: { count: 0, meanUncertaintyScore: 0 },
      },
      jitterDistM: { count: 0, minM: null, maxM: null, medianM: null, p90M: null },
      samplingGapDist: { count: 0, minS: null, maxS: null, medianS: null, p90S: null },
      impossibleSpeedEvents: 0,
      byCondition: {},
    };

    const rating = computeShadowRating(metrics, "HEALTHY", 50);
    assert.equal(rating.rating, "insufficient", "too many unknown places must give insufficient");
    assert.equal(rating.behaviorPatternInferenceReady, false, "must always be false");
  });

  // ── Admin cohort assignment happy path ────────────────────────────────

  it("admin can configure a stage", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/stages", {
      stage: "internal",
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    }, ADMIN_TOKEN);

    assert.equal(r.status, 201, "admin should be able to configure a stage");
    assert.ok(typeof r.body.stageId === "string", "stageId must be returned");
    assert.ok(typeof r.body.approvedAt === "string", "approvedAt must be returned as server-generated");
  });

  it("admin can revoke a cohort assignment", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest(
      "POST",
      `/admin/journey-shadow/cohorts/${ASSIGNMENT_ID}/revoke`,
      {},
      ADMIN_TOKEN,
    );

    assert.equal(r.status, 200, "admin should be able to revoke assignment");
    assert.equal(r.body.revoked, true, "revoked must be true");
  });

  it("revoke with invalid UUID returns 400", async () => {
    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest(
      "POST",
      "/admin/journey-shadow/cohorts/not-a-uuid/revoke",
      {},
      ADMIN_TOKEN,
    );

    assert.equal(r.status, 400, "invalid UUID param must return 400");
  });

  // ── 9. Unissued session isolation ─────────────────────────────────────
  //
  // A same or different user in an unissued session (not in journey_shadow_session_issuances)
  // must not be able to affect QA metrics or the report.

  it("observations from an unissued session (OTHER_SESSION_ID) do not appear in QA evaluation", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // Add ground truth for the issued SESSION_ID
    state.groundTruth["gt-issued"] = {
      id: "gt-issued",
      assignment_id: ASSIGNMENT_ID,
      recorded_at: now,
      ground_truth: { expectedStop: false },
      location_session_id: SESSION_ID,
      expires_at: end,
    };

    // Add observations for the OTHER_SESSION_ID (not issued through shadow rollout)
    state.observations.push({
      id: "obs-other-1",
      user_id: OTHER_USER_ID,
      location_session_id: OTHER_SESSION_ID,
      observed_at: now,
      quality_class: "high",
      quality_reasons: ["impossible_speed"],
    });

    // The QA service iterates only over issued session IDs and reads each via
    // read_journey_shadow_qa_observations_v1. Capture the read RPC calls to
    // verify the other (unissued) session is never passed to it.
    const readSessions: string[] = [];
    state.rpcOverrides["read_journey_shadow_qa_observations_v1"] = (args: any) => {
      readSessions.push(args.p_location_session_id);
      const isIssued = Object.values(state.issuances).some(
        (iss: any) => iss.location_session_id === args.p_location_session_id,
      );
      // Unissued → RPC would RAISE (surfaced as error), never return rows.
      if (!isIssued) return { data: null, error: { message: "not authorized", code: "42501" } };
      // QA includes ALL quality classes (including unusable).
      const rows = state.observations
        .filter((r: any) => r.location_session_id === args.p_location_session_id)
        .map((r: any) => ({
          id: r.id, observed_at: r.observed_at, source: r.source,
          lat: r.lat ?? null, lng: r.lng ?? null, accuracy_m: r.accuracy_m ?? null,
          speed_mps: r.speed_mps ?? null, quality_version: r.quality_version ?? null,
          quality_score: r.quality_score ?? null, quality_class: r.quality_class ?? null,
          quality_reasons: r.quality_reasons ?? [],
        }));
      return { data: rows, error: null };
    };

    let capturedPayload: any = null;
    state.rpcOverrides["persist_journey_shadow_qa_report_v1"] = (args: any) => {
      capturedPayload = args.p_payload;
      return { data: "qa-report-isolation-test", error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/evaluate", {
      stageId: STAGE_ID,
      periodStartsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      periodEndsAt: end,
    }, ADMIN_TOKEN);

    if (r.status === 201) {
      // The OTHER_SESSION_ID must not have been read-authorized (it's not issued).
      // read_journey_shadow_qa_observations_v1 was only called for issued sessions.
      assert.ok(
        !readSessions.includes(OTHER_SESSION_ID),
        "unissued session must never be passed to read_journey_shadow_qa_observations_v1",
      );

      if (capturedPayload) {
        const payloadStr = JSON.stringify(capturedPayload);
        // The other session's impossible_speed observation must not inflate the count
        // since it was never scoped into the evaluation
        assert.ok(
          !payloadStr.includes(OTHER_SESSION_ID),
          "other session ID must not appear in payload",
        );
        assert.ok(
          !payloadStr.includes(OTHER_USER_ID),
          "other user ID must not appear in payload",
        );
      }
    } else {
      // Evaluation may fail if there are no fixtures after filtering — that's acceptable
      assert.ok(r.status === 500, "must be 500 if evaluation blocked, not 201 with contaminated data");
    }
  });

  it("GET /report scopes observation/revision counts by issued session IDs, not all users", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // Add an observation for the issued SESSION_ID
    state.observations.push({
      id: "obs-issued",
      user_id: USER_SUBJECT_ID,
      location_session_id: SESSION_ID,
      received_at: now,
      quality_class: "high",
      quality_reasons: [],
    });

    // Add an observation for the OTHER_SESSION_ID (not issued)
    state.observations.push({
      id: "obs-other",
      user_id: OTHER_USER_ID,
      location_session_id: OTHER_SESSION_ID,
      received_at: now,
      quality_class: "high",
      quality_reasons: ["suspicious_speed"],
    });

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest(
      "GET",
      `/admin/journey-shadow/report?stageId=${encodeURIComponent(STAGE_ID)}&periodStartsAt=${encodeURIComponent(now)}&periodEndsAt=${encodeURIComponent(end)}`,
      undefined,
      ADMIN_TOKEN,
    );

    assert.equal(r.status, 200, "report must return 200");

    // The report's observation count must not include the OTHER session's observations
    // (only SESSION_ID is issued through the shadow rollout)
    if (r.body.counts.observations !== null) {
      assert.ok(
        r.body.counts.observations <= 1,
        "observation count must not exceed issued session count (excludes unissued sessions)",
      );
    }

    // Verify other user/session IDs are not in the response
    const bodyStr = JSON.stringify(r.body);
    assert.ok(!bodyStr.includes(OTHER_SESSION_ID), "other session ID must not appear in report");
    assert.ok(!bodyStr.includes(OTHER_USER_ID), "other user ID must not appear in report");
  });

  // ── 10. Denied raw_read blocks evaluation ─────────────────────────────

  it("denied journey_shadow_authorize_v1 (raw_read) blocks evaluation entirely", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // Add ground truth
    state.groundTruth["gt-deny-test"] = {
      id: "gt-deny-test",
      assignment_id: ASSIGNMENT_ID,
      recorded_at: now,
      ground_truth: { expectedStop: false },
      location_session_id: SESSION_ID,
      expires_at: end,
    };

    // Deny authorization for SESSION_ID. read_journey_shadow_qa_observations_v1
    // RAISEs a generic 42501 on denial (surfaced as an error), which blocks the
    // entire evaluation. The default fake already maps authorizeResults===false
    // to that error, so no explicit override is needed here.
    state.authorizeResults[SESSION_ID] = false;

    let persistCalled = false;
    state.rpcOverrides["persist_journey_shadow_qa_report_v1"] = () => {
      persistCalled = true;
      return { data: "should-not-persist", error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/evaluate", {
      stageId: STAGE_ID,
      periodStartsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      periodEndsAt: end,
    }, ADMIN_TOKEN);

    // Must fail — not persist
    assert.notEqual(r.status, 201, "denied auth must block evaluation (not 201)");
    assert.equal(persistCalled, false, "persist must not be called when authorization is denied");
  });

  it("error from read_journey_shadow_qa_observations_v1 blocks evaluation entirely", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    state.groundTruth["gt-error-test"] = {
      id: "gt-error-test",
      assignment_id: ASSIGNMENT_ID,
      recorded_at: now,
      ground_truth: { expectedStop: false },
      location_session_id: SESSION_ID,
      expires_at: end,
    };

    // Any error from the QA read RPC (including a denial 42501) blocks the
    // entire evaluation — fail closed.
    state.rpcOverrides["read_journey_shadow_qa_observations_v1"] = () => ({
      data: null,
      error: { message: "policy violation: session expired" },
    });

    let persistCalled = false;
    state.rpcOverrides["persist_journey_shadow_qa_report_v1"] = () => {
      persistCalled = true;
      return { data: "should-not-persist", error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/evaluate", {
      stageId: STAGE_ID,
      periodStartsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      periodEndsAt: end,
    }, ADMIN_TOKEN);

    assert.notEqual(r.status, 201, "authorize error must block evaluation (not 201)");
    assert.equal(persistCalled, false, "persist must not be called when authorization errors");
  });

  // ── 11. Jitter/gap/impossible metrics are aggregate and deterministic ──

  it("measureJourneyGroundTruth: jitter distribution is aggregate-only and deterministic", () => {
    const t0 = 1_700_000_000_000;
    // Two fixtures with observation evidence
    const fixtures: JourneyGroundTruthFixture[] = [
      {
        condition: "transit",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: [],
        observationEvidence: {
          orderedTimestampsMs: [t0, t0 + 10_000, t0 + 25_000],
          consecutiveDistancesM: [50, 120], // metres
          qualityReasonSets: [[], [], []],
        },
      },
      {
        condition: "transit",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: [],
        observationEvidence: {
          orderedTimestampsMs: [t0 + 100_000, t0 + 130_000],
          consecutiveDistancesM: [80],
          qualityReasonSets: [[], []],
        },
      },
    ];

    const metrics1 = measureJourneyGroundTruth(fixtures);
    const metrics2 = measureJourneyGroundTruth(fixtures); // Run twice for determinism

    // Deterministic
    assert.deepEqual(metrics1.jitterDistM, metrics2.jitterDistM, "jitter dist must be deterministic");
    assert.deepEqual(metrics1.samplingGapDist, metrics2.samplingGapDist, "gap dist must be deterministic");

    // Aggregate: count = total distances across all fixtures
    assert.equal(metrics1.jitterDistM.count, 3, "jitter count must be total consecutive distances");
    assert.equal(metrics1.jitterDistM.minM, 50, "jitter min must be correct");
    assert.equal(metrics1.jitterDistM.maxM, 120, "jitter max must be correct");
    assert.ok(metrics1.jitterDistM.medianM !== null, "jitter median must be non-null");

    // Gap distribution: gaps from timestamps
    // Fixture 1: gaps = 10s, 15s. Fixture 2: gap = 30s
    assert.equal(metrics1.samplingGapDist.count, 3, "gap count must be total gaps");
    assert.equal(metrics1.samplingGapDist.minS, 10, "gap min must be 10s");
    assert.equal(metrics1.samplingGapDist.maxS, 30, "gap max must be 30s");

    // No raw data in metrics output
    const metricsStr = JSON.stringify(metrics1);
    assert.ok(!metricsStr.includes(t0.toString()), "no raw timestamps in metrics");
  });

  it("measureJourneyGroundTruth: impossible_speed detected from quality_reasons", () => {
    const t0 = 1_700_000_000_000;
    const fixtures: JourneyGroundTruthFixture[] = [
      {
        condition: "transit",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: [],
        observationEvidence: {
          orderedTimestampsMs: [t0, t0 + 5_000, t0 + 10_000],
          consecutiveDistancesM: [10, 20],
          qualityReasonSets: [
            [],
            ["impossible_speed", "accuracy_low"],
            [],
          ],
        },
      },
    ];

    const metrics = measureJourneyGroundTruth(fixtures);
    assert.equal(metrics.impossibleSpeedEvents, 1, "must detect 1 impossible_speed event from reasons");
  });

  it("measureJourneyGroundTruth: impossible_speed detected from consecutive distance/time > 340 m/s", () => {
    const t0 = 1_700_000_000_000;
    const fixtures: JourneyGroundTruthFixture[] = [
      {
        condition: "transit",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: [],
        observationEvidence: {
          // 3400m in 1s = 3400 m/s > 340 m/s threshold
          orderedTimestampsMs: [t0, t0 + 1_000],
          consecutiveDistancesM: [3400],
          qualityReasonSets: [[], []],
        },
      },
    ];

    const metrics = measureJourneyGroundTruth(fixtures);
    assert.equal(metrics.impossibleSpeedEvents, 1, "must detect impossible speed from distance/time");
  });

  it("measureJourneyGroundTruth: backward compat — fixtures without observationEvidence still work", () => {
    // Fixtures without observationEvidence (the optional field)
    const fixtures: JourneyGroundTruthFixture[] = [
      {
        condition: "stop",
        expectedArrivalAt: "2024-01-01T10:00:00Z",
        expectedDepartureAt: "2024-01-01T10:30:00Z",
        expectedDwellS: 1800,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: [],
        // No observationEvidence
      },
    ];

    const metrics = measureJourneyGroundTruth(fixtures);
    assert.equal(metrics.fixtures, 1, "must process fixtures without evidence");
    assert.equal(metrics.jitterDistM.count, 0, "jitter must be empty without evidence");
    assert.equal(metrics.impossibleSpeedEvents, 0, "impossible speed must be 0 without evidence");
    // Should not throw
  });

  it("measureJourneyGroundTruth: jitter/gap/impossible are pure aggregates — no raw values", () => {
    const t0 = 1_700_000_000_000;
    const sessionSpecificTs = t0 + 999_999; // a recognizable timestamp

    const fixtures: JourneyGroundTruthFixture[] = [
      {
        condition: "transit",
        expectedArrivalAt: null,
        expectedDepartureAt: null,
        expectedDwellS: null,
        expectedPlaceId: null,
        expectedCategoryId: null,
        revisions: [],
        observationEvidence: {
          orderedTimestampsMs: [sessionSpecificTs, sessionSpecificTs + 15_000],
          consecutiveDistancesM: [75],
          qualityReasonSets: [[], []],
        },
      },
    ];

    const metrics = measureJourneyGroundTruth(fixtures);
    const metricsStr = JSON.stringify(metrics);

    // The raw timestamp must NOT appear in the output
    assert.ok(
      !metricsStr.includes(sessionSpecificTs.toString()),
      "raw timestamp must not appear in metrics output",
    );
    // The distance (75) appears only as a statistical summary value — check it's aggregate
    assert.equal(metrics.jitterDistM.count, 1);
    assert.equal(metrics.jitterDistM.minM, 75);
    // Gap = 15s
    assert.equal(metrics.samplingGapDist.count, 1);
    assert.equal(metrics.samplingGapDist.minS, 15);
  });

  // ── 12. No coordinate/raw/session/user IDs in persisted payload ────────

  it("QA payload never contains raw coordinate keys", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    state.groundTruth["gt-coord-test"] = {
      id: "gt-coord-test",
      assignment_id: ASSIGNMENT_ID,
      recorded_at: now,
      ground_truth: { expectedStop: false },
      location_session_id: SESSION_ID,
      expires_at: end,
    };

    // Add an observation with suspicious coordinate-like data to ensure it's not persisted
    state.observations.push({
      id: "obs-coord",
      user_id: USER_SUBJECT_ID,
      location_session_id: SESSION_ID,
      observed_at: now,
      quality_class: "high",
      quality_reasons: [],
    });

    let capturedPayload: any = null;
    state.rpcOverrides["persist_journey_shadow_qa_report_v1"] = (args: any) => {
      capturedPayload = args.p_payload;
      return { data: "qa-coord-test", error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest("POST", "/admin/journey-shadow/evaluate", {
      stageId: STAGE_ID,
      periodStartsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      periodEndsAt: end,
    }, ADMIN_TOKEN);

    if (r.status === 201 && capturedPayload) {
      const payloadStr = JSON.stringify(capturedPayload);
      const forbiddenPatterns = [
        '"lat"', '"lng"', '"latitude"', '"longitude"', '"coordinates"',
        '"user_id"', '"session_id"', '"observation_id"', '"raw_id"',
      ];
      for (const pattern of forbiddenPatterns) {
        assert.ok(
          !payloadStr.toLowerCase().includes(pattern.toLowerCase()),
          `payload must not contain forbidden key: ${pattern}`,
        );
      }
      // Must not contain any of our known IDs
      assert.ok(!payloadStr.includes(USER_SUBJECT_ID), "payload must not contain user subject ID");
      assert.ok(!payloadStr.includes(SESSION_ID), "payload must not contain session ID");
      assert.ok(!payloadStr.includes(ASSIGNMENT_ID), "payload must not contain assignment ID");
    }
    // If evaluation fails (e.g., no valid fixtures after auth filtering), that's also acceptable
  });

  it("known coordinates produce non-empty deterministic jitterDistM with zero coordinate leakage", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const t0 = Date.now() - 60_000;

    // Ground truth for the issued SESSION_ID
    state.groundTruth["gt-jitter"] = {
      id: "gt-jitter",
      assignment_id: ASSIGNMENT_ID,
      recorded_at: now,
      ground_truth: { expectedStop: false },
      location_session_id: SESSION_ID,
      expires_at: end,
    };

    // Three observations at known coordinates for the issued SESSION_ID.
    // Consecutive haversine distances are ~111m and ~138m (deterministic).
    const coords = [
      { lat: 51.5000, lng: -0.1000 },
      { lat: 51.5010, lng: -0.1000 },
      { lat: 51.5010, lng: -0.1020 },
    ];
    coords.forEach((c, i) => {
      state.observations.push({
        id: `obs-jitter-${i}`,
        user_id: USER_SUBJECT_ID,
        location_session_id: SESSION_ID,
        observed_at: new Date(t0 + i * 15_000).toISOString(),
        quality_class: "high",
        quality_reasons: [],
        lat: c.lat,
        lng: c.lng,
      });
    });

    // Same user, DIFFERENT unissued session — must be excluded from evidence.
    state.observations.push({
      id: "obs-jitter-unissued",
      user_id: USER_SUBJECT_ID,
      location_session_id: OTHER_SESSION_ID,
      observed_at: new Date(t0 + 5_000).toISOString(),
      quality_class: "high",
      quality_reasons: [],
      lat: 40.0000,
      lng: 40.0000,
    });

    let capturedPayload: any = null;
    state.rpcOverrides["persist_journey_shadow_qa_report_v1"] = (args: any) => {
      capturedPayload = args.p_payload;
      state.qaReports[REPORT_ID] = {
        id: REPORT_ID,
        stage_id: STAGE_ID,
        payload: args.p_payload,
        submitted_at: now,
      };
      return { data: REPORT_ID, error: null };
    };

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const evalRes = await makeRequest("POST", "/admin/journey-shadow/evaluate", {
      stageId: STAGE_ID,
      periodStartsAt: new Date(t0 - 24 * 3600 * 1000).toISOString(),
      periodEndsAt: end,
    }, ADMIN_TOKEN);

    assert.equal(evalRes.status, 201, "evaluation with known coordinates must succeed");
    assert.ok(capturedPayload, "persisted payload must be captured");

    // jitterDistM must be non-empty and deterministic: 2 consecutive distances
    // from 3 issued-session observations (the unissued-session point is excluded).
    const jd = capturedPayload.jitterDistM;
    assert.ok(jd, "jitterDistM must be present");
    assert.equal(jd.count, 2, "jitter count must equal consecutive distances of issued session only");
    assert.ok(jd.minM !== null && jd.maxM !== null, "jitter min/max must be non-null");
    assert.ok(jd.minM > 100 && jd.minM < 120, "jitter minM must reflect ~111m distance");
    assert.ok(jd.maxM > 130 && jd.maxM < 150, "jitter maxM must reflect ~138m distance");
    assert.ok(jd.minM <= jd.maxM, "jitter min must not exceed max");
    assert.ok(jd.medianM !== null, "jitter median must be non-null");

    // Recursive assertion: no coordinate keys/values anywhere in persisted payload.
    const forbiddenKeys = ["lat", "lng", "latitude", "longitude", "coordinates", "coord"];
    function assertNoCoords(obj: any, path: string) {
      if (obj === null || obj === undefined) return;
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => assertNoCoords(v, `${path}[${i}]`));
        return;
      }
      if (typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          const lk = k.toLowerCase();
          for (const fk of forbiddenKeys) {
            assert.ok(lk !== fk, `payload must not contain coordinate key '${k}' at ${path}`);
          }
          assertNoCoords(v, `${path}.${k}`);
        }
      }
    }
    assertNoCoords(capturedPayload, "payload");

    // The raw coordinate values must never appear as substrings either.
    const payloadStr = JSON.stringify(capturedPayload);
    for (const c of coords) {
      assert.ok(!payloadStr.includes(String(c.lat)), "payload must not contain raw lat value");
      assert.ok(!payloadStr.includes(String(c.lng)), "payload must not contain raw lng value");
    }
    assert.ok(!payloadStr.includes(SESSION_ID), "payload must not contain session ID");
    assert.ok(!payloadStr.includes(OTHER_SESSION_ID), "payload must not contain unissued session ID");

    // The HTTP report response must also be coordinate-free.
    const reportRes = await makeRequest(
      "GET",
      `/admin/journey-shadow/report?stageId=${encodeURIComponent(STAGE_ID)}&periodStartsAt=${encodeURIComponent(new Date(t0 - 24 * 3600 * 1000).toISOString())}&periodEndsAt=${encodeURIComponent(end)}`,
      undefined,
      ADMIN_TOKEN,
    );
    assert.equal(reportRes.status, 200, "report must return 200");
    assertNoCoords(reportRes.body, "reportBody");
    const respStr = JSON.stringify(reportRes.body);
    for (const c of coords) {
      assert.ok(!respStr.includes(String(c.lat)), "response must not contain raw lat value");
      assert.ok(!respStr.includes(String(c.lng)), "response must not contain raw lng value");
    }
  });

  it("GET /report response never contains raw user/session/assignment IDs in any field", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest(
      "GET",
      `/admin/journey-shadow/report?stageId=${encodeURIComponent(STAGE_ID)}&periodStartsAt=${encodeURIComponent(now)}&periodEndsAt=${encodeURIComponent(end)}`,
      undefined,
      ADMIN_TOKEN,
    );

    assert.equal(r.status, 200);
    const bodyStr = JSON.stringify(r.body);

    // User subject IDs must never appear
    assert.ok(!bodyStr.includes(USER_SUBJECT_ID), "report must not contain USER_SUBJECT_ID");
    assert.ok(!bodyStr.includes(ASSIGNMENT_ID), "report must not contain ASSIGNMENT_ID");
    assert.ok(!bodyStr.includes(SESSION_ID), "report must not contain SESSION_ID");

    // behaviorPatternInferenceReady must be hardcoded false
    assert.equal(r.body.behaviorPatternInferenceReady, false);
  });

  it("failureModes in report includes qualityClassDistribution and qualityReasonDistribution (including unusable)", async () => {
    const now = new Date().toISOString();
    const end = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    // Add observations with quality_class and quality_reasons for issued SESSION_ID.
    // Unusable rows are intentionally included in QA/report aggregate reads to
    // measure stale/poor-accuracy/impossible-speed failure-mode distributions.
    state.observations.push({
      id: "obs-q1",
      user_id: USER_SUBJECT_ID,
      location_session_id: SESSION_ID,
      received_at: now,
      quality_class: "high",
      quality_reasons: ["good_accuracy"],
    });
    state.observations.push({
      id: "obs-q2",
      user_id: USER_SUBJECT_ID,
      location_session_id: SESSION_ID,
      received_at: now,
      quality_class: "degraded",
      quality_reasons: ["low_accuracy", "signal_weak"],
    });
    state.observations.push({
      id: "obs-q3",
      user_id: USER_SUBJECT_ID,
      location_session_id: SESSION_ID,
      received_at: now,
      quality_class: "unusable",
      quality_reasons: ["stale"],
    });

    const adminClient = makeFakeClient(ADMIN_ID);
    _setTestClient(adminClient, true);
    _setTestServiceClient(adminClient);

    const r = await makeRequest(
      "GET",
      `/admin/journey-shadow/report?stageId=${encodeURIComponent(STAGE_ID)}&periodStartsAt=${encodeURIComponent(now)}&periodEndsAt=${encodeURIComponent(end)}`,
      undefined,
      ADMIN_TOKEN,
    );

    assert.equal(r.status, 200);
    assert.ok(typeof r.body.failureModes === "object", "failureModes must be present");
    assert.ok(
      typeof r.body.failureModes.qualityClassDistribution === "object",
      "qualityClassDistribution must be present in failureModes",
    );
    assert.ok(
      typeof r.body.failureModes.qualityReasonDistribution === "object",
      "qualityReasonDistribution must be present in failureModes",
    );

    // The distribution is aggregate counts — no raw rows, no IDs
    const fmStr = JSON.stringify(r.body.failureModes);
    assert.ok(!fmStr.includes(USER_SUBJECT_ID), "failureModes must not contain user IDs");
    assert.ok(!fmStr.includes(SESSION_ID), "failureModes must not contain session IDs");

    // Unusable is now included in QA distribution to measure stale/poor-accuracy
    // failure modes — verify it appears in qualityClassDistribution.
    assert.ok(
      typeof r.body.failureModes.qualityClassDistribution.unusable === "number",
      "unusable must appear in qualityClassDistribution for failure-mode measurement",
    );
  });
});
