/**
 * Telegraph §30A.19 — the Context Kernel stays the ONE assembler (census-telegraph
 * T439, T381). Static: reads .ts files off disk; no database, no network.
 *
 * The census's objection to building a relationship model (§45.3, T379) was
 * that a new resolver beside the old ones makes the anti-pattern worse. The
 * kernel answers it only if it is the composition point and stays one. This
 * suite holds four things:
 *
 *   G1  the §14.1 capability policy takes its relationship term from the
 *       kernel's relationship module — never from the resolver or canMessage —
 *       and only behind `telegraph_context_kernel_enabled`, only in a direct
 *       conversation, after the block input;
 *   G2  the relationship resolver is reached only through the kernel (and the
 *       §30A.1 route that is its own surface), and the kernel's relationship
 *       module only by the kernel and the policy;
 *   G3  no module outside the kernel composes conversation context from two or
 *       more of the context sources — except a CLOSED, SHRINK-ONLY list of the
 *       assemblers that predate it, each with its reason, each still one;
 *   G4  the kernel's proximity read is Nearby's own chain (same limiter and
 *       ceiling, same quantum, loader, signal contract and budget, in order),
 *       and the kernel neither reads `messages` nor can carry a coordinate.
 *
 * MUTANTS (each alone, each red, each reverted — b58/lane-TM-5.md):
 *   - the policy reads readTelegraphRelationship directly ................. G1 red
 *   - the policy's flag condition removed ................................. G1 red
 *   - a route composes relationship + shared context itself ............... G3 red
 *   - an allowlisted assembler stops assembling (entry left behind) ....... G3 red
 *   - the kernel skips applyObservationBudget ............................. G4 red
 *
 * Run: node --import tsx/esm --test src/test/telegraphContextKernelGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { CONTEXT_KERNEL_FLAG } from "../domain/telegraph/contracts/telegraphContextKernel.js";
import {
  NEARBY_RATE_LIMIT,
  NEARBY_RATE_LIMITER,
  NEARBY_RATE_WINDOW_MS,
} from "../server/telegraph/telegraphContextKernel.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const POLICY = "domain/telegraph/policies/conversationCapabilityPolicy.ts";
const KERNEL = "server/telegraph/telegraphContextKernel.ts";
const KERNEL_RELATIONSHIP = "server/telegraph/telegraphContextRelationship.ts";
const CONTRACT = "domain/telegraph/contracts/telegraphContextKernel.ts";
const NEARBY_ROUTE = "routes/nearbyReachable.ts";

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const posix = (p: string) => p.split(sep).join("/");

/** Every non-test, non-script .ts module under src/, as a path relative to src/. */
function modules(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === "test" || name === "scripts" || name === "node_modules") continue;
        walk(p);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
        out.push(posix(relative(SRC, p)));
      }
    }
  };
  walk(SRC);
  return out.sort();
}

/** The src-relative modules a file imports (relative specifiers only), without extension. */
function importsOf(rel: string): string[] {
  const src = read(rel);
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = m[1]!;
    if (!spec.startsWith(".")) continue;
    out.push(posix(normalize(join(dirname(rel), spec))).replace(/\.js$/, "").replace(/\.ts$/, ""));
  }
  return out;
}

const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function callsNamed(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if ((ts.isIdentifier(e) && e.text === name) || (ts.isPropertyAccessExpression(e) && e.name.text === name)) found.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("G1 — the capability policy's relationship term comes from the kernel, behind its flag", () => {
  const imports = importsOf(POLICY);

  it("imports the kernel's relationship module, and neither the resolver nor canMessage", () => {
    assert.ok(imports.includes("server/telegraph/telegraphContextRelationship"), "the policy does not take its term from the kernel");
    assert.ok(!imports.includes("services/telegraph/telegraphRelationship"), "the policy reads the relationship resolver around the kernel");
    assert.ok(!imports.includes("lib/messagingPermissions"), "the policy derives a relationship from canMessage itself — a sixth resolver");
  });

  it("consults the term exactly once, inside the kernel flag, a direct conversation and a clear block input", () => {
    const sf = parse(POLICY);
    const callsites = callsNamed(sf, "readKernelRelationship");
    assert.equal(callsites.length, 1, "the policy must read the kernel's term in one place");
    let p: ts.Node | undefined = callsites[0];
    while (p && !ts.isIfStatement(p)) p = p.parent;
    assert.ok(p && ts.isIfStatement(p), "the term is read outside any condition");
    const cond = (p as ts.IfStatement).expression.getText(sf).replace(/\s+/g, " ");
    assert.ok(cond.includes(`isFlagEnabled(sc, "${CONTEXT_KERNEL_FLAG}")`), `the term is read without the kernel flag: ${cond}`);
    assert.ok(cond.includes('conversationType === "direct"'), `the term is read outside a direct conversation: ${cond}`);
    assert.ok(cond.includes("!blocked") && cond.includes("!blockUnreadable"), `the term is read past the block input: ${cond}`);
  });

  it("the term can only refuse canCall: kernelCallTerm's answer reaches no other capability", () => {
    const src = read(POLICY);
    const block = src.slice(src.indexOf("readKernelRelationship(sc"), src.indexOf("readKernelRelationship(sc") + 400);
    const denies = [...block.matchAll(/deny\(d, "(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(denies, ["canCall"], `the kernel's term refuses ${denies.join(", ")}`);
  });

  it("the flag name is one name: contract, policy, route and migration agree", () => {
    assert.equal(CONTEXT_KERNEL_FLAG, "telegraph_context_kernel_enabled");
    assert.ok(read(POLICY).includes(`"${CONTEXT_KERNEL_FLAG}"`));
    assert.ok(read("server/telegraph/telegraphContextRoute.ts").includes(`readFlagState(sc, "${CONTEXT_KERNEL_FLAG}")`));
    assert.ok(read("migrations/3826_telegraph_context_kernel_flag.sql").includes(`('${CONTEXT_KERNEL_FLAG}', false,`), "3826 does not seed the flag FALSE");
  });
});

describe("G2 — the relationship resolver is reached through the kernel", () => {
  const all = modules();
  const importers = (target: string) => all.filter((m) => importsOf(m).includes(target));

  it("services/telegraph/telegraphRelationship is imported only by the kernel's relationship module and §30A.1's own route", () => {
    assert.deepEqual(importers("services/telegraph/telegraphRelationship"), [
      "routes/telegraphGroups.ts", // GET /users/:id/telegraph-relationship — T380's own surface, behind 3662's flag
      KERNEL_RELATIONSHIP,
    ]);
  });

  it("the kernel's relationship module is imported only by the kernel and the policy", () => {
    assert.deepEqual(importers("server/telegraph/telegraphContextRelationship"), [POLICY, KERNEL]);
  });
});

/**
 * The modules conversation context is composed FROM. The kernel's five sources,
 * plus the two the kernel deliberately does not re-project: canMessage's
 * relationship facts (the resolver's own input) and availability windows (§31's
 * "world context", which the conversation header projects under its own consent
 * rules).
 */
const SOURCES: Record<string, string[]> = {
  relationship: ["services/telegraph/telegraphRelationship", "server/telegraph/telegraphContextRelationship", "lib/messagingPermissions"],
  time: ["services/telegraph/coordination", "services/telegraph/coordinationStages"],
  availability: ["services/passport/OpenToPlansService"],
  proximity: ["services/telegraph/reachablePeopleQuery"],
  intent: ["services/telegraphIntent"],
  sharedObjects: ["services/telegraph/sharedContext"],
};

/**
 * Assemblers that predate the kernel. CLOSED and SHRINK-ONLY: an entry is
 * removed when its module stops assembling (TM-6 routes the first two through
 * the kernel); a new assembler is never added here — it reads the kernel.
 */
const PREDATING_ASSEMBLERS: Record<string, string> = {
  "compass/TelegraphConversationTools.ts":
    "Compass's §18.3 getConversationContext / getParticipantAvailability compose canMessage's edges and availability windows; B58 TM-6 routes them through the kernel and removes this entry.",
  "routes/telegraphSharedContext.ts":
    "the conversation header (identity, availability) and the §3 rail; B58 TM-6 has the header read GET /threads/:id/context and removes this entry.",
  "services/telegraph/reachablePeopleQuery.ts":
    "the Nearby loader: §30A.2's ReachablePersonProjection IS a composition of relationship and availability, and it is the kernel's PROXIMITY SOURCE — the kernel reads it, so it cannot read the kernel. Permanent.",
};

describe("G3 — one assembler: no module outside the kernel composes context from two sources", () => {
  const assemblers = new Map<string, string[]>();
  for (const m of modules()) {
    const imports = importsOf(m);
    const families = Object.keys(SOURCES).filter((f) => SOURCES[f]!.some((s) => imports.includes(s)));
    if (families.length >= 2) assemblers.set(m, families);
  }

  it("the kernel composes all five of its sources", () => {
    assert.deepEqual(assemblers.get(KERNEL)?.sort(), ["intent", "proximity", "relationship", "sharedObjects", "time"]);
  });

  it("every other assembler is a predating one, named with its reason", () => {
    const rogue = [...assemblers.keys()].filter((m) => m !== KERNEL && !(m in PREDATING_ASSEMBLERS));
    assert.deepEqual(rogue, [], `new conversation-context assembler(s) — compose through ${KERNEL} instead: ${rogue.map((m) => `${m} [${assemblers.get(m)!.join(", ")}]`).join("; ")}`);
  });

  it("the predating list only shrinks: every entry still assembles (remove the ones that stopped)", () => {
    const stale = Object.keys(PREDATING_ASSEMBLERS).filter((m) => !assemblers.has(m));
    assert.deepEqual(stale, [], `stale entries (the module no longer assembles — delete them): ${stale.join(", ")}`);
    for (const [m, why] of Object.entries(PREDATING_ASSEMBLERS)) assert.ok(why.length >= 60, `${m}: a reason, not a label`);
  });
});

describe("G4 — proximity is Nearby's own chain; no message read; no coordinate", () => {
  it("the kernel spends Nearby's limiter, ceiling and window — the literal the Nearby route uses", () => {
    const route = read(NEARBY_ROUTE);
    const m = route.match(/checkRateLimit\("([^"]+)", user\.id, (\d+), ([\d_]+)\)/);
    assert.ok(m, "the Nearby route's rate limit is no longer where this guard reads it");
    assert.equal(NEARBY_RATE_LIMITER, m![1]);
    assert.equal(NEARBY_RATE_LIMIT, Number(m![2]));
    assert.equal(NEARBY_RATE_WINDOW_MS, Number(m![3]!.replace(/_/g, "")));
  });

  it("both run quantiseNow → loadReachablePeople → withSignalContract → applyObservationBudget", () => {
    const order = (rel: string, start: number, end: number) => {
      const src = read(rel).slice(start, end);
      return ["checkRateLimit(", "quantiseNow(", "withSignalContract(", "loadReachablePeople(", "applyObservationBudget("].map((t) => src.indexOf(t));
    };
    const kernelSrc = read(KERNEL);
    const kStart = kernelSrc.indexOf("export async function readKernelProximity(");
    const k = order(KERNEL, kStart, kernelSrc.indexOf("\n}\n", kStart));
    const routeSrc = read(NEARBY_ROUTE);
    const r = order(NEARBY_ROUTE, routeSrc.indexOf('"/nearby/reachable"'), routeSrc.length);
    for (const [label, idx] of [["kernel", k], ["route", r]] as const) {
      assert.ok(idx.every((i) => i >= 0), `${label}: a step of Nearby's chain is missing (${idx.join(",")})`);
      // the loader runs INSIDE the contract's argument list, so it appears after `withSignalContract(` in the text
      assert.ok(idx[0]! < idx[1]! && idx[1]! < idx[2]! && idx[2]! < idx[3]! && idx[3]! < idx[4]!, `${label}: Nearby's chain is out of order (${idx.join(",")})`);
    }
  });

  it("the kernel reads no message, and its contract has no field that could carry a coordinate", () => {
    for (const rel of [KERNEL, KERNEL_RELATIONSHIP, CONTRACT, "server/telegraph/telegraphContextRoute.ts"]) {
      assert.ok(!/\.from\(\s*["']messages["']\s*\)/.test(read(rel)), `${rel} reads messages`);
    }
    const contract = read(CONTRACT).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/\b(lat|lng|latitude|longitude|distanceKm|etaMinutes|coords?)\b\s*[?]?:/.test(contract), "a coordinate-shaped field is declared in the kernel's contract");
  });
});
