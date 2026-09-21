/**
 * The shape of the deletion dependency graph.
 *
 * Every field carries a provenance in `provenance.ts`. Three levels, and the
 * difference between them is load-bearing:
 *
 *   MEASURED       read out of the committed schema dump or the source tree.
 *                  Reproducible by anyone re-running the parser.
 *   RULE_DERIVED   a hand-written rule (signalRules.ts) applied mechanically to
 *                  every table. The rule is an opinion; its application is not.
 *   HAND           written per table by a person (handNotes.ts), with the
 *                  evidence quoted alongside.
 *
 * A candidate class is an ENGINEERING OBSERVATION about what the evidence
 * shows. It is NOT a deletion policy, it does not authorise anything, and the
 * planner never treats it as a decision — see `DeletionPolicy` in
 * services/accountDeletion/policy.ts.
 */
import type { SignalKey, ColumnRole } from "./signalRules.js";

export type OnDelete = "CASCADE" | "SET NULL" | "SET DEFAULT" | "RESTRICT" | "NO ACTION";

export interface UserColumnFact {
  column: string;
  /** MEASURED: the FK this column declares, or null when it declares none. */
  references: string | null;
  /** MEASURED: declared referential action, null when no FK backs the column. */
  onDelete: OnDelete | null;
  /** MEASURED: whether the column is NOT NULL (blocks a naive anonymisation). */
  notNull: boolean;
  /** RULE_DERIVED: how this column relates to the account being deleted. */
  role: ColumnRole;
  /**
   * MEASURED: which evidence found this column. "foreign-key" means the
   * manifest's USER_IDENTIFYING_COLUMNS name list does NOT contain it, so
   * check:deletion-coverage cannot see it.
   */
  discoveredBy: "manifest-name-list" | "foreign-key" | "both";
}

export type SelectExposure =
  | "NO_RLS"
  | "NO_SELECT_POLICY"
  | "UNCONDITIONAL_READ"
  | "OWNER_SCOPED"
  | "CONDITIONAL_SHARED";

export interface VisibilityFact {
  /** MEASURED */ rlsEnabled: boolean;
  /** MEASURED */ policyCount: number;
  /** MEASURED: SELECT/ALL policies reachable by a non-service role. */
  selectPolicies: string[];
  /** MEASURED (classified mechanically from the policy text). */
  exposure: SelectExposure;
  /** MEASURED: whether a non-owner can read a row through PostgREST today. */
  nonOwnerReadable: boolean;
  /** MEASURED: route modules that read the table — the "through what". */
  routeReaders: string[];
}

export interface SignalFact {
  key: SignalKey;
  /** The columns (or the table name) that triggered the rule. */
  evidence: string[];
}

export interface DerivativeFact {
  /** RULE_DERIVED: the table's name says it holds derived state. */
  nameSuggestsDerived: boolean;
  /** MEASURED: written only by background modules, never by a route. */
  writtenOnlyByBackground: boolean;
  /** MEASURED: parent tables this one references (FK), with the action. */
  parents: Array<{ table: string; column: string; onDelete: OnDelete }>;
  /**
   * The single record this table is a derivative OF, when one can be named:
   * the parent whose removal makes these rows meaningless. Null when the
   * evidence names none.
   */
  derivedFrom: string | null;
  /** MEASURED: derivative tables that read this one and would go stale. */
  staleProjections: string[];
}

export interface RetentionFact {
  /** MEASURED: timed sweeps that already delete from this table. */
  sweepers: string[];
  /** MEASURED: retention RPCs whose body deletes from it, and their callers. */
  rpcs: Array<{ fn: string; migration: string; callers: string[] }>;
  /** MEASURED: an expiry column exists on the table. */
  expiryColumns: string[];
  /** True when some rule other than account deletion already bounds these rows. */
  governedElsewhere: boolean;
}

export type PropagationMechanism =
  | "AUTH_USER_CASCADE"
  | "EXPLICIT_SCOPED_DELETE"
  | "REQUIRES_DECLARED_ERASURE"
  | "EXPLICIT_COLUMN_NULL"
  | "SCHEMA_CHANGE_REQUIRED"
  | "NO_ACTION";

export interface PropagationPlan {
  mechanism: PropagationMechanism;
  /** One line a reviewer can check. */
  detail: string;
  /** Children removed automatically by an ON DELETE CASCADE from this table. */
  cascadeChildren: string[];
  /** Children whose FK would BLOCK the delete (NO ACTION / RESTRICT). */
  blockingChildren: string[];
  /** Storage objects this fate leaves behind unless a storage hook runs. */
  storageColumns: string[];
  /** Projections this fate makes stale unless a projection hook runs. */
  projectionTargets: string[];
  /** Reasons this fate cannot be carried out as declared. */
  obstacles: string[];
}

/**
 * How a table is linked to a user account, measured from the foreign-key graph
 * of the committed baseline. See userLink.ts for the rule behind each class and
 * for why a column-name list could never produce this on its own.
 *
 * DIRECT / INDIRECT are MEASURED from declared constraints. DERIVED and
 * AMBIGUOUS are the classes that carry column-name or hand-registration
 * evidence, which is exactly why they are kept separate from the measured two.
 */
export type UserLinkClass =
  | "DIRECT_USER_LINKED"
  | "INDIRECT_USER_LINKED"
  | "DERIVED_USER_LINKED"
  | "AMBIGUOUS"
  | "NOT_USER_LINKED";

export interface UserLinkFact {
  table: string;
  linkClass: UserLinkClass;
  /** Why, in words a reviewer can check against the dump. Never empty. */
  reasons: string[];
  /** Ownership hops to a user root: 0 = direct, n = indirect. Null otherwise. */
  hops: number | null;
  /** The ownership path walked, child first, ending at the user root. */
  path: string[];
  /** In the deletion denominator: every class except NOT_USER_LINKED. */
  governed: boolean;
  /** MEASURED: present in the committed baseline dump. */
  inBaseline: boolean;
}

export type CandidateClass =
  | "DELETE_CANDIDATE"
  | "ANONYMIZE_CANDIDATE"
  | "LEGAL_RETENTION_CANDIDATE"
  | "SAFETY_RETENTION_CANDIDATE"
  | "FINANCIAL_RETENTION_CANDIDATE"
  | "DERIVED_REBUILDABLE"
  | "OWNER_REQUIRED";

export type StatedFate =
  | "ERASED_BY_CASCADE"
  | "ANONYMISED_FK_NULLED"
  | "DELETION_FLOW"
  | "RETAINED_WITH_REASON"
  | "UNCLASSIFIED_BACKLOG"
  | "NOT_IN_MANIFEST";

export interface DeletionGraphNode {
  table: string;
  /** MEASURED: present in the committed baseline dump. */
  inBaseline: boolean;
  /**
   * MEASURED + RULE_DERIVED: how the schema links this table to an account, and
   * why. This is what puts the table in the deletion denominator at all.
   */
  userLink: UserLinkFact;
  /** MEASURED: which bucket of deletionDispositions.ts names it. */
  statedFate: StatedFate;
  /**
   * MEASURED: the table carries a foreign key to profiles/auth.users but NONE
   * of the manifest's USER_IDENTIFYING_COLUMNS, so check:deletion-coverage does
   * not count it as user-keyed and cannot require a fate for it.
   */
  manifestCoverageGap: boolean;
  /** MEASURED */ userColumns: UserColumnFact[];
  /** RULE_DERIVED */ subjectColumns: string[];
  /** RULE_DERIVED */ counterpartyColumns: string[];
  /** RULE_DERIVED */ staffColumns: string[];
  /** RULE_DERIVED */ ambiguousColumns: string[];
  /** MEASURED + RULE_DERIVED (see SignalFact.evidence) */
  signals: SignalFact[];
  visibility: VisibilityFact;
  derivative: DerivativeFact;
  retention: RetentionFact;
  /** MEASURED: append-only / immutability triggers on the table. */
  guardTriggers: string[];
  /** MEASURED: production code that reads / writes it. */
  code: { reads: number; writes: number; deletes: number; routeReaders: string[] };
  propagation: { DELETE: PropagationPlan; ANONYMIZE: PropagationPlan; RETAIN: PropagationPlan };
  /** ENGINEERING OBSERVATION — never a policy. */
  candidate: CandidateClass;
  /** The specific evidence that produced `candidate`, in order. */
  candidateEvidence: string[];
  /** HAND: per-table note, when one was written. */
  handNote?: string;
}
