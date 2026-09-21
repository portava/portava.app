/**
 * candidateClass — an ENGINEERING OBSERVATION about what the evidence shows,
 * and explicitly NOT the deletion policy.
 *
 * ── THE RULE THAT MATTERS ───────────────────────────────────────────────────
 * `OWNER_REQUIRED` is the DEFAULT and the honest answer whenever the evidence
 * does not decide. Every other class must be REACHED by evidence, and any
 * conflicting signal sends the table back to OWNER_REQUIRED. The count of
 * OWNER_REQUIRED tables is a measurement of how much of this system nobody has
 * decided yet; a change that shrinks it by loosening a rule here has falsified
 * the measurement, not improved the system.
 *
 * Nothing downstream may treat a candidate class as permission to act. The
 * planner resolves a table's fate from the POLICY (services/accountDeletion/
 * policy.ts) and from the committed dispositions manifest — never from here.
 */
import type { DeletionGraphNode, CandidateClass, SignalFact } from "./types.js";

const has = (signals: SignalFact[], key: string): boolean => signals.some((s) => s.key === key);

export interface CandidateVerdict {
  candidate: CandidateClass;
  evidence: string[];
}

/**
 * Classify one node. Order matters: the retention classes are tested first,
 * because a table that is BOTH a user's own content and a safety record is a
 * conflict, and the conflict must not be resolved silently in favour of
 * deletion.
 */
export function classifyCandidate(node: DeletionGraphNode): CandidateVerdict {
  const ev: string[] = [];
  const sig = node.signals;

  // ── Already-stated fates. These are not predictions: the manifest says what
  // happens today and the service implements it. Reporting them as anything
  // else would hide behaviour that already exists.
  if (node.statedFate === "ERASED_BY_CASCADE") {
    return { candidate: "DELETE_CANDIDATE", evidence: ["already erased by AccountDeletionService (ERASED_BY_CASCADE)"] };
  }
  if (node.statedFate === "ANONYMISED_FK_NULLED") {
    return { candidate: "ANONYMIZE_CANDIDATE", evidence: ["already anonymised in place (ANONYMISED_FK_NULLED)"] };
  }
  if (node.statedFate === "DELETION_FLOW") {
    return {
      candidate: "LEGAL_RETENTION_CANDIDATE",
      evidence: ["the deletion flow's own record (DELETION_FLOW_TABLES): erasing it would erase the evidence the deletion happened"],
    };
  }
  if (node.statedFate === "RETAINED_WITH_REASON") {
    return { candidate: "LEGAL_RETENTION_CANDIDATE", evidence: ["a decided retention with a written reason (RETAINED_WITH_REASON)"] };
  }

  const financial = has(sig, "financial");
  const safety = has(sig, "moderationSafety");
  const legal = has(sig, "legalEvidence");
  const audit = has(sig, "adminAudit");
  const trust = has(sig, "trust");
  const personal =
    has(sig, "preciseLocation") || has(sig, "contact") || has(sig, "identity") || has(sig, "messageContent") || has(sig, "media");

  // ── Retention-shaped evidence. Note these are CANDIDATES for retention, not
  // rulings that the data must be kept: each still needs a stated purpose and a
  // window, which is precisely the owner's call.
  if (financial) {
    ev.push(`financial signal: ${sig.find((s) => s.key === "financial")!.evidence.join(", ")}`);
    return { candidate: "FINANCIAL_RETENTION_CANDIDATE", evidence: ev };
  }
  if (safety) {
    ev.push(`safety/moderation signal: ${sig.find((s) => s.key === "moderationSafety")!.evidence.join(", ")}`);
    return { candidate: "SAFETY_RETENTION_CANDIDATE", evidence: ev };
  }
  if (legal) {
    ev.push(`legal-evidence signal: ${sig.find((s) => s.key === "legalEvidence")!.evidence.join(", ")}`);
    return { candidate: "LEGAL_RETENTION_CANDIDATE", evidence: ev };
  }

  // ── Rebuildable derived state. Requires BOTH a named source record and the
  // absence of anything a rebuild could not reproduce. A cache holding the only
  // copy of a message is not rebuildable, whatever its name says.
  if (node.derivative.derivedFrom && !personal && !trust) {
    ev.push(`derivative of ${node.derivative.derivedFrom}`);
    if (node.derivative.nameSuggestsDerived) ev.push("table name states derived state");
    if (node.derivative.writtenOnlyByBackground) ev.push("written only by background modules, never by a route");
    ev.push("no precise-location / contact / identity / message / media column that a rebuild could not reproduce");
    return { candidate: "DERIVED_REBUILDABLE", evidence: ev };
  }

  // ── Anonymisation-shaped: the ROW is about something else (a trip, a place,
  // a programme) and the only person-shaped column is a nullable staff actor.
  const onlyStaff =
    node.staffColumns.length > 0 && node.subjectColumns.length === 0 && node.counterpartyColumns.length === 0 && node.ambiguousColumns.length === 0;
  if (onlyStaff && !personal) {
    const nullable = node.userColumns.every((c) => !c.notNull);
    if (nullable) {
      ev.push(`only user-shaped columns are staff actors (${node.staffColumns.join(", ")}), all nullable`);
      ev.push("no personal-data signal on the row itself");
      return { candidate: "ANONYMIZE_CANDIDATE", evidence: ev };
    }
    ev.push(`staff-actor column(s) ${node.staffColumns.join(", ")} are NOT NULL — nulling them needs a schema change`);
    return { candidate: "OWNER_REQUIRED", evidence: ev };
  }

  // ── Deletion-shaped: strictly one person's own row, nobody else named on it,
  // nothing else already governing it, and no non-owner can read it today.
  const singleSubject =
    node.subjectColumns.length >= 1 &&
    node.counterpartyColumns.length === 0 &&
    node.staffColumns.length === 0 &&
    node.ambiguousColumns.length === 0;
  if (singleSubject && !trust && !audit && !node.visibility.nonOwnerReadable && !node.retention.governedElsewhere) {
    ev.push(`single subject column (${node.subjectColumns.join(", ")}), no counterparty, no staff actor`);
    ev.push(`RLS exposure ${node.visibility.exposure}: no non-owner read path through PostgREST`);
    ev.push("no trust, audit, financial, safety or legal signal");
    return { candidate: "DELETE_CANDIDATE", evidence: ev };
  }

  // ── Everything else is undecided, and says why.
  if (node.counterpartyColumns.length > 0) ev.push(`names a counterparty (${node.counterpartyColumns.join(", ")}): erasing the row edits another user's record`);
  if (node.ambiguousColumns.length > 0) ev.push(`role of ${node.ambiguousColumns.join(", ")} is table-dependent — subject or staff cannot be told apart by name`);
  if (node.staffColumns.length > 0 && node.subjectColumns.length > 0) ev.push("carries both a subject and a staff actor");
  if (trust) ev.push("feeds the Trust system: the fate changes other users' limits");
  if (audit) ev.push("admin/audit shaped");
  if (node.visibility.nonOwnerReadable) ev.push(`readable by a non-owner today (${node.visibility.exposure})`);
  if (node.retention.governedElsewhere) ev.push("another retention rule already bounds these rows; deletion policy must say which wins");
  if (node.subjectColumns.length === 0 && node.staffColumns.length === 0 && node.counterpartyColumns.length === 0)
    ev.push("no user column whose role the rules can name");
  if (ev.length === 0) ev.push("no rule reached a confident class on the available evidence");
  return { candidate: "OWNER_REQUIRED", evidence: ev };
}
