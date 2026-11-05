/**
 * The app-level per-IP rate limit (sec/public-surface, 2026-11-04).
 *
 * WHY
 * Before this, a limiter existed only on a few routes: reports, mutes and
 * moderation reports (per user), crash reports, sign-up and lookup-username
 * (per IP). Everything else that answers without a token (signup-status,
 * feature-flags, the share pages, the association files, the landing page)
 * had none. Those per-IP limiters also counted the wrong thing: with no
 * `trust proxy`, req.ip was the platform proxy's address (lib/clientIp.ts).
 *
 * WHAT IS COUNTED: every request that reaches app.ts's mount point, per client
 * address (req.ip under lib/clientIp.ts's trust rule; IPv6 per /56), in one of
 * three per-minute budgets:
 *
 *   tier     what                                   env                               default
 *   read     no bearer token, GET / HEAD / OPTIONS  PUBLIC_RATE_LIMIT_READ_PER_MIN      600
 *   write    no bearer token, any other method      PUBLIC_RATE_LIMIT_WRITE_PER_MIN      60
 *   bearer   carries `Authorization: Bearer …`      PUBLIC_RATE_LIMIT_BEARER_PER_MIN   3000
 *
 * 0 switches a tier off. A busy share page costs one request per viewer, the
 * landing page a few dozen, so `read` is far above anything a person or a
 * link-preview crawler does in a minute; `write` covers sign-up, username
 * lookup and crash reports, each of which also keeps its own tighter limiter.
 *
 * WHY BEARER REQUESTS ARE COUNTED, AND PER ADDRESS RATHER THAN PER USER
 * This runs before authentication, so the token here is unverified. Leaving
 * bearer requests uncounted would let anyone skip the anonymous budget by
 * sending `Authorization: Bearer x`. Keying them on the token's subject would
 * let a caller mint a fresh bucket per request with a made-up token. So they
 * are counted by address too, under a ceiling five times the anonymous one: a
 * signed-in app is chattier than a share page, and several travellers can sit
 * behind one hotel or airport NAT. It is a flood ceiling, not a product quota;
 * per-user limits stay where they are (lib/rateLimit.ts and the routes).
 *
 * NOT COUNTED
 *   - health checks: /api/healthz, /api/healthz/*, /healthz, /healthz/*, so a
 *     monitor is never refused;
 *   - provider webhooks (LiveKit, identity, payments): app.ts registers them
 *     BEFORE this middleware, so they never reach it;
 *   - CORS preflights: the cors middleware answers them before this runs;
 *   - a request whose address is not public (loopback, private, link-local,
 *     CGNAT) once lib/clientIp.ts has peeled the trusted proxies. That is a
 *     caller inside the deployment's own network, or a proxy chain the trust
 *     rule cannot see through; counting it would put every such caller in ONE
 *     bucket. It is logged once per process (`public_rate_limit_unattributable`).
 *
 * ACROSS INSTANCES: built on lib/rateLimit.ts checkRateLimit, so counts are
 * per instance in memory and shared through Redis when REDIS_URL is set. With N
 * instances and no Redis a client gets up to N times the budget, which is fine
 * for a ceiling against floods; an exact cross-instance limit belongs in the
 * database, as that file says.
 *
 * THE REFUSAL: 429 `rate_limited` through sendError, the flat envelope every
 * route uses, with Retry-After in whole seconds.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { checkRateLimit, sweepRateLimitBuckets } from "./rateLimit.js";
import { sendError } from "./http.js";
import { clientAddressKey, describeAddressChain, isPublicAddress } from "./clientIp.js";
import { logger } from "./logger.js";

export const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;

export type PublicRateLimitTier = "read" | "write" | "bearer";

/** One limiter id per tier, so the three budgets never share a bucket. */
export const PUBLIC_RATE_LIMIT_IDS: Record<PublicRateLimitTier, string> = {
  read: "public_read",
  write: "public_write",
  bearer: "public_bearer",
};

export interface PublicRateLimitBudgets {
  readPerMin: number;
  writePerMin: number;
  bearerPerMin: number;
  /**
   * true = an over-budget request is refused with 429. false = it is SERVED and
   * logged as `public_rate_limit_observed`. From the environment this is false
   * unless PUBLIC_RATE_LIMIT_MODE=enforce: the production proxy chain has not been
   * measured (see lib/clientIp.ts), and if it collapsed every caller onto one
   * address an enforcing limiter would refuse everyone. Read the
   * `client_ip_chain` and `public_rate_limit_observed` lines first, then enforce.
   */
  enforce: boolean;
}

export const DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS: PublicRateLimitBudgets = {
  readPerMin: 600,
  writePerMin: 60,
  bearerPerMin: 3000,
  enforce: false,
};

/** A budget from the environment: blank → the default, a whole number ≥ 0 → itself (0 = off), anything else → the default. */
function parseBudget(raw: string | undefined, fallback: number): number {
  const v = (raw ?? "").trim();
  if (!/^\d+$/.test(v)) return fallback;
  return Number(v);
}

export function publicRateLimitBudgets(env: NodeJS.ProcessEnv = process.env): PublicRateLimitBudgets {
  return {
    readPerMin: parseBudget(env["PUBLIC_RATE_LIMIT_READ_PER_MIN"], DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS.readPerMin),
    writePerMin: parseBudget(env["PUBLIC_RATE_LIMIT_WRITE_PER_MIN"], DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS.writePerMin),
    bearerPerMin: parseBudget(env["PUBLIC_RATE_LIMIT_BEARER_PER_MIN"], DEFAULT_PUBLIC_RATE_LIMIT_BUDGETS.bearerPerMin),
    enforce: (env["PUBLIC_RATE_LIMIT_MODE"] ?? "").trim().toLowerCase() === "enforce",
  };
}

/** Health checks are never counted, so a monitor can never be refused. */
export function isRateLimitExemptPath(path: string): boolean {
  return path === "/api/healthz" || path.startsWith("/api/healthz/") || path === "/healthz" || path.startsWith("/healthz/");
}

/** Which budget a request draws on. The bearer test is lib/http.ts requireUser's own. */
export function publicRateLimitTier(req: Pick<Request, "method" | "headers">): PublicRateLimitTier {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ") && auth.slice(7).trim() !== "") return "bearer";
  return req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" ? "read" : "write";
}

// ── Operator signals: bounded, address-free ───────────────────────────────────

/** How many X-Forwarded-For chain shapes each process logs (lib/clientIp.ts NOT MEASURED). */
const CHAIN_SAMPLES = 3;
let chainSamplesLogged = 0;
let unattributableLogged = false;
const REFUSAL_LOG_EVERY_MS = 10_000;
const lastRefusalLog: Record<PublicRateLimitTier, number> = { read: 0, write: 0, bearer: 0 };
const suppressedRefusals: Record<PublicRateLimitTier, number> = { read: 0, write: 0, bearer: 0 };
let lastSweepAt = 0;

/** Test seam: forget what has been logged and swept. Buckets are cleared with rateLimit.ts _resetRateLimit(). */
export function _resetPublicRateLimitState(): void {
  chainSamplesLogged = 0;
  unattributableLogged = false;
  lastSweepAt = 0;
  for (const t of Object.keys(lastRefusalLog) as PublicRateLimitTier[]) {
    lastRefusalLog[t] = 0;
    suppressedRefusals[t] = 0;
  }
}

function logOf(req: Request) {
  return (req as Request & { log?: typeof logger }).log ?? logger;
}

/** The app-level limiter. `budgets` defaults to the environment's (publicRateLimitBudgets). */
export function publicRateLimit(budgets: PublicRateLimitBudgets = publicRateLimitBudgets()): RequestHandler {
  const limits: Record<PublicRateLimitTier, number> = {
    read: budgets.readPerMin,
    write: budgets.writePerMin,
    bearer: budgets.bearerPerMin,
  };

  return function publicRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (isRateLimitExemptPath(req.path)) return next();

    const tier = publicRateLimitTier(req);
    const limit = limits[tier];
    if (limit <= 0) return next();

    const now = Date.now();
    if (now - lastSweepAt >= PUBLIC_RATE_LIMIT_WINDOW_MS) {
      lastSweepAt = now;
      for (const id of Object.values(PUBLIC_RATE_LIMIT_IDS)) sweepRateLimitBuckets(id, PUBLIC_RATE_LIMIT_WINDOW_MS, now);
    }

    const ip = req.ip;
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && chainSamplesLogged < CHAIN_SAMPLES) {
      chainSamplesLogged++;
      logOf(req).info(
        { event: "client_ip_chain", trustProxy: req.app?.get?.("trust proxy"), ...describeAddressChain(xff, req.socket?.remoteAddress, ip) },
        "client address derivation sample (shapes only; see lib/clientIp.ts)",
      );
    }

    if (!ip || !isPublicAddress(ip)) {
      if (!unattributableLogged) {
        unattributableLogged = true;
        logOf(req).info(
          { event: "public_rate_limit_unattributable" },
          "public rate limit: a request's client address is not public after peeling trusted proxies, so it is not counted (logged once per process)",
        );
      }
      return next();
    }

    const result = checkRateLimit(PUBLIC_RATE_LIMIT_IDS[tier], clientAddressKey(ip), limit, PUBLIC_RATE_LIMIT_WINDOW_MS);
    if (result.allowed) return next();

    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    if (now - lastRefusalLog[tier] >= REFUSAL_LOG_EVERY_MS) {
      logOf(req).warn(
        { event: budgets.enforce ? "public_rate_limited" : "public_rate_limit_observed", tier, limit, retryAfterSec, suppressedSinceLast: suppressedRefusals[tier] },
        budgets.enforce ? "public rate limit: refused" : "public rate limit: over budget, SERVED (observe mode; PUBLIC_RATE_LIMIT_MODE=enforce refuses)",
      );
      lastRefusalLog[tier] = now;
      suppressedRefusals[tier] = 0;
    } else {
      suppressedRefusals[tier]++;
    }
    if (!budgets.enforce) return next();
    res.setHeader("Retry-After", String(retryAfterSec));
    sendError(res, "rate_limited", "Too many requests. Please try again later.");
  };
}
