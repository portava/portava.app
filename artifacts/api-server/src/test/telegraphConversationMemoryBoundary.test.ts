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
  codeUnits,
  conversationReadsIn,
  crossingsInFile,
  importedNames,
  memoryCreationsIn,
  sqlCrossesBoundary,
  stripComments,
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
});
