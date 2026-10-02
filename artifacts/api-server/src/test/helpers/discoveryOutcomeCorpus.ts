/**
 * discoveryOutcomeCorpus — a controlled Discovery telemetry corpus for the §55
 * report suites, written by the REAL writers and routes so every row has the
 * shape production writes:
 *
 *   exposures        lib/discoveryServeLog.logDiscoveryServe (the legacy arm) and
 *                    lib/rankLog.logImpression (the PDE arm), each with its
 *                    per-request row through 3376's door;
 *   outcomes         POST /rank-events/outcome (funnel update + analytics row);
 *   attention        POST /rank-events/dwell (lib/discoveryDwell.ts).
 *
 * Only what production CANNOT be made to produce on demand is planted by hand,
 * and each such row is a copy of a real row with one field changed (a lost
 * insert, an unknown version, a row older than the servePoint marker).
 */
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import { _setTestClient } from "../../lib/http.js";
import { _setTestServiceClient } from "../../lib/supabase.js";
import rankEventsRouter, { _resetRecommendationIdSchemaLatch } from "../../routes/rankEvents.js";
import { invalidateServeLogFlagCache, logDiscoveryServe, DiscoveryServePoint, _resetServeRequestTableLatch } from "../../lib/discoveryServeLog.js";
import { logImpression } from "../../lib/rankLog.js";
import { mintServeExposure, servedRecommendationId } from "../../lib/discoveryRecommendationRecord.js";
import { DISCOVERY_DWELL_FLAG } from "../../lib/discoveryDwell.js";
import type { ScoredCandidate, RankCandidate } from "../../lib/portavaRank.js";
import { makeTelemetryDb } from "./fakeDiscoveryTelemetryDb.js";

export const ALICE = "a11ce000-0000-4000-8000-000000000001";
export const BOB   = "b0b00000-0000-4000-8000-000000000002";
const USERS = { "alice-token": ALICE, "bob-token": BOB };

export interface CorpusHarness {
  db: ReturnType<typeof makeTelemetryDb>;
  base: string;
  close(): Promise<void>;
  post(path: string, token: string | null, body: unknown): Promise<{ status: number; body: any }>;
  /** Legacy-arm serve through the serve log; returns each item's exposure id. */
  serveLegacy(userId: string, servePoint: number, items: string[]): Promise<string[]>;
  /** PDE-arm serve through rankLog: `scored` ⊆ `served` get exposure rows; the request row counts `served`. */
  servePde(userId: string, servePoint: number, served: string[], scored: string[]): Promise<string[]>;
  outcome(token: string, itemId: string, outcome: string, rid?: string): Promise<number>;
  dwell(token: string, itemId: string, rid: string, clientEventId: string, dwell: Array<{ kind: string; ms: number }>): Promise<number>;
}

export async function startCorpus(opts: { dwellFlag?: boolean } = {}): Promise<CorpusHarness> {
  const db = makeTelemetryDb({
    users: USERS,
    flags: {
      discovery_serve_log_enabled: { enabled: true },
      [DISCOVERY_DWELL_FLAG]: { enabled: opts.dwellFlag !== false },
    },
    rpc: { increment_distribution_stats: () => ({ data: null, error: null }) },
  });
  _setTestClient(db.client as any, true);
  _setTestServiceClient(db.client as any);
  invalidateServeLogFlagCache();
  _resetServeRequestTableLatch();
  _resetRecommendationIdSchemaLatch();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", rankEventsRouter);
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;

  const post = async (path: string, token: string | null, body: unknown) => {
    const res = await fetch(`${base}/api${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return {
    db, base, post,
    close: () => new Promise<void>((r) => server.close(() => r())),
    async serveLegacy(userId, servePoint, items) {
      const e = mintServeExposure(userId || null);
      await logDiscoveryServe(db.client, {
        userId, servePoint: servePoint as any, items: items.map((id) => ({ id })),
        sessionId: e.sessionId, servedAt: e.servedAt, context: { destination: "Miami", category: "for_you" },
      });
      return items.map((id, i) => servedRecommendationId(e, i, id));
    },
    async servePde(userId, servePoint, served, scored) {
      const e = mintServeExposure(userId);
      const candidates: ScoredCandidate<RankCandidate>[] = served
        .filter((id) => scored.includes(id))
        .map((id, i) => ({ candidate: { id, kind: "place" }, score: 1 - i / 10, features: { recency: 0.2, cityMatch: 0.1 } }));
      await logImpression(candidates, userId, "discovery", e.sessionId, {
        servePoint, route: "GET /discovery", rankedInRequest: true, destination: "Miami", category: "for_you",
        engineMode: "pde", modeReason: "cohort",
      }, { servedAt: e.servedAt, servedIds: served });
      return served.map((id, i) => servedRecommendationId(e, i, id));
    },
    async outcome(token, itemId, outcome, rid) {
      const r = await post("/rank-events/outcome", token, { item_id: itemId, surface: "discovery", outcome, ...(rid ? { recommendation_id: rid } : {}) });
      return r.status;
    },
    async dwell(token, itemId, rid, clientEventId, dwell) {
      const r = await post("/rank-events/dwell", token, { item_id: itemId, surface: "discovery", recommendation_id: rid, client_event_id: clientEventId, dwell });
      return r.status;
    },
  };
}

export const SP = DiscoveryServePoint;

/** Wait until every fire-and-forget analytics write has landed. */
export const quiesce = () => new Promise((r) => setTimeout(r, 80));
