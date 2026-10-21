/**
 * layoverLiveFeed — the LICENSED / APPROVED LIVE FEED half of Layover's live
 * airport intelligence (spec §10 "Fast live — security wait, immigration wait,
 * taxi queue, disruption; minutes"; census L81). Lane B2-LIVE, Layover 165.
 *
 * Owner decision 2026-10-18: "Use a combination of: Official airport
 * information; Licensed or approved live feeds; Verified traveler observations
 * …". This file is the second source class, and only the adapter: what a feed
 * says is decided by `LayoverAirportTruth` (screening, validation, the §10.1
 * contradiction rules) and folded by `layoverLiveSignals`, exactly like a
 * stored observation. A feed reading is an `AirportObservation` with observer
 * kind `official` (the airport's own published figure) or `operator_feed` (a
 * licensed provider), so it is weighted, rate-limited and checked for
 * plausibility by the same code as everything else.
 *
 * ── NO FEED IS CONNECTED, AND THAT IS A NAMED ABSENCE ───────────────────────
 * No feed has been purchased. With LAYOVER_LIVE_FEED_URL and
 * LAYOVER_LIVE_FEED_API_KEY unset (every environment today), `configuredLiveFeed`
 * answers `UNCONFIGURED_LIVE_FEED`, whose every read is
 * `{ ok: false, configured: false, reason: "feed_not_configured" }` — never an
 * empty reading list, which a caller could mistake for "the feed says there is
 * no queue". The live producer reads an unconfigured feed as the absence of
 * that source class and nothing else. A CONFIGURED feed that cannot be read is
 * different: the signal the deployment requires is missing, and the producer
 * says so with DATA_STALE.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * `portava.layover.live-feed.v1`, served as
 *   GET {LAYOVER_LIVE_FEED_URL}/v1/airports/{IATA}/conditions
 *   Authorization: Bearer {LAYOVER_LIVE_FEED_API_KEY}
 * answering
 *   { "contract": "portava.layover.live-feed.v1", "airport": "SIN",
 *     "authority": "official" | "licensed", "generatedAt": ISO,
 *     "readings": [ { "id": "…", "fact": "security_wait" | "immigration_wait"
 *                     | "taxi_queue" | "disruption", "minutes": n | null,
 *                     "level": 0-4 | null, "checkpoint": "…" | null,
 *                     "observedAt": ISO } ] }
 * It is PORTAVA's ingest contract, not a vendor's: whichever licensed provider
 * the owner contracts is fronted by a mapping to it (or chosen because it can
 * emit it). Contract fixtures: src/test/fixtures/layoverLiveFeed/.
 *
 * Several checkpoints for one fact (Terminal 1 and Terminal 3 security) are
 * folded to the LONGEST: the traveller's return checkpoint is not known here,
 * and the longest is the reading that cannot under-state their way back.
 *
 * No test makes a real call: the HTTP adapter takes `fetchImpl`.
 */
import { z } from "zod";
import type { AirportFactType, AirportObservation, ObserverKind } from "./LayoverAirportTruth.js";

/** The deployment's feed endpoint (base URL). Unset = no feed. */
export const LIVE_FEED_URL_ENV = "LAYOVER_LIVE_FEED_URL";
/** The deployment's feed credential (bearer token). Unset = no feed. */
export const LIVE_FEED_KEY_ENV = "LAYOVER_LIVE_FEED_API_KEY";
/** The contract name a payload must carry. */
export const LIVE_FEED_CONTRACT = "portava.layover.live-feed.v1";
/** A feed read that takes longer than this is a failed read, not a slow page. */
export const LIVE_FEED_TIMEOUT_MS = 2_500;

export type LiveFeedRefusal = "feed_not_configured" | "feed_unavailable" | "feed_malformed";

export type LiveFeedRead =
  | { ok: true; feedId: string; observations: AirportObservation[] }
  | { ok: false; configured: boolean; reason: LiveFeedRefusal; detail: string };

export interface LayoverLiveFeedAdapter {
  readonly id: string;
  /** False only for the named absence. */
  readonly configured: boolean;
  read(airportRef: string, nowMs: number): Promise<LiveFeedRead>;
}

/** The feed every deployment has today: none. Every read is the named absence. */
export const UNCONFIGURED_LIVE_FEED: LayoverLiveFeedAdapter = Object.freeze({
  id: "none",
  configured: false,
  async read(): Promise<LiveFeedRead> {
    return {
      ok: false,
      configured: false,
      reason: "feed_not_configured",
      detail: `${LIVE_FEED_URL_ENV} and ${LIVE_FEED_KEY_ENV} are not set — no licensed or official live airport feed is connected`,
    };
  },
});

const FEED_FACT: Record<"security_wait" | "immigration_wait" | "taxi_queue" | "disruption", AirportFactType> = {
  security_wait: "security_wait_minutes",
  immigration_wait: "immigration_wait_minutes",
  taxi_queue: "taxi_queue_minutes",
  disruption: "disruption_level",
};

const readingSchema = z.object({
  id: z.string().min(1).max(128),
  fact: z.enum(["security_wait", "immigration_wait", "taxi_queue", "disruption"]),
  minutes: z.number().finite().nullable().optional(),
  level: z.number().int().nullable().optional(),
  checkpoint: z.string().max(120).nullable().optional(),
  observedAt: z.string().min(1),
});

const payloadSchema = z.object({
  contract: z.literal(LIVE_FEED_CONTRACT),
  airport: z.string().min(1).max(64),
  authority: z.enum(["official", "licensed"]),
  generatedAt: z.string().min(1),
  readings: z.array(readingSchema).max(200),
});

/**
 * A contract payload as observations, or why it is not one. Pure.
 *
 * Refused WHOLE (never partially read) when the contract name, the airport or
 * any reading's shape is wrong: a feed that sends one malformed reading has
 * told us it is not speaking the contract, and keeping the readings that
 * happened to parse would be guessing which half to believe.
 * A reading missing the value its fact needs is the same refusal.
 * Plausibility and freshness are NOT judged here — `screenObservations` does
 * that for every source alike.
 */
export function parseLiveFeedPayload(
  payload: unknown,
  airportRef: string,
  feedId: string,
): { ok: true; observations: AirportObservation[] } | { ok: false; detail: string } {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, detail: `not a ${LIVE_FEED_CONTRACT} payload: ${parsed.error.issues[0]?.path.join(".") ?? "?"} ${parsed.error.issues[0]?.message ?? ""}`.trim() };
  const p = parsed.data;
  if (p.airport.trim().toUpperCase() !== airportRef.trim().toUpperCase()) {
    return { ok: false, detail: `payload is for ${p.airport}, not ${airportRef}` };
  }
  const kind: ObserverKind = p.authority === "official" ? "official" : "operator_feed";
  const longest = new Map<AirportFactType, { value: number; id: string; observedAt: string; checkpoint: string | null }>();
  for (const r of p.readings) {
    const factType = FEED_FACT[r.fact];
    const value = r.fact === "disruption" ? r.level : r.minutes;
    if (value === null || value === undefined) return { ok: false, detail: `reading ${r.id} (${r.fact}) carries no ${r.fact === "disruption" ? "level" : "minutes"}` };
    const prev = longest.get(factType);
    if (!prev || value > prev.value) longest.set(factType, { value, id: r.id, observedAt: r.observedAt, checkpoint: r.checkpoint ?? null });
  }
  const observations: AirportObservation[] = [...longest.entries()].map(([factType, r]) => ({
    observationId: `feed:${feedId}:${r.id}`,
    airportRef,
    factType,
    value: r.value,
    observerKind: kind,
    observerId: `feed:${feedId}`,
    observedAt: r.observedAt,
    sourceRef: `feed:${feedId}/${p.authority}/${r.id}${r.checkpoint ? `#${r.checkpoint}` : ""}`,
  }));
  return { ok: true, observations };
}

/** The contract's HTTP adapter. `fetchImpl` is injected so no test dials anything. */
export function httpLiveFeedAdapter(opts: {
  baseUrl: string;
  apiKey: string;
  id?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): LayoverLiveFeedAdapter {
  const id = opts.id ?? "live-feed";
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? LIVE_FEED_TIMEOUT_MS;
  return {
    id,
    configured: true,
    async read(airportRef: string): Promise<LiveFeedRead> {
      const url = `${opts.baseUrl.replace(/\/+$/, "")}/v1/airports/${encodeURIComponent(airportRef)}/conditions`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let body: unknown;
      try {
        const res = await doFetch(url, { method: "GET", headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" }, signal: ac.signal });
        if (!res.ok) return { ok: false, configured: true, reason: "feed_unavailable", detail: `${id} answered HTTP ${res.status}` };
        body = await res.json();
      } catch (e) {
        return { ok: false, configured: true, reason: "feed_unavailable", detail: `${id} could not be read: ${e instanceof Error ? e.name : String(e)}` };
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseLiveFeedPayload(body, airportRef, id);
      if (!parsed.ok) return { ok: false, configured: true, reason: "feed_malformed", detail: `${id}: ${parsed.detail}` };
      return { ok: true, feedId: id, observations: parsed.observations };
    },
  };
}

/** The deployment's feed: the HTTP adapter when BOTH variables are set, the named absence otherwise. */
export function configuredLiveFeed(
  readEnv: (name: string) => string | undefined = (n) => process.env[n],
  fetchImpl?: typeof fetch,
): LayoverLiveFeedAdapter {
  const baseUrl = (readEnv(LIVE_FEED_URL_ENV) ?? "").trim();
  const apiKey = (readEnv(LIVE_FEED_KEY_ENV) ?? "").trim();
  if (!baseUrl || !apiKey) return UNCONFIGURED_LIVE_FEED;
  return httpLiveFeedAdapter({ baseUrl, apiKey, ...(fetchImpl ? { fetchImpl } : {}) });
}
