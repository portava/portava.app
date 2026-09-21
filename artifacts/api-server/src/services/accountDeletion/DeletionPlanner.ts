/**
 * The deletion planner.
 *
 * Turns the dependency graph plus a policy into an ORDERED, DETERMINISTIC list
 * of actions for one user — and, far more often today, into a refusal that
 * names every table nobody has decided about.
 *
 * ── WHAT "ORDERED" MEANS HERE ───────────────────────────────────────────────
 * Two constraints, both read out of the graph rather than hand-sequenced:
 *   1. A DERIVATIVE is visited before the record it is derived from. Once the
 *      source is gone, the derivative can no longer be identified as belonging
 *      to that user, so a plan that removes the source first strands it.
 *   2. A child whose foreign key is NO ACTION / RESTRICT is visited before its
 *      parent, because that FK makes the parent's DELETE fail outright. This is
 *      the same shape as the 54 NO ACTION references that make `delete from
 *      profiles` unusable — the fact AccountDeletionService's header opens with.
 *
 * Ties are broken alphabetically, so the same graph and the same policy always
 * produce the same plan, action for action. A planner whose output moved
 * between runs could not be reviewed before it was run.
 *
 * ── WHAT IT REFUSES TO DO ───────────────────────────────────────────────────
 * It does not choose a fate. A table the policy does not name and the manifest
 * does not already handle comes out UNRESOLVED, and the executor will not run a
 * plan that contains one. It also does not quietly drop a dependency cycle: a
 * cycle is reported, and its members are ordered alphabetically so the plan is
 * still deterministic while the cycle is visible.
 */
import type { DeletionGraphNode, CandidateClass, PropagationMechanism } from "../../lib/deletion/types.js";
import { deletionGraph } from "../../lib/deletion/index.js";
import { resolveFate, validatePolicy, type DeletionPolicy, type PolicyFate, type PolicyProblem } from "./policy.js";
import { checkBoundary, type BoundaryViolation } from "./legalRetentionBoundary.js";
import { storageHooksFor, projectionHooksFor, missingStorageHooks } from "./hooks.js";

export interface PlannedAction {
  order: number;
  table: string;
  fate: PolicyFate | "UNRESOLVED";
  resolution: { source: "policy" | "manifest" | "none"; authority: string };
  mechanism: PropagationMechanism;
  /** The columns an implementation would filter on, with their rule-derived role. */
  keyColumns: Array<{ column: string; role: string; notNull: boolean }>;
  storageHookIds: string[];
  projectionHookIds: string[];
  /** Projections that go stale if this action removes its source rows. */
  staleProjections: string[];
  candidate: CandidateClass;
  /** Why this action sits where it does in the order. */
  orderReasons: string[];
  obstacles: string[];
}

export interface UnresolvedItem {
  table: string;
  reason: string;
  candidate: CandidateClass;
  /** True when the graph's own classifier could not decide either. */
  ownerRequired: boolean;
}

export interface DeletionPlan {
  userId: string;
  policyVersion: string;
  graphTableCount: number;
  actions: PlannedAction[];
  unresolved: UnresolvedItem[];
  boundaryViolations: BoundaryViolation[];
  policyProblems: PolicyProblem[];
  /** DELETE actions whose rows point at stored objects no hook covers. */
  unmetStorageHooks: Array<{ table: string; columns: string[] }>;
  /** Dependency cycles, reported rather than silently broken. */
  cycles: string[][];
  summary: {
    byFate: Record<string, number>;
    byCandidate: Record<string, number>;
    unresolvedCount: number;
    ownerRequiredUnresolved: number;
  };
}

export interface PlanInput {
  userId: string;
  policy: DeletionPolicy;
  /** Injectable for tests; defaults to the graph built from the committed baseline. */
  graph?: readonly DeletionGraphNode[];
}

/**
 * Deterministic topological order.
 *
 * Kahn's algorithm over a SORTED ready set, so the output depends only on the
 * edges — never on Map insertion order, which would make the plan reproducible
 * only by accident.
 */
export function orderTables(
  tables: readonly string[],
  edges: ReadonlyArray<{ before: string; after: string }>,
): { order: string[]; cycles: string[][] } {
  const present = new Set(tables);
  const indegree = new Map<string, number>(tables.map((t) => [t, 0]));
  const outgoing = new Map<string, string[]>(tables.map((t) => [t, []]));
  const seen = new Set<string>();
  for (const e of edges) {
    if (!present.has(e.before) || !present.has(e.after) || e.before === e.after) continue;
    const key = `${e.before} ${e.after}`;
    if (seen.has(key)) continue; // a duplicate edge would double the indegree
    seen.add(key);
    outgoing.get(e.before)!.push(e.after);
    indegree.set(e.after, (indegree.get(e.after) ?? 0) + 1);
  }

  const order: string[] = [];
  const ready = tables.filter((t) => (indegree.get(t) ?? 0) === 0).sort();
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const to of [...outgoing.get(next)!].sort()) {
      const d = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, d);
      if (d === 0) {
        ready.push(to);
        ready.sort();
      }
    }
  }

  // Whatever is left is in (or downstream of) a cycle. Report it and keep the
  // plan deterministic rather than dropping the tables from the plan entirely —
  // silently omitting a table is the defect this whole exercise exists to stop.
  const placed = new Set(order);
  const stuck = tables.filter((t) => !placed.has(t)).sort();
  const cycles: string[][] = stuck.length > 0 ? [stuck] : [];
  return { order: [...order, ...stuck], cycles };
}

export function buildDeletionPlan(input: PlanInput): DeletionPlan {
  const nodes = input.graph ?? deletionGraph();
  if (nodes.length === 0) {
    throw new Error(
      "buildDeletionPlan: the deletion graph is EMPTY. An empty plan would report a complete deletion " +
        "having done nothing; refusing to build one.",
    );
  }
  if (!input.userId) throw new Error("buildDeletionPlan: userId is required");

  const byTable = new Map(nodes.map((n) => [n.table, n]));
  const tables = [...byTable.keys()].sort();
  const policyProblems = validatePolicy(input.policy, tables);

  // Ordering constraints, read out of the graph.
  const edges: Array<{ before: string; after: string }> = [];
  const orderReasons = new Map<string, string[]>();
  const addReason = (t: string, r: string) => orderReasons.set(t, [...(orderReasons.get(t) ?? []), r]);
  for (const n of nodes) {
    if (n.derivative.derivedFrom && byTable.has(n.derivative.derivedFrom)) {
      edges.push({ before: n.table, after: n.derivative.derivedFrom });
      addReason(n.table, `visited before ${n.derivative.derivedFrom}: it is a derivative of it`);
    }
    for (const child of n.propagation.DELETE.blockingChildren) {
      if (byTable.has(child)) {
        edges.push({ before: child, after: n.table });
        addReason(child, `visited before ${n.table}: its NO ACTION/RESTRICT foreign key would make that table's DELETE fail`);
      }
    }
  }

  const { order, cycles } = orderTables(tables, edges);

  const actions: PlannedAction[] = [];
  const unresolved: UnresolvedItem[] = [];
  const boundaryViolations: BoundaryViolation[] = [];

  order.forEach((table, i) => {
    const n = byTable.get(table)!;
    const res = resolveFate(n, input.policy);
    const fate: PolicyFate | "UNRESOLVED" = res.resolved ? res.fate : "UNRESOLVED";
    if (!res.resolved) {
      unresolved.push({ table, reason: res.reason, candidate: n.candidate, ownerRequired: n.candidate === "OWNER_REQUIRED" });
    } else {
      boundaryViolations.push(...checkBoundary(n, res.fate, res.entry));
    }

    const prop = res.resolved ? n.propagation[res.fate] : n.propagation.DELETE;
    actions.push({
      order: i,
      table,
      fate,
      resolution: res.resolved ? { source: res.source, authority: res.authority } : { source: "none", authority: "" },
      mechanism: prop.mechanism,
      keyColumns: n.userColumns.map((c) => ({ column: c.column, role: c.role, notNull: c.notNull })),
      storageHookIds: storageHooksFor(table).map((h) => h.id),
      projectionHookIds: [...new Set(n.derivative.staleProjections.flatMap((p) => projectionHooksFor(p).map((h) => h.id)))].sort(),
      staleProjections: n.derivative.staleProjections,
      candidate: n.candidate,
      orderReasons: orderReasons.get(table) ?? [],
      obstacles: prop.obstacles,
    });
  });

  const deleteTables = new Set(actions.filter((a) => a.fate === "DELETE").map((a) => a.table));
  const unmetStorageHooks = missingStorageHooks(nodes.filter((n) => deleteTables.has(n.table)));

  const byFate: Record<string, number> = { DELETE: 0, ANONYMIZE: 0, RETAIN: 0, UNRESOLVED: 0 };
  const byCandidate: Record<string, number> = {};
  for (const a of actions) {
    byFate[a.fate] += 1;
    byCandidate[a.candidate] = (byCandidate[a.candidate] ?? 0) + 1;
  }

  return {
    userId: input.userId,
    policyVersion: input.policy.version,
    graphTableCount: nodes.length,
    actions,
    unresolved,
    boundaryViolations,
    policyProblems,
    unmetStorageHooks,
    cycles,
    summary: {
      byFate,
      byCandidate,
      unresolvedCount: unresolved.length,
      ownerRequiredUnresolved: unresolved.filter((u) => u.ownerRequired).length,
    },
  };
}

/** Human-readable plan, for a reviewer and for the report. */
export function formatPlan(plan: DeletionPlan, opts?: { limit?: number }): string {
  const limit = opts?.limit ?? plan.actions.length;
  const lines: string[] = [
    `deletion plan for ${plan.userId}`,
    `  policy: ${plan.policyVersion}`,
    `  graph: ${plan.graphTableCount} user-keyed table(s)`,
    `  fates: ${Object.entries(plan.summary.byFate).map(([k, v]) => `${k}=${v}`).join(" ")}`,
    `  UNRESOLVED: ${plan.summary.unresolvedCount} (of which OWNER_REQUIRED by the graph: ${plan.summary.ownerRequiredUnresolved})`,
    `  boundary violations: ${plan.boundaryViolations.length}   cycles: ${plan.cycles.length}   unmet storage hooks: ${plan.unmetStorageHooks.length}`,
    "",
  ];
  for (const a of plan.actions.slice(0, limit)) {
    lines.push(`  ${String(a.order).padStart(4)} ${a.fate.padEnd(10)} ${a.table}  [${a.mechanism}] candidate=${a.candidate}`);
    for (const r of a.orderReasons) lines.push(`        order: ${r}`);
  }
  if (limit < plan.actions.length) lines.push(`  ... ${plan.actions.length - limit} more action(s)`);
  return lines.join("\n");
}
