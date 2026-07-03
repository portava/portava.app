import { Router } from "express";
import { z } from "zod";

const router = Router();

const CrashReportBody = z.object({
  timestamp: z.string().optional(),
  errorMessage: z.string().max(2000),
  errorStack: z.string().max(10000).optional(),
  componentStack: z.string().max(10000),
  userId: z.string().max(200).optional(),
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
 */
router.post("/crash-report", (req, res) => {
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
