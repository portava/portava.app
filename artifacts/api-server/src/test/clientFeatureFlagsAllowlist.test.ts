/**
 * GET /api/feature-flags serves the client-facing flags only, and that list
 * moves with the app (sec/public-surface, 2026-11-04).
 *
 * PART 1, THE GUARD. Scans the app tree (travel-buddy-standalone, non-test
 * .ts/.tsx) for every way it reads a flag name out of the public flag bundle:
 *
 *   R1  FeatureFlagsContext's readers, isEnabled / isLivePlacesEnabled, and any
 *       name they are bound to (`{ isEnabled: flagEnabled }`,
 *       `const on = ctx.isEnabled`), called with a literal, a `const NAME =
 *       '…'` from anywhere in the tree, or a member of a const object of
 *       literals (INTEL_FLAGS.quickSignal);
 *   R2  flag-carrying properties in route and mode tables (featureFlag /
 *       flagKey / flagName / requiresFlag: '…');
 *   R3  direct reads of the response body: flags['…'], flags?.['…'], flags.x_y;
 *   R4  the Live Places parents FeatureFlagsContext re-checks on the device
 *       (its own `requirements` map), for every child R1–R3 found.
 *
 * and FAILS when:
 *   (a) the app reads a name CLIENT_FEATURE_FLAGS lacks: the endpoint would
 *       never serve it and the screen would read `false` for ever, silently;
 *   (b) a reader is called with an argument the scan cannot resolve, or a
 *       reader is handed to another function, and neither is declared below
 *       with a reason: "could not tell which flag" must not look like "fine";
 *   (c) a CLIENT_FEATURE_FLAGS name is read by nothing (stale: it would publish
 *       a flag no client uses), or a declaration below no longer matches;
 *   (d) the scan has no subject (no app tree, no files, no names).
 *
 * The scan is written here, independently of scripts/check-flag-polarity.mjs
 * (which asks a different question, "is every read flag seeded"); it is a
 * superset of that script's app-tree readers, adding R1's aliases and R3/R4.
 *
 * PART 2, THE ENDPOINT. With rows for client flags, server-only kill switches,
 * server-only gates, an unreleased flag and a hidden inert flag all TRUE, the
 * response carries only client flags, keeps the Live Places derivation, and
 * keeps HIDDEN_INERT_FLAGS out.
 *
 * Run: node --import tsx/esm --test src/test/clientFeatureFlagsAllowlist.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT_FEATURE_FLAGS, clientFeatureFlags, isClientFeatureFlag } from "../lib/clientFeatureFlags.js";
import { HIDDEN_INERT_FLAGS } from "../lib/hiddenInertFlags.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_ROOT = join(PKG_ROOT, "..", "..", "travel-buddy-standalone");
const CONTEXT_FILE = "src/context/FeatureFlagsContext.tsx";

// ── Declarations: reads the scan cannot resolve on its own, each with a reason ─

/** A reader argument that is not a literal, a const or a const-object member. */
const DECLARED_UNRESOLVED: Array<{ file: string; expr: string; reason: string }> = [
  {
    file: "app/(tabs)/media.tsx",
    expr: "flagKey",
    reason:
      "Both filter sites map over the module-level ALL_MODES table, whose entries carry literal " +
      "`flagKey: '…'` properties; R2 reads those literals, so every name this call can receive is scanned.",
  },
  {
    file: CONTEXT_FILE,
    expr: "key",
    reason: "FeatureFlagsContext's own reader: `flags[key] === true`. The names come from its callers, which R1 scans.",
  },
  {
    file: CONTEXT_FILE,
    expr: "parent",
    reason: "FeatureFlagsContext's own parent check, `flags[parent] === true`, over its requirements map, which R4 reads.",
  },
];

/** A reader handed to another function, which then calls it with names. */
const DECLARED_HANDOFFS: Array<{ file: string; callee: string; reason: string }> = [
  {
    file: "app/(tabs)/media.tsx",
    callee: "resolveMediaSurfaceDecisions",
    reason:
      "src/features/media/state/mediaSurfaceFlags.ts wraps the reader in a local `isEnabled` and calls it with " +
      "literals (on purpose, for check-flag-polarity); R1 scans that file.",
  },
  {
    file: "src/features/media/hooks/useMediaSurfaceDecisions.ts",
    callee: "resolveMediaSurfaceDecisions",
    reason: "Same receiver as above: mediaSurfaceFlags.ts, scanned by R1.",
  },
];

// ── The scan ──────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", ".git", ".expo", "ios", "android", "static-build", "dist"].includes(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const isTestFile = (rel: string) =>
  /(^|\/)(__tests__|__mocks__|__fixtures__|e2e)\//.test(rel) || /\.(test|spec)\.tsx?$/.test(rel) || rel.endsWith(".d.ts");

/** Blank out comments, keeping strings and line structure (a doc comment naming `isEnabled()` is not a call). */
function stripComments(src: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "sq" | "dq" | "tpl" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out += "  "; i++; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out += "  "; i++; continue; }
      if (c === "'") state = "sq"; else if (c === '"') state = "dq"; else if (c === "`") state = "tpl";
      out += c;
      continue;
    }
    if (state === "line") { if (c === "\n") { state = "code"; out += "\n"; } else out += " "; continue; }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out += "  "; i++; continue; }
      out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "\\") { out += src.slice(i, i + 2); i++; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) state = "code";
    out += c;
  }
  return out;
}

/** The text between the parenthesis at `open` and its match (strings respected), or null. */
function balancedArgs(src: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return null;
}

/** The first top-level argument of an argument list. */
function firstArg(args: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/** Is the `(` at `open` a call's (an identifier or a closing bracket before it, and not `function name(`)? */
function isCallParen(src: string, open: number): { callee: string } | null {
  let j = open - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  const end = j + 1;
  while (j >= 0 && /[\w$.]/.test(src[j])) j--;
  const callee = src.slice(j + 1, end);
  if (!callee || !/^[A-Za-z_$]/.test(callee)) return null;
  if (/\bfunction\s*$/.test(src.slice(Math.max(0, j - 12), j + 1)) || /^(if|for|while|switch|catch|return|typeof)$/.test(callee)) return null;
  return { callee };
}

/** The innermost unclosed bracket before `idx`. */
function enclosingOpener(src: string, idx: number): number {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = src[i];
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) { if (depth === 0) return i; depth--; }
  }
  return -1;
}

interface Scan {
  files: number;
  reads: Map<string, Set<string>>;
  unresolved: Array<{ file: string; expr: string }>;
  handoffs: Array<{ file: string; callee: string }>;
  requirements: Map<string, string[]>;
}

function scanAppTree(root: string): Scan {
  const files = walk(root).filter((f) => !isTestFile(relative(root, f).split("\\").join("/")));
  const srcs = new Map<string, string>();
  const consts = new Map<string, string>();
  for (const f of files) {
    const s = stripComments(readFileSync(f, "utf8"));
    srcs.set(relative(root, f).split("\\").join("/"), s);
    for (const m of s.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(['"`])([A-Za-z0-9_]+)\2/g)) {
      if (!consts.has(m[1])) consts.set(m[1], m[3]);
    }
    for (const m of s.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*\{([^{}]*)\}/g)) {
      for (const p of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*(['"`])([A-Za-z0-9_]+)\2/g)) {
        const key = `${m[1]}.${p[1]}`;
        if (!consts.has(key)) consts.set(key, p[3]);
      }
    }
  }

  const reads = new Map<string, Set<string>>();
  const unresolved: Scan["unresolved"] = [];
  const handoffs: Scan["handoffs"] = [];
  const note = (flag: string, file: string, src: string, idx: number) => {
    if (!reads.has(flag)) reads.set(flag, new Set());
    reads.get(flag)!.add(`${file}:${src.slice(0, idx).split("\n").length}`);
  };
  const resolve = (expr: string): string | null => {
    const lit = /^(['"`])([A-Za-z0-9_]+)\1$/.exec(expr);
    if (lit) return lit[2];
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(expr) && consts.has(expr)) return consts.get(expr)!;
    return null;
  };

  for (const [file, s] of srcs) {
    // R1 — the readers, and every name this file binds them to.
    const readers = new Set(["isEnabled", "isLivePlacesEnabled"]);
    for (const m of s.matchAll(/\b(?:isEnabled|isLivePlacesEnabled)\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/g)) readers.add(m[1]);
    for (const m of s.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.()]*\.(?:isEnabled|isLivePlacesEnabled)\b(?!\s*\()/g)) readers.add(m[1]);
    const alt = [...readers].map((r) => r.replace(/\$/g, "\\$")).join("|");
    for (const m of s.matchAll(new RegExp(`(?<![\\w$])(${alt})\\s*\\(`, "g"))) {
      // A declaration (`const isEnabled = (` / `function isEnabled(`) is not a read.
      if (/(?:function\s+|(?:const|let|var)\s+)$/.test(s.slice(Math.max(0, m.index! - 12), m.index!))) continue;
      const args = balancedArgs(s, m.index! + m[0].length - 1);
      const expr = args === null ? "" : firstArg(args);
      const flag = resolve(expr);
      if (flag) note(flag, file, s, m.index!);
      else unresolved.push({ file, expr });
    }
    // R1 — a reader handed to another function as an argument.
    for (const m of s.matchAll(new RegExp(`(?<![\\w$.])(${alt})(?![\\w$])(?!\\s*[(:=])`, "g"))) {
      const open = enclosingOpener(s, m.index!);
      if (open < 0 || s[open] !== "(") continue; // a dependency array, an object, a declaration
      const call = isCallParen(s, open);
      if (call && !readers.has(call.callee)) handoffs.push({ file, callee: call.callee });
    }
    // R2 — flag-carrying properties.
    for (const m of s.matchAll(/\b(?:featureFlag|flagKey|flagName|requiresFlag)\s*:\s*(['"`])([A-Za-z0-9_]+)\1/g)) note(m[2], file, s, m.index!);
    // R3 — direct reads of the response body.
    for (const m of s.matchAll(/\bflags\s*(?:\?\.)?\s*\[\s*([^\]]+?)\s*\]/g)) {
      const flag = resolve(m[1]);
      if (flag) note(flag, file, s, m.index!);
      else unresolved.push({ file, expr: m[1] });
    }
    for (const m of s.matchAll(/\bflags\s*\??\.\s*([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b/g)) note(m[1], file, s, m.index!);
  }

  // R4 — FeatureFlagsContext's own parent map, as the device applies it.
  const requirements = new Map<string, string[]>();
  const ctx = srcs.get(CONTEXT_FILE) ?? "";
  const block = /const\s+requirements\b[^=]*=\s*\{([\s\S]*?)\};/.exec(ctx);
  if (block) {
    for (const m of block[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*\[([^\]]*)\]/g)) {
      requirements.set(m[1], [...m[2].matchAll(/(['"`])([A-Za-z0-9_]+)\1/g)].map((p) => p[2]));
    }
  }
  return { files: files.length, reads, unresolved, handoffs, requirements };
}

/** R1–R3's names plus, for each, the parents the device re-checks (R4), transitively. */
function clientReadSet(scan: Scan): Map<string, string> {
  const out = new Map<string, string>();
  for (const [flag, sites] of scan.reads) out.set(flag, [...sites][0]);
  const queue = [...out.keys()];
  while (queue.length) {
    const child = queue.pop()!;
    for (const parent of scan.requirements.get(child) ?? []) {
      if (!out.has(parent)) { out.set(parent, `${CONTEXT_FILE} (parent of ${child})`); queue.push(parent); }
    }
  }
  return out;
}

// ── PART 1 ────────────────────────────────────────────────────────────────────

describe("CLIENT_FEATURE_FLAGS is exactly what the app reads", () => {
  let scan: Scan;
  let read: Map<string, string>;
  before(() => {
    assert.ok(existsSync(APP_ROOT), `VACUOUS: no app tree at ${APP_ROOT}. Check it out; do not skip this guard.`);
    scan = scanAppTree(APP_ROOT);
    read = clientReadSet(scan);
  });

  it("the scan has a subject: files, names, and FeatureFlagsContext's parent map", () => {
    assert.ok(scan.files > 100, `only ${scan.files} app files scanned`);
    assert.ok(scan.reads.size > 20, `only ${scan.reads.size} flag names found: the matchers broke`);
    assert.ok(scan.requirements.size > 0, `no requirements map found in ${CONTEXT_FILE}`);
    for (const known of ["wall_enabled", "rent_buddy_enabled", "find_your_circle_enabled", "MEDIA_WORLD_SHELL_ENABLED", "intel_trail_followup"]) {
      assert.ok(read.has(known), `${known} is read by the app today and the scan missed it (R1 literal, R3 direct, R1 const-object)`);
    }
  });

  it("(a) every flag the app reads is served", () => {
    const missing = [...read].filter(([flag]) => !isClientFeatureFlag(flag)).map(([flag, site]) => `${flag}  (read at travel-buddy-standalone/${site})`);
    assert.deepEqual(missing, [], "add these to CLIENT_FEATURE_FLAGS (lib/clientFeatureFlags.ts), or GET /api/feature-flags never serves them and the app reads false for ever:\n" + missing.join("\n"));
  });

  it("(b) every reader argument resolves, or is declared", () => {
    const undeclared = scan.unresolved.filter((u) => !DECLARED_UNRESOLVED.some((d) => d.file === u.file && d.expr === u.expr));
    assert.deepEqual(undeclared, [], "the scan cannot tell which flag these read; resolve them (a literal or a const) or declare them in DECLARED_UNRESOLVED with a reason");
    const undeclaredHandoffs = scan.handoffs.filter((h) => !DECLARED_HANDOFFS.some((d) => d.file === h.file && d.callee === h.callee));
    assert.deepEqual(undeclaredHandoffs, [], "a flag reader is handed to another function; declare it in DECLARED_HANDOFFS, naming the file that calls it and confirming the scan reads that file");
  });

  it("(c) nothing is served that the app does not read, and no declaration is stale", () => {
    const stale = CLIENT_FEATURE_FLAGS.filter((f) => !read.has(f));
    assert.deepEqual(stale, [], "no app code reads these: remove them from CLIENT_FEATURE_FLAGS, so the public bundle publishes nothing a client ignores");
    assert.equal(new Set(CLIENT_FEATURE_FLAGS).size, CLIENT_FEATURE_FLAGS.length, "duplicate entries");
    for (const d of DECLARED_UNRESOLVED) {
      assert.ok(scan.unresolved.some((u) => u.file === d.file && u.expr === d.expr), `DECLARED_UNRESOLVED ${d.file} \`${d.expr}\` no longer occurs: remove it`);
    }
    for (const d of DECLARED_HANDOFFS) {
      assert.ok(scan.handoffs.some((h) => h.file === d.file && h.callee === d.callee), `DECLARED_HANDOFFS ${d.file} → ${d.callee} no longer occurs: remove it`);
    }
  });

  it("no hidden inert flag is listed, and no kill switch is listed without a reader", () => {
    for (const f of CLIENT_FEATURE_FLAGS) assert.equal(HIDDEN_INERT_FLAGS.has(f), false, f);
    // Every listed stop is there because the app reads it (asserted by (c)); today none is.
    assert.deepEqual(CLIENT_FEATURE_FLAGS.filter((f) => /^disable_|_disabled$/.test(f)).filter((f) => !read.has(f)), []);
  });

  it("the guard fires: an app read of an unlisted name is reported", () => {
    // The same scanner over a three-file fixture: an aliased read, a literal read
    // of a child (whose parent R4 must add), and a direct body read, all unlisted.
    const fixture = scanFixture({
      "src/context/FeatureFlagsContext.tsx": "const requirements: Record<string, string[]> = { child_enabled: ['parent_enabled'] };",
      "app/screen.tsx":
        "const { isEnabled: on } = useFeatureFlags(); const A = on('brand_new_screen_enabled'); const B = isEnabled('child_enabled');",
      "src/hooks/useX.ts": "const v = body?.flags?.['another_unlisted_enabled'];",
    });
    const names = [...clientReadSet(fixture).keys()].sort();
    assert.deepEqual(names, ["another_unlisted_enabled", "brand_new_screen_enabled", "child_enabled", "parent_enabled"]);
    assert.ok(names.every((n) => !isClientFeatureFlag(n)), "so part (a) would fail on each");
  });
});

/** Run scanAppTree over a small tree written to a temp dir. */
function scanFixture(filesByPath: Record<string, string>): Scan {
  const dir = mkdtempSync(join(tmpdir(), "client-flags-"));
  try {
    for (const [p, body] of Object.entries(filesByPath)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    return scanAppTree(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── PART 2 ────────────────────────────────────────────────────────────────────

describe("GET /api/feature-flags serves the client-facing set only", () => {
  let server: http.Server;
  let rows: Array<{ flag: string; enabled: boolean }> = [];
  const fakeClient = {
    from: (table: string) => {
      assert.equal(table, "feature_flags");
      const b: any = { select: () => b, order: () => b, then: (res: any, rej: any) => Promise.resolve({ data: rows, error: null }).then(res, rej) };
      return b;
    },
  };

  before(async () => {
    const app = express();
    app.use((req: any, _res, next) => { req.log = { error() {}, warn() {}, info() {}, debug() {} }; next(); });
    const { default: featureFlags } = await import("../routes/featureFlags.js");
    app.use("/api", featureFlags);
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
    _setTestServiceClient(fakeClient as any);
  });
  after(() => { _setTestServiceClient(null); return new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => {
    rows = [
      // client-facing
      { flag: "wall_enabled", enabled: true },
      { flag: "rent_buddy_enabled", enabled: false },
      { flag: "external_places_enabled", enabled: false },
      { flag: "live_places_enabled", enabled: true },
      // server-only kill switches, engaged
      { flag: "disable_signups", enabled: true },
      { flag: "disable_rent_buddy_booking", enabled: true },
      { flag: "disable_rab_bookings", enabled: true },
      // server-only gates and an unreleased feature
      { flag: "invite_only_beta", enabled: true },
      { flag: "RENT_BUDDY_ADMIN_ONLY_MODE", enabled: true },
      { flag: "COMPASS_ENABLED", enabled: true },
      { flag: "telegraph_forwarding_enabled", enabled: false },
      // retired, hidden everywhere
      { flag: "freeze_city", enabled: true },
    ];
  });

  async function getFlags(): Promise<Record<string, boolean>> {
    const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/feature-flags`);
    assert.equal(r.status, 200);
    return ((await r.json()) as { flags: Record<string, boolean> }).flags;
  }

  it("serves the client flags it has rows for, and nothing else", async () => {
    const flags = await getFlags();
    assert.deepEqual(Object.keys(flags).sort(), ["external_places_enabled", "live_places_enabled", "rent_buddy_enabled", "wall_enabled"]);
    assert.equal(flags.wall_enabled, true);
    assert.equal(flags.rent_buddy_enabled, false);
  });

  it("never serves a kill switch, a server-only gate, an unreleased flag or a hidden inert flag", async () => {
    const flags = await getFlags();
    for (const f of ["disable_signups", "disable_rent_buddy_booking", "disable_rab_bookings", "invite_only_beta", "RENT_BUDDY_ADMIN_ONLY_MODE", "COMPASS_ENABLED", "telegraph_forwarding_enabled", "freeze_city"]) {
      assert.equal(f in flags, false, `${f} must not be served`);
    }
  });

  it("keeps the Live Places derivation: a child whose parent is off is served false", async () => {
    assert.equal((await getFlags()).live_places_enabled, false, "external_places_enabled is off");
    rows.find((r) => r.flag === "external_places_enabled")!.enabled = true;
    assert.equal((await getFlags()).live_places_enabled, true);
  });

  it("whatever the table holds, every served key is a client flag", async () => {
    rows = [...HIDDEN_INERT_FLAGS, ...CLIENT_FEATURE_FLAGS, "disable_messaging", "disable_posting", "some_future_flag_enabled"].map((flag) => ({ flag, enabled: true }));
    const flags = await getFlags();
    assert.ok(Object.keys(flags).every(isClientFeatureFlag), Object.keys(flags).filter((f) => !isClientFeatureFlag(f)).join(", "));
    assert.equal(Object.keys(flags).length, CLIENT_FEATURE_FLAGS.length);
    assert.deepEqual(clientFeatureFlags({ disable_x: true, wall_enabled: false }), { wall_enabled: false });
  });
});
