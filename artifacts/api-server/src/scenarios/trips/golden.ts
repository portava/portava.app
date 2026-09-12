/**
 * The GOLDEN record: the decisions the tree last agreed to, with the note
 * that explains the last change (Trips spec §24; census-trips TR410's
 * "unexplained large diffs" — a diff is explained by this note or not at all).
 *
 * Read by the CI script and the test; written only by the CI script's
 * `--update`, and only with a non-empty `--note`. `generatedAt` is deliberately
 * absent: the file must be byte-identical for the same decisions, or every
 * re-generation would be a diff.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, type ScenarioDecisions } from "./run.js";

export const GOLDEN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "golden.json");

export interface GoldenFile {
  /** Why the decisions last changed — the human half of the diff. */
  note: string;
  /** The tree's head when the note was written, as the writer knew it (informational; not compared). */
  head: string | null;
  decisions: ScenarioDecisions[];
}

export function readGolden(file: string = GOLDEN_PATH): GoldenFile | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<GoldenFile>;
  if (typeof parsed.note !== "string" || !Array.isArray(parsed.decisions)) throw new Error(`${file} is not a golden file: expected { note, head, decisions[] }`);
  return { note: parsed.note, head: typeof parsed.head === "string" ? parsed.head : null, decisions: parsed.decisions as ScenarioDecisions[] };
}

/** Refuses an empty note: an unexplained golden is the thing this file exists to prevent. */
export function writeGolden(decisions: readonly ScenarioDecisions[], note: string, head: string | null, file: string = GOLDEN_PATH): void {
  const trimmed = note.trim();
  if (trimmed.length < 12) throw new Error("a golden update needs a note that says WHY the decisions changed (at least 12 characters)");
  const body: GoldenFile = { note: trimmed, head, decisions: [...decisions] };
  writeFileSync(file, canonicalJson(body) + "\n", "utf8");
}
