/**
 * Guard: no function body in src/lib (including stamps/) may mix
 * Date.now() and no-arg new Date(). Mixing them takes two independent
 * clock reads, producing subtly inconsistent timestamps in schedulers,
 * queues, and sweepers.
 *
 * Fix pattern (see pushRetryQueue.ts): capture a single
 * `const nowMs = Date.now()` and derive `new Date(nowMs)` from it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SCAN_DIRS = [
  path.join(SRC_DIR, "lib"),
  path.join(SRC_DIR, "routes"),
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: FunctionLikeNode, sf: ts.SourceFile): string {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText(sf);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  // Arrow / anonymous: try enclosing variable declaration or property name
  let parent: ts.Node | undefined = node.parent;
  if (parent && ts.isVariableDeclaration(parent)) {
    return parent.name.getText(sf);
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sf);
  }
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `<anonymous at line ${line + 1}>`;
}

/** Date.now() call */
function isDateNowCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Date" &&
    node.expression.name.text === "now"
  );
}

/** no-arg `new Date()` */
function isNoArgNewDate(node: ts.Node): boolean {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    (!node.arguments || node.arguments.length === 0)
  );
}

/**
 * Scan a function body for direct (not nested-function) uses of
 * Date.now() and no-arg new Date(). Nested functions are their own
 * scope: they get scanned separately.
 */
function scanBody(fn: FunctionLikeNode): {
  hasDateNow: boolean;
  hasNewDate: boolean;
} {
  let hasDateNow = false;
  let hasNewDate = false;
  const visit = (node: ts.Node) => {
    if (node !== fn && isFunctionLike(node)) return; // separate scope
    if (isDateNowCall(node)) hasDateNow = true;
    if (isNoArgNewDate(node)) hasNewDate = true;
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return { hasDateNow, hasNewDate };
}

test("no function in src/lib or src/routes mixes Date.now() with no-arg new Date()", () => {
  const offenders: string[] = [];
  for (const file of SCAN_DIRS.flatMap((dir) => collectTsFiles(dir))) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      if (isFunctionLike(node)) {
        const { hasDateNow, hasNewDate } = scanBody(node);
        if (hasDateNow && hasNewDate) {
          const { line } = sf.getLineAndCharacterOfPosition(
            node.getStart(sf),
          );
          offenders.push(
            `${path.relative(SRC_DIR, file)}:${line + 1} in function "${functionName(node, sf)}"`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepEqual(
    offenders,
    [],
    `Split-clock violation: these functions call both Date.now() and no-arg new Date(), ` +
      `taking two independent clock reads. Capture a single "const nowMs = Date.now()" ` +
      `and derive dates via "new Date(nowMs)" (see pushRetryQueue.ts):\n  ` +
      offenders.join("\n  "),
  );
});
