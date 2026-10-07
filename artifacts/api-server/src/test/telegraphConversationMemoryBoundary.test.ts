/**
 * census-telegraph T366 — "No automatic Memory creation from private conversation
 * history" (§29), and §10.2's "Telegraph never automatically converts whole
 * conversations into Memories."
 *
 * The row was an UNGUARDED ABSENCE: no automatic path existed and nothing would
 * have refused one. The guarded version, on the precedent of T19
 * (`CANONICAL_MUTUALITY_SOURCES`): three closed lists in
 * `domain/telegraph/policies/conversationMemoryBoundary.ts`, enforced here over
 * every non-test server module and every SQL migration.
 *
 * WHAT IS EXERCISED
 *   1. The detector itself, on synthetic sources — so a guard that could never
 *      fire cannot pass for one.
 *   2. The whole server tree: no top-level unit reads conversation history AND
 *      reaches a memory creation, except the closed list's one explicit path.
 *   3. The closed list is not stale: its one path really does both, and its
 *      named suite exists.
 *   4. Every SQL migration and the baseline: none inserts into a memory table
 *      in the same file that reads a conversation-history table.
 *
 * SHOWN RED (mutation proof, recorded in the T2 lane report): a `.from("messages")`
 * read added inside `routes/memories.ts`'s create handler turns test 2 red,
 * naming that unit; removed, green.
 *
 * Run: node --import tsx/esm --test src/test/telegraphConversationMemoryBoundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONVERSATION_HISTORY_TABLES,
  EXPLICIT_CONVERSATION_MEMORY_PATHS,
  MEMORY_CREATION_TABLES,
  REVIEWED_CALL_TREE_NON_FLOWS,
  codeUnits,
  conversationReadsIn,
  conversationReadsResolved,
  crossingsInFile,
  crossingsTransitive,
  importedNames,
  memoryCreationsIn,
  memoryCreationsResolved,
  reachingNames,
  sqlCrossesBoundary,
  stringConstsIn,
  stripComments,
  type CodeUnit,
} from "../domain/telegraph/policies/conversationMemoryBoundary.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = join(PKG, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p === join(SRC, "test")) continue;
      walk(p, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(SRC);
const codeOf = new Map<string, string>(files.map((f) => [f, stripComments(readFileSync(f, "utf8"))]));

/** Files that create memory rows anywhere (file level — the conservative side for imports). */
const creatorFiles = new Set(files.filter((f) => memoryCreationsIn(codeOf.get(f)!).length > 0));

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec).replace(/\.js$/, "");
  for (const cand of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(cand)) return cand;
  return null;
}

function crossingsFor(file: string) {
  const code = codeOf.get(file)!;
  const importedCreators = new Set<string>();
  for (const imp of importedNames(code)) {
    const target = resolveImport(file, imp.spec);
    if (target && creatorFiles.has(target)) for (const n of imp.names) importedCreators.add(n);
  }
  return crossingsInFile(code, importedCreators);
}

const allowed = new Set(EXPLICIT_CONVERSATION_MEMORY_PATHS.map((p) => join(PKG, p.file)));

describe("T366 — the detector can fire (synthetic sources)", () => {
  it("a handler that reads messages and inserts a memory is a crossing", () => {
    const src = [
      'router.post("/x", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body").eq("thread_id", t);',
      '  await sc.from("memories").insert({ caption: data[0].body });',
      "});",
    ].join("\n");
    const c = crossingsInFile(stripComments(src), new Set());
    assert.equal(c.length, 1);
    assert.deepEqual(c[0]!.reads, ["messages"]);
    assert.deepEqual(c[0]!.creates, ["memories"]);
  });

  it("…including through a same-file helper and through an imported creator", () => {
    const viaHelper = [
      "async function remember(sc, body) {",
      '  await sc.from("memory_items").upsert({ body });',
      "}",
      'router.post("/y", async (req, res) => {',
      '  const { data } = await sc.from("saved_messages").select("*");',
      "  await remember(sc, data);",
      "});",
    ].join("\n");
    assert.equal(crossingsInFile(stripComments(viaHelper), new Set()).length, 1);

    const viaImport = [
      'router.post("/z", async (req, res) => {',
      '  const { data } = await sc.from("message_translations").select("*");',
      "  await createMemoryFromText(sc, data);",
      "});",
    ].join("\n");
    const c = crossingsInFile(stripComments(viaImport), new Set(["createMemoryFromText"]));
    assert.deepEqual(c[0]!.creates, ["call:createMemoryFromText"]);
  });

  it("a memory-creating RPC counts; erasure and retrieval RPCs do not", () => {
    assert.deepEqual(memoryCreationsIn('await sc.rpc("memory_kernel_execute", { p });'), ["rpc:memory_kernel_execute"]);
    assert.deepEqual(memoryCreationsIn('await sc.rpc("erase_memory_for_user", { p });'), []);
    assert.deepEqual(memoryCreationsIn('await sc.rpc("memory_retrieve", { p });'), []);
  });

  it("a read of a memory table, or an update/delete, is not creation", () => {
    assert.deepEqual(memoryCreationsIn('await sc.from("memories").select("id").eq("id", x);'), []);
    assert.deepEqual(memoryCreationsIn('await sc.from("memories").update({ state: "x" }).eq("id", x);'), []);
    assert.deepEqual(memoryCreationsIn('await sc.from("memories").delete().eq("user_id", u);'), []);
  });

  it("two units of one file that never meet are NOT a crossing (the routes/events.ts shape)", () => {
    const src = [
      'router.post("/events/:id/memory", async (req, res) => {',
      '  const { data: ev } = await sc.from("events").select("*");',
      '  await sc.from("passport_memories").insert({ title: ev.title });',
      "});",
      'router.post("/events/:id/chat", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("id");',
      "});",
    ].join("\n");
    assert.equal(codeUnits(stripComments(src)).length, 2);
    assert.deepEqual(crossingsInFile(stripComments(src), new Set()), []);
  });

  it("an explanation in a comment is not an offence", () => {
    const src = '// we never do sc.from("messages") then sc.from("memories").insert(...)\nconst x = 1;';
    assert.deepEqual(conversationReadsIn(stripComments(src)), []);
    assert.deepEqual(memoryCreationsIn(stripComments(src)), []);
  });

  it("a SQL file that inserts a memory and selects messages crosses; either alone does not", () => {
    assert.equal(sqlCrossesBoundary("INSERT INTO public.memories (x) SELECT body FROM public.messages;"), true);
    assert.equal(sqlCrossesBoundary("INSERT INTO public.memories (x) VALUES (1);"), false);
    assert.equal(sqlCrossesBoundary("SELECT 1 FROM messages;"), false);
    assert.equal(sqlCrossesBoundary("-- INSERT INTO memories ... FROM messages\nSELECT 1;"), false);
  });
});

describe("T366 — the server tree holds the boundary", () => {
  it("the scan is not vacuous: it sees conversation readers and memory creators", () => {
    const readers = files.filter((f) => conversationReadsIn(codeOf.get(f)!).length > 0);
    assert.ok(files.length > 500, `walked ${files.length} files`);
    assert.ok(readers.length >= 10, `only ${readers.length} conversation readers seen`);
    assert.ok(creatorFiles.size >= 3, `only ${creatorFiles.size} memory creators seen`);
  });

  it("no unit outside the closed list reads conversation history and creates a memory", () => {
    const violations: string[] = [];
    for (const f of files) {
      if (allowed.has(f)) continue;
      for (const c of crossingsFor(f)) {
        violations.push(`${relative(PKG, f)} :: ${c.unit} — reads ${c.reads.join(",")} → creates ${c.creates.join(",")}`);
      }
    }
    assert.deepEqual(
      violations,
      [],
      "§29: no automatic Memory creation from private conversation history. A new " +
        "conversation→Memory path must be an EXPLICIT, per-item user action and be added to " +
        "EXPLICIT_CONVERSATION_MEMORY_PATHS with its rule and the suite that proves it.",
    );
  });

  it("the closed list is exactly one path, and it is live — it really does both", () => {
    assert.equal(EXPLICIT_CONVERSATION_MEMORY_PATHS.length, 1);
    for (const p of EXPLICIT_CONVERSATION_MEMORY_PATHS) {
      const abs = join(PKG, p.file);
      assert.ok(existsSync(abs), `${p.file} is listed and does not exist`);
      assert.ok(crossingsFor(abs).length > 0, `${p.file} is listed but no longer crosses — remove the entry`);
      assert.ok(existsSync(join(PKG, p.provedBy)), `${p.provedBy} is named as the proof and does not exist`);
      assert.ok(p.rule.length > 80, "a listed path carries the rule that makes it explicit");
    }
  });

  it("the explicit path takes ONE message and writes a private draft, as literals", () => {
    const route = readFileSync(join(PKG, "src/routes/telegraphMemory.ts"), "utf8");
    assert.match(route, /messageId: z\.string\(\)/);
    for (const forbidden of ["threadId", "messageIds", "conversationId", "all"]) {
      assert.ok(route.includes(`"${forbidden}"`), `the route no longer refuses ${forbidden} by name`);
    }
    const notes = readFileSync(join(PKG, "src/services/telegraph/memoryNotes.ts"), "utf8");
    assert.match(notes, /state: "draft"/);
    assert.match(notes, /visibility: "only_me"/);
  });
});

describe("T366 — no migration crosses the boundary in SQL", () => {
  it("no migration (or the baseline) inserts a memory row in a file that reads conversation history", () => {
    const sqlFiles = [
      ...readdirSync(join(SRC, "migrations")).filter((n) => n.endsWith(".sql")).map((n) => join(SRC, "migrations", n)),
      join(PKG, "baseline/20260819_baseline_structure.sql"),
    ];
    assert.ok(sqlFiles.length > 100);
    const crossing = sqlFiles.filter((f) => sqlCrossesBoundary(readFileSync(f, "utf8"))).map((f) => relative(PKG, f));
    assert.deepEqual(crossing, []);
  });

  it("the vocabularies are the ones the schema defines", () => {
    const schema = [
      readFileSync(join(PKG, "baseline/20260819_baseline_structure.sql"), "utf8"),
      ...readdirSync(join(SRC, "migrations")).filter((n) => n.endsWith(".sql"))
        .map((n) => readFileSync(join(SRC, "migrations", n), "utf8")),
    ].join("\n");
    for (const t of [...MEMORY_CREATION_TABLES, ...CONVERSATION_HISTORY_TABLES]) {
      assert.match(schema, new RegExp(`CREATE TABLE (IF NOT EXISTS )?(public\\.)?${t}\\b`), `${t} is not a table any migration defines`);
    }
  });

  it("every memory event log a migration appends to is on the closed list — both logs, kept distinct", () => {
    // Verification of a58aa01d3f / check:memory-table-ownership (census-telegraph §45f). The
    // projection family's log and the §17 command kernel's log are two different tables
    // (lib/memoryTableOwnership.ts), and migrations append to each: projector triggers to the
    // first, memory_kernel_execute to the second. A conversation must create rows in NEITHER,
    // so both are on MEMORY_CREATION_TABLES; dropping either would let a trigger or migration
    // that reads history and appends there pass the SQL check above. Names are found, not typed.
    const appended = new Set<string>();
    for (const n of readdirSync(join(SRC, "migrations")).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(join(SRC, "migrations", n), "utf8").replace(/--.*$/gm, "");
      for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?"?(memory_[a-z_]*events)"?\b/gi)) appended.add(m[1]!.toLowerCase());
    }
    assert.equal(appended.size, 2, `expected the two memory event logs, found: ${[...appended].join(", ")}`);
    const listed = new Set<string>(MEMORY_CREATION_TABLES);
    assert.deepEqual([...appended].filter((t) => !listed.has(t)).sort(), [], "a memory event log is missing from MEMORY_CREATION_TABLES");
    for (const t of appended) {
      assert.equal(sqlCrossesBoundary(`INSERT INTO public.${t} (x) SELECT body FROM public.messages;`), true, `${t}: the SQL check does not fire`);
    }
  });
});


/* ══════════════════════════════════════════════════════════════════════════
 * HARDENING (lane T, mission 4, 2026-10-07). census-telegraph §45c moved T366
 * back to W as "a tripwire with stated holes": a dynamic `.rpc(fn)` (the memory
 * kernel's own call), a table name held in a constant, the mobile app unscanned
 * — and the header's own "two levels of indirection". Each hole is shown closed
 * on a synthetic source FIRST, then the trees are judged with the closed holes.
 * ════════════════════════════════════════════════════════════════════════ */

interface Imp { target: string | null; names: string[]; defaultName: string | null; namespace: string | null }

/** Imports with the DEFAULT and NAMESPACE bindings kept apart from the named ones. */
function importsIn(code: string, resolveSpec: (spec: string) => string | null): Imp[] {
  const out: Imp[] = [];
  for (const m of code.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = m[1]!.trim();
    const names: string[] = [];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const t = part.trim().replace(/^type\s+/, "");
        if (!t) continue;
        const as = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(t);
        // The EXPORTED name is what the target file's fixpoint knows; the local alias is what this file mentions.
        names.push(as ? `${as[1]}=>${as[2]}` : t);
      }
    }
    const def = /^([A-Za-z0-9_$]+)/.exec(clause);
    const ns = /\*\s+as\s+([A-Za-z0-9_$]+)/.exec(clause);
    out.push({ target: resolveSpec(m[2]!), names, defaultName: def && !clause.startsWith("{") && !clause.startsWith("*") ? def[1]! : null, namespace: ns ? ns[1]! : null });
  }
  return out;
}

interface Analysis {
  readonly files: string[];
  readonly units: Map<string, CodeUnit[]>;
  readonly code: Map<string, string>;
  readonly readers: Map<string, Set<string>>;
  readonly creators: Map<string, Set<string>>;
  /** Local names in `file` (its own and imported) that reach a read / a creation. */
  namesFor(file: string): { readers: Set<string>; creators: Set<string> };
  crossings(file: string): ReturnType<typeof crossingsTransitive>;
}

function analyse(
  sources: Map<string, string>,
  resolveFrom: (from: string, spec: string) => string | null,
  reads: (file: string, unit: string) => string[],
  creates: (file: string, unit: string) => string[],
): Analysis {
  const files = [...sources.keys()];
  const units = new Map(files.map((f) => [f, codeUnits(sources.get(f)!)]));
  const imports = new Map(files.map((f) => [f, importsIn(sources.get(f)!, (spec) => resolveFrom(f, spec))]));
  // The fixpoint sees exported names; aliases are applied below.
  const importsOf = (f: string) => imports.get(f)!.map((i) => ({ ...i, names: i.names.map((n) => n.split("=>")[0]!) }));
  const readers = reachingNames(units, importsOf, (f, u) => reads(f, u).length > 0);
  const creators = reachingNames(units, importsOf, (f, u) => creates(f, u).length > 0);
  // Aliased imports: credit the LOCAL alias in the importing file and re-run until stable.
  const namesFor = (f: string) => {
    const r = new Set(readers.get(f)!);
    const c = new Set(creators.get(f)!);
    for (const imp of imports.get(f)!) {
      if (!imp.target) continue;
      const tr = readers.get(imp.target);
      const tc = creators.get(imp.target);
      for (const n of imp.names) {
        const [exported, local] = n.includes("=>") ? n.split("=>") as [string, string] : [n, n];
        if (tr?.has(exported)) r.add(local);
        if (tc?.has(exported)) c.add(local);
      }
      if (imp.defaultName) { if (tr?.has("default")) r.add(imp.defaultName); if (tc?.has("default")) c.add(imp.defaultName); }
      if (imp.namespace) { if (tr && tr.size > 0) r.add(imp.namespace); if (tc && tc.size > 0) c.add(imp.namespace); }
    }
    return { readers: r, creators: c };
  };
  return {
    files, units, code: sources, readers, creators, namesFor,
    crossings: (f) => {
      const n = namesFor(f);
      return crossingsTransitive(units.get(f)!, (u) => reads(f, u), (u) => creates(f, u), n.readers, n.creators);
    },
  };
}

// The server analysis: reads and creations through constants; an unresolvable RPC is a creation.
const serverConsts = new Map(files.map((f) => [f, stringConstsIn(codeOf.get(f)!)]));
const serverReads = (f: string, u: string) =>
  conversationReadsResolved(u, serverConsts.get(f) ?? stringConstsIn(u)).filter((x) => !x.startsWith("?"));
const serverCreates = (f: string, u: string) =>
  memoryCreationsResolved(u, serverConsts.get(f) ?? stringConstsIn(u), codeOf.get(f) ?? u).filter((x) => !x.startsWith("?") || x.startsWith("rpc:?"));

function serverAnalysis(extra: Map<string, string> = new Map()): Analysis {
  const sources = new Map<string, string>([...codeOf, ...extra]);
  for (const [f, c] of extra) serverConsts.set(f, stringConstsIn(c));
  return analyse(sources, (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(from), spec).replace(/\.js$/, "");
    for (const cand of [`${base}.ts`, join(base, "index.ts")]) if (sources.has(cand)) return cand;
    return null;
  }, serverReads, serverCreates);
}

const server = serverAnalysis();
const reviewed = new Map(REVIEWED_CALL_TREE_NON_FLOWS.map((r) => [join(PKG, r.file), r]));

describe("T366 hardening — each hole §45c named, shown closed on a synthetic source", () => {
  it("hole 1: `sc.rpc(fn)` with fn a constant expression is the memory kernel — a creation", () => {
    const src = [
      'const MEMORY_KERNEL_FN = "memory_kernel_execute";',
      'const HIGHLIGHT_KERNEL_FN = "highlight_kernel_execute";',
      "export async function executeMemoryCommand(sc, cmd, highlight) {",
      "  const fn = highlight ? HIGHLIGHT_KERNEL_FN : MEMORY_KERNEL_FN;",
      "  return sc.rpc(fn, { p_command: cmd });",
      "}",
    ].join("\n");
    assert.deepEqual(memoryCreationsIn(src), [], "the OLD detector misses it — the hole as §45c measured it");
    assert.deepEqual(memoryCreationsResolved(src, stringConstsIn(src)), ["rpc:memory_kernel_execute"]);
  });

  it("hole 1, cont.: an RPC wrapper's name comes from its same-file call sites; an unresolvable one fails closed", () => {
    const wrapped = [
      "async function callRpc(sc, fn, args) { return sc.rpc(fn, args); }",
      'export async function grant(sc) { return callRpc(sc, "intel_consent_grant", {}); }',
    ].join("\n");
    assert.deepEqual(memoryCreationsResolved(wrapped, stringConstsIn(wrapped)), [], "a wrapper whose every caller names a non-memory RPC is not a creation");
    const viaKernel = wrapped + '\nexport async function sneak(sc) { return callRpc(sc, "memory_kernel_execute", {}); }';
    assert.deepEqual(memoryCreationsResolved(viaKernel, stringConstsIn(viaKernel)), ["rpc:memory_kernel_execute"]);
    const opaque = 'export async function anyRpc(sc, fn) { return sc.rpc(fn, {}); }';
    assert.deepEqual(memoryCreationsResolved(opaque, stringConstsIn(opaque)), ["rpc:?fn"], "an exported wrapper cannot be resolved and must count");
  });

  it("hole 2: `const HISTORY = \"messages\"; sc.from(HISTORY)` is a conversation read", () => {
    const src = [
      'const HISTORY = "messages";',
      'router.post("/x", async (req, res) => {',
      "  const { data } = await sc.from(HISTORY).select(\"body\");",
      '  await sc.from("memories").insert({ caption: data[0].body });',
      "});",
    ].join("\n");
    assert.deepEqual(crossingsInFile(stripComments(src), new Set()), [], "the OLD detector misses it — the hole as §45c measured it");
    const a = analyse(new Map([["/syn/h2.ts", src]]), () => null,
      (f, u) => conversationReadsResolved(u, stringConstsIn(src)).filter((x) => !x.startsWith("?")),
      (f, u) => memoryCreationsResolved(u, stringConstsIn(src), src));
    assert.equal(a.crossings("/syn/h2.ts").length, 1);
  });

  it("a WRITE into a thread is not a read of what people said", () => {
    assert.deepEqual(conversationReadsResolved('await sc.from("messages").insert({ body: card });', new Map()), []);
    assert.deepEqual(conversationReadsResolved('await sc.from("messages").select("id").eq("thread_id", t);', new Map()), ["messages"]);
  });

  it("hole 4: a read and a creation three files apart are followed (route → helper → kernel)", () => {
    const route = [
      'import { remember } from "./helper.js";',
      'router.post("/r", async (req, res) => {',
      '  const { data } = await sc.from("message_translations").select("translated_body");',
      "  await remember(sc, data);",
      "});",
    ].join("\n");
    const helper = 'import { executeMemoryCommand } from "./kernel.js";\nexport async function remember(sc, d) { return executeMemoryCommand(sc, d, false); }';
    const kernel = 'const K = "memory_kernel_execute";\nexport async function executeMemoryCommand(sc, c, h) { const fn = h ? "x" : K; return sc.rpc(fn, c); }';
    const sources = new Map([["/syn/route.ts", route], ["/syn/helper.ts", helper], ["/syn/kernel.ts", kernel]]);
    const resolveSyn = (_from: string, spec: string) => (spec === "./helper.js" ? "/syn/helper.ts" : spec === "./kernel.js" ? "/syn/kernel.ts" : null);
    const R = (f: string, u: string) => conversationReadsResolved(u, stringConstsIn(sources.get(f)!)).filter((x) => !x.startsWith("?"));
    const C = (f: string, u: string) => memoryCreationsResolved(u, stringConstsIn(sources.get(f)!), sources.get(f)!).filter((x) => !x.startsWith("?") || x.startsWith("rpc:?"));
    const c = analyse(sources, resolveSyn, R, C).crossings("/syn/route.ts");
    assert.equal(c.length, 1, "two levels of indirection are not followed");
    assert.deepEqual(c[0]!.creates, ["call:remember"]);
    // CONTROL: cut the helper's call and nothing crosses.
    const cut = new Map(sources).set("/syn/helper.ts", "export async function remember(sc, d) { return d; }");
    assert.equal(analyse(cut, resolveSyn, R, C).crossings("/syn/route.ts").length, 0);
  });

  it("the verifier's own counterexample, on the REAL tree: a handler that reads `messages` and calls executeMemoryCommand is caught", () => {
    const synthetic = join(SRC, "routes/__t366_synthetic.ts");
    const src = [
      'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
      'router.post("/auto-memory", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body").eq("thread_id", req.params.id);',
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    const c = serverAnalysis(new Map([[synthetic, stripComments(src)]])).crossings(synthetic);
    assert.equal(c.length, 1, "executeMemoryCommand is not seen as a memory creation");
    assert.ok(c[0]!.creates.includes("call:executeMemoryCommand"));
  });
});

describe("T366 hardening — the server tree, followed to any depth", () => {
  it("the analysis is not vacuous: the kernel's bus is a creator, and creators and readers are many files apart", () => {
    assert.ok(server.creators.get(join(SRC, "lib/memoryCommandBus.ts"))!.has("executeMemoryCommand"), "the memory kernel's bus is not seen as a creator");
    assert.ok([...server.readers.values()].filter((s) => s.size > 0).length >= 20);
    assert.ok([...server.creators.values()].filter((s) => s.size > 0).length >= 5);
  });

  it("no unit outside the closed lists reads conversation history and reaches a memory creation, at any depth", () => {
    const violations: string[] = [];
    for (const f of server.files) {
      if (allowed.has(f)) continue;
      for (const c of server.crossings(f)) {
        const r = reviewed.get(f);
        if (r && c.unit.startsWith(r.unit)) continue;
        violations.push(`${relative(PKG, f)} :: ${c.unit} — reads ${c.reads.join(",")} → creates ${c.creates.join(",")}`);
      }
    }
    assert.deepEqual(violations, [], "§29: a conversation→Memory path, possibly through several calls. Make it an EXPLICIT per-item action " +
      "(EXPLICIT_CONVERSATION_MEMORY_PATHS), or — if the two branches never carry content into each other — review it into " +
      "REVIEWED_CALL_TREE_NON_FLOWS with the argument and its pin.");
  });

  it("every reviewed non-flow still crosses (or must be removed), and its argument is pinned", () => {
    for (const r of REVIEWED_CALL_TREE_NON_FLOWS) {
      const abs = join(PKG, r.file);
      assert.ok(server.crossings(abs).some((c) => c.unit.startsWith(r.unit)), `${r.file} ${r.unit} no longer crosses — remove the entry`);
      assert.ok(existsSync(join(PKG, r.pinnedBy)));
    }
    // The pin for /compass/ask: compression reads the Compass conversation and keeps USER turns only.
    const svc = stripComments(readFileSync(join(SRC, "compass/CompassMemoryService.ts"), "utf8"));
    const unit = codeUnits(svc).find((u) => u.declares.includes("compressConversationIfDue"))!.code;
    assert.match(unit, /\.from\("compass_conversation_messages"\)/);
    assert.match(unit, /\.filter\(\(m: any\) => m\.role === "user"\)/, "compression no longer keeps user turns only — a tool result could reach compass_memories");
    assert.deepEqual(conversationReadsResolved(unit, new Map()), [], "compression reads a Telegraph table directly");
  });
});

/* ── §45c hole 3: the mobile app ─────────────────────────────────────────── */

const CLIENT = resolve(PKG, "../../travel-buddy-standalone");

function clientWalk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      clientWalk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** The server's own endpoints, classified by the server analysis: a GET that reads history, a write that creates a memory. */
function serverEndpoints(): { reads: Set<string>; creates: Set<string> } {
  const reads = new Set<string>();
  const creates = new Set<string>();
  for (const f of server.files) {
    const n = server.namesFor(f);
    for (const u of server.units.get(f)!) {
      const m = /^router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/.exec(u.code);
      if (!m) continue;
      const path = m[2]!.replace(/:[A-Za-z0-9_]+/g, "X").replace(/\*[A-Za-z0-9_]*/g, "X");
      const mentionsAny = (names: Set<string>) => [...names].some((x) => new RegExp(`(^|[^A-Za-z0-9_$.])${x.replace(/\$/g, "\\$")}\\s*[(.]`).test(u.code));
      if (m[1] === "get" && (serverReads(f, u.code).length > 0 || mentionsAny(n.readers))) reads.add(path);
      if (m[1] !== "get" && (serverCreates(f, u.code).length > 0 || mentionsAny(n.creators))) creates.add(path);
    }
  }
  return { reads, creates };
}

const endpoints = serverEndpoints();
/** `/${id}` is a path segment; any other interpolation (`${qs}`) is a suffix and is dropped. */
const normTpl = (s: string) => s.replace(/\/\$\{[^}]*\}/g, "/X").replace(/\$\{[^}]*\}/g, "");
function apiCalls(unit: string): Array<{ path: string; method: string }> {
  const code = normTpl(unit);
  const out: Array<{ path: string; method: string }> = [];
  for (const m of code.matchAll(/(["'`])[^"'`\n]*?\/api(\/[^"'`\s]*)\1/g)) {
    const path = m[2]!.replace(/\?.*$/, "").replace(/\/$/, "");
    const at = m.index ?? 0;
    const helper = /\b(?:api|http|fetch|call|request)?(post|put|patch|delete)[A-Za-z]*\s*(?:<[^>]*>)?\s*\(\s*$/i.exec(code.slice(Math.max(0, at - 60), at))?.[1];
    const method = helper?.toUpperCase() ?? /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)/.exec(code.slice(at, at + 300))?.[1] ?? "GET";
    out.push({ path, method });
  }
  return out;
}
const clientReads = (_f: string, u: string): string[] => [
  ...apiCalls(u).filter((c) => c.method === "GET" && endpoints.reads.has(c.path)).map((c) => `GET ${c.path}`),
  ...conversationReadsResolved(u, stringConstsIn(u)).filter((x) => !x.startsWith("?")),
];
const clientCreates = (_f: string, u: string): string[] => [
  ...apiCalls(u).filter((c) => c.method !== "GET" && endpoints.creates.has(c.path)).map((c) => `${c.method} ${c.path}`),
  ...memoryCreationsResolved(u, stringConstsIn(u)).filter((x) => !x.startsWith("?")),
];
function clientAnalysis(extra: Map<string, string> = new Map()): Analysis {
  const sources = new Map<string, string>([
    ...[...clientWalk(join(CLIENT, "src")), ...clientWalk(join(CLIENT, "app"))].map((f) => [f, stripComments(readFileSync(f, "utf8"))] as [string, string]),
    ...extra,
  ]);
  return analyse(sources, (from, spec) => {
    let base: string | null = null;
    if (spec.startsWith(".")) base = resolve(dirname(from), spec);
    else if (spec.startsWith("@/")) base = join(CLIENT, spec.slice(2));
    else if (spec.startsWith("src/")) base = join(CLIENT, spec);
    if (!base) return null;
    base = base.replace(/\.(js|ts|tsx)$/, "");
    for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (sources.has(cand)) return cand;
    return null;
  }, clientReads, clientCreates);
}

describe("T366 — the mobile app (§45c: 'the mobile app is not scanned at all')", () => {
  const client = clientAnalysis();

  it("the endpoint vocabularies come from the server analysis, and are not vacuous", () => {
    for (const p of ["/threads/X/messages", "/me/saved-messages", "/telegraph/search"]) assert.ok(endpoints.reads.has(p), `${p} is not seen as a history read`);
    for (const p of ["/memories", "/me/memory-drafts", "/compass/me/memories/teach"]) assert.ok(endpoints.creates.has(p), `${p} is not seen as a memory creation`);
  });

  it("the client analysis sees the app's history readers and memory creators", () => {
    const creatorOf = (rel: string, name: string) => client.creators.get(join(CLIENT, rel))?.has(name) === true;
    assert.ok(creatorOf("src/services/memories.ts", "createMemory"));
    assert.ok(creatorOf("src/features/telegraph/memory/memoryApi.ts", "saveMessageAsMemoryDraft"));
    assert.ok(client.readers.get(join(CLIENT, "src/services/messaging.ts"))?.has("getThreadMessages"), "the thread read is not seen");
    assert.ok([...client.readers.values()].filter((s) => s.size > 0).length >= 10);
  });

  it("no unit in the app reads conversation history and reaches a memory creation, at any depth", () => {
    const violations: string[] = [];
    for (const f of client.files) {
      for (const c of client.crossings(f)) violations.push(`${relative(CLIENT, f)} :: ${c.unit} — reads ${c.reads.join(",")} → creates ${c.creates.join(",")}`);
    }
    assert.deepEqual(violations, [], "§29 on the client: Save-to-Memory is ONE long-pressed message (saveMessageAsMemoryDraft); nothing else may carry conversation content into a memory.");
  });

  it("a synthetic screen that loads a thread and creates a memory from it is caught (the scan can fire)", () => {
    const synthetic = join(CLIENT, "app/__t366_synthetic.tsx");
    const src = [
      "import { getThreadMessages } from '../src/services/messaging.ts';",
      "import { createMemory } from '../src/services/memories.ts';",
      "export default function AutoRecap({ threadId }) {",
      "  useEffect(() => { void getThreadMessages(threadId).then((r) => createMemory({ caption: r.data.messages.map((m) => m.body).join(' ') })); }, []);",
      "  return null;",
      "}",
    ].join("\n");
    const c = clientAnalysis(new Map([[synthetic, src]])).crossings(synthetic);
    assert.equal(c.length, 1);
    assert.ok(c[0]!.reads.includes("call:getThreadMessages") && c[0]!.creates.includes("call:createMemory"), JSON.stringify(c));
  });
});
