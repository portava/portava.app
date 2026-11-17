/** Compatibility entry for retired automatic deletion callers.
 * Deleted profiles remain recoverable until an explicit admin permanently
 * deletes them. No flag, elapsed date or cron call authorizes erasure. */
export async function processDueDeletions() {
  return { considered: 0, executed: 0, failed: 0, skipped: true, reason: 'admin_permanent_deletion_required' };
}
