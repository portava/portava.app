/**
 * GET /api/admin/memory/metrics — spec §24's Memory metrics, for an admin
 * (census-highlights-memories H217 false_memory_rate, H222 do_again_conversion;
 * census §BK).
 *
 * This route is the export. There is no metrics exporter in this repository,
 * so the posture is the layover one (OQ-8): this route plus one structured log
 * line per metric. No exporter is bound.
 *
 *   quality  services/memory/memoryQualityMetrics.ts. The denominators are
 *            this process's own record (what the inbox showed, the Do Again
 *            plans served). The numerators are read from the database now:
 *            the kept Memory's stored values, and trip_saved_places.
 *   kernel   services/memory/memoryKernelMetrics.ts's in-process sample (the
 *            §24 counters H211–H216, H218). Before this route, nothing read it
 *            outside a test.
 *
 * ── WHAT IS NEVER REPORTED ──────────────────────────────────────────────────
 *   - A rate over nothing, or over a source that could not be read: either one
 *     is UNPRODUCIBLE, with the reason, and its count is null, not 0.
 *   - Any identifier. Counts and rates only: no owner, viewer, episode, Memory
 *     or place id leaves this route or its log line.
 * Both figures are PER PROCESS, since this process started. Another instance
 * has its own.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import {
  MEMORY_QUALITY_METRICS_ENGINE_VERSION,
  qualityMetricsLog,
  readDoAgainConversion,
  readFalseMemoryRate,
  recordQualityMetrics,
} from "../services/memory/memoryQualityMetrics.js";
import { readMemoryKernelMetrics } from "../services/memory/memoryKernelMetrics.js";

const router = Router();

router.get("/admin/memory/metrics", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const falseMemory = await readFalseMemoryRate(sc);
  const doAgain = await readDoAgainConversion(sc);
  recordQualityMetrics(qualityMetricsLog, [falseMemory, doAgain]);

  res.json({
    ok: true,
    scope: "this process, since it started — not aggregated across instances (no exporter is bound)",
    engineVersion: MEMORY_QUALITY_METRICS_ENGINE_VERSION,
    quality: {
      false_memory_rate: falseMemory,
      do_again_conversion: doAgain,
    },
    kernel: readMemoryKernelMetrics(),
  });
}));

export default router;
