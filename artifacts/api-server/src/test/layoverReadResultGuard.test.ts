/**
 * census-layover L294 / C2 (§55.9) — no NEW layover read may return its data
 * beside a degraded boolean.
 *
 * WHAT IS CHECKED, AND HOW
 * ========================
 * Every `async` function, method, arrow or function expression in
 * `src/services/airport/`, `src/services/layover/`, `src/routes/airport.ts`
 * and `src/routes/layover*.ts` is read with the TypeScript checker, so an
 * INFERRED return type is checked as well as an annotated one. Its awaited
 * return type — each member, if it is a union — is a violation when it carries
 * a READ-CONFIDENCE flag (`degraded`, `unreadable`, `readable`, …) typed as a
 * plain `boolean` beside at least one other field: the data-beside-boolean
 * shape, where a handler can use the data without ever reading the flag.
 *
 * NOT a violation:
 *   - `LayoverRead<T>` (`services/layover/layoverRead.ts`): the substitute is
 *     called `fallback`, not `value`, and has no boolean at all.
 *   - an `{ ok: true, … } | { ok: false, reason }` union: each member's flag is
 *     a LITERAL, so the handler must narrow before it reaches data.
 *   - a domain boolean (`verified`, `duplicate`, `checkedBags`): not a claim
 *     about the read. Only the names in READ_CONFIDENCE_FLAGS are.
 *   - a synchronous function: it reads nothing. `readDisclosure` and the
 *     wire-shaped `PresenceDisclosure` are where a read legitimately becomes
 *     the boolean the client already speaks.
 *
 * THE LEDGER MAY ONLY SHRINK
 * ==========================
 * `NOT_YET_MIGRATED` lists every read that had the shape when this guard
 * landed, minus the ones migrated with it. A new violation fails naming it; a
 * ledger entry that no longer violates fails too ("delete its entry"), so the
 * ledger cannot outlive the migration it records.
 *
 * Run: node --import tsx/esm --test src/test/layoverReadResultGuard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { readValue, readDegraded, matchRead, readDisclosure, type LayoverRead } from "../services/layover/layoverRead.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Names that make a claim about the READ itself, not about the domain. */
export const READ_CONFIDENCE_FLAGS: ReadonlySet<string> = new Set([
  "degraded", "unreadable", "unread", "readable", "readFailed", "failed", "signalsReadable", "fromStatic", "partial", "stale",
]);

/** file (relative to src) # function, with what is left to do. */
const NOT_YET_MIGRATED: ReadonlyMap<string, string> = new Map([
  ["services/airport/LayoverRecommendationService.ts#readLayoverLive", "byKey beside readable"],
  ["services/airport/LayoverPrivacyGuard.ts#evaluateSharingGate", "SharingGateResult: allowed beside degraded; read by disclosePresence and the crew abort notice"],
  ["services/airport/LayoverSafeReturnService.ts#markReturning", "a WRITE: applied beside failed"],
  ["services/airport/layoverMaturityGate.ts#landsideMaturityDecision", "a decision whose observation signals may be unreadable (signalsReadable)"],
]);

function scopedFiles(): string[] {
  const out: string[] = [];
  for (const d of ["services/airport", "services/layover"]) {
    for (const f of fs.readdirSync(path.join(SRC, d))) if (f.endsWith(".ts")) out.push(path.join(SRC, d, f));
  }
  for (const f of fs.readdirSync(path.join(SRC, "routes"))) if (/^(airport|layover[A-Za-z]*)\.ts$/.test(f)) out.push(path.join(SRC, "routes", f));
  return out.sort();
}

function isPlainBoolean(t: ts.Type): boolean {
  if (t.flags & ts.TypeFlags.Boolean) return true;
  return t.isUnion() && t.types.length === 2 && t.types.every((x) => (x.flags & ts.TypeFlags.BooleanLiteral) !== 0);
}

function functionName(n: ts.Node, sf: ts.SourceFile): string {
  const named = (n as ts.FunctionDeclaration).name;
  if (named) return named.getText(sf);
  if (ts.isVariableDeclaration(n.parent)) return n.parent.name.getText(sf);
  if (ts.isPropertyAssignment(n.parent)) return n.parent.name.getText(sf);
  return `<anonymous:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}>`;
}

/** Every async function in `files` whose awaited result carries a read-confidence boolean beside data. Keyed `relative#name`. */
export function findDataBesideBooleanReads(files: string[], base: string): Map<string, string> {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true, skipLibCheck: true, noEmit: true,
  });
  const checker = program.getTypeChecker();
  const found = new Map<string, string>();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`not in the program: ${file}`);
    const visit = (n: ts.Node): void => {
      const fn = ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
      if (fn && ts.getCombinedModifierFlags(n as ts.Declaration) & ts.ModifierFlags.Async) {
        const sig = checker.getSignatureFromDeclaration(n as ts.SignatureDeclaration);
        if (sig) {
          const ret = checker.getReturnTypeOfSignature(sig);
          const awaited = checker.getAwaitedType(ret) ?? ret;
          for (const member of awaited.isUnion() ? awaited.types : [awaited]) {
            const props = checker.getPropertiesOfType(member);
            const flags = props.filter((p) => READ_CONFIDENCE_FLAGS.has(p.name) && isPlainBoolean(checker.getTypeOfSymbolAtLocation(p, n)));
            if (flags.length > 0 && props.length > flags.length) {
              found.set(`${path.relative(base, file).split(path.sep).join("/")}#${functionName(n, sf)}`, flags.map((p) => p.name).join(","));
              break;
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return found;
}

/** What the ledger gets wrong against what was found: new violations, and entries that no longer violate. */
export function ledgerProblems(found: ReadonlyMap<string, string>, ledger: ReadonlyMap<string, string>): { fresh: string[]; stale: string[] } {
  const fresh = [...found.keys()].filter((k) => !ledger.has(k));
  const stale = [...ledger.keys()].filter((k) => !found.has(k));
  return { fresh, stale };
}

describe("census-layover L294 — no new layover read returns data beside a degraded boolean", () => {
  const files = scopedFiles();
  const found = findDataBesideBooleanReads(files, SRC);

  it("the scope is the layover stores and routes (not vacuous)", () => {
    assert.ok(files.length >= 60, `only ${files.length} files in scope`);
    for (const must of ["routes/airport.ts", "services/airport/LayoverPrivacyGuard.ts", "services/layover/LayoverConstraintStore.ts", "services/layover/layoverRead.ts"]) {
      assert.ok(files.includes(path.join(SRC, must)), `${must} is not in scope`);
    }
  });

  it("every data-beside-boolean read is on the ledger (a NEW one fails here, by name)", () => {
    const { fresh } = ledgerProblems(found, NOT_YET_MIGRATED);
    assert.deepEqual(fresh, [], `new data-beside-boolean read(s): ${fresh.map((k) => `${k} [${found.get(k)}]`).join("; ")} — return LayoverRead<T> (services/layover/layoverRead.ts) or an { ok } union instead`);
  });

  it("every ledger entry still has the shape (a migrated read must leave the ledger)", () => {
    const { stale } = ledgerProblems(found, NOT_YET_MIGRATED);
    assert.deepEqual(stale, [], `migrated, delete from NOT_YET_MIGRATED: ${stale.join(", ")}`);
  });
});

describe("the detector itself, on PLANTED sources", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l294-guard-"));
  const plant = (name: string, body: string) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
  const files = [
    plant("annotated.ts", "export async function annotated(): Promise<{ rows: string[]; degraded: boolean }> { return { rows: [], degraded: false }; }\n"),
    plant("inferred.ts", "export async function inferred(n: number) { return { count: n, unreadable: n < 0 }; }\n"),
    plant("arrow.ts", "export const arrow = async (n: number) => ({ items: [n], readable: n > 0 });\n"),
    plant("method.ts", "export class Store { async load(n: number): Promise<{ ghostMode: boolean; degraded: boolean }> { return { ghostMode: true, degraded: n > 0 }; } }\n"),
    plant("unionMember.ts", "export async function unionMember(n: number): Promise<{ ok: true; rows: string[]; degraded: boolean } | { ok: false; reason: string }> { return n ? { ok: true, rows: [], degraded: n > 1 } : { ok: false, reason: 'x' }; }\n"),
    plant("okUnion.ts", "export async function okUnion(n: number): Promise<{ ok: true; rows: string[] } | { ok: false; reason: string }> { return n ? { ok: true, rows: [] } : { ok: false, reason: 'x' }; }\n"),
    plant("domain.ts", "export async function domain(): Promise<{ id: string; verified: boolean }> { return { id: 'a', verified: true }; }\n"),
    plant("sync.ts", "export function sync(): { rows: string[]; degraded: boolean } { return { rows: [], degraded: true }; }\n"),
    plant("converted.ts", [
      "type LayoverRead<T> = { readonly kind: 'read'; readonly value: T } | { readonly kind: 'degraded'; readonly fallback: T; readonly reasons: readonly [string, ...string[]] };",
      "export async function converted(n: number): Promise<LayoverRead<boolean>> { return n ? { kind: 'read', value: true } : { kind: 'degraded', fallback: true, reasons: ['x'] }; }",
      "",
    ].join("\n")),
    plant("flagOnly.ts", "export async function flagOnly(): Promise<{ degraded: boolean }> { return { degraded: true }; }\n"),
  ];
  const found = findDataBesideBooleanReads(files, dir);

  it("flags an annotated, an inferred, an arrow, a method read, and a union member carrying the boolean", () => {
    assert.deepEqual([...found.keys()].sort(), ["annotated.ts#annotated", "arrow.ts#arrow", "inferred.ts#inferred", "method.ts#load", "unionMember.ts#unionMember"]);
  });

  it("the convention's whole point, checked by the compiler: the substitute is not reachable as `value`", () => {
    const conv = JSON.stringify(path.join(SRC, "services/layover/layoverRead.js"));
    const f = plant("handler.ts", [
      `import type { LayoverRead } from ${conv};`,
      "declare const r: LayoverRead<number>;",
      "export const skipped: number = r.value;",
      "export const lumped: number = r.kind !== 'read' ? r.value : 0;",
      "export const narrowed: number = r.kind === 'read' ? r.value : r.fallback;",
      "",
    ].join("\n"));
    const program = ts.createProgram([f], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true, noEmit: true });
    const sf = program.getSourceFile(f)!;
    const errors = ts.getPreEmitDiagnostics(program, sf).map((d) => [sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1, d.code]);
    assert.deepEqual(errors, [[3, 2339], [4, 2339]], "reading `value` without narrowing to 'read' must not compile; the narrowed handler must");
  });

  it("does not flag an { ok } union, a domain boolean, a sync function, a LayoverRead, or a lone flag", () => {
    for (const k of ["okUnion.ts#okUnion", "domain.ts#domain", "sync.ts#sync", "converted.ts#converted", "flagOnly.ts#flagOnly"]) {
      assert.equal(found.has(k), false, k);
    }
  });
});

describe("the ledger comparison, on PLANTED inputs", () => {
  it("a read not on the ledger is FRESH; a ledger entry with no read is STALE; agreement is neither", () => {
    const found = new Map([["a.ts#kept", "degraded"], ["b.ts#new", "readable"]]);
    const ledger = new Map([["a.ts#kept", "note"], ["c.ts#migrated", "note"]]);
    assert.deepEqual(ledgerProblems(found, ledger), { fresh: ["b.ts#new"], stale: ["c.ts#migrated"] });
    assert.deepEqual(ledgerProblems(new Map([["a.ts#kept", "x"]]), new Map([["a.ts#kept", "y"]])), { fresh: [], stale: [] });
  });
});

describe("LayoverRead — the convention", () => {
  it("a measured read exposes `value`; a degraded one exposes only `fallback`, with its reasons", () => {
    const measured: LayoverRead<number> = readValue(3);
    const substitute: LayoverRead<number> = readDegraded(0, ["presence_unreadable"]);
    assert.deepEqual(measured, { kind: "read", value: 3 });
    assert.deepEqual(substitute, { kind: "degraded", fallback: 0, reasons: ["presence_unreadable"] });
    assert.equal("value" in substitute, false, "the substitute is never reachable as `value`");
  });

  it("matchRead takes both branches", () => {
    const say = (r: LayoverRead<number>) => matchRead(r, { read: (v) => `measured ${v}`, degraded: (f, why) => `fallback ${f} (${why.join(",")})` });
    assert.equal(say(readValue(2)), "measured 2");
    assert.equal(say(readDegraded(0, ["a", "b"])), "fallback 0 (a,b)");
  });

  it("a degraded read with no named reason is refused", () => {
    assert.throws(() => readDegraded(0, [""] as unknown as readonly [string]), /must name at least one reason/);
    assert.throws(() => readDegraded(0, [] as unknown as readonly [string]), /must name at least one reason/);
  });

  it("readDisclosure is the wire's pair: degraded if any read is, every reason once", () => {
    assert.deepEqual(readDisclosure(), { degraded: false, degradedReasons: [] });
    assert.deepEqual(readDisclosure(readValue(1), readValue("x")), { degraded: false, degradedReasons: [] });
    assert.deepEqual(
      readDisclosure(readValue(1), readDegraded(0, ["a", "b"]), readDegraded(null, ["b", "c"])),
      { degraded: true, degradedReasons: ["a", "b", "c"] },
    );
  });
});
