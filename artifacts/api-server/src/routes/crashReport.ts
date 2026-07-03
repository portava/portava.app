import { Router } from "express";
import { z } from "zod";

const router = Router();

// ── Sliding-window rate limiter ───────────────────────────────────────────────

const WINDOW_MS   = 60_000;
const MAX_REPORTS = 10;

const _store = new Map<string, number[]>();

function checkRateLimit(key: string): boolean {
  const now  = Date.now();
  const cut  = now - WINDOW_MS;
  const hits = (_store.get(key) ?? []).filter((t) => t > cut);
  if (hits.length >= MAX_REPORTS) {
    _store.set(key, hits);
    return false;
  }
  hits.push(now);
  _store.set(key, hits);
  return true;
}

/** Test seam — clears the rate-limit store between test runs. */
export function _resetRateLimiter(): void {
  _store.clear();
}

// ── Schema ────────────────────────────────────────────────────────────────────

const CrashReportBody = z.object({
  timestamp:      z.string().optional(),
  errorMessage:   z.string().max(2000),
  errorStack:     z.string().max(10000).optional(),
  componentStack: z.string().max(10000),
  userId:         z.string().max(200).optional(),
});

/**
 * POST /crash-report
 *
 * Receives a client-side render crash from the mobile app's ErrorBoundary and
 * writes it to the server log so it appears in EAS build logs and any log
 * aggregator connected to the API server.
 *
 * No auth required — crashes may occur before the user has signed in.
 * Only the opaque userId is accepted; no email, name, or other PII.
 *
 * Rate limited to MAX_REPORTS per IP per WINDOW_MS to prevent log flooding
 * from devices stuck in a crash loop.
 */
router.post("/crash-report", (req, res) => {
  const key = (req.ip ?? "unknown").replace(/^::ffff:/, "");

  if (!checkRateLimit(key)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const parsed = CrashReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const { timestamp, errorMessage, errorStack, componentStack, userId } =
    parsed.data;

  req.log.error(
    { errorMessage, componentStack, userId, timestamp, errorStack },
    "client crash report",
  );

  res.json({ ok: true });
});

export default router;
