/**
 * census-media §35 (MD37) — every `media_assets` writer STATES its §6 source.
 *
 * §6: `sourceType: 'camera' | 'library' | 'provider' | 'official' | 'community'
 * | 'generated' | 'screenshot' | 'derivative'`. The spec lists the eight names
 * and settles, for no writer in this tree, which one an ordinary user upload
 * is: the upload route receives bytes and a Content-Type, never "camera" or
 * "library". Choosing one is an owner decision with consequences for real
 * people's content (it raises §35 evidence eligibility and the ranker's
 * provenance term), so this suite does NOT choose. What it enforces is the part
 * that needs no decision:
 *
 *   1. every call of the three canonical writers (recordMediaAsset,
 *      recordMediaAssetDetailed, recordEntityMedia) outside tests passes an
 *      explicit `sourceType`, and the value is either one of the eight or the
 *      NAMED undeclared sentinel `MEDIA_SOURCE_UNDECLARED` — never a bare
 *      "user", never a computed value, never nothing;
 *   2. the only direct INSERT/UPSERT sites on `media_assets` are the two known
 *      ones, each names `source_type`, and neither has a silent default;
 *   3. nothing UPDATEs `source_type` (a relabel would be a silent protection
 *      change on existing content);
 *   4. the sites that pass the sentinel are pinned, exactly: that list is the
 *      owner's decision inventory in census-media §35, and adding a writer to it
 *      is a census change, not a quiet one;
 *   5. the sentinel is NOT one of the eight and is NOT evidence-eligible, so no
 *      writer can raise a person's content into evidence by being undeclared.
 *
 * Structural, over the TypeScript AST of src/ (tests excluded, scripts
 * included — the backfill is a writer). Each check has a control that fails if
 * the scan found nothing, so the guard cannot pass by reading an empty tree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  EVIDENCE_ELIGIBLE_SOURCE_TYPES,
  MEDIA_SOURCE_UNDECLARED,
  SPEC_MEDIA_SOURCE_TYPES,
  isEvidenceEligible,
} from "../lib/media/mediaEvidenceEligibility.js";
import { provenanceClassOf } from "../lib/mediaRankingSignals.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SRC, "..", "..", "..");
const SENTINEL = "MEDIA_SOURCE_UNDECLARED";
const WRITERS = new Set(["recordMediaAsset", "recordMediaAssetDetailed", "recordEntityMedia"]);

function sourceFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "test" || e.name === "migrations" || e.name === "node_modules" || e.name === "baseline") continue;
      out.push(...sourceFiles(full));
    } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = parsed.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsed.set(file, sf);
  }
  return sf;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** The name of the function a call sits in, for a readable inventory. */
function enclosingFunction(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) {
      return n.parent.name.getText();
    }
  }
  return "<module>";
}

function propertyNamed(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === name);
}

type SourceKind = "spec" | "undeclared" | "forward" | "invalid";

/** Classify the expression a writer is handed as its source. */
function classify(expr: ts.Expression | undefined, file: string, fn: string): { kind: SourceKind; text: string } {
  if (!expr) return { kind: "invalid", text: "<missing>" };
  if (ts.isStringLiteral(expr)) {
    return (SPEC_MEDIA_SOURCE_TYPES as readonly string[]).includes(expr.text)
      ? { kind: "spec", text: expr.text }
      : { kind: "invalid", text: JSON.stringify(expr.text) };
  }
  if (ts.isIdentifier(expr) && expr.text === SENTINEL) return { kind: "undeclared", text: SENTINEL };
  // The ONE pass-through: recordEntityMedia forwards the source its own caller
  // stated, and every one of those callers is checked here too.
  if (file === "lib/mediaAssets.ts" && fn === "recordEntityMedia" && expr.getText() === "input.sourceType") {
    return { kind: "forward", text: "input.sourceType" };
  }
  return { kind: "invalid", text: expr.getText() };
}

interface Site { file: string; fn: string; callee: string; kind: SourceKind; value: string; line: number }

/** Every call of the three canonical writers, and the source each states. */
function writerCalls(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const sf = parse(file);
    const r = rel(file);
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !WRITERS.has(n.expression.text)) return;
      const fn = enclosingFunction(n);
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const arg = n.arguments[1];
      let prop: ts.ObjectLiteralElementLike | undefined;
      if (arg && ts.isObjectLiteralExpression(arg)) prop = propertyNamed(arg, "sourceType");
      let c: { kind: SourceKind; text: string };
      // The other pass-through: the thin `recordMediaAsset` wrapper hands its
      // whole, already-checked input to `recordMediaAssetDetailed`.
      if (r === "lib/mediaAssets.ts" && fn === "recordMediaAsset" && arg && ts.isIdentifier(arg) && arg.text === "input") c = { kind: "forward", text: "input" };
      else if (!arg || !ts.isObjectLiteralExpression(arg)) c = { kind: "invalid", text: "<input is not an object literal>" };
      else if (!prop) c = { kind: "invalid", text: "<no sourceType>" };
      else if (ts.isShorthandPropertyAssignment(prop)) c = classify(prop.name, r, fn);
      else if (ts.isPropertyAssignment(prop)) c = classify(prop.initializer, r, fn);
      else c = { kind: "invalid", text: prop.getText() };
      sites.push({ file: r, fn, callee: n.expression.text, kind: c.kind, value: c.text, line });
    });
  }
  return sites;
}

/** The receiver chain of a call, innermost `.from("…")` table name if any. */
function tableOf(call: ts.CallExpression): string | null {
  let e: ts.Expression = call.expression;
  while (true) {
    if (ts.isPropertyAccessExpression(e)) { e = e.expression; continue; }
    if (ts.isCallExpression(e)) {
      if (ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "from") {
        const a = e.arguments[0];
        return a && ts.isStringLiteralLike(a) ? a.text : null;
      }
      e = e.expression;
      continue;
    }
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) { e = e.expression; continue; }
    return null;
  }
}

interface TableWrite { file: string; fn: string; op: "insert" | "upsert" | "update"; call: ts.CallExpression; sf: ts.SourceFile }

function mediaAssetTableWrites(): TableWrite[] {
  const out: TableWrite[] = [];
  for (const file of sourceFiles()) {
    const sf = parse(file);
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const op = n.expression.name.text;
      if (op !== "insert" && op !== "upsert" && op !== "update") return;
      if (tableOf(n) !== "media_assets") return;
      out.push({ file: rel(file), fn: enclosingFunction(n), op, call: n, sf });
    });
  }
  return out;
}

/** Find `const <name> = { … }` / `const <name>: T = { … }` in the function that encloses `at`. */
function localObjectLiteral(at: ts.Node, name: string): ts.ObjectLiteralExpression | null {
  let fnNode: ts.Node | undefined = at.parent;
  while (fnNode && !ts.isFunctionLike(fnNode)) fnNode = fnNode.parent;
  let found: ts.ObjectLiteralExpression | null = null;
  if (!fnNode) return null;
  walk(fnNode, (n) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
      found = n.initializer;
    }
  });
  return found;
}

function functionNamed(file: string, name: string): ts.FunctionDeclaration {
  const sf = parse(path.join(SRC, file));
  let found: ts.FunctionDeclaration | null = null;
  walk(sf, (n) => {
    if (!found && ts.isFunctionDeclaration(n) && n.name?.text === name) found = n;
  });
  assert.ok(found, `${file} no longer declares ${name} — this guard would be reading nothing`);
  return found;
}

// ── The decision inventory (census-media §35, MD37) ─────────────────────────
//
// Each entry is a writer whose §6 source the spec does not settle, so it passes
// the named sentinel. `file · enclosing function · callee` and how many times.
// Changing this list is a census change: the owner's answer to §35's MD37
// question replaces the sentinel at exactly these sites.
const UNDECLARED_INVENTORY: Readonly<Record<string, number>> = {
  "lib/mediaAssets.ts · recordPostMediaAttachments · recordEntityMedia": 1,
  "routes/postcards.ts · syncPostcardAfterMediaChange · recordEntityMedia": 1, // census-media §37.9: the /complete step became a named function IN PLACE (was: "routes/postcards.ts · <module> · recordEntityMedia": 1)
  "routes/posts.ts · storeVerifiedMediaUpload · recordMediaAsset": 1, // census-telegraph §70 (T223): the /media/upload handler body became a named function IN PLACE, shared with the resumable message-media assemble; same call, same sentinel, count unchanged (was: "routes/posts.ts · <module> · recordMediaAsset": 1)
  "scripts/backfill-media-assets.ts · main · upsertAsset": 12,
  "services/passport/PassportMemoryService.ts · createMemory · recordEntityMedia": 1,
};

// The writers whose value IS one of the eight — kept visible so a change to
// them is a reviewed change too.
const SPEC_VALUED_INVENTORY: Readonly<Record<string, number>> = {
  "scripts/backfill-media-assets.ts · main · upsertAsset · community": 2,
  "services/hiddenGems/HiddenGemService.ts · submitGem · recordEntityMedia · community": 1,
};

/** The backfill's own writer takes the source positionally; read its calls. */
function backfillCalls(): Site[] {
  const file = path.join(SRC, "scripts", "backfill-media-assets.ts");
  const sf = parse(file);
  const out: Site[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "upsertAsset") return;
    const c = classify(n.arguments[2], "scripts/backfill-media-assets.ts", "upsertAsset-call");
    out.push({
      file: "scripts/backfill-media-assets.ts",
      fn: enclosingFunction(n),
      callee: "upsertAsset",
      kind: c.kind,
      value: c.text,
      line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
    });
  });
  return out;
}

function tally(sites: Site[], withValue: boolean): Record<string, number> {
  const t: Record<string, number> = {};
  for (const s of sites) {
    const k = `${s.file} · ${s.fn} · ${s.callee}` + (withValue ? ` · ${s.value}` : "");
    t[k] = (t[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(t).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe("MD37 — every media_assets writer states its §6 source", () => {
  it("control: the scan sees the source tree and the canonical writers' call sites", () => {
    assert.ok(sourceFiles().length > 200, "expected the api-server source tree");
    const calls = writerCalls();
    assert.ok(calls.length >= 6, `expected at least six writer call sites, found ${calls.length}`);
    for (const f of ["routes/posts.ts", "routes/postcards.ts", "services/passport/PassportMemoryService.ts", "services/hiddenGems/HiddenGemService.ts"]) {
      assert.ok(calls.some((c) => c.file === f), `${f} no longer calls a canonical writer — was it renamed? The guard would be inert there`);
    }
  });

  it("every canonical writer call passes an explicit sourceType that is one of the eight or the named sentinel", () => {
    const bad = writerCalls().filter((c) => c.kind === "invalid");
    assert.deepEqual(
      bad.map((c) => `${c.file}:${c.line} ${c.callee} sourceType=${c.value}`),
      [],
      "a media_assets writer must SAY its §6 source. Pass one of the eight §6 values where the spec settles it, " +
        `or ${SENTINEL} where it does not (then add the site to UNDECLARED_INVENTORY and to census-media §35). ` +
        'A bare "user" or a missing field is exactly the silent default MD37 is about.',
    );
  });

  it("the only pass-throughs are the two writers forwarding what their own callers stated", () => {
    const forwards = writerCalls().filter((c) => c.kind === "forward");
    assert.deepEqual(forwards.map((c) => `${c.file} · ${c.fn} · ${c.callee}`).sort(), [
      "lib/mediaAssets.ts · recordEntityMedia · recordMediaAsset",
      "lib/mediaAssets.ts · recordMediaAsset · recordMediaAssetDetailed",
    ]);
  });

  it("the backfill's writer has no default source and every call states one", () => {
    const fn = functionNamed("scripts/backfill-media-assets.ts", "upsertAsset");
    const p = fn.parameters.find((x) => x.name.getText() === "sourceType");
    assert.ok(p, "upsertAsset no longer takes a sourceType parameter");
    assert.equal(p.initializer, undefined, "upsertAsset's sourceType has a default again — an omitted source would be stored silently");
    const calls = backfillCalls();
    assert.ok(calls.length >= 10, `expected the backfill's writer calls, found ${calls.length}`);
    assert.deepEqual(calls.filter((c) => c.kind === "invalid").map((c) => `line ${c.line}: ${c.value}`), []);
  });

  it("the undeclared sites are exactly the owner's decision inventory (census-media §35)", () => {
    const sites = [...writerCalls(), ...backfillCalls()].filter((c) => c.kind === "undeclared");
    assert.deepEqual(
      tally(sites, false),
      UNDECLARED_INVENTORY,
      "the set of writers that do not know their §6 source changed. That is the list the owner decides MD37 over: " +
        "update UNDECLARED_INVENTORY and census-media §35 together.",
    );
  });

  it("the spec-valued sites are pinned too", () => {
    const sites = [...writerCalls(), ...backfillCalls()].filter((c) => c.kind === "spec");
    assert.deepEqual(tally(sites, true), SPEC_VALUED_INVENTORY);
  });
});

describe("MD37 — direct writes to the media_assets table", () => {
  it("control: the scan finds the known direct writers", () => {
    const writes = mediaAssetTableWrites();
    assert.ok(writes.some((w) => w.op === "upsert"), "no media_assets upsert found — the guard is reading nothing");
    assert.ok(writes.some((w) => w.op === "update"), "no media_assets update found — the guard is reading nothing");
  });

  it("only the two known sites insert or upsert a media_assets row", () => {
    const inserts = mediaAssetTableWrites().filter((w) => w.op !== "update");
    assert.deepEqual(
      inserts.map((w) => `${w.file} · ${w.fn} · ${w.op}`).sort(),
      ["lib/mediaAssets.ts · upsertAssetRow · upsert", "scripts/backfill-media-assets.ts · upsertAsset · upsert"],
      "a new code path creates media_assets rows. Route it through recordMediaAssetDetailed, or add it here " +
        "only once it names source_type from a stated value (census-media §35, MD37).",
    );
  });

  it("the canonical writer's payload names source_type, and its fallback is the named sentinel, not a bare literal", () => {
    const fn = functionNamed("lib/mediaAssets.ts", "recordMediaAssetDetailed");
    const row = localObjectLiteral(fn.body!.statements[0]!, "row");
    assert.ok(row, "recordMediaAssetDetailed no longer builds a `row` literal");
    const p = propertyNamed(row, "source_type");
    assert.ok(p && ts.isPropertyAssignment(p), "the canonical payload no longer names source_type");
    assert.equal(p.initializer.getText(), `input.sourceType ?? ${SENTINEL}`);
  });

  it("the backfill's payload names source_type from its stated parameter", () => {
    const fn = functionNamed("scripts/backfill-media-assets.ts", "upsertAsset");
    let payload: ts.ObjectLiteralExpression | null = null;
    walk(fn, (n) => {
      if (payload || !ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "upsert") return;
      const a = n.arguments[0];
      if (a && ts.isObjectLiteralExpression(a)) payload = a;
    });
    assert.ok(payload, "the backfill no longer upserts an object literal");
    const p = propertyNamed(payload, "source_type");
    assert.ok(p && ts.isPropertyAssignment(p) && p.initializer.getText() === "sourceType", "the backfill payload must store the stated source");
  });

  it("nothing UPDATEs source_type — a relabel would change existing content's eligibility silently", () => {
    const relabels: string[] = [];
    for (const w of mediaAssetTableWrites().filter((x) => x.op === "update")) {
      const a = w.call.arguments[0];
      let obj: ts.ObjectLiteralExpression | null = null;
      if (a && ts.isObjectLiteralExpression(a)) obj = a;
      else if (a && ts.isIdentifier(a)) obj = localObjectLiteral(w.call, a.text);
      const named = obj ? propertyNamed(obj, "source_type") : undefined;
      const spread = obj ? obj.properties.some((p) => ts.isSpreadAssignment(p) && /source_type/.test(p.getText())) : false;
      if (named || spread) relabels.push(`${w.file} · ${w.fn}`);
    }
    // The versioned update reaches the table through a variable patch
    // (`{ ...patch, version }`), so its CALLERS' patches are read instead.
    let casCalls = 0;
    for (const file of sourceFiles()) {
      walk(parse(file), (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== "casUpdateMediaAsset") return;
        casCalls++;
        const patch = n.arguments[3];
        if (!patch || !ts.isObjectLiteralExpression(patch) || propertyNamed(patch, "source_type")) relabels.push(`${rel(file)} · ${enclosingFunction(n)} · casUpdateMediaAsset`);
      });
    }
    assert.ok(casCalls >= 2, `expected the versioned-update callers, found ${casCalls}`);
    assert.deepEqual(relabels, []);
  });
});

describe("MD37 — the sentinel cannot raise anyone's content", () => {
  it("the eight are §6's eight: the spec text and migration 2250's CHECK both say so", () => {
    const spec = readFileSync(path.join(REPO, "docs", "specs", "Portava_Media_Engineering_Architecture_and_Design_Spec.txt"), "utf8");
    const m = /sourceType:\s*((?:\|?\s*'[a-z]+'\s*)+);/.exec(spec);
    assert.ok(m, "§6's sourceType union is no longer in the spec text");
    const specValues = [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    assert.deepEqual(specValues, [...SPEC_MEDIA_SOURCE_TYPES]);

    const mig = readFileSync(path.join(SRC, "migrations", "2250_media_asset_canonical_model.sql"), "utf8");
    const check = /CHECK \(source_type IN \(([\s\S]*?)\)\);/.exec(mig);
    assert.ok(check, "2250's source_type CHECK moved");
    const checkValues = [...check[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    assert.deepEqual(checkValues.filter((v) => v !== MEDIA_SOURCE_UNDECLARED), [...SPEC_MEDIA_SOURCE_TYPES]);
    assert.ok(checkValues.includes(MEDIA_SOURCE_UNDECLARED), "the sentinel must be storable, or every undeclared write fails");
  });

  it("the sentinel is not one of the eight, is not evidence-eligible, and does not rank as authentic", () => {
    assert.ok(!(SPEC_MEDIA_SOURCE_TYPES as readonly string[]).includes(MEDIA_SOURCE_UNDECLARED));
    assert.ok(!EVIDENCE_ELIGIBLE_SOURCE_TYPES.has(MEDIA_SOURCE_UNDECLARED));
    const now = Date.parse("2026-09-27T12:00:00Z");
    const captured = new Date(now - 5 * 60_000).toISOString();
    // CONTROL: the same fresh, unedited, located capture IS eligible as camera,
    // so the refusal below is the source's doing and nothing else's.
    assert.equal(isEvidenceEligible({ source_type: "camera", captured_at: captured, now }), true);
    assert.equal(isEvidenceEligible({ source_type: MEDIA_SOURCE_UNDECLARED, captured_at: captured, now }), false);
    const row = (source: string) => ({ canonical_media: [{ processing_status: "ready", position: 0, source_type: source, provenance: null }] }) as any;
    assert.equal(provenanceClassOf(row("camera")), "authentic");
    assert.equal(provenanceClassOf(row(MEDIA_SOURCE_UNDECLARED)), "unknown");
  });
});
