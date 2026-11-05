import { getServiceClient } from './supabase.js';
import { logger } from './logger.js';
export const MAP_NAVIGATION_RETENTION_INTERVAL_MS = 60000;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let lastRun: { at: string; purged: number; ok: boolean } | null = null;
export const getMapNavigationRetentionStatus = () => lastRun;
/** Expired intent is never a feature input. Retention continues after collection is disabled. */
export async function runMapNavigationRetention(client: any = getServiceClient()): Promise<{ purged: number; ok: boolean }> {
  if (!client) return { purged: 0, ok: false };
  let purged = 0;
  try {
    // Each DB call deletes <=500 rows, rechecking expiry under row locks.
    for (let batch = 0; batch < 20; batch++) {
      const result = await client.rpc('purge_expired_map_navigation_contributions', { p_limit: 500 }).abortSignal(AbortSignal.timeout(5000));
      if (result.error || !Number.isInteger(result.data) || result.data < 0 || result.data > 500) throw new Error('navigation_retention_unavailable');
      purged += result.data; if (result.data < 500) break;
    }
    lastRun = { at: new Date().toISOString(), purged, ok: true }; return { purged, ok: true };
  } catch {
    lastRun = { at: new Date().toISOString(), purged, ok: false };
    logger.warn({ purged }, 'Map navigation retention could not finish'); return { purged, ok: false };
  }
}
export function startMapNavigationRetentionScheduler(): void {
  if (timer !== null) return;
  const runGeneration = ++generation;
  const tick = () => { void runMapNavigationRetention().finally(() => {
    if (timer !== null && generation === runGeneration) { timer = setTimeout(tick, MAP_NAVIGATION_RETENTION_INTERVAL_MS); timer.unref?.(); }
  }); };
  timer = setTimeout(tick, MAP_NAVIGATION_RETENTION_INTERVAL_MS); timer.unref?.();
}
export function stopMapNavigationRetentionScheduler(): void { generation++; if (timer !== null) clearTimeout(timer); timer = null; }
