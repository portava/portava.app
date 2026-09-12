/**
 * safetyCandidateStore — the reads and the one write behind the safety
 * candidate stage (lib/safetyCandidate): which subjects to look at, which
 * candidates are already before the reviewers, filing one, and listing the
 * detector's own open questions. Every failure is a REFUSAL with a name.
 *
 * The queue is `moderation_reports` — the platform's existing review — and
 * the detector writes it exactly as routes/moderation.ts does for a person's
 * report, with `reporter_id` NULL because the reporter is the detector. The
 * service client writes (modrep_svc); no client role can read a row with no
 * reporter (the SELECT policies are `reporter_id = auth.uid()`), which is the
 * right answer: a candidate is for specialists, and GET /admin/moderation/
 * reports is where they read it. The client is injected; this module names
 * no credential.
 */
import {
  SAFETY_CANDIDATE_CATEGORY,
  SAFETY_CANDIDATE_SUBJECT_TYPE,
  candidateReportRow,
  parseCandidateDetails,
  type SafetyCandidate,
  type SafetyCandidateReason,
  type StoredCandidate,
} from "./safetyCandidate.js";

export const REPORTS_TABLE = "moderation_reports";
export const SNAPSHOTS_TABLE = "intel_state_snapshots";
/** Bounded sweep: the subjects currently served as packed. */
export const SWEEP_MAX_SUBJECTS = 200;
/** The queue states that mean "already before a reviewer". */
export const OPEN_REPORT_STATUSES: readonly string[] = ["open", "reviewing"];

export type SweepSubjectsResult = { ok: true; subjectIds: string[] } | { ok: false; reason: "no_client" | "error" };

/**
 * The subjects whose CURRENT crowd.level is served as `packed`: privacy-eligible,
 * unexpired snapshots only — the same two per-row gates the safety notice read
 * applies. This only chooses WHERE to look; the evidence itself is then read
 * through lib/liveClaimRead by the caller.
 */
export async function listSweepSubjects(sc: any, nowMs: number): Promise<SweepSubjectsResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc
      .from(SNAPSHOTS_TABLE)
      .select("subject_id")
      .eq("claim_type", "crowd.level")
      .eq("privacy_eligible", true)
      .gt("expires_at", new Date(nowMs).toISOString())
      .contains("value", { level: "packed" })
      .limit(SWEEP_MAX_SUBJECTS);
    if (error || !Array.isArray(data)) return { ok: false, reason: "error" };
    const ids = new Set<string>();
    for (const row of data as Array<{ subject_id?: unknown }>) if (typeof row?.subject_id === "string") ids.add(row.subject_id);
    return { ok: true, subjectIds: [...ids] };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type OpenCandidatesResult = { ok: true; reasons: Set<SafetyCandidateReason> } | { ok: false; reason: "no_client" | "error" };

/** The reasons already before a reviewer for this subject — open or reviewing, the detector's own rows. */
export async function openCandidateReasons(sc: any, subjectId: string): Promise<OpenCandidatesResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc
      .from(REPORTS_TABLE)
      .select("details, status")
      .eq("subject_type", SAFETY_CANDIDATE_SUBJECT_TYPE)
      .eq("subject_id", subjectId)
      .eq("category", SAFETY_CANDIDATE_CATEGORY)
      .in("status", OPEN_REPORT_STATUSES)
      .is("reporter_id", null);
    if (error || !Array.isArray(data)) return { ok: false, reason: "error" };
    const reasons = new Set<SafetyCandidateReason>();
    for (const row of data as Array<{ details?: unknown }>) {
      const parsed = parseCandidateDetails(row?.details);
      if (parsed) reasons.add(parsed.reason);
    }
    return { ok: true, reasons };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type FileCandidateResult = { ok: true; reportId: string } | { ok: false; reason: "no_client" | "error" };

/** File one candidate into the review queue. */
export async function fileCandidateReport(sc: any, candidate: SafetyCandidate): Promise<FileCandidateResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc.from(REPORTS_TABLE).insert(candidateReportRow(candidate)).select("id").single();
    if (error || !data || typeof (data as { id?: unknown }).id !== "string") return { ok: false, reason: "error" };
    return { ok: true, reportId: (data as { id: string }).id };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export interface OpenCandidateRow {
  reportId: string;
  subjectId: string;
  status: string;
  createdAt: string | null;
  candidate: StoredCandidate;
}

export type ListCandidatesResult = { ok: true; candidates: OpenCandidateRow[] } | { ok: false; reason: "no_client" | "error" };

/** The detector's own rows still before a reviewer, newest first. Rows it cannot parse are not its own. */
export async function listOpenCandidates(sc: any, limit: number): Promise<ListCandidatesResult> {
  if (!sc) return { ok: false, reason: "no_client" };
  try {
    const { data, error } = await sc
      .from(REPORTS_TABLE)
      .select("id, subject_id, details, status, created_at")
      .eq("subject_type", SAFETY_CANDIDATE_SUBJECT_TYPE)
      .eq("category", SAFETY_CANDIDATE_CATEGORY)
      .in("status", OPEN_REPORT_STATUSES)
      .is("reporter_id", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !Array.isArray(data)) return { ok: false, reason: "error" };
    const candidates: OpenCandidateRow[] = [];
    for (const row of data as Array<Record<string, unknown>>) {
      const parsed = parseCandidateDetails(row?.details);
      if (!parsed || typeof row.id !== "string" || typeof row.subject_id !== "string") continue;
      candidates.push({
        reportId: row.id,
        subjectId: row.subject_id,
        status: String(row.status ?? ""),
        createdAt: typeof row.created_at === "string" ? row.created_at : null,
        candidate: parsed,
      });
    }
    return { ok: true, candidates };
  } catch {
    return { ok: false, reason: "error" };
  }
}
