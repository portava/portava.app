/** Authenticated Layover metrics report and Prometheus scrape. All producers
 * share LayoverMetricsReport; partial or unavailable windows have no value. */
import { Router } from 'express';
import { sendError } from '../lib/http.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAdmin } from '../lib/requireAdmin.js';
import { readLayoverMetricsReport, metricsWindowDays } from '../services/airport/LayoverMetricsReport.js';
import { renderPrometheusText } from '../lib/providers/metricsExporter.js';
export { EVENT_WINDOW_LIMIT, METRICS_MAX_DAYS, METRICS_DEFAULT_DAYS, CONTRACT_EVENT_LIMIT, metricsWindowDays } from '../services/airport/LayoverMetricsReport.js';
const router = Router();
router.get('/admin/layover/metrics', asyncHandler(async (req,res)=>{
  const admin=await requireAdmin(req,res);if(!admin)return;
  const report=await readLayoverMetricsReport(admin.sc,{days:metricsWindowDays(req.query?.days)});
  if(!report.ok){sendError(res,'degraded_unavailable',report.message);return;}
  if(req.query?.format==='prometheus') {
    res.type('text/plain; version=0.0.4').send(renderPrometheusText(report.metrics,{prefix:'portava_layover_',windowed:true,labels:{window_days:String(report.window.days)}}).text);return;
  }
  res.json(report);
}));
export default router;
