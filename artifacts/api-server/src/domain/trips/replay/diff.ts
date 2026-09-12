/**
 * The decision DIFF: golden record vs the tree's record, classified the way
 * Trips spec §24 asks — "reporting changed decisions, increased/decreased
 * conservatism, new conflicts, unexplained large diffs" (census-trips TR410).
 *
 *   changed decisions   every leaf whose value differs, by path;
 *   conservatism        `conservatismScore` before vs after, per scenario —
 *                       a direction, never a verdict on whether the change
 *                       is right;
 *   new conflicts       a conflict key (kind + commitments + plans, from the
 *                       freedom engine, the plan overlaps and every simulated
 *                       change) present in the tree's record and absent from
 *                       the golden; resolved ones are listed too;
 *   large diff          more than LARGE_DIFF_RATIO of a scenario's leaves
 *                       changed. Every diff is "unexplained" by definition
 *                       until someone re-generates the golden WITH a note —
 *                       the note is what explains it, and golden.ts refuses
 *                       to write without one.
 *
 * A pure function over two JSON values; no engine is imported here, so the
 * differ cannot drift with the engines it judges.
 */
import { conservatismScore, type ScenarioDecisions } from "./run.js";

export const LARGE_DIFF_RATIO = 0.25;

export interface DecisionChange { path: string; before: unknown; after: unknown }

export interface ScenarioDiff {
  scenario: string;
  status: "unchanged" | "changed" | "added" | "removed";
  changes: DecisionChange[];
  /** Leaves in the union of both records — the denominator of `changeRatio`. */
  leaves: number;
  changeRatio: number;
  conservatism: { before: number | null; after: number | null; direction: "increased" | "decreased" | "unchanged" | "n/a" };
  newConflicts: string[];
  resolvedConflicts: string[];
  large: boolean;
}

export interface DecisionDiffReport {
  ok: boolean;
  scenarios: ScenarioDiff[];
  changedScenarios: string[];
  totalChanges: number;
  conservatismIncreased: string[];
  conservatismDecreased: string[];
  newConflicts: { scenario: string; conflict: string }[];
  largeUnexplained: string[];
}

/** Every leaf of a JSON value by path. Empty arrays and objects are leaves too, so "[] → [x]" is one change, not zero. */
export function flattenLeaves(value: unknown, prefix = "$"): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      if (v.length === 0) { out.set(path, "[]"); return; }
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      const keys = Object.keys(v as Record<string, unknown>).sort();
      if (keys.length === 0) { out.set(path, "{}"); return; }
      for (const k of keys) walk((v as Record<string, unknown>)[k], `${path}.${k}`);
      return;
    }
    out.set(path, v);
  };
  walk(value, prefix);
  return out;
}

const conflictKey = (c: { kind: string; commitmentIds: string[]; planIds: string[] }): string => `${c.kind}:${[...c.commitmentIds].sort().join("+")}:${[...c.planIds].sort().join("+")}`;

/** The conflicts a record asserts, as stable keys: the freedom engine's, the plan overlaps, and each simulated change's. */
export function conflictKeys(d: ScenarioDecisions): string[] {
  const keys = new Set<string>();
  for (const c of d.freedom?.conflicts ?? []) keys.add(conflictKey(c));
  for (const c of d.planOverlaps) keys.add(conflictKey(c));
  for (const i of d.impact ?? []) for (const c of i.conflicts) keys.add(`${i.change.kind}(${i.change.targetId ?? "?"})/${conflictKey(c)}`);
  return [...keys].sort();
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function diffScenario(golden: ScenarioDecisions | null, actual: ScenarioDecisions | null): ScenarioDiff {
  const id = (actual ?? golden)!.scenario;
  const before = golden ? flattenLeaves(golden) : new Map<string, unknown>();
  const after = actual ? flattenLeaves(actual) : new Map<string, unknown>();
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes: DecisionChange[] = [];
  for (const p of [...paths].sort()) {
    const b = before.has(p) ? before.get(p) : undefined;
    const a = after.has(p) ? after.get(p) : undefined;
    if (!same(b, a)) changes.push({ path: p, before: b, after: a });
  }
  const cb = golden ? conservatismScore(golden) : null;
  const ca = actual ? conservatismScore(actual) : null;
  const direction: ScenarioDiff["conservatism"]["direction"] = cb === null || ca === null ? "n/a" : ca > cb ? "increased" : ca < cb ? "decreased" : "unchanged";
  const kb = new Set(golden ? conflictKeys(golden) : []);
  const ka = new Set(actual ? conflictKeys(actual) : []);
  const leaves = paths.size;
  const changeRatio = leaves === 0 ? 0 : changes.length / leaves;
  const status: ScenarioDiff["status"] = !golden ? "added" : !actual ? "removed" : changes.length === 0 ? "unchanged" : "changed";
  return {
    scenario: id, status, changes, leaves, changeRatio: Math.round(changeRatio * 1000) / 1000,
    conservatism: { before: cb, after: ca, direction },
    newConflicts: [...ka].filter((k) => !kb.has(k)), resolvedConflicts: [...kb].filter((k) => !ka.has(k)),
    large: status !== "unchanged" && (status !== "changed" || changeRatio > LARGE_DIFF_RATIO),
  };
}

export function diffDecisions(golden: readonly ScenarioDecisions[], actual: readonly ScenarioDecisions[]): DecisionDiffReport {
  const byIdG = new Map(golden.map((d) => [d.scenario, d]));
  const byIdA = new Map(actual.map((d) => [d.scenario, d]));
  const ids = [...new Set([...byIdG.keys(), ...byIdA.keys()])];
  // the tree's order first, then anything only the golden knows
  ids.sort((x, y) => (byIdA.has(x) ? actual.findIndex((d) => d.scenario === x) : 1e9) - (byIdA.has(y) ? actual.findIndex((d) => d.scenario === y) : 1e9));
  const scenarios = ids.map((id) => diffScenario(byIdG.get(id) ?? null, byIdA.get(id) ?? null));
  const changed = scenarios.filter((s) => s.status !== "unchanged");
  return {
    ok: changed.length === 0,
    scenarios,
    changedScenarios: changed.map((s) => s.scenario),
    totalChanges: scenarios.reduce((n, s) => n + s.changes.length, 0),
    conservatismIncreased: scenarios.filter((s) => s.conservatism.direction === "increased").map((s) => s.scenario),
    conservatismDecreased: scenarios.filter((s) => s.conservatism.direction === "decreased").map((s) => s.scenario),
    newConflicts: scenarios.flatMap((s) => s.newConflicts.map((conflict) => ({ scenario: s.scenario, conflict }))),
    largeUnexplained: scenarios.filter((s) => s.large).map((s) => s.scenario),
  };
}

const show = (v: unknown): string => (v === undefined ? "∅" : JSON.stringify(v));

export function formatReport(r: DecisionDiffReport, opts: { maxChangesPerScenario?: number } = {}): string {
  const max = opts.maxChangesPerScenario ?? 40;
  const lines: string[] = [];
  lines.push(r.ok
    ? `trip decision diff: ${r.scenarios.length} scenario(s), every decision as the golden records it.`
    : `trip decision diff: ${r.changedScenarios.length} of ${r.scenarios.length} scenario(s) changed — ${r.totalChanges} decision leaf/leaves differ.`);
  for (const s of r.scenarios) {
    if (s.status === "unchanged") continue;
    const cons = s.conservatism.direction === "n/a" ? "" : ` · conservatism ${s.conservatism.before} → ${s.conservatism.after} (${s.conservatism.direction})`;
    lines.push(`  ${s.scenario}: ${s.status.toUpperCase()} — ${s.changes.length}/${s.leaves} leaves (${Math.round(s.changeRatio * 100)} %)${cons}${s.large ? " · LARGE DIFF" : ""}`);
    for (const k of s.newConflicts) lines.push(`      NEW CONFLICT      ${k}`);
    for (const k of s.resolvedConflicts) lines.push(`      resolved conflict ${k}`);
    for (const c of s.changes.slice(0, max)) lines.push(`      ${c.path}: ${show(c.before)} → ${show(c.after)}`);
    if (s.changes.length > max) lines.push(`      … ${s.changes.length - max} more`);
  }
  if (!r.ok) {
    lines.push("");
    lines.push(`  conservatism increased: ${r.conservatismIncreased.length === 0 ? "none" : r.conservatismIncreased.join(", ")}`);
    lines.push(`  conservatism decreased: ${r.conservatismDecreased.length === 0 ? "none" : r.conservatismDecreased.join(", ")}`);
    lines.push(`  new conflicts:          ${r.newConflicts.length === 0 ? "none" : r.newConflicts.map((c) => `${c.scenario}/${c.conflict}`).join(", ")}`);
    lines.push(`  large, unexplained:     ${r.largeUnexplained.length === 0 ? "none" : r.largeUnexplained.join(", ")}`);
    lines.push("");
    lines.push("  A changed decision is not wrong and not right: it is CHANGED, and someone has to say why. If the change is");
    lines.push("  intended, re-generate the golden with the reason: pnpm -s check:trip-decision-diff -- --update --note \"…\"");
  }
  return lines.join("\n");
}
