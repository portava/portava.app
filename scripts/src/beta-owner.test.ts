/**
 * beta-owner.test.ts — beta:status and beta:provision against a FAKE `gh` and
 * a stubbed fetch. No network, no credentials, nothing dispatched.
 *
 * The fake records every gh invocation, so the assertions are about which
 * commands the owner's tool runs (and, on every refusal, that it ran NO
 * dispatch), and about the gate states it reports.
 *
 * Run: pnpm --dir scripts run test:beta-owner
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BETA_AUTH_SETTINGS_URL, type SmokeFetch } from "./beta-smoke.js";
import { APPLY_PENDING_JOB, AUDIT_STEP, betaStatus, boundaryCheckProblem, builtState, cfgRunKind, CERTIFY_STEP, DB_RUN_LIMITS, dbRunKind, formatGates, provisionBeta, PROVISION_CONFIRMATION, REBUILD_CMD, REPO, TOKEN_SECRET, type Exec, type ExecResult } from "./beta-owner.js";
import { loadFlagPolicy, PROFILES_BOUNDARY_MARKER } from "./beta-config-core.js";
import { REPO_ROOT } from "./beta-db-core.js";

const KEY = "sb_publishable_test_beta_key";
const BASE = "https://portava-beta.replit.app";
const POLICY_FLAGS = Object.fromEntries(loadFlagPolicy().flags.map((e) => [e.flag, e.enabled]));

interface World {
  secrets: string[] | null;
  dbRuns: Array<Record<string, unknown>>;
  cfgRuns: Array<Record<string, unknown>>;
  migrationsSince: string[];
  watchExit: Record<number, number>;
  disableSignup: boolean;
  apiDeployed: boolean;
  /** portava-beta's profiles table as PostgREST shows it to the anon key: absent (schema not built), open, or closed (3740). */
  profiles: "absent" | "open" | "closed";
  dispatchFails?: boolean;
  /** `gh run view <id> --json jobs` answers, by run id (absent: the read fails). */
  runJobs?: Record<number, unknown>;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const run = (id: number, conclusion: string, createdAt = "2026-10-07T12:00:00Z", headSha = "abcdef0123456789", displayTitle?: string) =>
  ({ databaseId: id, status: "completed", conclusion, url: `https://github.com/${REPO}/actions/runs/${id}`, createdAt, headSha, displayTitle });
/** beta-config.yml's run-name for an applying CONFIGURE-BETA dispatch (the workflow's run-name is pinned below). */
const CFG_APPLY = `beta-config · CONFIGURE-BETA · apply · ${PROFILES_BOUNDARY_MARKER}`;
const CFG_DRY = `beta-config · CONFIGURE-BETA · dry-run · ${PROFILES_BOUNDARY_MARKER}`;
/** A configuration run made an hour after the default schema run, so its step f is the newer evidence. */
const cfgRun = (id: number, conclusion = "success", title: string | null = CFG_APPLY, createdAt = "2026-10-07T13:00:00Z") => run(id, conclusion, createdAt, undefined, title ?? undefined);

function fakeGh(w: World) {
  const calls: string[][] = [];
  let nextId = 900;
  const exec: Exec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    calls.push([...args]);
    const a = args.join(" ");
    if (a.startsWith("api repos/") && a.includes("/environments/ci-nonprod-supabase/secrets")) {
      return w.secrets === null ? { code: 1, stdout: "", stderr: "HTTP 500" } : ok(w.secrets.join("\n"));
    }
    if (a.startsWith(`api repos/${REPO}/compare/`)) return ok(w.migrationsSince.join("\n"));
    if (a.startsWith("run list")) {
      const wf = args[args.indexOf("--workflow") + 1];
      // `gh run list --limit N` returns at most the N newest runs (the lists are kept newest first)
      const limit = Number(args[args.indexOf("--limit") + 1]);
      assert.ok(Number.isInteger(limit) && limit > 0, `run list without a --limit: ${a}`);
      return ok(JSON.stringify((wf === "beta-db.yml" ? w.dbRuns : w.cfgRuns).slice(0, limit)));
    }
    if (a.startsWith("workflow run")) {
      if (w.dispatchFails) return { code: 1, stdout: "", stderr: "HTTP 403" };
      const wf = args[2];
      // beta-db.yml's run-name: "beta-db · <confirm>[ · apply][ · reset]"
      const input = (k: string) => args.find((x, i) => args[i - 1] === "-f" && x.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
      // beta-config.yml's run-name: "beta-config · <confirm> · apply|dry-run · profiles boundary 3740+3742"
      const title = wf === "beta-db.yml"
        ? `beta-db · ${input("confirm")}${input("apply") === "yes" ? " · apply" : ""}${input("reset") === "RESET-BETA" ? " · reset" : ""}`
        : `beta-config · ${input("confirm")}${input("dry_run") === "yes" ? " · dry-run" : " · apply"} · ${PROFILES_BOUNDARY_MARKER}`;
      // one second apart per dispatch, so a later run is visibly later (GitHub's createdAt has second resolution)
      const row = run(nextId, "", new Date(Date.now() + (nextId - 900) * 1000).toISOString(), "abcdef0123456789", title);
      nextId++;
      row.status = "in_progress";
      (wf === "beta-db.yml" ? w.dbRuns : w.cfgRuns).unshift(row);
      return ok("");
    }
    if (a.startsWith("run view")) {
      const jobs = w.runJobs?.[Number(args[2])];
      assert.deepEqual(args.slice(3), ["--repo", REPO, "--json", "jobs"]);
      return jobs === undefined ? { code: 1, stdout: "", stderr: "HTTP 404" } : ok(JSON.stringify({ jobs }));
    }
    if (a.startsWith("run watch")) {
      const id = Number(args[2]);
      const code = w.watchExit[id] ?? 0;
      for (const list of [w.dbRuns, w.cfgRuns]) {
        const row = list.find((r) => r.databaseId === id);
        if (row) { row.status = "completed"; row.conclusion = code === 0 ? "success" : "failure"; }
      }
      // A successful beta-config run is what closes Supabase Auth.
      if (code === 0 && w.cfgRuns.some((r) => r.databaseId === id)) w.disableSignup = true;
      return { code, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected gh call: ${a}`);
  };
  return { exec, calls };
}

function fakeFetch(w: World) {
  const urls: Array<{ url: string; headers: Record<string, string> }> = [];
  const f: SmokeFetch = async (url, init) => {
    urls.push({ url, headers: init.headers });
    assert.equal(init.method, "GET");
    let status = 404;
    let body: unknown = { error: "not_found" };
    if (url.startsWith("https://emfpckykpzfturllshly.supabase.co/rest/v1/profiles?")) {
      assert.ok(url.endsWith("&limit=0"));
      [status, body] = w.profiles === "absent" ? [404, { code: "PGRST205" }] : w.profiles === "open" ? [200, []] : [401, { code: "42501" }];
    } else if (url === BETA_AUTH_SETTINGS_URL) {
      if (init.headers.apikey === KEY) { status = 200; body = { disable_signup: w.disableSignup, external: { email: true } }; }
      else { status = 401; body = { message: "Invalid API key" }; }
    } else if (w.apiDeployed) {
      const path = url.replace(BASE, "");
      const routes: Record<string, [number, unknown]> = {
        "/api/healthz": [200, { status: "ok" }],
        "/api/auth/signup-status": [200, { signupsEnabled: false, inviteOnly: true }],
        "/api/verification/status": [401, { error: "unauthenticated" }],
        "/api/feature-flags": [200, { flags: POLICY_FLAGS }],
      };
      if (routes[path]) [status, body] = routes[path];
    }
    return { status, text: async () => JSON.stringify(body) };
  };
  return { fetch: f, urls };
}

/** Today's measured state (2026-10-07): no token, one failed bootstrap, Auth open, no deployment. */
const today = (): World => ({
  secrets: ["SUPABASE_PROJECT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL"],
  dbRuns: [run(37462712102, "failure")],
  cfgRuns: [],
  migrationsSince: [],
  watchExit: {},
  disableSignup: false,
  apiDeployed: false,
  profiles: "absent",
});

const isDispatch = (c: string[]) => c[0] === "workflow" && c[1] === "run";
const noSleep = async () => {};

describe("beta:status — read-only", () => {
  it("today's state: every gate reported, nothing dispatched, the next action is the token", async () => {
    const w = today();
    const g = fakeGh(w);
    const f = fakeFetch(w);
    const gates = await betaStatus(g.exec, f.fetch, { publishableKey: KEY });
    const byId = Object.fromEntries(gates.map((x) => [x.id, x.state]));
    assert.deepEqual(byId, { "0": "PASS", "1": "OPEN", "2": "OPEN", "3a": "OPEN", "3b": "OPEN", "3c": "OPEN", "4-6": "OPEN", "7": "OPEN", "8": "MANUAL", "9": "MANUAL" });
    assert.ok(!g.calls.some(isDispatch), "status must never dispatch");
    assert.ok(g.calls.every((c) => c[0] === "api" || (c[0] === "run" && c[1] === "list")), JSON.stringify(g.calls));
    assert.match(formatGates(gates), new RegExp(`NEXT \\(gate 1\\): .*gh secret set ${TOKEN_SECRET} --env ci-nonprod-supabase`));
    // the only credential sent anywhere is the public key, and only to portava-beta itself
    for (const u of f.urls) assert.equal("apikey" in u.headers, u.url.startsWith("https://emfpckykpzfturllshly.supabase.co/"), u.url);
    for (const u of f.urls) assert.ok(!("authorization" in u.headers) && !("Authorization" in u.headers), u.url);
  });

  it("a fully provisioned and deployed beta: every automatable gate PASSES", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(1, "success")], cfgRuns: [cfgRun(2)], disableSignup: true, apiDeployed: true, profiles: "closed" };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.deepEqual(gates.filter((x) => x.state !== "PASS").map((x) => [x.id, x.state]), [["8", "MANUAL"], ["9", "MANUAL"]], formatGates(gates));
    assert.match(String(gates.find((x) => x.id === "3c")?.detail), /step f passed in beta-config\.yml run 2, after the last schema write/);
  });

  it("'schema current' is measured from the newest run that WROTE: an applying apply-pending run counts, a dry run does not", async () => {
    const seen: string[] = [];
    const w: World = {
      ...today(), secrets: [TOKEN_SECRET],
      dbRuns: [
        run(9, "success", undefined, "dry0000000000000", "beta-db · APPLY-PENDING-BETA"),
        run(8, "success", undefined, "apply00000000000", "beta-db · APPLY-PENDING-BETA · apply"),
        run(1, "success", undefined, "boot000000000000", "beta-db · BOOTSTRAP-BETA"),
      ],
    };
    const g = fakeGh(w);
    const exec: Exec = async (cmd, args, o) => {
      if (args[0] === "api" && String(args[1]).includes("/compare/")) seen.push(String(args[1]));
      return g.exec(cmd, args, o);
    };
    const gates = await betaStatus(exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.equal(gates.find((x) => x.id === "2")?.state, "PASS");
    assert.deepEqual(seen, [`repos/${REPO}/compare/apply00000000000...main`]);
  });

  it("migrations merged after the bootstrap make 'schema current' OPEN, naming them, and point at apply-pending", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(1, "success")], migrationsSince: ["artifacts/api-server/src/migrations/3821_payment_ledger.sql", "docs/x.md"] };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
    const g = gates.find((x) => x.id === "2b");
    assert.equal(g?.state, "OPEN");
    assert.match(String(g?.detail), /1 migration\(s\).*3821_payment_ledger\.sql/);
    assert.match(String(g?.next), /APPLY-PENDING-BETA apply=yes; never a reset/);
  });

  it("3740 gate: a built, configured, deployed beta whose anon key can read profiles' personal columns is OPEN at 3c, and testers wait for it", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(1, "success")], cfgRuns: [cfgRun(2)], disableSignup: true, apiDeployed: true, profiles: "open" };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
    const g = gates.find((x) => x.id === "3c");
    assert.equal(g?.state, "OPEN");
    assert.match(String(g?.detail), /^3740: READABLE by the anon key: date_of_birth, full_name, expo_push_token/);
    assert.doesNotMatch(String(g?.detail), /3742:/, "step f's half holds here; only the probe's half is named");
    assert.match(String(g?.next), /3740 \(PR #647\).*Create NO tester account/);
    assert.match(String(gates.find((x) => x.id === "8")?.detail), /ONLY after gate 3c PASSES/);
    assert.match(formatGates(gates), /NEXT \(gate 3c\)/);
  });

  it("an unreadable eas.json key leaves gate 3c OPEN ('not probed') and testers waiting — never a pass by absence (verifier F3)", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(1, "success")], cfgRuns: [cfgRun(2)], disableSignup: true, apiDeployed: true, profiles: "closed" };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { readPublishableKey: () => { throw new Error("eas.json build.beta carries no publishable key"); } });
    const g3c = gates.find((x) => x.id === "3c");
    assert.equal(g3c?.state, "OPEN");
    assert.match(String(g3c?.detail), /not probed/);
    assert.equal(gates.find((x) => x.id === "0")?.state, "UNKNOWN");
    assert.match(String(gates.find((x) => x.id === "8")?.detail), /ONLY after gate 3c PASSES/);
  });

  it("an unreadable secret list is UNKNOWN, never OPEN or PASS; a wrong publishable key is OPEN", async () => {
    const w: World = { ...today(), secrets: null };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: "sb_publishable_wrong" });
    assert.equal(gates.find((x) => x.id === "1")?.state, "UNKNOWN");
    assert.equal(gates.find((x) => x.id === "0")?.state, "OPEN");
    assert.equal(gates.find((x) => x.id === "3b")?.state, "UNKNOWN");
  });
});

describe("beta:status gate 3c — 3742's half: authority columns server-only and the trigger, proved by step f", () => {
  // Everything else about this beta passes: built, configured, deployed, and the anon probe (3740) closed.
  const ready = (over: Partial<World> = {}): World => ({
    ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(1, "success")], cfgRuns: [cfgRun(2)], disableSignup: true, apiDeployed: true, profiles: "closed", ...over,
  });
  const gate3c = async (w: World) => {
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
    return { g: gates.find((x) => x.id === "3c"), gates };
  };

  it("the workflow's run-name states the mode and carries the boundary marker; cfgRunKind reads both renderings", () => {
    const wf = readFileSync(join(REPO_ROOT, ".github/workflows/beta-config.yml"), "utf8");
    const line = wf.split("\n").find((l) => l.startsWith("run-name:"));
    assert.equal(line, `run-name: "beta-config · \${{ inputs.confirm }}\${{ inputs.dry_run == 'yes' && ' · dry-run' || ' · apply' }} · ${PROFILES_BOUNDARY_MARKER}"`);
    assert.equal(cfgRunKind(CFG_APPLY), "apply");
    assert.equal(cfgRunKind(CFG_DRY), "dry-run");
    assert.equal(cfgRunKind("Beta config (portava-beta auth + flags)"), "unknown", "a run from before the run-name existed");
    assert.equal(cfgRunKind(undefined), "unknown");
  });

  it("PASS only with the probe closed AND the newest config run an applying success, carrying the marker, made after the newest schema write", async () => {
    const { g } = await gate3c(ready());
    assert.equal(g?.state, "PASS");
    assert.match(String(g?.name), /3740.*19 authority columns server-only \+ trigger \(3742, step f\)/);
  });

  it("OPEN: the newest config run predates the 3742 check (no marker / the workflow's old name)", async () => {
    for (const title of [null, "Beta config (portava-beta auth + flags)", "beta-config · CONFIGURE-BETA · apply"]) {
      const { g } = await gate3c(ready({ cfgRuns: [cfgRun(2, "success", title)] }));
      assert.equal(g?.state, "OPEN", String(title));
      assert.match(String(g?.detail), /^3742: .*predates the current boundary check/);
      assert.match(String(g?.next), /3742 \(PR #653\).*Create NO tester account/);
    }
  });

  it("OPEN: the newest config run was a dry run (step f only warns there), even after an applying success", async () => {
    const { g } = await gate3c(ready({ cfgRuns: [cfgRun(3, "success", CFG_DRY, "2026-10-07T14:00:00Z"), cfgRun(2)] }));
    assert.equal(g?.state, "OPEN");
    assert.match(String(g?.detail), /run 3 was a dry run/);
  });

  it("OPEN: the newest config run failed (step f refused) — an older success does not count", async () => {
    const { g } = await gate3c(ready({ cfgRuns: [cfgRun(3, "failure", CFG_APPLY, "2026-10-07T14:00:00Z"), cfgRun(2)] }));
    assert.equal(g?.state, "OPEN");
    assert.match(String(g?.detail), /run 3 is completed\/failure: step f has not passed/);
  });

  it("OPEN: a configuration run still in progress is not a pass", async () => {
    const inProgress = { ...cfgRun(3, "", CFG_APPLY, "2026-10-07T14:00:00Z"), status: "in_progress" };
    const { g } = await gate3c(ready({ cfgRuns: [inProgress, cfgRun(2)] }));
    assert.equal(g?.state, "OPEN");
    assert.match(String(g?.detail), /in_progress\/—: step f has not passed/);
  });

  it("OPEN: a schema write after the newest check (an applying apply-pending run, or a bootstrap) — step f must run again", async () => {
    for (const dbRuns of [
      [run(5, "success", "2026-10-07T13:30:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply"), run(1, "success")],
      [run(5, "success", "2026-10-07T13:30:00Z"), run(1, "success")],
    ]) {
      const { g } = await gate3c(ready({ dbRuns }));
      assert.equal(g?.state, "OPEN");
      assert.match(String(g?.detail), /written, or may have been, by beta-db\.yml run 5 \(success, .*step f must run again/);
    }
    // an apply-pending DRY run after the check wrote nothing: still PASS
    const dry = await gate3c(ready({ dbRuns: [run(5, "success", "2026-10-07T13:30:00Z", undefined, "beta-db · APPLY-PENDING-BETA"), run(1, "success")] }));
    assert.equal(dry.g?.state, "PASS");
    // the same second is not "after": fail closed
    const same = await gate3c(ready({ cfgRuns: [cfgRun(2, "success", CFG_APPLY, "2026-10-07T12:00:00Z")] }));
    assert.equal(same.g?.state, "OPEN");
  });

  it("never dispatched: OPEN; an unreadable run list: UNKNOWN — neither is a pass, and testers wait", async () => {
    const never = await gate3c(ready({ cfgRuns: [] }));
    assert.equal(never.g?.state, "OPEN");
    assert.match(String(never.g?.detail), /step f has never run/);
    const w = ready();
    const g = fakeGh(w);
    const exec: Exec = async (cmd, args, o) => (args[0] === "run" && args.includes("beta-config.yml") ? { code: 1, stdout: "", stderr: "HTTP 502" } : g.exec(cmd, args, o));
    const gates = await betaStatus(exec, fakeFetch(w).fetch, { publishableKey: KEY });
    const g3c = gates.find((x) => x.id === "3c");
    assert.equal(g3c?.state, "UNKNOWN");
    assert.match(String(g3c?.detail), /could not list beta-config\.yml runs/);
    assert.match(String(gates.find((x) => x.id === "8")?.detail), /ONLY after gate 3c PASSES/);
  });

  it("both halves failing name both", async () => {
    const { g } = await gate3c(ready({ profiles: "open", cfgRuns: [] }));
    assert.equal(g?.state, "OPEN");
    assert.match(String(g?.detail), /^3740: READABLE .* · 3742: step f has never run/);
  });

  it("boundaryCheckProblem is pure over the two runs", () => {
    assert.equal(boundaryCheckProblem(cfgRun(2), run(1, "success")), null);
    assert.match(String(boundaryCheckProblem(cfgRun(2), undefined)), /no schema write is listed/);
    assert.match(String(boundaryCheckProblem(cfgRun(2, "success", CFG_APPLY, "not a date"), run(1, "success"))), /step f must run again/);
  });

  // Verifier BETA2b F2: the ordering is against the newest beta-db.yml run that wrote OR MAY HAVE — any status, any
  // conclusion. The applier applies file by file, so a failed apply-pending run applied some files; a cancelled run
  // stopped somewhere unknown; a failed reset bootstrap dropped the schema; an in-progress run is still writing.
  // Gate 2 ("built") and 2b ("current") stay on successful runs only.
  const AFTER_CHECK = "2026-10-07T14:00:00Z"; // the config check (cfgRun's default) was made at 13:00
  for (const [label, write] of [
    ["a FAILED applying apply-pending run", run(7, "failure", AFTER_CHECK, undefined, "beta-db · APPLY-PENDING-BETA · apply")],
    ["a CANCELLED applying apply-pending run", run(7, "cancelled", AFTER_CHECK, undefined, "beta-db · APPLY-PENDING-BETA · apply")],
    ["a FAILED reset bootstrap", run(7, "failure", AFTER_CHECK, undefined, "beta-db · BOOTSTRAP-BETA · reset")],
    ["a failed run from before the run-name existed (could only bootstrap)", run(7, "failure", AFTER_CHECK)],
  ] as const) {
    it(`OPEN: ${label} made after the check — it may have written; step f must run again`, async () => {
      const { g, gates } = await gate3c(ready({ dbRuns: [write, run(1, "success")] }));
      assert.equal(g?.state, "OPEN");
      assert.match(String(g?.detail), new RegExp(`^3742: the schema was written, or may have been, by beta-db\\.yml run 7 \\(${write.conclusion}, .*step f must run again`));
      if (dbRunKind(write.displayTitle) === "bootstrap") {
        // a bootstrap-kind run that did not succeed after the successful one: not built either (lead ruling 2026-10-08)
        assert.equal(gates.find((x) => x.id === "2")?.state, "OPEN");
        assert.equal(gates.find((x) => x.id === "2b"), undefined);
      } else {
        // an apply-pending failure leaves "built" alone; 2b still counts the successful bootstrap only
        assert.equal(gates.find((x) => x.id === "2")?.state, "PASS");
        assert.match(String(gates.find((x) => x.id === "2b")?.detail), /\(run 1\)/);
      }
    });
  }

  it("OPEN: an applying run still IN PROGRESS — a write in flight — whether made after the check or (defensively) before it", async () => {
    for (const createdAt of [AFTER_CHECK, "2026-10-07T12:30:00Z"]) {
      const inFlight = { ...run(7, "", createdAt, undefined, "beta-db · APPLY-PENDING-BETA · apply"), status: "in_progress" };
      const { g } = await gate3c(ready({ dbRuns: [inFlight, run(1, "success")] }));
      assert.equal(g?.state, "OPEN", createdAt);
      assert.match(String(g?.detail), /^3742: a schema write is in flight: beta-db\.yml run 7 is in_progress — step f must run again after it/);
    }
    const queued = { ...run(7, "", AFTER_CHECK, undefined, "beta-db · BOOTSTRAP-BETA"), status: "queued" };
    assert.equal((await gate3c(ready({ dbRuns: [queued, run(1, "success")] }))).g?.state, "OPEN");
    // verifier BETA2c F3: a queued or waiting write dated BEFORE the check is in flight too (not only in_progress)
    for (const status of ["queued", "waiting", "pending", "requested"]) {
      const before = { ...run(7, "", "2026-10-07T12:30:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply"), status };
      const { g } = await gate3c(ready({ dbRuns: [before, run(1, "success")] }));
      assert.equal(g?.state, "OPEN", status);
      assert.match(String(g?.detail), new RegExp(`^3742: a schema write is in flight: beta-db\\.yml run 7 is ${status}`));
    }
  });

  it("PASS: a failed or cancelled write BEFORE the check — step f checked the state it left; an apply-pending DRY run after it wrote nothing", async () => {
    for (const conclusion of ["failure", "cancelled"]) {
      const before = run(7, conclusion, "2026-10-07T12:30:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply");
      assert.equal((await gate3c(ready({ dbRuns: [before, run(1, "success")] }))).g?.state, "PASS", conclusion);
    }
    const dryAfter = { ...run(8, "", AFTER_CHECK, undefined, "beta-db · APPLY-PENDING-BETA"), status: "in_progress" };
    assert.equal((await gate3c(ready({ dbRuns: [dryAfter, run(1, "success")] }))).g?.state, "PASS", "a dry run never writes, finished or not");
  });

  it("UNKNOWN: the beta-db.yml run list cannot be read (the check cannot be placed) — never a pass", async () => {
    const w = ready();
    const g = fakeGh(w);
    const exec: Exec = async (cmd, args, o) => (args[0] === "run" && args.includes("beta-db.yml") ? { code: 1, stdout: "", stderr: "HTTP 502" } : g.exec(cmd, args, o));
    const gates = await betaStatus(exec, fakeFetch(w).fetch, { publishableKey: KEY });
    const g3c = gates.find((x) => x.id === "3c");
    assert.equal(g3c?.state, "UNKNOWN");
    assert.match(String(g3c?.detail), /could not list beta-db\.yml runs, so step f's check cannot be placed/);
    assert.equal(gates.find((x) => x.id === "2")?.state, "UNKNOWN");
  });

  it("the ordering rests on one queue: beta-db.yml and beta-config.yml share concurrency group beta-db, never cancelling (verifier BETA2b F7)", () => {
    const group = (wf: string) => {
      const src = readFileSync(join(REPO_ROOT, ".github/workflows", wf), "utf8");
      const m = /^concurrency:\n {2}group: (\S+)\n {2}cancel-in-progress: (\S+)\n/m.exec(src);
      assert.ok(m, `${wf} has no top-level concurrency block`);
      return [m[1], m[2]];
    };
    assert.deepEqual(group("beta-db.yml"), ["beta-db", "false"]);
    assert.deepEqual(group("beta-config.yml"), ["beta-db", "false"]);
  });

  it("end to end: provision on an unbuilt beta, then status — 3c PASSES (3740 and 3742 holding); a later apply-pending write re-opens it", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [], apiDeployed: true, profiles: "closed" };
    const g = fakeGh(w);
    const f = fakeFetch(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], { exec: g.exec, fetch: f.fetch, log: () => {}, sleep: noSleep, publishableKey: KEY }), 0);
    const after = (await betaStatus(g.exec, f.fetch, { publishableKey: KEY })).find((x) => x.id === "3c");
    assert.equal(after?.state, "PASS", after?.detail);
    w.dbRuns.unshift(run(990, "success", new Date(Date.now() + 3_600_000).toISOString(), undefined, "beta-db · APPLY-PENDING-BETA · apply"));
    const later = (await betaStatus(g.exec, f.fetch, { publishableKey: KEY })).find((x) => x.id === "3c");
    assert.equal(later?.state, "OPEN");
    assert.match(String(later?.detail), /run 990 .*step f must run again/);
  });
});

describe("gate 2 — a bootstrap or RESET that did not succeed AFTER the last successful bootstrap means NOT built (lead ruling 2026-10-08)", () => {
  const deps = (w: World) => {
    const g = fakeGh(w);
    const log: string[] = [];
    return { g, log, d: { exec: g.exec, fetch: fakeFetch(w).fetch, log: (l: string) => log.push(l), sleep: noSleep, publishableKey: KEY } };
  };
  const BOOT_OK = run(1, "success", "2026-10-07T09:00:00Z", "boot000000000000", "beta-db · BOOTSTRAP-BETA");
  const later = "2026-10-08T09:00:00Z";
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a FAILED reset", run(9, "failure", later, undefined, "beta-db · BOOTSTRAP-BETA · reset"), /^RESET bootstrap run 9 \(failure, /],
    ["a CANCELLED reset", run(9, "cancelled", later, undefined, "beta-db · BOOTSTRAP-BETA · reset"), /^RESET bootstrap run 9 \(cancelled, /],
    ["a FAILED bootstrap (no reset)", run(9, "failure", later, undefined, "beta-db · BOOTSTRAP-BETA"), /^bootstrap run 9 \(failure, /],
    ["a reset still IN PROGRESS", { ...run(9, "", later, undefined, "beta-db · BOOTSTRAP-BETA · reset"), status: "in_progress" }, /^RESET bootstrap run 9 \(in_progress, /],
    ["a failed run from before the run-name existed (could only bootstrap)", run(9, "failure", later), /^bootstrap run 9 \(failure, /],
  ];
  for (const [label, newer, reason] of cases) {
    it(`OPEN, with the reason, after ${label}; 2b is not reported; provision dispatches NOTHING (exit 2)`, async () => {
      const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [newer, run(5, "success", "2026-10-07T20:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply"), BOOT_OK] };
      const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
      const g2 = gates.find((x) => x.id === "2");
      assert.equal(g2?.state, "OPEN", formatGates(gates));
      assert.match(String(g2?.detail), reason);
      assert.match(String(g2?.detail), /is newer than the last successful bootstrap 1: the schema may be partly built or dropped, so it is not counted as built$/);
      assert.equal(g2?.next?.includes(REBUILD_CMD), true, String(g2?.next));
      assert.equal(gates.find((x) => x.id === "2b"), undefined, "no 'current' claim about a schema not counted as built");
      const { g, d, log } = deps({ ...w, dbRuns: [...w.dbRuns] });
      assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
      assert.ok(!g.calls.some(isDispatch), "provision never resets, and neither bootstraps nor applies over an unsettled schema");
      assert.match(log.join("\n"), /Nothing was dispatched\.$/);
    });
  }

  it("PASS when the failure is OLDER than the successful bootstrap (e.g. the 403 first attempt, then a success); failed apply-pending runs never touch gate 2", async () => {
    const w: World = {
      ...today(), secrets: [TOKEN_SECRET],
      dbRuns: [run(7, "failure", later, undefined, "beta-db · APPLY-PENDING-BETA · apply"), BOOT_OK, run(37462712102, "failure", "2026-10-06T12:00:00Z")],
    };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.equal(gates.find((x) => x.id === "2")?.state, "PASS");
    const { g, d } = deps({ ...w, dbRuns: [...w.dbRuns] });
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0);
    assert.match(g.calls.filter(isDispatch)[0].join(" "), /confirm=APPLY-PENDING-BETA -f apply=yes$/);
  });

  it("a SUCCESSFUL reset after the failure settles it: built again (the newest successful bootstrap is the reset)", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(10, "success", "2026-10-08T10:00:00Z", undefined, "beta-db · BOOTSTRAP-BETA · reset"), run(9, "failure", later, undefined, "beta-db · BOOTSTRAP-BETA · reset"), BOOT_OK] };
    const gates = await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.equal(gates.find((x) => x.id === "2")?.state, "PASS");
    assert.match(String(gates.find((x) => x.id === "2")?.detail), /bootstrap run 10 succeeded/);
  });

  it("builtState is pure over the newest-first list (and the certified-apply predicate)", async () => {
    const no = async () => false;
    const yes = async () => true;
    assert.deepEqual(await builtState([], no), { kind: "never" });
    assert.deepEqual(await builtState([run(3, "success", later, undefined, "beta-db · APPLY-PENDING-BETA")], no), { kind: "never" });
    assert.deepEqual(await builtState([BOOT_OK], no), { kind: "built", built: BOOT_OK });
    const reset = run(9, "failure", later, undefined, "beta-db · BOOTSTRAP-BETA · reset");
    assert.deepEqual(await builtState([reset, BOOT_OK], no), { kind: "unsettled", built: BOOT_OK, unsettled: reset });
    assert.deepEqual(await builtState([run(9, "failure")], yes), { kind: "failed", unsettled: run(9, "failure") }, "never built: BETA-9 does not apply");
    const apply = run(11, "success", "2026-10-08T11:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply");
    assert.deepEqual(await builtState([apply, reset, BOOT_OK], yes), { kind: "built", built: BOOT_OK, settled: { unsettled: reset, by: apply } });
    assert.equal((await builtState([apply, reset, BOOT_OK], no)).kind, "unsettled", "an apply that did not prove the schema settles nothing");
    assert.equal((await builtState([reset, apply, BOOT_OK], yes)).kind, "unsettled", "a certified apply OLDER than the failure settles nothing");
  });

  // Verifier BETA2c F2: the unsettled run need not be the newest row.
  it("OPEN, and provision dispatches nothing, with the unsettled reset BEHIND newer runs (a dry run; an applying run that did not certify)", async () => {
    const reset = run(9, "failure", later, undefined, "beta-db · BOOTSTRAP-BETA · reset");
    for (const newer of [
      run(12, "success", "2026-10-08T12:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA"),
      run(12, "success", "2026-10-08T12:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply"),
    ]) {
      const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [newer, reset, BOOT_OK] };
      const g2 = (await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY })).find((x) => x.id === "2");
      assert.equal(g2?.state, "OPEN", String(newer.displayTitle));
      assert.match(String(g2?.detail), /^RESET bootstrap run 9 \(failure, /);
      const { g, d } = deps({ ...w, dbRuns: [...w.dbRuns] });
      assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
      assert.ok(!g.calls.some(isDispatch));
    }
  });
});

describe("BETA-9 — a certified APPLY-PENDING apply settles an unsettled bootstrap (the non-destructive way back)", () => {
  const deps = (w: World) => {
    const g = fakeGh(w);
    const log: string[] = [];
    return { g, log, d: { exec: g.exec, fetch: fakeFetch(w).fetch, log: (l: string) => log.push(l), sleep: noSleep, publishableKey: KEY } };
  };
  const BOOT_OK = run(1, "success", "2026-10-07T09:00:00Z", "boot000000000000", "beta-db · BOOTSTRAP-BETA");
  const RESET_FAILED = run(9, "failure", "2026-10-08T09:00:00Z", undefined, "beta-db · BOOTSTRAP-BETA · reset");
  const APPLY_OK = run(11, "success", "2026-10-08T11:00:00Z", "apply11000000000", "beta-db · APPLY-PENDING-BETA · apply");
  const step = (name: string, conclusion = "success") => ({ name, conclusion, status: "completed" });
  /** The apply-pending job as `gh run view --json jobs` returns it, with the given certify/audit outcomes. */
  const jobsOf = (certify = "success", audit = "success", job = "success") => [
    { name: "preflight · every CI-invoked package script exists + exact dispatch inputs", conclusion: "success", steps: [step("Set up job")] },
    {
      name: "beta · apply pending migrations (no reset; dry run unless apply=yes)", conclusion: job,
      steps: [step("Set up job"), step("apply-pending — dry run (what beta lacks; refusals must be the computed set)"),
        step("apply-pending — apply what beta lacks (refused-by-shape files hand-applied where the applier stops)"),
        step("apply-pending — certify the apply landed", certify), step("apply-pending — audit:schema (migrations vs the live beta schema)", audit)],
    },
  ];

  it("the job and step names the gate reads are the workflow's own", () => {
    const wf = readFileSync(join(REPO_ROOT, ".github/workflows/beta-db.yml"), "utf8");
    assert.ok(wf.includes(`    name: ${APPLY_PENDING_JOB}`), "apply-pending job name");
    assert.ok(wf.includes(`      - name: '${CERTIFY_STEP}'`), "certify step name");
    assert.ok(wf.split("\n").some((l) => l.startsWith(`      - name: '${AUDIT_STEP}`)), "audit step name");
  });

  it("SETTLED: a successful applying run NEWER than the failed reset, certify and audit both successful — gate 2 PASS naming both, 2b from it, provision applies", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [APPLY_OK, RESET_FAILED, BOOT_OK], runJobs: { 11: jobsOf() } };
    const s = fakeGh(w);
    const gates = await betaStatus(s.exec, fakeFetch(w).fetch, { publishableKey: KEY });
    const g2 = gates.find((x) => x.id === "2");
    assert.equal(g2?.state, "PASS", formatGates(gates));
    assert.match(String(g2?.detail), /bootstrap run 1 succeeded .*; the later failure bootstrap run 9 is settled by apply-pending run 11 \(applied; certify:migrations and audit:schema succeeded\)$/);
    assert.match(String(gates.find((x) => x.id === "2b")?.detail), /\(run 11\)/);
    assert.ok(s.calls.some((c) => c.join(" ") === `run view 11 --repo ${REPO} --json jobs`));
    const { g, d } = deps({ ...w, dbRuns: [...w.dbRuns] });
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0);
    assert.match(g.calls.filter(isDispatch)[0].join(" "), /confirm=APPLY-PENDING-BETA -f apply=yes$/);
  });

  for (const [label, jobs] of [
    ["certify failed", jobsOf("failure")],
    ["audit skipped", jobsOf("success", "skipped")],
    ["the job did not succeed", jobsOf("success", "success", "failure")],
    ["no audit step at all", [{ name: "beta · apply pending migrations (no reset; dry run unless apply=yes)", conclusion: "success", steps: [step("apply-pending — certify the apply landed")] }]],
    ["no apply-pending job", [{ name: "preflight", conclusion: "success", steps: [] }]],
    ["the jobs cannot be read", undefined],
  ] as const) {
    it(`NOT settled — ${label}: gate 2 stays OPEN and provision dispatches nothing`, async () => {
      const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [APPLY_OK, RESET_FAILED, BOOT_OK], runJobs: jobs === undefined ? {} : { 11: jobs } };
      const g2 = (await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY })).find((x) => x.id === "2");
      assert.equal(g2?.state, "OPEN");
      assert.match(String(g2?.next), /Non-destructive: gh workflow run beta-db\.yml .*confirm=APPLY-PENDING-BETA -f apply=yes .*settles it \(BETA-9\)/);
      const { g, d } = deps({ ...w, dbRuns: [...w.dbRuns] });
      assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
      assert.ok(!g.calls.some(isDispatch));
    });
  }

  it("NOT settled by a certified apply OLDER than the failure, nor past a NEWER failure; a dry run never counts", async () => {
    const older = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [RESET_FAILED, run(5, "success", "2026-10-08T08:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA · apply"), BOOT_OK], runJobs: { 5: jobsOf() } } as World;
    assert.equal((await betaStatus(fakeGh(older).exec, fakeFetch(older).fetch, { publishableKey: KEY })).find((x) => x.id === "2")?.state, "OPEN");
    const newerFailure = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(13, "failure", "2026-10-08T13:00:00Z", undefined, "beta-db · BOOTSTRAP-BETA"), APPLY_OK, RESET_FAILED, BOOT_OK], runJobs: { 11: jobsOf() } } as World;
    const g2 = (await betaStatus(fakeGh(newerFailure).exec, fakeFetch(newerFailure).fetch, { publishableKey: KEY })).find((x) => x.id === "2");
    assert.equal(g2?.state, "OPEN");
    assert.match(String(g2?.detail), /^bootstrap run 13 /);
    const dry = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(14, "success", "2026-10-08T14:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA"), RESET_FAILED, BOOT_OK], runJobs: { 14: jobsOf() } } as World;
    const s = fakeGh(dry);
    assert.equal((await betaStatus(s.exec, fakeFetch(dry).fetch, { publishableKey: KEY })).find((x) => x.id === "2")?.state, "OPEN");
    assert.ok(!s.calls.some((c) => c[0] === "run" && c[1] === "view"), "a dry run is never even asked");
  });
});

describe("never built, and a bootstrap did not succeed: provision does NOT dispatch a plain bootstrap that would refuse (verifier BETA2c F5)", () => {
  const deps = (w: World) => {
    const g = fakeGh(w);
    const log: string[] = [];
    return { g, log, d: { exec: g.exec, fetch: fakeFetch(w).fetch, log: (l: string) => log.push(l), sleep: noSleep, publishableKey: KEY } };
  };

  it("today's real state (one FAILED bootstrap on record, run 37462712102): gate 2 OPEN 'a rebuild WITH reset is needed', provision exit 2, nothing dispatched", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET] };
    const g2 = (await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY })).find((x) => x.id === "2");
    assert.equal(g2?.state, "OPEN");
    assert.match(String(g2?.detail), /^no successful bootstrap; bootstrap run 37462712102 ended failure .*a rebuild WITH reset is needed$/);
    assert.ok(String(g2?.next).includes(REBUILD_CMD), String(g2?.next));
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
    assert.ok(!g.calls.some(isDispatch), "no plain BOOTSTRAP-BETA, and never a reset");
    assert.match(log.join("\n"), /REFUSED: no successful bootstrap; .*will not dispatch a plain bootstrap that would refuse\. Next: .*-f reset=RESET-BETA\. Nothing was dispatched\./);
  });

  it("the same for a cancelled bootstrap, a failed RESET, and a pre-run-name failure behind newer dry runs", async () => {
    for (const dbRuns of [
      [run(9, "cancelled", undefined, undefined, "beta-db · BOOTSTRAP-BETA")],
      [run(9, "failure", undefined, undefined, "beta-db · BOOTSTRAP-BETA · reset")],
      [run(12, "success", "2026-10-08T12:00:00Z", undefined, "beta-db · APPLY-PENDING-BETA"), run(9, "failure")],
    ]) {
      const { g, d } = deps({ ...today(), secrets: [TOKEN_SECRET], dbRuns });
      assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2, JSON.stringify(dbRuns[0]));
      assert.ok(!g.calls.some(isDispatch));
    }
  });

  it("a first bootstrap still RUNNING: gate 2 OPEN 'wait for its verdict', provision exit 2 — never a second bootstrap", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [{ ...run(9, "", undefined, undefined, "beta-db · BOOTSTRAP-BETA"), status: "in_progress" }] };
    const g2 = (await betaStatus(fakeGh(w).exec, fakeFetch(w).fetch, { publishableKey: KEY })).find((x) => x.id === "2");
    assert.equal(g2?.state, "OPEN");
    assert.match(String(g2?.detail), /bootstrap run 9 is in_progress/);
    assert.match(String(g2?.next), /^wait for its verdict: gh run watch 9/);
    const { g, d } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
    assert.ok(!g.calls.some(isDispatch));
  });

  it("never dispatched at all (or only apply-pending dry runs): provision bootstraps as before", async () => {
    for (const dbRuns of [[], [run(6, "success", undefined, undefined, "beta-db · APPLY-PENDING-BETA")]]) {
      const { g, d } = deps({ ...today(), secrets: [TOKEN_SECRET], dbRuns });
      assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0);
      assert.match(g.calls.filter(isDispatch)[0].join(" "), /confirm=BOOTSTRAP-BETA$/);
    }
  });
});

describe("beta:provision — owner only", () => {
  const deps = (w: World) => {
    const g = fakeGh(w);
    const f = fakeFetch(w);
    const log: string[] = [];
    return { g, f, log, d: { exec: g.exec, fetch: f.fetch, log: (l: string) => log.push(l), sleep: noSleep, publishableKey: KEY } };
  };

  it("REFUSES without the typed confirmation: exit 2, no gh call at all", async () => {
    const { g, d, log } = deps({ ...today(), secrets: [TOKEN_SECRET] });
    assert.equal(await provisionBeta([], d), 2);
    assert.equal(await provisionBeta(["--confirm=provision-beta"], d), 2);
    assert.deepEqual(g.calls, []);
    assert.match(log.join("\n"), /Nothing was dispatched/);
  });

  it("REFUSES while the token secret is absent (today): exit 2, nothing dispatched", async () => {
    const { g, d, log } = deps(today());
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
    assert.ok(!g.calls.some(isDispatch));
    assert.match(log.join("\n"), new RegExp(`${TOKEN_SECRET} is not set`));
  });

  it("REFUSES when the secret names cannot be read: exit 2, nothing dispatched", async () => {
    const { g, d } = deps({ ...today(), secrets: null });
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
    assert.ok(!g.calls.some(isDispatch));
  });

  it("happy path (never dispatched): bootstrap, wait, configure, wait, Auth read back closed — exit 0, in that order, never a reset", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [] };
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0, log.join("\n"));
    const steps = g.calls.filter((c) => isDispatch(c) || (c[0] === "run" && c[1] === "watch"));
    assert.deepEqual(steps.map((c) => c.slice(0, 3).join(" ")), [
      "workflow run beta-db.yml", "run watch 900", "workflow run beta-config.yml", "run watch 901",
    ]);
    const dispatches = g.calls.filter(isDispatch).map((c) => c.join(" "));
    assert.deepEqual(dispatches, [
      `workflow run beta-db.yml --repo ${REPO} --ref main -f confirm=BOOTSTRAP-BETA`,
      `workflow run beta-config.yml --repo ${REPO} --ref main -f confirm=CONFIGURE-BETA`,
    ]);
    assert.ok(!g.calls.some((c) => c.join(" ").includes("reset")), "provision never resets");
    assert.ok(g.calls.filter((c) => c[0] === "run" && c[1] === "watch").every((c) => c.includes("--exit-status")));
    assert.match(log.join("\n"), /DONE/);
  });

  it("a failed bootstrap stops everything: beta-config.yml is NEVER dispatched, exit 1", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [], watchExit: { 900: 1 } };
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 1);
    assert.deepEqual(g.calls.filter(isDispatch).map((c) => c[2]), ["beta-db.yml"]);
    assert.match(log.join("\n"), /beta-config\.yml was NOT dispatched/);
  });

  it("an already-built schema is never bootstrapped again: it applies only what beta lacks (no reset), then configures", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(5, "success")] };
    const { g, d } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0);
    assert.deepEqual(g.calls.filter(isDispatch).map((c) => c.join(" ")), [
      `workflow run beta-db.yml --repo ${REPO} --ref main -f confirm=APPLY-PENDING-BETA -f apply=yes`,
      `workflow run beta-config.yml --repo ${REPO} --ref main -f confirm=CONFIGURE-BETA`,
    ]);
    assert.ok(!g.calls.some((c) => c.join(" ").includes("BOOTSTRAP-BETA") || c.join(" ").includes("reset")));
  });

  it("a failed apply-pending run stops everything: beta-config.yml is NEVER dispatched, exit 1", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(5, "success")], watchExit: { 900: 1 } };
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 1);
    assert.deepEqual(g.calls.filter(isDispatch).map((c) => c[2]), ["beta-db.yml"]);
    assert.match(log.join("\n"), /apply-pending run 900 did not succeed; beta-config\.yml was NOT dispatched/);
  });

  it("a successful apply-pending DRY RUN is not a bootstrap: an unbuilt beta is still bootstrapped", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(6, "success", undefined, undefined, "beta-db · APPLY-PENDING-BETA")] };
    const { g, d } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0);
    assert.match(g.calls.filter(isDispatch)[0].join(" "), /confirm=BOOTSTRAP-BETA$/);
  });

  it("a configuration run that succeeds but leaves Auth open is a FAILURE (the read-back is the proof)", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(5, "success")] };
    const { g, d, log } = deps(w);
    // the fake closes Auth on a successful config watch; undo that to model a dry run or a drifted setting
    const exec: Exec = async (cmd, args, opts) => {
      const r = await g.exec(cmd, args, opts);
      if (args[0] === "run" && args[1] === "watch") w.disableSignup = false;
      return r;
    };
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], { ...d, exec }), 1);
    assert.match(log.join("\n"), /disable_signup=false; expected 200 and true/);
  });

  // Verifier BETA2b F4: the run history is read back to the newest SUCCESSFUL bootstrap, not just the 30 newest runs.
  /** n successful apply-pending DRY runs, newest first, one minute apart, all after 2026-10-07. */
  const dryRuns = (n: number, from = 100) =>
    Array.from({ length: n }, (_, i) => run(from + n - i, "success", new Date(Date.parse("2026-10-09T00:00:00Z") - i * 60_000).toISOString(), undefined, "beta-db · APPLY-PENDING-BETA"));
  const dbLimits = (calls: string[][]) =>
    calls.filter((c) => c[0] === "run" && c[1] === "list" && c.includes("beta-db.yml") && !c.includes("--event")).map((c) => Number(c[c.indexOf("--limit") + 1]));

  it("a built beta hidden behind 30 later dry runs: status pages to the bootstrap (gate 2 PASS) and provision applies what is pending, never a bootstrap", async () => {
    const dbRuns = [...dryRuns(30), run(1, "success", "2026-10-07T09:00:00Z", "boot000000000000", "beta-db · BOOTSTRAP-BETA")];
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns };
    const s = fakeGh(w);
    const gates = await betaStatus(s.exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.equal(gates.find((x) => x.id === "2")?.state, "PASS", formatGates(gates));
    assert.deepEqual(dbLimits(s.calls), [30, 100], "30 runs held no bootstrap, so it read further");
    const { g, d } = deps({ ...w, dbRuns: [...dbRuns] });
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 0);
    assert.deepEqual(g.calls.filter(isDispatch).map((c) => c.slice(3).join(" ")), [
      `--repo ${REPO} --ref main -f confirm=APPLY-PENDING-BETA -f apply=yes`, `--repo ${REPO} --ref main -f confirm=CONFIGURE-BETA`,
    ]);
  });

  it("it reads PAST a failed bootstrap to the newest successful one (PR-BETA2-6), so the failure is SEEN as newer: provision dispatches nothing", async () => {
    const dbRuns = [run(9, "failure", "2026-10-08T09:00:00Z", undefined, "beta-db · BOOTSTRAP-BETA"), ...dryRuns(40), run(1, "success", "2026-10-07T09:00:00Z")];
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns };
    const s = fakeGh(w);
    const gates = await betaStatus(s.exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.deepEqual(dbLimits(s.calls), [30, 100], "read past the failure to the success");
    assert.match(String(gates.find((x) => x.id === "2")?.detail), /^bootstrap run 9 \(failure, .*\) is newer than the last successful bootstrap 1/);
    const { g, d, log } = deps({ ...w, dbRuns: [...dbRuns] });
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
    assert.ok(!g.calls.some(isDispatch));
    assert.match(log.join("\n"), /REFUSED: bootstrap run 9 .*never resets .*Non-destructive: .*confirm=APPLY-PENDING-BETA -f apply=yes .*settles it, BETA-9\)\. A rebuild is the owner's decision: .*-f reset=RESET-BETA\. Nothing was dispatched\./);
  });

  it("a short history is read once; one with no successful bootstrap is complete when shorter than the limit (never built → bootstrap)", async () => {
    const short: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(1, "success")] };
    const s = fakeGh(short);
    await betaStatus(s.exec, fakeFetch(short).fetch, { publishableKey: KEY });
    assert.deepEqual(dbLimits(s.calls), [30]);
    const never: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(9, "failure"), ...dryRuns(45)] };
    const n = fakeGh(never);
    const gates = await betaStatus(n.exec, fakeFetch(never).fetch, { publishableKey: KEY });
    assert.deepEqual(dbLimits(n.calls), [30, 100], "46 runs < 100: the whole history was read");
    assert.match(String(gates.find((x) => x.id === "2")?.detail), /no successful bootstrap/);
  });

  it(`${DB_RUN_LIMITS[DB_RUN_LIMITS.length - 1]} runs without reaching a successful bootstrap or the end: gate 2 UNKNOWN, and provision dispatches NOTHING (exit 2)`, async () => {
    const max = DB_RUN_LIMITS[DB_RUN_LIMITS.length - 1];
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [...dryRuns(max + 5), run(1, "success", "2026-10-01T00:00:00Z")] };
    const s = fakeGh(w);
    const gates = await betaStatus(s.exec, fakeFetch(w).fetch, { publishableKey: KEY });
    assert.equal(gates.find((x) => x.id === "2")?.state, "UNKNOWN");
    assert.match(String(gates.find((x) => x.id === "2")?.detail), new RegExp(`read the ${max} newest beta-db\\.yml runs without reaching a successful bootstrap`));
    assert.deepEqual(dbLimits(s.calls), [...DB_RUN_LIMITS]);
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 2);
    assert.ok(!g.calls.some(isDispatch), "unknown built-ness dispatches neither a bootstrap nor an apply");
    assert.match(log.join("\n"), /it is unknown whether portava-beta is built\. Nothing was dispatched\./);
  });

  it("an unreadable run history: provision dispatches NOTHING (exit 2) — it used to fall through to a bootstrap", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [run(5, "success")] };
    const { g, d, log } = deps(w);
    const exec: Exec = async (cmd, args, o) => (args[0] === "run" && args[1] === "list" && args.includes("beta-db.yml") ? { code: 1, stdout: "", stderr: "HTTP 502" } : g.exec(cmd, args, o));
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], { ...d, exec }), 2);
    assert.ok(!g.calls.some(isDispatch));
    assert.match(log.join("\n"), /could not list beta-db\.yml runs/);
  });

  it("a dispatch the API refuses is exit 1 with gh's message, and nothing after it runs", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dbRuns: [], dispatchFails: true };
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 1);
    assert.ok(!g.calls.some((c) => c[0] === "run" && c[1] === "watch"));
    assert.match(log.join("\n"), /HTTP 403/);
  });
});
