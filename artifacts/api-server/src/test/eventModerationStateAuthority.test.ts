/**
 * census-trust (wave 5, honesty 3, 2026-10-18) — a moderator's change to
 * `events.state` goes through the SAME transition authority as the host's.
 *
 * Run: env -i PATH="$PATH" HOME=$TMPDIR TMPDIR=$TMPDIR TZ=UTC \
 *      SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventModerationStateAuthority.test.ts
 * The route cases listen on 127.0.0.1 (run with loopback allowed).
 *
 * THE DEFECT. lib/eventLifecycle.ts's EVENT_STATE_TRANSITIONS is "the single
 * answer to 'may this event go from A to B'", and every host route writes
 * through routes/events.ts writeEventState, which asks it. Two writers did not:
 *   - PATCH /admin/events/:eventId/moderate (routes/admin.ts, through
 *     lib/eventModerationClaim.ts) put `state` straight into its claim: `cancel`
 *     wrote `cancelled` over a completed or archived event; `restore` wrote
 *     `open` over EVERY cancelled or archived event — the host's own
 *     cancellations included — and a moderator-cancelled draft came back
 *     PUBLISHED;
 *   - an approved event appeal (services/appeals/resolveAppeal.ts) wrote
 *     `state: "open"` over every state.
 * And a moderator's cancel told no attendee, where the host's pushes "Event
 * cancelled" to the going / maybe RSVPs.
 *
 * WHAT IS PROVEN HERE
 *   A. The moderator-only arrow (restore) is in the authority, derived from the
 *      table, and the host's table is unchanged.
 *   B. STRUCTURAL: across the whole server, every UPDATE that can write
 *      events.state is one of the listed writers that ask the authority, plus
 *      ONE listed exception (the moderation undo), each reasoned below.
 *   C. The moderate route over the real router.
 *   D. The appeal path.
 *
 * DOUBLES: helpers/adminModerationDouble.ts (schemaStrictSupabase + the stated
 * additions). The cancellation push is caught at lib/push.ts's fetch seam
 * (_setTestFetch); nothing leaves the process.
 *
 * Each case says whether it was RED or GREEN on the code before this change
 * (929b2599b). Modules whose exports this change adds are imported as
 * namespaces, so on the old code a missing export fails ITS case, not the file.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { _setTestFetch } from "../lib/push.js";
import * as lifecycle from "../lib/eventLifecycle.js";
import * as claimLib from "../lib/eventModerationClaim.js";
import { resolveAppeal } from "../services/appeals/resolveAppeal.js";
import adminRouter from "../routes/admin.js";
import { sanitize, matchParen } from "../scripts/lib/supabaseCallScan.js";
import { installModerationDouble, isListRead } from "./helpers/adminModerationDouble.js";
import type { Seed, Row } from "./helpers/schemaStrictSupabase.js";

const L: any = lifecycle;
const C: any = claimLib;

const ADMIN    = "a1111111-1111-4111-8111-11111111b0a0";
const HOST     = "a3333333-3333-4333-8333-33333333b0a0";
const GOING    = "a5555555-5555-4555-8555-55555555b0a0";
const MAYBE    = "a6666666-6666-4666-8666-66666666b0a0";
const CANT_GO  = "a7777777-7777-4777-8777-77777777b0a0";
const EVENT    = "b4444444-4444-4444-8444-44444444b0a0";
const APPEAL   = "c9999999-9999-4999-8999-99999999b0a0";
const TOKENS: Record<string, string> = { "admin-token": ADMIN };
const FAIL = { message: "simulated failure", code: "57014" };

const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
/** A recorded moderation row. Seeded ids sort below the double's inserted `f0000000-…` ids, and in time order. */
const record = (n: number, action: string, from: string, to: string): Row => ({
  id: `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, event_id: EVENT, actor_id: ADMIN, action,
  metadata: { reason: null, from_state: from, to_state: to }, created_at: at(100 + n),
});

function profile(id: string, handle: string, role = "user", token: string | null = null): Row {
  return { id, handle, username: handle, name: `${handle} name`, display_name: `${handle} display`, role, account_status: "active", created_at: at(0), expo_push_token: token };
}

function world(state = "open", extra: Partial<Row> = {}): Seed {
  return {
    profiles: [
      profile(ADMIN, "admin", "admin"), profile(HOST, "host"),
      profile(GOING, "going", "user", "ExponentPushToken[going]"), profile(MAYBE, "maybe", "user", "ExponentPushToken[maybe]"),
      profile(CANT_GO, "cantgo", "user", "ExponentPushToken[cantgo]"),
    ],
    admin_access_log: [], user_account_states: [], compass_settings: [], moderation_actions: [], reports: [], event_activity_log: [],
    feature_flags: [{ flag: "push_notifications_enabled", enabled: true }],
    events: [{ id: EVENT, host_id: HOST, title: "Moderated event", state, visibility: "public", featured: false, city: "Da Nang", starts_at: at(15), created_at: at(15), updated_at: at(15), ...extra }],
    event_rsvps: [
      { event_id: EVENT, user_id: GOING, status: "going", created_at: at(20), updated_at: at(20) },
      { event_id: EVENT, user_id: MAYBE, status: "maybe", created_at: at(21), updated_at: at(21) },
      { event_id: EVENT, user_id: CANT_GO, status: "cant_go", created_at: at(22), updated_at: at(22) },
    ],
  };
}
const ev = (s: Seed) => s.events!.find((e) => e.id === EVENT)!;
const install = (s: Seed, o: Parameters<typeof installModerationDouble>[1] = {}) => installModerationDouble(s, { tokens: TOKENS, ...o });

let server: http.Server;
let base = "";
let pushes: Array<Array<{ to: string; title: string; body: string; data: any }>> = [];
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
  app.use(adminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  _setTestClient(null, false);
  _setTestServiceClient(null);
});
beforeEach(() => {
  _resetRateLimit();
  pushes = [];
  _setTestFetch((async (_url: any, init: any) => {
    const msgs = JSON.parse(String(init?.body ?? "[]"));
    pushes.push(msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: "ok" })) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any);
});
afterEach(() => _setTestFetch(null));

async function moderate(action: string, body: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/admin/events/${EVENT}/moderate`, { method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" }, body: JSON.stringify({ action, ...body }) });
  const raw = await r.text();
  let parsed: any; try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: r.status, body: parsed, raw };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForPush(ms = 1500) { const end = Date.now() + ms; while (pushes.length === 0 && Date.now() < end) await sleep(10); }
const activity = (s: Seed) => s.event_activity_log!.map((a) => ({ action: a.action, from: (a.metadata as any)?.from_state, to: (a.metadata as any)?.to_state }));

// ══════════════════════════════════════════════════════════════════════════════
// A. The authority: a moderator-only arrow, derived; the host's table unchanged
// ══════════════════════════════════════════════════════════════════════════════

describe("A. lib/eventLifecycle.ts — the moderator-only reversal is in the authority", () => {
  it("RED before (a new authority function): a restore's targets are DERIVED from the table — exactly the legal predecessors of cancelled / archived — and the host's table is unchanged", () => {
    assert.equal(typeof L.eventModerationReversalTargets, "function", "eventModerationReversalTargets is not exported");
    assert.deepEqual([...L.eventModerationReversalTargets("cancelled")].sort(), ["draft", "full", "open", "started", "waitlist"]);
    assert.deepEqual([...L.eventModerationReversalTargets("archived")].sort(), ["cancelled", "completed", "draft", "full", "open", "started", "waitlist"]);
    for (const s of ["cancelled", "archived"]) assert.deepEqual(L.eventModerationReversalTargets(s), lifecycle.eventStatesAllowedBefore(s as any), `${s}: not derived from the table`);
    for (const s of ["draft", "open", "full", "waitlist", "started", "completed"]) assert.deepEqual(L.eventModerationReversalTargets(s), [], `${s} is not a state a moderation leaves`);
    // The host may still never leave cancelled (except to archive) or archived.
    for (const [f, t] of [["cancelled", "open"], ["cancelled", "draft"], ["archived", "open"], ["archived", "cancelled"], ["archived", "completed"]] as const) {
      assert.equal(lifecycle.decideEventTransition(f, t).allowed, false, `${f} -> ${t} must stay refused for the host`);
    }
  });

  it("RED before (a new authority function): decideEventModerationReversal reverses ONLY the newest recorded moderation, to the state it found", () => {
    assert.equal(typeof L.decideEventModerationReversal, "function", "decideEventModerationReversal is not exported");
    const d = (cur: string, rec: any) => L.decideEventModerationReversal(cur, rec);
    const rec = (action: string, from: unknown, to: string) => ({ action, from_state: from, to_state: to });
    assert.deepEqual(d("cancelled", rec("admin_cancel", "open", "cancelled")), { allowed: true, from: "cancelled", to: "open", moderatorOnly: true });
    assert.equal(d("cancelled", rec("admin_cancel", "draft", "cancelled")).to, "draft", "a cancelled draft goes back to DRAFT, never published");
    assert.equal(d("cancelled", rec("admin_cancel", "full", "cancelled")).to, "full");
    assert.equal(d("archived", rec("admin_remove", "completed", "archived")).to, "completed", "a removed completed event is completed again, not reopened");
    assert.equal(d("archived", rec("admin_remove", "cancelled", "archived")).to, "cancelled", "a host's cancellation the moderator then removed stays cancelled");
    const refusals: Array<[string, any, string]> = [
      ["open", rec("admin_cancel", "open", "cancelled"), "not_reversible_state"],
      ["completed", null, "not_reversible_state"],
      ["banana", null, "not_reversible_state"],
      ["cancelled", null, "no_recorded_moderation"],
      ["cancelled", undefined, "no_recorded_moderation"],
      ["cancelled", rec("admin_restore", "cancelled", "open"), "record_does_not_match"],   // restored since: the host re-cancelled it
      ["cancelled", rec("admin_restore", "archived", "cancelled"), "record_does_not_match"], // a restore is never reversed by a restore
      ["cancelled", rec("admin_cancel", "open", "archived"), "record_does_not_match"],      // the record does not leave the event where it is
      ["archived", rec("admin_cancel", "open", "cancelled"), "record_does_not_match"],    // archived since the cancel
      ["cancelled", rec("admin_remove", "open", "archived"), "record_does_not_match"],
      ["cancelled", rec("admin_cancel", 7, "cancelled"), "record_does_not_match"],
      ["cancelled", rec("admin_cancel", "completed", "cancelled"), "illegal_transition"], // the authority never allowed that cancel
      ["cancelled", rec("admin_cancel", "banana", "cancelled"), "illegal_transition"],
    ];
    for (const [cur, r, reason] of refusals) {
      const out = d(cur, r);
      assert.equal(out.allowed, false, `${cur} / ${JSON.stringify(r)} must be refused`);
      assert.equal(out.reason, reason, `${cur} / ${JSON.stringify(r)}`);
      assert.match(out.message, /\S/, "a refusal says why");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// B. Structural — server-wide, only the authority's writers write events.state
// ══════════════════════════════════════════════════════════════════════════════

const SRC = fileURLToPath(new URL("..", import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== "test" && n !== "node_modules" && n !== "generated") walk(p, out); }
    else if (/\.tsx?$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

interface WriteSite { file: string; enclosing: string; arg: string; argCode: string; line: number }
/**
 * Every `.from("events")` chain in the server whose statement carries an
 * `.update(` or `.upsert(`, with its balanced argument. Comments and string
 * CONTENTS are blanked first (supabaseCallScan.sanitize, length-preserving), so
 * prose quoting a defect is not code, and a statement ends at its own `;`.
 */
function eventWriteSites(): { sites: WriteSite[]; chains: number } {
  const sites: WriteSite[] = [];
  let chains = 0;
  for (const p of walk(SRC)) {
    const text = readFileSync(p, "utf8");
    if (!text.includes("events")) continue;
    const code = sanitize(text);
    const re = /\.from\(\s*["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const q = m.index + m[0].length - 1;
      if (!/^["'`]events["'`]\s*\)/.test(text.slice(q, q + 10))) continue;
      chains++;
      // From the `(` of `.from(`: the statement runs to its own `;`, or to the close of the block it sits in.
      let end = m.index + ".from".length; let depth = 0;
      for (; end < code.length; end++) {
        const ch = code[end];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth < 0) break; }
        else if (ch === ";" && depth === 0) break;
      }
      const stmt = code.slice(q, end);
      const w = stmt.search(/\.(update|upsert)\(/);
      if (w < 0) continue;
      const open = q + w + stmt.slice(w).indexOf("(");
      const close = matchParen(code, open);
      const before = text.slice(0, m.index);
      const fn = [...before.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*async\b|router\.(?:get|post|patch|put|delete)\(\s*"([^"]+)"/g)].pop();
      sites.push({
        file: relative(SRC, p).split("\\").join("/"),
        enclosing: fn ? (fn[1] ?? fn[2] ?? `route ${fn[3]}`) : "(module)",
        arg: text.slice(open + 1, close), argCode: code.slice(open + 1, close),
        line: before.split("\n").length,
      });
    }
  }
  return { sites, chains };
}

/**
 * THE LIST. A site is "state-capable" when its argument names `state` or is not
 * a closed object literal (a spread, or a variable). Each one is listed, with why.
 */
const SANCTIONED: Array<{ file: string; enclosing: string; arg: RegExp; why: string }> = [
  { file: "routes/events.ts", enclosing: "writeEventState", arg: /^\{\s*state:\s*to,\s*updated_at:[^,]+,\s*\.\.\.extraPatch\s*\}$/,
    why: "THE host writer: decideEventTransition, then UPDATE conditional on the decided-from state. Every call passes four arguments, so extraPatch is always {}." },
  { file: "lib/eventLifecycle.ts", enclosing: "runEventStartPass", arg: /^\{\s*state:\s*EVENT_STARTED_STATE,\s*updated_at:\s*nowIso\s*\}$/,
    why: "the start scheduler (flag-gated): decideEventStart, whose startable set is DERIVED from the table, and an UPDATE conditional on that set." },
  { file: "lib/eventModerationClaim.ts", enclosing: "applyEventModeration", arg: /^\{\s*\.\.\.changes,\s*updated_at:\s*opts\.now\s*\}$/,
    why: "the moderation claim: `changes` is decidedChanges(): a raw `state` is refused, and the state is an ALLOWED authority decision taken from the state read; the UPDATE is guarded on it." },
];
const EXCEPTIONS: Array<{ file: string; enclosing: string; arg: RegExp; why: string }> = [
  { file: "lib/eventModerationClaim.ts", enclosing: "undo", arg: /^\{\s*\.\.\.prior,\s*updated_at:\s*opts\.now\s*\}$/,
    why: "COMPENSATION, not a transition: it writes back what THIS request read, only when this request's own audit row failed, guarded on the values it wrote AND its own updated_at stamp (a later writer's change is never undone), and before any side effect fired (the cancel push waits for the audit)." },
];
const STATE_FREE: Array<{ file: string; enclosing: string; arg: RegExp; why: string }> = [
  { file: "routes/events.ts", enclosing: "recountEventWaitlist", arg: /^\{\s*waitlist_count:[^}]*\.\.\.\(extra \?\? \{\}\)\s*\}$/,
    why: "`extra` is a caller's literal; every caller passes `{ updated_at }` or nothing (asserted below)." },
  { file: "routes/events.ts", enclosing: "route /events/:id", arg: /^patch$/,
    why: "PATCH /events/:id: its patch never takes `state` — a state change there goes through writeEventState (asserted below)." },
  { file: "routes/events.ts", enclosing: "route /events/:id/link-circle", arg: /^patch$/,
    why: "link-circle: circle_id, updated_at and visibility only (asserted below)." },
];
const stateCapable = (s: WriteSite) => /\bstate\b/.test(s.argCode) || /\.\.\./.test(s.argCode) || !/^\s*\{[\s\S]*\}\s*$/.test(s.argCode);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

describe("B. structural — every events.state writer in the server asks the transition authority", () => {
  const { sites, chains } = eventWriteSites();

  it("RED before: the only state-capable events UPDATEs are the listed writers, the one listed exception, and three proven state-free patches", () => {
    assert.ok(chains >= 60, `vacuity: expected many .from("events") chains, inspected ${chains}`);
    assert.ok(sites.length >= 30, `vacuity: expected many events writes, found ${sites.length}`);
    const listed = [...SANCTIONED, ...EXCEPTIONS, ...STATE_FREE];
    const unexpected: string[] = [];
    const hits = new Map<object, number>();
    for (const s of sites.filter(stateCapable)) {
      const e = listed.find((x) => x.file === s.file && x.enclosing === s.enclosing && x.arg.test(norm(s.arg)));
      if (e) hits.set(e, (hits.get(e) ?? 0) + 1);
      else unexpected.push(`${s.file}:${s.line} (${s.enclosing}) .update(${norm(s.arg).slice(0, 120)})`);
    }
    assert.deepEqual(unexpected, [], `events.state may be written outside the authority:\n${unexpected.join("\n")}`);
    for (const e of listed) assert.equal(hits.get(e) ?? 0, 1, `${e.file} ${e.enclosing}: the listed site is gone or doubled — re-read the list (${e.why})`);
  });

  it("RED before: no other events write names `state` — an object-literal write with a state key outside the list fails here", () => {
    const literal = sites.filter((s) => /\bstate\b/.test(s.argCode));
    assert.deepEqual(literal.map((s) => `${s.file}:${s.enclosing}`).sort(), ["lib/eventLifecycle.ts:runEventStartPass", "routes/events.ts:writeEventState"]);
  });

  /** `re` matched in a file's CODE: the original text between `from` and `to`, where the match does not start inside a comment. */
  function code(file: string, fromMarker: string, toMarker: string | null): { text: string; has: (re: RegExp) => boolean } {
    const orig = readFileSync(join(SRC, file), "utf8");
    const san = sanitize(orig);
    const a = orig.indexOf(fromMarker);
    assert.ok(a >= 0 && san[a] === orig[a], `${file}: ${fromMarker} was not found in code`);
    const b = toMarker === null ? orig.length : orig.indexOf(toMarker, a + fromMarker.length);
    assert.ok(b > a, `${file}: ${toMarker} was not found after ${fromMarker}`);
    const text = orig.slice(a, b);
    return { text, has: (re: RegExp) => [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].some((m) => san[a + m.index!] === orig[a + m.index!]) };
  }

  it("RED before: each listed writer asks the authority first, and writes conditionally on the state it decided from", () => {
    const wes = code("routes/events.ts", "async function writeEventState(", "async function syncEventState(");
    assert.ok(wes.has(/decideEventTransition\(from, to\)/), "writeEventState does not ask the authority");
    assert.ok(wes.has(/\.eq\("state", decision\.from\)/), "writeEventState's UPDATE is not conditional on the decided-from state");
    const events = readFileSync(join(SRC, "routes/events.ts"), "utf8");
    const san = sanitize(events);
    const calls = [...san.matchAll(/writeEventState\(/g)].filter((m) => !/function\s+$/.test(san.slice(Math.max(0, m.index! - 20), m.index!)));
    assert.ok(calls.length >= 8, `vacuity: ${calls.length} writeEventState calls`);
    for (const m of calls) {
      const open = m.index! + "writeEventState".length;
      const args = san.slice(open + 1, matchParen(san, open));
      assert.equal(args.split(",").length, 4, `a writeEventState call passes a fifth argument (extraPatch): ${events.slice(m.index!, matchParen(san, open) + 1)}`);
    }
    const recounts = [...san.matchAll(/recountEventWaitlist\(sc,/g)].map((m) => norm(san.slice(m.index!, matchParen(san, m.index! + "recountEventWaitlist".length) + 1)));
    assert.ok(recounts.length >= 2, "vacuity: recountEventWaitlist's callers");
    for (const c of recounts) assert.match(c, /^recountEventWaitlist\(sc, id, req(, \{ updated_at: new Date\(\)\.toISOString\(\) \})?\)$/, `a recount passes more than updated_at: ${c}`);
    assert.ok(!/patch\.state\s*=/.test(san), "a route assembles state into a raw patch");
    const pat = code("routes/events.ts", 'router.patch("/events/:id",', 'router.delete("/events/:id",');
    assert.ok(pat.has(/const stateWrite = await writeEventState\(sc, id, \(current as any\)\.state, b\.state as EventState\);/), "PATCH's state does not go through writeEventState");
    assert.ok(pat.has(/const patch: Record<string, any> = \{ updated_at: new Date\(\)\.toISOString\(\) \};/));
    const patchKeys = [...sanitize(pat.text).matchAll(/patch\.(\w+)\s*=/g)].map((m) => m[1]);
    assert.ok(patchKeys.length >= 20 && !patchKeys.includes("state"), `PATCH's raw patch takes state: ${patchKeys.join(", ")}`);
    const circle = code("routes/events.ts", 'router.post("/events/:id/link-circle",', "router.");
    assert.ok(circle.has(/const patch: Record<string, any> = \{ circle_id: circleId, updated_at: new Date\(\)\.toISOString\(\) \};/));
    assert.deepEqual([...sanitize(circle.text).matchAll(/patch\.(\w+)\s*=/g)].map((m) => m[1]), ["visibility"], "link-circle's patch takes more than visibility");

    const pass = code("lib/eventLifecycle.ts", "export async function runEventStartPass(", "export function startEventLifecycleScheduler(");
    assert.ok(pass.has(/const decision = decideEventStart\(row, now\);/));
    assert.ok(pass.has(/\.in\("state", EVENT_STARTABLE_STATES\)\s*\.select\("id"\)/));

    const apply = code("lib/eventModerationClaim.ts", "export async function applyEventModeration(", "// 1. Claim.");
    assert.ok(apply.has(/const decided = decidedChanges\(opts, ev\); if \("refused" in decided\) return decided\.refused; const changes = decided\.changes;/), "the claim's changes are not decidedChanges()'s");
    const dc = code("lib/eventModerationClaim.ts", "function decidedChanges(", "function stateChangeOf(");
    assert.ok(dc.has(/if \(Object\.prototype\.hasOwnProperty\.call\(opts\.changes, "state"\)\) \{/), "a raw state change is not refused");
    assert.ok(dc.has(/if \(d\.allowed !== true \|\| d\.from !== String\(ev\.state \?\? ""\) \|\| typeof d\.to !== "string" \|\| d\.to === d\.from\) \{/), "the decision is not checked against the state read");
    assert.ok(dc.has(/return \{ changes: \{ \.\.\.opts\.changes, state: d\.to \} \};/));
    const dm = code("lib/eventModerationClaim.ts", "export async function decideModeratedEventState(", "export async function readRecordedEventModeration(");
    assert.ok(dm.has(/const d = decideEventTransition\(ev\.state, intent\.to\);/));
    assert.ok(dm.has(/const d = decideEventModerationReversal\(ev\.state, rec\.recorded\);/));
    const undo = code("lib/eventModerationClaim.ts", "const undo = async (", "// 2. Audit");
    assert.ok(undo.has(/\.eq\("updated_at", opts\.now\);/), "the undo is not guarded on this request's own stamp");
    assert.ok(undo.has(/for \(const c of cols\) q = guard\(q, c, changes\[c\]\);/), "the undo is not guarded on what this request wrote");
    const fin = code("lib/eventModerationClaim.ts", "  try {\n    const r = await opts.writeAudit();", "\n}\n");
    assert.ok(fin.has(/if \(changes\.state === "cancelled"\) notifyAttendeesOfModeratedCancel\(sc, req, ev\); return \{ outcome: "applied", activityId \};/), "the cancel push does not wait for the audit");
  });

  it("RED before: the moderate route and the appeal hand state to the authority — neither builds it", () => {
    const route = code("routes/admin.ts", 'router.patch("/admin/events/:eventId/moderate",', "// ── Invite-link slot reconciliation");
    assert.ok(!/patch\.state\s*=/.test(sanitize(route.text)), "the moderate route patches state");
    assert.ok(route.has(/const decidedE = await decideModeratedEventState\(sc, ev as ModeratedEventRow, stateIntent\);/));
    assert.ok(route.has(/changes, stateDecision: decidedE\.decision,/));
    const evCase = code("services/appeals/resolveAppeal.ts", '    case "event": {', '    case "trip": {');
    assert.ok(evCase.has(/const r = await reverseModeratedEventOnAppeal\(sc, /));
    assert.ok(!/\.update\(/.test(sanitize(evCase.text)), "the appeal's event case writes events itself");
  });

  it("GREEN before (CONTROL): no migration or baseline function UPDATEs events.state", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const files = [...readdirSync(join(root, "src/migrations")).map((n) => join(root, "src/migrations", n)), ...readdirSync(join(root, "baseline")).map((n) => join(root, "baseline", n))].filter((p) => p.endsWith(".sql"));
    assert.ok(files.length > 100, "vacuity: the migrations were not read");
    const hits: string[] = [];
    for (const p of files) {
      const sql = readFileSync(p, "utf8").replace(/--[^\n]*/g, "");
      for (const m of sql.matchAll(/update\s+(?:public\.)?events\s+set\s+([^;]*)/gi)) if (/\bstate\s*=/i.test(m[1]!.split(/\bwhere\b/i)[0]!)) hits.push(relative(root, p));
    }
    assert.deepEqual(hits, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// C. The moderate route — over the real router
// ══════════════════════════════════════════════════════════════════════════════

describe("C. PATCH /admin/events/:eventId/moderate — state through the authority", () => {
  it("RED before: cancel from open is cancelled, the activity row RECORDS the change, and the answer names it", async () => {
    const s = world("open");
    install(s);
    const r = await moderate("cancel", { reason: "scam" });
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "cancelled");
    assert.deepEqual(activity(s), [{ action: "admin_cancel", from: "open", to: "cancelled" }]);
    assert.deepEqual(r.body.state, { from: "open", to: "cancelled" });
    assert.deepEqual(s.moderation_actions!.map((m) => m.action_type), ["event_cancel"]);
  });

  it("RED before: a moderator's cancel tells the going and maybe attendees \"Event cancelled\", as the host's does — and nobody else", async () => {
    const s = world("open");
    install(s);
    const r = await moderate("cancel");
    assert.equal(r.status, 200, r.raw);
    await waitForPush();
    assert.equal(pushes.length, 1, "one push batch");
    assert.deepEqual(pushes[0]!.map((m) => m.to).sort(), ["ExponentPushToken[going]", "ExponentPushToken[maybe]"]);
    for (const m of pushes[0]!) {
      assert.equal(m.title, "Event cancelled");
      assert.equal(m.body, "\"Moderated event\" has been cancelled.");
      assert.deepEqual(m.data, { eventId: EVENT, type: "event_cancelled" });
    }
  });

  it("RED before: cancel of a COMPLETED event is refused by the authority (409), nothing written, nobody told", async () => {
    const s = world("completed");
    install(s);
    const r = await moderate("cancel");
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.match(r.body.message, /An event cannot go from 'completed' to 'cancelled'.*same transition authority as the host's/);
    assert.equal(ev(s).state, "completed");
    assert.deepEqual(s.event_activity_log, []);
    assert.deepEqual(s.moderation_actions, []);
    await sleep(100);
    assert.equal(pushes.length, 0);
  });

  it("RED before: cancel of an ARCHIVED (removed) event is refused — archived is terminal for the moderator's cancel too", async () => {
    const s = world("archived", { visibility: "invite_only" });
    install(s);
    const r = await moderate("cancel");
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.equal(ev(s).state, "archived");
    assert.deepEqual(s.event_activity_log, []);
  });

  it("GREEN before (CONTROL): cancel of an already-cancelled event changes no state, is still audited, and tells nobody again", async () => {
    const s = world("cancelled");
    install(s);
    const r = await moderate("cancel");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "cancelled");
    assert.equal(r.body.state, undefined, "no state change is named");
    assert.deepEqual(activity(s), [{ action: "admin_cancel", from: undefined, to: undefined }]);
    assert.deepEqual(s.moderation_actions!.map((m) => m.action_type), ["event_cancel"]);
    await sleep(100);
    assert.equal(pushes.length, 0);
  });

  it("RED before: remove archives and hides, and records the change it reverses from", async () => {
    const s = world("full");
    install(s);
    const r = await moderate("remove");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "archived");
    assert.equal(ev(s).visibility, "invite_only");
    assert.deepEqual(activity(s), [{ action: "admin_remove", from: "full", to: "archived" }]);
  });

  it("RED before: restore of a moderator-cancelled DRAFT goes back to draft — it was published as `open`", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "draft", "cancelled")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "draft");
    assert.equal(ev(s).visibility, "public");
    assert.deepEqual(r.body.state, { from: "cancelled", to: "draft" });
    assert.deepEqual(activity(s).at(-1), { action: "admin_restore", from: "cancelled", to: "draft" });
  });

  it("RED before: restore after a recorded cancel from open is open again, and the restore is itself recorded", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open");
    assert.deepEqual(activity(s).at(-1), { action: "admin_restore", from: "cancelled", to: "open" });
  });

  it("RED before: restore of a HOST-cancelled event (no recorded moderation) is refused — it un-cancelled the host's own cancellation", async () => {
    const s = world("cancelled", { visibility: "invite_only" });
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error, "invalid_state_transition");
    assert.match(r.body.message, /no recorded moderation put it there/);
    assert.equal(ev(s).state, "cancelled");
    assert.equal(ev(s).visibility, "invite_only", "nothing was changed");
    assert.deepEqual(s.event_activity_log, []);
    assert.deepEqual(s.moderation_actions, []);
  });

  it("RED before: restore when the newest record is a restore (the host cancelled it since) is refused", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled"), record(2, "admin_restore", "cancelled", "open")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 409, r.raw);
    assert.match(r.body.message, /newest recorded moderation state change on it is admin_restore to 'open'/);
    assert.equal(ev(s).state, "cancelled");
  });

  it("GREEN before (CONTROL; the old restore un-cancelled every cancelled event, so its answer coincides here): a record that changed no state (a cancel of an already-cancelled event) is passed over, not reversed", async () => {
    const s = world("cancelled");
    // Both shapes of a change-less record: what the route writes (no from/to), and a hand-written from == to.
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled"), { ...record(2, "admin_cancel", "cancelled", "cancelled"), metadata: { reason: null } }, record(3, "admin_cancel", "cancelled", "cancelled")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "open", "the newest record that CHANGED the state is the cancel from open");
  });

  it("RED before: restore of a removed COMPLETED event is completed again — it was reopened as `open`", async () => {
    const s = world("archived", { visibility: "invite_only" });
    s.event_activity_log = [record(1, "admin_remove", "completed", "archived")];
    install(s);
    const r = await moderate("restore");
    assert.equal(r.status, 200, r.raw);
    assert.equal(ev(s).state, "completed");
  });

  it("RED before: restore whose moderation record cannot be read is refused naming it — nothing changed", async () => {
    const s = world("cancelled", { visibility: "invite_only" });
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled")];
    install(s, { overrides: { event_activity_log: (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r = await moderate("restore");
    assert.equal(r.status, 500, r.raw);
    assert.equal(r.body.error, "db_error");
    assert.match(r.body.message, /moderation record could not be read \(event_activity_log\): simulated failure/);
    assert.equal(ev(s).state, "cancelled");
    assert.equal(ev(s).visibility, "invite_only");
  });

  it("GREEN before (CONTROL): the moderator's own cancel is reversible through the route, again and again", async () => {
    const s = world("open");
    install(s);
    for (let i = 0; i < 2; i++) {
      assert.equal((await moderate("cancel")).status, 200);
      assert.equal(ev(s).state, "cancelled");
      const r = await moderate("restore");
      assert.equal(r.status, 200, r.raw);
      assert.equal(ev(s).state, "open");
    }
  });

  it("GREEN before (CONTROL): a state change that lost a race (the host cancelled between the read and the claim) is a 409 with nothing written", async () => {
    const s = world("open");
    let raced = false;
    install(s, { overrides: { events: (calls, run) => {
      if (calls.some(([m]) => m === "update") && !raced) { raced = true; ev(s).state = "cancelled"; }
      return run();
    } } });
    const r = await moderate("remove");
    assert.equal(r.status, 409, r.raw);
    assert.equal(ev(s).state, "cancelled", "the host's cancel stands");
    assert.equal(ev(s).visibility, "public");
    assert.deepEqual(s.event_activity_log, []);
  });

  it("GREEN before (CONTROL): a cancel whose audit row fails is undone, and nobody is told — the push waits for the audit", async () => {
    const s = world("open");
    install(s, { strict: { writeError: { table: "moderation_actions", error: { message: "audit insert refused" } } } });
    const r = await moderate("cancel");
    assert.equal(r.status, 500, r.raw);
    assert.equal(ev(s).state, "open");
    assert.deepEqual(s.event_activity_log, []);
    await sleep(100);
    assert.equal(pushes.length, 0);
  });

  it("RED before (a new guard): applyEventModeration refuses a raw `state` change — only an authority decision may carry one", async () => {
    const s = world("open");
    install(s);
    const sc = (await import("../lib/supabase.js")).getServiceClient()!;
    const out = await C.applyEventModeration(sc, null, { ...ev(s) }, {
      changes: { state: "cancelled" }, now: at(900), activityAction: "admin_cancel",
      writeActivity: () => sc.from("event_activity_log").insert({ event_id: EVENT, actor_id: ADMIN, action: "admin_cancel", metadata: {} }).select("id"),
      writeAudit: () => Promise.resolve({ error: null }),
    });
    assert.equal(out.outcome, "refused", JSON.stringify(out));
    assert.equal(ev(s).state, "open");
    assert.deepEqual(s.event_activity_log, []);
  });

  it("RED before (a new guard): a decision taken from another state than the one read is refused, nothing written", async () => {
    const s = world("open");
    install(s);
    const sc = (await import("../lib/supabase.js")).getServiceClient()!;
    const out = await C.applyEventModeration(sc, null, { ...ev(s) }, {
      changes: { visibility: "invite_only" }, stateDecision: { allowed: true, from: "draft", to: "cancelled" }, now: at(900), activityAction: "admin_cancel",
      writeActivity: () => sc.from("event_activity_log").insert({ event_id: EVENT, actor_id: ADMIN, action: "admin_cancel", metadata: {} }).select("id"),
      writeAudit: () => Promise.resolve({ error: null }),
    });
    assert.equal(out.outcome, "refused", JSON.stringify(out));
    assert.equal(ev(s).state, "open");
    assert.equal(ev(s).visibility, "public");
    assert.deepEqual(s.event_activity_log, []);
    // Nor a refused decision, nor one that changes nothing.
    for (const stateDecision of [{ allowed: false, from: "open", to: "cancelled" }, { allowed: true, from: "open", to: "open" }]) {
      const again = await C.applyEventModeration(sc, null, { ...ev(s) }, {
        changes: { visibility: "invite_only" }, stateDecision, now: at(901), activityAction: "admin_cancel",
        writeActivity: () => sc.from("event_activity_log").insert({ event_id: EVENT, actor_id: ADMIN, action: "admin_cancel", metadata: {} }).select("id"),
        writeAudit: () => Promise.resolve({ error: null }),
      });
      assert.equal(again.outcome, "refused", `${JSON.stringify(stateDecision)}: ${JSON.stringify(again)}`);
    }
    assert.equal(ev(s).visibility, "public");
    assert.deepEqual(s.event_activity_log, []);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D. The appeal path — services/appeals/resolveAppeal.ts
// ══════════════════════════════════════════════════════════════════════════════

describe("D. an approved event appeal reverses the recorded moderation, through the same authority", () => {
  const appeal = { id: APPEAL, appellant_id: HOST, target_type: "event", target_id: EVENT, resolution_note: "upheld", moderator_id: ADMIN };

  it("RED before: a moderator-cancelled draft goes back to draft, and the reversal is recorded `via: appeal` — it was published as `open`", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "draft", "cancelled")];
    const { client } = install(s);
    const r = await resolveAppeal(client, appeal);
    assert.deepEqual(r, { ok: true, action: "event_restored" });
    assert.equal(ev(s).state, "draft");
    const last = s.event_activity_log!.at(-1)!;
    assert.equal(last.action, "admin_restore");
    assert.deepEqual(last.metadata, { via: "appeal", appeal_id: APPEAL, reason: "upheld", from_state: "cancelled", to_state: "draft" });
  });

  it("RED before: a HOST-cancelled event is not un-cancelled — the restoration is deferred to a person", async () => {
    const s = world("cancelled");
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, true);
    assert.equal(r.action, "restore_requires_policy");
    assert.equal(r.restored, false);
    assert.match(r.reason, /no recorded moderation put it there/);
    assert.equal(ev(s).state, "cancelled");
  });

  it("RED before: a COMPLETED event is not reopened — there is no moderation state change to reverse", async () => {
    const s = world("completed");
    const { client } = install(s);
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.action, "restore_requires_policy");
    assert.match(r.reason, /the event is 'completed': there is no moderation state change to reverse/);
    assert.equal(ev(s).state, "completed");
    assert.deepEqual(s.event_activity_log, []);
  });

  it("RED before: an unreadable moderation record holds the appeal (noop), never a restore on a guess", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled")];
    const { client } = install(s, { overrides: { event_activity_log: (calls) => (isListRead(calls) ? { data: null, error: FAIL, count: null } : null) } });
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, false);
    assert.equal(r.action, "noop");
    assert.match(r.reason, /event restore failed: The event's moderation record could not be read/);
    assert.equal(ev(s).state, "cancelled");
  });

  it("GREEN before (CONTROL): an event the appellant does not host matches nothing — a noop, the event untouched", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled")];
    const { client } = install(s);
    const r: any = await resolveAppeal(client, { ...appeal, appellant_id: GOING });
    assert.equal(r.ok, false);
    assert.match(r.reason, /matched no row/);
    assert.equal(ev(s).state, "cancelled");
  });

  it("RED before: the appeal's reversal is undone when its record cannot be written — the next restore must not decide on a stale record", async () => {
    const s = world("cancelled");
    s.event_activity_log = [record(1, "admin_cancel", "open", "cancelled")];
    const { client } = install(s, { strict: { writeError: { table: "event_activity_log", error: { message: "activity insert refused" } } } });
    const r: any = await resolveAppeal(client, appeal);
    assert.equal(r.ok, false);
    assert.match(r.reason, /activity log could not be written \(activity insert refused\).*restored to what it held when read/);
    assert.equal(ev(s).state, "cancelled");
  });
});

