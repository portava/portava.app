/**
 * Admin audit helpers — shared across all admin route files.
 *
 * logAdminAccess writes one row to admin_access_log for every admin read of a
 * private record (profile, event, trip, gps_event, check_in).
 *
 * Contract:
 *  - Never throws — a log write failure must never block a legitimate admin operation.
 *  - reason is taken from the X-Admin-Access-Reason request header when present.
 *  - For list queries use record_id = 'list'.
 *  - action_taken: 'view' (list/read), 'expand' (full detail), 'export'.
 */

export type AdminRecordType = "profile" | "event" | "trip" | "gps_event" | "check_in";
export type AdminActionTaken = "view" | "expand" | "export";

import { logger } from "./logger.js";

export async function logAdminAccess(
  sc: any,
  adminId: string,
  recordType: AdminRecordType,
  recordId: string,
  actionTaken: AdminActionTaken,
  reason: string | null,
): Promise<void> {
  try {
    // supabase-js RESOLVES (does not throw) on a DB error, so the insert result
    // must be checked — a bare await here silently punched holes in the admin
    // access audit trail. Still never throws (see contract above), but a failed
    // audit write is now visible in the server log instead of vanishing.
    const { error } = await sc.from("admin_access_log").insert({
      admin_id:     adminId,
      record_type:  recordType,
      record_id:    recordId,
      reason:       reason ?? null,
      action_taken: actionTaken,
      timestamp:    new Date().toISOString(),
    });
    if (error) {
      logger.warn({ err: error, adminId, recordType, recordId, actionTaken },
        "logAdminAccess: admin_access_log insert failed — audit trail has a hole");
    }
  } catch (err) {
    // Best-effort — never block a read on a log failure, but say so.
    logger.warn({ err, adminId, recordType, recordId }, "logAdminAccess: unexpected error");
  }
}

/** Convenience: extract the X-Admin-Access-Reason header value (or null). */
export function accessReason(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const h = req.headers["x-admin-access-reason"];
  return typeof h === "string" ? h : null;
}
