/**
 * THE ONE AUTHORITATIVE CURRENT RECORD for Discovery compliance.
 *
 * Every lane coordinates against `docs/discovery/compliance-ledger.json`, and
 * this script is the only thing that writes it. It does NOT invent verdicts: the
 * verdict column is read from `checkCensusIntegrity`'s own dump, so the ledger
 * and the census can never disagree about what a row currently is. What it adds
 * is the part the census cannot express — WHAT CLASS OF THING would close each
 * row — which is the question five parallel lanes kept answering differently.
 *
 * Regenerate after every census edit:
 *   npm run -s build:discovery-ledger
 *
 * The `blocker` for a row is authored below and is the ONLY hand-maintained
 * field. It is deliberately not derived: a blocker is a judgement about the
 * world (is there a migration? has an owner ruled?), and deriving it from text
 * would reproduce exactly the stale-evidence problem census §16.4 documents.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const OUT = process.env.DISCOVERY_LEDGER_OUTPUT ?? join(REPO, "docs", "discovery", "compliance-ledger.json");

export type Blocker =
  | "NONE"
  | "CODE"
  | "PRODUCTION_ROLLOUT"
  | "OWNER_APPROVAL"
  | "RUNTIME_EVIDENCE"
  | "EXTERNAL_SETTING"
  | "OBSERVATION_WINDOW";

const BLOCKERS: Record<string, Blocker> = {
  A01: "PRODUCTION_ROLLOUT", A03: "PRODUCTION_ROLLOUT", A05: "PRODUCTION_ROLLOUT",
  A07: "PRODUCTION_ROLLOUT", A10: "PRODUCTION_ROLLOUT", A11: "PRODUCTION_ROLLOUT",
  A13: "PRODUCTION_ROLLOUT", A14: "PRODUCTION_ROLLOUT", A18: "PRODUCTION_ROLLOUT",
  A21: "PRODUCTION_ROLLOUT", A25: "PRODUCTION_ROLLOUT", B03: "PRODUCTION_ROLLOUT",
  B04: "PRODUCTION_ROLLOUT", C19: "PRODUCTION_ROLLOUT", C32: "OBSERVATION_WINDOW",
  "DC-01": "PRODUCTION_ROLLOUT", "DC-04": "PRODUCTION_ROLLOUT", "DC-05": "PRODUCTION_ROLLOUT",
  "DC-06": "PRODUCTION_ROLLOUT", "DC-07": "OWNER_APPROVAL", "DC-11": "OWNER_APPROVAL",
  "DC-12": "OWNER_APPROVAL", "DC-13": "PRODUCTION_ROLLOUT", "DC-14": "PRODUCTION_ROLLOUT",
  "DC-17": "PRODUCTION_ROLLOUT", "DC-18": "RUNTIME_EVIDENCE", "DC-20": "PRODUCTION_ROLLOUT",
  "DC-21": "PRODUCTION_ROLLOUT", "DC-22": "PRODUCTION_ROLLOUT", "DC-23": "OWNER_APPROVAL",
  "DC-24": "OBSERVATION_WINDOW", "DC-26": "RUNTIME_EVIDENCE", "DC-27": "OBSERVATION_WINDOW",
  "DC-32": "PRODUCTION_ROLLOUT",
  "DV-02": "PRODUCTION_ROLLOUT", "DV-03": "PRODUCTION_ROLLOUT", "DV-06": "OWNER_APPROVAL",
  "DV-09": "PRODUCTION_ROLLOUT", "DV-12": "OWNER_APPROVAL", "DV-18": "PRODUCTION_ROLLOUT",
  "DV-19": "RUNTIME_EVIDENCE", "DV-21": "PRODUCTION_ROLLOUT", "DV-22": "PRODUCTION_ROLLOUT",
  "DV-24": "PRODUCTION_ROLLOUT", "DV-26": "OWNER_APPROVAL", "DV-28": "PRODUCTION_ROLLOUT",
  "DV-29": "PRODUCTION_ROLLOUT", "DV-30": "PRODUCTION_ROLLOUT", "DV-31": "PRODUCTION_ROLLOUT",
  "DV-32": "PRODUCTION_ROLLOUT", "DV-33": "PRODUCTION_ROLLOUT", "DV-34": "OWNER_APPROVAL",
  "DV-37": "PRODUCTION_ROLLOUT", "DV-40": "PRODUCTION_ROLLOUT", "DV-41": "OWNER_APPROVAL",
  "DV-42": "PRODUCTION_ROLLOUT", "DV-44": "PRODUCTION_ROLLOUT", "DV-47": "PRODUCTION_ROLLOUT",
  "DV-49": "PRODUCTION_ROLLOUT", "DV-51": "PRODUCTION_ROLLOUT", "DV-52": "OWNER_APPROVAL",
  "DV-53": "PRODUCTION_ROLLOUT", "DV-54": "PRODUCTION_ROLLOUT", "DV-55": "PRODUCTION_ROLLOUT",
  "DV-56": "OWNER_APPROVAL", "DV-57": "OWNER_APPROVAL", "DV-58": "OWNER_APPROVAL",
  "DV-59": "PRODUCTION_ROLLOUT", "DV-60": "PRODUCTION_ROLLOUT", "DV-61": "OWNER_APPROVAL",
  "DV-62": "OWNER_APPROVAL", "DV-63": "OWNER_APPROVAL", "DV-64": "PRODUCTION_ROLLOUT",
  "DV-65": "PRODUCTION_ROLLOUT", "DV-66": "PRODUCTION_ROLLOUT", "DV-67": "PRODUCTION_ROLLOUT",
  "DV-68": "PRODUCTION_ROLLOUT", "DV-69": "PRODUCTION_ROLLOUT", "DV-70": "PRODUCTION_ROLLOUT",
  "DV-72": "OWNER_APPROVAL", "DV-74": "PRODUCTION_ROLLOUT", "DV-75": "EXTERNAL_SETTING",
  "DV-76": "PRODUCTION_ROLLOUT", "DV-77": "PRODUCTION_ROLLOUT", "DV-78": "OWNER_APPROVAL",
  "DV-80": "RUNTIME_EVIDENCE", "DV-82": "PRODUCTION_ROLLOUT",
};

function dump(): Array<{ id: string; verdict: string; line: number }> {
  const out = execFileSync(
    "node",
    ["--import", "tsx/esm", "src/scripts/checkCensusIntegrity.ts"],
    { cwd: join(REPO, "artifacts", "api-server"), encoding: "utf8",
      env: { ...process.env, CENSUS_INTEGRITY_DUMP: "ALL" }, maxBuffer: 1 << 28 },
  );
  return out.split("\n")
    .filter((l) => l.startsWith("discovery|"))
    .map((l) => { const [, id, verdict, line] = l.split("|"); return { id, verdict, line: Number(line) }; });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Usage: buildDiscoveryLedger.ts [--check]");
  const rows = dump().map((r) => ({
    ...r,
    blocker: r.verdict === "C" ? "NONE" : (BLOCKERS[r.id] ?? "CODE"),
  }));
  const byVerdict: Record<string, number> = {};
  const byBlocker: Record<string, number> = {};
  for (const r of rows) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    if (r.verdict !== "C") byBlocker[r.blocker] = (byBlocker[r.blocker] ?? 0) + 1;
  }
  const serialized = JSON.stringify({
    generatedFrom: "checkCensusIntegrity CENSUS_INTEGRITY_DUMP=ALL",
    note: "Verdicts are READ from the census and are never authored here. " +
          "`blocker` is the one hand-maintained field; see the header of " +
          "src/scripts/buildDiscoveryLedger.ts for why it is not derived. " +
          "The blocker is a primary gate, not all acceptance criteria or permission to activate.",
    blockerReviewedAt: "2026-10-15",
    blockerEvidence: "docs/verification/discovery-completion-20261015.md",
    total: rows.length, byVerdict, openByBlocker: byBlocker, rows,
  }, null, 2) + "\n";
  if (args.includes("--check")) {
    let existing: string | null = null;
    try { existing = readFileSync(OUT, "utf8"); } catch {}
    if (existing !== serialized) {
      console.error("Discovery compliance ledger is missing or stale; regenerate it with build:discovery-ledger.");
      process.exitCode = 1;
      return;
    }
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, serialized);
  }
  console.log(`discovery ledger: ${rows.length} requirement(s) -> ${OUT}`);
  console.log(`  verdicts: ${Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  open by blocker: ${Object.entries(byBlocker).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

main();
