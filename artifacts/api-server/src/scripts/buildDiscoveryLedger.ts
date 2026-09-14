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
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const OUT = join(REPO, "docs", "discovery", "compliance-ledger.json");

export type Blocker =
  | "NONE"                 // C already, or reachable now
  | "CODE"                 // engineering, this repo, no schema change
  | "CODE_CROSS_SURFACE"   // engineering, another surface's files
  | "MIGRATION"            // needs a schema object that does not exist
  | "FLAG"                 // built; needs a feature flag row enabled
  | "DEPLOY"               // built and merged; needs the migration applied to prod
  | "RUNTIME_EVIDENCE"     // needs observed production behaviour
  | "EXTERNAL_SETTING"     // needs a setting outside the repo (e.g. branch protection)
  | "SPEND_OR_CREDENTIAL"; // needs money or a credential this repo does not hold

/**
 * Hand-authored blocker classes, established by the five-lane pass of
 * 2026-09-14 and re-verified against source. Rows absent from this map inherit
 * "NONE" when C and "CODE" otherwise — a deliberately pessimistic default, so a
 * new requirement shows up as work rather than as silently fine.
 */
const BLOCKERS: Record<string, Blocker> = {
  // Flag rows whose migration is not applied to production at all.
  A01: "FLAG", A03: "FLAG", A05: "FLAG", A07: "FLAG",
  "DV-03": "FLAG", "DV-28": "FLAG", "DV-29": "FLAG", "DV-31": "FLAG",
  "DV-32": "FLAG", "DV-33": "FLAG", "DV-42": "FLAG", "DV-49": "FLAG",
  "DC-11": "FLAG", "DC-14": "FLAG", "DC-25": "FLAG",
  "DV-53": "FLAG", "DV-54": "FLAG",

  // Schema objects that do not exist in any database.
  "DV-37": "MIGRATION", "DV-38": "MIGRATION", "DV-41": "MIGRATION",
  "DV-44": "MIGRATION", "DV-72": "MIGRATION", "DC-07": "MIGRATION",
  "DC-15": "MIGRATION", "DC-33": "MIGRATION", "DV-39": "MIGRATION",
  A10: "MIGRATION", A11: "MIGRATION", B04: "MIGRATION",

  // Built in the tree; production lacks the applied migration.
  B01: "DEPLOY",

  // Engineering inside Discovery's own files.
  "DV-06": "CODE", "DV-40": "CODE", "DV-46": "CODE", "DSV2-12": "CODE",
  "DV-18": "CODE", "DV-74": "CODE", "DC-01": "CODE", "DC-09": "CODE",
  "DC-13": "CODE", "DC-17": "CODE", "DC-19": "CODE", "DC-22": "CODE",
  "DC-24": "CODE", "DC-32": "CODE", C14: "CODE", B02: "CODE",
  "DV-55": "CODE", "DV-79": "CODE", "DV-82": "CODE", "DV-34": "CODE",
  "DV-51": "CODE", "DV-70": "CODE", "DV-78": "CODE", "DV-80": "CODE",
  "DV-09": "CODE", "DV-12": "CODE", "DC-06": "CODE", "DC-12": "CODE",
  "DC-26": "CODE", "DC-18": "CODE", "DV-45": "CODE",

  // Trails — an absent subsystem, now authorised.
  "DV-13": "CODE", "DV-20": "CODE", "DV-21": "CODE", "DV-22": "CODE",
  "DV-23": "CODE", "DV-24": "CODE", "DV-25": "CODE", "DV-26": "CODE",
  "DC-02": "CODE", "DC-03": "CODE", "DC-04": "CODE", "DC-05": "CODE",
  "DC-20": "CODE", "DC-21": "CODE", "DC-23": "CODE",

  // Another surface owns the producer.
  A13: "CODE_CROSS_SURFACE", A14: "CODE_CROSS_SURFACE",
  A18: "CODE_CROSS_SURFACE", A21: "CODE_CROSS_SURFACE",
  A24: "CODE_CROSS_SURFACE", A25: "CODE_CROSS_SURFACE",
  A08: "CODE_CROSS_SURFACE", B03: "CODE_CROSS_SURFACE",
  B05: "CODE_CROSS_SURFACE", C19: "CODE_CROSS_SURFACE",
  "DSV2-04": "CODE_CROSS_SURFACE", "DV-52": "CODE_CROSS_SURFACE",
  "DV-76": "CODE_CROSS_SURFACE", "DV-77": "CODE_CROSS_SURFACE",
  "DV-01": "CODE_CROSS_SURFACE", "DV-07": "CODE_CROSS_SURFACE",
  "DV-19": "CODE_CROSS_SURFACE",

  // Observed production behaviour is the evidence, not a file.
  "DV-02": "RUNTIME_EVIDENCE", "DV-47": "RUNTIME_EVIDENCE",
  "DV-71": "RUNTIME_EVIDENCE", "DC-27": "RUNTIME_EVIDENCE",
  "DV-75": "EXTERNAL_SETTING",

  // CORRECTED 2026-09-14. These fourteen were classified SPEND_OR_CREDENTIAL on
  // the assumption that creator earnings need a payment processor. THE SPECS SAY
  // THE OPPOSITE, in their own acceptance criteria:
  //
  //   07 §10 — "Creator economy INFRASTRUCTURE is ready when: value can be
  //             attributed, EARNINGS CAN BE RECORDED WITHOUT PAYING, rules are
  //             versioned, fraud holds exist, historical recalculation is
  //             possible."
  //   09 §11 — "Payment architecture is ready BEFORE PAYOUTS when: every earning
  //             can be reconstructed, no balance depends on mutable totals,
  //             attribution is linked, reversals are possible, provider can be
  //             swapped later."
  //
  // Every one of those ten is an architectural property of a ledger, not a
  // transaction. No processor, no money, no credential. Two of them are
  // VIOLATED by code that exists rather than absent — a mutable per-booking
  // summary row, and a ledger whose CHECK and grants make a compensating entry
  // impossible — which is engineering work, not a purchase.
  "DV-56": "CODE_CROSS_SURFACE", "DV-57": "CODE_CROSS_SURFACE",
  "DV-58": "CODE_CROSS_SURFACE", "DV-59": "CODE_CROSS_SURFACE",
  "DV-60": "CODE_CROSS_SURFACE", "DV-61": "CODE_CROSS_SURFACE",
  "DV-62": "CODE_CROSS_SURFACE", "DV-63": "CODE_CROSS_SURFACE",
  "DV-64": "CODE_CROSS_SURFACE", "DV-65": "CODE_CROSS_SURFACE",
  "DV-66": "CODE_CROSS_SURFACE", "DV-67": "CODE_CROSS_SURFACE",
  "DV-68": "CODE_CROSS_SURFACE", "DV-69": "CODE_CROSS_SURFACE",
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
  const rows = dump().map((r) => ({
    ...r,
    blocker: BLOCKERS[r.id] ?? (r.verdict === "C" ? "NONE" : "CODE"),
  }));
  const byVerdict: Record<string, number> = {};
  const byBlocker: Record<string, number> = {};
  for (const r of rows) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    if (r.verdict !== "C") byBlocker[r.blocker] = (byBlocker[r.blocker] ?? 0) + 1;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generatedFrom: "checkCensusIntegrity CENSUS_INTEGRITY_DUMP=ALL",
    note: "Verdicts are READ from the census and are never authored here. " +
          "`blocker` is the one hand-maintained field; see the header of " +
          "src/scripts/buildDiscoveryLedger.ts for why it is not derived.",
    total: rows.length, byVerdict, openByBlocker: byBlocker, rows,
  }, null, 2) + "\n");
  console.log(`discovery ledger: ${rows.length} requirement(s) -> ${OUT}`);
  console.log(`  verdicts: ${Object.entries(byVerdict).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  open by blocker: ${Object.entries(byBlocker).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

main();
