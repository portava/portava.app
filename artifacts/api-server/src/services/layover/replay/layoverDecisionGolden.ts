/**
 * The GOLDEN record for `check:layover-decision-diff` (census-layover L241):
 * the §20 decisions the tree last agreed to over `layoverScenarioCorpus.ts`,
 * with the note that explains the last change.
 *
 * Same discipline as Trips' `domain/trips/replay/golden.ts`, which it mirrors
 * deliberately so the two domains' decision diffs read the same way:
 *
 *   - written ONLY by the check's `--update`, and only with a note that says
 *     WHY the decisions changed (at least 12 characters) — an unexplained
 *     golden is the thing a decision diff exists to prevent;
 *   - canonical JSON (sorted keys, one trailing newline, no timestamp of its
 *     own), so the file is byte-identical for the same decisions and a
 *     re-generation that changed nothing is not a diff.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DecisionRecord } from "../../airport/layoverLedger.js";
import { decisionDiffCorpus, type CorpusDiff } from "../../airport/layoverReplay.js";

export const LAYOVER_GOLDEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "layoverDecisionGolden.json");

export interface LayoverGoldenFile {
  note: string;
  /** The head the note was written at, as the writer knew it. Informational; never compared. */
  head: string | null;
  decisions: DecisionRecord[];
}

/** Sorted-key JSON, so the same value always serialises to the same bytes. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, norm(o[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value), null, 2);
}

export function readLayoverGolden(file: string = LAYOVER_GOLDEN_PATH): LayoverGoldenFile | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LayoverGoldenFile>;
  if (typeof parsed.note !== "string" || !Array.isArray(parsed.decisions)) {
    throw new Error(`${file} is not a layover golden file: expected { note, head, decisions[] }`);
  }
  return { note: parsed.note, head: typeof parsed.head === "string" ? parsed.head : null, decisions: parsed.decisions as DecisionRecord[] };
}

export function writeLayoverGolden(decisions: readonly DecisionRecord[], note: string, head: string | null, file: string = LAYOVER_GOLDEN_PATH): void {
  const trimmed = note.trim();
  if (trimmed.length < 12) throw new Error("a golden update needs a note that says WHY the decisions changed (at least 12 characters)");
  const body: LayoverGoldenFile = { note: trimmed, head, decisions: [...decisions] };
  writeFileSync(file, canonicalJson(body) + "\n", "utf8");
}

export interface LayoverDecisionDiffReport {
  ok: boolean;
  diff: CorpusDiff;
  /** Scenario ids present in the tree's corpus and absent from the golden, and the reverse. */
  added: string[];
  removed: string[];
}

/**
 * Golden vs tree. Red on ANY changed field, on a scenario added or removed, and
 * on a vacuous comparison — "nothing lined up" must never read as "nothing
 * changed" (`CorpusDiff.vacuous`).
 */
export function compareToGolden(golden: readonly DecisionRecord[], actual: readonly DecisionRecord[]): LayoverDecisionDiffReport {
  const diff = decisionDiffCorpus([...golden], [...actual]);
  const goldenIds = new Set(golden.map((d) => d.sessionId));
  const actualIds = new Set(actual.map((d) => d.sessionId));
  const added = [...actualIds].filter((id) => !goldenIds.has(id)).sort();
  const removed = [...goldenIds].filter((id) => !actualIds.has(id)).sort();
  const ok = !diff.vacuous && diff.changed === 0 && added.length === 0 && removed.length === 0;
  return { ok, diff, added, removed };
}

export function formatLayoverDiffReport(r: LayoverDecisionDiffReport): string {
  const d = r.diff;
  const lines = [
    `layover decision diff: ${d.compared} scenario(s) compared against the golden — ${d.changed} changed, ${r.added.length} added, ${r.removed.length} removed${d.vacuous ? " (VACUOUS: nothing lined up)" : ""}`,
  ];
  // The LATER direction first: a deadline that moved later is the change that
  // strands a traveller, and a reviewer must not have to dig for it.
  for (const m of d.deadlineMovedLater) lines.push(`  ⚠ deadline moved LATER (less conservative): ${m.sessionId} +${m.byMinutes} min`);
  for (const m of d.deadlineMovedEarlier) lines.push(`  deadline moved earlier (more conservative): ${m.sessionId} -${m.byMinutes} min`);
  for (const f of d.verdictFlips) lines.push(`  verdict flip: ${f.sessionId} ${f.from} → ${f.to}`);
  for (const p of d.perSession) {
    lines.push(`  changed: ${p.sessionId}: ${p.diff.fields.join(", ")}`
      + (p.diff.rulesAdded.length ? ` | rules added: ${p.diff.rulesAdded.join(", ")}` : "")
      + (p.diff.rulesRemoved.length ? ` | rules removed: ${p.diff.rulesRemoved.join(", ")}` : ""));
  }
  for (const id of r.added) lines.push(`  scenario only in the tree (not in the golden): ${id}`);
  for (const id of r.removed) lines.push(`  scenario only in the golden (gone from the tree): ${id}`);
  return lines.join("\n");
}
