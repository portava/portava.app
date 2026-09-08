/**
 * buildDeletionGraph — assembles the deletion dependency graph out of the three
 * evidence sources, keeping them distinguishable in the output.
 *
 * The graph answers, for every user-keyed table: who owns the row, what it is a
 * derivative of, who can read it today, what kind of data it holds, what else
 * already governs it, and what the propagation mechanism WOULD be under each of
 * the three fates. It does not answer WHICH fate applies — that is owner
 * decision D6, and the classifier deliberately returns OWNER_REQUIRED wherever
 * the evidence stops.
 *
 * VACUITY IS A FAILURE MODE HERE, not a quiet zero: `buildDeletionGraph`
 * THROWS when the schema text yields no user-keyed tables, because a graph over
 * zero tables would let every downstream check pass by describing nothing.
 */
import {
  ERASED_BY_CASCADE,
  ANONYMISED_FK_NULLED,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  USER_IDENTIFYING_COLUMNS,
} from "../deletionDispositions.js";
import { parseSchemaFacts, type TableFacts } from "./schemaFacts.js";
import type { TableCodeUsage, RetentionRpcFact } from "./codeFacts.js";
import {
  SIGNAL_RULES,
  COLUMN_ROLES,
  DERIVATIVE_TABLE_PATTERNS,
  BACKGROUND_WRITER_PATTERNS,
  signalsForColumn,
  signalsForTableName,
  type SignalKey,
} from "./signalRules.js";
import { handNoteFor } from "./handNotes.js";
import { classifyCandidate } from "./candidateClass.js";
import type {
  DeletionGraphNode, OnDelete, PropagationPlan, SelectExposure, SignalFact, StatedFate, UserColumnFact,
} from "./types.js";

export interface BuildInput {
  /** Text of the schema-only dump. */
  sql: string;
  /** Output of scanCodeUsage(). Absent = an empty code index, and the graph says so. */
  code?: Map<string, TableCodeUsage>;
  /** Output of scanRetentionRpcs(). */
  retentionRpcs?: Map<string, RetentionRpcFact[]>;
  /**
   * Tables to include even though the baseline predates them. The manifest's
   * POST_BASELINE_TABLES are classified but invisible to the dump; including
   * them keeps the graph from silently omitting live tables.
   */
  extraTables?: readonly string[];
}

const EXPIRY_RE = /^(expires_at|expiry|expired_at|purge_after|delete_after|ttl|ttl_seconds|retention_until)$/;
const GUARD_TRIGGER_RE = /(append_only|no_delete|immutable|guard|readonly|read_only)/i;

function statedFate(table: string): StatedFate {
  if (ERASED_BY_CASCADE.includes(table)) return "ERASED_BY_CASCADE";
  if (ANONYMISED_FK_NULLED.includes(table)) return "ANONYMISED_FK_NULLED";
  if (DELETION_FLOW_TABLES.includes(table)) return "DELETION_FLOW";
  if (RETAINED_WITH_REASON.some((r) => r.table === table)) return "RETAINED_WITH_REASON";
  if (UNCLASSIFIED_BACKLOG.includes(table)) return "UNCLASSIFIED_BACKLOG";
  return "NOT_IN_MANIFEST";
}

/**
 * Classify PostgREST read exposure from the policies alone.
 *
 * service_role-only policies are excluded: the server always reads with the
 * service key, so a service_role policy says nothing about who else can see the
 * row. What matters for a deletion decision is whether a row about a departed
 * user remains visible to somebody ELSE.
 */
export function classifyExposure(facts: TableFacts): { exposure: SelectExposure; selectPolicies: string[] } {
  if (!facts.rlsEnabled) return { exposure: "NO_RLS", selectPolicies: [] };
  const readable = facts.policies.filter(
    (p) =>
      (p.command === "SELECT" || p.command === "ALL") &&
      !(p.roles.length > 0 && p.roles.every((r) => r === "service_role" || r === "postgres")),
  );
  const names = readable.map((p) => p.name);
  if (readable.length === 0) return { exposure: "NO_SELECT_POLICY", selectPolicies: names };
  const unconditional = readable.some((p) => (p.using ?? "").replace(/[()\s]/g, "") === "true");
  if (unconditional) return { exposure: "UNCONDITIONAL_READ", selectPolicies: names };
  const ownerScoped = readable.every((p) => {
    const u = p.using ?? "";
    return u.includes("auth.uid()") && !/EXISTS|public\.[a-z_]+\s*\(|IN \(\s*SELECT/i.test(u);
  });
  return { exposure: ownerScoped ? "OWNER_SCOPED" : "CONDITIONAL_SHARED", selectPolicies: names };
}

function isNotNull(type: string): boolean {
  return /\bNOT NULL\b/.test(type);
}

function propagationFor(
  facts: TableFacts | undefined,
  userColumns: UserColumnFact[],
  storageColumns: string[],
  projectionTargets: string[],
  guardTriggers: string[],
  signals: SignalFact[],
  retentionGoverned: boolean,
): DeletionGraphNode["propagation"] {
  const cascadeChildren = (facts?.referencedBy ?? []).filter((f) => f.onDelete === "CASCADE").map((f) => f.table);
  const blockingChildren = (facts?.referencedBy ?? [])
    .filter((f) => f.onDelete === "NO ACTION" || f.onDelete === "RESTRICT")
    .map((f) => f.table);

  const authCascade = userColumns.find((c) => c.references === "auth.users" && c.onDelete === "CASCADE");
  const profilesCascade = userColumns.filter((c) => c.references === "public.profiles" && c.onDelete === "CASCADE");

  const deleteObstacles: string[] = [];
  if (blockingChildren.length > 0) {
    deleteObstacles.push(
      `${new Set(blockingChildren).size} child table(s) reference it with NO ACTION/RESTRICT: ` +
        `${[...new Set(blockingChildren)].sort().join(", ")} — those rows must be handled first or the DELETE fails`,
    );
  }
  if (guardTriggers.length > 0) {
    deleteObstacles.push(`append-only guard trigger(s) ${guardTriggers.join(", ")} refuse DELETE outside a declared erasure`);
  }
  if (retentionGoverned) deleteObstacles.push("another retention rule already deletes from this table on a timer — the two must not disagree");
  if (storageColumns.length > 0) deleteObstacles.push(`stored objects referenced by ${storageColumns.join(", ")} outlive the row unless a storage hook runs`);

  let deleteMech: PropagationPlan["mechanism"];
  let deleteDetail: string;
  if (guardTriggers.length > 0) {
    deleteMech = "REQUIRES_DECLARED_ERASURE";
    deleteDetail = "DELETE is refused by an append-only trigger; it must run inside a declared erasure (SET LOCAL portava.erasure_in_progress) or through the erasure RPC.";
  } else if (authCascade) {
    deleteMech = "AUTH_USER_CASCADE";
    deleteDetail = `${authCascade.column} REFERENCES auth.users ON DELETE CASCADE, and the deletion removes the auth.users row — the rows go without service code.`;
  } else {
    deleteMech = "EXPLICIT_SCOPED_DELETE";
    deleteDetail =
      profilesCascade.length > 0
        ? `${profilesCascade.map((c) => c.column).join(", ")} declares ON DELETE CASCADE to public.profiles, but the deletion keeps an ANONYMISED TOMBSTONE profile, so that cascade never fires. An explicit scoped delete is required.`
        : `no cascade reaches this table; an explicit scoped delete keyed by ${userColumns.map((c) => c.column).join(", ") || "(no user column)"} is required.`;
  }

  const anonObstacles: string[] = [];
  const notNullUserCols = userColumns.filter((c) => c.notNull).map((c) => c.column);
  if (notNullUserCols.length > 0) {
    anonObstacles.push(`${notNullUserCols.join(", ")} is NOT NULL — it cannot be nulled without a schema change or a sentinel value`);
  }
  const residual = signals
    .filter((s) => (["preciseLocation", "contact", "identity", "messageContent", "media"] as SignalKey[]).includes(s.key))
    .map((s) => `${s.key} (${s.evidence.join(", ")})`);
  if (residual.length > 0) {
    anonObstacles.push(`nulling the identifier does not anonymise the row: ${residual.join("; ")} remain and can re-identify it`);
  }
  const anonMech: PropagationPlan["mechanism"] = notNullUserCols.length > 0 ? "SCHEMA_CHANGE_REQUIRED" : "EXPLICIT_COLUMN_NULL";
  const setNullCols = userColumns.filter((c) => c.onDelete === "SET NULL").map((c) => c.column);

  const retainObstacles: string[] = [];
  if (userColumns.length > 0) {
    retainObstacles.push(`the row stays joinable to the departed account by ${userColumns.map((c) => c.column).join(", ")}`);
  }
  if (!retentionGoverned) retainObstacles.push("no other rule bounds these rows, so retention here means INDEFINITE retention");

  return {
    DELETE: {
      mechanism: deleteMech,
      detail: deleteDetail,
      cascadeChildren: [...new Set(cascadeChildren)].sort(),
      blockingChildren: [...new Set(blockingChildren)].sort(),
      storageColumns,
      projectionTargets,
      obstacles: deleteObstacles,
    },
    ANONYMIZE: {
      mechanism: anonMech,
      detail:
        setNullCols.length > 0
          ? `${setNullCols.join(", ")} declares ON DELETE SET NULL, which the tombstone profile defeats: the service must perform the UPDATE ... SET ${setNullCols.join(" = NULL, ")} = NULL itself.`
          : `an explicit UPDATE ... SET ${userColumns.map((c) => c.column).join(" = NULL, ") || "(no user column)"} = NULL, keyed by the same column.`,
      cascadeChildren: [],
      blockingChildren: [],
      storageColumns,
      projectionTargets,
      obstacles: anonObstacles,
    },
    RETAIN: {
      mechanism: "NO_ACTION",
      detail: "nothing runs; the rows survive the account exactly as they are.",
      cascadeChildren: [],
      blockingChildren: [],
      storageColumns: [],
      projectionTargets: [],
      obstacles: retainObstacles,
    },
  };
}

export function buildDeletionGraph(input: BuildInput): DeletionGraphNode[] {
  const facts = parseSchemaFacts(input.sql);
  const code = input.code ?? new Map<string, TableCodeUsage>();
  const rpcs = input.retentionRpcs ?? new Map<string, RetentionRpcFact[]>();
  const userCols = new Set(USER_IDENTIFYING_COLUMNS);

  const isUserFk = (ref: string): boolean => ref === "public.profiles" || ref === "auth.users";
  const userFkColumns = (t: TableFacts): string[] =>
    [...new Set(t.foreignKeys.filter((k) => isUserFk(k.references)).flatMap((k) => k.columns))];

  const baselineUserKeyed = [...facts.values()]
    .filter((t) => t.columns.some((c) => userCols.has(c.name)) || userFkColumns(t).length > 0)
    .map((t) => t.table);
  if (baselineUserKeyed.length === 0) {
    throw new Error(
      "buildDeletionGraph: the schema text yielded ZERO user-keyed tables. " +
        "A graph over nothing would let every downstream check pass vacuously; refusing to build one.",
    );
  }

  const tableNames = [...new Set([...baselineUserKeyed, ...(input.extraTables ?? [])])].sort();

  // Which tables look like projections, for the staleness edge below.
  const projectionTables = new Set(
    [...facts.keys(), ...(input.extraTables ?? [])].filter((t) => DERIVATIVE_TABLE_PATTERNS.some((re) => re.test(t))),
  );

  const nodes: DeletionGraphNode[] = [];
  for (const table of tableNames) {
    const f = facts.get(table);
    const usage = code.get(table);
    const cols = f?.columns ?? [];

    // ── WHICH COLUMNS MAKE THIS TABLE USER-KEYED ─────────────────────────────
    // Two independent sources, and they DISAGREE:
    //   * the manifest's USER_IDENTIFYING_COLUMNS name list — what
    //     check:deletion-coverage uses;
    //   * a MEASURED foreign key to public.profiles or auth.users.
    // The second finds columns the first has never heard of (blocked_id,
    // target_user_id, reviewer_id, tagged_user_id …). Tables that only the FK
    // scan sees are flagged `manifestCoverageGap` below: they carry a user's
    // uuid and are invisible to the coverage gate.
    const fkUserCols = f ? userFkColumns(f) : [];
    const nameUserCols = cols.filter((c) => userCols.has(c.name)).map((c) => c.name);
    const allUserCols = [...new Set([...nameUserCols, ...fkUserCols])].sort();

    const userColumns: UserColumnFact[] = allUserCols.map((name) => {
      const col = cols.find((c) => c.name === name);
      const fk = (f?.foreignKeys ?? []).find((k) => k.columns.length === 1 && k.columns[0] === name && isUserFk(k.references));
      const anyFk = fk ?? (f?.foreignKeys ?? []).find((k) => k.columns.length === 1 && k.columns[0] === name);
      return {
        column: name,
        references: anyFk ? anyFk.references : null,
        onDelete: anyFk ? (anyFk.onDelete as OnDelete) : null,
        notNull: col ? isNotNull(col.type) : false,
        role: COLUMN_ROLES[name] ?? "ambiguous",
        discoveredBy: nameUserCols.includes(name)
          ? (fkUserCols.includes(name) ? "both" : "manifest-name-list")
          : "foreign-key",
      };
    });
    const manifestCoverageGap = nameUserCols.length === 0 && fkUserCols.length > 0;

    // Signals: column rules + table-name rules, each carrying its evidence.
    const byKey = new Map<SignalKey, string[]>();
    for (const c of cols) {
      for (const key of signalsForColumn(c.name)) {
        byKey.set(key, [...(byKey.get(key) ?? []), c.name]);
      }
    }
    for (const key of signalsForTableName(table)) {
      byKey.set(key, [...(byKey.get(key) ?? []), `table name "${table}"`]);
    }
    const signals: SignalFact[] = SIGNAL_RULES.filter((r) => byKey.has(r.key)).map((r) => ({
      key: r.key,
      evidence: byKey.get(r.key)!,
    }));

    const { exposure, selectPolicies } = f
      ? classifyExposure(f)
      : { exposure: "NO_SELECT_POLICY" as SelectExposure, selectPolicies: [] };
    const routeReaders = usage?.routeReaders ?? [];
    const nonOwnerReadable = exposure === "NO_RLS" || exposure === "UNCONDITIONAL_READ" || exposure === "CONDITIONAL_SHARED";

    // Derivative evidence.
    const parents = (f?.foreignKeys ?? [])
      .filter((k) => k.references.startsWith("public.") && k.references !== "public.profiles")
      .map((k) => ({ table: k.references.replace("public.", ""), column: k.columns.join(","), onDelete: k.onDelete as OnDelete }))
      .sort((a, b) => (a.table + a.column).localeCompare(b.table + b.column));
    const writers = usage?.writes ?? [];
    const writtenOnlyByBackground =
      writers.length > 0 &&
      writers.every((w) => !w.startsWith("src/routes/") && BACKGROUND_WRITER_PATTERNS.some((re) => re.test(w)));
    const nameSuggestsDerived = DERIVATIVE_TABLE_PATTERNS.some((re) => re.test(table));
    const cascadeParents = parents.filter((p) => p.onDelete === "CASCADE");
    const derivedFrom =
      nameSuggestsDerived || writtenOnlyByBackground
        ? (cascadeParents[0]?.table ?? parents[0]?.table ?? null)
        : null;

    // Projections that read this table and would go stale without it.
    const readers = new Set(usage?.reads ?? []);
    const staleProjections = [...projectionTables]
      .filter((p) => p !== table)
      .filter((p) => (code.get(p)?.writes ?? []).some((w) => readers.has(w)))
      .sort();

    const retentionSweepers = usage?.retentionSweepers ?? [];
    const retentionRpcs = (rpcs.get(table) ?? []).map((r) => ({ fn: r.fn, migration: r.migration, callers: r.callers }));
    const expiryColumns = cols.filter((c) => EXPIRY_RE.test(c.name)).map((c) => c.name);
    const governedElsewhere = retentionSweepers.length > 0 || retentionRpcs.length > 0;

    const guardTriggers = (f?.triggers ?? []).filter((t) => GUARD_TRIGGER_RE.test(t));
    const storageColumns = signals.find((s) => s.key === "media")?.evidence.filter((e) => !e.startsWith("table name")) ?? [];

    const node: DeletionGraphNode = {
      table,
      inBaseline: Boolean(f),
      statedFate: statedFate(table),
      manifestCoverageGap,
      userColumns,
      subjectColumns: userColumns.filter((c) => c.role === "subject").map((c) => c.column),
      counterpartyColumns: userColumns.filter((c) => c.role === "counterparty").map((c) => c.column),
      staffColumns: userColumns.filter((c) => c.role === "staff_actor").map((c) => c.column),
      ambiguousColumns: userColumns.filter((c) => c.role === "ambiguous").map((c) => c.column),
      signals,
      visibility: {
        rlsEnabled: f?.rlsEnabled ?? false,
        policyCount: f?.policies.length ?? 0,
        selectPolicies,
        exposure,
        nonOwnerReadable,
        routeReaders,
      },
      derivative: { nameSuggestsDerived, writtenOnlyByBackground, parents, derivedFrom, staleProjections },
      retention: { sweepers: retentionSweepers, rpcs: retentionRpcs, expiryColumns, governedElsewhere },
      guardTriggers,
      code: {
        reads: usage?.reads.length ?? 0,
        writes: usage?.writes.length ?? 0,
        deletes: usage?.deletes.length ?? 0,
        routeReaders,
      },
      propagation: propagationFor(f, userColumns, storageColumns, staleProjections, guardTriggers, signals, governedElsewhere),
      candidate: "OWNER_REQUIRED",
      candidateEvidence: [],
    };

    const verdict = classifyCandidate(node);
    node.candidate = verdict.candidate;
    node.candidateEvidence = verdict.evidence;
    const hand = handNoteFor(table);
    if (hand) node.handNote = `${hand.note} [evidence: ${hand.evidence}]`;

    nodes.push(node);
  }

  return nodes;
}

/** Candidate-class counts, for reporting. Deterministic key order. */
export function candidateCounts(nodes: readonly DeletionGraphNode[]): Record<string, number> {
  const out: Record<string, number> = {
    DELETE_CANDIDATE: 0, ANONYMIZE_CANDIDATE: 0, LEGAL_RETENTION_CANDIDATE: 0,
    SAFETY_RETENTION_CANDIDATE: 0, FINANCIAL_RETENTION_CANDIDATE: 0,
    DERIVED_REBUILDABLE: 0, OWNER_REQUIRED: 0,
  };
  for (const n of nodes) out[n.candidate] += 1;
  return out;
}
