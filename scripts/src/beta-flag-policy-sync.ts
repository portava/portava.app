/**
 * beta-flag-policy-sync.ts — keep scripts/src/beta-flag-policy.json complete when
 * a merged lane adds or retires a feature flag, without deciding anything ON.
 *
 *   pnpm -C scripts beta:flag-policy-sync           # report; exit 0 in sync, 1 changes needed, 2 refused
 *   pnpm -C scripts beta:flag-policy-sync --write   # write the safe changes (refuses as a whole if any flag needs a human)
 *
 * The policy must list every flag the migration chain leaves in feature_flags,
 * exactly once (scripts/src/beta-configure.test.ts, and
 * artifacts/api-server/src/test/betaFlagPolicyCompleteness.test.ts in the
 * gated api-server suite). When a merge adds a flag, those tests go red until the
 * policy lists it. This tool makes the SAFE half of that edit mechanical:
 *
 *   - a new flag that NO migration ever turns on is added OFF, with a reason
 *     naming the seeding migration and no evidence. OFF is the beta's default
 *     for anything not launch-approved; for a STOP flag OFF means not engaged,
 *     which is also what its FALSE seed says;
 *   - a flag the chain now retires (a DELETE) is removed from the policy;
 *   - REFUSED, nothing written: a new flag that any migration turns on (TRUE seed
 *     or UPDATE … SET enabled = true) — that needs an explicit decision in the
 *     policy AND in beta-configure.test.ts POST_SNAPSHOT_SEEDED_TRUE — and a
 *     new flag whose kind (STOP / CAPABILITY / CONFIG) can be read neither from
 *     the naming conventions nor from check-flag-polarity.mjs CLASSIFIED.
 *
 * Turning any flag ON stays a reviewed hand edit with evidence.
 * The file is written as JSON.stringify(policy, null, 2) + "\n", flags sorted by
 * name — the form the committed file already has, so a write changes only the
 * entries it adds or removes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./beta-db-core.js";
import {
  FLAG_POLICY_PATH,
  loadFlagPolicy,
  seededFlagPopulation,
  type FlagKind,
  type FlagPolicy,
  type FlagPolicyEntry,
  type SeededFlag,
} from "./beta-config-core.js";

export interface PolicySyncPlan {
  add: FlagPolicyEntry[];
  remove: string[];
  /** flag → why a human must decide it. Non-empty = nothing may be written. */
  refuse: Array<{ flag: string; why: string }>;
}

const POLARITY_PATH = join(REPO_ROOT, "artifacts", "api-server", "scripts", "check-flag-polarity.mjs");

/** The kind of a flag: naming conventions first (as beta-configure.test.ts enforces them), then check-flag-polarity's CLASSIFIED. */
export function flagKindOf(flag: string, polaritySource: string = readFileSync(POLARITY_PATH, "utf8")): FlagKind | null {
  if (/^disable_|_disabled$/.test(flag)) return "STOP";
  if (/^[a-z0-9_]+_enabled$/.test(flag)) return "CAPABILITY";
  const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`flag:\\s*'${esc}',\\s*(?:seededIn:\\s*'[^']*',\\s*)?kind:\\s*'(STOP|CAPABILITY|CONFIG)'`).exec(polaritySource);
  return m ? (m[1] as FlagKind) : null;
}

export function planPolicySync(
  policy: FlagPolicy,
  population: ReadonlyMap<string, SeededFlag>,
  kindOf: (flag: string) => FlagKind | null = (f) => flagKindOf(f),
): PolicySyncPlan {
  const listed = new Set(policy.flags.map((e) => e.flag));
  const plan: PolicySyncPlan = { add: [], remove: [], refuse: [] };
  for (const seeded of population.values()) {
    if (listed.has(seeded.flag)) continue;
    if (seeded.everSetTrue) {
      plan.refuse.push({
        flag: seeded.flag,
        why: `a migration turns it ON (${seeded.seededIn}${seeded.seededValue ? ", seeded TRUE" : ", UPDATE … SET enabled = true"}): decide it explicitly in beta-flag-policy.json and in beta-configure.test.ts POST_SNAPSHOT_SEEDED_TRUE`,
      });
      continue;
    }
    const kind = kindOf(seeded.flag);
    if (kind === null) {
      plan.refuse.push({ flag: seeded.flag, why: "its kind is not readable from the naming conventions or check-flag-polarity.mjs CLASSIFIED: add the entry by hand" });
      continue;
    }
    plan.add.push({
      flag: seeded.flag,
      kind,
      enabled: false,
      reason:
        `OFF: seeded FALSE by ${seeded.seededIn}, newer than this policy and not launch-approved for beta` +
        `${kind === "STOP" ? " (a STOP left disengaged, as seeded)" : ""} — turning it on is a reviewed policy edit with evidence.`,
      evidence: [],
    });
  }
  for (const e of policy.flags) if (!population.has(e.flag)) plan.remove.push(e.flag);
  plan.add.sort((a, b) => (a.flag < b.flag ? -1 : 1));
  plan.remove.sort();
  return plan;
}

export function applyPolicySync(policy: FlagPolicy, plan: PolicySyncPlan): FlagPolicy {
  if (plan.refuse.length) throw new Error(`refusing to write: ${plan.refuse.map((r) => r.flag).join(", ")} need a human decision`);
  const gone = new Set(plan.remove);
  const flags = [...policy.flags.filter((e) => !gone.has(e.flag)), ...plan.add].sort((a, b) => (a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0));
  return { ...policy, flags };
}

/** The committed file's exact form. */
export function serializePolicy(policy: FlagPolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

const RUN_DIRECTLY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  const write = process.argv.includes("--write");
  const policy = loadFlagPolicy();
  const plan = planPolicySync(policy, seededFlagPopulation());
  for (const e of plan.add) console.log(`ADD     ${e.flag} (${e.kind}) OFF — ${e.reason}`);
  for (const f of plan.remove) console.log(`REMOVE  ${f} — no migration leaves it in feature_flags any more`);
  for (const r of plan.refuse) console.log(`REFUSE  ${r.flag} — ${r.why}`);
  if (plan.refuse.length) {
    console.log(`\n${plan.refuse.length} flag(s) need a human decision; nothing was written.`);
    process.exit(2);
  }
  if (!plan.add.length && !plan.remove.length) {
    console.log("beta-flag-policy.json lists every flag the migration chain leaves, exactly once.");
    process.exit(0);
  }
  if (!write) {
    console.log("\nRe-run with --write to apply these changes.");
    process.exit(1);
  }
  writeFileSync(FLAG_POLICY_PATH, serializePolicy(applyPolicySync(policy, plan)));
  console.log(`\nwrote ${FLAG_POLICY_PATH}: +${plan.add.length} OFF, -${plan.remove.length}. Re-run test:beta-configure, and re-dispatch beta-config.yml once merged.`);
  process.exit(0);
}
