import { getServiceClient } from './supabase.js';
import { logger } from './logger.js';
import type { SweepResult } from './intelRetentionScheduler.js';
/** Proposed Q11(a) 30-day ceiling; SQL checks the separately disabled review gate.
 * Runs in the EXISTING retention pass registry; no new timer or app poller. */
export async function runMediaEventRetentionSweep(opts: { client?: unknown } = {}): Promise<SweepResult> {
  const sc = ('client' in opts ? opts.client : getServiceClient()) as any;
  if (!sc) return { purged: 0, skipped: true, reason: 'no_client' };
  let purged = 0;
  try {
    for (let pass = 0; pass < 10; pass++) {
      const { data, error } = await sc.rpc('purge_expired_media_events', { p_limit: 500 });
      if (error || !data || typeof data.enabled !== 'boolean' || typeof data.more !== 'boolean' || !Number.isInteger(data.deleted) || data.deleted < 0 || data.deleted > 500) throw new Error('retention_receipt_unreadable');
      if (!data.enabled) return { purged, skipped: true, reason: 'disabled' };
      purged += data.deleted;
      if (!data.more) return { purged, skipped: false, reason: null };
      if (data.deleted === 0) break;
    }
    logger.warn({ purged }, 'Media event retention backlog remains');
  } catch { logger.warn({ purged }, 'Media event retention unconfirmed'); }
  return { purged, skipped: true, reason: 'error' };
}
