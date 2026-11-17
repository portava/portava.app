/** Receipt fixture for HTTP tests. Real SQL authorization/rollback proof lives
 * in postcardCaptureUpload.db.test.ts; this is not a SQL transaction emulator. */
export function adminPostcardWithdrawalReceipt(
  tables: Record<string, Record<string, unknown>[]>,
  args: Record<string, unknown>,
) {
  const row = tables.post_media?.find(item => item.id === args.p_media && item.post_id === args.p_post);
  if (!row || typeof args.p_admin_reason !== 'string' || !args.p_admin_reason.trim()) return { data: false, error: null };
  if (!row.deleted_at) {
    const snapshot = { processing_status: row.processing_status, moderation_status: row.moderation_status, public_url: row.public_url };
    const report = args.p_report_id;
    (tables.moderation_actions ??= []).push({ target_user_id: row.user_id, performed_by: args.p_actor,
      action_type: 'content_removed', reason: args.p_admin_reason, report_id: report ?? null,
      metadata: { target: 'post_media', target_id: row.id, retained: true,
        ...(report ? { report_id: report, report_table: 'moderation_reports' } : {}) } });
    Object.assign(row, { deleted_at: new Date().toISOString(), processing_status: 'pending', public_url: '',
      thumbnail_url: null, feed_url: null, recovery_snapshot: snapshot });
  }
  return { data: true, error: null };
}
