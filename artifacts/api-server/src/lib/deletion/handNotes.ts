/**
 * handNotes — the per-table facts a person had to look up, kept SEPARATE from
 * everything the parser measured so that no hand guess can be read as a
 * measurement.
 *
 * A note here does NOT change a table's candidate class and does not decide its
 * fate. It records something the mechanical passes cannot see, with the
 * evidence quoted so the next reader can check it rather than trust it.
 *
 * Deliberately short. Anything that can be measured belongs in schemaFacts.ts
 * or codeFacts.ts instead; the temptation to "explain" a table in prose here is
 * how a graph turns into an unverifiable opinion document.
 */

export interface HandNote {
  table: string;
  /** Where the claim can be checked. */
  evidence: string;
  note: string;
}

export const HAND_NOTES: readonly HandNote[] = [
  {
    table: "passport_stamps",
    evidence: "src/lib/deletionDispositions.ts (ERASED_BY_CASCADE comment on passport_stamps_gps)",
    note:
      "Its CHILD passport_stamps_gps cascades from auth.users and so is erased today, while the stamp row itself " +
      "survives. The parent and child therefore have different fates right now — the graph reports both, and the " +
      "asymmetry is a reason a fate for this table cannot be inferred from its child's.",
  },
  {
    table: "map_telemetry_events",
    evidence: "src/lib/deletionDispositions.ts (comment on wall_telemetry_events)",
    note:
      "Has NO foreign key at all, so nothing about account deletion reaches it. Recorded in the dispositions manifest " +
      "as a Map-lane defect rather than a pattern to copy.",
  },
  {
    table: "profiles",
    evidence: "src/services/accountDeletion/AccountDeletionService.ts step anonymise_profile",
    note:
      "The tombstone: the one row guaranteed to survive every deletion. Its anonymisation names twelve columns by " +
      "hand, so a column added later is retained by default. That is a drift risk the graph cannot see, because the " +
      "column list is in code rather than in the schema.",
  },
  {
    table: "passport_memories",
    evidence: "src/services/accountDeletion/AccountDeletionService.ts header, 'NOT COLLECTED, deliberately'",
    note:
      "photo_url points at stored bytes that are deliberately NOT collected today, because the ROW is not deleted " +
      "either. If this table is ever given an ERASE fate, the storage hook and the row delete must land in the same " +
      "change — either alone leaves the account half-erased.",
  },
  {
    table: "highlights",
    evidence: "src/services/accountDeletion/AccountDeletionService.ts header, 'NOT COLLECTED, deliberately'",
    note:
      "Same shape as passport_memories. Note the live inconsistency the service records: a story saved to a highlight " +
      "already has its BYTES removed by delete_stories, so a surviving highlight row can point at bytes that are gone.",
  },
  {
    table: "intel_evidence",
    evidence: "src/migrations/2173_intel_contribution_retention.sql, src/lib/intelRetentionScheduler.ts",
    note:
      "Governed by a 180-day retention sweep that runs through an RPC. The RPC scan measures this; it is repeated here " +
      "because the same table is ALSO erased per-actor by erase_intel_for_actor, and the two rules answer different " +
      "questions (how long anyone's evidence lives vs what happens when one person leaves).",
  },
];

const BY_TABLE = new Map(HAND_NOTES.map((n) => [n.table, n]));
export function handNoteFor(table: string): HandNote | undefined {
  return BY_TABLE.get(table);
}
