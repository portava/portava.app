/**
 * provenance — the machine-readable answer to "is this field a measurement or a
 * guess?", for every field of a DeletionGraphNode.
 *
 * This exists because the graph mixes three kinds of claim and a reader cannot
 * tell them apart by looking at the JSON. A field declared MEASURED can be
 * re-derived by anyone from the artefact named in `source`; a RULE_DERIVED
 * field is a hand-written rule applied mechanically; a HAND field is one
 * person's reading, with its evidence quoted.
 *
 * deletionGraph.test.ts asserts this table names EVERY field the graph emits,
 * so a new field cannot be added without saying where it came from.
 */
export type Provenance = "MEASURED" | "RULE_DERIVED" | "HAND";

export interface FieldProvenance {
  field: string;
  provenance: Provenance;
  /** What it was measured FROM, or which rule produced it. */
  source: string;
}

export const FIELD_PROVENANCE: readonly FieldProvenance[] = [
  { field: "table", provenance: "MEASURED", source: "CREATE TABLE statements in the baseline dump" },
  { field: "inBaseline", provenance: "MEASURED", source: "presence in the baseline dump" },
  { field: "statedFate", provenance: "MEASURED", source: "which bucket of lib/deletionDispositions.ts names the table" },
  { field: "manifestCoverageGap", provenance: "MEASURED", source: "has an FK to profiles/auth.users but no USER_IDENTIFYING_COLUMNS column" },
  { field: "userColumns", provenance: "MEASURED", source: "columns + FOREIGN KEY constraints in the dump (role sub-field is RULE_DERIVED)" },
  { field: "subjectColumns", provenance: "RULE_DERIVED", source: "signalRules.COLUMN_ROLES applied to the measured columns" },
  { field: "counterpartyColumns", provenance: "RULE_DERIVED", source: "signalRules.COLUMN_ROLES" },
  { field: "staffColumns", provenance: "RULE_DERIVED", source: "signalRules.COLUMN_ROLES" },
  { field: "ambiguousColumns", provenance: "RULE_DERIVED", source: "signalRules.COLUMN_ROLES — the default for any column the rules do not name" },
  { field: "signals", provenance: "RULE_DERIVED", source: "signalRules.SIGNAL_RULES matched against measured column and table names; `evidence` lists the matches" },
  { field: "visibility", provenance: "MEASURED", source: "ALTER TABLE … ENABLE ROW LEVEL SECURITY + CREATE POLICY text; routeReaders from the src/routes scan" },
  { field: "derivative", provenance: "MEASURED", source: "FOREIGN KEY parents measured; nameSuggestsDerived and writtenOnlyByBackground are RULE_DERIVED from signalRules patterns" },
  { field: "retention", provenance: "MEASURED", source: "timed sweepers found by the code scan; RPC retention read out of src/migrations function bodies; expiry columns from the dump" },
  { field: "guardTriggers", provenance: "MEASURED", source: "CREATE TRIGGER statements in the dump, filtered by name" },
  { field: "code", provenance: "MEASURED", source: "lexical scan of .from(\"table\") call sites — a FLOOR, never proof of absence" },
  { field: "propagation", provenance: "MEASURED", source: "derived arithmetically from the measured FKs, triggers, NOT NULL flags and signals; no judgement about which fate applies" },
  { field: "candidate", provenance: "RULE_DERIVED", source: "candidateClass.classifyCandidate — an ENGINEERING OBSERVATION, never a policy" },
  { field: "candidateEvidence", provenance: "RULE_DERIVED", source: "the specific evidence the classifier used" },
  { field: "handNote", provenance: "HAND", source: "handNotes.ts, each with the file it can be checked against" },
] as const;
