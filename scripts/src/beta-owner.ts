/**
 * beta-owner.ts — the owner's two commands for the private beta
 * (docs/ops/beta-runtime-runbook.md).
 *
 *   pnpm -C scripts beta:status
 *     READ-ONLY. One line per beta gate — PASS, OPEN, UNKNOWN or MANUAL — and
 *     the exact next owner action. It reads secret NAMES and workflow-run
 *     conclusions through `gh` (needs `gh auth login`), portava-beta's PUBLIC
 *     Auth settings with the beta publishable key, and the deployed beta API's
 *     public GETs (scripts/src/beta-smoke.ts). It writes nothing, dispatches
 *     nothing and never prints a secret value.
 *
 *   pnpm -C scripts beta:provision --confirm=PROVISION-BETA
 *     OWNER ONLY: it dispatches workflows. In order, stopping at the first
 *     failure:
 *       1. preflight — BETA_SUPABASE_PROJECT_TOKEN is listed (by name) in the
 *          ci-nonprod-supabase environment; otherwise exit 2, nothing dispatched;
 *       2. beta-db.yml -f confirm=BOOTSTRAP-BETA, then wait for its verdict —
 *          SKIPPED when the last beta-db.yml run already succeeded (the
 *          bootstrap refuses a built schema; a rebuild is a deliberate reset
 *          dispatch this command never makes);
 *       3. beta-config.yml -f confirm=CONFIGURE-BETA, then wait;
 *       4. read back portava-beta's public Auth settings: disable_signup must
 *          be true.
 *     Exit 0 done · 1 a run failed or a read-back differs · 2 refused before
 *     anything was dispatched.
 *
 * Everything that touches the outside world is injected (Exec, SmokeFetch,
 * sleep, now), so scripts/src/beta-owner.test.ts drives both commands with a
 * recorded fake `gh` and a stubbed fetch, and no credentials.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { argValue } from "./beta-db-core.js";
import { BETA_WEB_ORIGIN } from "./beta-config-core.js";
import { BETA_AUTH_SETTINGS_URL, betaPublishableKey, runBetaSmoke, type SmokeFetch } from "./beta-smoke.js";

export const REPO = "portava/portava.app";
export const SECRET_ENVIRONMENT = "ci-nonprod-supabase";
export const TOKEN_SECRET = "BETA_SUPABASE_PROJECT_TOKEN";
export const PROVISION_CONFIRMATION = "PROVISION-BETA";
const MIGRATIONS_PREFIX = "artifacts/api-server/src/migrations/";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `cmd args`; `inherit` streams the child's output to the terminal (gh run watch). */
export type Exec = (cmd: string, args: readonly string[], opts?: { inherit?: boolean }) => Promise<ExecResult>;

export type GateState = "PASS" | "OPEN" | "UNKNOWN" | "MANUAL";
export interface Gate {
  id: string;
  name: string;
  state: GateState;
  detail: string;
  /** The owner's next action when this gate is not PASS. */
  next?: string;
}

interface RunRow {
  databaseId: number;
  status: string;
  conclusion: string;
  url: string;
  createdAt: string;
  headSha: string;
}

async function gh(exec: Exec, args: readonly string[]): Promise<ExecResult> {
  return exec("gh", args);
}

/** Secret NAMES in the environment (values are never readable through this API). null when the read failed. */
export async function secretNames(exec: Exec): Promise<string[] | null> {
  const r = await gh(exec, ["api", `repos/${REPO}/environments/${SECRET_ENVIRONMENT}/secrets`, "--jq", ".secrets[].name"]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function runs(exec: Exec, workflow: string, limit = 1, event?: string): Promise<RunRow[] | null> {
  const args = ["run", "list", "--repo", REPO, "--workflow", workflow, "--limit", String(limit), "--json", "databaseId,status,conclusion,url,createdAt,headSha"];
  if (event) args.push("--event", event);
  const r = await gh(exec, args);
  if (r.code !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout) as RunRow[];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** Migration files that landed on main after `sha` (the commit beta was built from). null when unknown. */
async function migrationsSince(exec: Exec, sha: string): Promise<string[] | null> {
  const r = await gh(exec, ["api", `repos/${REPO}/compare/${sha}...main`, "--jq", ".files[] | select(.status == \"added\") | .filename"]);
  if (r.code !== 0) return null;
  return r.stdout.split("\n").map((s) => s.trim()).filter((f) => f.startsWith(MIGRATIONS_PREFIX) && f.endsWith(".sql"));
}

async function authSettings(fetchImpl: SmokeFetch, key: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetchImpl(BETA_AUTH_SETTINGS_URL, { method: "GET", headers: { accept: "application/json", apikey: key }, signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  try {
    const body = JSON.parse(raw) as unknown;
    return { status: res.status, body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null };
  } catch {
    return { status: res.status, body: null };
  }
}

const PROVISION_CMD = `pnpm -C scripts beta:provision --confirm=${PROVISION_CONFIRMATION}`;

/** Every beta gate the outside world can show, in runbook order. Pure over (exec, fetch). */
export async function betaStatus(exec: Exec, fetchImpl: SmokeFetch, opts: { publishableKey?: string; base?: string } = {}): Promise<Gate[]> {
  const gates: Gate[] = [];
  const base = opts.base ?? BETA_WEB_ORIGIN;

  // Step 0 / 3 — Supabase Auth on beta refuses new users (public settings).
  let key: string | null = null;
  try { key = opts.publishableKey ?? betaPublishableKey(); } catch { key = null; }
  let auth: { status: number; body: Record<string, unknown> | null } | null = null;
  try { auth = key ? await authSettings(fetchImpl, key) : null; } catch { auth = null; }
  gates.push(
    auth === null
      ? { id: "0", name: "beta publishable key accepted by portava-beta", state: "UNKNOWN", detail: key ? "the settings request did not complete" : "eas.json build.beta carries no publishable key" }
      : auth.status === 200
        ? { id: "0", name: "beta publishable key accepted by portava-beta", state: "PASS", detail: "GET /auth/v1/settings with eas.json's key → 200" }
        : { id: "0", name: "beta publishable key accepted by portava-beta", state: "OPEN", detail: `GET /auth/v1/settings → ${auth.status}`, next: "put portava-beta's publishable key in travel-buddy-standalone/eas.json build.beta (a reviewed PR)" },
  );

  // Step 1 — the token secret exists (by name).
  const names = await secretNames(exec);
  gates.push(
    names === null
      ? { id: "1", name: `${TOKEN_SECRET} in environment ${SECRET_ENVIRONMENT}`, state: "UNKNOWN", detail: "could not list secret names (gh not logged in, or GitHub answered an error)", next: "gh auth login, then re-run beta:status" }
      : names.includes(TOKEN_SECRET)
        ? { id: "1", name: `${TOKEN_SECRET} in environment ${SECRET_ENVIRONMENT}`, state: "PASS", detail: "listed by name" }
        : {
            id: "1", name: `${TOKEN_SECRET} in environment ${SECRET_ENVIRONMENT}`, state: "OPEN",
            detail: `absent (the environment lists ${names.length} secret name(s))`,
            next: `create a Supabase Management API token that can reach portava-beta, then: gh secret set ${TOKEN_SECRET} --env ${SECRET_ENVIRONMENT} --repo ${REPO}   (paste it at the prompt)`,
          },
  );

  // Step 2 — the schema is built (and how far behind main it is).
  const db = await runs(exec, "beta-db.yml");
  const lastDb = db?.[0];
  gates.push(
    db === null
      ? { id: "2", name: "schema built (beta-db.yml)", state: "UNKNOWN", detail: "could not list runs" }
      : !lastDb
        ? { id: "2", name: "schema built (beta-db.yml)", state: "OPEN", detail: "never dispatched", next: PROVISION_CMD }
        : lastDb.conclusion === "success"
          ? { id: "2", name: "schema built (beta-db.yml)", state: "PASS", detail: `run ${lastDb.databaseId} succeeded at ${lastDb.headSha.slice(0, 10)}` }
          : { id: "2", name: "schema built (beta-db.yml)", state: "OPEN", detail: `last run ${lastDb.databaseId}: ${lastDb.status}/${lastDb.conclusion || "—"} ${lastDb.url}`, next: PROVISION_CMD },
  );
  if (lastDb?.conclusion === "success") {
    const since = await migrationsSince(exec, lastDb.headSha);
    gates.push(
      since === null
        ? { id: "2b", name: "schema current with main", state: "UNKNOWN", detail: "could not compare the built commit with main" }
        : since.length === 0
          ? { id: "2b", name: "schema current with main", state: "PASS", detail: "no migration added to main since the bootstrap" }
          : {
              id: "2b", name: "schema current with main", state: "OPEN",
              detail: `${since.length} migration(s) added to main since ${lastDb.headSha.slice(0, 10)} (e.g. ${since.slice(0, 3).map((f) => f.slice(MIGRATIONS_PREFIX.length)).join(", ")}); beta-db.yml has no apply-pending mode`,
              next: "before testers exist: gh workflow run beta-db.yml -f confirm=BOOTSTRAP-BETA -f reset=RESET-BETA (DESTROYS beta data), then beta:provision; after testers exist: needs an apply-pending workflow (not built)",
            },
    );
  }

  // Step 3 — configured: the config run, and Supabase Auth's own disable_signup (what closes the app's path).
  const cfg = await runs(exec, "beta-config.yml");
  const lastCfg = cfg?.[0];
  gates.push(
    cfg === null
      ? { id: "3a", name: "configuration applied (beta-config.yml)", state: "UNKNOWN", detail: "could not list runs" }
      : lastCfg?.conclusion === "success"
        ? { id: "3a", name: "configuration applied (beta-config.yml)", state: "PASS", detail: `run ${lastCfg.databaseId} succeeded (a dry run also succeeds: gate 3b and smoke check 5 are the proof)` }
        : { id: "3a", name: "configuration applied (beta-config.yml)", state: "OPEN", detail: lastCfg ? `last run ${lastCfg.databaseId}: ${lastCfg.status}/${lastCfg.conclusion || "—"}` : "never dispatched", next: PROVISION_CMD },
  );
  const disable = auth?.status === 200 ? auth.body?.disable_signup : undefined;
  gates.push(
    auth?.status !== 200
      ? { id: "3b", name: "Supabase Auth refuses new users on beta", state: "UNKNOWN", detail: "the public settings read did not answer 200" }
      : disable === true
        ? { id: "3b", name: "Supabase Auth refuses new users on beta", state: "PASS", detail: "disable_signup=true" }
        : {
            id: "3b", name: "Supabase Auth refuses new users on beta", state: "OPEN",
            detail: `disable_signup=${JSON.stringify(disable)}: Supabase Auth on beta still accepts sign-ups (the app's own path)`,
            next: `${PROVISION_CMD}   (or now, with no token: beta project dashboard → Authentication → Sign In / Providers → turn off "Allow new users to sign up")`,
          },
  );

  // Steps 4–7 — the beta API is deployed, and the read-only smoke passes against it.
  const smoke = await runBetaSmoke(base, fetchImpl, key ? { publishableKey: key } : {});

  // Before step 8 — profiles' personal columns closed to the anon key (migration 3740, PR #647). The probe goes to
  // portava-beta's PostgREST directly, so it answers before the API is deployed.
  const grant = smoke.find((r) => r.name === "profiles personal columns closed to the anon key");
  gates.push(
    grant?.ok
      ? { id: "3c", name: "profiles personal columns closed to the anon key (3740)", state: "PASS", detail: grant.detail }
      : {
          id: "3c", name: "profiles personal columns closed to the anon key (3740)", state: "OPEN", detail: grant?.detail ?? "not probed",
          next: "migration 3740 (PR #647) must be in the chain beta is built from: merge it, (re)build beta (reset if already built), re-run beta:provision. Create NO tester account until this gate PASSES",
        },
  );
  const health = smoke.find((r) => r.name === "health");
  gates.push(
    health?.ok
      ? { id: "4-6", name: `beta API deployed at ${base}`, state: "PASS", detail: "GET /api/healthz → 200 {status:\"ok\"}" }
      : {
          id: "4-6", name: `beta API deployed at ${base}`, state: "OPEN", detail: health?.detail ?? "no answer",
          next: "fork the Repl as portava-beta, set the step-5 Secrets (PORTAVA_DEPLOYMENT_ENV=beta first), deploy (runbook steps 4-6)",
        },
  );
  const failed = smoke.filter((r) => !r.ok);
  gates.push(
    failed.length === 0
      ? { id: "7", name: "beta smoke (7 read-only checks)", state: "PASS", detail: "all checks pass" }
      : { id: "7", name: "beta smoke (7 read-only checks)", state: "OPEN", detail: `${failed.length} failing: ${failed.map((r) => r.name).join("; ")}`, next: `pnpm -C scripts beta:smoke --base ${base}   (details per check)` },
  );

  // Steps 8–9 — not observable without the owner's credentials.
  gates.push({ id: "8", name: "tester accounts created", state: "MANUAL", detail: "ONLY after gate 3c PASSES; needs the beta project dashboard (Authentication → Users → Add user, Auto Confirm)" });
  gates.push({ id: "9", name: "beta app built and distributed", state: "MANUAL", detail: "needs the Expo account: cd travel-buddy-standalone && eas build --profile beta --platform all (docs/eas-runbook.md)" });
  return gates;
}

export function formatGates(gates: readonly Gate[]): string {
  const lines = gates.map((g) => `${g.state.padEnd(8)} ${g.id.padEnd(4)} ${g.name} — ${g.detail}`);
  const next = gates.find((g) => g.state === "OPEN" || g.state === "UNKNOWN");
  if (next?.next) lines.push("", `NEXT (gate ${next.id}): ${next.next}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// beta:provision — owner only
// ─────────────────────────────────────────────────────────────────────────────

export interface ProvisionDeps {
  exec: Exec;
  fetch: SmokeFetch;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  publishableKey?: string;
}

/** Dispatch a workflow on main and return the id of the run that dispatch created. */
async function dispatchAndFind(d: ProvisionDeps, workflow: string, inputs: Record<string, string>): Promise<number> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const before = await runs(d.exec, workflow, 5, "workflow_dispatch");
  const known = new Set((before ?? []).map((r) => r.databaseId));
  const startedAt = now();
  const args = ["workflow", "run", workflow, "--repo", REPO, "--ref", "main"];
  for (const [k, v] of Object.entries(inputs)) args.push("-f", `${k}=${v}`);
  const r = await gh(d.exec, args);
  if (r.code !== 0) throw new Error(`gh workflow run ${workflow} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  for (let i = 0; i < 40; i++) {
    const rows = await runs(d.exec, workflow, 5, "workflow_dispatch");
    const fresh = (rows ?? []).find((row) => !known.has(row.databaseId) && Date.parse(row.createdAt) >= startedAt - 120_000);
    if (fresh) return fresh.databaseId;
    await sleep(3_000);
  }
  throw new Error(`dispatched ${workflow} but its run did not appear within two minutes; find it with: gh run list --repo ${REPO} --workflow ${workflow}`);
}

async function watch(d: ProvisionDeps, id: number): Promise<boolean> {
  const r = await d.exec("gh", ["run", "watch", String(id), "--repo", REPO, "--exit-status"], { inherit: true });
  return r.code === 0;
}

/** 0 done · 1 a run failed or the read-back differs · 2 refused before dispatching anything. */
export async function provisionBeta(argv: readonly string[], d: ProvisionDeps): Promise<number> {
  if (argValue(argv, "--confirm") !== PROVISION_CONFIRMATION) {
    d.log(`REFUSED: pass --confirm=${PROVISION_CONFIRMATION}. This dispatches beta-db.yml (if the schema is not built) and beta-config.yml against portava-beta. Nothing was dispatched.`);
    return 2;
  }
  const names = await secretNames(d.exec);
  if (names === null) {
    d.log(`REFUSED: could not list the secret names of environment ${SECRET_ENVIRONMENT} (gh auth login?). Nothing was dispatched.`);
    return 2;
  }
  if (!names.includes(TOKEN_SECRET)) {
    d.log(`REFUSED: ${TOKEN_SECRET} is not set in environment ${SECRET_ENVIRONMENT}. Add it first: gh secret set ${TOKEN_SECRET} --env ${SECRET_ENVIRONMENT} --repo ${REPO}. Nothing was dispatched.`);
    return 2;
  }
  try {
    const lastDb = (await runs(d.exec, "beta-db.yml"))?.[0];
    if (lastDb?.conclusion === "success") {
      d.log(`schema: already built by run ${lastDb.databaseId} (${lastDb.url}); bootstrap skipped. A rebuild is a deliberate reset dispatch (runbook).`);
    } else {
      d.log("schema: dispatching beta-db.yml (confirm=BOOTSTRAP-BETA) …");
      const id = await dispatchAndFind(d, "beta-db.yml", { confirm: "BOOTSTRAP-BETA" });
      d.log(`schema: run ${id} — waiting for its verdict`);
      if (!(await watch(d, id))) {
        d.log(`FAILED: beta-db.yml run ${id} did not succeed; beta-config.yml was NOT dispatched. Read: gh run view ${id} --repo ${REPO} --log-failed`);
        return 1;
      }
    }
    d.log("config: dispatching beta-config.yml (confirm=CONFIGURE-BETA) …");
    const cfg = await dispatchAndFind(d, "beta-config.yml", { confirm: "CONFIGURE-BETA" });
    d.log(`config: run ${cfg} — waiting for its verdict`);
    if (!(await watch(d, cfg))) {
      d.log(`FAILED: beta-config.yml run ${cfg} did not succeed. Read: gh run view ${cfg} --repo ${REPO} --log-failed`);
      return 1;
    }
  } catch (err) {
    d.log(`FAILED: ${(err as Error).message}`);
    return 1;
  }
  const key = d.publishableKey ?? betaPublishableKey();
  let auth: { status: number; body: Record<string, unknown> | null };
  try {
    auth = await authSettings(d.fetch, key);
  } catch (err) {
    d.log(`FAILED: the Auth read-back did not complete: ${(err as Error).message}`);
    return 1;
  }
  if (auth.status !== 200 || auth.body?.disable_signup !== true) {
    d.log(`FAILED: portava-beta's Auth settings read back ${auth.status} disable_signup=${JSON.stringify(auth.body?.disable_signup)}; expected 200 and true.`);
    return 1;
  }
  d.log("DONE: schema built, configuration applied, Supabase Auth refuses new users. Next: runbook steps 4-6 (fork, Secrets, deploy), then pnpm -C scripts beta:smoke --base https://portava-beta.replit.app");
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const realExec: Exec = async (cmd, args, opts) => {
  const r = spawnSync(cmd, [...args], { encoding: "utf8", stdio: opts?.inherit ? "inherit" : "pipe", maxBuffer: 16 << 20 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.error ? String(r.error) : (r.stderr ?? "") };
};

const RUN_DIRECTLY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_DIRECTLY) {
  const [command, ...rest] = process.argv.slice(2);
  const fetchImpl = fetch as unknown as SmokeFetch;
  if (command === "status") {
    const gates = await betaStatus(realExec, fetchImpl);
    console.log(formatGates(gates));
    process.exit(gates.every((g) => g.state === "PASS" || g.state === "MANUAL") ? 0 : 1);
  } else if (command === "provision") {
    process.exit(await provisionBeta(rest, { exec: realExec, fetch: fetchImpl, log: (l) => console.log(l) }));
  } else {
    console.error("usage: beta-owner.ts status | provision --confirm=PROVISION-BETA");
    process.exit(2);
  }
}
