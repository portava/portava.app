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
import { betaStatus, boundaryCheckProblem, cfgRunKind, formatGates, provisionBeta, PROVISION_CONFIRMATION, REPO, TOKEN_SECRET, type Exec, type ExecResult } from "./beta-owner.js";
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
      return ok(JSON.stringify(wf === "beta-db.yml" ? w.dbRuns : w.cfgRuns));
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
      assert.match(String(g?.detail), /^3742: .*predates the 3742 check/);
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
      assert.match(String(g?.detail), /written by beta-db\.yml run 5 .*step f must run again/);
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
    assert.match(String(boundaryCheckProblem(cfgRun(2), undefined)), /no successful schema write/);
    assert.match(String(boundaryCheckProblem(cfgRun(2, "success", CFG_APPLY, "not a date"), run(1, "success"))), /step f must run again/);
  });

  it("end to end: provision on an unbuilt beta, then status — 3c PASSES (3740 and 3742 holding); a later apply-pending write re-opens it", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], apiDeployed: true, profiles: "closed" };
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

  it("happy path: bootstrap, wait, configure, wait, Auth read back closed — exit 0, in that order, never a reset", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET] };
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
    const w: World = { ...today(), secrets: [TOKEN_SECRET], watchExit: { 900: 1 } };
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

  it("a dispatch the API refuses is exit 1 with gh's message, and nothing after it runs", async () => {
    const w: World = { ...today(), secrets: [TOKEN_SECRET], dispatchFails: true };
    const { g, d, log } = deps(w);
    assert.equal(await provisionBeta([`--confirm=${PROVISION_CONFIRMATION}`], d), 1);
    assert.ok(!g.calls.some((c) => c[0] === "run" && c[1] === "watch"));
    assert.match(log.join("\n"), /HTTP 403/);
  });
});
