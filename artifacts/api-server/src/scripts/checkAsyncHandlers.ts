/**
 * Async-handler guard — standalone CI check
 *
 * Scans every TypeScript file in src/routes/ and reports any
 * router.get/post/put/patch/delete call whose argument list contains a bare
 * async callback that is NOT directly wrapped by asyncHandler().
 *
 * Detection algorithm:
 *  1. Find each `router.<method>(` opening using a regex.
 *  2. Extract the full parenthesised argument block via depth counting.
 *  3. Split the block into top-level arguments (respecting nesting and strings).
 *  4. Flag any argument that is itself an async arrow function or async named
 *     function and is NOT directly wrapped by asyncHandler().
 *
 * This correctly handles multi-line declarations and mixed calls such as:
 *
 *   router.post(
 *     "/path",
 *     asyncHandler(async (req, res) => { ... }),   // ← OK, wrapped
 *     async (req, res) => { ... },                 // ← VIOLATION
 *   );
 *
 * Files listed in ASYNC_HANDLER_LEGACY_FILES are skipped; they pre-date this
 * policy. Do NOT add new filenames to that list — fix the handler instead.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:async-handlers
 * or directly:
 *   node --import tsx/esm src/scripts/checkAsyncHandlers.ts
 *
 * Exit code 0 → no violations found in non-legacy route files
 * Exit code 1 → one or more bare async handlers found in non-legacy files
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ASYNC_HANDLER_LEGACY_FILES } from "./asyncHandlerLegacy.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const routesDir = resolve(__dir, "../routes");

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Strip line comments and block comments from source while preserving newlines
 * so that character-offset→line-number mapping stays intact.
 */
function stripComments(src: string): string {
  // Block comments: replace every non-newline character with a space
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m
      .split("")
      .map((c) => (c === "\n" ? "\n" : " "))
      .join(""),
  );
  // Single-line comments: replace everything up to (but not including) the newline
  out = out.replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
  return out;
}

/**
 * Advance past a JavaScript string literal starting at `src[i]` (where
 * `src[i]` is `'`, `"`, or `` ` ``).  Returns the index immediately after
 * the closing quote.
 */
function skipString(src: string, i: number): number {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && quote !== "`") {
      i += 2; // skip escaped character
      continue;
    }
    if (quote === "`" && ch === "$" && src[i + 1] === "{") {
      // Template expression — skip nested block
      i += 2;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") depth--;
        i++;
      }
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * Given source and the index of an opening `(`, return the full text of the
 * parenthesised block (including the outer parens).  Respects nested
 * parentheses/brackets/braces and string literals.
 */
function extractParenBlock(src: string, openIdx: number): string {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
    i++;
  }
  return src.slice(openIdx);
}

/**
 * Split the inner content of a parenthesised block (everything between the
 * outer `(` and `)`) into top-level arguments — commas inside nested
 * parens/brackets/braces and inside string literals do NOT split.
 *
 * Returns trimmed argument strings.
 */
function splitTopLevelArgs(block: string): string[] {
  // block includes surrounding parens: "( arg1, arg2, ... )"
  const inner = block.slice(1, block.length - 1);

  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(inner, i);
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  const last = inner.slice(start).trim();
  if (last.length > 0) args.push(last);
  return args;
}

/**
 * Returns true if the given argument text is a bare async callback — i.e. it
 * is an async arrow function (`async (...) =>`) or async named function
 * (`async function`) and is NOT wrapped by asyncHandler().
 *
 * Compliant forms:
 *   asyncHandler(async (req, res) => { ... })
 *   asyncHandler(async function handler(req, res) { ... })
 *
 * Violation forms:
 *   async (req, res) => { ... }
 *   async function handler(req, res) { ... }
 */
function isBareAsyncCallback(arg: string): boolean {
  const t = arg.trimStart();
  // Must start with the `async` keyword followed by whitespace/paren/function
  if (!/^async\s*(\(|function\b)/.test(t)) return false;
  // If it's actually asyncHandler(...) it starts with "asyncHandler" — not a violation
  // (Already excluded above since "asyncHandler" starts with "asyncH", not "async\s*\(")
  return true;
}

// Matches the opening of a router method call.
const ROUTER_METHOD_RE = /\brouter\.(get|post|put|patch|delete)\s*\(/g;

interface Violation {
  file: string;
  line: number;
  snippet: string;
  argSnippet: string;
}

// ── Scan ──────────────────────────────────────────────────────────────────────

let routeFiles: string[];
try {
  routeFiles = readdirSync(routesDir)
    .filter((f) => f.endsWith(".ts"))
    .sort();
} catch {
  console.error(`ERROR: Routes directory not found: ${routesDir}`);
  process.exit(1);
}

const violations: Violation[] = [];
const skippedLegacy: string[] = [];
const cleanFiles: string[] = [];

for (const filename of routeFiles) {
  if (ASYNC_HANDLER_LEGACY_FILES.has(filename)) {
    skippedLegacy.push(filename);
    continue;
  }

  const filePath = join(routesDir, filename);
  const rawSrc = readFileSync(filePath, "utf-8");
  const src = stripComments(rawSrc);

  let fileHasViolation = false;
  ROUTER_METHOD_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ROUTER_METHOD_RE.exec(src)) !== null) {
    // The `(` is the last character of the match
    const openParenIdx = match.index + match[0].length - 1;
    const block = extractParenBlock(src, openParenIdx);
    const args = splitTopLevelArgs(block);

    // Check each argument individually
    for (const arg of args) {
      if (isBareAsyncCallback(arg)) {
        const line = rawSrc.slice(0, match.index).split("\n").length;
        const snippet = rawSrc.split("\n")[line - 1].trimEnd();
        // First line of the bare callback for context
        const argFirstLine = arg.split("\n")[0].trimEnd();
        violations.push({
          file: `src/routes/${filename}`,
          line,
          snippet,
          argSnippet: argFirstLine,
        });
        fileHasViolation = true;
      }
    }
  }

  if (!fileHasViolation) {
    cleanFiles.push(filename);
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

if (violations.length === 0) {
  console.log(
    `check:async-handlers PASSED\n` +
      `  ${cleanFiles.length} route file(s) clean\n` +
      `  ${skippedLegacy.length} legacy file(s) skipped (awaiting migration)`,
  );
  process.exit(0);
}

const violatingFiles = new Set(violations.map((v) => v.file)).size;
console.error(
  `\nERROR: Bare async route handlers found in ${violatingFiles} file(s).\n` +
    `       Each async callback passed to router.<method>() must be wrapped with\n` +
    `       asyncHandler() to ensure errors reach Express's error middleware.\n` +
    `\n` +
    `       If this is a pre-existing file that cannot be migrated right now,\n` +
    `       add it to ASYNC_HANDLER_LEGACY_FILES in\n` +
    `       src/scripts/asyncHandlerLegacy.ts — but prefer fixing the handler.\n` +
    `\n` +
    `       Violations:\n` +
    violations
      .map(
        (v) =>
          `         ${v.file}:${v.line}\n` +
          `           route:    ${v.snippet}\n` +
          `           callback: ${v.argSnippet}`,
      )
      .join("\n") +
    `\n`,
);
process.exit(1);
