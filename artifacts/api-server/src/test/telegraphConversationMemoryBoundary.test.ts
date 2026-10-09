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
  importedNames,
  memoryCreationsIn,
  memoryCreationsResolved,
  reachingNamesThrough,
  crossingsThrough,
  moduleLinks,
  withoutModuleStatements,
  tableParameterUses,
  callArguments,
  historyTriggerFunctions,
  sqlFunctionBodies,
  sqlInsertsMemory,
  sqlCrossesBoundary,
  stringConstsIn,
  stripComments, objectConstsIn, importedConsts, jsxReferences, references, REVIEWED_CLIENT_JSX_NON_FLOWS, jsxPassesData, dynamicImportLocal, fromSites, // §64
  REVIEWED_OPAQUE_READ_HELPERS, REVIEWED_CLIENT_SHARED_STORES, CLIENT_SHARED_STORE_RE, // §66
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

interface Analysis {
  readonly files: string[];
  readonly units: Map<string, CodeUnit[]>;
  readonly code: Map<string, string>;
  readonly readers: Map<string, Set<string>>;
  readonly creators: Map<string, Set<string>>;
  /** §66: each file's resolved imports. */
  readonly linksOf: (file: string) => ReturnType<typeof moduleLinks>;
  /** §66: the comment-stripped source WITH its module statements. */
  sourceOf(file: string): string;
  /** §66: the unit reads conversation history, directly or through a reader name. */
  isReaderUnit(file: string, unit: CodeUnit): boolean;
  /** Local names in `file` (its own and imported, aliases and namespaces applied) that reach a read / a creation. */
  namesFor(file: string): { readers: Set<string>; creators: Set<string>; opaque: Set<string> };
  crossings(file: string): ReturnType<typeof crossingsThrough>;
}

type Seed = (file: string, unitCode: string, consts: ReadonlyMap<string, string>, fileCode: string) => string[];

/**
 * The analysis, round 2 (verification F3): static AND dynamic imports with
 * aliases, namespaces, re-exports and `export *` (moduleLinks); a value counts
 * as a reference, not only a call (references); a table named by a parameter is
 * resolved at every call site, for reads and for writes (tableParameterUses);
 * an unresolvable `.from(expr)` counts as a possible read IN ITS OWN UNIT
 * (`unknownReads`) — it is not a fixpoint seed, or every generic helper would
 * become a reader of everything.
 */
function analyse(
  sources: Map<string, string>,
  resolveFrom: (from: string, spec: string) => string | null,
  seedReads: Seed,
  seedCreates: Seed,
  unknownReads: Seed = () => [],
  jsx = false,
  opaqueReads: Seed | null = null,
): Analysis {
  const files = [...sources.keys()];
  const code = new Map(files.map((f) => [f, withoutModuleStatements(sources.get(f)!)]));
  const consts = new Map(files.map((f) => [f, stringConstsIn(code.get(f)!)]));
  const units = new Map(files.map((f) => [f, codeUnits(code.get(f)!)]));
  const links = new Map(files.map((f) => [f, moduleLinks(sources.get(f)!, (spec) => resolveFrom(f, spec))]));
  // §64 (b): object-literal constants (`TABLES.history`) and constants an import brings in, under their local names.
  for (const f of files) for (const [k, v] of objectConstsIn(code.get(f)!)) consts.get(f)!.set(k, v);
  for (let round = 0; round < 3; round++) {
    for (const f of files) for (const [k, v] of importedConsts(links.get(f)!.imports, (t) => consts.get(t))) if (!consts.get(f)!.has(k)) consts.get(f)!.set(k, v);
  }
  const params = new Map(files.map((f) => [f, tableParameterUses(units.get(f)!)]));
  const unitOf = new Map(files.map((f) => [f, new Map(units.get(f)!.map((u) => [u.code, u]))]));
  // A function that passes one of ITS parameters on, in the table position, to a
  // table-parameter function is one too — followed to a fixpoint, across imports.
  for (let round = 0, grew = true; grew && round < 8; round++) {
    grew = false;
    for (const f of files) {
      const visible = new Map(params.get(f)!);
      for (const imp of links.get(f)!.imports) {
        const theirs = imp.target ? params.get(imp.target) : undefined;
        if (theirs) for (const b of imp.bindings) { const use = theirs.get(b.exported); if (use) visible.set(b.local, use); }
      }
      for (const u of units.get(f)!) {
        const head = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/.exec(u.code.trim())
          ?? /^(?:export\s+)?(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(([^)]*)\)\s*(?::[^=]*)?=>/.exec(u.code.trim());
        if (!head || params.get(f)!.has(head[1]!)) continue;
        const ps = head[2]!.split(",").map((x) => x.trim().replace(/[:=?][\s\S]*$/, "").trim());
        for (const [local, use] of visible) {
          if (local === head[1]) continue;
          for (const args of callArguments(u.code, local)) {
            const i = ps.indexOf((args[use.index] ?? "").trim());
            if (i >= 0) { params.get(f)!.set(head[1]!, { index: i, reads: use.reads, writes: use.writes }); grew = true; break; }
          }
          if (params.get(f)!.has(head[1]!)) break;
        }
      }
    }
  }
  const history = new Set<string>(CONVERSATION_HISTORY_TABLES);
  const memory = new Set<string>(MEMORY_CREATION_TABLES);

  const visibleParams = new Map<string, Map<string, { index: number; reads: boolean; writes: boolean }>>();
  const paramFnsIn = (f: string) => {
    let m = visibleParams.get(f);
    if (m) return m;
    m = new Map(params.get(f)!);
    for (const imp of links.get(f)!.imports) {
      const theirs = imp.target ? params.get(imp.target) : undefined;
      if (!theirs) continue;
      for (const b of imp.bindings) { const use = theirs.get(b.exported); if (use) m.set(b.local, use); }
    }
    visibleParams.set(f, m);
    return m;
  };
  const resolveArg = (f: string, a: string | undefined): string | null => {
    if (a === undefined) return null;
    const lit = /^(["'`])([A-Za-z0-9_]+)\1$/.exec(a.trim());
    return lit ? lit[2]! : (consts.get(f)!.get(a.trim()) ?? null);
  };
  const ownParams = (f: string, u: CodeUnit): Set<string> => {
    const out = new Set<string>();
    for (const d of u.declares) {
      const use = params.get(f)!.get(d);
      const head = use ? /\(([^)]*)\)/.exec(u.code) : null;
      if (use && head) out.add(head[1]!.split(",").map((x) => x.trim().replace(/[:=?][\s\S]*$/, "").trim())[use.index]!);
    }
    return out;
  };
  const argUses = (f: string, u: CodeUnit, want: "reads" | "writes", tables: Set<string>) => {
    const known: string[] = [];
    const unknown: string[] = [];
    for (const [local, use] of paramFnsIn(f)) {
      if (!use[want] || u.declares.includes(local)) continue;
      for (const args of callArguments(u.code, local)) {
        const t = resolveArg(f, args[use.index]);
        if (t === null) unknown.push(`?arg:${local}`);
        else if (tables.has(t)) known.push(`arg:${local}:${t}`);
      }
    }
    return { known, unknown };
  };
  const knownReads = (f: string, u: CodeUnit) => [...seedReads(f, u.code, consts.get(f)!, code.get(f)!), ...argUses(f, u, "reads", history).known];
  const allReads = (f: string, u: CodeUnit) => {
    const own = ownParams(f, u);
    return [
      ...knownReads(f, u),
      ...unknownReads(f, u.code, consts.get(f)!, code.get(f)!).filter((x) => !own.has(x.replace(/^\?/, ""))),
      ...argUses(f, u, "reads", history).unknown,
    ];
  };
  const creates = (f: string, u: CodeUnit) => [...seedCreates(f, u.code, consts.get(f)!, code.get(f)!), ...argUses(f, u, "writes", memory).known];

  const readers = reachingNamesThrough(units, (f) => links.get(f)!, (f, c) => knownReads(f, unitOf.get(f)!.get(c)!).length > 0);
  // §66: an unresolvable `.from(expr)` that is not the unit's own table parameter
  // (that one is resolved at the call sites) SEEDS a second fixpoint — the
  // "opaque readers" — so a caller of such a helper counts as a POSSIBLE history
  // reader. Reviewed generic helpers (REVIEWED_OPAQUE_READ_HELPERS) do not seed.
  const opaqueSeeded = (f: string, u: CodeUnit) => {
    if (!opaqueReads) return false;
    const own = ownParams(f, u);
    return opaqueReads(f, u.code, consts.get(f)!, code.get(f)!).some((x) => !own.has(x.replace(/^\?/, "")));
  };
  const opaque = opaqueReads ? reachingNamesThrough(units, (f) => links.get(f)!, (f, c) => opaqueSeeded(f, unitOf.get(f)!.get(c)!)) : null;
  const creators = reachingNamesThrough(units, (f) => links.get(f)!, (f, c) => creates(f, unitOf.get(f)!.get(c)!).length > 0, jsx ? jsxReferences : references);
  const namesFor = (f: string) => {
    const pick = (reach: Map<string, Set<string>>) => {
      const s = new Set(reach.get(f)!);
      for (const imp of links.get(f)!.imports) {
        const theirs = imp.target ? reach.get(imp.target) : undefined;
        if (!theirs || theirs.size === 0) continue;
        for (const b of imp.bindings) if (theirs.has(b.exported)) s.add(b.local);
        if (imp.namespace) s.add(imp.namespace);
      }
      return s;
    };
    return { readers: pick(readers), creators: pick(creators), opaque: opaque ? pick(opaque) : new Set<string>() };
  };
  return {
    files, units, code, readers, creators, namesFor,
    linksOf: (f) => links.get(f)!,
    sourceOf: (f) => sources.get(f)!,
    isReaderUnit: (f, u) => allReads(f, u).length > 0 || [...namesFor(f).readers].some((x) => !u.declares.includes(x) && references(u.code, x)),
    crossings: (f) => {
      const n = namesFor(f);
      const opaqueCalls = (u: CodeUnit) => [...n.opaque].filter((x) => !u.declares.includes(x) && references(u.code, x)).map((x) => `?call:${x}`);
      return crossingsThrough(units.get(f)!, (c) => { const u = unitOf.get(f)!.get(c)!; return [...allReads(f, u), ...opaqueCalls(u)]; }, (c) => creates(f, unitOf.get(f)!.get(c)!), n.readers, n.creators, jsx ? jsxReferences : references);
    },
  };
}

// The server analysis. Known reads: history tables by literal or constant. Unknown
// reads (direct, own unit): an unresolvable `.from(expr)`. Creations: memory tables
// by literal or constant, and an unresolvable RPC (fail closed).
const serverReads: Seed = (_f, u, consts) => conversationReadsResolved(u, consts).filter((x) => !x.startsWith("?"));
const serverUnknownReads: Seed = (_f, u, consts) => conversationReadsResolved(u, consts).filter((x) => x.startsWith("?"));
const serverCreates: Seed = (_f, u, consts, fileCode) =>
  memoryCreationsResolved(u, consts, fileCode).filter((x) => !x.startsWith("?") || x.startsWith("rpc:?"));

// §66: the opaque-reader seed — an unresolvable DATABASE `.from(expr)` (a storage
// bucket, `.storage.from(…)`, is not a table), outside the reviewed generic helpers.
const opaqueReadsExcept = (reviewedList: readonly { file: string; unit: string }[]): Seed => {
  const reviewedAbs = reviewedList.map((r) => ({ abs: join(PKG, r.file), unit: r.unit }));
  return (f, u, consts) => {
    if (reviewedAbs.some((r) => r.abs === f && u.trim().startsWith(r.unit))) return [];
    return conversationReadsResolved(u.replace(/\.storage\s*\??\.\s*from\(/g, ".storage.bucket("), consts).filter((x) => x.startsWith("?"));
  };
};
const serverOpaqueReads = opaqueReadsExcept(REVIEWED_OPAQUE_READ_HELPERS);

function serverAnalysis(extra: Map<string, string> = new Map(), opaqueSeed: Seed = serverOpaqueReads): Analysis {
  const sources = new Map<string, string>([...codeOf, ...extra]);
  return analyse(sources, (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(from), spec).replace(/\.js$/, "");
    for (const cand of [`${base}.ts`, join(base, "index.ts")]) if (sources.has(cand)) return cand;
    return null;
  }, serverReads, serverCreates, serverUnknownReads, false, opaqueSeed);
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

describe("T366 hardening, round 2 — the verifier's five survivors (verification of 54ddc1de4, F3), each caught on the REAL tree", () => {
  const route = (name: string) => join(SRC, `routes/__t366_probe_${name}.ts`);
  const caught = (name: string, src: string, extra: Array<[string, string]> = []) => {
    const file = route(name);
    const a = serverAnalysis(new Map<string, string>([[file, stripComments(src)], ...extra.map(([f, c]) => [f, stripComments(c)] as [string, string])]));
    return a.crossings(file);
  };

  it("A: a helper that reads a table named by its PARAMETER, called with \"messages\" — the call site is the read", () => {
    const src = [
      'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
      "async function readHistory(sc, table) { return sc.from(table).select(\"body\"); }",
      'router.post("/a", async (req, res) => {',
      '  const { data } = await readHistory(sc, "messages");',
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    const c = caught("a", src);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.ok(c[0]!.reads.includes("arg:readHistory:messages"), JSON.stringify(c));
  });

  it("A, two levels: a helper that passes its table parameter on to another is followed too", () => {
    const src = [
      'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
      "async function readRows(sc, table) { return sc.from(table).select(\"body\"); }",
      "async function readThread(sc, which) { return readRows(sc, which); }",
      'router.post("/a1", async (req, res) => {',
      '  const { data } = await readThread(sc, "message_translations");',
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    const c = caught("a1", src);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.ok(c[0]!.reads.includes("arg:readThread:message_translations"), JSON.stringify(c));
  });

  it("A, unresolvable: the same helper called with a table the file cannot name counts as a POSSIBLE read in that unit", () => {
    const src = [
      'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
      "async function readAny(sc, table) { return sc.from(table).select(\"*\"); }",
      'router.post("/a2", async (req, res) => {',
      "  const { data } = await readAny(sc, req.body.table);",
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    assert.equal(caught("a2", src).length, 1);
  });

  it("A, direct: an unresolvable `.from(expr)` in the unit that creates a memory counts (the policy's own words)", () => {
    const src = [
      'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
      'router.post("/a3", async (req, res) => {',
      "  const { data } = await sc.from(req.query.t).select(\"*\");",
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    assert.equal(caught("a3", src).length, 1);
  });

  it("B: a DYNAMIC import of the memory kernel, after a history read", () => {
    const src = [
      'router.post("/b", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body");',
      '  const { executeMemoryCommand } = await import("../lib/memoryCommandBus.js");',
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    assert.equal(caught("b", src).length, 1);
  });

  it("C: the kernel reached through a BARREL re-export", () => {
    const barrel = join(SRC, "lib/__t366_barrel.ts");
    const src = [
      'import { executeMemoryCommand } from "../lib/__t366_barrel.js";',
      'router.post("/c", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body");',
      '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    assert.equal(caught("c", src, [[barrel, 'export { executeMemoryCommand } from "./memoryCommandBus.js";']]).length, 1);
    const star = join(SRC, "lib/__t366_star.ts");
    const src2 = src.replace("__t366_barrel", "__t366_star");
    assert.equal(caught("c2", src2, [[star, 'export * from "./memoryCommandBus.js";']]).length, 1, "export * is followed too");
  });

  it("D: the kernel used as a VALUE (`const run = executeMemoryCommand; await run(…)`)", () => {
    const src = [
      'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
      'router.post("/d", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body");',
      "  const run = executeMemoryCommand;",
      '  await run(sc, { commandType: "CREATE_MEMORY", payload: data });',
      "});",
    ].join("\n");
    assert.equal(caught("d", src).length, 1);
  });

  it("E: a TRIGGER on a history table whose function inserts a memory row from NEW.* — no FROM messages anywhere", () => {
    const sql = [
      "CREATE OR REPLACE FUNCTION public.remember_message() RETURNS trigger LANGUAGE plpgsql AS $fn$",
      "BEGIN INSERT INTO public.memory_items (user_id, caption) VALUES (NEW.sender_id, NEW.body); RETURN NEW; END $fn$;",
      "CREATE TRIGGER remember AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.remember_message();",
    ].join("\n");
    assert.equal(sqlCrossesBoundary(sql), false, "the file-level check misses it — the hole as F3 measured it");
    const fns = historyTriggerFunctions(sql);
    assert.deepEqual(fns, ["remember_message"]);
    assert.equal(sqlInsertsMemory(sqlFunctionBodies(sql).get("remember_message")!), true);
  });
});

describe("T366 — no trigger on a conversation-history table creates a memory row, in any migration", () => {
  it("every history trigger's function, wherever it is defined, inserts into no memory table", () => {
    const sqlFiles = [
      ...readdirSync(join(SRC, "migrations")).filter((n) => n.endsWith(".sql")).map((n) => join(SRC, "migrations", n)),
      join(PKG, "baseline/20260819_baseline_structure.sql"),
    ];
    const bodies = new Map<string, string>();
    for (const f of sqlFiles) for (const [name, body] of sqlFunctionBodies(readFileSync(f, "utf8"))) bodies.set(name, body);
    const triggers: string[] = [];
    const offending: string[] = [];
    for (const f of sqlFiles) {
      for (const fn of historyTriggerFunctions(readFileSync(f, "utf8"))) {
        triggers.push(fn);
        const body = bodies.get(fn);
        if (body === undefined) offending.push(`${relative(PKG, f)}: trigger function ${fn} has no body in any migration (cannot be checked)`);
        else if (sqlInsertsMemory(body)) offending.push(`${relative(PKG, f)}: trigger function ${fn} inserts a memory row`);
      }
    }
    assert.ok(triggers.length >= 2, `only ${triggers.length} history trigger(s) seen — the scan is not reading the triggers`);
    assert.deepEqual(offending, []);
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
    const fileCode = server.code.get(f)!;
    const consts = stringConstsIn(fileCode);
    for (const u of server.units.get(f)!) {
      const m = /^router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/.exec(u.code);
      if (!m) continue;
      const path = m[2]!.replace(/:[A-Za-z0-9_]+/g, "X").replace(/\*[A-Za-z0-9_]*/g, "X");
      const mentionsAny = (names: Set<string>) => [...names].some((x) => new RegExp(`(^|[^A-Za-z0-9_$.])${x.replace(/\$/g, "\\$")}\\s*[(.]`).test(u.code));
      if (m[1] === "get" && (serverReads(f, u.code, consts, fileCode).length > 0 || mentionsAny(n.readers))) reads.add(path);
      if (m[1] !== "get" && (serverCreates(f, u.code, consts, fileCode).length > 0 || mentionsAny(n.creators))) creates.add(path);
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
  }, clientReads, clientCreates, () => [], true);
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

  // CHANGED 2026-10-08 (lane T, §64; verification F2 on 3e2b9c1afd): the client analysis now counts a JSX element
  // that PASSES DATA to a memory-creating component as a reference (jsxReferences), so two reviewed units —
  // each argued and pinned below — are excepted by name; any other component they render, or any other unit, fails.
  const reviewedClient = new Map(REVIEWED_CLIENT_JSX_NON_FLOWS.map((r) => [`${r.file}::${r.unit}`, r]));
  const isReviewedClient = (f: string, c: { unit: string; creates: readonly string[] }) => {
    const r = [...reviewedClient.values()].find((x) => relative(CLIENT, f) === x.file && c.unit.startsWith(x.unit));
    return r !== undefined && c.creates.every((x) => r.components.some((k) => x === `call:${k}`));
  };
  it("no unit in the app reads conversation history and reaches a memory creation, at any depth", () => {
    const violations: string[] = [];
    for (const f of client.files) {
      for (const c of client.crossings(f)) if (!isReviewedClient(f, c)) violations.push(`${relative(CLIENT, f)} :: ${c.unit} — reads ${c.reads.join(",")} → creates ${c.creates.join(",")}`);
    }
    assert.deepEqual(violations, [], "§29 on the client: Save-to-Memory is ONE long-pressed message (saveMessageAsMemoryDraft); nothing else may carry conversation content into a memory.");
  });

  it("§64: the reviewed exceptions are narrow — another file, another unit or one more creation is NOT excepted", () => {
    const thread = join(CLIENT, "app/messages/[id].tsx");
    assert.equal(isReviewedClient(thread, { unit: "export default function TelegraphThread() {", creates: ["call:LongPressActionSheet"] }), true, "CONTROL");
    assert.equal(isReviewedClient(thread, { unit: "export default function TelegraphThread() {", creates: ["call:LongPressActionSheet", "call:createMemory"] }), false);
    assert.equal(isReviewedClient(thread, { unit: "function SomethingElse() {", creates: ["call:LongPressActionSheet"] }), false);
    assert.equal(isReviewedClient(join(CLIENT, "app/other.tsx"), { unit: "export default function TelegraphThread() {", creates: ["call:LongPressActionSheet"] }), false);
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

describe("T366 hardening, round 2 — the other two dynamic-import shapes", () => {
  const caughtIn = (name: string, src: string) => {
    const file = join(SRC, `routes/__t366_probe_${name}.ts`);
    return serverAnalysis(new Map<string, string>([[file, stripComments(src)]])).crossings(file);
  };
  const lines = (call: string[]) => [
    `router.post("/bx", async (req, res) => {`,
    '  const { data } = await sc.from("messages").select("body");',
    ...call,
    "});",
  ].join("\n");

  it("B2: a NAMESPACE dynamic import (`const bus = await import(…); await bus.executeMemoryCommand(…)`)", () => {
    const src = lines([
      '  const bus = await import("../lib/memoryCommandBus.js");',
      '  await bus.executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
    ]);
    assert.equal(caughtIn("b2", src).length, 1);
  });

  it("B3: an INLINE dynamic import (`(await import(…)).executeMemoryCommand(…)`)", () => {
    const src = lines([
      '  await (await import("../lib/memoryCommandBus.js")).executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data });',
    ]);
    assert.equal(caughtIn("b3", src).length, 1);
  });

  it("CONTROL: the same three shapes importing a module that creates nothing are not crossings", () => {
    for (const [n, call] of [
      ["c1", ['  const { logger } = await import("../lib/logger.js");', "  logger.info(data);"]],
      ["c2", ['  const log = await import("../lib/logger.js");', "  log.logger.info(data);"]],
      ["c3", ['  (await import("../lib/logger.js")).logger.info(data);']],
    ] as const) {
      assert.equal(caughtIn(n, lines([...call])).length, 0, n);
    }
  });
});

describe("T366 hardening, round 3 — the verifier's three shapes (verification of 3e2b9c1afd, F2), each caught", () => {
  const caughtIn = (name: string, files: Array<[string, string]>) => {
    const extra = new Map<string, string>(files.map(([rel, src]) => [join(SRC, rel), stripComments(src)]));
    const a = serverAnalysis(extra);
    return files.flatMap(([rel]) => a.crossings(join(SRC, rel)));
  };

  it("(a) a `.then` dynamic import of the memory kernel, after a history read, is a crossing", () => {
    const c = caughtIn("a", [["routes/__t366_r3_then.ts", [
      'router.post("/r3a", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body");',
      '  await import("../lib/memoryCommandBus.js").then((m) => m.executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: data }));',
      "});",
    ].join("\n")]]);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.ok(c[0]!.creates.includes(`call:${dynamicImportLocal("../lib/memoryCommandBus.js")}`));
  });

  it("(a) CONTROL: a `.then` dynamic import of a module that creates nothing is not", () => {
    assert.equal(caughtIn("a0", [["routes/__t366_r3_then0.ts", [
      'router.post("/r3a0", async (req, res) => {',
      '  const { data } = await sc.from("messages").select("body");',
      '  await import("../lib/logger.js").then((m) => m.logger.info(data));',
      "});",
    ].join("\n")]]).length, 0);
  });

  it("(b) a table name read off an exported OBJECT in another file, inside a helper, makes the helper a reader — the caller crosses", () => {
    const c = caughtIn("b", [
      ["lib/__t366_r3_tables.ts", 'export const TABLES = { history: "messages", other: "trips" } as const;'],
      ["routes/__t366_r3_obj.ts", [
        'async function readHistory(sc) { const { data } = await sc.from(TABLES.history).select("body"); return data; }',
        'router.post("/r3b", async (req, res) => {',
        "  const rows = await readHistory(sc);",
        '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: rows });',
        "});",
      ].join("\n").replace(/^/, 'import { TABLES } from "../lib/__t366_r3_tables.js";\nimport { executeMemoryCommand } from "../lib/memoryCommandBus.js";\n')],
    ]);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.ok(c[0]!.reads.includes("call:readHistory"), JSON.stringify(c));
  });

  it("(b) the same object read through a namespace import, and an imported plain constant, resolve too", () => {
    assert.equal(objectConstsIn('export const T = { h: "messages" };').get("T.h"), "messages");
    const imported = importedConsts(
      [{ target: "x", bindings: [{ exported: "TABLES", local: "TB" }, { exported: "HIST", local: "H" }] }, { target: "x", bindings: [], namespace: "ns" }],
      () => new Map([["TABLES.history", "messages"], ["HIST", "messages"]]),
    );
    assert.equal(imported.get("TB.history"), "messages");
    assert.equal(imported.get("H"), "messages");
    assert.equal(imported.get("ns.TABLES.history"), "messages");
  });

  it("(b) bracket access (`TABLES[\"history\"]`) resolves like a property; a template with an interpolation is an UNRESOLVED read", () => {
    const consts = new Map([["TABLES.history", "messages"]]);
    assert.deepEqual(fromSites('sc.from(TABLES["history"]).select("body")', consts).map((x) => x.table), ["messages"]);
    assert.deepEqual(fromSites("sc.from(`${prefix}messages`).select('body')", consts).map((x) => [x.table, x.expr]), [[null, "`${prefix}messages`"]]);
    assert.ok(conversationReadsResolved("sc.from(`${prefix}messages`).select('body')", consts)[0]!.startsWith("?"), "an unresolvable template is not dropped");
  });

  it("(b) CONTROL: the object's other key, a non-history table, is not a read", () => {
    assert.equal(caughtIn("b0", [
      ["lib/__t366_r3_tables0.ts", 'export const TABLES = { history: "messages", other: "trips" } as const;'],
      ["routes/__t366_r3_obj0.ts", [
        'import { TABLES } from "../lib/__t366_r3_tables0.js";',
        'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
        'async function readTrips(sc) { const { data } = await sc.from(TABLES.other).select("id"); return data; }',
        'router.post("/r3b0", async (req, res) => {',
        "  const rows = await readTrips(sc);",
        '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: rows });',
        "});",
      ].join("\n")],
    ]).length, 0);
  });

  it("(c) a screen that loads a thread and HANDS it to a component that creates a memory (`<AutoRecapCard messages={messages} />`) is caught", () => {
    const card = join(CLIENT, "src/components/__t366_AutoRecapCard.tsx");
    const screen = join(CLIENT, "app/__t366_jsx_screen.tsx");
    const a = clientAnalysis(new Map([
      [card, [
        "import { createMemory } from '../services/memories.ts';",
        "export function AutoRecapCard({ messages }) {",
        "  useEffect(() => { void createMemory({ caption: messages.map((m) => m.body).join(' ') }); }, [messages]);",
        "  return null;",
        "}",
      ].join("\n")],
      [screen, [
        "import { getThreadMessages } from '../src/services/messaging.ts';",
        "import { AutoRecapCard } from '../src/components/__t366_AutoRecapCard.tsx';",
        "export default function Screen({ threadId }) {",
        "  const [messages, setMessages] = useState([]);",
        "  useEffect(() => { void getThreadMessages(threadId).then((r) => setMessages(r.data.messages)); }, []);",
        "  return <AutoRecapCard messages={messages} />;",
        "}",
      ].join("\n")],
    ]));
    const c = a.crossings(screen);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.ok(c[0]!.creates.includes("call:AutoRecapCard"));
  });

  it("(c) CONTROL: rendering a component with literal-only attributes passes no data and is not a reference", () => {
    assert.equal(jsxPassesData('<AutoRecapCard title="Recap" />', "AutoRecapCard"), false);
    assert.equal(jsxPassesData("<AutoRecapCard messages={messages} />", "AutoRecapCard"), true);
    assert.equal(jsxPassesData("<AutoRecapCard {...props} />", "AutoRecapCard"), true);
    assert.equal(references("<AutoRecapCard messages={messages} />", "AutoRecapCard"), false, "references alone does not see JSX");
  });

  describe("(c) the two reviewed client units: each still crosses only through its named components, and its argument is pinned", () => {
    const client = clientAnalysis();
    for (const r of REVIEWED_CLIENT_JSX_NON_FLOWS) {
      it(`${r.file} :: ${r.unit}`, () => {
        const f = join(CLIENT, r.file);
        const c = client.crossings(f).filter((x) => x.unit.startsWith(r.unit));
        assert.equal(c.length, 1, `${r.file}: the reviewed unit no longer crosses — remove its entry`);
        for (const x of c[0]!.creates) assert.ok(r.components.some((k) => x === `call:${k}`), `${x} is not a reviewed component`);
      });
    }
    it("PIN — the thread screen's LongPressActionSheet creates ONE message's private draft, only on its own press", () => {
      const src = stripComments(readFileSync(join(CLIENT, "app/messages/[id].tsx"), "utf8"));
      const sheet = src.slice(src.indexOf("function LongPressActionSheet("), src.indexOf("export default function TelegraphThread("));
      const creations = [...sheet.matchAll(/\b(saveMessageAsMemoryDraft|createMemory|createMemoryDraft|executeMemoryCommand)\s*\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
      assert.deepEqual(creations, ["saveMessageAsMemoryDraft(message.id)"]);
      assert.match(sheet, /testID="telegraph-save-to-memory"[\s\S]{0,300}onPress=\{async \(\) => \{[\s\S]{0,200}saveMessageAsMemoryDraft\(message\.id\)/);
    });
    it("PIN — the trip screen uses openTripChat's answer for threadId and title only, to navigate", () => {
      const src = stripComments(readFileSync(join(CLIENT, "app/trip/[id].tsx"), "utf8"));
      assert.equal((src.match(/openTripChat\(/g) ?? []).length, 1);
      assert.match(src, /const res = await openTripChat\(id\);[\s\S]{0,200}const \{ threadId, title \} = res\.data;[\s\S]{0,200}router\.push\(`\/messages\/\$\{threadId\}/);
      const handler = src.slice(src.indexOf("async function handleOpenChat()"), src.indexOf("async function", src.indexOf("async function handleOpenChat()") + 10));
      assert.ok(handler.includes("openTripChat(id)"), "the read moved out of handleOpenChat");
      assert.equal((handler.match(/\bres\.data\b/g) ?? []).length, 2, "openTripChat's answer reached something other than threadId and title");
      assert.doesNotMatch(handler, /set[A-Z][A-Za-z]*\([^)]*res\b/, "openTripChat's answer was put into screen state");
    });
  });
});

describe("T366 hardening, round 4 (§66) — a helper's UNRESOLVABLE `.from(expr)` seeds the fixpoint (fail closed)", () => {
  const caughtIn = (files: Array<[string, string]>, seed?: Seed) => {
    const extra = new Map<string, string>(files.map(([rel, src]) => [join(SRC, rel), stripComments(src)]));
    const a = serverAnalysis(extra, seed);
    return files.flatMap(([rel]) => a.crossings(join(SRC, rel)));
  };
  const route = (helperCall: string) => [
    'import { executeMemoryCommand } from "../lib/memoryCommandBus.js";',
    `import { readSomething } from "../lib/__t366_r4_helper.js";`,
    'router.post("/r4", async (req, res) => {',
    `  const rows = await ${helperCall};`,
    '  await executeMemoryCommand(sc, { commandType: "CREATE_MEMORY", payload: rows });',
    "});",
  ].join("\n");

  it("a caller of a helper whose table the scan cannot name, that also creates a memory, crosses — through two files", () => {
    const c = caughtIn([
      ["lib/__t366_r4_helper.ts", 'export async function readSomething(sc, id) { const { data } = await sc.from(tableFor(id)).select("*"); return data; }'],
      ["routes/__t366_r4_route.ts", route("readSomething(sc, req.params.id)")],
    ]);
    assert.equal(c.length, 1, JSON.stringify(c));
    assert.ok(c[0]!.reads.includes("?call:readSomething"), JSON.stringify(c));
  });

  it("…and through an intermediate helper (the reach is a fixpoint, not one hop)", () => {
    const c = caughtIn([
      ["lib/__t366_r4_helper.ts", [
        'async function inner(sc, id) { const { data } = await sc.from(registry[id].table).select("*"); return data; }',
        "export async function readSomething(sc, id) { return inner(sc, id); }",
      ].join("\n")],
      ["routes/__t366_r4_route.ts", route("readSomething(sc, req.params.id)")],
    ]);
    assert.equal(c.length, 1, JSON.stringify(c));
  });

  it("CONTROL: the same helper with a literal non-history table is not a crossing; a storage bucket is not a table", () => {
    assert.equal(caughtIn([
      ["lib/__t366_r4_helper.ts", 'export async function readSomething(sc, id) { const { data } = await sc.from("trips").select("*").eq("id", id); return data; }'],
      ["routes/__t366_r4_route.ts", route("readSomething(sc, req.params.id)")],
    ]).length, 0);
    assert.equal(caughtIn([
      ["lib/__t366_r4_helper.ts", "export async function readSomething(sc, path) { const { data } = await sc.storage.from(BUCKET).download(path); return data; }"],
      ["routes/__t366_r4_route.ts", route("readSomething(sc, req.params.id)")],
    ]).length, 0);
  });

  it("CONTROL: a table PARAMETER is still resolved at the call site (not double-counted as opaque)", () => {
    const helper = 'export async function readSomething(sc, table) { const { data } = await sc.from(table).select("*"); return data; }';
    assert.equal(caughtIn([["lib/__t366_r4_helper.ts", helper], ["routes/__t366_r4_route.ts", route('readSomething(sc, "trips")')]]).length, 0);
    assert.equal(caughtIn([["lib/__t366_r4_helper.ts", helper], ["routes/__t366_r4_route.ts", route('readSomething(sc, "messages")')]]).length, 1);
  });

  it("the seed is not vacuous on the real tree, and every reviewed helper is load-bearing: without the list, real units cross", () => {
    const bare = serverAnalysis(new Map(), opaqueReadsExcept([]));
    const extra: string[] = [];
    for (const f of bare.files) {
      if (allowed.has(f)) continue;
      for (const c of bare.crossings(f)) {
        const r = reviewed.get(f);
        if (r && c.unit.startsWith(r.unit)) continue;
        extra.push(`${relative(PKG, f)} :: ${c.unit}`);
      }
    }
    assert.ok(extra.length > 0, "nothing on the real tree reaches an opaque helper — the reviewed list would be dead");
    for (const r of REVIEWED_OPAQUE_READ_HELPERS) {
      const only = serverAnalysis(new Map(), opaqueReadsExcept(REVIEWED_OPAQUE_READ_HELPERS.filter((x) => x !== r)));
      const n = only.files.reduce((k, f) => k + (allowed.has(f) ? 0 : only.crossings(f).filter((c) => !(reviewed.get(f) && c.unit.startsWith(reviewed.get(f)!.unit))).length), 0);
      assert.ok(n > 0, `${r.file} ${r.unit}: un-reviewing it crosses nothing — remove the entry`);
    }
  });

  it("every reviewed helper still has an unresolved database read (or must be removed)", () => {
    for (const r of REVIEWED_OPAQUE_READ_HELPERS) {
      const code = codeOf.get(join(PKG, r.file));
      assert.ok(code, r.file);
      const unit = codeUnits(code!).find((u) => u.code.trim().startsWith(r.unit));
      assert.ok(unit, `${r.file}: ${r.unit} not found`);
      assert.ok(opaqueReadsExcept([])(join(PKG, r.file), unit!.code, stringConstsIn(code!), code!).length > 0, `${r.unit} no longer has an unresolved read`);
    }
  });

  it("PIN — probeSchemaReadiness: no CapabilityDefinition names a conversation-history table, and the probe keeps no rows", () => {
    const keyRe = new RegExp(`(?:^|[\\s{,])["']?(${CONVERSATION_HISTORY_TABLES.join("|")})["']?\\s*:`, "m");
    let defs = 0;
    for (const [f, code] of codeOf) {
      if (!/\bCapabilityDefinition\b/.test(code)) continue;
      defs++;
      for (const m of code.matchAll(/\btables\s*:\s*\{/g)) {
        let depth = 0, i = (m.index ?? 0) + m[0].length - 1;
        for (; i < code.length; i++) { if (code[i] === "{") depth++; else if (code[i] === "}" && --depth === 0) break; }
        const block = code.slice(m.index, i + 1);
        assert.doesNotMatch(block, keyRe, `${relative(PKG, f)}: a capability requires a conversation-history table — probeSchemaReadiness would read it`);
      }
    }
    assert.ok(defs >= 3, "no CapabilityDefinition found — the pin is vacuous");
    const unit = codeUnits(codeOf.get(join(SRC, "lib/capability/schemaCapability.ts"))!).find((u) => u.declares.includes("probeSchemaReadiness"))!.code;
    assert.doesNotMatch(unit, /\breturn\b[^;]*\bres\.data\b|\bres\.data\b/, "the probe now carries row data out");
  });
});

describe("T366 hardening, round 4 (§66) — a client context or store that conversation content reaches is a reviewed channel", () => {
  const client = clientAnalysis();
  /** Store/context modules (declare a context, an external store, or use a store library) that a history-reading unit feeds or that read history themselves. */
  const taintedStores = (a: Analysis) => {
    const stores = new Set(a.files.filter((f) => CLIENT_SHARED_STORE_RE.test(a.sourceOf(f))));
    const out = new Set<string>();
    for (const f of a.files) {
      const imports = a.linksOf(f).imports.filter((i) => i.target && stores.has(i.target));
      for (const u of a.units.get(f)!) {
        if (!a.isReaderUnit(f, u)) continue;
        if (stores.has(f)) out.add(f);
        for (const i of imports) if (i.bindings.some((b) => references(u.code, b.local)) || (i.namespace && references(u.code, i.namespace))) out.add(i.target!);
      }
    }
    return { stores, tainted: [...out].map((f) => relative(CLIENT, f)).sort() };
  };

  it("the store inventory is not vacuous", () => {
    const t = taintedStores(client);
    assert.ok(t.stores.size >= 10, `${t.stores.size} stores: ${[...t.stores].map((f) => relative(CLIENT, f)).join(", ")}`);
  });

  it("every context/store that history-reading code feeds (or that reads history itself) is reviewed — and every entry is live", () => {
    assert.deepEqual(taintedStores(client).tainted, REVIEWED_CLIENT_SHARED_STORES.map((r) => r.file).sort(),
      "conversation content may enter a context/store — a channel the client scan does not follow to its consumers. Review what it carries into REVIEWED_CLIENT_SHARED_STORES");
  });

  it("a synthetic store fed by a thread read is caught; the same store fed by something else is not", () => {
    const store = join(CLIENT, "src/context/__t366_ThreadStore.tsx");
    const feeder = join(CLIENT, "app/__t366_feeder.tsx");
    const mk = (read: string) => clientAnalysis(new Map([
      [store, "export const ThreadCtx = createContext(null);\nexport function setThreadData(d) { cur = d; }"],
      [feeder, [
        "import { getThreadMessages } from '../src/services/messaging.ts';",
        "import { getMyTrips } from '../src/services/trips.ts';",
        "import { setThreadData } from '../src/context/__t366_ThreadStore.tsx';",
        `export default function Feeder({ id }) { useEffect(() => { void ${read}(id).then((r) => setThreadData(r.data)); }, []); return null; }`,
      ].join("\n")],
    ]));
    assert.ok(taintedStores(mk("getThreadMessages")).tainted.includes("src/context/__t366_ThreadStore.tsx"));
    assert.ok(!taintedStores(mk("getMyTrips")).tainted.includes("src/context/__t366_ThreadStore.tsx"));
  });
});
